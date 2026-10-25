/*
 * Интеграционный сценарий через HTTP API на локальной БД (scripts/dev-db.js).
 * Внимание: очищает таблицы — запускается только на локальной базе.
 */

const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const prisma = require('../src/utils/db');
const { encrypt } = require('../src/utils/encrypt');
const { buildApp } = require('../src/index');
const { signInitData } = require('./helpers');

if (!/127\.0\.0\.1:54329|localhost:54329/.test(process.env.DATABASE_URL)) {
    throw new Error('api.test.js запускается только на локальной БД');
}

const BOT_TOKEN = '777000:FAKEtokenForTestsOnly_0123456789ab';
const ADMIN_ID = config.adminIds[0];
let app;

async function call(method, url, { token, body } = {}) {
    const res = await app.inject({
        method, url, payload: body,
        headers: token ? { authorization: `Bearer ${token}` } : {}
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

async function login(id, name) {
    const res = await call('POST', '/api/auth/dev', { body: { id: String(id), first_name: name } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.token;
}

test.before(async () => {
    for (const t of ['broadcast_recipients', 'broadcasts', 'reviews', 'bookings', 'services', 'portfolio', 'faq', 'clients', 'payments', 'masters', 'backup_log']) {
        await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`);
    }
    app = buildApp();
    await app.ready();
});

test.after(async () => {
    await app.close();
    await prisma.$disconnect();
});

test('полный сценарий мастер → клиент → владелец', async t => {
    let tokenA, tokenB, serviceIds = [], masterA;

    await t.test('без токена — 401', async () => {
        assert.strictEqual((await call('GET', '/api/master/profile')).status, 401);
    });

    await t.test('регистрация мастера', async () => {
        const tg = await login(1001, 'Анна');
        assert.strictEqual((await call('GET', '/api/master/profile', { token: tg })).status, 403);
        const bad = await call('POST', '/api/master/register', { token: tg, body: { name: '' } });
        assert.strictEqual(bad.status, 400);
        const res = await call('POST', '/api/master/register', {
            token: tg, body: { name: 'Анна Иванова', specialty: 'Маникюр', phone: '+79370000000', email: 'anna@example.com' }
        });
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        assert.ok(res.body.registered);
        assert.strictEqual(res.body.profile.botToken, undefined, 'токен бота не отдаётся');
        tokenA = res.body.token;
        assert.strictEqual((await call('POST', '/api/master/register', { token: tokenA, body: { name: 'X' } })).status, 409);
    });

    await t.test('услуги: лимит Free = 5', async () => {
        for (let i = 1; i <= 5; i++) {
            const res = await call('POST', '/api/master/services', {
                token: tokenA, body: { name: `Услуга ${i}`, price: 1000 * i, duration: 60, emoji: '💅' }
            });
            assert.strictEqual(res.status, 201, JSON.stringify(res.body));
            serviceIds.push(res.body.id);
        }
        const sixth = await call('POST', '/api/master/services', { token: tokenA, body: { name: 'Шестая', price: 1 } });
        assert.strictEqual(sixth.status, 403);
        assert.match(sixth.body.error, /Pro/);
        // Неактивную можно добавить сверх лимита
        const hidden = await call('POST', '/api/master/services', { token: tokenA, body: { name: 'Скрытая', price: 1, isActive: false } });
        assert.strictEqual(hidden.status, 201);
        assert.strictEqual((await call('PUT', `/api/master/services/${hidden.body.id}`, { token: tokenA, body: { isActive: true } })).status, 403);
    });

    await t.test('Pro-функции закрыты на Free', async () => {
        assert.strictEqual((await call('PUT', '/api/master/header', { token: tokenA, body: { headerName: 'Студия' } })).status, 403);
        assert.strictEqual((await call('GET', '/api/master/clients', { token: tokenA })).status, 403);
        assert.strictEqual((await call('POST', '/api/master/broadcast', { token: tokenA, body: { text: 'hi' } })).status, 403);
    });

    await t.test('изоляция: другой мастер не видит и не меняет чужое', async () => {
        const tg = await login(2002, 'Мария');
        const res = await call('POST', '/api/master/register', { token: tg, body: { name: 'Мария' } });
        tokenB = res.body.token;
        assert.strictEqual((await call('PUT', `/api/master/services/${serviceIds[0]}`, { token: tokenB, body: { price: 1 } })).status, 404);
        assert.strictEqual((await call('DELETE', `/api/master/services/${serviceIds[0]}`, { token: tokenB })).status, 404);
        assert.strictEqual((await call('GET', '/api/master/services', { token: tokenB })).body.length, 0);
    });

    await t.test('FAQ: лимит и CRUD', async () => {
        const res = await call('POST', '/api/master/faq', { token: tokenA, body: { question: 'цена, стоимость', answer: 'От 1000 ₽' } });
        assert.strictEqual(res.status, 201);
        assert.strictEqual((await call('GET', '/api/master/faq', { token: tokenA })).body.length, 1);
    });

    await t.test('бот: неверный формат токена отклоняется', async () => {
        assert.strictEqual((await call('POST', '/api/master/bot', { token: tokenA, body: { token: 'abc' } })).status, 400);
    });

    // Подключаем «бота» напрямую в БД (без обращения к Telegram)
    masterA = await prisma.master.findUnique({ where: { telegramId: 1001n } });
    await prisma.master.update({
        where: { id: masterA.id },
        data: { botToken: encrypt(BOT_TOKEN, config.encryptionKey), botUsername: 'anna_test_bot', botId: 777000n }
    });

    await t.test('каталог: публичные данные по username бота', async () => {
        const res = await call('GET', '/api/catalog/anna_test_bot');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.master.name, 'Анна Иванова');
        assert.strictEqual(res.body.services.length, 5);
        assert.strictEqual(res.body.master.botToken, undefined);
        assert.strictEqual(res.body.master.phone, '+79370000000');
        assert.strictEqual((await call('GET', '/api/catalog/nobody_bot')).status, 404);
    });

    let bookingId;
    await t.test('запись: подпись initData проверяется токеном бота мастера', async () => {
        const user = JSON.stringify({ id: 5005, first_name: 'Клиентка', username: 'client5005' });
        const initData = signInitData({ user, auth_date: String(Math.floor(Date.now() / 1000)) }, BOT_TOKEN);
        const forged = signInitData({ user, auth_date: String(Math.floor(Date.now() / 1000)) }, '1:wrong');

        assert.strictEqual((await call('POST', '/api/booking', {
            body: { botUsername: 'anna_test_bot', serviceId: serviceIds[0], initData: forged }
        })).status, 401);

        const res = await call('POST', '/api/booking', {
            body: { botUsername: 'anna_test_bot', serviceId: serviceIds[1], initData, comment: 'После 18:00' }
        });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        bookingId = res.body.bookingId;

        const client = await prisma.client.findFirst({ where: { masterId: masterA.id, telegramId: 5005n } });
        assert.strictEqual(client.bookingsCount, 1);
    });

    await t.test('заявки: подтверждение требует дату, затем завершение', async () => {
        const list = await call('GET', '/api/master/bookings?status=new', { token: tokenA });
        assert.strictEqual(list.body.length, 1);
        assert.strictEqual(list.body[0].serviceName, 'Услуга 2');
        assert.strictEqual((await call('PUT', `/api/master/bookings/${bookingId}`, { token: tokenA, body: { status: 'confirmed' } })).status, 400);
        const when = new Date(Date.now() + 26 * 3600 * 1000).toISOString();
        const ok = await call('PUT', `/api/master/bookings/${bookingId}`, { token: tokenA, body: { status: 'confirmed', appointmentAt: when } });
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(ok.body.status, 'confirmed');
        // чужой мастер не может трогать заявку
        assert.strictEqual((await call('PUT', `/api/master/bookings/${bookingId}`, { token: tokenB, body: { status: 'cancelled' } })).status, 404);
        const done = await call('PUT', `/api/master/bookings/${bookingId}`, { token: tokenA, body: { status: 'completed' } });
        assert.ok(done.body.completedAt);
    });

    await t.test('статистика мастера', async () => {
        const res = await call('GET', '/api/master/stats', { token: tokenA });
        assert.strictEqual(res.body.bookingsTotal, 1);
        assert.strictEqual(res.body.clientsTotal, 1);
        assert.ok(res.body.views >= 1);
    });

    await t.test('админ-API закрыт для мастера, открыт для владельца', async () => {
        assert.strictEqual((await call('GET', '/api/admin/masters', { token: tokenA })).status, 403);
        const admin = await login(ADMIN_ID, 'Владелец');
        const masters = await call('GET', '/api/admin/masters', { token: admin });
        assert.strictEqual(masters.status, 200);
        assert.strictEqual(masters.body.length, 2);
        assert.ok(masters.body.every(m => m.botToken === undefined));

        const act = await call('PUT', `/api/admin/masters/${masterA.id}/plan`, { token: admin, body: { plan: 'pro', days: 30 } });
        assert.strictEqual(act.status, 200, JSON.stringify(act.body));
        assert.strictEqual(act.body.plan, 'pro');

        const stats = await call('GET', '/api/admin/stats', { token: admin });
        assert.strictEqual(stats.body.pro, 1);
        assert.strictEqual(stats.body.revenue.total, config.proPrice);
    });

    await t.test('после Pro: шестая услуга, заголовок, тема, клиенты', async () => {
        assert.strictEqual((await call('POST', '/api/master/services', { token: tokenA, body: { name: 'Шестая', price: 600 } })).status, 201);
        assert.strictEqual((await call('PUT', '/api/master/header', { token: tokenA, body: { headerName: 'Студия Анны' } })).status, 200);
        assert.strictEqual((await call('PUT', '/api/master/theme', { token: tokenA, body: { theme: { accent: '#ff6699' } } })).status, 200);
        assert.strictEqual((await call('PUT', '/api/master/theme', { token: tokenA, body: { theme: { accent: 'red' } } })).status, 400);
        const clients = await call('GET', '/api/master/clients', { token: tokenA });
        assert.strictEqual(clients.body.length, 1);
        const catalog = await call('GET', '/api/catalog/anna_test_bot');
        assert.strictEqual(catalog.body.master.headerName, 'Студия Анны');
        assert.strictEqual(catalog.body.services.length, 6, '5 + шестая; «Скрытая» неактивна');
    });

    await t.test('напоминание и запрос отзыва помечаются один раз', async () => {
        const reminder = require('../src/services/reminder');
        await prisma.booking.update({
            where: { id: bookingId },
            data: { status: 'confirmed', appointmentAt: new Date(Date.now() + 3600 * 1000), reminder2hSent: false, reminder24hSent: false }
        });
        await reminder.sendReminders();
        let b = await prisma.booking.findUnique({ where: { id: bookingId } });
        assert.ok(b.reminder2hSent && b.reminder24hSent);

        await prisma.booking.update({ where: { id: bookingId }, data: { status: 'completed', completedAt: new Date(Date.now() - 3 * 3600 * 1000) } });
        await reminder.requestReviews();
        b = await prisma.booking.findUnique({ where: { id: bookingId } });
        assert.ok(b.reviewRequested);
    });

    await t.test('просроченный Pro понижается до Free, данные сохраняются', async () => {
        const { checkSubscriptions } = require('../src/services/payment');
        await prisma.master.update({ where: { id: masterA.id }, data: { planExpiresAt: new Date(Date.now() - 1000) } });
        await checkSubscriptions();
        const m = await prisma.master.findUnique({ where: { id: masterA.id } });
        assert.strictEqual(m.plan, 'free');
        assert.strictEqual(m.headerName, 'Студия Анны', 'данные не удалены');
        const catalog = await call('GET', '/api/catalog/anna_test_bot');
        assert.strictEqual(catalog.body.services.length, 5, 'сверх лимита скрыто');
        assert.strictEqual(catalog.body.master.headerName, 'Анна Иванова', 'Pro-оформление скрыто');
    });

    await t.test('лимит MAX_MASTERS', async () => {
        const saved = config.maxMasters;
        config.maxMasters = 2;
        const tg = await login(3003, 'Третья');
        const res = await call('POST', '/api/master/register', { token: tg, body: { name: 'Третья' } });
        config.maxMasters = saved;
        assert.strictEqual(res.status, 503);
    });
});
