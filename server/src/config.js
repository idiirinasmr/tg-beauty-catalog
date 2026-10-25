/* Конфигурация из переменных окружения (server/.env) */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const env = process.env;

function required(name) {
    if (!env[name]) {
        throw new Error(`Не задана переменная окружения ${name} (см. server/.env.example)`);
    }
    return env[name];
}

// Ключ шифрования токенов читается из файла, а не из .env (раздел 13.1 плана).
// Нет файла — сервер не стартует.
function loadEncryptionKey() {
    const keyPath = path.resolve(path.join(__dirname, '..'), required('ENCRYPTION_KEY_PATH'));
    if (!fs.existsSync(keyPath)) {
        throw new Error(`Файл ключа шифрования не найден: ${keyPath}. Создайте его: npm run generate-key`);
    }
    const key = fs.readFileSync(keyPath, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/i.test(key)) {
        throw new Error('Ключ шифрования должен быть 64 hex-символа (32 байта)');
    }
    return key;
}

const isDev = env.NODE_ENV === 'development';
const appUrl = (env.APP_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, '');

const config = {
    isDev,
    port: Number(env.PORT || 3000),
    appUrl,
    botMode: env.BOT_MODE || (appUrl.startsWith('https://') ? 'webhook' : 'polling'),
    jwtSecret: required('JWT_SECRET'),
    encryptionKey: loadEncryptionKey(),
    maxMasters: Number(env.MAX_MASTERS || 50),

    adminIds: (env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
    adminBotToken: env.ADMIN_BOT_TOKEN || '',
    adminBotUsername: env.ADMIN_BOT_USERNAME || '',

    supabaseUrl: env.SUPABASE_URL || '',
    supabaseServiceKey: env.SUPABASE_SERVICE_KEY || '',
    supabaseBucket: env.SUPABASE_BUCKET || 'media',

    proPrice: Number(env.PRO_PRICE || 500),
    yukassaShopId: env.YUKASSA_SHOP_ID || '',
    yukassaSecretKey: env.YUKASSA_SECRET_KEY || '',
    manualPaymentDetails: env.MANUAL_PAYMENT_DETAILS || '',

    devLogin: isDev && env.DEV_LOGIN === '1',

    // Лимиты тарифа Free (раздел 5 плана)
    freeLimits: { services: 5, portfolio: 6, faq: 10 },
    timezone: 'Europe/Moscow'
};

module.exports = config;
