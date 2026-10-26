/*
 * Настройка под ключ: владелец заводит мастера, заполняет его каталог в режиме
 * настройки, мастер привязывает Telegram по одноразовой ссылке, владелец отмечает оплату.
 * Работает на локальной БД (scripts/dev-db.js), за собой убирает.
 */

const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const prisma = require('../src/utils/db');
const { buildApp } = require('../src/index');
const { claimMaster } = require('../src/services/bot-handlers');

if (!/127\.0\.0\.1:54329|localhost:54329/.test(process.env.DATABASE_URL)) {
    throw new Error('turnkey.test.js запускается только на локальной БД');
}

const ADMIN_ID = config.adminIds[0];
const MASTER_TG = 7700770077n;
let app;

async function call(method, url, { token, body } = {}) {
    const res = await app.inject({
        method, url, payload: body,
        headers: token ? { authorization: `Bearer ${token}` } : {}
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

async function login(id) {
    return (await call('POST', '/api/auth/dev', { body: { id: String(id) } })).body.token;
}

async function cleanup() {
    await prisma.master.deleteMany({ where: { OR: [{ name: { startsWith: 'Под ключ' } }, { telegramId: { in: [MASTER_TG, 7700770078n] } }] } });
}

test.before(async () => {
    app = buildApp();
    await app.ready();
    await cleanup();
});

test.after(async () => {
    await cleanup();
    await app.close();
    await prisma.$disconnect();
});

test('настройка под ключ: мастер ничего не делает, только нажимает ссылку', async t => {
    const admin = await login(ADMIN_ID);
    let masterId, impersonate;

    await t.test('владелец заводит мастера без его регистрации', async () => {
        const res = await call('POST', '/api/admin/masters', {
            token: admin, body: { name: 'Под ключ Ольга', specialty: 'Брови', price: 3000 }
        });
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        masterId = res.body.id;

        const m = await prisma.master.findUnique({ where: { id: masterId } });
        assert.strictEqual(m.telegramId, null);
        assert.ok(m.claimCode && m.claimCode.length >= 20);

        const payment = await prisma.payment.findFirst({ where: { masterId } });
        assert.strictEqual(payment.method, 'turnkey');
        assert.strictEqual(payment.status, 'pending');
        assert.strictEqual(payment.amount, 3000);
    });

    await t.test('лишние поля и чужие права отклоняются', async () => {
        const forged = await call('POST', '/api/admin/masters', { token: admin, body: { name: 'Под ключ X', plan: 'pro' } });
        assert.strictEqual(forged.status, 201);
        assert.strictEqual((await prisma.master.findUnique({ where: { id: forged.body.id } })).plan, 'free');

        const stranger = await login(7700770078);
        assert.strictEqual((await call('POST', '/api/admin/masters', { token: stranger, body: { name: 'Под ключ Y' } })).status, 403);
        assert.strictEqual((await call('POST', `/api/admin/masters/${masterId}/impersonate`, { token: stranger })).status, 403);
    });

    await t.test('режим настройки: владелец заполняет каталог за мастера', async () => {
        const res = await call('POST', `/api/admin/masters/${masterId}/impersonate`, { token: admin });
        assert.strictEqual(res.status, 200);
        impersonate = res.body.token;

        const profile = await call('GET', '/api/master/profile', { token: impersonate });
        assert.strictEqual(profile.status, 200);
        assert.strictEqual(profile.body.name, 'Под ключ Ольга');
        assert.strictEqual(profile.body.claimCode, undefined, 'код привязки не отдаётся');

        const svc = await call('POST', '/api/master/services', { token: impersonate, body: { name: 'Ламинирование', price: 1800 } });
        assert.strictEqual(svc.status, 201);
    });

    await t.test('токен режима настройки не даёт прав админа и не регистрирует', async () => {
        assert.strictEqual((await call('GET', '/api/admin/stats', { token: impersonate })).status, 403);
        assert.strictEqual((await call('POST', '/api/master/register', { token: impersonate, body: { name: 'X' } })).status, 403);
    });

    await t.test('ссылка для мастера появляется после подключения бота', async () => {
        let row = (await call('GET', '/api/admin/masters', { token: admin })).body.find(m => m.id === masterId);
        assert.strictEqual(row.awaitingClaim, true);
        assert.strictEqual(row.claimLink, null, 'бота ещё нет');
        assert.strictEqual(row.claimCode, undefined);

        await prisma.master.update({ where: { id: masterId }, data: { botUsername: 'olga_turnkey_bot' } });
        row = (await call('GET', '/api/admin/masters', { token: admin })).body.find(m => m.id === masterId);
        assert.match(row.claimLink, /^https:\/\/t\.me\/olga_turnkey_bot\?start=claim_[A-Za-z0-9_-]+$/);
    });

    await t.test('мастер нажимает ссылку — Telegram привязан, код сгорает', async () => {
        const m = await prisma.master.findUnique({ where: { id: masterId } });
        const replies = [];
        const ctx = (code, id) => ({
            master: m, match: 'claim_' + code, from: { id }, me: { username: 'olga_turnkey_bot' },
            reply: text => replies.push(text)
        });

        // Неверный код ничего не делает
        const wrong = ctx('nope', Number(MASTER_TG));
        await claimMaster(wrong);
        assert.ok(!wrong.isMaster);

        const right = ctx(m.claimCode, Number(MASTER_TG));
        await claimMaster(right);
        assert.ok(right.isMaster);
        const claimed = await prisma.master.findUnique({ where: { id: masterId } });
        assert.strictEqual(claimed.telegramId, MASTER_TG);
        assert.strictEqual(claimed.claimCode, null);

        // Повтор той же ссылки другим человеком — ничего не меняет
        const again = { ...ctx(m.claimCode, 7700770078), master: claimed };
        await claimMaster(again);
        assert.strictEqual((await prisma.master.findUnique({ where: { id: masterId } })).telegramId, MASTER_TG);

        // Теперь мастер может войти сам
        const own = await login(MASTER_TG);
        assert.strictEqual((await call('GET', '/api/master/profile', { token: own })).status, 200);
    });

    await t.test('владелец отмечает оплату — она попадает в выручку', async () => {
        const payment = await prisma.payment.findFirst({ where: { masterId, method: 'turnkey' } });
        const before = (await call('GET', '/api/admin/stats', { token: admin })).body.revenue.total;
        assert.strictEqual((await call('POST', `/api/admin/payments/${payment.id}/paid`, { token: admin })).status, 200);
        assert.strictEqual((await call('POST', `/api/admin/payments/${payment.id}/paid`, { token: admin })).status, 404, 'повторно нельзя');
        const after = (await call('GET', '/api/admin/stats', { token: admin })).body.revenue.total;
        assert.strictEqual(after - before, 3000);
    });
});

test('договорная цена: сумма указывается при отметке оплаты', async () => {
    const admin = await login(ADMIN_ID);
    const created = await call('POST', '/api/admin/masters', { token: admin, body: { name: 'Под ключ Договорная', price: 0 } });
    const payment = await prisma.payment.findFirst({ where: { masterId: created.body.id } });
    assert.strictEqual(payment.amount, 0);
    assert.strictEqual((await call('POST', `/api/admin/payments/${payment.id}/paid`, { token: admin, body: { amount: -5 } })).status, 400);
    assert.strictEqual((await call('POST', `/api/admin/payments/${payment.id}/paid`, { token: admin, body: { amount: 4500 } })).status, 200);
    const paid = await prisma.payment.findUnique({ where: { id: payment.id } });
    assert.strictEqual(paid.status, 'paid');
    assert.strictEqual(paid.amount, 4500);
});
