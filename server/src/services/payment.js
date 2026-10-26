/*
 * Подписка Pro: активация, продление, ЮKassa, ручная оплата, понижение до Free.
 * При окончании подписки данные не удаляются: услуги сверх лимита и Pro-оформление
 * просто не отдаются в каталог (см. routes/catalog.js), пока подписку не продлят.
 */

const crypto = require('crypto');
const config = require('../config');
const prisma = require('../utils/db');

const PERIOD_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const YUKASSA_API = 'https://api.yookassa.ru/v3';

/**
 * Продлить Pro на days дней от max(сейчас, текущая дата окончания).
 * paymentId — существующий pending-платёж: он помечается paid в той же транзакции.
 * Если платёж уже обработан (повторный вебхук), возвращает null и ничего не продлевает.
 */
async function activatePro(masterId, { days = PERIOD_DAYS, method = 'manual', amount = config.proPrice, paymentId = null } = {}) {
    return prisma.$transaction(async tx => {
        const master = await tx.master.findUniqueOrThrow({ where: { id: masterId } });
        const now = new Date();
        const start = master.plan === 'pro' && master.planExpiresAt > now ? master.planExpiresAt : now;
        const end = new Date(start.getTime() + days * DAY);
        const paymentData = { status: 'paid', paidAt: now, periodStart: start, periodEnd: end, amount };

        if (paymentId) {
            const claimed = await tx.payment.updateMany({ where: { id: paymentId, status: 'pending' }, data: paymentData });
            if (!claimed.count) return null;
        } else {
            await tx.payment.create({ data: { masterId, method, ...paymentData } });
        }
        const updated = await tx.master.update({
            where: { id: masterId },
            data: { plan: 'pro', planExpiresAt: end }
        });
        return { master: updated };
    });
}

async function revenue(from) {
    const agg = await prisma.payment.aggregate({
        where: { status: 'paid', ...(from ? { paidAt: { gte: from } } : {}) },
        _sum: { amount: true }
    });
    return agg._sum.amount || 0;
}

// ---------- ЮKassa ----------

function yukassaEnabled() {
    return Boolean(config.yukassaShopId && config.yukassaSecretKey);
}

async function yukassaRequest(method, path, body) {
    const auth = Buffer.from(`${config.yukassaShopId}:${config.yukassaSecretKey}`).toString('base64');
    const res = await fetch(`${YUKASSA_API}${path}`, {
        method,
        headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/json',
            ...(method === 'POST' ? { 'Idempotence-Key': crypto.randomUUID() } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`ЮKassa: ${data.description || res.status}`);
    return data;
}

/** Создать платёж, вернуть URL страницы оплаты */
async function createYukassaPayment(master) {
    const payment = await prisma.payment.create({
        data: { masterId: master.id, amount: config.proPrice, method: 'yukassa', status: 'pending' }
    });
    const yk = await yukassaRequest('POST', '/payments', {
        amount: { value: config.proPrice.toFixed(2), currency: 'RUB' },
        capture: true,
        confirmation: { type: 'redirect', return_url: `${config.appUrl}/admin/?payment=done` },
        description: `Подписка Pro на ${PERIOD_DAYS} дней — ${master.name}`.slice(0, 128),
        metadata: { payment_id: payment.id, master_id: master.id }
    });
    await prisma.payment.update({ where: { id: payment.id }, data: { externalId: yk.id } });
    return yk.confirmation.confirmation_url;
}

/**
 * Вебхук ЮKassa. ЮKassa не подписывает уведомления, поэтому не доверяем телу:
 * перезапрашиваем платёж по id через API и проверяем статус там.
 * Возвращает { activated, master } или null.
 */
async function handleYukassaWebhook(body) {
    const externalId = body?.object?.id;
    if (!externalId || !yukassaEnabled()) return null;

    const payment = await prisma.payment.findUnique({ where: { externalId } });
    if (!payment || payment.status !== 'pending') return null;

    const yk = await yukassaRequest('GET', `/payments/${encodeURIComponent(externalId)}`);
    if (yk.status === 'succeeded' && yk.paid) {
        // Повторный вебхук не продлит дважды: activatePro атомарно переводит pending -> paid.
        // Если транзакция упадёт, платёж останется pending и ЮKassa пришлёт вебхук снова.
        const amount = Math.round(Number(yk.amount.value));
        const result = await activatePro(payment.masterId, { amount, paymentId: payment.id });
        return result && { activated: true, master: result.master, amount };
    }
    if (yk.status === 'canceled') {
        await prisma.payment.update({ where: { id: payment.id }, data: { status: 'failed' } });
    }
    return null;
}

// ---------- Cron: истекающие и просроченные подписки ----------

async function checkSubscriptions() {
    const { notifyAdmin } = require('./admin-bot');
    const { notifyMaster } = require('./notify');
    const now = new Date();

    const expired = await prisma.master.findMany({ where: { plan: 'pro', planExpiresAt: { lt: now } } });
    for (const m of expired) {
        await prisma.master.update({ where: { id: m.id }, data: { plan: 'free' } });
        notifyAdmin(`⏰ Pro просрочен у ${m.name}. Переведён на Free`);
        notifyMaster(m, 'Подписка Pro закончилась — аккаунт переведён на Free. Ваши данные сохранены: продлите Pro в панели мастера, и всё вернётся.');
    }

    const in3days = new Date(now.getTime() + 3 * DAY);
    const expiring = await prisma.master.findMany({
        where: { plan: 'pro', planExpiresAt: { gte: new Date(in3days.getTime() - DAY), lt: in3days } },
        include: { _count: { select: { clients: true } } }
    });
    for (const m of expiring) {
        notifyAdmin(`⌛ Через 3 дня истекает Pro у ${m.name}. Клиентов: ${m._count.clients}`);
        notifyMaster(m, 'Через 3 дня закончится подписка Pro. Продлить можно в панели мастера → «Тариф».');
    }
}

module.exports = {
    activatePro, revenue, yukassaEnabled, createYukassaPayment, handleYukassaWebhook, checkSubscriptions, PERIOD_DAYS
};
