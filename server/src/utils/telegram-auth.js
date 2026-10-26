/*
 * Проверка подписей Telegram (без внешних зависимостей):
 *  - initData из Mini App: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *  - Telegram Login Widget: https://core.telegram.org/widgets/login#checking-authorization
 */

const crypto = require('crypto');

const MAX_AGE_SECONDS = 24 * 60 * 60;

function safeEqualHex(a, b) {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function isFresh(authDate, maxAge) {
    const age = Math.floor(Date.now() / 1000) - Number(authDate);
    return Number.isFinite(age) && age >= 0 && age <= maxAge;
}

/** Возвращает { user, startParam, authDate } или null, если подпись неверна. */
function validateInitData(initData, botToken, maxAge = MAX_AGE_SECONDS) {
    if (!initData || !botToken) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
    params.delete('hash');

    const dataCheckString = [...params.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');

    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    if (!safeEqualHex(expected, hash)) return null;
    if (!isFresh(params.get('auth_date'), maxAge)) return null;

    let user = null;
    try { user = JSON.parse(params.get('user') || 'null'); } catch { return null; }
    if (!user?.id) return null;

    return { user, startParam: params.get('start_param'), authDate: Number(params.get('auth_date')) };
}

/** data — объект из Login Widget (id, first_name, ..., auth_date, hash). Возвращает true/false. */
function validateLoginWidget(data, botToken, maxAge = MAX_AGE_SECONDS) {
    if (!data?.hash || !botToken) return false;
    const { hash, ...fields } = data;
    const dataCheckString = Object.keys(fields)
        .filter(k => fields[k] !== undefined && fields[k] !== null)
        .sort()
        .map(k => `${k}=${fields[k]}`)
        .join('\n');

    const secret = crypto.createHash('sha256').update(botToken).digest();
    const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    return /^[0-9a-f]{64}$/i.test(hash) && safeEqualHex(expected, hash) && isFresh(fields.auth_date, maxAge);
}

module.exports = { validateInitData, validateLoginWidget };
