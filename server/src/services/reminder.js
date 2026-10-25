/*
 * Cron каждые 5 минут:
 *  - напоминания клиентам за 24 ч и за 2 ч до визита (только Pro)
 *  - запрос отзыва через 2 ч после завершения визита (все тарифы)
 * Флаги в bookings гарантируют однократную отправку даже после рестарта.
 */

const { InlineKeyboard } = require('grammy');
const prisma = require('../utils/db');
const { isPro } = require('../middleware/plan-check');
const { sendFromMasterBot, escapeHtml } = require('./notify');
const { formatDate } = require('./bot-handlers');

const HOUR = 60 * 60 * 1000;

async function sendReminders() {
    const now = Date.now();
    const bookings = await prisma.booking.findMany({
        where: {
            status: 'confirmed',
            appointmentAt: { gt: new Date(now), lte: new Date(now + 24 * HOUR) },
            OR: [{ reminder24hSent: false }, { reminder2hSent: false }]
        },
        include: { master: true }
    });

    for (const b of bookings) {
        if (!isPro(b.master)) continue;
        const left = b.appointmentAt.getTime() - now;
        const soon = left <= 2 * HOUR;
        if (soon ? b.reminder2hSent : b.reminder24hSent) continue;

        // Сначала помечаем, потом шлём — чтобы параллельный запуск не отправил дважды
        const claimed = await prisma.booking.updateMany({
            where: { id: b.id, ...(soon ? { reminder2hSent: false } : { reminder24hSent: false }) },
            data: soon ? { reminder2hSent: true, reminder24hSent: true } : { reminder24hSent: true }
        });
        if (!claimed.count) continue;

        const when = soon ? 'через 2 часа' : 'завтра';
        const address = b.master.address ? `\n📍 ${escapeHtml(b.master.address)}` : '';
        await sendFromMasterBot(b.masterId, b.clientTelegramId,
            `⏰ Напоминание: ${when} у вас запись\n\n<b>${escapeHtml(b.serviceName)}</b>\n🗓 ${formatDate(b.appointmentAt)}${address}\n\nЕсли планы изменились — напишите сюда, мастер перенесёт запись.`,
            { priority: 'high' });
    }
}

async function requestReviews() {
    const bookings = await prisma.booking.findMany({
        where: { status: 'completed', reviewRequested: false, completedAt: { lte: new Date(Date.now() - 2 * HOUR) } },
        take: 200
    });
    for (const b of bookings) {
        const claimed = await prisma.booking.updateMany({ where: { id: b.id, reviewRequested: false }, data: { reviewRequested: true } });
        if (!claimed.count) continue;
        const kb = new InlineKeyboard();
        for (let i = 1; i <= 5; i++) kb.text('⭐'.repeat(i), `rate:${b.id}:${i}`).row();
        await sendFromMasterBot(b.masterId, b.clientTelegramId,
            `Спасибо за визит! Как вам <b>${escapeHtml(b.serviceName)}</b>? Оцените, пожалуйста:`,
            { priority: 'low', reply_markup: kb });
    }
}

async function tick() {
    try {
        await sendReminders();
        await requestReviews();
    } catch (err) {
        console.error('[reminder]', err.message);
    }
}

module.exports = { tick, sendReminders, requestReviews };
