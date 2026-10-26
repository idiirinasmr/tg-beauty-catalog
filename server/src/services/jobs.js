/* Задачи по расписанию — общие для node-cron (свой сервер) и /api/cron/* (Vercel) */

const reminder = require('./reminder');
const broadcast = require('./broadcast');
const adminBot = require('./admin-bot');
const botManager = require('./bot-manager');
const { checkSubscriptions } = require('./payment');

/** Каждые 5 минут: напоминания, запросы отзывов, досылка рассылок */
async function tick() {
    await botManager.ensureAdminWebhook().catch(err => console.error('[cron] admin webhook:', err.message));
    await reminder.tick();
    await broadcast.resumeAll();
}

/** Раз в день (21:00 МСК): просроченные подписки, отчёт владельцу, проверка бэкапов */
async function daily() {
    await checkSubscriptions();
    await adminBot.sendDailyReport();
    await adminBot.checkBackups();
}

module.exports = { tick, daily };
