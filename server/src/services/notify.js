/* Отправка сообщений через бота мастера с учётом очереди и заблокировавших бота клиентов */

const { GrammyError } = require('grammy');
const prisma = require('../utils/db');
const { enqueue } = require('../utils/queue');
const botManager = require('./bot-manager');

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/**
 * Отправить сообщение от бота мастера.
 * Возвращает true при успехе, false если бот не запущен или клиент заблокировал бота.
 */
async function sendFromMasterBot(masterId, chatId, text, { priority = 'high', photo, ...extra } = {}) {
    const api = botManager.getApi(masterId);
    if (!api) return false;
    try {
        await enqueue(masterId, () => photo
            ? api.sendPhoto(String(chatId), photo, { caption: text, parse_mode: 'HTML', ...extra })
            : api.sendMessage(String(chatId), text, { parse_mode: 'HTML', ...extra }), priority);
        return true;
    } catch (err) {
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

async function notifyMaster(master, text, extra = {}) {
    if (!master.telegramId) return false; // мастер «под ключ» ещё не открыл свою ссылку
    return sendFromMasterBot(master.id, master.telegramId, text, { priority: 'critical', ...extra });
}

module.exports = { sendFromMasterBot, notifyMaster, escapeHtml };
