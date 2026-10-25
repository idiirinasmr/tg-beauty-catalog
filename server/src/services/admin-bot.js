/*
 * Бот владельца платформы (раздел 15 плана): уведомления в личку, команды, ежедневный отчёт.
 * Отвечает только ADMIN_TELEGRAM_IDS. Через него же открывается панель платформы (Mini App).
 */

const { InlineKeyboard } = require('grammy');
const config = require('../config');
const prisma = require('../utils/db');
const { enqueue, stats: queueStats } = require('../utils/queue');
const botManager = require('./bot-manager');
const { overview } = require('./platform-stats');
const { activatePro, revenue } = require('./payment');

const KEY = 'admin';

function rub(n) {
    return `${Number(n).toLocaleString('ru-RU')} руб`;
}

function dateRu(d) {
    return d ? d.toLocaleDateString('ru-RU', { timeZone: config.timezone }) : '—';
}

/** Уведомление всем админам. Без ADMIN_BOT_TOKEN — просто в лог. */
function notifyAdmin(text) {
    const api = botManager.getApi(KEY);
    if (!api) {
        console.log(`[admin] ${text}`);
        return;
    }
    for (const id of config.adminIds) {
        enqueue(KEY, () => api.sendMessage(id, text), 'critical')
            .catch(err => console.error('[admin-bot]', err.message));
    }
}

async function findMasterByName(query) {
    return prisma.master.findFirst({
        where: {
            OR: [
                { name: { contains: query, mode: 'insensitive' } },
                { botUsername: { equals: query.replace(/^@/, ''), mode: 'insensitive' } }
            ]
        },
        include: { _count: { select: { clients: true, services: true, bookings: true } } }
    });
}

async function dailyReportText() {
    const s = await overview();
    const exp = s.expiring.length
        ? s.expiring.map(m => `${m.name}, до ${dateRu(m.planExpiresAt)}`).join('; ')
        : 'нет';
    return [
        `📊 Отчёт за ${dateRu(new Date())}:`,
        '',
        `Мастеров: ${s.masters}/${s.maxMasters} (Free: ${s.free}, Pro: ${s.pro})`,
        `Новых сегодня: +${s.mastersToday}`,
        `Клиентов всего: ${s.clients} (+${s.clientsToday} сегодня)`,
        `Записей сегодня: ${s.bookingsToday}`,
        `Выручка сегодня: ${rub(s.revenue.today)}`,
        `Выручка за месяц: ${rub(s.revenue.month)}`,
        `Подписки истекают скоро: ${exp}`
    ].join('\n');
}

function setupAdminBot(bot) {
    bot.use(async (ctx, next) => {
        if (!ctx.from || !config.adminIds.includes(String(ctx.from.id))) {
            if (ctx.message) await ctx.reply('Бот не предназначен для использования.');
            return;
        }
        await next();
    });

    bot.command(['start', 'help'], ctx => {
        const kb = new InlineKeyboard().webApp('🛠 Панель платформы', `${config.appUrl}/platform/`);
        return ctx.reply([
            'Бот владельца платформы. Команды:',
            '/stats — общая статистика',
            '/today — за сегодня',
            '/masters — все мастера',
            '/master Имя — карточка мастера',
            '/revenue — выручка',
            '/expiring — истекающие подписки',
            '/activate Имя [дней] — включить Pro вручную',
            '/backup — статус бэкапа'
        ].join('\n'), { reply_markup: kb });
    });

    bot.command('stats', async ctx => {
        const s = await overview();
        await ctx.reply(
            `Мастеров: ${s.masters}/${s.maxMasters} (Free: ${s.free}, Pro: ${s.pro})\n` +
            `Клиентов: ${s.clients}\nЗаписей всего: ${s.bookingsTotal}\n` +
            `Выручка за месяц: ${rub(s.revenue.month)}\n` +
            `Активных ботов: ${botManager.runningCount()}\nОчередь сообщений: ${queueStats().pending}`
        );
    });

    bot.command('today', async ctx => {
        const s = await overview();
        await ctx.reply(`Сегодня: +${s.mastersToday} мастеров, +${s.clientsToday} клиентов, ` +
            `${s.bookingsToday} записей, ${s.paymentsToday} оплат (${rub(s.revenue.today)})`);
    });

    bot.command('masters', async ctx => {
        const masters = await prisma.master.findMany({
            orderBy: { createdAt: 'asc' },
            include: { _count: { select: { clients: true } } }
        });
        if (!masters.length) return ctx.reply('Мастеров пока нет');
        const lines = masters.map((m, i) =>
            `${i + 1}. ${m.name}${m.botUsername ? ` (@${m.botUsername})` : ''} — ${m.plan}, клиентов: ${m._count.clients}`);
        await ctx.reply(lines.join('\n').slice(0, 4000));
    });

    bot.command('master', async ctx => {
        const q = ctx.match.trim();
        if (!q) return ctx.reply('Использование: /master Имя');
        const m = await findMasterByName(q);
        if (!m) return ctx.reply('Мастер не найден');
        await ctx.reply([
            `👤 ${m.name}${m.botUsername ? ` (@${m.botUsername})` : ''}`,
            `Специализация: ${m.specialty || '—'}`,
            `Тариф: ${m.plan}${m.plan === 'pro' ? ` до ${dateRu(m.planExpiresAt)}` : ''}`,
            `Услуг: ${m._count.services}, клиентов: ${m._count.clients}, записей: ${m._count.bookings}`,
            `Бот: ${botManager.isRunning(m.id) ? 'работает' : 'не подключён'}`,
            `Регистрация: ${dateRu(m.createdAt)}`,
            `Телефон: ${m.phone || '—'}, email: ${m.email || '—'}`
        ].join('\n'));
    });

    bot.command('revenue', async ctx => {
        const s = await overview();
        await ctx.reply(`Выручка:\nСегодня: ${rub(s.revenue.today)}\nНеделя: ${rub(s.revenue.week)}\n` +
            `Месяц: ${rub(s.revenue.month)}\nВсего: ${rub(s.revenue.total)}`);
    });

    bot.command('expiring', async ctx => {
        const s = await overview();
        await ctx.reply(s.expiring.length
            ? s.expiring.map(m => `${m.name} — до ${dateRu(m.planExpiresAt)}`).join('\n')
            : 'В ближайшие 7 дней подписки не истекают');
    });

    bot.command('activate', async ctx => {
        const parts = ctx.match.trim().split(/\s+/);
        const days = /^\d+$/.test(parts.at(-1)) && parts.length > 1 ? Number(parts.pop()) : 30;
        const q = parts.join(' ');
        if (!q) return ctx.reply('Использование: /activate Имя [дней]');
        const m = await findMasterByName(q);
        if (!m) return ctx.reply('Мастер не найден');

        // Если мастер оставлял заявку на ручную оплату — закрываем её
        const pending = await prisma.payment.findFirst({
            where: { masterId: m.id, method: 'manual', status: 'pending' },
            orderBy: { createdAt: 'desc' }
        });
        const { master } = await activatePro(m.id, { days, paymentId: pending?.id });
        await ctx.reply(`✅ Pro активирован для ${m.name} до ${dateRu(master.planExpiresAt)}`);
        const { notifyMaster } = require('./notify');
        notifyMaster(master, `🎉 Тариф Pro активирован до ${dateRu(master.planExpiresAt)}. Спасибо!`);
    });

    bot.command('backup', async ctx => {
        const last = await prisma.backupLog.findFirst({ orderBy: { createdAt: 'desc' } });
        if (!last) return ctx.reply('Бэкапов ещё не было');
        await ctx.reply(`Последний бэкап: ${last.createdAt.toLocaleString('ru-RU', { timeZone: config.timezone })}\n` +
            `Размер: ${(Number(last.sizeBytes) / 1024 / 1024).toFixed(1)} МБ\nСтатус: ${last.ok ? 'ОК' : 'ошибка — ' + last.message}`);
    });
}

async function startAdminBot() {
    if (!config.adminBotToken) {
        console.log('[admin-bot] ADMIN_BOT_TOKEN не задан — уведомления пишутся в лог');
        return;
    }
    const entry = await botManager.launch(KEY, config.adminBotToken, setupAdminBot);
    await entry.bot.api.setMyCommands([
        { command: 'stats', description: 'Общая статистика' },
        { command: 'today', description: 'За сегодня' },
        { command: 'masters', description: 'Все мастера' },
        { command: 'revenue', description: 'Выручка' },
        { command: 'expiring', description: 'Истекающие подписки' },
        { command: 'backup', description: 'Статус бэкапа' }
    ]).catch(() => {});
}

async function sendDailyReport() {
    notifyAdmin(await dailyReportText());
}

/** Алерт, если за последние 26 часов не было успешного бэкапа */
async function checkBackups() {
    const since = new Date(Date.now() - 26 * 60 * 60 * 1000);
    const ok = await prisma.backupLog.count({ where: { ok: true, createdAt: { gte: since } } });
    if (!ok) notifyAdmin('🚨 Ошибка бэкапа: за сутки не создано ни одного успешного бэкапа. Проверь VPS');
}

module.exports = { notifyAdmin, startAdminBot, sendDailyReport, checkBackups, revenue };
