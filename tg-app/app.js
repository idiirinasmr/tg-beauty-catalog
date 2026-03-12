/* ============================================
   Логика Telegram Mini App — Каталог бьюти-услуг
   ============================================ */

// --- Telegram Web App ---
const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

// --- Данные мастера ---
const master = {
    name: 'Анна Иванова',
    specialty: 'Маникюр, педикюр · 5 лет',
    address: 'ул. Тверская, 15, оф.3',
    phone: '+7 (937) 658-10-31',
    telegram: 'https://t.me/Irinasmrgmailcom'
};

// --- Каталог услуг ---
const services = [
    {
        id: 1,
        name: 'Маникюр классический',
        description: 'Классический маникюр с покрытием гель-лаком. Аккуратная обработка кутикулы и придание формы.',
        price: 1500,
        duration: 60,
        emoji: '💅'
    },
    {
        id: 2,
        name: 'Маникюр + покрытие',
        description: 'Маникюр с выравниванием ногтевой пластины и покрытием гель-лаком. Широкая палитра цветов.',
        price: 2500,
        duration: 90,
        emoji: '💅'
    },
    {
        id: 3,
        name: 'Педикюр',
        description: 'Аппаратный педикюр с покрытием гель-лаком. Полный уход за стопами и ногтями.',
        price: 2000,
        duration: 90,
        emoji: '🦶'
    },
    {
        id: 4,
        name: 'Наращивание ногтей',
        description: 'Наращивание на формы или типсы. Любая длина и форма. Крепкие и красивые ногти.',
        price: 3500,
        duration: 120,
        emoji: '✨'
    },
    {
        id: 5,
        name: 'Дизайн ногтей',
        description: 'Художественная роспись, стемпинг, наклейки, стразы. Индивидуальный дизайн по вашему желанию.',
        price: 500,
        duration: 30,
        emoji: '🖌️'
    },
    {
        id: 6,
        name: 'Снятие покрытия',
        description: 'Бережное снятие гель-лака или наращенных ногтей без повреждения ногтевой пластины.',
        price: 500,
        duration: 30,
        emoji: '🧴'
    }
];

// --- Портфолио (заглушки-эмодзи, потом заменим на фото) ---
const portfolio = [
    { emoji: '🎵', color: 0 },
    { emoji: '💅', color: 1 },
    { emoji: '💖', color: 2 },
    { emoji: '⚙️', color: 3 },
    { emoji: '🌸', color: 4 },
    { emoji: '🌊', color: 5 }
];

// --- Состояние приложения ---
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
            mainBtn.hide();
            backBtn.hide();
            break;

        case 'catalog':
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
            haptic('notification', 'success');
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

// --- Генерация портфолио ---

function renderPortfolio() {
    const grid = document.getElementById('portfolio-grid');

    grid.innerHTML = portfolio.map(item => `
        <div class="portfolio-item">${item.emoji}</div>
    `).join('');
}

// --- Генерация списка услуг ---

function renderServicesList() {
    const list = document.getElementById('services-list');

    list.innerHTML = services.map(service => `
        <div class="service-item" data-id="${service.id}">
            <div class="service-item-icon">${service.emoji}</div>
            <div class="service-item-info">
                <div class="service-item-name">${service.name}</div>
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
            const id = parseInt(item.dataset.id);
            selectedService = services.find(s => s.id === id);
            haptic('selection');
            fillDetailScreen(selectedService);
            showScreen('detail');
        });
    });
}

// --- Заполнение экрана деталей ---

function fillDetailScreen(service) {
    document.getElementById('detail-image-placeholder').textContent = service.emoji;
    document.getElementById('detail-name').textContent = service.name;
    document.getElementById('detail-description').textContent = service.description;
    document.getElementById('detail-duration-text').textContent = service.duration + ' минут';
    document.getElementById('detail-price').textContent = formatPrice(service.price);
}

// --- Заполнение экрана подтверждения ---

function fillConfirmScreen() {
    document.getElementById('confirm-service').textContent = selectedService.name;
    document.getElementById('confirm-duration').textContent = selectedService.duration + ' мин';
    document.getElementById('confirm-price').textContent = formatPrice(selectedService.price);
}

// --- Отправка данных в бота ---

function sendBookingData() {
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

    tg.MainButton.hideProgress();
    showScreen('success');
}

// --- Вспомогательные функции ---

function formatPrice(price) {
    return price.toLocaleString('ru-RU') + ' ₽';
}

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
    window.open('tel:' + master.phone.replace(/[^\d+]/g, ''));
});

document.getElementById('btn-message')?.addEventListener('click', () => {
    haptic('selection');
    window.open(master.telegram);
});

// --- Навигация отзывов ---

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

    leftBtn.addEventListener('click', () => {
        haptic('selection');
        list.scrollBy({ left: -270, behavior: 'smooth' });
    });

    rightBtn.addEventListener('click', () => {
        haptic('selection');
        list.scrollBy({ left: 270, behavior: 'smooth' });
    });

    list.addEventListener('scroll', updateArrows);
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

function initOnboarding() {
    // Показываем один раз
    if (localStorage.getItem('onboarding_done')) {
        showScreen('catalog');
        return;
    }

    // Персональное приветствие
    const user = tg.initDataUnsafe?.user;
    const name = user?.first_name || '';
    const title = document.getElementById('onboarding-title');
    title.textContent = name ? 'Привет, ' + name + '!' : 'Привет!';

    document.getElementById('onboarding-start').addEventListener('click', () => {
        haptic('impact', 'light');
        localStorage.setItem('onboarding_done', '1');
        showScreen('catalog');
    });

    showScreen('onboarding');
}

// --- Кнопка «Поделиться с другом» ---

document.getElementById('btn-share')?.addEventListener('click', () => {
    haptic('selection');
    const shareText = 'Записывайся на маникюр к мастеру Анне — удобно прямо в Telegram!';
    const shareUrl = 'https://t.me/Krasa555bot';

    if (tg.openTelegramLink) {
        tg.openTelegramLink('https://t.me/share/url?url=' + encodeURIComponent(shareUrl) + '&text=' + encodeURIComponent(shareText));
    } else {
        window.open('https://t.me/share/url?url=' + encodeURIComponent(shareUrl) + '&text=' + encodeURIComponent(shareText));
    }
});

// --- Модалка-оффер (первый визит) ---

function initOffer() {
    if (localStorage.getItem('offer_shown')) return;

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
if (new URLSearchParams(window.location.search).has('reset')) {
    localStorage.removeItem('onboarding_done');
    localStorage.removeItem('offer_shown');
}

renderPortfolio();
renderServicesList();
initReviewsNav();
initOnboarding();
initOffer();
