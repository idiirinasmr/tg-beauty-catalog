/*
 * API мастера (раздел 3.2 плана). Все запросы, кроме register, требуют JWT мастера.
 * Изоляция: каждая выборка фильтруется по request.master.id.
 */

const { Prisma } = require('@prisma/client');
const config = require('../config');
const prisma = require('../utils/db');
const { encrypt } = require('../utils/encrypt');
const { readImage, saveImage, deleteImage } = require('../utils/upload');
const { requireTelegramUser, requireMaster, httpError } = require('../middleware/auth');
const { isPro, requirePro, assertWithinLimit } = require('../middleware/plan-check');
const botManager = require('../services/bot-manager');
const { notifyAdmin } = require('../services/admin-bot');
const { sendFromMasterBot, escapeHtml } = require('../services/notify');
const { formatDate } = require('../services/bot-handlers');
const broadcast = require('../services/broadcast');
const { yukassaEnabled, PERIOD_DAYS } = require('../services/payment');
const { issueToken } = require('./auth');

const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };
const str = max => ({ type: 'string', maxLength: max });

const profileProps = {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    specialty: str(150), phone: str(30), email: { type: 'string', maxLength: 120, pattern: '^$|^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
    address: str(200), about: str(1000)
};

const serviceProps = {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    description: str(1000),
    price: { type: 'integer', minimum: 0, maximum: 1000000 },
    duration: { type: 'integer', minimum: 5, maximum: 1440 },
    emoji: str(16),
    sortOrder: { type: 'integer' },
    isActive: { type: 'boolean' }
};

const faqProps = {
    question: { type: 'string', minLength: 1, maxLength: 300 },
    answer: { type: 'string', minLength: 1, maxLength: 2000 },
    sortOrder: { type: 'integer' }
};

/** Профиль для панели (без токена бота) */
function profileView(m) {
    const { botToken, claimCode, ...rest } = m;
    return {
        ...rest,
        isPro: Boolean(isPro(m)),
        botConnected: Boolean(botToken),
        botRunning: botManager.isRunning(m.id),
        miniAppUrl: m.botUsername ? botManager.miniAppUrl(m.botUsername) : null
    };
}

async function findOwned(model, id, masterId) {
    const item = await prisma[model].findFirst({ where: { id, masterId } });
    if (!item) throw httpError(404, 'Не найдено');
    return item;
}

module.exports = async function masterRoutes(app) {
    // ---------- Регистрация ----------

    app.post('/api/master/register', {
        preHandler: requireTelegramUser,
        schema: { body: { type: 'object', required: ['name'], properties: profileProps, additionalProperties: false } }
    }, async (request, reply) => {
        if (request.user.src === 'impersonate') throw httpError(403, 'В режиме настройки регистрация недоступна');
        const telegramId = BigInt(request.user.tg);
        if (await prisma.master.findUnique({ where: { telegramId } })) {
            throw httpError(409, 'Вы уже зарегистрированы');
        }
        const total = await prisma.master.count();
        if (total >= config.maxMasters) {
            notifyAdmin(`🚧 Лимит ${config.maxMasters} мастеров достигнут — регистрация отклонена (${request.body.name})`);
            throw httpError(503, 'Все места на платформе сейчас заняты. Оставьте заявку — мы напишем, когда появится место');
        }
        const master = await prisma.master.create({ data: { ...request.body, telegramId } });
        notifyAdmin(`👋 Новый мастер: ${master.name}${master.specialty ? ` (${master.specialty})` : ''}. Всего мастеров: ${total + 1}/${config.maxMasters}`);
        reply.code(201);
        return { ...(await issueToken(app, { id: request.user.tg })), profile: profileView(master) };
    });

    // Все маршруты ниже — только для зарегистрированного мастера
    app.register(async scoped => {
        scoped.addHook('preHandler', requireMaster);

        // ---------- Профиль ----------

        scoped.get('/api/master/profile', async request => profileView(request.master));

        scoped.put('/api/master/profile', {
            schema: { body: { type: 'object', properties: profileProps, additionalProperties: false } }
        }, async request => profileView(await prisma.master.update({
            where: { id: request.master.id }, data: request.body
        })));

        scoped.post('/api/master/avatar', async request => {
            const url = await saveImage(await readImage(request), `${request.master.id}/avatar`);
            await deleteImage(request.master.avatarUrl);
            return profileView(await prisma.master.update({ where: { id: request.master.id }, data: { avatarUrl: url } }));
        });

        // ---------- Pro-оформление ----------

        scoped.post('/api/master/logo', { preHandler: requirePro }, async request => {
            const url = await saveImage(await readImage(request), `${request.master.id}/logo`);
            await deleteImage(request.master.logoUrl);
            return profileView(await prisma.master.update({ where: { id: request.master.id }, data: { logoUrl: url } }));
        });

        const color = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
        scoped.put('/api/master/theme', {
            preHandler: requirePro,
            schema: {
                body: {
                    type: 'object',
                    properties: {
                        theme: { anyOf: [{ type: 'null' }, { type: 'object', properties: { accent: color, background: color, text: color }, additionalProperties: false }] },
                        whiteLabel: { type: 'boolean' }
                    }
                }
            }
        }, async request => {
            const data = {};
            if ('theme' in request.body) data.theme = request.body.theme ?? Prisma.DbNull;
            if ('whiteLabel' in request.body) data.whiteLabel = request.body.whiteLabel;
            return profileView(await prisma.master.update({ where: { id: request.master.id }, data }));
        });

        scoped.put('/api/master/header', {
            preHandler: requirePro,
            schema: { body: { type: 'object', required: ['headerName'], properties: { headerName: str(60) } } }
        }, async request => profileView(await prisma.master.update({
            where: { id: request.master.id }, data: { headerName: request.body.headerName.trim() || null }
        })));

        // ---------- Бот мастера ----------

        scoped.post('/api/master/bot', {
            config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
            schema: { body: { type: 'object', required: ['token'], properties: { token: { type: 'string', pattern: '^\\d{5,15}:[A-Za-z0-9_-]{30,50}$' } } } }
        }, async request => {
            const { token } = request.body;
            if (token === config.adminBotToken) throw httpError(400, 'Этот бот уже используется платформой');

            let me;
            try {
                me = await botManager.createBot(token).api.getMe();
            } catch {
                throw httpError(400, 'Telegram не принял токен. Скопируйте его из @BotFather ещё раз');
            }
            const taken = await prisma.master.findFirst({ where: { botId: BigInt(me.id), NOT: { id: request.master.id } } });
            if (taken) throw httpError(409, 'Этот бот уже подключён к другому мастеру');

            await botManager.stop(request.master.id);
            const master = await prisma.master.update({
                where: { id: request.master.id },
                data: { botToken: encrypt(token, config.encryptionKey), botUsername: me.username, botId: BigInt(me.id) }
            });
            try {
                await botManager.startMasterBot(master);
            } catch (err) {
                throw httpError(502, `Бот сохранён, но не запустился: ${err.message}`);
            }
            return profileView(master);
        });

        scoped.delete('/api/master/bot', async request => {
            await botManager.stop(request.master.id);
            return profileView(await prisma.master.update({
                where: { id: request.master.id },
                data: { botToken: null, botUsername: null, botId: null }
            }));
        });

        // ---------- Услуги ----------

        scoped.get('/api/master/services', async request => prisma.service.findMany({
            where: { masterId: request.master.id },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
        }));

        scoped.post('/api/master/services', {
            schema: { body: { type: 'object', required: ['name', 'price'], properties: serviceProps, additionalProperties: false } }
        }, async (request, reply) => {
            if (request.body.isActive !== false) await assertWithinLimit(request.master, 'services');
            reply.code(201);
            return prisma.service.create({ data: { ...request.body, masterId: request.master.id } });
        });

        scoped.put('/api/master/services/:id', {
            schema: { params: idParam, body: { type: 'object', properties: serviceProps, additionalProperties: false } }
        }, async request => {
            const service = await findOwned('service', request.params.id, request.master.id);
            if (request.body.isActive === true && !service.isActive) await assertWithinLimit(request.master, 'services');
            return prisma.service.update({ where: { id: service.id }, data: request.body });
        });

        scoped.delete('/api/master/services/:id', { schema: { params: idParam } }, async request => {
            const service = await findOwned('service', request.params.id, request.master.id);
            await prisma.service.delete({ where: { id: service.id } });
            await deleteImage(service.imageUrl);
            return { ok: true };
        });

        scoped.post('/api/master/services/:id/image', { schema: { params: idParam } }, async request => {
            const service = await findOwned('service', request.params.id, request.master.id);
            const url = await saveImage(await readImage(request), `${request.master.id}/services`);
            await deleteImage(service.imageUrl);
            return prisma.service.update({ where: { id: service.id }, data: { imageUrl: url } });
        });

        // ---------- Портфолио ----------

        scoped.get('/api/master/portfolio', async request => prisma.portfolio.findMany({
            where: { masterId: request.master.id },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
        }));

        scoped.post('/api/master/portfolio', async (request, reply) => {
            await assertWithinLimit(request.master, 'portfolio');
            const url = await saveImage(await readImage(request), `${request.master.id}/portfolio`);
            reply.code(201);
            return prisma.portfolio.create({ data: { masterId: request.master.id, imageUrl: url } });
        });

        scoped.delete('/api/master/portfolio/:id', { schema: { params: idParam } }, async request => {
            const item = await findOwned('portfolio', request.params.id, request.master.id);
            await prisma.portfolio.delete({ where: { id: item.id } });
            await deleteImage(item.imageUrl);
            return { ok: true };
        });

        // ---------- Заявки ----------

        scoped.get('/api/master/bookings', {
            schema: { querystring: { type: 'object', properties: { status: { type: 'string', enum: ['new', 'confirmed', 'completed', 'cancelled'] } } } }
        }, async request => prisma.booking.findMany({
            where: { masterId: request.master.id, ...(request.query.status ? { status: request.query.status } : {}) },
            orderBy: { createdAt: 'desc' },
            take: 200
        }));

        scoped.put('/api/master/bookings/:id', {
            schema: {
                params: idParam,
                body: {
                    type: 'object',
                    properties: {
                        status: { type: 'string', enum: ['new', 'confirmed', 'completed', 'cancelled'] },
                        appointmentAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] }
                    },
                    additionalProperties: false
                }
            }
        }, async request => {
            const booking = await findOwned('booking', request.params.id, request.master.id);
            const { status, appointmentAt } = request.body;
            const data = {};
            const statusChanged = status && status !== booking.status;
            if (statusChanged) data.status = status;
            if (status === 'completed' && statusChanged) data.completedAt = new Date();

            const newTime = appointmentAt ? new Date(appointmentAt) : null;
            const timeChanged = appointmentAt !== undefined &&
                (newTime?.getTime() ?? null) !== (booking.appointmentAt?.getTime() ?? null);
            if (timeChanged) {
                data.appointmentAt = newTime;
                // Время изменилось — напоминания нужно отправить заново
                data.reminder24hSent = false;
                data.reminder2hSent = false;
            }

            const finalStatus = data.status ?? booking.status;
            const finalTime = timeChanged ? newTime : booking.appointmentAt;
            if (finalStatus === 'confirmed' && !finalTime) {
                throw httpError(400, 'Укажите дату и время визита');
            }
            if (!Object.keys(data).length) return booking;
            const updated = await prisma.booking.update({ where: { id: booking.id }, data });

            // Сообщаем клиенту только о реальных изменениях
            const service = `<b>${escapeHtml(updated.serviceName)}</b>`;
            let text = null;
            if (finalStatus === 'confirmed' && (statusChanged || timeChanged)) {
                const addr = request.master.address ? `\n📍 ${escapeHtml(request.master.address)}` : '';
                text = `✅ Запись подтверждена!\n\n${service}\n🗓 ${formatDate(updated.appointmentAt)}${addr}`;
            } else if (status === 'cancelled' && statusChanged) {
                text = `Запись на ${service} отменена. Если хотите выбрать другое время — напишите сюда или откройте каталог: /start`;
            }
            if (text) sendFromMasterBot(request.master.id, updated.clientTelegramId, text, { priority: 'critical' });
            return updated;
        });

        // ---------- Клиенты (Pro) ----------

        scoped.get('/api/master/clients', { preHandler: requirePro }, async request => prisma.client.findMany({
            where: { masterId: request.master.id },
            orderBy: { firstVisitAt: 'desc' }
        }));

        // ---------- Отзывы ----------

        scoped.get('/api/master/reviews', async request => prisma.review.findMany({
            where: { masterId: request.master.id },
            orderBy: { createdAt: 'desc' }
        }));

        scoped.put('/api/master/reviews/:id', {
            schema: { params: idParam, body: { type: 'object', required: ['isVisible'], properties: { isVisible: { type: 'boolean' } } } }
        }, async request => {
            const review = await findOwned('review', request.params.id, request.master.id);
            return prisma.review.update({ where: { id: review.id }, data: { isVisible: request.body.isVisible } });
        });

        // ---------- FAQ ----------

        scoped.get('/api/master/faq', async request => prisma.faq.findMany({
            where: { masterId: request.master.id },
            orderBy: { sortOrder: 'asc' }
        }));

        scoped.post('/api/master/faq', {
            schema: { body: { type: 'object', required: ['question', 'answer'], properties: faqProps, additionalProperties: false } }
        }, async (request, reply) => {
            await assertWithinLimit(request.master, 'faq');
            reply.code(201);
            return prisma.faq.create({ data: { ...request.body, masterId: request.master.id } });
        });

        scoped.put('/api/master/faq/:id', {
            schema: { params: idParam, body: { type: 'object', properties: faqProps, additionalProperties: false } }
        }, async request => {
            const item = await findOwned('faq', request.params.id, request.master.id);
            return prisma.faq.update({ where: { id: item.id }, data: request.body });
        });

        scoped.delete('/api/master/faq/:id', { schema: { params: idParam } }, async request => {
            const item = await findOwned('faq', request.params.id, request.master.id);
            await prisma.faq.delete({ where: { id: item.id } });
            return { ok: true };
        });

        // ---------- Рассылки (Pro) ----------

        scoped.get('/api/master/broadcasts', async request => prisma.broadcast.findMany({
            where: { masterId: request.master.id },
            orderBy: { createdAt: 'desc' },
            take: 50,
            include: { _count: { select: { recipients: true } } }
        }));

        scoped.post('/api/master/broadcast', {
            preHandler: requirePro,
            config: { rateLimit: { max: 5, timeWindow: '1 hour' } }
        }, async (request, reply) => {
            if (!botManager.isRunning(request.master.id)) throw httpError(400, 'Сначала подключите бота');

            // Принимаем и JSON { text }, и multipart (text + фото)
            let text;
            let imageUrl = null;
            if (request.isMultipart()) {
                const image = await readImage(request);
                text = image.fields.text?.value;
                imageUrl = await saveImage(image, `${request.master.id}/broadcasts`);
            } else {
                text = request.body?.text;
            }
            text = escapeHtml(String(text || '').trim());
            if (!text) throw httpError(400, 'Введите текст рассылки');
            // Лимиты Telegram: подпись к фото 1024, сообщение 4096 (считаем после экранирования)
            if (text.length > (imageUrl ? 1024 : 4096)) {
                await deleteImage(imageUrl);
                throw httpError(400, imageUrl ? 'Текст с фото — до ~1000 символов' : 'Текст — до ~4000 символов');
            }

            const created = await broadcast.createBroadcast(request.master.id, { text, imageUrl });
            broadcast.run(created.id);
            reply.code(202);
            return created;
        });

        // ---------- Статистика ----------

        scoped.get('/api/master/stats', async request => {
            const masterId = request.master.id;
            const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const [bookingsMonth, newClientsMonth, clientsTotal, byStatus] = await Promise.all([
                prisma.booking.count({ where: { masterId, createdAt: { gte: monthAgo } } }),
                prisma.client.count({ where: { masterId, firstVisitAt: { gte: monthAgo } } }),
                prisma.client.count({ where: { masterId } }),
                prisma.booking.groupBy({ by: ['status'], where: { masterId }, _count: true })
            ]);
            const views = request.master.statsViews;
            const total = request.master.statsBookings;
            return {
                bookingsMonth, newClientsMonth, clientsTotal,
                bookingsTotal: total, views,
                conversion: views ? Math.round((total / views) * 1000) / 10 : 0,
                byStatus: Object.fromEntries(byStatus.map(s => [s.status, s._count]))
            };
        });

        // ---------- Подписка ----------

        scoped.get('/api/master/subscription', async request => {
            const m = request.master;
            const [services, portfolio, faq, lastPayment] = await Promise.all([
                prisma.service.count({ where: { masterId: m.id, isActive: true } }),
                prisma.portfolio.count({ where: { masterId: m.id } }),
                prisma.faq.count({ where: { masterId: m.id } }),
                prisma.payment.findFirst({ where: { masterId: m.id }, orderBy: { createdAt: 'desc' } })
            ]);
            return {
                plan: isPro(m) ? 'pro' : 'free',
                expiresAt: m.planExpiresAt,
                price: config.proPrice,
                periodDays: PERIOD_DAYS,
                limits: config.freeLimits,
                usage: { services, portfolio, faq },
                yukassa: yukassaEnabled(),
                manualDetails: config.manualPaymentDetails,
                pendingManual: lastPayment?.method === 'manual' && lastPayment.status === 'pending'
            };
        });
    });
};
