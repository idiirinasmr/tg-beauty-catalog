# Telegram Mini App — Каталог услуг бьюти-мастера

## Структура проекта

```
tg-beauty-catalog/
├── CLAUDE.md           ← Этот файл: документация проекта
├── research.md         ← Исследование ниши и экспертная оценка
├── brief.md            ← Детальный план: экраны, элементы, переходы
└── tg-app/             ← Telegram Mini App (фронтенд)
    ├── index.html      ← Точка входа. Все 4 экрана в одном файле
    ├── style.css       ← Стили. CSS-переменные Telegram для тем
    ├── app.js          ← Логика: навигация, MainButton, sendData
    └── img/            ← Папка для фото услуг (пока пустая)
```

## Файлы и за что отвечают

### tg-app/index.html
Все 4 экрана приложения как div-секции с классом `.screen`:
- `#screen-catalog` — главный экран, сетка карточек услуг
- `#screen-detail` — детали услуги (фото, описание, цена)
- `#screen-confirm` — подтверждение записи (сводка)
- `#screen-success` — экран успеха (анимированная галочка)

### tg-app/style.css
Стили используют CSS-переменные Telegram (`--tg-theme-*`).
Автоматическая поддержка светлой и тёмной темы.
Адаптация под экраны 320–430px.

### tg-app/app.js
Вся логика приложения:
- **Массив `services`** (строка ~30) — данные об услугах. **Здесь менять услуги, цены, описания.**
- **Объект `master`** (строка ~20) — имя и специализация мастера. **Здесь менять данные мастера.**
- **`showScreen()`** — переключение экранов (show/hide div)
- **`updateTelegramButtons()`** — настройка MainButton/BackButton для каждого экрана
- **`sendBookingData()`** — отправка данных в бота через `sendData()`
- **`renderCatalog()`** — генерация карточек из массива `services`

## Навигация между экранами

```
[Каталог] ──(нажатие на карточку)──→ [Детали]
                                        │
                              [BackButton] ←──┘
                                        │
                    [MainButton «Записаться»] ──→ [Подтверждение]
                                                      │
                                        [BackButton] ←──┘
                                                      │
                              [MainButton «Подтвердить запись»]
                                                      │
                                              sendData() → бот
                                                      │
                                                  [Успех]
                                                      │
                                        [MainButton «Закрыть»]
                                                      │
                                                  close()
```

## Где менять данные

### Услуги
Файл: `tg-app/app.js`, массив `services` (~строка 30).
Каждая услуга:
```javascript
{
    id: 1,              // уникальный ID
    name: 'Маникюр',    // название
    description: '...',  // описание (2-4 предложения)
    price: 1500,         // цена в рублях (число)
    duration: 60,        // длительность в минутах
    emoji: '💅'          // эмодзи для карточки (пока нет фото)
}
```

### Мастер
Файл: `tg-app/app.js`, объект `master` (~строка 20).
А также в `index.html` — тексты на экранах подтверждения и успеха.

### Фото
Заменить эмодзи на реальные фото:
1. Положить фото в `tg-app/img/`
2. В массиве `services` добавить поле `image: 'img/manicure.jpg'`
3. В `renderCatalog()` и `fillDetailScreen()` — заменить emoji на `<img>`

## Как запустить

### Локально (для тестирования)
```bash
cd tg-app
python -m http.server 8080
# или
npx serve .
```
Открыть http://localhost:8080 в браузере.

### В Telegram (продакшен)
1. Захостить `tg-app/` на GitHub Pages / Vercel / Netlify (нужен HTTPS)
2. Создать бота через @BotFather
3. Настроить Menu Button → URL Mini App
4. Написать бота (bot.py), который обрабатывает `web_app_data`

## Технические детали

- **Без фреймворков** — чистый HTML + CSS + JS
- **Telegram Web App SDK** — подключается через `<script>` в index.html
- **Переключение экранов** — show/hide div (не SPA-роутер)
- **Анимации** — CSS transitions 250ms (opacity + translateY)
- **Тап-зоны** — минимум 44px
- **Шрифт** — системный (-apple-system, Segoe UI, Roboto)
