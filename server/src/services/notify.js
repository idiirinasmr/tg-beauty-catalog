/* Отправка сообщений через бота мастера с учётом очереди и заблокировавших бота клиентов */

const { GrammyError } = require('grammy');
const prisma = require('../utils/db');
const { enqueue } = require('../utils/queue');
const { track } = require('../utils/background');
const botManager = require('./bot-manager');

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/**
 * Отправить сообщение от бота мастера.
 * Возвращает true при успехе, false если бот не запущен или клиент заблокировал бота.
 * Можно вызывать без await: отправка дождётся завершения и на Vercel (utils/background.js).
 */
function sendFromMasterBot(masterId, chatId, text, options = {}) {
    return track(send(masterId, chatId, text, options));
}

async function send(masterId, chatId, text, { priority = 'high', photo, ...extra } = {}) {
    const api = await botManager.getApi(masterId);
    if (!api) return false;
    try {
        await enqueue(masterId, () => photo
            ? api.sendPhoto(String(chatId), photo, { caption: text, parse_mode: 'HTML', ...extra })
            : api.sendMessage(String(chatId), text, { parse_mode: 'HTML', ...extra }), priority);
        return true;
    } catch (err) {
        // 401: токен бота отозван в BotFather — отключаем бота и сообщаем владельцу
        if (botManager.isUnauthorized(err)) {
            await botManager.markBotDead(masterId);
            return false;
        }
        // 403: пользователь заблокировал бота или не начинал с ним диалог
        if (err instanceof GrammyError && err.error_code === 403) {
            await prisma.client.updateMany({
                where: { masterId, telegramId: BigInt(chatId) },
                data: { isBlocked: true }
            });
            return false;
        }
        console.error('[notify]', err.message);
        return false;
    }
}

function htmlToText(html) {
    return String(html).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function notifyMaster(master, text, extra = {}) {
    if (!master.telegramId) {
        // Мастер «под ключ» ещё не открыл ссылку привязки — чтобы заявка не потерялась, шлём владельцу
        const { notifyAdmin } = require('./admin-bot');
        notifyAdmin(`📭 Для мастера ${master.name} (ещё не привязал Telegram):\n\n${htmlToText(text)}`);
        return false;
    }
    return sendFromMasterBot(master.id, master.telegramId, text, { priority: 'critical', ...extra });
}

module.exports = { sendFromMasterBot, notifyMaster, escapeHtml };
