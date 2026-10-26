/* API владельца платформы (раздел 3.4 плана), доступ только ADMIN_TELEGRAM_IDS */

const os = require('os');
const crypto = require('crypto');
const config = require('../config');
const prisma = require('../utils/db');
const { requireAdmin, httpError } = require('../middleware/auth');
const { overview } = require('../services/platform-stats');
const { activatePro } = require('../services/payment');
const { notifyMaster } = require('../services/notify');
const botManager = require('../services/bot-manager');
const { stats: queueStats } = require('../utils/queue');

const uuidParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };

module.exports = async function adminRoutes(app) {
    app.addHook('preHandler', requireAdmin);

    app.get('/api/admin/masters', async () => {
        const masters = await prisma.master.findMany({
            orderBy: { createdAt: 'desc' },
            include: { _count: { select: { clients: true, services: true, bookings: true } } }
        });
        return masters.map(({ botToken, claimCode, ...m }) => ({
            ...m,
            botRunning: botManager.isActive({ id: m.id, botToken }),
            // Ссылка, по которой мастер «под ключ» один раз нажимает Start и привязывает свой Telegram
            claimLink: claimCode && m.botUsername ? `https://t.me/${m.botUsername}?start=claim_${claimCode}` : null,
            awaitingClaim: Boolean(claimCode)
        }));
    });

    // --- Настройка под ключ: владелец заводит мастера сам ---

    app.post('/api/admin/masters', {
        schema: {
            body: {
                type: 'object', required: ['name'], additionalProperties: false,
                properties: {
                    name: { type: 'string', minLength: 1, maxLength: 100 },
                    specialty: { type: 'string', maxLength: 150 },
                    phone: { type: 'string', maxLength: 30 },
                    address: { type: 'string', maxLength: 200 },
                    price: { type: 'integer', minimum: 0, maximum: 1000000 }
                }
            }
        }
    }, async (request, reply) => {
        if (await prisma.master.count() >= config.maxMasters) {
            throw httpError(503, `Достигнут лимит ${config.maxMasters} мастеров (MAX_MASTERS)`);
        }
        const { price = config.turnkeyPrice, ...profile } = request.body;
        const master = await prisma.master.create({
            data: {
                ...profile,
                claimCode: crypto.randomBytes(16).toString('base64url'),
                payments: { create: { amount: price, method: 'turnkey', status: 'pending' } }
            }
        });
        reply.code(201);
        return { id: master.id, name: master.name };
    });

    // Вход в панель мастера от имени владельца (режим настройки), 4 часа
    app.post('/api/admin/masters/:id/impersonate', { schema: { params: uuidParam } }, async request => {
        const master = await prisma.master.findUnique({ where: { id: request.params.id }, select: { id: true } });
        if (!master) throw httpError(404, 'Мастер не найден');
        return { token: app.jwt.sign({ tg: request.user.tg, mid: master.id, src: 'impersonate' }, { expiresIn: '4h' }) };
    });

    // Отметить разовую оплату (настройка под ключ или перевод за Pro)
    app.post('/api/admin/payments/:id/paid', { schema: { params: uuidParam } }, async request => {
        const payment = await prisma.payment.findUnique({ where: { id: request.params.id } });
        if (!payment || payment.status !== 'pending') throw httpError(404, 'Ожидающий платёж не найден');

        if (payment.method === 'manual') {
            const result = await activatePro(payment.masterId, { paymentId: payment.id });
            if (result) notifyMaster(result.master, '🎉 Оплата получена, тариф Pro активирован. Спасибо!');
        } else if (payment.method === 'turnkey') {
            await prisma.payment.updateMany({ where: { id: payment.id, status: 'pending' }, data: { status: 'paid', paidAt: new Date() } });
        } else {
            throw httpError(400, 'Онлайн-платежи подтверждаются автоматически');
        }
        return { ok: true };
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
            return prisma.master.update({ where: { id }, data: { plan: 'free', planExpiresAt: null }, omit: { botToken: true, claimCode: true } });
        }
        const pending = await prisma.payment.findFirst({
            where: { masterId: id, method: 'manual', status: 'pending' },
            orderBy: { createdAt: 'desc' }
        });
        const { master: updated } = await activatePro(id, { days: request.body.days || 30, paymentId: pending?.id })
            ?? await activatePro(id, { days: request.body.days || 30 }); // pending уже закрыт параллельно
        const until = updated.planExpiresAt.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
        notifyMaster(updated, `🎉 Тариф Pro активирован до ${until}. Спасибо!`);
        const { botToken, claimCode, ...rest } = updated;
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
            bots: await botManager.activeCount(),
            queue: queueStats(),
            lastBackup
        };
    });
};
