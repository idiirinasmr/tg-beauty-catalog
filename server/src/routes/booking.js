/*
 * POST /api/booking — заявка из Mini App.
 * initData подписан токеном бота мастера: проверяем им же, поэтому подделать
 * клиента или записаться к мастеру «чужим» ботом нельзя.
 */

const config = require('../config');
const prisma = require('../utils/db');
const { decrypt } = require('../utils/encrypt');
const { validateInitData } = require('../utils/telegram-auth');
const { httpError } = require('../middleware/auth');
const { isPro } = require('../middleware/plan-check');
const { findMasterByBot } = require('./catalog');
const { upsertClient } = require('../services/bot-handlers');
const { notifyMaster, sendFromMasterBot, escapeHtml } = require('../services/notify');
const { panelUrl } = require('../services/bot-manager');

const MAX_OPEN_BOOKINGS = 5; // защита от спама заявками одним клиентом

module.exports = async function bookingRoutes(app) {
    app.post('/api/booking', {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: {
            body: {
                type: 'object', required: ['botUsername', 'serviceId', 'initData'],
                properties: {
                    botUsername: { type: 'string', pattern: '^[A-Za-z0-9_]{5,64}$' },
                    serviceId: { type: 'string', format: 'uuid' },
                    initData: { type: 'string', maxLength: 4096 },
                    comment: { type: 'string', maxLength: 500 }
                }
            }
        }
    }, async request => {
        const { botUsername, serviceId, initData, comment = '' } = request.body;
        const master = await findMasterByBot(botUsername);
        if (!master.botToken) throw httpError(400, 'Бот мастера не подключён');

        const auth = validateInitData(initData, decrypt(master.botToken, config.encryptionKey));
        if (!auth) throw httpError(401, 'Откройте каталог через Telegram-бота мастера');
        const user = auth.user;

        const service = await prisma.service.findFirst({ where: { id: serviceId, masterId: master.id, isActive: true } });
        if (!service) throw httpError(404, 'Услуга не найдена');
        if (!isPro(master)) {
            // На Free клиенту видны только первые N услуг — записаться можно только на них
            const visible = await prisma.service.findMany({
                where: { masterId: master.id, isActive: true },
                orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
                take: config.freeLimits.services, select: { id: true }
            });
            if (!visible.some(s => s.id === service.id)) throw httpError(404, 'Услуга не найдена');
        }

        const open = await prisma.booking.count({
            where: { masterId: master.id, clientTelegramId: BigInt(user.id), status: 'new' }
        });
        if (open >= MAX_OPEN_BOOKINGS) {
            throw httpError(429, 'У вас уже есть несколько заявок — мастер скоро с вами свяжется');
        }

        await upsertClient(master.id, user);
        const booking = await prisma.$transaction(async tx => {
            const b = await tx.booking.create({
                data: {
                    masterId: master.id, serviceId: service.id,
                    serviceName: service.name, servicePrice: service.price,
                    clientTelegramId: BigInt(user.id), clientName: user.first_name || 'Клиент',
                    clientUsername: user.username || null, comment
                }
            });
            await tx.master.update({ where: { id: master.id }, data: { statsBookings: { increment: 1 } } });
            await tx.client.update({
                where: { masterId_telegramId: { masterId: master.id, telegramId: BigInt(user.id) } },
                data: { bookingsCount: { increment: 1 } }
            });
            return b;
        });

        const contact = user.username ? `@${escapeHtml(user.username)}` : `<a href="tg://user?id=${user.id}">написать</a>`;
        notifyMaster(master,
            `🆕 Новая заявка!\n\n<b>${escapeHtml(service.name)}</b> — ${service.price.toLocaleString('ru-RU')} ₽, ${service.duration} мин\n` +
            `👤 ${escapeHtml(booking.clientName)} (${contact})` +
            (comment ? `\n💬 ${escapeHtml(comment)}` : '') +
            `\n\nПодтвердите время в панели мастера.`,
            { reply_markup: { inline_keyboard: [[{ text: '⚙️ Открыть заявки', web_app: { url: panelUrl(master.botUsername) + '#bookings' } }]] } });
        sendFromMasterBot(master.id, user.id,
            `✅ Заявка на «${escapeHtml(service.name)}» отправлена мастеру. Мастер подтвердит дату и время — я пришлю сообщение.`,
            { priority: 'critical' });

        return { ok: true, bookingId: booking.id };
    });
};
