/*
 * Управление ботами: один процесс — много ботов (боты мастеров + бот владельца).
 *
 * Режимы (BOT_MODE):
 *  - webhook (прод): один маршрут POST /bot/:hookId, hookId — непредсказуемый HMAC от bot_id,
 *    плюс заголовок X-Telegram-Bot-Api-Secret-Token. Ответ 200 сразу, обработка в фоне,
 *    дедупликация по update_id.
 *  - polling (локально): bot.start() для каждого бота.
 */

const crypto = require('crypto');
const { Bot, GrammyError } = require('grammy');
const { autoRetry } = require('@grammyjs/auto-retry');
const config = require('../config');
const prisma = require('../utils/db');
const { decrypt } = require('../utils/encrypt');

const bots = new Map();     // key (masterId | 'admin') -> entry
const hooks = new Map();    // hookId -> entry
const DEDUP_SIZE = 200;

function hmac(label, value) {
    return crypto.createHmac('sha256', config.jwtSecret).update(`${label}:${value}`).digest('hex');
}

function miniAppUrl(botUsername) {
    return `${config.appUrl}/app/?bot=${encodeURIComponent(botUsername)}`;
}

function panelUrl(botUsername) {
    return `${config.appUrl}/admin/${botUsername ? `?bot=${encodeURIComponent(botUsername)}` : ''}`;
}

function createBot(token) {
    const bot = new Bot(token, { client: { timeoutSeconds: 15 } });
    // 429 Too Many Requests -> ждём retry_after и повторяем; сетевые ошибки — тоже
    bot.api.config.use(autoRetry({ maxRetryAttempts: 5, maxDelaySeconds: 60, rethrowHttpErrors: false }));
    return bot;
}

function isUnauthorized(err) {
    return err instanceof GrammyError && err.error_code === 401;
}

/**
 * Запустить бота. setup(bot) регистрирует обработчики.
 * onDead() вызывается, если токен стал недействительным (401).
 */
async function launch(key, token, setup, onDead) {
    await stop(key);
    const bot = createBot(token);
    await bot.init(); // getMe; бросит 401 при неверном токене
    setup(bot);
    bot.catch(err => {
        console.error(`[bot ${bot.botInfo.username}]`, err.error?.message || err.message);
    });

    const entry = { key, bot, username: bot.botInfo.username, seen: [], onDead };
    bots.set(key, entry);

    if (config.botMode === 'webhook') {
        const hookId = hmac('hook', bot.botInfo.id).slice(0, 40);
        entry.hookId = hookId;
        entry.secret = hmac('secret', bot.botInfo.id).slice(0, 64);
        hooks.set(hookId, entry);
        await bot.api.setWebhook(`${config.appUrl}/bot/${hookId}`, {
            secret_token: entry.secret,
            allowed_updates: ['message', 'callback_query']
        });
    } else {
        await bot.api.deleteWebhook().catch(() => {});
        bot.start({
            allowed_updates: ['message', 'callback_query'],
            onStart: () => console.log(`[bot] @${entry.username} polling`)
        }).catch(err => handleDead(entry, err));
    }
    return entry;
}

async function handleDead(entry, err) {
    if (isUnauthorized(err) && bots.get(entry.key) === entry) {
        console.error(`[bot] @${entry.username}: токен недействителен`);
        await stop(entry.key);
        entry.onDead?.();
    } else if (err) {
        console.error(`[bot] @${entry.username}:`, err.message);
    }
}

async function stop(key) {
    const entry = bots.get(key);
    if (!entry) return;
    bots.delete(key);
    if (entry.hookId) hooks.delete(entry.hookId);
    try {
        if (config.botMode === 'webhook') await entry.bot.api.deleteWebhook();
        else await entry.bot.stop();
    } catch { /* бот уже мёртв — не важно */ }
}

/** Вызов из Fastify-маршрута вебхука. Возвращает false, если хук/секрет неверны. */
function handleWebhook(hookId, secretHeader, update) {
    const entry = hooks.get(hookId);
    const given = Buffer.from(String(secretHeader || ''));
    const expected = Buffer.from(entry?.secret || '');
    if (!entry || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        return false;
    }
    if (entry.seen.includes(update.update_id)) return true; // повтор от Telegram
    entry.seen.push(update.update_id);
    if (entry.seen.length > DEDUP_SIZE) entry.seen.shift();

    entry.bot.handleUpdate(update).catch(err => handleDead(entry, err));
    return true;
}

// ---------- Боты мастеров ----------

async function onMasterBotDead(masterId) {
    const master = await prisma.master.findUnique({ where: { id: masterId } });
    if (!master) return;
    const { notifyAdmin } = require('./admin-bot');
    notifyAdmin(`⚠️ Бот мастера ${master.name} (@${master.botUsername}) перестал работать: токен недействителен. Мастеру нужно подключить бота заново в панели.`);
}

async function startMasterBot(master) {
    const { setupMasterBot } = require('./bot-handlers');
    const token = decrypt(master.botToken, config.encryptionKey);
    const entry = await launch(master.id, token, bot => setupMasterBot(bot, master.id), () => onMasterBotDead(master.id));
    await configureMasterBot(entry.bot, master);
    return entry;
}

/** Кнопка меню «Записаться» -> Mini App, команды, описание */
async function configureMasterBot(bot, master) {
    const api = bot.api;
    const username = bot.botInfo.username;
    await Promise.allSettled([
        api.setChatMenuButton({
            menu_button: { type: 'web_app', text: 'Записаться', web_app: { url: miniAppUrl(username) } }
        }),
        api.setMyCommands([
            { command: 'start', description: 'Открыть каталог услуг' },
            { command: 'my_bookings', description: 'Мои записи' },
            { command: 'help', description: 'Как записаться и контакты' }
        ]),
        api.setMyShortDescription(`${master.name} — ${master.specialty || 'бьюти-мастер'}. Запись онлайн прямо в Telegram.`.slice(0, 120))
    ]);
}

async function startAll() {
    const masters = await prisma.master.findMany({ where: { botToken: { not: null } } });
    for (const master of masters) {
        try {
            await startMasterBot(master);
        } catch (err) {
            console.error(`[bot] не удалось запустить бота мастера ${master.name}:`, err.message);
            if (isUnauthorized(err)) onMasterBotDead(master.id);
        }
    }
    console.log(`[bot] запущено ботов мастеров: ${[...bots.keys()].filter(k => k !== 'admin').length}`);
}

async function stopAll() {
    await Promise.all([...bots.keys()].map(stop));
}

function getApi(key) {
    return bots.get(key)?.bot.api || null;
}

function isRunning(key) {
    return bots.has(key);
}

function runningCount() {
    return [...bots.keys()].filter(k => k !== 'admin').length;
}

module.exports = {
    launch, stop, stopAll, startAll, startMasterBot, handleWebhook,
    getApi, isRunning, runningCount, isUnauthorized, createBot, miniAppUrl, panelUrl
};
