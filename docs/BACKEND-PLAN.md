# BACKEND-PLAN.md — Архитектура SaaS-платформы

> Дата: 13 марта 2026 (обновлён 14 марта 2026)
> Статус: утверждён, готов к разработке
> Основа: ответы из `BACKEND-QUESTIONS.md` + `research.md`

**Целевая аудитория:** любой мастер из бьюти-сферы — маникюр, педикюр, парикмахер, косметолог, бровист, лешмейкер, массажист, визажист, мастер депиляции, мастер тату и др. Платформа универсальна и не привязана к конкретной специализации.

---

## 1. Общая архитектура

```
                    Мастер                          Клиент
                      |                               |
               [Админ-панель]                  [Telegram-бот мастера]
               (веб-страница)                         |
                      |                        [Mini App каталог]
                      |                               |
                      v                               v
              +-----------------------------------------+
              |          API-сервер (Node.js)           |
              |            VPS на Бегете                |
              +-----------------------------------------+
                              |
                      +-------+-------+
                      |               |
               [Supabase DB]   [Файловое хранилище]
               (PostgreSQL)    (Supabase Storage)
```

### Принцип работы

1. Мастер регистрируется через админ-панель или Mini App
2. Мастер создаёт своего бота в BotFather, вводит токен
3. Наш сервер подключается к боту мастера через Telegram Bot API
4. Клиент открывает бота мастера -> видит только его каталог
5. Сервер по `bot_id` определяет, чей каталог показать
6. **Один сервер, много мастеров. Каждый видит только своё.**

### Ограничения на старте (MVP)

**Лимит: до 50 мастеров на первом этапе.**

Причина: grammy Multi-Bot держит все соединения в одном процессе. VPS на Бегете (1-2 GB RAM) справится с 50 ботами. При достижении лимита:
1. Закрыть регистрацию новых мастеров (вернуть сообщение «Все места заняты, оставьте заявку»)
2. Замерить потребление RAM и CPU на 50 ботах
3. Если ресурсов достаточно — поднять лимит до 100, 200 и т.д.
4. Если не хватает — масштабировать: увеличить VPS или вынести ботов в отдельный процесс (worker)

**Реализация в коде:**
- В таблице `masters` добавить middleware: перед `POST /api/master/register` проверять `SELECT COUNT(*) FROM masters`
- Лимит хранить в переменной окружения `MAX_MASTERS=50`
- При достижении лимита — вернуть HTTP 503 с сообщением

---

## 2. Модель данных (таблицы Supabase)

### 2.1 masters (мастера)

| Поле | Тип | Описание |
|------|-----|----------|
| id | uuid, PK | Уникальный ID мастера |
| telegram_id | bigint, unique | Telegram ID мастера |
| name | text | Имя мастера |
| specialty | text | Специализация |
| phone | text | Телефон |
| email | text | Email (резервный контакт для восстановления доступа) |
| address | text | Адрес |
| avatar_url | text | Ссылка на аватар |
| logo_url | text | Ссылка на логотип (платно) |
| header_name | text | Название в шапке (платно, по умолчанию = name) |
| bot_token | text, encrypted | Токен Telegram-бота (шифруется) |
| bot_username | text | Username бота (@...) |
| plan | text | 'free' или 'pro' |
| plan_expires_at | timestamp | Дата окончания подписки |
| theme | jsonb | Кастомная тема (цвета), null = стандартная |
| white_label | boolean | Скрыть наш логотип (платно) |
| stats_bookings | int | Счётчик записей |
| created_at | timestamp | Дата регистрации |

### 2.2 services (услуги)

| Поле | Тип | Описание |
|------|-----|----------|
| id | uuid, PK | Уникальный ID услуги |
| master_id | uuid, FK -> masters | Чья услуга |
| name | text | Название |
| description | text | Описание |
| price | int | Цена в рублях |
| duration | int | Длительность в минутах |
| emoji | text | Эмодзи (если нет фото) |
| image_url | text | Ссылка на фото |
| sort_order | int | Порядок сортировки |
| is_active | boolean | Показывать ли в каталоге |
| created_at | timestamp | Дата создания |

**Ограничение:** бесплатный тариф — максимум 5 активных услуг.

### 2.3 portfolio (фото работ)

| Поле | Тип | Описание |
|------|-----|----------|
| id | uuid, PK | Уникальный ID |
| master_id | uuid, FK -> masters | Чьё фото |
| image_url | text | Ссылка на фото |
| sort_order | int | Порядок |
| created_at | timestamp | Дата загрузки |

**Ограничение:** бесплатный тариф — максимум 6 фото.

### 2.4 bookings (записи/заявки)

| Поле | Тип | Описание |
|------|-----|----------|
| id | uuid, PK | Уникальный ID заявки |
| master_id | uuid, FK -> masters | К какому мастеру |
| service_id | uuid, FK -> services | Какая услуга |
| client_telegram_id | bigint | Telegram ID клиента |
| client_name | text | Имя клиента |
| client_username | text | @username клиента |
| status | text | 'new', 'confirmed', 'completed', 'cancelled' |
| created_at | timestamp | Дата заявки |
| reminder_sent | boolean | Отправлено ли напоминание |

### 2.5 reviews (отзывы)

| Поле | Тип | Описание |
|------|-----|----------|
| id | uuid, PK | Уникальный ID |
| master_id | uuid, FK -> masters | О каком мастере |
| booking_id | uuid, FK -> bookings | После какой записи |
| client_name | text | Имя клиента |
| rating | int | Оценка 1-5 |
| text | text | Текст отзыва |
| is_visible | boolean | Мастер может скрыть |
| created_at | timestamp | Дата |

### 2.6 faq (частые вопросы для бота-консультанта)

| Поле | Тип | Описание |
|------|-----|----------|
| id | uuid, PK | Уникальный ID |
| master_id | uuid, FK -> masters | Чей FAQ |
| question | text | Вопрос (ключевые слова) |
| answer | text | Ответ бота |
| sort_order | int | Порядок |

### 2.7 broadcasts (рассылки акций/новостей)

| Поле | Тип | Описание |
|------|-----|----------|
| id | uuid, PK | Уникальный ID |
| master_id | uuid, FK -> masters | Кто рассылает |
| text | text | Текст рассылки |
| image_url | text | Фото (опционально) |
| sent_at | timestamp | Когда отправлена |
| recipients_count | int | Сколько получили |

### 2.8 clients (клиенты мастера)

| Поле | Тип | Описание |
|------|-----|----------|
| id | uuid, PK | Уникальный ID |
| master_id | uuid, FK -> masters | К какому мастеру привязан |
| telegram_id | bigint | Telegram ID клиента |
| first_name | text | Имя |
| username | text | @username |
| first_visit_at | timestamp | Первое обращение |
| bookings_count | int | Количество записей |

**Уникальность:** master_id + telegram_id (один клиент у одного мастера — одна запись).

### 2.9 payments (платежи за подписку)

| Поле | Тип | Описание |
|------|-----|----------|
| id | uuid, PK | Уникальный ID |
| master_id | uuid, FK -> masters | Кто платит |
| amount | int | Сумма в рублях |
| method | text | 'yukassa', 'stripe', 'manual' |
| status | text | 'pending', 'paid', 'failed' |
| external_id | text | ID платежа во внешней системе |
| created_at | timestamp | Дата |
| period_start | timestamp | Начало оплаченного периода |
| period_end | timestamp | Конец оплаченного периода |

---

## 3. API endpoints

### 3.1 Публичное API (Mini App для клиентов)

Клиент видит только данные своего мастера. Мастер определяется по `bot_id` из параметров Mini App.

| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/api/catalog/:botUsername` | Профиль мастера + услуги + портфолио + отзывы |
| POST | `/api/booking` | Создать заявку (service_id, initData) |
| GET | `/api/faq/:botUsername` | FAQ для бота-консультанта |

### 3.2 API мастера (админ-панель, требует авторизацию)

| Метод | URL | Описание |
|-------|-----|----------|
| POST | `/api/master/register` | Регистрация мастера (через Telegram Login) |
| GET | `/api/master/profile` | Получить свой профиль |
| PUT | `/api/master/profile` | Обновить профиль (имя, телефон, адрес) |
| POST | `/api/master/avatar` | Загрузить аватар |
| POST | `/api/master/logo` | Загрузить логотип (только pro) |
| PUT | `/api/master/theme` | Обновить тему (только pro) |
| PUT | `/api/master/header` | Изменить название в шапке (только pro) |
| POST | `/api/master/bot` | Подключить бота (токен) |
| DELETE | `/api/master/bot` | Отключить бота |
| GET | `/api/master/services` | Список своих услуг |
| POST | `/api/master/services` | Добавить услугу |
| PUT | `/api/master/services/:id` | Редактировать услугу |
| DELETE | `/api/master/services/:id` | Удалить услугу |
| POST | `/api/master/services/:id/image` | Загрузить фото услуги |
| GET | `/api/master/portfolio` | Список фото портфолио |
| POST | `/api/master/portfolio` | Загрузить фото в портфолио |
| DELETE | `/api/master/portfolio/:id` | Удалить фото |
| GET | `/api/master/bookings` | Список заявок |
| PUT | `/api/master/bookings/:id` | Изменить статус (confirmed/completed/cancelled) |
| GET | `/api/master/clients` | Клиентская база |
| GET | `/api/master/reviews` | Отзывы |
| PUT | `/api/master/reviews/:id` | Скрыть/показать отзыв |
| GET | `/api/master/faq` | Список FAQ |
| POST | `/api/master/faq` | Добавить FAQ |
| PUT | `/api/master/faq/:id` | Редактировать FAQ |
| DELETE | `/api/master/faq/:id` | Удалить FAQ |
| POST | `/api/master/broadcast` | Отправить рассылку |
| GET | `/api/master/stats` | Статистика (записи, клиенты, конверсия) |

### 3.3 API платежей

| Метод | URL | Описание |
|-------|-----|----------|
| POST | `/api/payment/create` | Создать платёж (ЮKassa/Stripe) |
| POST | `/api/payment/webhook` | Вебхук от платёжной системы |
| POST | `/api/payment/manual` | Запрос на ручную активацию |
| GET | `/api/master/subscription` | Статус подписки |

### 3.4 API администратора (для тебя)

| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/api/admin/masters` | Все мастера |
| PUT | `/api/admin/masters/:id/plan` | Вручную активировать подписку |
| GET | `/api/admin/stats` | Общая статистика платформы |
| GET | `/api/admin/payments` | Все платежи |

---

## 4. Роли и права

| Роль | Что видит | Что может делать |
|------|-----------|------------------|
| **Клиент** | Каталог одного мастера (через Mini App) | Смотреть услуги, записываться, оставлять отзывы |
| **Мастер (free)** | Свой профиль, свои заявки | До 5 услуг, до 6 фото, стандартная тема, FAQ (до 10) |
| **Мастер (pro)** | Всё то же + клиентская база, рассылки, напоминания | Безлимит услуг, логотип, своя тема, название в шапке, White Label |
| **Админ (ты)** | Все мастера, все платежи, статистика | Ручная активация подписок, управление платформой |

---

## 5. Тарифные планы

### Free (бесплатно навсегда)

| Включено | Лимит |
|----------|-------|
| Услуги | до 5 |
| Фото в портфолио | до 6 |
| Приём заявок | безлимит |
| FAQ бота | до 10 вопросов |
| Тема | стандартная |
| Логотип | наш логотип |
| Рассылки | нет |
| Клиентская база | нет |
| Напоминания | нет |

### Pro (500 руб/мес)

| Включено | Лимит |
|----------|-------|
| Услуги | безлимит |
| Фото в портфолио | безлимит |
| Приём заявок | безлимит |
| FAQ бота | безлимит |
| Рассылки | безлимит |
| Клиентская база | есть |
| Напоминания | есть |
| Кастомная тема (цвета) | есть |
| Своё название в шапке | есть |
| Свой логотип | есть |
| White Label (без нашего лого) | есть |
| Свой бот (подключение) | есть |

**Что происходит при окончании подписки:**
- Мастер возвращается на Free
- Услуги свыше 5 скрываются (не удаляются)
- Логотип, тема, название — сбрасываются на стандартные
- Данные не удаляются, можно возобновить

---

## 6. Бот-консультант — функции

### Что умеет бот каждого мастера:

| Функция | Как работает |
|---------|-------------|
| **Приветствие** | /start -> имя мастера, описание, кнопка «Открыть каталог» (Mini App) |
| **FAQ** | Клиент пишет вопрос -> бот ищет по ключевым словам в таблице faq -> если не нашёл, пересылает вопрос мастеру |
| **Напоминания** | За 24 часа и за 2 часа до записи -> сообщение клиенту |
| **Уведомление мастеру** | Новая заявка -> бот пишет мастеру: услуга, клиент, контакт |
| **Рассылки** | Мастер через админ-панель создаёт текст -> задача ставится в очередь BullMQ -> worker отправляет по 20 сообщений/сек через бота мастера -> при ошибке Telegram (429 Too Many Requests) автоматически ждёт и повторяет |
| **Сбор отзывов** | После визита (статус completed) -> бот спрашивает оценку и текст |
| **Статистика** | Мастер пишет /stats -> бот отвечает: записей за месяц, новых клиентов |
| **Помощь** | /help -> список команд |

### Команды бота для клиентов:

| Команда | Что делает |
|---------|-----------|
| /start | Приветствие + кнопка Mini App |
| /help | Как записаться, контакты мастера |
| /my_bookings | Мои записи (ближайшие) |

### Команды бота для мастера (определяется по telegram_id):

| Команда | Что делает |
|---------|-----------|
| /stats | Статистика записей |
| /clients | Количество клиентов |
| /broadcast | Начать рассылку |

---

## 7. Технический стек

### Сервер (VPS на Бегете)

| Компонент | Технология | Почему |
|-----------|-----------|--------|
| Runtime | Node.js 20+ | Один язык с фронтендом, большая экосистема |
| Фреймворк | Fastify | Быстрее Express в 2x, встроенная валидация |
| ORM | Prisma | Типобезопасность, миграции, работает с Supabase PostgreSQL |
| Telegram Bot | grammy | Современная библиотека, поддержка Multi-Bot (один процесс = много ботов) |
| Авторизация | Telegram Login Widget + JWT | Мастер логинится через Telegram, получает JWT-токен |
| Валидация initData | @telegram-apps/init-data-node | Проверка подписи данных из Mini App |
| Загрузка файлов | Supabase Storage | S3-совместимое хранилище, бесплатно до 1 GB |
| Cron-задачи | node-cron | Напоминания, проверка подписок |
| Очередь сообщений | BullMQ + Redis | Рассылки и напоминания через очередь (лимит 20 msg/sec на бота) |
| Платежи | @yokassa/sdk / stripe | Интеграция с платёжными системами |
| Шифрование | Node.js crypto (встроенный) | AES-256-GCM для bot_token, 0 зависимостей |

### База данных (Supabase)

| Что | Зачем |
|-----|-------|
| PostgreSQL | Надёжная реляционная БД, бесплатно до 500 MB |
| Supabase Storage | Хранение фото (аватары, портфолио, услуги) |
| Row Level Security | Мастер видит только свои данные |
| Realtime | Уведомления о новых заявках (будущее) |

### Фронтенд

| Компонент | Технология |
|-----------|-----------|
| Mini App (клиент) | HTML + CSS + JS (текущий, доработанный) |
| Админ-панель (мастер) | HTML + CSS + JS (отдельная страница) |

**Без фреймворков** — как в текущем проекте. Лёгкий, быстрый, понятный.

---

## 8. Как Mini App узнаёт, чей каталог показать

```
1. Мастер создаёт бота -> вводит токен в админ-панели
2. Сервер вызывает setChatMenuButton -> URL: https://app.example.com/?bot=BOT_USERNAME
3. Клиент открывает Mini App из бота мастера
4. Mini App берёт bot_username из URL-параметра
5. Запрос GET /api/catalog/BOT_USERNAME
6. Сервер находит мастера по bot_username -> возвращает его данные
7. Mini App рендерит каталог этого мастера
```

Альтернатива: вместо URL-параметра использовать `initDataUnsafe.start_param` или `Telegram.WebApp.initData` для определения бота.

---

## 9. Структура файлов бэкенда

```
tg-beauty-catalog/
|-- tg-app/                    # Mini App (фронтенд клиента) — уже есть
|-- admin/                     # Админ-панель мастера (фронтенд)
|   |-- index.html
|   |-- style.css
|   |-- admin.js
|-- server/                    # API-сервер (бэкенд)
|   |-- package.json
|   |-- .env                   # Переменные окружения
|   |-- src/
|   |   |-- index.js           # Точка входа, запуск Fastify
|   |   |-- config.js          # Конфигурация (env-переменные)
|   |   |-- routes/
|   |   |   |-- catalog.js     # GET /api/catalog/:botUsername
|   |   |   |-- booking.js     # POST /api/booking
|   |   |   |-- master.js      # CRUD профиля, услуг, портфолио
|   |   |   |-- payment.js     # Платежи, вебхуки
|   |   |   |-- admin.js       # Админка платформы
|   |   |-- services/
|   |   |   |-- bot-manager.js # Управление ботами (подключение/отключение)
|   |   |   |-- bot-handlers.js # Обработчики команд бота
|   |   |   |-- faq-engine.js  # Поиск ответов по FAQ
|   |   |   |-- reminder.js    # Напоминания (cron)
|   |   |   |-- broadcast.js   # Рассылки
|   |   |   |-- payment.js     # Логика платежей
|   |   |-- middleware/
|   |   |   |-- auth.js        # JWT-авторизация мастера
|   |   |   |-- validate-init-data.js  # Проверка Telegram initData
|   |   |   |-- plan-check.js  # Проверка тарифа (free/pro)
|   |   |-- prisma/
|   |   |   |-- schema.prisma  # Схема БД
|   |   |   |-- migrations/    # Миграции
|   |   |-- utils/
|   |       |-- encrypt.js     # Шифрование bot_token (AES-256-GCM)
|   |       |-- upload.js      # Загрузка файлов в Supabase Storage
|   |       |-- queue.js       # Настройка BullMQ (очереди рассылок/напоминаний)
|   |-- scripts/
|   |   |-- backup.sh          # Ежедневный бэкап PostgreSQL
|   |   |-- rotate-keys.js     # Ротация ключей шифрования (будущее)
|   |   |-- generate-key.sh    # Генерация ENCRYPTION_KEY
|-- docs/                      # Документация — уже есть
|-- bot/                       # Старый скрипт настройки — уже есть
```

---

## 10. Порядок разработки (этапы)

### Этап 1: Фундамент (сервер + БД)
1. Инициализация проекта: `server/package.json`, зависимости (fastify, prisma, dotenv, jsonwebtoken)
2. Настройка Prisma + Supabase PostgreSQL (schema.prisma со всеми 9 таблицами + поле email в masters)
3. Запуск миграции: `npx prisma migrate dev` -> создание таблиц в Supabase
4. Базовый Fastify-сервер: index.js, config.js, CORS, rate limiting
5. Авторизация мастера: Telegram Login Widget -> проверка hash -> выдача JWT
6. Middleware: auth.js (проверка JWT), validate-init-data.js (проверка подписи Mini App)
7. Лимит регистраций: middleware проверяет `COUNT(*) FROM masters < MAX_MASTERS` (50 на старте)
8. Настройка скрипта бэкапа: `server/scripts/backup.sh` + cron на VPS

### Этап 2: CRUD мастера
9. POST /api/master/register — регистрация (имя, email, телефон, специализация)
10. GET/PUT /api/master/profile — получение и обновление профиля
11. CRUD услуг: POST/GET/PUT/DELETE /api/master/services
12. Загрузка фото: POST /api/master/avatar, POST /api/master/portfolio, POST /api/master/services/:id/image
13. Проверка лимитов в middleware plan-check.js:
    - Free: максимум 5 активных услуг, 6 фото в портфолио
    - При попытке превысить -> HTTP 403 с сообщением «Перейдите на Pro для добавления»

### Этап 3: Подключение бота мастера
14. POST /api/master/bot — принять токен, проверить через Telegram API (getMe), сохранить
15. Шифрование токена: encrypt.js (AES-256-GCM), ключ из /etc/beauty-saas/encryption.key
16. Генерация ключа при первой установке: server/scripts/generate-key.sh
17. Multi-bot через grammy: bot-manager.js — подключение/отключение ботов при старте сервера
18. При подключении бота: setChatMenuButton -> URL Mini App с ?bot=BOT_USERNAME
19. /start обработчик: приветствие с именем мастера + кнопка «Открыть каталог»

### Этап 4: Mini App -> API
20. Переделать tg-app/app.js: вместо хардкода services/master -> fetch GET /api/catalog/:botUsername
21. Определение бота: Mini App берёт bot_username из URL-параметра ?bot=
22. POST /api/booking: сохранение в БД + уведомление мастеру через бота
23. Валидация initData на сервере (middleware validate-init-data.js)
24. Skeleton-экран при загрузке данных с API (пока данные не пришли)

### Этап 5: Бот-консультант + очередь сообщений
25. Установить Redis на VPS: `apt install redis-server`
26. Настроить BullMQ: server/src/utils/queue.js (3 очереди: broadcast, reminder, notification)
27. FAQ-движок: faq-engine.js — поиск по ключевым словам в таблице faq
28. Переадресация на мастера: если FAQ не нашёл ответ -> пересылает сообщение мастеру
29. Напоминания: cron каждые 5 мин проверяет bookings с reminder_sent=false, ставит задачу в очередь
30. Worker рассылок: берёт задачи из очереди, отправляет с лимитом 20 msg/sec на бота
31. Обработка 429 (Too Many Requests): автоматический retry с exponential backoff
32. Сбор отзывов: при статусе booking=completed -> бот спрашивает оценку через 2 часа

### Этап 6: Подписка и платежи
33. Интеграция ЮKassa: POST /api/payment/create -> redirect на страницу оплаты
34. Вебхук ЮKassa: POST /api/payment/webhook -> проверка подписи -> активация подписки
35. Интеграция Stripe (аналогично ЮKassa — для зарубежных мастеров)
36. Ручная активация: POST /api/payment/manual -> админ подтверждает -> обновление plan='pro'
37. Middleware plan-check.js: проверка plan + plan_expires_at на каждом запросе к pro-функциям
38. Cron: ежедневная проверка просроченных подписок -> downgrade до free

### Этап 7: Админ-панель мастера
39. Веб-страница admin/index.html: авторизация через Telegram Login Widget
40. Разделы: профиль, услуги (CRUD), портфолио (загрузка фото), заявки, клиентская база (pro)
41. Настройки (pro): загрузка логотипа, смена названия в шапке, выбор цветовой темы
42. Рассылки (pro): форма текст + фото -> POST /api/master/broadcast -> очередь BullMQ
43. Статистика: записей за месяц, новых клиентов, конверсия (открыл каталог -> записался)

### Этап 8: Админ-панель платформы (для тебя)
44. Отдельная веб-страница (защищена по ADMIN_TELEGRAM_IDS)
45. Список всех мастеров: имя, тариф, количество клиентов, дата регистрации
46. Ручная активация/деактивация подписки
47. Общая статистика: мастеров, клиентов, записей, доход
48. Список платежей: кто, когда, сколько, статус
49. Мониторинг: потребление RAM/CPU, количество активных ботов, размер очереди BullMQ

---

## 11. Переменные окружения (server/.env)

```
# Supabase
SUPABASE_URL=https://gfylphystvksjlfwqnbp.supabase.co
SUPABASE_ANON_KEY=sb_publishable_HGVrHJPcisV2HQlDvsZkBA_AwNPG2_c
SUPABASE_SERVICE_KEY=xxx           # НЕ коммитить! Взять из Supabase Dashboard -> Settings -> API
DATABASE_URL=postgresql://xxx       # Взять из Supabase Dashboard -> Settings -> Database

# JWT
JWT_SECRET=xxx

# Платежи
YUKASSA_SHOP_ID=xxx
YUKASSA_SECRET_KEY=xxx
STRIPE_SECRET_KEY=xxx

# Шифрование (путь к файлу ключа, сам ключ НЕ в .env!)
ENCRYPTION_KEY_PATH=/etc/beauty-saas/encryption.key

# Redis (для BullMQ — очереди рассылок/напоминаний)
REDIS_URL=redis://127.0.0.1:6379

# Сервер
PORT=3000
NODE_ENV=production
APP_URL=https://app.example.com

# Лимиты
MAX_MASTERS=50

# Админ
ADMIN_TELEGRAM_IDS=123456789
```

---

## 12. Резервное копирование

### Стратегия бэкапов

| Что | Как | Частота | Где хранить |
|-----|-----|---------|-------------|
| База данных (PostgreSQL) | `pg_dump` через cron-скрипт на VPS | Каждый день в 03:00 | Отдельная папка на VPS + копия в Supabase Storage (бакет `backups`) |
| Фото (Supabase Storage) | Supabase Storage API -> скачать все файлы | Раз в неделю (воскресенье 03:00) | Отдельная папка на VPS |
| .env и конфигурация | Ручное копирование при изменении | При каждом изменении | Защищённое место вне VPS (пароль-менеджер) |

### Реализация

**Скрипт `server/scripts/backup.sh`:**
```bash
#!/bin/bash
# Ежедневный бэкап PostgreSQL
DATE=$(date +%Y-%m-%d_%H-%M)
BACKUP_DIR=/home/backups/beauty-saas
mkdir -p $BACKUP_DIR

# Дамп базы
pg_dump $DATABASE_URL > $BACKUP_DIR/db_$DATE.sql

# Сжатие
gzip $BACKUP_DIR/db_$DATE.sql

# Удаление бэкапов старше 30 дней
find $BACKUP_DIR -name "*.sql.gz" -mtime +30 -delete

# Загрузка в Supabase Storage (через curl)
curl -X POST "$SUPABASE_URL/storage/v1/object/backups/db_$DATE.sql.gz" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/gzip" \
  --data-binary @$BACKUP_DIR/db_$DATE.sql.gz
```

**Cron на VPS:**
```
0 3 * * * /home/server/scripts/backup.sh >> /home/logs/backup.log 2>&1
```

**Восстановление:**
```bash
gunzip db_2026-03-14_03-00.sql.gz
psql $DATABASE_URL < db_2026-03-14_03-00.sql
```

### Проверка бэкапов
- Раз в месяц: вручную скачать последний бэкап и проверить, что он восстанавливается
- Настроить алерт: если файл бэкапа не появился за день — отправить уведомление админу в Telegram

---

## 13. Безопасность

| Угроза | Защита |
|--------|--------|
| Подделка данных из Mini App | Валидация initData (подпись Telegram) |
| Чужие данные мастера | Row Level Security + JWT с master_id |
| Утечка bot_token | Шифрование AES-256-GCM (см. раздел 13.1) |
| SQL-инъекции | Prisma ORM (параметризованные запросы) |
| XSS | Экранирование в шаблонах, CSP-заголовки |
| DDoS | Rate limiting на Fastify |
| Подделка платежей | Проверка подписи вебхука ЮKassa/Stripe |
| Потеря доступа мастером | Email как резервный контакт. Процедура: мастер пишет на support-email -> подтверждение через email -> ручная привязка нового Telegram ID админом |

### 13.1 Шифрование bot_token — детальная реализация

**Проблема:** bot_token мастера — это ключ доступа к его боту. Если утечёт, злоумышленник может отправлять сообщения от имени бота.

**Решение: AES-256-GCM с разделением ключей**

```
Уровень 1 (MVP — Этап 3):
- Алгоритм: AES-256-GCM (authenticated encryption — защита от чтения и подмены)
- Ключ шифрования: 32 байта, генерируется через crypto.randomBytes(32)
- Для каждого токена: уникальный IV (initialization vector) 12 байт
- Формат хранения в БД: base64(IV + authTag + encrypted)
- Реализация: встроенный модуль Node.js `crypto` (0 зависимостей)
```

**Файл `server/src/utils/encrypt.js`:**
```javascript
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function encrypt(text, key) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(key, 'hex'), iv);
    let encrypted = cipher.update(text, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decrypt(encryptedBase64, key) {
    const data = Buffer.from(encryptedBase64, 'base64');
    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(key, 'hex'), iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
```

**Где хранить ключ шифрования (ВАЖНО — не в .env!):**
1. На VPS создать файл `/etc/beauty-saas/encryption.key` с правами `chmod 600`
2. Сервер при старте читает ключ из этого файла
3. Если файл не найден — сервер не стартует (fail-safe)
4. В `.env` указать только путь: `ENCRYPTION_KEY_PATH=/etc/beauty-saas/encryption.key`

**Генерация ключа (один раз при первой установке):**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > /etc/beauty-saas/encryption.key
chmod 600 /etc/beauty-saas/encryption.key
```

**Масштабирование (100+ мастеров):**
- Вынести ключи в HashiCorp Vault или аналог
- Ротация ключей: перешифровать все токены новым ключом без даунтайма
- Скрипт ротации: `server/scripts/rotate-keys.js`

---

## 14. Очередь сообщений (BullMQ)

### Зачем нужна очередь

Telegram ограничивает отправку сообщений: ~30 msg/sec на бота (мы ставим лимит 20 msg/sec для запаса). Без очереди:
- 50 мастеров запускают рассылку одновременно -> Telegram блокирует ботов (429 Too Many Requests)
- Напоминания на одно и то же время -> всплеск нагрузки

### Архитектура

```
Мастер нажал «Отправить рассылку» (админ-панель)
    |
    v
POST /api/master/broadcast -> сервер создаёт запись в таблице broadcasts
    |
    v
Сервер ставит N задач в очередь BullMQ (по одной на каждого клиента)
    |
    v
Worker (отдельный процесс или тот же сервер) берёт задачи из очереди
    |
    v
Отправляет сообщения с лимитом 20/сек на бота
    |
    v
Если Telegram вернул 429 -> задача возвращается в очередь с задержкой (retry)
    |
    v
После отправки всех сообщений -> обновить broadcasts.recipients_count
```

### Типы задач в очереди

| Очередь | Что отправляет | Приоритет | Лимит |
|---------|---------------|-----------|-------|
| `broadcast:{botUsername}` | Рассылки акций/новостей | Низкий | 20 msg/sec на бота |
| `reminder:{botUsername}` | Напоминания о записи | Высокий | 20 msg/sec на бота |
| `notification:{botUsername}` | Уведомления мастеру о новых заявках | Критический | Мгновенно (без лимита, это 1 сообщение) |

### Зависимости

- **BullMQ** — библиотека очередей для Node.js
- **Redis** — хранилище очередей (установить на VPS: `apt install redis-server`)
- Redis занимает ~5 MB RAM, справится с миллионами задач

### Когда внедрять

Этап 5 (бот-консультант). До этого этапа рассылок и напоминаний нет — очередь не нужна.

---

## 15. Главное правило архитектуры

> **Один сервер. Много мастеров. Каждый видит только своё.**
>
> Вся изоляция данных строится на `master_id`. Каждый запрос от клиента проходит через `bot_username` -> `master_id`. Каждый запрос от мастера проходит через JWT -> `master_id`. Никто не видит чужих данных.
