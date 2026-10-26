/*
 * Управление ботами: один процесс — много ботов (боты мастеров + бот владельца).
 *
 * Режимы (BOT_MODE):
 *  - webhook (прод): один маршрут POST /bot/:hookId. hookId = "<bot_id>_<HMAC>", плюс заголовок
 *    X-Telegram-Bot-Api-Secret-Token (тоже HMAC от bot_id). Чужие запросы отсекаются до обращения
 *    к БД. Дедупликация по update_id.
 *  - polling (локально): bot.start() для каждого бота.
 *
 * На Vercel (config.serverless) боты не живут в памяти: на каждый апдейт бот «просыпается»
 * заново по bot_id из БД (wake), а для отправки Api создаётся по актуальному токену (getApi).
 * Ничего не кэшируется между запросами — иначе тёплый экземпляр мог бы работать со старым
 * владельцем бота или старым токеном. Вебхук ставится при подключении бота (launch)
 * или в cron (ensureAdminWebhook).
 */

const crypto = require('crypto');
const { Bot, GrammyError } = require('grammy');
const { autoRetry } = require('@grammyjs/auto-retry');
const config = require('../config');
const prisma = require('../utils/db');
const { decrypt } = require('../utils/encrypt');
const { track } = require('../utils/background');

const ADMIN_KEY = 'admin';
const bots = new Map();     // key (masterId | 'admin') -> entry (только свой сервер)
const hooks = new Map();    // hookId -> entry (только свой сервер)
const DEDUP_SIZE = 200;
const ALLOWED_UPDATES = ['message', 'callback_query'];
const HOOK_RE = /^(\d{5,15})_([0-9a-f]{32})$/;

function hmac(label, value) {
    return crypto.createHmac('sha256', config.jwtSecret).update(`${label}:${value}`).digest('hex');
}

function hookIdFor(botId) {
    return `${botId}_${hmac('hook', botId).slice(0, 32)}`;
}

function secretFor(botId) {
    return hmac('secret', botId).slice(0, 64);
}

function safeEqual(a, b) {
    const bufA = Buffer.from(String(a || ''));
    const bufB = Buffer.from(String(b || ''));
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/** bot_id из hookId, если и hookId, и секрет из заголовка подписаны нашим ключом; иначе null */
function verifyHook(hookId, secretHeader) {
    const m = HOOK_RE.exec(hookId);
    if (!m || !safeEqual(hookId, hookIdFor(m[1])) || !safeEqual(secretHeader, secretFor(m[1]))) return null;
    return m[1];
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

/** Навесить обработчики. Возвращает entry; в карты процесса не кладёт */
function buildEntry(key, bot, setup, onDead) {
    setup(bot);
    bot.catch(err => {
        console.error(`[bot ${bot.botInfo.username}]`, err.error?.message || err.message);
        if (isUnauthorized(err.error) && onDead) track(Promise.resolve().then(onDead));
    });
    return { key, bot, onDead, username: bot.botInfo.username, seen: [], hookId: hookIdFor(bot.botInfo.id), secret: secretFor(bot.botInfo.id) };
}

/**
 * Запустить бота. setup(bot) регистрирует обработчики.
 * onDead() вызывается, если токен стал недействительным (401).
 */
async function launch(key, token, setup, onDead) {
    await stop(key);
    const bot = createBot(token);
    await bot.init(); // getMe; бросит 401 при неверном токене
    const entry = buildEntry(key, bot, setup, onDead);

    if (config.botMode === 'webhook') {
        await bot.api.setWebhook(`${config.appUrl}/bot/${entry.hookId}`, {
            secret_token: entry.secret,
            allowed_updates: ALLOWED_UPDATES
        });
    }
    if (config.serverless) return entry; // на Vercel в памяти не держим

    bots.set(key, entry);
    hooks.set(entry.hookId, entry);
    if (config.botMode !== 'webhook') {
        await bot.api.deleteWebhook().catch(() => {});
        bot.start({
            allowed_updates: ALLOWED_UPDATES,
            onStart: () => console.log(`[bot] @${entry.username} polling`)
        }).catch(err => handleDead(entry, err));
    }
    return entry;
}

async function handleDead(entry, err) {
    // handleUpdate оборачивает ошибку в BotError — настоящая ошибка Telegram в err.error
    const cause = err?.error ?? err;
    if (isUnauthorized(cause) && (config.serverless || bots.get(entry.key) === entry)) {
        console.error(`[bot] @${entry.username}: токен недействителен`);
        await stop(entry.key);
        await entry.onDead?.();
    } else if (err) {
        console.error(`[bot] @${entry.username}:`, err.message);
    }
}

async function stop(key) {
    const entry = bots.get(key);
    if (!entry) {
        // Vercel: бота нет в памяти, но вебхук в Telegram мог быть поставлен — снимаем по токену
        if (config.serverless && key !== ADMIN_KEY) {
            const api = await getApi(key).catch(() => null);
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

/** Vercel: поднять бота по bot_id (одна выборка по уникальному индексу, без getMe) */
async function wake(botId) {
    if (config.adminBotToken && config.adminBotToken.split(':')[0] === botId) {
        const { setupAdminBot } = require('./admin-bot');
        const bot = createBot(config.adminBotToken, knownBotInfo(botId, config.adminBotUsername));
        return buildEntry(ADMIN_KEY, bot, setupAdminBot);
    }
    const master = await prisma.master.findUnique({ where: { botId: BigInt(botId) } });
    if (!master?.botToken) return null;
    const { setupMasterBot } = require('./bot-handlers');
    const bot = createBot(decrypt(master.botToken, config.encryptionKey), knownBotInfo(botId, master.botUsername));
    return buildEntry(master.id, bot, b => setupMasterBot(b, master.id), () => markBotDead(master.id));
}

/** Вызов из Fastify-маршрута вебхука. Возвращает false, если хук/секрет неверны. */
async function handleWebhook(hookId, secretHeader, update) {
    const botId = verifyHook(hookId, secretHeader);
    if (!botId) return false;
    const entry = config.serverless ? await wake(botId) : hooks.get(hookId);
    if (!entry) return false;

    if (entry.seen.includes(update.update_id)) return true; // повтор от Telegram
    entry.seen.push(update.update_id);
    if (entry.seen.length > DEDUP_SIZE) entry.seen.shift();

    const handled = entry.bot.handleUpdate(update).catch(err => handleDead(entry, err));
    // На Vercel обработку нужно дождаться до ответа, иначе функция «уснёт» на полпути
    if (config.serverless) await handled;
    return true;
}

// ---------- Боты мастеров ----------

/**
 * Токен бота мастера больше не действует (мастер отозвал его в BotFather):
 * отключаем бота, чтобы панель предложила подключить заново, и сообщаем владельцу.
 */
async function markBotDead(masterId) {
    await stop(masterId).catch(() => {});
    const master = await prisma.master.findUnique({ where: { id: masterId } });
    if (!master?.botToken) return;
    await prisma.master.updateMany({
        where: { id: masterId, botToken: master.botToken },
        data: { botToken: null, botUsername: null, botId: null }
    });
    const { notifyAdmin } = require('./admin-bot');
    notifyAdmin(`⚠️ Бот мастера ${master.name} (@${master.botUsername}) перестал работать: токен недействителен. Бот отключён — нужно подключить его заново в панели мастера.`);
}

async function startMasterBot(master) {
    const { setupMasterBot } = require('./bot-handlers');
    const token = decrypt(master.botToken, config.encryptionKey);
    const entry = await launch(master.id, token, bot => setupMasterBot(bot, master.id), () => markBotDead(master.id));
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
            if (isUnauthorized(err)) markBotDead(master.id);
        }
    }
    console.log(`[bot] запущено ботов мастеров: ${[...bots.keys()].filter(k => k !== ADMIN_KEY).length}`);
}

async function stopAll() {
    await Promise.all([...bots.keys()].map(stop));
}

let adminApi;

/** Api для отправки сообщений от имени бота (key = id мастера или 'admin'), null — бота нет */
async function getApi(key) {
    const running = bots.get(key);
    if (running) return running.bot.api;
    if (!config.serverless) return null;

    if (key === ADMIN_KEY) {
        // Токен бота владельца задан в окружении и не меняется без передеплоя — можно кэшировать
        if (!config.adminBotToken) return null;
        adminApi ||= createBot(config.adminBotToken).api;
        return adminApi;
    }
    const master = await prisma.master.findUnique({ where: { id: key }, select: { botToken: true } });
    return master?.botToken ? createBot(decrypt(master.botToken, config.encryptionKey)).api : null;
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
    launch, stop, stopAll, startAll, startMasterBot, handleWebhook, ensureAdminWebhook, markBotDead,
    getApi, isActive, activeCount, isUnauthorized, createBot, miniAppUrl, panelUrl, hookIdFor, ADMIN_KEY
};
