/* API владельца платформы (раздел 3.4 плана), доступ только ADMIN_TELEGRAM_IDS */

const os = require('os');
const prisma = require('../utils/db');
const { requireAdmin, httpError } = require('../middleware/auth');
const { overview } = require('../services/platform-stats');
const { activatePro } = require('../services/payment');
const { notifyMaster } = require('../services/notify');
const botManager = require('../services/bot-manager');
const { stats: queueStats } = require('../utils/queue');

module.exports = async function adminRoutes(app) {
    app.addHook('preHandler', requireAdmin);

    app.get('/api/admin/masters', async () => {
        const masters = await prisma.master.findMany({
            orderBy: { createdAt: 'desc' },
            include: { _count: { select: { clients: true, services: true, bookings: true } } }
        });
        return masters.map(({ botToken, ...m }) => ({ ...m, botRunning: botManager.isRunning(m.id) }));
    });

    app.put('/api/admin/masters/:id/plan', {
        schema: {
            params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
            body: {
                type: 'object', required: ['plan'],
                properties: { plan: { type: 'string', enum: ['pro', 'free'] }, days: { type: 'integer', minimum: 1, maximum: 3650 } }
            }
        }
    }, async request => {
        const { id } = request.params;
        const master = await prisma.master.findUnique({ where: { id } });
        if (!master) throw httpError(404, 'Мастер не найден');

        if (request.body.plan === 'free') {
            return prisma.master.update({ where: { id }, data: { plan: 'free', planExpiresAt: null }, omit: { botToken: true } });
        }
        const pending = await prisma.payment.findFirst({
            where: { masterId: id, method: 'manual', status: 'pending' },
            orderBy: { createdAt: 'desc' }
        });
        const { master: updated } = await activatePro(id, { days: request.body.days || 30, paymentId: pending?.id });
        const until = updated.planExpiresAt.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
        notifyMaster(updated, `🎉 Тариф Pro активирован до ${until}. Спасибо!`);
        const { botToken, ...rest } = updated;
        return rest;
    });

    app.get('/api/admin/stats', async () => overview());

    app.get('/api/admin/payments', async () => prisma.payment.findMany({
        orderBy: { createdAt: 'desc' },
        take: 300,
        include: { master: { select: { name: true } } }
    }));

    app.get('/api/admin/monitoring', async () => {
        const mem = process.memoryUsage();
        const lastBackup = await prisma.backupLog.findFirst({ orderBy: { createdAt: 'desc' } });
        return {
            uptimeSec: Math.round(process.uptime()),
            memory: { rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576) },
            system: {
                totalMb: Math.round(os.totalmem() / 1048576),
                freeMb: Math.round(os.freemem() / 1048576),
                load: os.loadavg().map(n => Math.round(n * 100) / 100),
                cpus: os.cpus().length
            },
            bots: botManager.runningCount(),
            queue: queueStats(),
            lastBackup
        };
    });
};
