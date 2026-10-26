/* Статистика платформы — общая для бота владельца и API админ-панели */

const prisma = require('../utils/db');
const { revenue } = require('./payment');
const config = require('../config');

const DAY = 24 * 60 * 60 * 1000;

function startOfToday() {
    // Полночь по Москве (UTC+3, без перехода на летнее время)
    const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
    msk.setUTCHours(0, 0, 0, 0);
    return new Date(msk.getTime() - 3 * 60 * 60 * 1000);
}

async function overview() {
    const now = new Date();
    const today = startOfToday();
    const monthAgo = new Date(now.getTime() - 30 * DAY);
    const weekAgo = new Date(now.getTime() - 7 * DAY);

    const [masters, pro, clients, clientsToday, mastersToday, bookingsToday, bookingsTotal,
        revToday, revWeek, revMonth, revTotal, paymentsToday, expiring] = await Promise.all([
        prisma.master.count(),
        prisma.master.count({ where: { plan: 'pro', planExpiresAt: { gt: now } } }),
        prisma.client.count(),
        prisma.client.count({ where: { firstVisitAt: { gte: today } } }),
        prisma.master.count({ where: { createdAt: { gte: today } } }),
        prisma.booking.count({ where: { createdAt: { gte: today } } }),
        prisma.booking.count(),
        revenue(today), revenue(weekAgo), revenue(monthAgo), revenue(),
        prisma.payment.count({ where: { status: 'paid', paidAt: { gte: today } } }),
        prisma.master.findMany({
            where: { plan: 'pro', planExpiresAt: { gt: now, lt: new Date(now.getTime() + 7 * DAY) } },
            select: { id: true, name: true, planExpiresAt: true },
            orderBy: { planExpiresAt: 'asc' }
        })
    ]);

    return {
        masters, pro, free: masters - pro, maxMasters: config.maxMasters,
        clients, clientsToday, mastersToday, bookingsToday, bookingsTotal, paymentsToday,
        revenue: { today: revToday, week: revWeek, month: revMonth, total: revTotal },
        expiring
    };
}

module.exports = { overview, startOfToday };
