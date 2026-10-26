# BeautyApp — SaaS-платформа для бьюти-мастеров в Telegram

У каждого мастера свой Telegram-бот и каталог (Mini App). Один сервер обслуживает всех мастеров,
и каждый видит только своё. Архитектура: [docs/BACKEND-PLAN.md](docs/BACKEND-PLAN.md).
Принятые решения и отступления от плана: [docs/DECISIONS.md](docs/DECISIONS.md).
История работ: [WORK-LOG.md](WORK-LOG.md).

## Структура проекта

```
tg-beauty-catalog/
├── CLAUDE.md             ← этот файл
├── WORK-LOG.md           ← журнал работ (обновлять после каждого этапа)
├── research.md, brief.md ← исследование ниши и ТЗ первой версии
├── docs/
│   ├── BACKEND-PLAN.md   ← архитектура SaaS (утверждена)
│   ├── BACKEND-QUESTIONS.md
│   └── DECISIONS.md      ← решения совета, дизайн, отступления от плана
├── tg-app/               ← Mini App каталога для клиентов
├── admin/                ← панель мастера
├── platform-admin/       ← панель владельца платформы
├── server/               ← API + боты + cron (Node.js), инструкция: server/README.md
└── bot/setup.js          ← настройка демо-бота первой версии (@Krasa555bot)
```

## server/ — бэкенд

Fastify + Prisma (Postgres/Supabase) + grammy. Один процесс: API, раздача фронтендов, все боты, cron.

| Папка/файл | За что отвечает |
|---|---|
| `src/index.js` | точка входа, плагины, CSP, раздача `/app/` `/admin/` `/platform/`, вебхуки `/bot/:hookId`, cron |
| `src/config.js` | все переменные окружения (`server/.env`, образец `.env.example`) |
| `src/prisma/schema.prisma` | схема БД: masters, services, portfolio, bookings, reviews, faq, broadcasts, broadcast_recipients, clients, payments, backup_log |
| `src/routes/` | `auth` (вход), `catalog` + `booking` (публичное API Mini App), `master` (API панели), `payment`, `admin` |
| `src/middleware/` | `auth.js` (JWT, роли), `plan-check.js` (лимиты Free/Pro) |
| `src/services/bot-manager.js` | запуск/остановка ботов, webhook/polling, кнопка меню |
| `src/services/bot-handlers.js` | бот-консультант: /start, FAQ, пересылка вопросов мастеру, отзывы |
| `src/services/admin-bot.js` | бот владельца: уведомления, команды, отчёт 21:00 |
| `src/services/reminder.js` | напоминания за 24 и 2 часа, запрос отзыва |
| `src/services/payment.js` | Pro: активация, ЮKassa, просрочка подписок |
| `src/utils/encrypt.js` | AES-256-GCM для токенов ботов (ключ в файле, не в .env) |
| `src/utils/queue.js` | очередь сообщений в памяти, 20 сообщений в секунду на бота |
| `scripts/` | `dev-db.js` (локальная БД), `generate-key.js`, `backup.sh` |
| `deploy/` | systemd-юнит и конфиг nginx |
| `test/` | интеграционные тесты (`npm test`, нужна запущенная dev-db) |

### Правила безопасности (не нарушать)
- **Изоляция.** Каждая выборка в API мастера фильтруется по `request.master.id` (`findOwned`).
- **Тело запроса.** У каждой схемы, которая пишет в БД, стоит `additionalProperties: false`, иначе мастер выдаст себе Pro.
- **Токен бота** никогда не попадает в ответы API (`profileView`, `omit`).
- **Вход через initData бота мастера** даёт JWT с `src: 'masterbot'`: только для владельца этого бота и никогда для админа.
- **Режим настройки** (`src: 'impersonate'`) выдаёт только админ-API; такой токен не даёт прав админа и не регистрирует мастеров.
- **HTML.** Пользовательский текст в сообщениях бота с `parse_mode: 'HTML'` проходит через `escapeHtml`, во фронтендах — через `esc()` перед `innerHTML`.
- **Вебхук ЮKassa.** Его телу не доверять: статус платежа перепроверяется через API.

## Фронтенды

Без фреймворков: чистый HTML, CSS и JS. **CSP строгий:** никаких inline-скриптов и `onclick=`.
События вешаются через `data-action` и делегирование.

### tg-app/ — каталог для клиентов
- **С `?bot=USERNAME`.** Данные берутся из `GET /api/catalog/:bot`, запись идёт через `POST /api/booking` с `tg.initData`.
- **Без параметра.** Демо-режим с данными из объекта `DEMO` в `app.js`. На нём работает GitHub Pages: https://idiirinasmr.github.io/tg-beauty-catalog/
- **Оформление.** Следует теме Telegram (`--tg-theme-*`), у Pro-мастера накладываются его цвета.
- `tg-stub.js` — заглушка Telegram для обычного браузера.

### admin/ — панель мастера
- **Вход.** Telegram Login Widget в режиме redirect, initData из бота мастера (`?bot=`) или dev-вход.
- **Навигация** по `#hash`: home, bookings, services, profile, bot, faq, reviews, clients, broadcast, design, plan, more.
- **Дизайн:** тёплый «салонный», всегда фирменный, без цветов Telegram. Токены в `admin/style.css`, шрифты Fraunces + Manrope, иконки из `admin/icons.svg`.

### platform-admin/ — панель владельца
Использует `/admin/style.css`. Доступ только для `ADMIN_TELEGRAM_IDS`.

## Как запустить локально

```bash
cd server
node scripts/dev-db.js     # локальная БД PGlite на 127.0.0.1:54329, держать открытой
npm run dev                # http://localhost:3000/admin/  (DEV_LOGIN=1: вход по Telegram ID)
npm test                   # 40 тестов
```
Первичная настройка (`.env`, ключ, миграции) и деплой на VPS описаны в [server/README.md](server/README.md).

**Особенность этого компьютера.** embedded-postgres не работает из-за кириллицы в имени пользователя Windows,
поэтому используется PGlite. В `DATABASE_URL` обязателен `pgbouncer=true`: у PGlite одна сессия на все подключения.

## Тарифы

| | Free | Pro (500 ₽ / 30 дней) |
|---|---|---|
| Услуги / фото / FAQ | 5 / 6 / 10 | без лимита |
| Свой бот, заявки | ✓ | ✓ |
| Напоминания, рассылки, база клиентов | — | ✓ |
| Логотип, цвет, название, без логотипа BeautyApp | — | ✓ |

**Настройка под ключ** — разовая оплата, **стоимость обсуждается** (`TURNKEY_PRICE=0`; сумма вводится при отметке «Оплачено»): владелец сам заполняет каталог мастера
из панели платформы. Подробно — [docs/DECISIONS.md](docs/DECISIONS.md).

Лимиты задаются в `server/src/config.js` (`freeLimits`). Когда Pro заканчивается, данные не удаляются: каталог просто показывает первые 5 услуг и 6 фото.

## Хостинг

Сейчас — **Vercel**, проект `krasa-platform` (https://krasa-platform.vercel.app). Сервер сам переходит в режим
serverless (`config.serverless`): `api/index.js` → `server/src/vercel.js`, расписание — `/api/cron/*`.
Не полагаться на состояние в памяти процесса: на Vercel его нет между запросами. Подробно — [server/README.md](server/README.md).

## Статус (27.10.2026)

Платформа опубликована: https://krasa-platform.vercel.app. Весь код — в `master` (PR #1 смёржен).
Публикация — `vercel deploy --prod` из корня (проект не подключён к GitHub, деплой из CLI).
Push в `master` также обновляет демо на GitHub Pages (`.github/workflows/deploy.yml`, папка `tg-app/`).
Продакшен-секреты — в Vercel и в `server/secrets/vercel.env` (не в git). Не хватает: магазина ЮKassa, VPS и домена (отложены).
**С чего продолжать** — раздел «▶ Продолжить отсюда» в начале [WORK-LOG.md](WORK-LOG.md).
