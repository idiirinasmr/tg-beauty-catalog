/* Панель владельца платформы: статистика, мастера, платежи, мониторинг */

const tg = window.Telegram?.WebApp;
const params = new URLSearchParams(location.search);
const TOKEN_KEY = 'beauty_platform_token';
let token = null;

const $ = sel => document.querySelector(sel);
const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rub = n => Number(n).toLocaleString('ru-RU') + ' ₽';
const day = iso => iso ? new Date(iso).toLocaleDateString('ru-RU') : '—';

let toastTimer;
function toast(msg, err = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', err);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

async function api(path, { method = 'GET', body } = {}) {
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Ошибка'), { status: res.status });
    return data;
}

async function authenticate() {
    if (params.get('hash') && params.get('id')) {
        const data = {};
        ['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date', 'hash']
            .forEach(k => { if (params.has(k)) data[k] = params.get(k); });
        history.replaceState(null, '', location.pathname);
        return (await api('/api/auth/telegram', { method: 'POST', body: data })).token;
    }
    if (tg?.initData) return (await api('/api/auth/webapp', { method: 'POST', body: { initData: tg.initData } })).token;
    try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
}

async function showLogin() {
    $('#view-login').hidden = false;
    $('#view-app').hidden = true;
    const cfg = await api('/api/auth/config').catch(() => ({}));
    if (cfg.loginBotUsername) {
        const s = document.createElement('script');
        s.async = true;
        s.src = 'https://telegram.org/js/telegram-widget.js?22';
        s.dataset.telegramLogin = cfg.loginBotUsername;
        s.dataset.size = 'large';
        s.dataset.radius = '12';
        s.dataset.authUrl = location.origin + location.pathname;
        $('#login-widget').replaceChildren(s);
    }
    $('#dev-login').hidden = !cfg.devLogin;
}

$('#dev-login').addEventListener('submit', async e => {
    e.preventDefault();
    try {
        const res = await api('/api/auth/dev', { method: 'POST', body: { id: new FormData(e.target).get('id') } });
        token = res.token;
        localStorage.setItem(TOKEN_KEY, token);
        await render();
    } catch (err) { toast(err.message, true); }
});

$('#logout').addEventListener('click', () => {
    token = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    showLogin();
});

async function render() {
    const [stats, masters, payments, mon] = await Promise.all([
        api('/api/admin/stats'), api('/api/admin/masters'), api('/api/admin/payments'), api('/api/admin/monitoring')
    ]);
    $('#view-login').hidden = true;
    $('#view-app').hidden = false;

    const backup = mon.lastBackup;
    const backupOk = backup?.ok && Date.now() - new Date(backup.createdAt) < 26 * 3600 * 1000;

    $('#main').innerHTML = `
        <div class="page-head"><div><h2>Платформа</h2><p>Мастеров ${stats.masters} из ${stats.maxMasters}</p></div></div>
        <div class="stats">
            <div class="stat accent"><div class="stat-value">${rub(stats.revenue.month)}</div><div class="stat-label">выручка за 30 дней</div></div>
            <div class="stat"><div class="stat-value">${stats.masters}</div><div class="stat-label">мастеров (Pro: ${stats.pro})</div></div>
            <div class="stat"><div class="stat-value">${stats.clients}</div><div class="stat-label">клиентов (+${stats.clientsToday} сегодня)</div></div>
            <div class="stat"><div class="stat-value">${stats.bookingsTotal}</div><div class="stat-label">заявок (+${stats.bookingsToday} сегодня)</div></div>
        </div>

        <div class="card">
            <div class="card-head"><h3>Мониторинг</h3><span class="muted small">аптайм ${Math.round(mon.uptimeSec / 3600)} ч</span></div>
            <div class="mon">
                <div><div class="muted small">Память процесса</div><strong>${mon.memory.rssMb} МБ</strong></div>
                <div><div class="muted small">Свободно на сервере</div><strong>${mon.system.freeMb} / ${mon.system.totalMb} МБ</strong></div>
                <div><div class="muted small">Активных ботов</div><strong>${mon.bots}</strong></div>
                <div><div class="muted small">Очередь сообщений</div><strong>${mon.queue.pending}</strong></div>
                <div><div class="muted small">Нагрузка CPU</div><strong>${mon.system.load.join(' / ')}</strong></div>
                <div><div class="muted small">Последний бэкап</div>
                    <strong class="${backupOk ? 'ok' : 'bad'}">${backup ? new Date(backup.createdAt).toLocaleString('ru-RU') : 'не было'}</strong></div>
            </div>
        </div>

        <div class="card">
            <div class="card-head"><h3>Мастера</h3></div>
            <div class="table-wrap"><table>
                <thead><tr><th>Мастер</th><th>Бот</th><th>Тариф</th><th>Клиенты</th><th>Заявки</th><th>С нами с</th><th></th></tr></thead>
                <tbody>${masters.map(m => {
                    const pro = m.plan === 'pro' && new Date(m.planExpiresAt) > new Date();
                    return `<tr>
                        <td><strong>${esc(m.name)}</strong><div class="muted small">${esc(m.specialty)}</div></td>
                        <td>${m.botUsername ? `<a href="https://t.me/${esc(m.botUsername)}" target="_blank" rel="noopener">@${esc(m.botUsername)}</a> ${m.botRunning ? '<span class="ok">●</span>' : '<span class="bad">●</span>'}` : '<span class="muted">—</span>'}</td>
                        <td>${pro ? `<span class="badge pro">Pro до ${day(m.planExpiresAt)}</span>` : '<span class="badge free">Free</span>'}</td>
                        <td>${m._count.clients}</td>
                        <td>${m._count.bookings}</td>
                        <td>${day(m.createdAt)}</td>
                        <td><button class="btn btn-outline btn-sm" data-plan="pro" data-id="${m.id}">+30 дней Pro</button>
                            ${pro ? `<button class="btn btn-danger btn-sm" data-plan="free" data-id="${m.id}">→ Free</button>` : ''}</td>
                    </tr>`;
                }).join('') || '<tr><td colspan="7" class="muted">Мастеров пока нет</td></tr>'}</tbody>
            </table></div>
        </div>

        <div class="card">
            <div class="card-head"><h3>Платежи</h3><span class="muted small">всего ${rub(stats.revenue.total)}</span></div>
            <div class="table-wrap"><table>
                <thead><tr><th>Дата</th><th>Мастер</th><th>Сумма</th><th>Способ</th><th>Статус</th><th>Период</th></tr></thead>
                <tbody>${payments.map(p => `<tr>
                    <td>${day(p.createdAt)}</td><td>${esc(p.master.name)}</td><td>${rub(p.amount)}</td>
                    <td>${{ yukassa: 'ЮKassa', manual: 'Перевод', stripe: 'Stripe' }[p.method] || esc(p.method)}</td>
                    <td><span class="badge ${p.status === 'paid' ? 'confirmed' : p.status === 'pending' ? 'new' : 'cancelled'}">${{ paid: 'оплачен', pending: 'ожидает', failed: 'ошибка' }[p.status] || esc(p.status)}</span></td>
                    <td>${p.periodEnd ? `${day(p.periodStart)} — ${day(p.periodEnd)}` : '—'}</td>
                </tr>`).join('') || '<tr><td colspan="6" class="muted">Платежей пока нет</td></tr>'}</tbody>
            </table></div>
        </div>`;
}

document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-plan]');
    if (!btn) return;
    const plan = btn.dataset.plan;
    if (plan === 'free' && !confirm('Перевести мастера на Free?')) return;
    btn.disabled = true;
    try {
        await api(`/api/admin/masters/${btn.dataset.id}/plan`, { method: 'PUT', body: { plan, days: 30 } });
        toast(plan === 'pro' ? 'Pro продлён на 30 дней' : 'Переведён на Free');
        await render();
    } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
    }
});

(async () => {
    try { tg?.ready(); tg?.expand(); } catch (e) {}
    try {
        token = await authenticate();
        if (!token) return showLogin();
        localStorage.setItem(TOKEN_KEY, token);
        await render();
    } catch (e) {
        showLogin();
        if (e.status === 403) toast('Нет доступа: вашего Telegram ID нет в ADMIN_TELEGRAM_IDS', true);
        else toast(e.message, true);
    }
})();
