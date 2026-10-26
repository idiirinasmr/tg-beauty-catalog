/*
 * Режим Vercel (SERVERLESS=1): боты не живут в памяти, «просыпаются» по вебхуку,
 * расписание — через /api/cron/* с секретом. Локальная БД, за собой убирает.
 */

process.env.SERVERLESS = '1';
process.env.CRON_SECRET = 'test-cron-secret-0123456789';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const config = require('../src/config');
const prisma = require('../src/utils/db');
const { encrypt } = require('../src/utils/encrypt');
const { buildApp } = require('../src/index');
const { flush } = require('../src/utils/background');

if (!/127\.0\.0\.1:54329|localhost:54329/.test(process.env.DATABASE_URL)) {
    throw new Error('serverless.test.js запускается только на локальной БД');
}

const BOT_ID = 990099009;
const BOT_TOKEN = `${BOT_ID}:FAKEserverlessTokenForTests_0123456`;
const CLIENT_ID = 8800880088;
let app, masterId;

const hmac = (label, value) => crypto.createHmac('sha256', config.jwtSecret).update(`${label}:${value}`).digest('hex');
const hookId = hmac('hook', BOT_ID).slice(0, 40);
const secret = hmac('secret', BOT_ID).slice(0, 64);

async function cleanup() {
    await prisma.master.deleteMany({ where: { botId: BigInt(BOT_ID) } });
}

test.before(async () => {
    app = buildApp();
    await app.ready();
    await cleanup();
    masterId = (await prisma.master.create({
        data: {
            telegramId: 5500550055n, name: 'Serverless Мастер',
            botToken: encrypt(BOT_TOKEN, config.encryptionKey), botUsername: 'serverless_test_bot', botId: BigInt(BOT_ID)
        }
    })).id;
});

test.after(async () => {
    await flush();
    await cleanup();
    await app.close();
    await prisma.$disconnect();
});

test('режим Vercel включён', () => {
    assert.strictEqual(config.serverless, true);
    assert.strictEqual(config.botMode, 'webhook');
});

test('статику сервер не раздаёт (её раздаёт Vercel)', async () => {
    assert.strictEqual((await app.inject({ method: 'GET', url: '/admin/' })).statusCode, 404);
});

test('cron: без секрета — 401, с секретом — выполняется', async () => {
    assert.strictEqual((await app.inject({ method: 'GET', url: '/api/cron/tick' })).statusCode, 401);
    assert.strictEqual((await app.inject({
        method: 'GET', url: '/api/cron/tick', headers: { authorization: 'Bearer wrong-secret-0123456789abcd' }
    })).statusCode, 401);
    const ok = await app.inject({ method: 'GET', url: '/api/cron/tick', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
    assert.strictEqual(ok.statusCode, 200, ok.body);
    assert.strictEqual((await app.inject({
        method: 'GET', url: '/api/cron/nope', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }
    })).statusCode, 400);
});

test('вебхук: чужой хук и неверный секрет — 401', async () => {
    const update = { update_id: 1, message: { message_id: 1, date: 1, chat: { id: CLIENT_ID, type: 'private' }, from: { id: CLIENT_ID, is_bot: false, first_name: 'K' }, text: 'hi' } };
    assert.strictEqual((await app.inject({ method: 'POST', url: '/bot/unknownhook', payload: update, headers: { 'x-telegram-bot-api-secret-token': secret } })).statusCode, 401);
    assert.strictEqual((await app.inject({ method: 'POST', url: `/bot/${hookId}`, payload: update, headers: { 'x-telegram-bot-api-secret-token': 'x'.repeat(64) } })).statusCode, 401);
});

test('вебхук: бот мастера «просыпается» и обрабатывает сообщение до ответа', async () => {
    const update = {
        update_id: 2,
        message: {
            message_id: 2, date: Math.floor(Date.now() / 1000), text: '/start',
            entities: [{ type: 'bot_command', offset: 0, length: 6 }],
            chat: { id: CLIENT_ID, type: 'private' },
            from: { id: CLIENT_ID, is_bot: false, first_name: 'Клиентка', username: 'srv_client' }
        }
    };
    const res = await app.inject({ method: 'POST', url: `/bot/${hookId}`, payload: update, headers: { 'x-telegram-bot-api-secret-token': secret } });
    assert.strictEqual(res.statusCode, 200);
    // Обработчик успел записать клиента ещё до ответа (ответ в Telegram с фейковым токеном не уйдёт — это нормально)
    const client = await prisma.client.findFirst({ where: { masterId, telegramId: BigInt(CLIENT_ID) } });
    assert.ok(client, 'клиент записан');
    assert.strictEqual(client.firstName, 'Клиентка');
});

test('статус бота берётся из БД, а не из памяти процесса', async () => {
    const botManager = require('../src/services/bot-manager');
    const master = await prisma.master.findUnique({ where: { id: masterId } });
    assert.strictEqual(botManager.isActive(master), true);
    assert.strictEqual(botManager.isActive({ ...master, botToken: null }), false);
    assert.ok(await botManager.activeCount() >= 1);
});
