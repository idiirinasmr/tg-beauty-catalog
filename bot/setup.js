/**
 * Настройка бота через Telegram Bot API
 * Запуск: node bot/setup.js
 */

const fs = require('fs');
const path = require('path');

// Читаем токен из .env
const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
const BOT_TOKEN = envContent.match(/BOT_TOKEN=(.+)/)?.[1]?.trim();

if (!BOT_TOKEN) {
    console.error('BOT_TOKEN не найден в .env');
    process.exit(1);
}

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function callAPI(method, params = {}) {
    const res = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
    });
    const data = await res.json();
    if (!data.ok) {
        console.error(`${method}: ${data.description}`);
    } else {
        console.log(`${method}: OK`);
    }
    return data;
}

async function setup() {
    console.log('Настройка бота...\n');

    // 1. Описание бота (видно при первом открытии чата)
    await callAPI('setMyDescription', {
        description: 'Каталог услуг мастера Анны — маникюр, педикюр, наращивание и дизайн ногтей. Выберите услугу и запишитесь прямо в Telegram. Нажмите «Записаться» внизу, чтобы открыть каталог.',
        language_code: 'ru'
    });

    // 2. Короткое описание (видно в профиле бота)
    await callAPI('setMyShortDescription', {
        short_description: 'Запись на маникюр и педикюр к мастеру Анне — быстро и удобно прямо в Telegram.',
        language_code: 'ru'
    });

    // 3. Команды бота
    await callAPI('setMyCommands', {
        commands: [
            { command: 'start', description: 'Открыть каталог услуг' },
            { command: 'help', description: 'Как пользоваться ботом' }
        ],
        language_code: 'ru'
    });

    // 4. Установить Menu Button (кнопка открытия Mini App)
    await callAPI('setChatMenuButton', {
        menu_button: {
            type: 'web_app',
            text: 'Записаться',
            web_app: { url: 'https://idiirinasmr.github.io/tg-beauty-catalog/' }
        }
    });

    console.log('\nГотово! Бот настроен.');
}

setup().catch(console.error);
