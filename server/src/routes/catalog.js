/*
 * Публичное API для Mini App клиента:
 *  GET /api/catalog/:botUsername — профиль мастера + услуги + портфолио + отзывы
 *  GET /api/faq/:botUsername     — FAQ мастера
 * Free: в каталог попадают первые 5 услуг и 6 фото, Pro-оформление скрыто.
 */

const config = require('../config');
const prisma = require('../utils/db');
const { isPro } = require('../middleware/plan-check');
const { httpError } = require('../middleware/auth');
const { track } = require('../utils/background');

const params = {
    type: 'object', required: ['botUsername'],
    properties: { botUsername: { type: 'string', pattern: '^[A-Za-z0-9_]{5,64}$' } }
};

async function findMasterByBot(botUsername) {
    const master = await prisma.master.findFirst({
        where: { botUsername: { equals: botUsername, mode: 'insensitive' } }
    });
    if (!master) throw httpError(404, 'Мастер не найден');
    return master;
}

module.exports = async function catalogRoutes(app) {
    app.get('/api/catalog/:botUsername', { schema: { params } }, async request => {
        const master = await findMasterByBot(request.params.botUsername);
        const pro = isPro(master);

        const [services, portfolio, reviews, rating] = await Promise.all([
            prisma.service.findMany({
                where: { masterId: master.id, isActive: true },
                orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
                take: pro ? undefined : config.freeLimits.services
            }),
            prisma.portfolio.findMany({
                where: { masterId: master.id },
                orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
                take: pro ? undefined : config.freeLimits.portfolio
            }),
            prisma.review.findMany({
                where: { masterId: master.id, isVisible: true },
                orderBy: { createdAt: 'desc' },
                take: 20
            }),
            prisma.review.aggregate({
                where: { masterId: master.id, isVisible: true },
                _avg: { rating: true },
                _count: true
            })
        ]);

        // Счётчик открытий каталога — для конверсии в статистике
        track(prisma.master.update({ where: { id: master.id }, data: { statsViews: { increment: 1 } } }));

        return {
            master: {
                name: master.name,
                headerName: pro && master.headerName ? master.headerName : master.name,
                specialty: master.specialty,
                about: master.about,
                phone: master.phone,
                address: master.address,
                avatarUrl: master.avatarUrl,
                logoUrl: pro ? master.logoUrl : null,
                theme: pro ? master.theme : null,
                whiteLabel: pro && master.whiteLabel,
                botUsername: master.botUsername,
                rating: rating._avg.rating ? Math.round(rating._avg.rating * 10) / 10 : null,
                reviewsCount: rating._count
            },
            services: services.map(s => ({
                id: s.id, name: s.name, description: s.description, price: s.price,
                duration: s.duration, emoji: s.emoji, imageUrl: s.imageUrl
            })),
            portfolio: portfolio.map(p => ({ id: p.id, imageUrl: p.imageUrl })),
            reviews: reviews.map(r => ({
                id: r.id, clientName: r.clientName, rating: r.rating, text: r.text, createdAt: r.createdAt
            }))
        };
    });

    app.get('/api/faq/:botUsername', { schema: { params } }, async request => {
        const master = await findMasterByBot(request.params.botUsername);
        const faq = await prisma.faq.findMany({ where: { masterId: master.id }, orderBy: { sortOrder: 'asc' } });
        return faq.map(f => ({ id: f.id, question: f.question, answer: f.answer }));
    });
};

module.exports.findMasterByBot = findMasterByBot;
