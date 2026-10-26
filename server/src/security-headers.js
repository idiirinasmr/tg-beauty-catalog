/*
 * Заголовки безопасности — единый источник. Используются сервером (index.js) и повторены
 * в vercel.json для статики на Vercel; test/unit.test.js проверяет, что они совпадают.
 */

const CSP = [
    "default-src 'self'",
    "script-src 'self' https://telegram.org",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self'",
    'frame-src https://oauth.telegram.org',
    "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org"
].join('; ');

const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': CSP
};

module.exports = { SECURITY_HEADERS };
