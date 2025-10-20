const AppState = {
    username: null,
    isVip: false, vipLevel: null, vipExpiry: null,
    botState: 'STOPPED',
    capitalManagementState: 'IDLE',
    currentTradeDetails: null,
    tradeHistory: []
};

document.addEventListener('DOMContentLoaded', () => {
    setupAuthListeners();
    checkLoginSession();
});

function checkLoginSession() {
    const username = localStorage.getItem('username');
    if (username) {
        AppState.username = username;
        initializeApp();
    } else {
        showAuthPage();
    }
}

async function initializeApp() {
    showAppPage();
    fetchStatus();
    setInterval(fetchStatus, 2000);
}

async function fetchStatus() {
    try {
        const response = await postData('/api/status', { username: AppState.username });
        if (!response) return;

        const wasVip = AppState.isVip;
        const wasBotRunning = AppState.botState === 'RUNNING';

        AppState.isVip = response.is_vip === 1;
        AppState.vipLevel = response.vip_level;
        AppState.vipExpiry = response.vip_expiry_timestamp;
        AppState.botState = response.botState;
        AppState.capitalManagementState = response.capitalManagementState;
        AppState.currentTradeDetails = response.currentTradeDetails;
        AppState.tradeHistory = response.tradeHistory || [];

        document.getElementById('vip-user').textContent = AppState.username;
        document.getElementById('vip-pnl').textContent = response.pnl?.toFixed(4) || '0.00';
        
        updateVipTime();
        updateBotStatusDisplay();

        if (wasVip !== AppState.isVip || wasBotRunning !== (AppState.botState === 'RUNNING')) {
            renderUI();
        }
    } catch (error) {
        console.error("Lỗi fetch status:", error);
    }
}

function createButton(id, icon, text, onClick, customClass = 'action-button') {
    const button = document.createElement('button');
    button.className = customClass;
    if (id) button.id = id;
    if (icon && text) button.innerHTML = `<i class="fas ${icon}"></i><span>${text}</span>`;
    if (onClick) button.addEventListener('click', onClick);
    return button;
}

function renderUI() {
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = '';
    
    if (AppState.isVip) {
        document.getElementById('vip-info-panel').style.display = 'flex';
        document.getElementById('bot-status-panel').style.display = 'flex';
        
        const isBotRunning = AppState.botState === 'RUNNING';
        const startButton = createButton('start-btn', isBotRunning ? 'fa-stop-circle' : 'fa-play-circle', isBotRunning ? 'Stop Bot' : 'Start Bot', isBotRunning ? handleStopBot : () => togglePopup('start-options-popup', true));
        if (isBotRunning) startButton.classList.add('stop-state');

        const historyFundingButton = createButton('history-funding-btn', 'fa-history', 'History Funding', () => showHistoryPopup('funding'));
        const historyStartButton = createButton('history-start-btn', 'fa-scroll', 'History Start', () => showHistoryPopup('start'));
        const supportButton = createButton('support-btn', 'fa-life-ring', 'Support', () => alert('Please contact support via Telegram.'));
        
        mainContent.append(startButton, historyFundingButton, historyStartButton, supportButton);

    } else {
        document.getElementById('vip-info-panel').style.display = 'none';
        document.getElementById('bot-status-panel').style.display = 'none';
        mainContent.innerHTML = `<p>Bạn cần nâng cấp VIP để sử dụng bot.</p>`;
    }
}

function updateBotStatusDisplay() {
    document.getElementById('bot-logic-state').textContent = AppState.botState || 'STOPPED';
    document.getElementById('bot-capital-state').textContent = AppState.capitalManagementState || 'IDLE';
    const tradeInfoEl = document.getElementById('current-trade-info');
    if (AppState.currentTradeDetails) {
        const trade = AppState.currentTradeDetails;
        tradeInfoEl.textContent = `Đang giao dịch: ${trade.coin} | ${trade.shortExchange} / ${trade.longExchange}`;
    } else {
        tradeInfoEl.textContent = 'Không có giao dịch nào đang mở.';
    }
}

function updateVipTime() {
    const timeSpan = document.getElementById('vip-time');
    const levelSpan = document.getElementById('vip-level');
    if (AppState.isVip) {
        levelSpan.textContent = AppState.vipLevel || 'N/A';
        if (AppState.vipLevel === 'GOLD') {
            timeSpan.textContent = 'Vĩnh viễn';
            return;
        }
        if (AppState.vipExpiry) {
            const remaining = AppState.vipExpiry - Date.now();
            if (remaining > 0) {
                 const d = Math.floor(remaining / 86400000), h = Math.floor((remaining % 86400000) / 3600000);
                 timeSpan.textContent = `${d}d ${h}h`;
            } else {
                 timeSpan.textContent = 'Hết hạn';
            }
        }
    }
}

function showHistoryPopup(type) {
    const title = document.getElementById('history-title'), head = document.getElementById('history-table-head'), body = document.getElementById('history-table-body');
    head.innerHTML = ''; body.innerHTML = '';

    if (type === 'start') {
        title.textContent = 'History Start';
        head.innerHTML = `<tr><th>Coin</th><th>Margin</th><th>PNL</th></tr>`;
        if (AppState.tradeHistory.length === 0) {
            body.innerHTML = `<tr><td colspan="3">No history data.</td></tr>`;
        } else {
            AppState.tradeHistory.forEach(row => {
                const pnlClass = row.actualPnl >= 0 ? 'pnl-positive' : 'pnl-negative';
                body.innerHTML += `<tr><td>${row.coin}</td><td>$${row.collateralUsed.toFixed(2)}</td><td class="${pnlClass}">${row.actualPnl.toFixed(4)}</td></tr>`;
            });
        }
    } else if (type === 'funding') {
        title.textContent = 'History Funding';
        head.innerHTML = `<tr><th>Coin</th><th>Est. PNL</th></tr>`;
        body.innerHTML = `<tr><td colspan="2">No funding history data yet.</td></tr>`;
    }
    togglePopup('history-popup', true);
}

async function handleStartBot(event) {
    event.preventDefault();
    const marginOptions = {
        type: event.target.elements['margin-type'].value,
        value: event.target.elements['margin-value'].value
    };
    if (!marginOptions.value || marginOptions.value <= 0) return alert('Vui lòng nhập giá trị hợp lệ.');
    
    const response = await postData('/api/start', { username: AppState.username, marginOptions });
    togglePopup('start-options-popup', false);
    if (!response.success) alert('Lỗi khởi động bot: ' + response.message);
    fetchStatus();
}

async function handleStopBot() {
    await postData('/api/stop', { username: AppState.username });
    fetchStatus();
}

async function handleSaveSettings(event) {
    event.preventDefault();
    const formData = new FormData(event.target);
    const settings = Object.fromEntries(formData.entries());
    const response = await postData('/api/save-settings', { username: AppState.username, settings });
    alert(response.message);
    if(response.success) togglePopup('settings-popup', false);
}

function setupAppListeners() {
    document.getElementById('logout-btn').addEventListener('click', handleLogout);
    document.getElementById('settings-btn').addEventListener('click', () => togglePopup('settings-popup', true));
    document.querySelectorAll('.popup-close-btn').forEach(btn => btn.addEventListener('click', () => btn.closest('.popup').classList.remove('active')));
    document.getElementById('settings-form').addEventListener('submit', handleSaveSettings);
    document.getElementById('start-options-form').addEventListener('submit', handleStartBot);
}

function setupAuthListeners() {
    document.getElementById('login-form').addEventListener('submit', handleLogin);
    document.getElementById('register-form').addEventListener('submit', handleRegister);
    document.getElementById('show-register').addEventListener('click', (e) => { e.preventDefault(); showRegisterForm(true); });
    document.getElementById('show-login').addEventListener('click', (e) => { e.preventDefault(); showRegisterForm(false); });
}

async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    const response = await postData('/api/login', { username, password });
    if (response.success) {
        localStorage.setItem('username', username);
        AppState.username = username;
        initializeApp();
    } else {
        alert('Đăng nhập thất bại: ' + response.message);
    }
}

async function handleRegister(e) {
    e.preventDefault();
    const username = document.getElementById('register-username').value;
    const password = document.getElementById('register-password').value;
    const response = await postData('/api/register', { username, password });
    alert(response.message);
    if (response.success) showRegisterForm(false);
}

function handleLogout() {
    localStorage.removeItem('username');
    window.location.reload();
}

function showAuthPage() {
    document.getElementById('auth-page').style.display = 'block';
    document.getElementById('app-container').style.display = 'none';
}

function showAppPage() {
    document.getElementById('auth-page').style.display = 'none';
    document.getElementById('app-container').style.display = 'block';
    document.querySelector('.header-actions').style.display = 'flex';
    setupAppListeners();
}

function showRegisterForm(show) {
    document.getElementById('login-form').style.display = show ? 'none' : 'block';
    document.getElementById('register-form').style.display = show ? 'block' : 'none';
}

function togglePopup(popupId, show) {
    const popup = document.getElementById(popupId);
    if (popup) show ? popup.classList.add('active') : popup.classList.remove('active');
}

async function postData(url = '', data = {}) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return response.json();
}
