/*
 * Платежи (раздел 3.3 плана):
 *  POST /api/payment/create  — ссылка на оплату ЮKassa
 *  POST /api/payment/webhook — уведомление ЮKassa (статус перепроверяется через API)
 *  POST /api/payment/manual  — заявка на ручную оплату (перевод на карту)
 * Stripe — на следующем этапе, когда появятся зарубежные мастера.
 */

const config = require('../config');
const prisma = require('../utils/db');
const { requireMaster, httpError } = require('../middleware/auth');
const payment = require('../services/payment');
const { notifyAdmin } = require('../services/admin-bot');
const { notifyMaster } = require('../services/notify');

module.exports = async function paymentRoutes(app) {
    app.post('/api/payment/create', {
        preHandler: requireMaster,
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } }
    }, async request => {
        if (!payment.yukassaEnabled()) throw httpError(503, 'Онлайн-оплата пока не подключена — используйте оплату переводом');
        return { url: await payment.createYukassaPayment(request.master) };
    });

    app.post('/api/payment/webhook', async request => {
        try {
            const result = await payment.handleYukassaWebhook(request.body);
            if (result?.activated) {
                const until = result.master.planExpiresAt.toLocaleDateString('ru-RU', { timeZone: config.timezone });
                const month = await payment.revenue(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
                notifyAdmin(`💰 Оплата ${result.amount} руб от ${result.master.name} (ЮKassa). Выручка за месяц: ${month} руб`);
                notifyMaster(result.master, `🎉 Оплата прошла! Тариф Pro активен до ${until}.`);
            }
        } catch (err) {
            request.log.error(err, 'yukassa webhook');
        }
        return { ok: true }; // ЮKassa ждёт 200, иначе будет повторять
    });

    app.post('/api/payment/manual', {
        preHandler: requireMaster,
        config: { rateLimit: { max: 3, timeWindow: '1 hour' } }
    }, async request => {
        const m = request.master;
        const pending = await prisma.payment.findFirst({ where: { masterId: m.id, method: 'manual', status: 'pending' } });
        if (!pending) {
            await prisma.payment.create({ data: { masterId: m.id, amount: config.proPrice, method: 'manual', status: 'pending' } });
        }
        notifyAdmin(`💳 ${m.name} сообщает об оплате переводом (${config.proPrice} руб). ` +
            `Проверьте поступление и активируйте: /activate ${m.name}`);
        return { ok: true, details: config.manualPaymentDetails };
    });
};
