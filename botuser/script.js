const API_BASE_URL = '';
const COIN_DATA_URL = 'http://35.240.146.86:5005/api/data';

const AppState = {
    isVip: false, vipLevel: null, vipExpiry: null, isBotRunning: false,
    username: null, pnl: 0, totalUsdt: 0, tradeHistory: []
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
    await fetchStatus();
    renderUI();
    setupAppListeners();
    setInterval(fetchStatus, 3000);
    fetchCoinData();
    setInterval(fetchCoinData, 5000);
    setInterval(updateVipTime, 1000);
}

async function fetchStatus() {
    try {
        const response = await postData('/api/status', { username: AppState.username });
        if (!response) throw new Error('Could not connect to bot server.');

        const lastRunningState = AppState.isBotRunning;
        const lastVipState = AppState.isVip;

        AppState.isVip = response.is_vip === 1;
        AppState.vipLevel = response.vip_level;
        AppState.vipExpiry = response.vip_expiry_timestamp;
        AppState.isBotRunning = response.isBotRunning;
        AppState.pnl = response.pnl;
        AppState.totalUsdt = response.totalUsdt;
        AppState.tradeHistory = response.tradeHistory || [];

        if (lastRunningState !== AppState.isBotRunning || lastVipState !== AppState.isVip) {
            renderUI();
        }
        updateVipPanel();
        checkVipExpiry();
    } catch (error) {
        console.error(error);
    }
}

function renderUI() {
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = '';
    if (AppState.isVip) {
        renderVipView(mainContent);
    } else {
        renderNonVipView(mainContent);
    }
}

function renderNonVipView(mainContent) {
    document.getElementById('vip-info-panel').style.display = 'none';
    const vipOptions = [
        { id: 'vip1', name: 'VIP 1', price: '29$', duration: '7 days' },
        { id: 'vip2', name: 'VIP 2', price: '99$', duration: '30 days' },
        { id: 'vip3', name: 'VIP 3', price: '999$', duration: '365 days' },
    ];
    vipOptions.forEach(vip => {
        const button = createButton(null, null, null, null, 'action-button vip-button');
        button.dataset.vipId = vip.id;
        button.innerHTML = `<h3>${vip.name}</h3><p>${vip.price} / ${vip.duration}</p>`;
        button.addEventListener('click', () => showVipPopup(vip));
        mainContent.appendChild(button);
    });
}

function renderVipView(mainContent) {
    const vipPanel = document.getElementById('vip-info-panel');
    vipPanel.style.display = 'flex';

    const startButton = createButton('start-btn', AppState.isBotRunning ? 'fa-stop-circle' : 'fa-play-circle', AppState.isBotRunning ? 'Stop Bot' : 'Start Bot', handleStartStopClick);
    if (AppState.isBotRunning) startButton.classList.add('stop-state');
    
    const historyFundingButton = createButton('history-funding-btn', 'fa-history', 'History Funding', () => showHistoryPopup('funding'));
    const historyStartButton = createButton('history-start-btn', 'fa-scroll', 'History Start', () => showHistoryPopup('start'));
    const supportButton = createButton('support-btn', 'fa-life-ring', 'Support', () => alert('Please contact support via Telegram.'));
    
    mainContent.append(startButton, historyFundingButton, historyStartButton, supportButton);
}

function createButton(id, icon, text, onClick, customClass = 'action-button') {
    const button = document.createElement('button');
    button.className = customClass;
    if (id) button.id = id;
    if (icon && text) button.innerHTML = `<i class="fas ${icon}"></i><span>${text}</span>`;
    if (onClick) button.addEventListener('click', onClick);
    return button;
}

function updateVipPanel() {
    if (document.getElementById('vip-user')) {
        document.getElementById('vip-user').textContent = AppState.username;
        document.getElementById('vip-usdt').textContent = AppState.totalUsdt.toFixed(2);
        document.getElementById('vip-pnl').textContent = AppState.pnl.toFixed(4);
    }
}

function updateVipTime() {
    if (AppState.isVip && AppState.vipExpiry && document.getElementById('vip-time')) {
        const remaining = AppState.vipExpiry - Date.now();
        const timeSpan = document.getElementById('vip-time');
        if (remaining > 0) {
            const d = Math.floor(remaining / 86400000), h = Math.floor((remaining % 86400000) / 3600000), m = Math.floor((remaining % 3600000) / 60000), s = Math.floor((remaining % 60000) / 1000);
            timeSpan.textContent = `${d}d ${h}h ${m}m ${s}s`;
        } else {
            timeSpan.textContent = 'Expired';
        }
    }
}

function checkVipExpiry() {
    if (AppState.isVip && AppState.vipExpiry && Date.now() > AppState.vipExpiry) {
        AppState.isVip = false;
        renderUI();
    }
}

function setupAppListeners() {
    document.getElementById('logout-btn').addEventListener('click', handleLogout);
    document.getElementById('settings-btn').addEventListener('click', () => togglePopup('settings-popup', true));
    document.querySelectorAll('.popup').forEach(popup => {
        popup.addEventListener('click', (e) => { if (e.target === popup) togglePopup(popup.id, false); });
        popup.querySelector('.popup-close-btn')?.addEventListener('click', () => togglePopup(popup.id, false));
    });
    document.getElementById('start-options-form').addEventListener('submit', handleStartBot);
    document.getElementById('settings-form').addEventListener('submit', handleSaveSettings);
}

async function handleStartStopClick() {
    if (AppState.isBotRunning) {
        await postData('/api/stop', { username: AppState.username });
    } else {
        togglePopup('start-options-popup', true);
    }
    await fetchStatus();
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
    if (!response.success) alert('Failed to start bot. Is another bot running or API keys invalid?');
    await fetchStatus();
}

async function handleSaveSettings(event) {
    event.preventDefault();
    const formData = new FormData(event.target);
    const settings = Object.fromEntries(formData.entries());
    const response = await postData('/api/save-settings', { username: AppState.username, settings });
    alert(response.message);
    if(response.success) togglePopup('settings-popup', false);
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

async function fetchCoinData() {
    if (!AppState.isVip) return;
    try {
        const response = await fetch(COIN_DATA_URL);
        const data = await response.json();
        const tableBody = document.getElementById('predicted-coin-body');
        tableBody.innerHTML = '';
        if (data && data.arbitrageData && data.arbitrageData.length > 0) {
            data.arbitrageData.slice(0, 5).forEach(c => {
                tableBody.innerHTML += `<tr><td>${c.coin}</td><td>${c.commonLeverage}x</td><td>${c.exchanges}</td><td>${new Date(c.nextFundingTime).toLocaleTimeString('vi-VN')}</td><td>${c.volume24h.toLocaleString()}</td></tr>`;
            });
        } else {
            tableBody.innerHTML = '<tr><td colspan="5">No data available.</td></tr>';
        }
    } catch (error) {
        console.error("Failed to fetch coin data:", error);
    }
}

function setupAuthListeners() {
    document.getElementById('login-form').addEventListener('submit', handleLogin);
    document.getElementById('register-form').addEventListener('submit', handleRegister);
    document.getElementById('show-register').addEventListener('click', (e) => { e.preventDefault(); showRegisterForm(true); });
    document.getElementById('show-login').addEventListener('click', (e) => { e.preventDefault(); showRegisterForm(false); });
}
async function handleLogin(e) {
    e.preventDefault();
    const username = e.target.elements['login-username'].value;
    const password = e.target.elements['login-password'].value;
    const response = await postData('/api/login', { username, password });
    if (response.success) {
        localStorage.setItem('username', username);
        AppState.username = username;
        initializeApp();
    } else {
        alert('Login failed: ' + response.message);
    }
}
async function handleRegister(e) {
    e.preventDefault();
    const username = e.target.elements['register-username'].value;
    const password = e.target.elements['register-password'].value;
    const response = await postData('/api/register', { username, password });
    alert(response.message);
    if(response.success) showRegisterForm(false);
}
function handleLogout() {
    localStorage.removeItem('username');
    AppState.username = null;
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
}
function showRegisterForm(show) {
    document.getElementById('login-form').style.display = show ? 'none' : 'block';
    document.getElementById('register-form').style.display = show ? 'block' : 'none';
}
function togglePopup(popupId, show) {
    const popup = document.getElementById(popupId);
    if (popup) show ? popup.classList.add('active') : popup.classList.remove('active');
}
function showVipPopup(vip) {
    document.getElementById('vip-purchase-info').innerHTML = `<p>Thông tin VIP: <span>${vip.name} - ${vip.duration}</span></p><p>MONEY: <span>${vip.price}</span></p>`;
    togglePopup('vip-popup', true);
}
async function postData(url = '', data = {}) {
    const response = await fetch(API_BASE_URL + url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return response.json();
}
