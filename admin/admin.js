/* ============================================
   Панель мастера — логика
   Вход: Telegram Login Widget (браузер) или initData (Mini App в боте мастера).
   Навигация: #hash (#bookings, #services, ...). События — через data-action.
   ============================================ */

const tg = window.Telegram?.WebApp;
const params = new URLSearchParams(location.search);
const TOKEN_KEY = 'beauty_master_token';

const state = {
    token: null,
    profile: null,
    sub: null,
    newBookings: 0,
    bookingsFilter: 'new',
    accent: null
};

// ---------- Утилиты ----------

const $ = sel => document.querySelector(sel);

function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function icon(name, cls = '') {
    return `<svg class="i ${cls}"><use href="icons.svg#${name}"/></svg>`;
}

function rub(n) {
    return Number(n).toLocaleString('ru-RU') + ' ₽';
}

function dateTime(iso) {
    return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

function dateOnly(iso) {
    return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function initials(name) {
    return String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
}

function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
}

/** Значение для <input type="datetime-local"> в локальном времени */
function toLocalInput(date) {
    const d = new Date(date);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
}

let toastTimer;
function toast(message, isError = false) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.toggle('error', isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
    try { tg?.HapticFeedback?.notificationOccurred(isError ? 'error' : 'success'); } catch (e) {}
}

// ---------- API ----------

class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
}

async function api(path, { method = 'GET', body, form } = {}) {
    const headers = {};
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    if (body) headers['Content-Type'] = 'application/json';
    let res;
    try {
        res = await fetch(path, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
    } catch (e) {
        throw new ApiError('Нет соединения с сервером', 0);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || 'Что-то пошло не так', res.status);
    return data;
}

function upload(path, file, extra = {}) {
    const form = new FormData();
    Object.entries(extra).forEach(([k, v]) => form.append(k, v));
    form.append('file', file);
    return api(path, { method: 'POST', form });
}

/** Обёртка для действий: блокирует кнопку, показывает ошибку тостом */
async function withBusy(button, fn) {
    if (button) button.disabled = true;
    try {
        return await fn();
    } catch (e) {
        toast(e.message, true);
        if (e.status === 401) logout();
    } finally {
        if (button) button.disabled = false;
    }
}

// ---------- Вход ----------

function showView(name) {
    ['boot', 'login', 'register', 'app'].forEach(v => { $('#view-' + v).hidden = v !== name; });
}

// Токен режима настройки (владелец заполняет каталог за мастера) живёт только в своей
// вкладке: две вкладки разных мастеров не перепутаются, собственная сессия не затирается.
const IMPERSONATE_KEY = 'beauty_impersonate_token';

function saveToken(token) {
    state.token = token;
    try {
        if (isImpersonating()) sessionStorage.setItem(IMPERSONATE_KEY, token);
        else localStorage.setItem(TOKEN_KEY, token);
    } catch (e) {}
}

/** Данные из JWT (без проверки подписи — только для отображения) */
function tokenClaims() {
    try {
        return JSON.parse(atob(state.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    } catch (e) {
        return {};
    }
}

function isImpersonating() {
    return state.token && tokenClaims().src === 'impersonate';
}

let configPromise;
function loadConfig() {
    configPromise ||= api('/api/auth/config').catch(() => ({}));
    return configPromise;
}

/** Предложение «Настроим под ключ» — ссылка на Telegram владельца платформы */
function turnkeyHint(cfg) {
    return `<a class="turnkey-hint" href="https://t.me/${encodeURIComponent(cfg.supportTelegram)}" target="_blank" rel="noopener">
        ${icon('sparkles', 'sm')}<span>Некогда разбираться? <strong>Настроим всё за вас</strong>, ${cfg.turnkeyPrice ? 'за ' + rub(cfg.turnkeyPrice) : 'стоимость обсуждается'} — напишите нам</span></a>`;
}

/** Показать предложение на экранах входа и регистрации */
async function showTurnkeyHints() {
    const cfg = await loadConfig();
    if (!cfg.supportTelegram) return;
    document.querySelectorAll('.turnkey-slot').forEach(slot => { slot.innerHTML = turnkeyHint(cfg); });
}

function logout() {
    const wasImpersonating = isImpersonating();
    state.token = null;
    if (wasImpersonating) {
        try { sessionStorage.removeItem(IMPERSONATE_KEY); } catch (e) {}
        window.close(); // вкладка открыта из панели платформы
        location.href = '/platform/';
        return;
    }
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    if (tg?.initData) {
        tg.close();
        return;
    }
    showLogin();
}

async function authenticate() {
    // 0) Режим настройки из панели платформы: токен приходит во фрагменте #as=...
    if (location.hash.startsWith('#as=')) {
        const token = decodeURIComponent(location.hash.slice(4));
        history.replaceState(null, '', location.pathname + location.search + '#home');
        return token;
    }
    try {
        const impersonated = sessionStorage.getItem(IMPERSONATE_KEY);
        if (impersonated) return impersonated;
    } catch (e) {}
    // 1) Возврат с Telegram Login Widget: ?id=...&hash=...
    if (params.get('hash') && params.get('id')) {
        const data = {};
        ['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date', 'hash']
            .forEach(k => { if (params.has(k)) data[k] = params.get(k); });
        history.replaceState(null, '', location.pathname + location.hash);
        return (await api('/api/auth/telegram', { method: 'POST', body: data })).token;
    }
    // 2) Mini App внутри Telegram (бот мастера или бот платформы)
    if (tg?.initData) {
        const body = { initData: tg.initData };
        if (params.get('bot')) body.botUsername = params.get('bot');
        return (await api('/api/auth/webapp', { method: 'POST', body })).token;
    }
    // 3) Сохранённая сессия
    try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
}

async function showLogin() {
    showView('login');
    const cfg = await loadConfig();
    showTurnkeyHints();
    const box = $('#login-widget');
    box.innerHTML = '';
    if (cfg.loginBotUsername) {
        // Режим redirect (data-auth-url) — без inline-колбэков, совместим с CSP
        const s = document.createElement('script');
        s.async = true;
        s.src = 'https://telegram.org/js/telegram-widget.js?22';
        s.dataset.telegramLogin = cfg.loginBotUsername;
        s.dataset.size = 'large';
        s.dataset.radius = '12';
        s.dataset.authUrl = location.origin + location.pathname;
        s.dataset.requestAccess = 'write';
        box.appendChild(s);
    } else {
        $('#login-hint').textContent = 'Вход через Telegram ещё не настроен на сервере (ADMIN_BOT_USERNAME).';
    }
    $('#dev-login').hidden = !cfg.devLogin;
}

$('#dev-login').addEventListener('submit', async e => {
    e.preventDefault();
    const id = new FormData(e.target).get('id');
    await withBusy(e.submitter, async () => {
        const res = await api('/api/auth/dev', { method: 'POST', body: { id: String(id), first_name: 'Тест' } });
        saveToken(res.token);
        await start();
    });
});

$('#register-form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = Object.fromEntries([...new FormData(e.target)].filter(([, v]) => v !== ''));
    await withBusy(e.submitter, async () => {
        const res = await api('/api/master/register', { method: 'POST', body });
        saveToken(res.token);
        state.profile = res.profile;
        location.hash = '#bot';
        await enterApp();
        toast('Каталог создан! Осталось подключить бота');
    });
});

async function start() {
    try {
        state.profile = await api('/api/master/profile');
        await enterApp();
    } catch (e) {
        if (e.status === 403) {
            showView('register');
            showTurnkeyHints();
            const name = tg?.initDataUnsafe?.user?.first_name;
            if (name) $('#register-form [name=name]').value = name;
        } else if (e.status === 401 || !state.token) {
            logout();
        } else {
            showLogin();
            toast(e.message, true);
        }
    }
}

// ---------- Оболочка и навигация ----------

const ROUTES = {
    home: { title: 'Главная', icon: 'home', tab: true },
    bookings: { title: 'Заявки', icon: 'calendar', tab: true },
    services: { title: 'Услуги', icon: 'sparkles', tab: true },
    profile: { title: 'Профиль', icon: 'user', tab: true },
    more: { title: 'Ещё', icon: 'grid', tab: true, mobileOnly: true },
    bot: { title: 'Бот', icon: 'bot' },
    faq: { title: 'Вопросы бота', icon: 'message' },
    reviews: { title: 'Отзывы', icon: 'star' },
    clients: { title: 'Клиенты', icon: 'users', pro: true },
    broadcast: { title: 'Рассылки', icon: 'send', pro: true },
    design: { title: 'Оформление', icon: 'palette', pro: true },
    plan: { title: 'Тариф', icon: 'crown' }
};

function currentRoute() {
    const r = location.hash.slice(1);
    return ROUTES[r] ? r : 'home';
}

function renderChrome() {
    const p = state.profile;
    $('#top-name').textContent = p.headerName && p.isPro ? p.headerName : p.name;
    $('#top-plan').innerHTML = p.isPro
        ? `<span class="badge pro">Pro до ${esc(dateOnly(p.planExpiresAt))}</span>`
        : '<span class="badge free">Free</span>';
    $('#top-avatar').innerHTML = p.avatarUrl ? `<img src="${esc(p.avatarUrl)}" alt="">` : esc(initials(p.name));
    const catalogLink = $('#top-catalog');
    catalogLink.hidden = !p.botUsername;
    if (p.botUsername) catalogLink.href = 'https://t.me/' + encodeURIComponent(p.botUsername);

    const route = currentRoute();
    const dot = n => n ? `<span class="dot">${n}</span>` : '';
    $('#tabbar').innerHTML = Object.entries(ROUTES).filter(([, r]) => r.tab).map(([key, r]) => `
        <a class="tab ${key === route || (key === 'more' && !ROUTES[route].tab) ? 'active' : ''}" href="#${key}">
            ${icon(r.icon)}<span>${r.title}</span>${key === 'bookings' ? dot(state.newBookings) : ''}
        </a>`).join('');
    $('#nav').innerHTML = Object.entries(ROUTES).filter(([, r]) => !r.mobileOnly).map(([key, r], i) => `
        ${i === 4 ? '<div class="nav-sep"></div>' : ''}
        <a class="nav-item ${key === route ? 'active' : ''}" href="#${key}">
            ${icon(r.icon)}<span>${r.title}</span>
            ${key === 'bookings' ? dot(state.newBookings) : ''}
            ${r.pro && !p.isPro ? icon('lock', 'sm') : ''}
        </a>`).join('');
}

async function refreshCounters() {
    const list = await api('/api/master/bookings?status=new').catch(() => []);
    state.newBookings = list.length;
}

async function enterApp() {
    showView('app');
    $('#impersonate-bar').hidden = !isImpersonating();
    $('#impersonate-name').textContent = state.profile.name;
    await refreshCounters();
    await render();
}

async function render() {
    renderChrome();
    const route = currentRoute();
    const main = $('#main');
    main.innerHTML = '';
    try {
        main.innerHTML = await VIEWS[route]();
        main.classList.remove('stagger');
        void main.offsetWidth; // перезапуск анимации
        main.classList.add('stagger');
    } catch (e) {
        if (e.status === 401) return logout();
        main.innerHTML = `<div class="card empty">${icon('help')}<strong>Не удалось загрузить</strong><span>${esc(e.message)}</span></div>`;
    }
    window.scrollTo({ top: 0 });
}

window.addEventListener('hashchange', () => { if (state.profile) render(); });

function pageHead(title, sub = '', action = '') {
    return `<div class="page-head"><div><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div>${action}</div>`;
}

function proLock(text) {
    return `<div class="pro-lock">${icon('crown')}
        <div class="pro-lock-text"><strong>Доступно на Pro</strong><span>${text}</span></div>
        <a class="btn btn-gold btn-sm" href="#plan">Подключить</a></div>`;
}

// ---------- Разделы ----------

const VIEWS = {};

VIEWS.home = async () => {
    const p = state.profile;
    const [stats, services, portfolio, faq, cfg] = await Promise.all([
        api('/api/master/stats'), api('/api/master/services'), api('/api/master/portfolio'), api('/api/master/faq'),
        loadConfig()
    ]);
    const steps = [
        { done: p.botConnected, text: 'Подключить своего Telegram-бота', href: '#bot' },
        { done: services.length > 0, text: 'Добавить услуги с ценами', href: '#services' },
        { done: Boolean(p.avatarUrl), text: 'Загрузить фото профиля', href: '#profile' },
        { done: portfolio.length > 0, text: 'Показать работы в портфолио', href: '#profile' },
        { done: faq.length > 0, text: 'Научить бота отвечать на вопросы', href: '#faq' },
        { done: stats.bookingsTotal > 0, text: 'Получить первую заявку', href: '#bookings' }
    ];
    const doneCount = steps.filter(s => s.done).length;
    const hour = new Date().getHours();
    const hello = hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';

    return `
        ${pageHead(`${hello}, <em>${esc(p.name.split(' ')[0])}</em>`, state.newBookings
            ? `У вас ${state.newBookings} ${plural(state.newBookings, 'новая заявка', 'новые заявки', 'новых заявок')} — <a href="#bookings">посмотреть</a>`
            : 'Новых заявок нет — самое время обновить портфолио')}
        <div class="stats">
            <div class="stat accent"><div class="stat-value">${stats.bookingsMonth}</div><div class="stat-label">заявок за 30 дней</div></div>
            <div class="stat"><div class="stat-value">${stats.clientsTotal}</div><div class="stat-label">клиентов всего</div></div>
            <div class="stat"><div class="stat-value">${stats.views}</div><div class="stat-label">открытий каталога</div></div>
            <div class="stat"><div class="stat-value">${stats.conversion}%</div><div class="stat-label">открыли → записались</div></div>
        </div>
        ${doneCount < steps.length ? `
        <div class="card">
            <div class="card-head"><h3>${icon('sparkles')} Запуск каталога</h3><span class="muted small">${doneCount} из ${steps.length}</span></div>
            <div class="progress"><div style="width:${Math.round(doneCount / steps.length * 100)}%"></div></div>
            <div class="checklist">
                ${steps.map(s => `<a class="check-item ${s.done ? 'done' : ''}" href="${s.href}">
                    <span class="check-box">${icon('check', 'sm')}</span><span class="check-text">${s.text}</span>
                    ${s.done ? '' : icon('chevron', 'sm')}</a>`).join('')}
            </div>
            ${cfg.supportTelegram && !isImpersonating() ? turnkeyHint(cfg) : ''}
        </div>` : ''}
        ${p.botUsername ? `
        <div class="card">
            <div class="card-head"><h3>${icon('external')} Ссылка для клиентов</h3></div>
            <p class="muted small">Добавьте её в шапку Instagram, на визитки и в статус WhatsApp — клиенты сразу попадут в ваш каталог.</p>
            <div class="row" style="margin-top:10px">
                <input class="input" readonly value="https://t.me/${esc(p.botUsername)}" id="share-link">
                <button class="btn btn-outline" data-action="copy-link">Копировать</button>
            </div>
        </div>` : ''}
        ${!p.isPro ? proLock('Напоминания клиентам, рассылки акций, клиентская база и своё оформление — 500 ₽ в месяц.') : ''}
    `;
};

// --- Заявки ---

const STATUS = {
    new: 'Новая', confirmed: 'Подтверждена', completed: 'Завершена', cancelled: 'Отменена'
};

VIEWS.bookings = async () => {
    const filter = state.bookingsFilter;
    const list = await api('/api/master/bookings' + (filter === 'all' ? '' : '?status=' + filter));
    state.bookingsCache = list;
    const segments = [['new', 'Новые'], ['confirmed', 'Подтверждённые'], ['completed', 'Завершённые'], ['cancelled', 'Отменённые'], ['all', 'Все']];

    return `
        ${pageHead('Заявки', 'Подтвердите время — бот сам напишет клиенту')}
        <div class="segments">${segments.map(([k, t]) =>
            `<button class="segment ${k === filter ? 'active' : ''}" data-action="filter-bookings" data-filter="${k}">${t}${k === 'new' && state.newBookings ? ` · ${state.newBookings}` : ''}</button>`).join('')}
        </div>
        ${list.length ? list.map(bookingCard).join('') : `
            <div class="card empty">${icon('calendar')}<strong>Здесь пусто</strong>
            <span>${filter === 'new' ? 'Новые заявки из каталога появятся здесь и придут вам в бота.' : 'Заявок с таким статусом нет.'}</span></div>`}
    `;
};

function bookingCard(b) {
    const contact = b.clientUsername
        ? `<a href="https://t.me/${esc(b.clientUsername)}" target="_blank" rel="noopener">@${esc(b.clientUsername)}</a>`
        : `<a href="tg://user?id=${esc(b.clientTelegramId)}">написать</a>`;
    let actions = '';
    if (b.status === 'new') {
        actions = `<button class="btn btn-primary" data-action="confirm-booking" data-id="${b.id}">${icon('check')}Подтвердить</button>
                   <button class="btn btn-danger" data-action="set-status" data-status="cancelled" data-id="${b.id}">Отклонить</button>`;
    } else if (b.status === 'confirmed') {
        actions = `<button class="btn btn-primary" data-action="set-status" data-status="completed" data-id="${b.id}">Визит состоялся</button>
                   <button class="btn btn-outline" data-action="confirm-booking" data-id="${b.id}">Перенести</button>
                   <button class="btn btn-danger btn-sm" data-action="set-status" data-status="cancelled" data-id="${b.id}">Отменить</button>`;
    }
    return `
        <div class="card booking">
            <div class="booking-top">
                <div>
                    <div class="list-title">${esc(b.serviceName)}</div>
                    <div class="booking-meta"><span>${icon('user', 'sm')} ${esc(b.clientName)} · ${contact}</span><span>${rub(b.servicePrice)}</span></div>
                </div>
                <span class="badge ${b.status}">${STATUS[b.status]}</span>
            </div>
            ${b.appointmentAt ? `<div class="booking-when">${icon('clock', 'sm')} ${esc(dateTime(b.appointmentAt))}</div>` : ''}
            ${b.comment ? `<div class="booking-comment">${esc(b.comment)}</div>` : ''}
            <div class="booking-meta"><span>Заявка от ${esc(dateTime(b.createdAt))}</span></div>
            ${actions ? `<div class="booking-actions">${actions}</div>` : ''}
        </div>`;
}

// --- Услуги ---

VIEWS.services = async () => {
    const [services, sub] = await Promise.all([api('/api/master/services'), loadSub()]);
    state.servicesCache = services;
    const active = services.filter(s => s.isActive).length;
    const limit = sub.limits.services;
    const atLimit = !state.profile.isPro && active >= limit;

    return `
        ${pageHead('Услуги', state.profile.isPro ? `${active} в каталоге` : `${active} из ${limit} на тарифе Free`,
            `<button class="btn btn-primary" data-action="edit-service">${icon('plus')}Добавить</button>`)}
        ${atLimit ? proLock(active > limit
            ? `Включено ${active} услуг, но на Free клиенты видят только первые ${limit}. Остальные сохранены — вернутся с Pro.`
            : `На Free в каталоге до ${limit} услуг. С Pro — без ограничений.`) : ''}
        <div class="card">
            ${services.length ? `<div class="list">${services.map(s => `
                <div class="list-item ${s.isActive ? '' : 'inactive'}">
                    <div class="thumb">${s.imageUrl ? `<img src="${esc(s.imageUrl)}" alt="">` : esc(s.emoji)}</div>
                    <div class="list-main">
                        <div class="list-title">${esc(s.name)}</div>
                        <div class="list-sub">${s.duration} мин · <span class="price">${rub(s.price)}</span></div>
                    </div>
                    <label class="switch" title="Показывать в каталоге">
                        <input type="checkbox" data-action="toggle-service" data-id="${s.id}" ${s.isActive ? 'checked' : ''}
                            aria-label="Показывать «${esc(s.name)}» в каталоге"><span></span>
                    </label>
                    <div class="list-actions">
                        <button class="icon-btn" data-action="edit-service" data-id="${s.id}" aria-label="Изменить">${icon('pencil')}</button>
                    </div>
                </div>`).join('')}</div>` : `
                <div class="empty">${icon('sparkles')}<strong>Пока ни одной услуги</strong>
                <span>Добавьте то, что делаете чаще всего — с ценой и длительностью.</span>
                <button class="btn btn-primary" data-action="edit-service">${icon('plus')}Первая услуга</button></div>`}
        </div>`;
};

const EMOJIS = ['💅', '🦶', '✨', '🖌️', '💇‍♀️', '💆‍♀️', '👁️', '💄', '🧖‍♀️', '🪒', '🧴', '💎'];

function openServiceModal(service) {
    const s = service || { name: '', description: '', price: '', duration: 60, emoji: '💅' };
    openModal(`
        <form class="form" data-form="service" data-id="${service?.id || ''}">
            <div class="modal-head"><h3>${service ? 'Изменить услугу' : 'Новая услуга'}</h3>
                <button type="button" class="icon-btn" data-action="close-modal" aria-label="Закрыть">${icon('x')}</button></div>
            <label class="field"><span>Название *</span><input class="input" name="name" required maxlength="100" value="${esc(s.name)}" placeholder="Маникюр с покрытием"></label>
            <div class="grid-2">
                <label class="field"><span>Цена, ₽ *</span><input class="input" name="price" type="number" min="0" max="1000000" required value="${esc(s.price)}" inputmode="numeric"></label>
                <label class="field"><span>Длительность, мин</span><input class="input" name="duration" type="number" min="5" max="1440" step="5" value="${esc(s.duration)}" inputmode="numeric"></label>
            </div>
            <label class="field"><span>Описание</span><textarea class="textarea" name="description" maxlength="1000" placeholder="Что входит, сколько держится, для кого подходит">${esc(s.description)}</textarea></label>
            <div class="field"><span>Значок (если нет фото)</span>
                <div class="color-row">${EMOJIS.map(e => `<button type="button" class="segment ${e === s.emoji ? 'active' : ''}" data-action="pick-emoji" data-emoji="${e}">${e}</button>`).join('')}</div>
                <input type="hidden" name="emoji" value="${esc(s.emoji)}">
            </div>
            <label class="field"><span>Фото услуги</span>
                <input class="input" type="file" name="image" accept="image/jpeg,image/png,image/webp">
                <span class="hint">JPG, PNG или WEBP до 5 МБ. Квадратное фото смотрится лучше всего.</span></label>
            <button class="btn btn-primary btn-block" type="submit">${service ? 'Сохранить' : 'Добавить услугу'}</button>
            ${service ? `<button type="button" class="btn btn-danger btn-block" data-action="delete-service" data-id="${service.id}">${icon('trash')}Удалить услугу</button>` : ''}
        </form>`);
}

// --- Профиль и портфолио ---

VIEWS.profile = async () => {
    const p = state.profile;
    const [portfolio, sub] = await Promise.all([api('/api/master/portfolio'), loadSub()]);
    const limit = sub.limits.portfolio;
    const canAdd = p.isPro || portfolio.length < limit;

    return `
        ${pageHead('Профиль', 'Так вас видят клиенты в каталоге')}
        <div class="card">
            <div class="avatar-edit">
                <div class="avatar">${p.avatarUrl ? `<img src="${esc(p.avatarUrl)}" alt="">` : esc(initials(p.name))}</div>
                <label class="btn btn-outline">${icon('camera')}Сменить фото
                    <input class="file-input" type="file" accept="image/jpeg,image/png,image/webp" data-action="upload-avatar"></label>
            </div>
        </div>
        <form class="card form" data-form="profile">
            <label class="field"><span>Имя *</span><input class="input" name="name" required maxlength="100" value="${esc(p.name)}"></label>
            <label class="field"><span>Специализация</span><input class="input" name="specialty" maxlength="150" value="${esc(p.specialty)}" placeholder="Маникюр, педикюр · 5 лет"></label>
            <label class="field"><span>О себе</span><textarea class="textarea" name="about" maxlength="1000" placeholder="Пара предложений о подходе, материалах, опыте">${esc(p.about)}</textarea></label>
            <div class="grid-2">
                <label class="field"><span>Телефон</span><input class="input" name="phone" type="tel" maxlength="30" value="${esc(p.phone)}"></label>
                <label class="field"><span>Email</span><input class="input" name="email" type="email" maxlength="120" value="${esc(p.email)}"></label>
            </div>
            <label class="field"><span>Адрес</span><input class="input" name="address" maxlength="200" value="${esc(p.address)}"></label>
            <button class="btn btn-primary" type="submit">Сохранить</button>
        </form>
        <div class="card">
            <div class="card-head"><h3>${icon('image')} Мои работы</h3>
                <span class="muted small">${p.isPro ? portfolio.length : `${portfolio.length} из ${limit}`}</span></div>
            <div class="gallery">
                ${portfolio.map(item => `<div class="gallery-item"><img src="${esc(item.imageUrl)}" alt="" loading="lazy">
                    <button class="icon-btn" data-action="delete-photo" data-id="${item.id}" aria-label="Удалить фото">${icon('trash', 'sm')}</button></div>`).join('')}
                ${canAdd ? `<label class="upload-tile">${icon('plus')}Добавить
                    <input type="file" accept="image/jpeg,image/png,image/webp" data-action="upload-photo"></label>` : ''}
            </div>
            ${!canAdd ? `<div style="margin-top:12px">${proLock('На Free — до 6 фото. С Pro — без ограничений.')}</div>` : ''}
        </div>`;
};

// --- Бот ---

VIEWS.bot = async () => {
    const p = state.profile;
    const status = p.botConnected
        ? `<div class="bot-status ${p.botRunning ? '' : 'off'}">${icon('bot')}
            <div class="list-main"><div class="list-title">@${esc(p.botUsername)}</div>
            <div class="list-sub">${p.botRunning ? 'Работает: принимает заявки и отвечает клиентам' : 'Не отвечает — подключите токен заново'}</div></div>
            <a class="btn btn-outline btn-sm" href="https://t.me/${esc(p.botUsername)}" target="_blank" rel="noopener">Открыть</a></div>`
        : '';
    return `
        ${pageHead('Ваш бот', 'Через него клиенты открывают каталог, записываются и задают вопросы')}
        ${status ? `<div class="card">${status}</div>` : ''}
        <div class="card">
            <div class="card-head"><h3>${icon('help')} ${p.botConnected ? 'Подключить другого бота' : 'Как подключить — 2 минуты'}</h3></div>
            <div class="steps">
                <div class="step"><div>Откройте <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> в Telegram и отправьте <code>/newbot</code></div></div>
                <div class="step"><div>Придумайте название, например «Маникюр у Анны», и username, который заканчивается на <code>bot</code>: <code>anna_nails_bot</code></div></div>
                <div class="step"><div>BotFather пришлёт токен вида <code>123456:ABC-DEF…</code> — скопируйте его целиком и вставьте ниже</div></div>
            </div>
            <form class="form" data-form="bot" style="margin-top:16px">
                <label class="field"><span>Токен бота</span>
                    <input class="input" name="token" required autocomplete="off" spellcheck="false" placeholder="123456789:AAH…"></label>
                <button class="btn btn-primary" type="submit">${icon('bot')}Подключить бота</button>
                <p class="hint">Токен хранится в зашифрованном виде и никому не показывается.</p>
            </form>
        </div>
        ${p.botConnected ? `<button class="btn btn-danger" data-action="disconnect-bot">Отключить бота</button>` : ''}`;
};

// --- FAQ ---

VIEWS.faq = async () => {
    const [faq, sub] = await Promise.all([api('/api/master/faq'), loadSub()]);
    state.faqCache = faq;
    const limit = sub.limits.faq;
    const canAdd = state.profile.isPro || faq.length < limit;
    return `
        ${pageHead('Вопросы бота', 'Бот ответит сам, если в вопросе клиента есть ключевые слова. Не знает ответа — перешлёт вопрос вам.',
            canAdd ? `<button class="btn btn-primary" data-action="edit-faq">${icon('plus')}Добавить</button>` : '')}
        ${!canAdd ? proLock(`На Free — до ${limit} вопросов. С Pro — без ограничений.`) : ''}
        <div class="card">
            ${faq.length ? `<div class="list">${faq.map(f => `
                <div class="list-item">
                    <div class="list-main"><div class="list-title">${esc(f.question)}</div><div class="list-sub">${esc(f.answer)}</div></div>
                    <div class="list-actions"><button class="icon-btn" data-action="edit-faq" data-id="${f.id}" aria-label="Изменить">${icon('pencil')}</button></div>
                </div>`).join('')}</div>` : `
                <div class="empty">${icon('message')}<strong>Научите бота отвечать</strong>
                <span>Например: «цена, стоимость, сколько стоит» → «Маникюр с покрытием — 2 500 ₽, полный прайс в каталоге».</span>
                <button class="btn btn-primary" data-action="edit-faq">${icon('plus')}Первый вопрос</button></div>`}
        </div>`;
};

function openFaqModal(item) {
    const f = item || { question: '', answer: '' };
    openModal(`
        <form class="form" data-form="faq" data-id="${item?.id || ''}">
            <div class="modal-head"><h3>${item ? 'Изменить ответ' : 'Новый вопрос'}</h3>
                <button type="button" class="icon-btn" data-action="close-modal" aria-label="Закрыть">${icon('x')}</button></div>
            <label class="field"><span>Ключевые слова через запятую *</span>
                <input class="input" name="question" required maxlength="300" value="${esc(f.question)}" placeholder="адрес, где находитесь, как добраться">
                <span class="hint">Бот ищет эти слова в сообщении клиента, окончания не важны.</span></label>
            <label class="field"><span>Ответ бота *</span>
                <textarea class="textarea" name="answer" required maxlength="2000" placeholder="Я принимаю на Тверской, 15, офис 3. Вход со двора, домофон 3.">${esc(f.answer)}</textarea></label>
            <button class="btn btn-primary btn-block" type="submit">Сохранить</button>
            ${item ? `<button type="button" class="btn btn-danger btn-block" data-action="delete-faq" data-id="${item.id}">${icon('trash')}Удалить</button>` : ''}
        </form>`);
}

// --- Отзывы ---

VIEWS.reviews = async () => {
    const reviews = await api('/api/master/reviews');
    return `
        ${pageHead('Отзывы', 'Бот попросит оценку через 2 часа после визита. Скрытые отзывы не видны в каталоге.')}
        <div class="card">
            ${reviews.length ? `<div class="list">${reviews.map(r => `
                <div class="list-item">
                    <div class="list-main">
                        <div class="list-title">${esc(r.clientName)} <span class="stars">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span></div>
                        ${r.text ? `<div class="review-text">${esc(r.text)}</div>` : '<div class="list-sub">Без комментария</div>'}
                        <div class="list-sub">${esc(dateOnly(r.createdAt))}${r.isVisible ? '' : ' · скрыт'}</div>
                    </div>
                    <button class="icon-btn" data-action="toggle-review" data-id="${r.id}" data-visible="${r.isVisible}"
                        aria-label="${r.isVisible ? 'Скрыть' : 'Показать'}">${icon(r.isVisible ? 'eye' : 'eye-off')}</button>
                </div>`).join('')}</div>` : `
                <div class="empty">${icon('star')}<strong>Отзывов пока нет</strong><span>Отметьте визит как «состоялся» — бот сам попросит клиента оценить.</span></div>`}
        </div>`;
};

// --- Клиенты (Pro) ---

VIEWS.clients = async () => {
    if (!state.profile.isPro) {
        return pageHead('Клиенты') + proLock('Вся база: кто, когда пришёл впервые, сколько раз записывался — и прямая ссылка, чтобы написать.');
    }
    const clients = await api('/api/master/clients');
    return `
        ${pageHead('Клиенты', `${clients.length} ${plural(clients.length, 'человек', 'человека', 'человек')} писали вашему боту`)}
        <div class="card">
            ${clients.length ? `<div class="list">${clients.map(c => `
                <div class="list-item">
                    <div class="avatar sm">${esc(initials(c.firstName))}</div>
                    <div class="list-main">
                        <div class="list-title">${esc(c.firstName || 'Без имени')} ${c.username ? `<a class="small" href="https://t.me/${esc(c.username)}" target="_blank" rel="noopener">@${esc(c.username)}</a>` : ''}</div>
                        <div class="list-sub">с ${esc(dateOnly(c.firstVisitAt))} · ${c.bookingsCount} ${plural(c.bookingsCount, 'запись', 'записи', 'записей')}${c.isBlocked ? ' · заблокировал бота' : ''}</div>
                    </div>
                </div>`).join('')}</div>` : `<div class="empty">${icon('users')}<strong>Клиентов пока нет</strong></div>`}
        </div>`;
};

// --- Рассылки (Pro) ---

VIEWS.broadcast = async () => {
    if (!state.profile.isPro) {
        return pageHead('Рассылки') + proLock('Сообщите всем клиентам об окошках, акциях и новых услугах — одним сообщением от вашего бота.');
    }
    const history = await api('/api/master/broadcasts');
    return `
        ${pageHead('Рассылки', 'Сообщение придёт всем, кто писал вашему боту')}
        <form class="card form" data-form="broadcast">
            <label class="field"><span>Текст *</span>
                <textarea class="textarea" name="text" required maxlength="4000" placeholder="Освободилось окошко в субботу в 14:00 — запишитесь через каталог 💅"></textarea></label>
            <label class="field"><span>Фото (необязательно)</span>
                <input class="input" type="file" name="image" accept="image/jpeg,image/png,image/webp">
                <span class="hint">С фото текст — до ~1000 символов.</span></label>
            <button class="btn btn-primary" type="submit">${icon('send')}Отправить всем</button>
        </form>
        ${history.length ? `<div class="card"><div class="card-head"><h3>История</h3></div><div class="list">${history.map(b => `
            <div class="list-item">
                <div class="list-main"><div class="list-title">${esc(b.text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).slice(0, 120)}</div>
                <div class="list-sub">${esc(dateTime(b.createdAt))} · ${b.status === 'done' ? `доставлено ${b.recipientsCount} из ${b._count.recipients}` : 'отправляется…'}</div></div>
            </div>`).join('')}</div></div>` : ''}`;
};

// --- Оформление (Pro) ---

const ACCENTS = ['#C8674F', '#D4708F', '#9B6BC4', '#4F7CC8', '#3E9A7A', '#C89A3E', '#2B2B2B'];

VIEWS.design = async () => {
    const p = state.profile;
    if (!p.isPro) {
        return pageHead('Оформление') + proLock('Свой логотип, название салона в шапке, фирменный цвет и каталог без нашего логотипа.');
    }
    state.accent = p.theme?.accent || null;
    return `
        ${pageHead('Оформление', 'Как выглядит ваш каталог для клиентов')}
        <div class="card">
            <div class="card-head"><h3>${icon('image')} Логотип</h3></div>
            <div class="avatar-edit">
                ${p.logoUrl ? `<img src="${esc(p.logoUrl)}" alt="Логотип" style="max-height:56px;max-width:160px">` : '<span class="muted">Логотип не загружен</span>'}
                <label class="btn btn-outline">${icon('camera')}Загрузить
                    <input class="file-input" type="file" accept="image/png,image/jpeg,image/webp" data-action="upload-logo"></label>
            </div>
        </div>
        <form class="card form" data-form="header">
            <label class="field"><span>Название в шапке каталога</span>
                <input class="input" name="headerName" maxlength="60" value="${esc(p.headerName || '')}" placeholder="${esc(p.name)}">
                <span class="hint">Например, «Студия Nail Garden». Пусто — показываем ваше имя.</span></label>
            <button class="btn btn-primary" type="submit">Сохранить название</button>
        </form>
        <div class="card form">
            <div class="card-head"><h3>${icon('palette')} Фирменный цвет</h3></div>
            <div class="color-row">
                ${ACCENTS.map(c => `<button class="color-swatch ${state.accent === c ? 'active' : ''}" style="background:${c}" data-action="pick-accent" data-color="${c}" aria-label="Цвет ${c}"></button>`).join('')}
                <input type="color" class="color-swatch" data-action="custom-accent" value="${esc(state.accent || '#C8674F')}" aria-label="Свой цвет">
            </div>
            <div class="row">
                <button class="btn btn-primary" data-action="save-theme">Применить цвет</button>
                <button class="btn btn-ghost" data-action="reset-theme">Стандартный</button>
            </div>
            <div class="list-item">
                <div class="list-main"><div class="list-title">Без логотипа BeautyApp</div><div class="list-sub">Убрать «Сделано на BeautyApp» внизу каталога</div></div>
                <label class="switch"><input type="checkbox" data-action="toggle-whitelabel" ${p.whiteLabel ? 'checked' : ''} aria-label="White label"><span></span></label>
            </div>
        </div>`;
};

// --- Тариф ---

async function loadSub() {
    state.sub = await api('/api/master/subscription');
    return state.sub;
}

VIEWS.plan = async () => {
    const s = await loadSub();
    const pro = s.plan === 'pro';
    const usage = (label, used, limit) => `
        <div><div class="usage-row"><span>${label}</span><span class="muted">${used}${pro ? '' : ' из ' + limit}</span></div>
        ${pro ? '' : `<div class="usage-bar"><div style="width:${Math.min(100, Math.round(used / limit * 100))}%"></div></div>`}</div>`;
    const li = text => `<li>${icon('check')}<span>${text}</span></li>`;

    return `
        ${pageHead('Тариф', pro ? `Pro активен до ${esc(dateOnly(s.expiresAt))}` : 'Сейчас — Free')}
        <div class="card usage">
            ${usage('Услуги в каталоге', s.usage.services, s.limits.services)}
            ${usage('Фото работ', s.usage.portfolio, s.limits.portfolio)}
            ${usage('Вопросы бота', s.usage.faq, s.limits.faq)}
        </div>
        <div class="plans">
            <div class="plan">
                <h3>Free</h3>
                <div class="plan-price">0 ₽ <small>навсегда</small></div>
                <ul>${li('Свой бот и каталог')}${li('До 5 услуг и 6 фото')}${li('Заявки без ограничений')}${li('До 10 ответов бота')}</ul>
            </div>
            <div class="plan featured">
                <span class="plan-tag">Для тех, кто растёт</span>
                <h3>Pro</h3>
                <div class="plan-price">${s.price} ₽ <small>/ ${s.periodDays} дней</small></div>
                <ul>${li('Безлимит услуг, фото и ответов')}${li('Напоминания клиентам за 24 и 2 часа')}${li('Рассылки акций и окошек')}${li('Клиентская база')}${li('Свой логотип, цвет и название')}</ul>
                ${s.yukassa ? `<button class="btn btn-gold btn-block" data-action="pay-online">${pro ? 'Продлить' : 'Подключить'} картой</button>` : ''}
                <button class="btn btn-outline btn-block" style="margin-top:8px" data-action="pay-manual">Оплатить переводом</button>
                ${s.pendingManual ? '<p class="hint" style="margin-top:8px">Ждём подтверждения вашего перевода — обычно в течение дня.</p>' : ''}
            </div>
        </div>`;
};

// --- «Ещё» (телефон) ---

VIEWS.more = async () => {
    const tile = (route, sub) => `<a class="more-tile" href="#${route}">${icon(ROUTES[route].icon)}
        <span>${ROUTES[route].title} ${ROUTES[route].pro && !state.profile.isPro ? icon('lock', 'sm') : ''}</span><small>${sub}</small></a>`;
    return `
        ${pageHead('Ещё')}
        <div class="more-grid">
            ${tile('bot', state.profile.botConnected ? '@' + esc(state.profile.botUsername) : 'Не подключён')}
            ${tile('faq', 'Автоответы клиентам')}
            ${tile('reviews', 'Оценки после визитов')}
            ${tile('clients', 'Ваша база')}
            ${tile('broadcast', 'Акции и окошки')}
            ${tile('design', 'Логотип и цвета')}
            ${tile('plan', state.profile.isPro ? 'Pro' : 'Free → Pro')}
            <button class="more-tile" data-action="logout" style="text-align:left;font:inherit;font-weight:700;cursor:pointer">${icon('logout')}<span>Выйти</span><small>&nbsp;</small></button>
        </div>`;
};

// ---------- Модальное окно ----------

function openModal(html) {
    $('#modal-body').innerHTML = html;
    const dlg = $('#modal');
    if (!dlg.open) dlg.showModal();
}

function closeModal() {
    $('#modal').close();
}

$('#modal').addEventListener('click', e => {
    if (e.target.id === 'modal') closeModal(); // клик по фону
});

// ---------- Действия (делегирование) ----------

const ACTIONS = {
    'logout': () => logout(),
    'close-modal': () => closeModal(),

    'copy-link': async () => {
        const input = $('#share-link');
        try {
            await navigator.clipboard.writeText(input.value);
        } catch (e) {
            input.select();
            document.execCommand('copy');
        }
        toast('Ссылка скопирована');
    },

    'filter-bookings': el => {
        state.bookingsFilter = el.dataset.filter;
        render();
    },

    'confirm-booking': el => {
        const b = state.bookingsCache.find(x => x.id === el.dataset.id);
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(11, 0, 0, 0);
        openModal(`
            <form class="form" data-form="confirm-booking" data-id="${b.id}">
                <div class="modal-head"><h3>${b.status === 'new' ? 'Подтвердить запись' : 'Перенести запись'}</h3>
                    <button type="button" class="icon-btn" data-action="close-modal" aria-label="Закрыть">${icon('x')}</button></div>
                <p class="muted">${esc(b.serviceName)} · ${esc(b.clientName)}</p>
                ${b.comment ? `<div class="booking-comment">${esc(b.comment)}</div>` : ''}
                <label class="field"><span>Дата и время визита</span>
                    <input class="input" type="datetime-local" name="when" required value="${toLocalInput(b.appointmentAt || tomorrow)}"></label>
                <p class="hint">Клиент получит сообщение с датой и адресом${state.profile.isPro ? ', а за 24 и 2 часа — напоминание' : ''}.</p>
                <button class="btn btn-primary btn-block" type="submit">${icon('check')}Подтвердить</button>
            </form>`);
    },

    'set-status': async el => {
        const status = el.dataset.status;
        if (status === 'cancelled' && !confirm('Отменить запись? Клиент получит уведомление.')) return;
        await withBusy(el, async () => {
            await api('/api/master/bookings/' + el.dataset.id, { method: 'PUT', body: { status } });
            toast(status === 'completed' ? 'Готово! Бот попросит отзыв через 2 часа' : 'Запись отменена');
            await refreshCounters();
            render();
        });
    },

    'edit-service': el => openServiceModal(el.dataset.id ? state.servicesCache.find(s => s.id === el.dataset.id) : null),

    'pick-emoji': el => {
        el.closest('.field').querySelectorAll('.segment').forEach(b => b.classList.toggle('active', b === el));
        el.closest('form').elements.emoji.value = el.dataset.emoji;
    },

    'toggle-service': async el => {
        await withBusy(null, async () => {
            await api('/api/master/services/' + el.dataset.id, { method: 'PUT', body: { isActive: el.checked } });
            toast(el.checked ? 'Услуга в каталоге' : 'Услуга скрыта');
        });
        render();
    },

    'delete-service': async el => {
        if (!confirm('Удалить услугу? Это действие нельзя отменить.')) return;
        await withBusy(el, async () => {
            await api('/api/master/services/' + el.dataset.id, { method: 'DELETE' });
            closeModal();
            toast('Услуга удалена');
            render();
        });
    },

    'upload-avatar': async el => {
        const file = el.files[0];
        if (!file) return;
        await withBusy(null, async () => {
            state.profile = await upload('/api/master/avatar', file);
            toast('Фото обновлено');
            render();
        });
    },

    'upload-logo': async el => {
        const file = el.files[0];
        if (!file) return;
        await withBusy(null, async () => {
            state.profile = await upload('/api/master/logo', file);
            toast('Логотип загружен');
            render();
        });
    },

    'upload-photo': async el => {
        const file = el.files[0];
        if (!file) return;
        await withBusy(null, async () => {
            await upload('/api/master/portfolio', file);
            toast('Фото добавлено в портфолио');
            render();
        });
    },

    'delete-photo': async el => {
        if (!confirm('Удалить фото из портфолио?')) return;
        await withBusy(el, async () => {
            await api('/api/master/portfolio/' + el.dataset.id, { method: 'DELETE' });
            render();
        });
    },

    'disconnect-bot': async el => {
        if (!confirm('Отключить бота? Клиенты не смогут записаться, пока вы не подключите его снова.')) return;
        await withBusy(el, async () => {
            state.profile = await api('/api/master/bot', { method: 'DELETE' });
            toast('Бот отключён');
            render();
        });
    },

    'edit-faq': el => openFaqModal(el.dataset.id ? state.faqCache.find(f => f.id === el.dataset.id) : null),

    'delete-faq': async el => {
        if (!confirm('Удалить этот ответ?')) return;
        await withBusy(el, async () => {
            await api('/api/master/faq/' + el.dataset.id, { method: 'DELETE' });
            closeModal();
            render();
        });
    },

    'toggle-review': async el => {
        const isVisible = el.dataset.visible !== 'true';
        await withBusy(el, async () => {
            await api('/api/master/reviews/' + el.dataset.id, { method: 'PUT', body: { isVisible } });
            toast(isVisible ? 'Отзыв снова в каталоге' : 'Отзыв скрыт');
            render();
        });
    },

    'pick-accent': el => {
        state.accent = el.dataset.color;
        document.querySelectorAll('.color-swatch').forEach(s => s.classList.toggle('active', s === el));
    },

    'save-theme': async el => {
        if (!state.accent) return toast('Выберите цвет', true);
        await withBusy(el, async () => {
            state.profile = await api('/api/master/theme', { method: 'PUT', body: { theme: { accent: state.accent } } });
            toast('Цвет каталога обновлён');
        });
    },

    'reset-theme': async el => {
        await withBusy(el, async () => {
            state.profile = await api('/api/master/theme', { method: 'PUT', body: { theme: null } });
            toast('Вернули стандартное оформление');
            render();
        });
    },

    'toggle-whitelabel': async el => {
        await withBusy(null, async () => {
            state.profile = await api('/api/master/theme', { method: 'PUT', body: { whiteLabel: el.checked } });
            toast(el.checked ? 'Логотип BeautyApp скрыт' : 'Логотип BeautyApp показан');
        });
    },

    'pay-online': async el => {
        await withBusy(el, async () => {
            const { url } = await api('/api/payment/create', { method: 'POST' });
            if (tg?.openLink && tg.initData) tg.openLink(url);
            else location.href = url;
        });
    },

    'pay-manual': async el => {
        await withBusy(el, async () => {
            const { details } = await api('/api/payment/manual', { method: 'POST' });
            openModal(`
                <div class="modal-head"><h3>Оплата переводом</h3>
                    <button type="button" class="icon-btn" data-action="close-modal" aria-label="Закрыть">${icon('x')}</button></div>
                <p>Переведите <strong>${state.sub.price} ₽</strong>:</p>
                <div class="booking-comment">${esc(details)}</div>
                <p class="muted">Мы получили вашу заявку. Как только перевод поступит, Pro включится и бот пришлёт вам сообщение.</p>
                <button class="btn btn-primary btn-block" data-action="close-modal">Понятно</button>`);
            render();
        });
    }
};

document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el || el.tagName === 'INPUT') return; // input-ы обрабатываются по change
    const fn = ACTIONS[el.dataset.action];
    if (fn) {
        e.preventDefault();
        fn(el);
    }
});

document.addEventListener('change', e => {
    const el = e.target;
    if (el.tagName === 'INPUT' && el.dataset.action && el.dataset.action !== 'custom-accent') {
        ACTIONS[el.dataset.action]?.(el);
    }
});

document.addEventListener('input', e => {
    if (e.target.dataset.action === 'custom-accent') {
        state.accent = e.target.value;
        document.querySelectorAll('.color-swatch').forEach(s => s.classList.toggle('active', s === e.target));
    }
});

// ---------- Формы ----------

const FORMS = {
    async service(form) {
        const fd = new FormData(form);
        const body = {
            name: fd.get('name').trim(),
            price: Number(fd.get('price')),
            duration: Number(fd.get('duration') || 60),
            description: fd.get('description').trim(),
            emoji: fd.get('emoji')
        };
        const id = form.dataset.id;
        const saved = id
            ? await api('/api/master/services/' + id, { method: 'PUT', body })
            : await api('/api/master/services', { method: 'POST', body });
        const image = fd.get('image');
        if (image && image.size) await upload(`/api/master/services/${saved.id}/image`, image);
        closeModal();
        toast(id ? 'Услуга сохранена' : 'Услуга добавлена в каталог');
    },

    async profile(form) {
        const body = Object.fromEntries(new FormData(form));
        state.profile = await api('/api/master/profile', { method: 'PUT', body });
        toast('Профиль сохранён');
    },

    async bot(form) {
        const token = new FormData(form).get('token').trim();
        state.profile = await api('/api/master/bot', { method: 'POST', body: { token } });
        toast(`Бот @${state.profile.botUsername} подключён!`);
    },

    async 'confirm-booking'(form) {
        const when = new Date(new FormData(form).get('when'));
        if (when < new Date()) throw new Error('Выберите время в будущем');
        await api('/api/master/bookings/' + form.dataset.id, {
            method: 'PUT', body: { status: 'confirmed', appointmentAt: when.toISOString() }
        });
        closeModal();
        await refreshCounters();
        toast('Подтверждено — клиент получил сообщение');
    },

    async faq(form) {
        const body = Object.fromEntries(new FormData(form));
        const id = form.dataset.id;
        await api(id ? '/api/master/faq/' + id : '/api/master/faq', { method: id ? 'PUT' : 'POST', body });
        closeModal();
        toast('Бот теперь знает ответ');
    },

    async header(form) {
        const headerName = new FormData(form).get('headerName');
        state.profile = await api('/api/master/header', { method: 'PUT', body: { headerName } });
        toast('Название обновлено');
    },

    async broadcast(form) {
        const fd = new FormData(form);
        const text = fd.get('text').trim();
        const image = fd.get('image');
        if (!confirm('Отправить сообщение всем клиентам?')) return;
        const res = image && image.size
            ? await upload('/api/master/broadcast', image, { text })
            : await api('/api/master/broadcast', { method: 'POST', body: { text } });
        toast(`Рассылка запущена: ${res._count.recipients} ${plural(res._count.recipients, 'получатель', 'получателя', 'получателей')}`);
    }
};

document.addEventListener('submit', async e => {
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    await withBusy(form.querySelector('[type=submit]'), async () => {
        await FORMS[form.dataset.form](form);
        render();
    });
});

// ---------- Старт ----------

(async () => {
    try { tg?.ready(); tg?.expand(); } catch (e) {}
    try {
        const token = await authenticate();
        if (!token) return showLogin();
        saveToken(token);
        await start();
    } catch (e) {
        await showLogin();
        toast(e.message, true);
    }
})();
