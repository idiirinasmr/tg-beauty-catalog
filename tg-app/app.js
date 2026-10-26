/* ============================================
   Логика Telegram Mini App — Каталог бьюти-услуг

   Два режима:
   - Платформа: открыт из бота мастера с ?bot=USERNAME — данные из API,
     запись через POST /api/booking (подпись Telegram проверяет сервер)
   - Демо: без ?bot= (GitHub Pages) — данные ниже, запись через sendData()
   ============================================ */

// --- Telegram Web App ---
const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

// --- Режим работы ---
const params = new URLSearchParams(window.location.search);
const botUsername = params.get('bot') || tg.initDataUnsafe?.start_param || null;
const API_URL = ''; // тот же домен, что и сервер платформы
const isPlatform = Boolean(botUsername);

// --- Демо-данные (режим без ?bot=) ---
const DEMO = {
    master: {
        name: 'Анна Иванова',
        headerName: 'Анна Иванова',
        specialty: 'Маникюр, педикюр · 5 лет',
        address: 'ул. Тверская, 15, оф.3',
        phone: '+7 (937) 658-10-31',
        telegram: 'https://t.me/Irinasmrgmailcom',
        botUsername: 'Krasa555bot',
        stats: '247 записей · Ближайшее: завтра, 10:00'
    },
    services: [
        { id: 1, name: 'Маникюр классический', description: 'Классический маникюр с покрытием гель-лаком. Аккуратная обработка кутикулы и придание формы.', price: 1500, duration: 60, emoji: '💅' },
        { id: 2, name: 'Маникюр + покрытие', description: 'Маникюр с выравниванием ногтевой пластины и покрытием гель-лаком. Широкая палитра цветов.', price: 2500, duration: 90, emoji: '💅' },
        { id: 3, name: 'Педикюр', description: 'Аппаратный педикюр с покрытием гель-лаком. Полный уход за стопами и ногтями.', price: 2000, duration: 90, emoji: '🦶' },
        { id: 4, name: 'Наращивание ногтей', description: 'Наращивание на формы или типсы. Любая длина и форма. Крепкие и красивые ногти.', price: 3500, duration: 120, emoji: '✨' },
        { id: 5, name: 'Дизайн ногтей', description: 'Художественная роспись, стемпинг, наклейки, стразы. Индивидуальный дизайн по вашему желанию.', price: 500, duration: 30, emoji: '🖌️' },
        { id: 6, name: 'Снятие покрытия', description: 'Бережное снятие гель-лака или наращенных ногтей без повреждения ногтевой пластины.', price: 500, duration: 30, emoji: '🧴' }
    ],
    // Портфолио — заглушки-эмодзи
    portfolio: ['🎵', '💅', '💖', '⚙️', '🌸', '🌊'].map(emoji => ({ emoji })),
    reviews: [
        { clientName: 'Мария', rating: 5, text: 'Делала маникюр у Анны — результат идеальный! Покрытие держится уже 3 недели без сколов. Обязательно приду ещё 💅' },
        { clientName: 'Екатерина', rating: 5, text: 'Наращивание получилось очень аккуратное и естественное. Анна внимательно выслушала пожелания и сделала именно то, что хотела ✨' },
        { clientName: 'Ольга', rating: 5, text: 'Хожу на педикюр регулярно. Всегда чисто, аккуратно и приятная атмосфера. Рекомендую всем подругам!' }
    ]
};

// --- Состояние приложения ---
let catalog = DEMO;
let selectedService = null;
let currentScreen = 'onboarding';

// --- Навигация между экранами ---

function showScreen(screenName) {
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active', 'visible');
    });

    const screen = document.getElementById('screen-' + screenName);
    screen.classList.add('active');

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            screen.classList.add('visible');
        });
    });

    currentScreen = screenName;
    updateTelegramButtons(screenName);
}

function updateTelegramButtons(screenName) {
    const mainBtn = tg.MainButton;
    const backBtn = tg.BackButton;

    mainBtn.offClick(onMainButtonClick);
    backBtn.offClick(onBackButtonClick);

    switch (screenName) {
        case 'onboarding':
        case 'catalog':
        case 'error':
            mainBtn.hide();
            backBtn.hide();
            break;

        case 'detail':
            mainBtn.setText('Записаться');
            mainBtn.show();
            mainBtn.onClick(onMainButtonClick);
            backBtn.show();
            backBtn.onClick(onBackButtonClick);
            break;

        case 'confirm':
            mainBtn.setText('Подтвердить запись');
            mainBtn.show();
            mainBtn.onClick(onMainButtonClick);
            backBtn.show();
            backBtn.onClick(onBackButtonClick);
            break;

        case 'success':
            mainBtn.setText('Закрыть');
            mainBtn.show();
            mainBtn.onClick(onMainButtonClick);
            backBtn.hide();
            break;
    }
}

// --- Обработчики кнопок ---

function onMainButtonClick() {
    switch (currentScreen) {
        case 'detail':
            haptic('impact', 'light');
            fillConfirmScreen();
            showScreen('confirm');
            break;

        case 'confirm':
            tg.MainButton.showProgress();
            sendBookingData();
            break;

        case 'success':
            tg.close();
            break;
    }
}

function onBackButtonClick() {
    switch (currentScreen) {
        case 'detail':
            showScreen('catalog');
            break;
        case 'confirm':
            showScreen('detail');
            break;
    }
}

// --- Профиль мастера ---

function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

function renderProfile() {
    const m = catalog.master;
    const avatar = document.getElementById('master-avatar');
    if (m.avatarUrl) {
        avatar.innerHTML = `<img src="${escapeAttr(m.avatarUrl)}" alt="">`;
    } else {
        avatar.textContent = initials(m.name);
    }

    const logo = document.getElementById('master-logo');
    logo.hidden = !m.logoUrl;
    if (m.logoUrl) logo.src = m.logoUrl;

    document.getElementById('master-name').textContent = m.headerName || m.name;
    document.getElementById('master-specialty').textContent = m.specialty || '';
    document.getElementById('master-address').textContent = m.address || '';
    document.getElementById('master-address-row').hidden = !m.address;

    const stats = m.stats || (m.rating ? `★ ${m.rating} · ${m.reviewsCount} ${plural(m.reviewsCount, 'отзыв', 'отзыва', 'отзывов')}` : '');
    document.getElementById('master-stats').textContent = stats;
    document.getElementById('master-stats').hidden = !stats;

    const about = document.getElementById('master-about');
    about.textContent = m.about || '';
    about.hidden = !m.about;

    document.getElementById('btn-call').hidden = !m.phone;
    document.getElementById('powered-by').hidden = !isPlatform || m.whiteLabel;
    document.title = m.headerName || m.name;

    applyTheme(m.theme);
}

// Кастомная тема мастера (Pro): переопределяем акцентный цвет и фон
function applyTheme(theme) {
    if (!theme) return;
    const root = document.documentElement.style;
    if (theme.accent) {
        root.setProperty('--accent', theme.accent);
        root.setProperty('--tg-theme-button-color', theme.accent);
        try { tg.MainButton.setParams({ color: theme.accent }); } catch (e) {}
    }
    if (theme.background) root.setProperty('--tg-theme-bg-color', theme.background);
    if (theme.text) root.setProperty('--tg-theme-text-color', theme.text);
}

// --- Генерация портфолио ---

function renderPortfolio() {
    const grid = document.getElementById('portfolio-grid');
    document.getElementById('section-portfolio').hidden = !catalog.portfolio.length;

    grid.innerHTML = catalog.portfolio.map(item => item.imageUrl
        ? `<div class="portfolio-item"><img src="${escapeAttr(item.imageUrl)}" alt="" loading="lazy"></div>`
        : `<div class="portfolio-item">${escapeHtml(item.emoji)}</div>`
    ).join('');
}

// --- Отзывы ---

function renderReviews() {
    const list = document.getElementById('reviews-list');
    document.getElementById('section-reviews').hidden = !catalog.reviews.length;

    list.innerHTML = catalog.reviews.map(r => `
        <div class="review-item">
            <div class="review-header">
                <span class="review-name">${escapeHtml(r.clientName)}</span>
                <span class="review-stars">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span>
            </div>
            <p class="review-text">${escapeHtml(r.text || 'Без комментария')}</p>
        </div>
    `).join('');
}

// --- Генерация списка услуг ---

function serviceIcon(service, cls) {
    return service.imageUrl
        ? `<div class="${cls}"><img src="${escapeAttr(service.imageUrl)}" alt="" loading="lazy"></div>`
        : `<div class="${cls}">${escapeHtml(service.emoji || '💅')}</div>`;
}

function renderServicesList() {
    const list = document.getElementById('services-list');

    if (!catalog.services.length) {
        list.innerHTML = '<p class="empty-text">Мастер ещё не добавил услуги</p>';
        return;
    }

    list.innerHTML = catalog.services.map(service => `
        <div class="service-item" data-id="${escapeAttr(service.id)}">
            ${serviceIcon(service, 'service-item-icon')}
            <div class="service-item-info">
                <div class="service-item-name">${escapeHtml(service.name)}</div>
                <div class="service-item-duration">${service.duration} мин</div>
            </div>
            <div class="service-item-price">${formatPrice(service.price)}</div>
            <svg class="service-item-arrow" width="7" height="12" viewBox="0 0 7 12" fill="none">
                <path d="M1 1L6 6L1 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        </div>
    `).join('');

    // Обработчики нажатий
    list.querySelectorAll('.service-item').forEach(item => {
        item.addEventListener('click', () => {
            selectedService = catalog.services.find(s => String(s.id) === item.dataset.id);
            haptic('selection');
            fillDetailScreen(selectedService);
            showScreen('detail');
        });
    });
}

// --- Заполнение экрана деталей ---

function fillDetailScreen(service) {
    const placeholder = document.getElementById('detail-image-placeholder');
    if (service.imageUrl) {
        placeholder.innerHTML = `<img src="${escapeAttr(service.imageUrl)}" alt="">`;
    } else {
        placeholder.textContent = service.emoji || '💅';
    }
    document.getElementById('detail-name').textContent = service.name;
    document.getElementById('detail-description').textContent = service.description;
    document.getElementById('detail-duration-text').textContent = service.duration + ' минут';
    document.getElementById('detail-price').textContent = formatPrice(service.price);
}

// --- Заполнение экрана подтверждения ---

function fillConfirmScreen() {
    document.getElementById('confirm-service').textContent = selectedService.name;
    document.getElementById('confirm-master').textContent = catalog.master.name;
    document.getElementById('confirm-duration').textContent = selectedService.duration + ' мин';
    document.getElementById('confirm-price').textContent = formatPrice(selectedService.price);
}

// --- Отправка заявки ---

async function sendBookingData() {
    if (isPlatform) {
        try {
            await api('/api/booking', {
                method: 'POST',
                body: { botUsername, serviceId: selectedService.id, initData: tg.initData }
            });
        } catch (e) {
            tg.MainButton.hideProgress();
            haptic('notification', 'error');
            tg.showAlert(e.message);
            return;
        }
    } else {
        const user = tg.initDataUnsafe?.user;
        const data = {
            action: 'booking',
            service_id: selectedService.id,
            service: selectedService.name,
            price: selectedService.price,
            duration: selectedService.duration,
            user_name: user?.first_name || 'Клиент',
            user_id: user?.id || null,
            username: user?.username || null
        };
        try {
            tg.sendData(JSON.stringify(data));
        } catch (e) {
            console.log('sendData:', JSON.stringify(data, null, 2));
        }
    }

    haptic('notification', 'success');
    tg.MainButton.hideProgress();
    document.getElementById('success-text').innerHTML = isPlatform
        ? `Мастер <strong>${escapeHtml(catalog.master.name)}</strong> получил(а) вашу заявку. Подтверждение с&nbsp;датой и&nbsp;временем придёт в&nbsp;чат с&nbsp;ботом`
        : 'Мастер <strong>Анна</strong> получила вашу заявку и&nbsp;ответит в&nbsp;течение 15&nbsp;минут';
    showScreen('success');
}

// --- API ---

async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
        res = await fetch(API_URL + path, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined
        });
    } catch (e) {
        throw new Error('Нет соединения. Проверьте интернет и попробуйте ещё раз');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Что-то пошло не так, попробуйте позже');
    return data;
}

// Skeleton вместо демо-данных, пока каталог грузится
function showSkeleton() {
    document.body.classList.add('loading');
    document.getElementById('master-logo').hidden = true;
    document.getElementById('master-about').hidden = true;
    document.getElementById('portfolio-grid').innerHTML =
        '<div class="portfolio-item skeleton"></div>'.repeat(3);
    document.getElementById('services-list').innerHTML =
        '<div class="skeleton skeleton-row"></div>'.repeat(4);
    if (currentScreen !== 'catalog') showScreen('catalog');
}

async function loadCatalog() {
    showSkeleton();
    try {
        const data = await api('/api/catalog/' + encodeURIComponent(botUsername));
        catalog = data;
        renderAll();
        return true;
    } catch (e) {
        document.getElementById('error-text').textContent = e.message;
        showScreen('error');
        return false;
    } finally {
        document.body.classList.remove('loading');
    }
}

function renderAll() {
    renderProfile();
    renderPortfolio();
    renderReviews();
    renderServicesList();
    initReviewsNav();
}

// --- Вспомогательные функции ---

function formatPrice(price) {
    return price.toLocaleString('ru-RU') + ' ₽';
}

function plural(n, one, few, many) {
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
}

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

const escapeAttr = escapeHtml;

function haptic(type, style) {
    try {
        if (type === 'impact') {
            tg.HapticFeedback.impactOccurred(style || 'light');
        } else if (type === 'notification') {
            tg.HapticFeedback.notificationOccurred(style || 'success');
        } else if (type === 'selection') {
            tg.HapticFeedback.selectionChanged();
        }
    } catch (e) {}
}

// --- Кнопки профиля ---

document.getElementById('btn-call')?.addEventListener('click', () => {
    haptic('selection');
    window.open('tel:' + catalog.master.phone.replace(/[^\d+]/g, ''));
});

document.getElementById('btn-message')?.addEventListener('click', () => {
    haptic('selection');
    // В режиме платформы пишем в бота мастера — вопрос попадёт в FAQ или к мастеру
    const link = isPlatform ? 'https://t.me/' + catalog.master.botUsername : catalog.master.telegram;
    if (isPlatform && tg.openTelegramLink) {
        tg.openTelegramLink(link);
        tg.close();
    } else {
        window.open(link);
    }
});

// --- Навигация отзывов ---

let reviewsNavReady = false;

function initReviewsNav() {
    const list = document.getElementById('reviews-list');
    const leftBtn = document.getElementById('reviews-left');
    const rightBtn = document.getElementById('reviews-right');

    function updateArrows() {
        const scrollLeft = Math.round(list.scrollLeft);
        const maxScroll = list.scrollWidth - list.clientWidth;
        leftBtn.classList.toggle('disabled', scrollLeft <= 0);
        rightBtn.classList.toggle('disabled', scrollLeft >= maxScroll - 1);
    }

    if (!reviewsNavReady) {
        reviewsNavReady = true;
        leftBtn.addEventListener('click', () => {
            haptic('selection');
            list.scrollBy({ left: -270, behavior: 'smooth' });
        });

        rightBtn.addEventListener('click', () => {
            haptic('selection');
            list.scrollBy({ left: 270, behavior: 'smooth' });
        });

        list.addEventListener('scroll', updateArrows);
    }
    updateArrows();
}

// --- Кнопки «Назад» в навигации ---

document.querySelectorAll('.nav-back').forEach(btn => {
    btn.addEventListener('click', () => {
        haptic('selection');
        showScreen(btn.dataset.back);
    });
});

// --- Онбординг (приветствие по имени) ---

// Ключи localStorage — свои у каждого мастера, чтобы онбординг показался в каждом каталоге
const storageKey = key => isPlatform ? `${key}:${botUsername}` : key;

function initOnboarding() {
    // Показываем один раз
    if (localStorage.getItem(storageKey('onboarding_done'))) {
        showScreen('catalog');
        return;
    }

    // Персональное приветствие
    const user = tg.initDataUnsafe?.user;
    const name = user?.first_name || '';
    const title = document.getElementById('onboarding-title');
    title.textContent = name ? 'Привет, ' + name + '!' : 'Привет!';

    if (isPlatform) {
        document.getElementById('onboarding-list').innerHTML =
            '<li>Посмотреть услуги и цены</li>' +
            '<li>Записаться к мастеру в пару нажатий</li>' +
            '<li>Задать вопрос мастеру прямо в чате</li>';
    }

    document.getElementById('onboarding-start').addEventListener('click', () => {
        haptic('impact', 'light');
        localStorage.setItem(storageKey('onboarding_done'), '1');
        showScreen('catalog');
    });

    showScreen('onboarding');
}

// --- Кнопка «Поделиться с другом» ---

document.getElementById('btn-share')?.addEventListener('click', () => {
    haptic('selection');
    const m = catalog.master;
    const shareText = isPlatform
        ? `Записывайся к мастеру ${m.name} — удобно прямо в Telegram!`
        : 'Записывайся на маникюр к мастеру Анне — удобно прямо в Telegram!';
    const shareUrl = 'https://t.me/' + m.botUsername;
    const link = 'https://t.me/share/url?url=' + encodeURIComponent(shareUrl) + '&text=' + encodeURIComponent(shareText);

    if (tg.openTelegramLink) {
        tg.openTelegramLink(link);
    } else {
        window.open(link);
    }
});

// --- Модалка-оффер (первый визит, только демо) ---

function initOffer() {
    if (isPlatform || localStorage.getItem('offer_shown')) return;

    const overlay = document.getElementById('offer-overlay');
    const btnOffer = document.getElementById('offer-btn');
    const btnSkip = document.getElementById('offer-skip');

    overlay.classList.add('active');
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            overlay.classList.add('visible');
        });
    });

    function closeOffer() {
        localStorage.setItem('offer_shown', '1');
        overlay.classList.remove('visible');
        setTimeout(() => {
            overlay.classList.remove('active');
        }, 300);
    }

    btnOffer.addEventListener('click', () => {
        haptic('impact', 'light');
        closeOffer();
    });

    btnSkip.addEventListener('click', () => {
        haptic('selection');
        closeOffer();
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            closeOffer();
        }
    });
}

// --- Инициализация ---

// Сброс для тестирования (?reset в URL)
if (params.has('reset')) {
    localStorage.removeItem(storageKey('onboarding_done'));
    localStorage.removeItem('offer_shown');
}

document.getElementById('error-retry').addEventListener('click', async () => {
    haptic('impact', 'light');
    if (await loadCatalog()) initOnboarding();
});

(async () => {
    if (isPlatform) {
        if (!await loadCatalog()) return;
    } else {
        renderAll();
    }
    initOnboarding();
    initOffer();
})();
