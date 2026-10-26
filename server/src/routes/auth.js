/*
 * Вход мастера/владельца:
 *  - POST /api/auth/telegram — Telegram Login Widget (браузер), подпись ботом владельца
 *  - POST /api/auth/webapp   — панель открыта как Mini App внутри Telegram (initData)
 *  - POST /api/auth/dev      — только локально (NODE_ENV=development и DEV_LOGIN=1)
 */

const config = require('../config');
const prisma = require('../utils/db');
const { decrypt } = require('../utils/encrypt');
const { validateInitData, validateLoginWidget } = require('../utils/telegram-auth');
const { isAdminId, httpError } = require('../middleware/auth');

/**
 * src — чем подтверждена личность:
 *  'platform'  — подпись бота владельца (Login Widget / Mini App бота владельца)
 *  'masterbot' — подпись бота мастера. Токен этого бота знает сам мастер, поэтому
 *                такой вход годится только для его собственного аккаунта и не даёт прав админа.
 */
async function issueToken(app, tgUser, src = 'platform') {
    const tg = String(tgUser.id);
    const master = await prisma.master.findUnique({ where: { telegramId: BigInt(tg) }, select: { id: true } });
    const token = app.jwt.sign({ tg, mid: master?.id || null, src }, { expiresIn: '7d' });
    return {
        token,
        registered: Boolean(master),
        isAdmin: src === 'platform' && isAdminId(tg),
        user: { id: tg, firstName: tgUser.first_name || '', username: tgUser.username || null }
    };
}

module.exports = async function authRoutes(app) {
    app.get('/api/auth/config', async () => ({
        loginBotUsername: config.adminBotUsername || null,
        supportTelegram: config.supportTelegram || null,
        turnkeyPrice: config.turnkeyPrice,
        devLogin: config.devLogin
    }));

    app.post('/api/auth/telegram', {
        config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
        schema: { body: { type: 'object', required: ['id', 'hash', 'auth_date'] } }
    }, async request => {
        if (!validateLoginWidget(request.body, config.adminBotToken)) {
            throw httpError(401, 'Подпись Telegram недействительна, попробуйте войти ещё раз');
        }
        return issueToken(app, request.body);
    });

    app.post('/api/auth/webapp', {
        config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
        schema: {
            body: {
                type: 'object', required: ['initData'],
                properties: { initData: { type: 'string', maxLength: 4096 }, botUsername: { type: 'string', maxLength: 64 } }
            }
        }
    }, async request => {
        const { initData, botUsername } = request.body;
        if (!botUsername) {
            const data = validateInitData(initData, config.adminBotToken);
            if (!data) throw httpError(401, 'Подпись Telegram недействительна');
            return issueToken(app, data.user);
        }

        // Панель открыта из бота мастера: пускаем только владельца этого бота
        const m = await prisma.master.findUnique({ where: { botUsername }, select: { botToken: true, telegramId: true } });
        const data = m?.botToken && validateInitData(initData, decrypt(m.botToken, config.encryptionKey));
        if (!data) throw httpError(401, 'Подпись Telegram недействительна');
        if (String(data.user.id) !== String(m.telegramId)) {
            throw httpError(403, 'Панель доступна только мастеру — владельцу этого бота');
        }
        return issueToken(app, data.user, 'masterbot');
    });

    if (config.devLogin) {
        app.post('/api/auth/dev', {
            schema: { body: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^\\d+$' }, first_name: { type: 'string' } } } }
        }, async request => issueToken(app, request.body));
    }
};

module.exports.issueToken = issueToken;
