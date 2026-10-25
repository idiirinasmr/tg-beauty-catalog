/* Проверка тарифа (раздел 5 плана): Free-лимиты и Pro-функции */

const config = require('../config');
const prisma = require('../utils/db');

function isPro(master) {
    return master.plan === 'pro' && master.planExpiresAt && master.planExpiresAt > new Date();
}

class PlanError extends Error {
    constructor(message) {
        super(message);
        this.statusCode = 403;
        this.code = 'PLAN_LIMIT';
    }
}

/** preHandler: доступ только для Pro */
async function requirePro(request) {
    if (!isPro(request.master)) {
        throw new PlanError('Эта функция доступна на тарифе Pro');
    }
}

const counters = {
    services: masterId => prisma.service.count({ where: { masterId, isActive: true } }),
    portfolio: masterId => prisma.portfolio.count({ where: { masterId } }),
    faq: masterId => prisma.faq.count({ where: { masterId } })
};

const limitMessages = {
    services: n => `На тарифе Free можно до ${n} активных услуг. Перейдите на Pro для добавления`,
    portfolio: n => `На тарифе Free можно до ${n} фото в портфолио. Перейдите на Pro для добавления`,
    faq: n => `На тарифе Free можно до ${n} вопросов FAQ. Перейдите на Pro для добавления`
};

/** Бросает 403, если Free-мастер упёрся в лимит по kind ('services' | 'portfolio' | 'faq') */
async function assertWithinLimit(master, kind) {
    if (isPro(master)) return;
    const limit = config.freeLimits[kind];
    if (await counters[kind](master.id) >= limit) {
        throw new PlanError(limitMessages[kind](limit));
    }
}

module.exports = { isPro, requirePro, assertWithinLimit, PlanError };
