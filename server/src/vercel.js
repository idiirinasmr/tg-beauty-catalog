/*
 * Точка входа для Vercel (подключается из /api/index.js в корне репозитория).
 * Fastify-приложение создаётся один раз на «тёплый» экземпляр функции;
 * после ответа функция ждёт фоновые задачи (уведомления, рассылки) через waitUntil.
 */

const { waitUntil } = require('@vercel/functions');
const { buildApp } = require('./index');
const { flush } = require('./utils/background');

let ready;

module.exports = async function handler(req, res) {
    ready ||= (async () => {
        const app = buildApp();
        await app.ready();
        return app;
    })().catch(err => {
        ready = null; // следующий запрос попробует снова
        throw err;
    });
    const app = await ready;
    // 'close' срабатывает и после обычного ответа, и при обрыве соединения
    waitUntil(new Promise(resolve => res.on('close', resolve)).then(flush));
    app.server.emit('request', req, res);
};
