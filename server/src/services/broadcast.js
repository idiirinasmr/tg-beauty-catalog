/*
 * Рассылки мастера (Pro). Получатели фиксируются в broadcast_recipients при создании,
 * отправка идёт через очередь с приоритетом low (20 msg/сек на бота).
 * После рестарта resumeAll() дошлёт оставшимся (status = pending) — без дублей.
 *
 * На Vercel время работы функции ограничено, поэтому за один запуск уходит не больше
 * BATCH_SERVERLESS сообщений; остальное досылает cron (/api/cron/tick → resumeAll).
 */

const config = require('../config');
const prisma = require('../utils/db');
const { track } = require('../utils/background');
const { sendFromMasterBot } = require('./notify');

const BATCH_SERVERLESS = 500; // ~25 секунд при 20 msg/сек
const running = new Set();

async function createBroadcast(masterId, { text, imageUrl }) {
    const clients = await prisma.client.findMany({
        where: { masterId, isBlocked: false },
        select: { telegramId: true }
    });
    return prisma.broadcast.create({
        data: {
            masterId, text, imageUrl: imageUrl || null, status: 'queued',
            recipients: { create: clients.map(c => ({ telegramId: c.telegramId })) }
        },
        include: { _count: { select: { recipients: true } } }
    });
}

/** Отправить рассылку (или очередную порцию). Можно вызывать без await. */
function run(broadcastId) {
    return track(sendBatch(broadcastId));
}

async function sendBatch(broadcastId) {
    if (running.has(broadcastId)) return;
    running.add(broadcastId);
    try {
        const broadcast = await prisma.broadcast.update({ where: { id: broadcastId }, data: { status: 'sending' } });
        const pending = await prisma.broadcastRecipient.findMany({
            where: { broadcastId, status: 'pending' },
            take: config.serverless ? BATCH_SERVERLESS : undefined
        });

        await Promise.all(pending.map(async r => {
            const ok = await sendFromMasterBot(broadcast.masterId, r.telegramId, broadcast.text, {
                priority: 'low',
                photo: broadcast.imageUrl || undefined
            });
            await prisma.broadcastRecipient.update({ where: { id: r.id }, data: { status: ok ? 'sent' : 'failed' } });
        }));

        const left = await prisma.broadcastRecipient.count({ where: { broadcastId, status: 'pending' } });
        if (left) return; // остаток дошлёт следующий запуск

        const sent = await prisma.broadcastRecipient.count({ where: { broadcastId, status: 'sent' } });
        await prisma.broadcast.update({
            where: { id: broadcastId },
            data: { status: 'done', sentAt: new Date(), recipientsCount: sent }
        });
    } catch (err) {
        console.error('[broadcast]', err.message);
    } finally {
        running.delete(broadcastId);
    }
}

async function resumeAll() {
    const unfinished = await prisma.broadcast.findMany({ where: { status: { in: ['queued', 'sending'] } } });
    await Promise.all(unfinished.map(b => run(b.id)));
}

module.exports = { createBroadcast, run, resumeAll };
