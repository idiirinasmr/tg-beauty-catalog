/*
 * Авторизация мастера и владельца платформы через JWT.
 * JWT payload: { tg: '<telegram_id>', mid: '<master_id>' | null }
 */

const config = require('../config');
const prisma = require('../utils/db');

function httpError(statusCode, message) {
    return Object.assign(new Error(message), { statusCode });
}

async function verifyJwt(request) {
    try {
        await request.jwtVerify();
    } catch {
        throw httpError(401, 'Требуется вход через Telegram');
    }
}

/** preHandler: токен валиден (мастер может быть ещё не зарегистрирован) */
async function requireTelegramUser(request) {
    await verifyJwt(request);
}

function isAdminId(telegramId) {
    return config.adminIds.includes(String(telegramId));
}

/**
 * preHandler: зарегистрированный мастер, кладёт его в request.master.
 * src = 'impersonate' — владелец платформы настраивает мастера «под ключ»
 * (токен выдаёт только POST /api/admin/masters/:id/impersonate).
 */
async function requireMaster(request) {
    await verifyJwt(request);
    const master = request.user.mid
        ? await prisma.master.findUnique({ where: { id: request.user.mid } })
        : null;
    const allowed = request.user.src === 'impersonate'
        ? isAdminId(request.user.tg)
        : master && String(master.telegramId) === request.user.tg;
    if (!master || !allowed) {
        throw httpError(403, 'Сначала завершите регистрацию');
    }
    request.master = master;
}

/** preHandler: только владелец платформы (ADMIN_TELEGRAM_IDS) */
async function requireAdmin(request) {
    await verifyJwt(request);
    // Вход через бота мастера (src = 'masterbot') прав админа не даёт — см. routes/auth.js
    if (request.user.src !== 'platform' || !isAdminId(request.user.tg)) {
        throw httpError(403, 'Доступ только для администратора платформы');
    }
}

module.exports = { requireTelegramUser, requireMaster, requireAdmin, isAdminId, httpError };
