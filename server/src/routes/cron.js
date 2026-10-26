/*
 * Задачи по расписанию по HTTP (для Vercel, где нет постоянно работающего процесса):
 *   /api/cron/tick  — каждые 5 минут (вызывает Supabase pg_cron, см. scripts/supabase-cron.sql)
 *   /api/cron/daily — раз в день (Vercel Cron, см. vercel.json)
 * Доступ только с заголовком Authorization: Bearer CRON_SECRET (Vercel Cron ставит его сам).
 */

const crypto = require('crypto');
const config = require('../config');
const jobs = require('../services/jobs');
const { httpError } = require('../middleware/auth');

function checkSecret(request) {
    const given = Buffer.from(String(request.headers.authorization || ''));
    const expected = Buffer.from(`Bearer ${config.cronSecret}`);
    if (!config.cronSecret || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        throw httpError(401, 'unauthorized');
    }
}

module.exports = async function cronRoutes(app) {
    const params = { type: 'object', required: ['job'], properties: { job: { type: 'string', enum: ['tick', 'daily'] } } };
    const handler = async request => {
        checkSecret(request);
        const started = Date.now();
        const { failed } = await jobs[request.params.job]();
        return { ok: failed.length === 0, failed, ms: Date.now() - started };
    };
    // Vercel Cron шлёт GET, pg_net в Supabase — POST
    app.get('/api/cron/:job', { schema: { params }, config: { rateLimit: false } }, handler);
    app.post('/api/cron/:job', { schema: { params }, config: { rateLimit: false } }, handler);
};
