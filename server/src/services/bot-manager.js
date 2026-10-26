/*
 * Управление ботами: один процесс — много ботов (боты мастеров + бот владельца).
 *
 * Режимы (BOT_MODE):
 *  - webhook (прод): один маршрут POST /bot/:hookId, hookId — непредсказуемый HMAC от bot_id,
 *    плюс заголовок X-Telegram-Bot-Api-Secret-Token. Ответ 200 сразу, обработка в фоне,
 *    дедупликация по update_id.
 *  - polling (локально): bot.start() для каждого бота.
 *
 * На Vercel (config.serverless) боты не живут в памяти: при каждом апдейте бот «просыпается»
 * по hookId (wake), а для отправки сообщений Api создаётся по токену из БД (getApi).
 * Вебхук ставится один раз — при подключении бота (launch) или в cron (ensureAdminWebhook).
 */

const crypto = require('crypto');
const { Bot, GrammyError } = require('grammy');
const { autoRetry } = require('@grammyjs/auto-retry');
const config = require('../config');
const prisma = require('../utils/db');
const { decrypt } = require('../utils/encrypt');

const ADMIN_KEY = 'admin';
const bots = new Map();     // key (masterId | 'admin') -> entry
const hooks = new Map();    // hookId -> entry
const apis = new Map();     // key -> Api (serverless: только для отправки)
const DEDUP_SIZE = 200;
const ALLOWED_UPDATES = ['message', 'callback_query'];

function hmac(label, value) {
    return crypto.createHmac('sha256', config.jwtSecret).update(`${label}:${value}`).digest('hex');
}

function hookIdFor(botId) {
    return hmac('hook', botId).slice(0, 40);
}

function secretFor(botId) {
    return hmac('secret', botId).slice(0, 64);
}

function miniAppUrl(botUsername) {
    return `${config.appUrl}/app/?bot=${encodeURIComponent(botUsername)}`;
}

function panelUrl(botUsername) {
    return `${config.appUrl}/admin/${botUsername ? `?bot=${encodeURIComponent(botUsername)}` : ''}`;
}

function createBot(token, botInfo) {
    const bot = new Bot(token, { client: { timeoutSeconds: 15 }, botInfo });
    // 429 Too Many Requests -> ждём retry_after и повторяем; сетевые ошибки — тоже
    bot.api.config.use(autoRetry({ maxRetryAttempts: 5, maxDelaySeconds: 60, rethrowHttpErrors: false }));
    return bot;
}

/** botInfo без запроса getMe — для «пробуждения» бота на Vercel */
function knownBotInfo(botId, username) {
    return {
        id: Number(botId), is_bot: true, first_name: username, username,
        can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
        can_connect_to_business: false, has_main_web_app: false
    };
}

function isUnauthorized(err) {
    return err instanceof GrammyError && err.error_code === 401;
}

function register(key, bot, setup, onDead) {
    setup(bot);
    bot.catch(err => {
        console.error(`[bot ${bot.botInfo.username}]`, err.error?.message || err.message);
    });
    const entry = {
        key, bot, onDead, username: bot.botInfo.username, seen: [],
        hookId: hookIdFor(bot.botInfo.id), secret: secretFor(bot.botInfo.id)
    };
    bots.set(key, entry);
    hooks.set(entry.hookId, entry);
    return entry;
}

/**
 * Запустить бота. setup(bot) регистрирует обработчики.
 * onDead() вызывается, если токен стал недействительным (401).
 */
async function launch(key, token, setup, onDead) {
    await stop(key);
    const bot = createBot(token);
    await bot.init(); // getMe; бросит 401 при неверном токене
    const entry = register(key, bot, setup, onDead);

    if (config.botMode === 'webhook') {
        await bot.api.setWebhook(`${config.appUrl}/bot/${entry.hookId}`, {
            secret_token: entry.secret,
            allowed_updates: ALLOWED_UPDATES
        });
    } else {
        await bot.api.deleteWebhook().catch(() => {});
        bot.start({
            allowed_updates: ALLOWED_UPDATES,
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
    apis.delete(key);
    if (!entry) {
        // Vercel: бота нет в памяти, но вебхук в Telegram мог быть поставлен — снимаем по токену
        if (config.serverless && key !== ADMIN_KEY) {
            const api = await getApi(key).catch(() => null);
            apis.delete(key);
            await api?.deleteWebhook().catch(() => {});
        }
        return;
    }
    bots.delete(key);
    hooks.delete(entry.hookId);
    try {
        if (config.botMode === 'webhook') await entry.bot.api.deleteWebhook();
        else await entry.bot.stop();
    } catch { /* бот уже мёртв — не важно */ }
}

/** Vercel: найти бота по hookId и поднять его обработчики (без getMe) */
async function wake(hookId) {
    if (config.adminBotToken) {
        const adminId = config.adminBotToken.split(':')[0];
        if (hookIdFor(adminId) === hookId) {
            const { setupAdminBot } = require('./admin-bot');
            const bot = createBot(config.adminBotToken, knownBotInfo(adminId, config.adminBotUsername));
            return register(ADMIN_KEY, bot, setupAdminBot);
        }
    }
    const candidates = await prisma.master.findMany({
        where: { botId: { not: null }, botToken: { not: null } },
        select: { id: true, botId: true }
    });
    const match = candidates.find(m => hookIdFor(m.botId) === hookId);
    if (!match) return null;
    const master = await prisma.master.findUnique({ where: { id: match.id } });
    const { setupMasterBot } = require('./bot-handlers');
    const bot = createBot(decrypt(master.botToken, config.encryptionKey), knownBotInfo(master.botId, master.botUsername));
    return register(master.id, bot, b => setupMasterBot(b, master.id), () => onMasterBotDead(master.id));
}

/** Вызов из Fastify-маршрута вебхука. Возвращает false, если хук/секрет неверны. */
async function handleWebhook(hookId, secretHeader, update) {
    const entry = hooks.get(hookId) || (config.serverless ? await wake(hookId) : null);
    const given = Buffer.from(String(secretHeader || ''));
    const expected = Buffer.from(entry?.secret || '');
    if (!entry || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        return false;
    }
    if (entry.seen.includes(update.update_id)) return true; // повтор от Telegram
    entry.seen.push(update.update_id);
    if (entry.seen.length > DEDUP_SIZE) entry.seen.shift();

    const handled = entry.bot.handleUpdate(update).catch(err => handleDead(entry, err));
    // На Vercel обработку нужно дождаться до ответа, иначе функция «уснёт» на полпути
    if (config.serverless) await handled;
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
    console.log(`[bot] запущено ботов мастеров: ${[...bots.keys()].filter(k => k !== ADMIN_KEY).length}`);
}

async function stopAll() {
    await Promise.all([...bots.keys()].map(stop));
}

/** Api для отправки сообщений от имени бота (key = id мастера или 'admin'), null — бота нет */
async function getApi(key) {
    const running = bots.get(key);
    if (running) return running.bot.api;
    if (!config.serverless) return null;
    if (apis.has(key)) return apis.get(key);

    let token = null;
    if (key === ADMIN_KEY) {
        token = config.adminBotToken || null;
    } else {
        const master = await prisma.master.findUnique({ where: { id: key }, select: { botToken: true } });
        token = master?.botToken ? decrypt(master.botToken, config.encryptionKey) : null;
    }
    const api = token ? createBot(token).api : null;
    apis.set(key, api);
    return api;
}

/** Подключён ли бот мастера и может ли он отправлять сообщения */
function isActive(master) {
    return config.serverless ? Boolean(master.botToken) : bots.has(master.id);
}

async function activeCount() {
    return config.serverless
        ? prisma.master.count({ where: { botToken: { not: null } } })
        : [...bots.keys()].filter(k => k !== ADMIN_KEY).length;
}

/** Vercel: поставить вебхук бота владельца, если он ещё не стоит (вызывается из cron) */
async function ensureAdminWebhook() {
    if (!config.serverless || !config.adminBotToken) return;
    const botId = config.adminBotToken.split(':')[0];
    const url = `${config.appUrl}/bot/${hookIdFor(botId)}`;
    const api = await getApi(ADMIN_KEY);
    const info = await api.getWebhookInfo();
    if (info.url === url) return;
    await api.setWebhook(url, { secret_token: secretFor(botId), allowed_updates: ALLOWED_UPDATES });
    const { ADMIN_COMMANDS } = require('./admin-bot');
    await api.setMyCommands(ADMIN_COMMANDS).catch(() => {});
}

module.exports = {
    launch, stop, stopAll, startAll, startMasterBot, handleWebhook, ensureAdminWebhook,
    getApi, isActive, activeCount, isUnauthorized, createBot, miniAppUrl, panelUrl, ADMIN_KEY
};
