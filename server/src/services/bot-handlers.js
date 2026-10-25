/*
 * Обработчики бота мастера (бот-консультант, раздел 6 плана).
 * Клиент: /start, /help, /my_bookings, вопросы (FAQ -> иначе пересылка мастеру), отзывы.
 * Мастер (по telegram_id): /stats, /clients, /broadcast, ответы клиентам через reply.
 */

const { InlineKeyboard } = require('grammy');
const prisma = require('../utils/db');
const { isPro } = require('../middleware/plan-check');
const { answerFor } = require('./faq-engine');
const { sendFromMasterBot, notifyMaster, escapeHtml } = require('./notify');
const { miniAppUrl, panelUrl } = require('./bot-manager');

// Клиенты, от которых ждём текст отзыва: `${masterId}:${telegramId}` -> { reviewId, until }
const pendingReviews = new Map();
const REVIEW_TEXT_TTL = 60 * 60 * 1000;

const CLIENT_TAG = /#id(\d+)/;

async function upsertClient(masterId, from) {
    return prisma.client.upsert({
        where: { masterId_telegramId: { masterId, telegramId: BigInt(from.id) } },
        create: { masterId, telegramId: BigInt(from.id), firstName: from.first_name || '', username: from.username || null },
        update: { firstName: from.first_name || '', username: from.username || null, isBlocked: false }
    });
}

function formatDate(date) {
    return date.toLocaleString('ru-RU', {
        timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
    });
}

const STATUS_LABELS = { new: '🕓 ждёт подтверждения', confirmed: '✅ подтверждена', completed: '✔️ завершена', cancelled: '✖️ отменена' };

async function masterStats(masterId) {
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [bookings, newClients, totalClients] = await Promise.all([
        prisma.booking.count({ where: { masterId, createdAt: { gte: monthAgo } } }),
        prisma.client.count({ where: { masterId, firstVisitAt: { gte: monthAgo } } }),
        prisma.client.count({ where: { masterId } })
    ]);
    return { bookings, newClients, totalClients };
}

function setupMasterBot(bot, masterId) {
    // Свежие данные мастера на каждый апдейт (их меняют из панели)
    bot.use(async (ctx, next) => {
        ctx.master = await prisma.master.findUnique({ where: { id: masterId } });
        if (!ctx.master || !ctx.from || ctx.chat?.type !== 'private') return;
        ctx.isMaster = String(ctx.master.telegramId) === String(ctx.from.id);
        if (!ctx.isMaster) await upsertClient(masterId, ctx.from);
        await next();
    });

    bot.command('start', async ctx => {
        const m = ctx.master;
        const username = ctx.me.username;
        if (ctx.isMaster) {
            const kb = new InlineKeyboard()
                .webApp('📱 Мой каталог', miniAppUrl(username)).row()
                .webApp('⚙️ Панель мастера', panelUrl(username));
            return ctx.reply(
                `Здравствуйте, ${escapeHtml(m.name)}! Это ваш бот — клиенты записываются через него.\n\n` +
                `Команды мастера:\n/stats — статистика\n/clients — клиенты\n/broadcast — рассылка\n\n` +
                `Чтобы ответить клиенту на вопрос — ответьте (reply) на пересланное сообщение.`,
                { parse_mode: 'HTML', reply_markup: kb }
            );
        }
        const kb = new InlineKeyboard().webApp('💅 Открыть каталог', miniAppUrl(username));
        await ctx.reply(
            `Здравствуйте, ${escapeHtml(ctx.from.first_name || '')}! 👋\n\n` +
            `Я бот мастера <b>${escapeHtml(m.headerName && isPro(m) ? m.headerName : m.name)}</b>` +
            `${m.specialty ? ` — ${escapeHtml(m.specialty)}` : ''}.\n\n` +
            `Откройте каталог, выберите услугу и оставьте заявку — мастер подтвердит время. ` +
            `Если есть вопрос — просто напишите его сюда.`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    });

    bot.command('help', async ctx => {
        const m = ctx.master;
        const lines = [
            '<b>Как записаться</b>',
            '1. Нажмите «Записаться» внизу слева или /start',
            '2. Выберите услугу и подтвердите заявку',
            '3. Мастер подтвердит дату и время — бот пришлёт сообщение',
            '',
            '/my_bookings — мои записи'
        ];
        if (m.phone) lines.push('', `📞 ${escapeHtml(m.phone)}`);
        if (m.address) lines.push(`📍 ${escapeHtml(m.address)}`);
        await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    });

    bot.command('my_bookings', async ctx => {
        const bookings = await prisma.booking.findMany({
            where: { masterId, clientTelegramId: BigInt(ctx.from.id), status: { in: ['new', 'confirmed'] } },
            orderBy: { createdAt: 'desc' },
            take: 10
        });
        if (!bookings.length) {
            return ctx.reply('У вас нет активных записей. Нажмите /start, чтобы открыть каталог.');
        }
        const text = bookings.map(b =>
            `• <b>${escapeHtml(b.serviceName)}</b> — ${STATUS_LABELS[b.status]}` +
            (b.appointmentAt ? `\n  🗓 ${formatDate(b.appointmentAt)}` : '')
        ).join('\n');
        await ctx.reply(`Ваши записи:\n\n${text}`, { parse_mode: 'HTML' });
    });

    // --- Команды мастера ---

    bot.command('stats', async ctx => {
        if (!ctx.isMaster) return;
        const s = await masterStats(masterId);
        await ctx.reply(
            `📊 За 30 дней:\nЗаявок: ${s.bookings}\nНовых клиентов: ${s.newClients}\n\n` +
            `Всего клиентов: ${s.totalClients}\nОткрытий каталога: ${ctx.master.statsViews}`
        );
    });

    bot.command('clients', async ctx => {
        if (!ctx.isMaster) return;
        const s = await masterStats(masterId);
        const more = isPro(ctx.master) ? 'Полная база — в панели мастера.' : 'Клиентская база с контактами — на тарифе Pro.';
        await ctx.reply(`👥 Клиентов: ${s.totalClients} (новых за месяц: ${s.newClients}).\n${more}`);
    });

    bot.command('broadcast', async ctx => {
        if (!ctx.isMaster) return;
        if (!isPro(ctx.master)) return ctx.reply('Рассылки доступны на тарифе Pro. Подключить — в панели мастера.');
        const kb = new InlineKeyboard().webApp('✉️ Создать рассылку', panelUrl(ctx.me.username) + '#broadcast');
        await ctx.reply('Рассылку удобнее составить в панели: текст + фото.', { reply_markup: kb });
    });

    // --- Отзывы: оценка кнопкой, затем текст ---

    bot.callbackQuery(/^rate:([0-9a-f-]{36}):([1-5])$/, async ctx => {
        const [, bookingId, rating] = ctx.match;
        const booking = await prisma.booking.findFirst({
            where: { id: bookingId, masterId, clientTelegramId: BigInt(ctx.from.id), status: 'completed' }
        });
        if (!booking) return ctx.answerCallbackQuery({ text: 'Запись не найдена' });

        const review = await prisma.review.upsert({
            where: { bookingId },
            create: { masterId, bookingId, clientName: booking.clientName, rating: Number(rating) },
            update: { rating: Number(rating) }
        });
        pendingReviews.set(`${masterId}:${ctx.from.id}`, { reviewId: review.id, until: Date.now() + REVIEW_TEXT_TTL });

        await ctx.answerCallbackQuery({ text: 'Спасибо за оценку!' });
        await ctx.editMessageText(`Ваша оценка: ${'⭐'.repeat(Number(rating))}\n\nНапишите пару слов о визите — мастеру будет приятно. Или /skip, чтобы пропустить.`);
        notifyMaster(ctx.master, `⭐ Новая оценка ${rating}/5 от ${escapeHtml(booking.clientName)} (${escapeHtml(booking.serviceName)})`);
    });

    bot.command('skip', async ctx => {
        pendingReviews.delete(`${masterId}:${ctx.from.id}`);
        await ctx.reply('Хорошо! Спасибо, что выбрали нас 💛');
    });

    // --- Текстовые сообщения ---

    bot.on('message:text', async ctx => {
        const text = ctx.message.text;
        if (text.startsWith('/')) return;

        if (ctx.isMaster) {
            // Мастер отвечает клиенту reply-ем на пересланный вопрос
            const original = ctx.message.reply_to_message?.text || '';
            const tag = original.match(CLIENT_TAG);
            if (!tag) {
                return ctx.reply('Чтобы ответить клиенту, ответьте (reply) на сообщение с его вопросом. Команды: /stats /clients /broadcast');
            }
            const ok = await sendFromMasterBot(masterId, tag[1], `💬 Ответ мастера:\n\n${escapeHtml(text)}`, { priority: 'critical' });
            return ctx.reply(ok ? '✅ Ответ отправлен клиенту' : '⚠️ Не удалось отправить: клиент заблокировал бота');
        }

        // Текст отзыва
        const pendingKey = `${masterId}:${ctx.from.id}`;
        const pending = pendingReviews.get(pendingKey);
        if (pending && pending.until > Date.now()) {
            pendingReviews.delete(pendingKey);
            await prisma.review.update({ where: { id: pending.reviewId }, data: { text: text.slice(0, 1000) } });
            return ctx.reply('Спасибо за отзыв! 💛');
        }

        // FAQ
        const answer = await answerFor(masterId, text);
        if (answer) return ctx.reply(answer);

        // Не нашли ответ — пересылаем мастеру
        const from = ctx.from;
        const who = `${escapeHtml(from.first_name || 'Клиент')}${from.username ? ` (@${escapeHtml(from.username)})` : ''}`;
        const sent = await notifyMaster(ctx.master,
            `❓ Вопрос от ${who} #id${from.id}\n\n${escapeHtml(text)}\n\n<i>Ответьте на это сообщение (reply) — бот перешлёт ответ клиенту.</i>`);
        await ctx.reply(sent
            ? 'Передал ваш вопрос мастеру — ответ придёт сюда же 🙌'
            : 'Мастер скоро ответит. Можно также открыть каталог: /start');
    });
}

module.exports = { setupMasterBot, upsertClient, masterStats, formatDate, STATUS_LABELS };
