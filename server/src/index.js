/*
 * Точка входа API-сервера SaaS-платформы.
 * Один процесс: HTTP API + раздача фронтендов + все боты + cron-задачи.
 *
 *   /app/       — Mini App клиента (tg-app/)
 *   /admin/     — панель мастера (admin/)
 *   /platform/  — панель владельца платформы (platform-admin/)
 *   /api/...    — API
 *   /bot/:hook  — вебхуки Telegram
 */

const path = require('path');
const fs = require('fs');
const Fastify = require('fastify');
const cron = require('node-cron');
const config = require('./config');
const prisma = require('./utils/db');
const { LOCAL_DIR } = require('./utils/upload');
const botManager = require('./services/bot-manager');
const adminBot = require('./services/admin-bot');
const reminder = require('./services/reminder');
const broadcast = require('./services/broadcast');
const { checkSubscriptions } = require('./services/payment');

const ROOT = path.join(__dirname, '..', '..');

function buildApp() {
    const app = Fastify({
        logger: { level: config.isDev ? 'info' : 'warn' },
        trustProxy: true, // за nginx
        bodyLimit: 1024 * 1024
    });

    app.register(require('@fastify/cors'), {
        origin: config.isDev ? true : [config.appUrl]
    });
    app.register(require('@fastify/rate-limit'), {
        max: 120,
        timeWindow: '1 minute',
        allowList: req => req.url.startsWith('/bot/') // вебхуки Telegram не ограничиваем
    });
    app.register(require('@fastify/jwt'), { secret: config.jwtSecret });
    app.register(require('@fastify/multipart'));

    // Заголовки безопасности (XSS, кликджекинг). Telegram-скрипты и iframe входа разрешены.
    app.addHook('onSend', async (request, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
        reply.header('Content-Security-Policy', [
            "default-src 'self'",
            "script-src 'self' https://telegram.org",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: https:",
            "connect-src 'self'",
            'frame-src https://oauth.telegram.org',
            "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org"
        ].join('; '));
    });

    app.setErrorHandler((err, request, reply) => {
        if (err.validation) {
            return reply.code(400).send({ error: 'Проверьте правильность заполнения полей', details: err.message });
        }
        const status = err.statusCode || 500;
        if (status >= 500) request.log.error(err);
        reply.code(status).send({
            error: status >= 500 && !config.isDev ? 'Ошибка сервера, попробуйте позже' : err.message,
            code: err.code
        });
    });

    // --- API ---
    app.register(require('./routes/auth'));
    app.register(require('./routes/catalog'));
    app.register(require('./routes/booking'));
    app.register(require('./routes/master'));
    app.register(require('./routes/payment'));
    app.register(require('./routes/admin'));

    app.get('/api/health', async () => {
        await prisma.$queryRaw`SELECT 1`;
        return { ok: true, bots: botManager.runningCount() };
    });

    // --- Вебхуки Telegram ---
    app.post('/bot/:hookId', async (request, reply) => {
        const ok = botManager.handleWebhook(
            request.params.hookId,
            request.headers['x-telegram-bot-api-secret-token'],
            request.body
        );
        return reply.code(ok ? 200 : 401).send(ok ? 'ok' : 'unauthorized');
    });

    // --- Фронтенды ---
    const statics = [
        ['tg-app', '/app/'],
        ['admin', '/admin/'],
        ['platform-admin', '/platform/']
    ];
    statics.forEach(([dir, prefix], i) => {
        app.register(require('@fastify/static'), {
            root: path.join(ROOT, dir), prefix, decorateReply: i === 0
        });
    });
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    app.register(require('@fastify/static'), { root: LOCAL_DIR, prefix: '/uploads/', decorateReply: false });
    app.get('/', (request, reply) => reply.redirect('/admin/'));

    return app;
}

function startCron() {
    const tz = { timezone: config.timezone };
    cron.schedule('*/5 * * * *', reminder.tick, tz);                  // напоминания + отзывы
    cron.schedule('0 10 * * *', () => checkSubscriptions().catch(console.error), tz); // подписки
    cron.schedule('0 21 * * *', () => adminBot.sendDailyReport().catch(console.error), tz); // отчёт
    cron.schedule('0 9 * * *', () => adminBot.checkBackups().catch(console.error), tz);     // бэкапы
}

async function main() {
    const app = buildApp();
    await app.listen({ port: config.port, host: '0.0.0.0' });

    await adminBot.startAdminBot().catch(err => console.error('[admin-bot]', err.message));
    await botManager.startAll();
    await broadcast.resumeAll();
    startCron();
    console.log(`Платформа запущена: ${config.appUrl} (боты: ${config.botMode})`);

    const shutdown = async () => {
        console.log('Остановка...');
        await botManager.stopAll();
        await app.close();
        await prisma.$disconnect();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

if (require.main === module) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { buildApp };
