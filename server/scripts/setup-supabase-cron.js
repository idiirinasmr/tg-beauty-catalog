/**
 * Расписание для Vercel: Supabase каждые 5 минут вызывает /api/cron/tick
 * (напоминания клиентам, запросы отзывов, досылка рассылок).
 * Встроенный Vercel Cron на бесплатном тарифе запускается только раз в день.
 *
 * Запуск (один раз после первого деплоя), переменные — из server/.env или окружения:
 *   APP_URL=https://<проект>.vercel.app CRON_SECRET=... DIRECT_URL=postgresql://... node scripts/setup-supabase-cron.js
 * Повторный запуск безопасен: задача пересоздаётся с новыми значениями.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');

const { APP_URL, CRON_SECRET, DIRECT_URL } = process.env;
if (!APP_URL?.startsWith('https://') || !CRON_SECRET || !DIRECT_URL) {
    console.error('Нужны APP_URL (https://...), CRON_SECRET и DIRECT_URL');
    process.exit(1);
}

const JOB = 'beautyapp-tick';
const url = `${APP_URL.replace(/\/$/, '')}/api/cron/tick`;
const prisma = new PrismaClient({ datasourceUrl: DIRECT_URL });

(async () => {
    await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_cron');
    await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_net');
    await prisma.$executeRawUnsafe(`SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = '${JOB}'`);
    // Значения передаются параметрами ($1, $2) — без подстановки в текст SQL
    await prisma.$executeRawUnsafe(
        `SELECT cron.schedule('${JOB}', '*/5 * * * *', format(
            $q$SELECT net.http_post(url := %L, headers := jsonb_build_object('Authorization', %L), timeout_milliseconds := 55000)$q$,
            $1::text, $2::text))`,
        url, `Bearer ${CRON_SECRET}`
    );
    const jobs = await prisma.$queryRawUnsafe(`SELECT jobname, schedule, active FROM cron.job WHERE jobname = '${JOB}'`);
    console.log('Готово:', jobs);
})().catch(err => {
    console.error(err.message);
    process.exit(1);
}).finally(() => prisma.$disconnect());
