/* Задачи по расписанию — общие для node-cron (свой сервер) и /api/cron/* (Vercel) */

const reminder = require('./reminder');
const broadcast = require('./broadcast');
const adminBot = require('./admin-bot');
const botManager = require('./bot-manager');
const { checkSubscriptions } = require('./payment');

/** Запустить задачи по очереди; ошибка одной не отменяет остальные */
async function runAll(tasks) {
    const failed = [];
    for (const [name, fn] of tasks) {
        try {
            await fn();
        } catch (err) {
            console.error(`[cron] ${name}:`, err.message);
            failed.push(name);
        }
    }
    return { failed };
}

/** Каждые 5 минут: напоминания, запросы отзывов, досылка рассылок */
function tick() {
    return runAll([
        ['admin-webhook', botManager.ensureAdminWebhook],
        ['reminders', reminder.sendReminders],
        ['reviews', reminder.requestReviews],
        ['broadcasts', broadcast.resumeAll]
    ]);
}

const subscriptions = () => runAll([['subscriptions', checkSubscriptions]]);
const report = () => runAll([['report', adminBot.sendDailyReport]]);
const backups = () => runAll([['backups', adminBot.checkBackups]]);

/** Раз в день на Vercel (21:00 МСК): всё ежедневное одним запуском */
function daily() {
    return runAll([
        ['subscriptions', checkSubscriptions],
        ['report', adminBot.sendDailyReport],
        ['backups', adminBot.checkBackups]
    ]);
}

module.exports = { tick, daily, subscriptions, report, backups };
