/* Заглушка Telegram WebApp для тестирования в обычном браузере */
if (!window.Telegram || !window.Telegram.WebApp) {
    window.Telegram = {
        WebApp: {
            ready: function() {},
            expand: function() {},
            close: function() { alert('Приложение закрыто (тестовый режим)'); },
            sendData: function(data) { console.log('sendData:', data); },
            showAlert: function(msg, cb) { alert(msg); if (cb) cb(); },
            openTelegramLink: function(url) { window.open(url); },
            initData: '',
            MainButton: {
                text: '', isVisible: false,
                setText: function(t) { this.text = t; this._updateDOM(); },
                show: function() { this.isVisible = true; this._updateDOM(); },
                hide: function() { this.isVisible = false; this._updateDOM(); },
                onClick: function(cb) { this._cb = cb; },
                offClick: function() { this._cb = null; },
                showProgress: function() {},
                hideProgress: function() {},
                _cb: null,
                _updateDOM: function() {
                    let btn = document.getElementById('__tg_main_btn');
                    if (!btn) {
                        btn = document.createElement('div');
                        btn.id = '__tg_main_btn';
                        btn.style.cssText = 'position:fixed;bottom:0;left:0;right:0;height:56px;background:#2AABEE;color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600;cursor:pointer;z-index:9999;font-family:inherit;';
                        btn.addEventListener('click', () => { if (this._cb) this._cb(); });
                        document.body.appendChild(btn);
                    }
                    btn.textContent = this.text;
                    btn.style.display = this.isVisible ? 'flex' : 'none';
                }
            },
            BackButton: {
                isVisible: false,
                show: function() { this.isVisible = true; this._updateDOM(); },
                hide: function() { this.isVisible = false; this._updateDOM(); },
                onClick: function(cb) { this._cb = cb; },
                offClick: function() { this._cb = null; },
                _cb: null,
                _updateDOM: function() {
                    let btn = document.getElementById('__tg_back_btn');
                    if (!btn) {
                        btn = document.createElement('div');
                        btn.id = '__tg_back_btn';
                        btn.style.cssText = 'position:fixed;top:0;left:0;width:56px;height:56px;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:9999;font-size:24px;color:#2AABEE;';
                        btn.innerHTML = '←';
                        btn.addEventListener('click', () => { if (this._cb) this._cb(); });
                        document.body.appendChild(btn);
                    }
                    btn.style.display = this.isVisible ? 'flex' : 'none';
                }
            },
            HapticFeedback: {
                impactOccurred: function() {},
                notificationOccurred: function() {},
                selectionChanged: function() {}
            },
            initDataUnsafe: { user: { first_name: 'Тест', id: 123, username: 'test' } },
            themeParams: {}
        }
    };
}
