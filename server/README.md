# Сервер платформы BeautyApp

Один процесс Node.js: API + раздача фронтендов + все Telegram-боты + cron-задачи.

| Адрес | Что это |
|---|---|
| `/app/?bot=USERNAME` | Mini App каталога для клиентов (`tg-app/`) |
| `/admin/` | Панель мастера (`admin/`) |
| `/platform/` | Панель владельца платформы (`platform-admin/`) |
| `/api/...` | API (см. `docs/BACKEND-PLAN.md`, раздел 3) |
| `/bot/:hookId` | Вебхуки Telegram |

## Локальный запуск (Windows, без Postgres и Docker)

```bash
cd server
npm install
cp .env.example .env          # затем: NODE_ENV=development, DEV_LOGIN=1, APP_URL=http://localhost:3000, BOT_MODE=polling
npm run generate-key          # создаёт файл ключа и печатает JWT_SECRET — вставить в .env
node scripts/dev-db.js        # локальная БД (PGlite) на 127.0.0.1:54329 — оставить открытым
npx prisma migrate deploy     # создать таблицы
npm run dev                   # http://localhost:3000/admin/
npm test                      # 40 тестов, в т.ч. режим Vercel (нужна запущенная dev-db)
```

Для локальной БД в `.env`:
```
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/postgres?connection_limit=1&sslmode=disable&pgbouncer=true
DIRECT_URL=<то же самое>
```

С `DEV_LOGIN=1` на странице входа появляется поле «Telegram ID» — вход без Telegram.

## Продакшен на Vercel (сейчас)

Проект **krasa-platform** → https://krasa-platform.vercel.app (аккаунт idiirinasmr).
Тот же код, что и для VPS, но в режиме serverless (`config.serverless`, включается сам на Vercel):

| Что | Как на Vercel |
|---|---|
| API и вебхуки | функция `api/index.js` → `server/src/vercel.js` (Fastify) |
| Панели и Mini App | статика из `public/` (собирает `server/scripts/build-vercel.js`) |
| Боты | только вебхуки; бот «просыпается» на каждое сообщение по `bot_id` из адреса |
| Каждые 5 минут (напоминания, отзывы, рассылки) | Supabase pg_cron → `POST /api/cron/tick` |
| Раз в день 21:00 МСК (подписки, отчёт) | Vercel Cron → `GET /api/cron/daily` (`vercel.json`) |
| Фото | только Supabase Storage (`SUPABASE_SERVICE_KEY` обязателен) |
| Ключ шифрования | переменная `ENCRYPTION_KEY` (на VPS — файл) |
| Бэкапы | средствами Supabase; `backup.sh` и алерт о бэкапе на Vercel не работают |

**Настройки** лежат в Vercel (Settings → Environment Variables, только Production).
Резервная копия — `server/secrets/vercel.env` (не в git). ⚠️ `ENCRYPTION_KEY` из неё сохранить в
пароль-менеджер: без него сохранённые токены ботов мастеров не расшифровать.

**Первый запуск:**
1. Добавить в Vercel `DATABASE_URL` (pooler 6543 + `?pgbouncer=true&connection_limit=1`), `DIRECT_URL` (5432),
   `SUPABASE_SERVICE_KEY`; в Supabase Storage создать публичный бакет `media`.
2. `vercel deploy --prod` из корня репозитория — сборка сама применит миграции.
3. Расписание раз в 5 минут:
   `APP_URL=https://krasa-platform.vercel.app CRON_SECRET=... DIRECT_URL=... node server/scripts/setup-supabase-cron.js`
4. @BotFather → `/setdomain` → бот владельца → `krasa-platform.vercel.app` (без этого не работает кнопка входа).
5. Открыть любой адрес `/api/cron/tick` не нужно: первый же запуск расписания поставит вебхук бота владельца.

## Продакшен (VPS на Бегете — позже)

1. **Supabase**: Project Settings → Database → строки подключения
   - `DATABASE_URL` — pooler, порт 6543, добавить `?pgbouncer=true`
   - `DIRECT_URL` — порт 5432 (для миграций и бэкапов)
   - Settings → API → `service_role` → `SUPABASE_SERVICE_KEY`
   - Storage → создать **публичный** бакет `media` и **приватный** `backups`
2. **Бот владельца**: @BotFather → `/newbot` → токен в `ADMIN_BOT_TOKEN`, username в `ADMIN_BOT_USERNAME`;
   затем `/setdomain` → ваш домен (нужно для входа через Telegram на сайте).
   Свой Telegram ID (узнать у @userinfobot) → `ADMIN_TELEGRAM_IDS`.
3. **VPS** (Ubuntu):
   ```bash
   sudo apt install -y nodejs npm nginx certbot python3-certbot-nginx postgresql-client
   sudo useradd -r -m beauty && sudo mkdir -p /opt/beauty-saas && sudo chown beauty /opt/beauty-saas
   # скопировать репозиторий в /opt/beauty-saas, затем:
   cd /opt/beauty-saas/server && npm ci --omit=dev
   sudo mkdir -p /etc/beauty-saas && sudo node scripts/generate-key.js /etc/beauty-saas/encryption.key
   sudo chown beauty /etc/beauty-saas/encryption.key
   npx prisma migrate deploy
   sudo cp deploy/beauty-saas.service /etc/systemd/system/ && sudo systemctl enable --now beauty-saas
   sudo cp deploy/nginx.conf /etc/nginx/sites-available/beauty-saas   # поправить server_name
   sudo ln -s /etc/nginx/sites-available/beauty-saas /etc/nginx/sites-enabled/ && sudo certbot --nginx
   ```
4. **Бэкапы**: `crontab -e` от пользователя beauty:
   ```
   0 3 * * * /opt/beauty-saas/server/scripts/backup.sh >> /home/beauty/backup.log 2>&1
   ```
5. **ЮKassa** (когда будет магазин): `YUKASSA_SHOP_ID`, `YUKASSA_SECRET_KEY`, в личном кабинете
   указать URL уведомлений `https://ВАШ_ДОМЕН/api/payment/webhook` (событие `payment.succeeded`).

⚠️ Файл `/etc/beauty-saas/encryption.key` — сохранить копию в пароль-менеджер. Без него
сохранённые токены ботов мастеров не расшифровать.

## Решения, отличающиеся от плана

- **Очередь сообщений в памяти**, а не BullMQ + Redis (решение совета 26.10.2026): для 50 мастеров
  хватает, Redis не нужно администрировать. Рассылки переживают рестарт — статус каждого получателя
  в таблице `broadcast_recipients`. Интерфейс `enqueue()` в `utils/queue.js` позволит заменить на BullMQ.
- **Подключение бота доступно на Free** — без бота у мастера нет канала к клиентам.
- **Дата визита назначается мастером** при подтверждении заявки (`bookings.appointment_at`) —
  от неё считаются напоминания за 24 и 2 часа.
- **Stripe** пока не подключён — только ЮKassa и перевод на карту.
