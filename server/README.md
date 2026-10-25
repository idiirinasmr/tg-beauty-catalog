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
npm test                      # 25 интеграционных тестов (нужна запущенная dev-db)
```

Для локальной БД в `.env`:
```
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/postgres?connection_limit=1&sslmode=disable&pgbouncer=true
DIRECT_URL=<то же самое>
```

С `DEV_LOGIN=1` на странице входа появляется поле «Telegram ID» — вход без Telegram.

## Продакшен (VPS на Бегете)

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
