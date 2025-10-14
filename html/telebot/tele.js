// --- CONFIG & STATE MANAGEMENT ---
const API_BASE_URL = '/bot-api'; // Giả sử API của bạn chạy trên cùng domain
const COIN_DATA_URL = 'http://35.240.146.86:5005/api/data'; // Địa chỉ IP lấy dữ liệu coin

// State object to hold the application's current state
const AppState = {
    isVip: false,
    vipLevel: null,
    vipExpiry: null,
    isBotRunning: false,
    username: null,
    pnl: 0,
    totalUsdt: 0,
    vipPanelVisible: false, // For new VIPs to click "Start Now"
};

// --- DOM ELEMENTS ---
const mainContent = document.getElementById('main-content');
const vipInfoPanel = document.getElementById('vip-info-panel');
const allPopups = document.querySelectorAll('.popup');

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    // 1. Check Login Status
    AppState.username = localStorage.getItem('username');
    if (!AppState.username) {
        alert('Vui lòng đăng nhập để tiếp tục.');
        window.location.href = 'reg-log.html'; // Redirect to your login page
        return;
    }

    // 2. Load and Check VIP Status from localStorage
    loadVipStatus();
    checkVipExpiry();

    // 3. Initial UI Render
    renderUI();

    // 4. Attach all event listeners
    setupEventListeners();

    // 5. Start background tasks
    setInterval(updateVipTime, 1000);
    setInterval(checkVipExpiry, 60000); // Check expiry every minute
    fetchCoinData();
    setInterval(fetchCoinData, 5000); // Refresh coin data every 5s
});

// --- STATE & LOCALSTORAGE FUNCTIONS ---
function loadVipStatus() {
    AppState.isVip = localStorage.getItem('is_vip') === 'true';
    AppState.vipLevel = localStorage.getItem('vip_level');
    AppState.vipExpiry = parseInt(localStorage.getItem('vip_expiry_timestamp'), 10);
    AppState.vipPanelVisible = localStorage.getItem('vip_panel_visible') === 'true';
    // Load other user data if available
    AppState.pnl = parseFloat(localStorage.getItem('pnl') || 0);
    AppState.totalUsdt = parseFloat(localStorage.getItem('total_usdt') || 0);
}

function saveVipStatus() {
    localStorage.setItem('is_vip', AppState.isVip);
    localStorage.setItem('vip_level', AppState.vipLevel);
    localStorage.setItem('vip_expiry_timestamp', AppState.vipExpiry);
    localStorage.setItem('vip_panel_visible', AppState.vipPanelVisible);
}

function checkVipExpiry() {
    if (AppState.isVip && AppState.vipExpiry && Date.now() > AppState.vipExpiry) {
        alert('Gói VIP của bạn đã hết hạn.');
        AppState.isVip = false;
        AppState.vipLevel = null;
        AppState.vipExpiry = null;
        AppState.vipPanelVisible = false;
        saveVipStatus();
        renderUI();
    }
}

// --- UI RENDERING ---
function renderUI() {
    mainContent.innerHTML = ''; // Clear current buttons
    if (AppState.isVip) {
        renderVipView();
    } else {
        renderNonVipView();
    }
}

function renderNonVipView() {
    vipInfoPanel.style.display = 'none';

    const vipOptions = [
        { id: 'vip1', name: 'VIP 1', price: '29$', duration: '7 days' },
        { id: 'vip2', name: 'VIP 2', price: '99$', duration: '30 days' },
        { id: 'vip3', name: 'VIP 3', price: '999$', duration: '365 days' },
    ];

    vipOptions.forEach(vip => {
        const button = document.createElement('button');
        button.className = 'action-button vip-button';
        button.dataset.vipId = vip.id;
        button.innerHTML = `
            <h3>${vip.name}</h3>
            <p>${vip.price} / ${vip.duration}</p>
        `;
        button.addEventListener('click', () => showVipPopup(vip));
        mainContent.appendChild(button);
    });
}

function renderVipView() {
    if (!AppState.vipPanelVisible) {
        const startNowButton = createButton(
            'start-now-btn', 'fa-rocket', 'Start Now',
            () => {
                AppState.vipPanelVisible = true;
                localStorage.setItem('vip_panel_visible', 'true');
                renderUI();
            }
        );
        mainContent.appendChild(startNowButton);
        vipInfoPanel.style.display = 'none';

    } else {
        updateVipPanel();
        vipInfoPanel.style.display = 'flex';

        const startButton = createButton(
            'start-btn', AppState.isBotRunning ? 'fa-stop-circle' : 'fa-play-circle',
            AppState.isBotRunning ? 'Stop Bot' : 'Start Bot',
            handleStartStopClick
        );
        if(AppState.isBotRunning) startButton.classList.add('stop-state');

        const historyFundingButton = createButton('history-funding-btn', 'fa-history', 'History Funding', () => showHistoryPopup('funding'));
        const historyStartButton = createButton('history-start-btn', 'fa-scroll', 'History Start', () => showHistoryPopup('start'));
        const supportButton = createButton('support-btn', 'fa-life-ring', 'Support', () => { /* Add support logic */ });

        mainContent.append(startButton, historyFundingButton, historyStartButton, supportButton);
    }
}

function createButton(id, iconClass, text, onClick) {
    const button = document.createElement('button');
    button.className = 'action-button';
    button.id = id;
    button.innerHTML = `<i class="fas ${iconClass}"></i><span>${text}</span>`;
    button.addEventListener('click', onClick);
    return button;
}

function updateVipPanel() {
    document.getElementById('vip-user').textContent = AppState.username;
    document.getElementById('vip-usdt').textContent = AppState.totalUsdt.toFixed(2);
    document.getElementById('vip-pnl').textContent = AppState.pnl.toFixed(2);
    updateVipTime();
}

function updateVipTime() {
    if (AppState.isVip && AppState.vipExpiry) {
        const remaining = AppState.vipExpiry - Date.now();
        if (remaining > 0) {
            const days = Math.floor(remaining / (1000 * 60 * 60 * 24));
            const hours = Math.floor((remaining / (1000 * 60 * 60)) % 24);
            const minutes = Math.floor((remaining / 1000 / 60) % 60);
            const seconds = Math.floor((remaining / 1000) % 60);
            document.getElementById('vip-time').textContent = `${days}d ${hours}h ${minutes}m ${seconds}s`;
        } else {
            document.getElementById('vip-time').textContent = 'Expired';
        }
    }
}

// --- EVENT LISTENERS & HANDLERS ---
function setupEventListeners() {
    // Header Buttons
    document.getElementById('logout-btn').addEventListener('click', handleLogout);
    document.getElementById('settings-btn').addEventListener('click', () => togglePopup('settings-popup', true));

    // Close Popup Buttons
    allPopups.forEach(popup => {
        popup.addEventListener('click', (event) => {
            if (event.target === popup) { // Click on overlay
                togglePopup(popup.id, false);
            }
        });
        popup.querySelector('.popup-close-btn')?.addEventListener('click', () => togglePopup(popup.id, false));
    });

    // Forms
    document.getElementById('start-options-form').addEventListener('submit', handleStartBot);
    // document.getElementById('settings-form').addEventListener('submit', handleSaveSettings);
}

function handleLogout() {
    localStorage.clear(); // Clear all user data
    window.location.href = 'reg-log.html';
}

function handleStartStopClick() {
    if (AppState.isBotRunning) {
        // Stop the bot
        // Mock API call
        console.log('Stopping bot...');
        // fetch(`${API_BASE_URL}/stop`, { method: 'POST' })
        //     .then(res => res.json())
        //     .then(data => {
        //         if(data.success) {
        //             AppState.isBotRunning = false;
        //             renderUI();
        //             alert('Bot stopped successfully.');
        //         }
        //     });
        // For demonstration:
        AppState.isBotRunning = false;
        renderUI();
        alert('Bot stopped successfully.');


    } else {
        // Show start options popup
        togglePopup('start-options-popup', true);
    }
}

function handleStartBot(event) {
    event.preventDefault();
    const marginType = event.target.elements['margin-type'].value;
    const marginValue = event.target.elements['margin-value'].value;

    if (!marginValue || marginValue <= 0) {
        alert('Vui lòng nhập giá trị hợp lệ.');
        return;
    }

    const options = { marginType, marginValue };
    console.log('Starting bot with options:', options);

    // Mock API call to start the bot
    // fetch(`${API_BASE_URL}/start`, {
    //     method: 'POST',
    //     headers: { 'Content-Type': 'application/json' },
    //     body: JSON.stringify(options)
    // }).then(res => res.json()).then(data => {
    //     if(data.success) {
    //         AppState.isBotRunning = true;
    //         renderUI();
    //         togglePopup('start-options-popup', false);
    //         alert('Bot started successfully!');
    //     }
    // });
    // For demonstration:
    AppState.isBotRunning = true;
    renderUI();
    togglePopup('start-options-popup', false);
    alert('Bot started successfully!');
}


// --- POPUP MANAGEMENT ---
function togglePopup(popupId, show) {
    const popup = document.getElementById(popupId);
    if (popup) {
        if (show) {
            popup.classList.add('active');
        } else {
            popup.classList.remove('active');
        }
    }
}

function showVipPopup(vip) {
    const infoDiv = document.getElementById('vip-purchase-info');
    infoDiv.innerHTML = `
        <p>Thông tin VIP: <span>${vip.name} - ${vip.duration}</span></p>
        <p>MONEY: <span>${vip.price}</span></p>
    `;
    togglePopup('vip-popup', true);
}

function showHistoryPopup(type) {
    const title = document.getElementById('history-title');
    const head = document.getElementById('history-table-head');
    const body = document.getElementById('history-table-body');
    
    // Clear previous data
    head.innerHTML = '';
    body.innerHTML = '';

    // Mock data, replace with actual API call
    const mockStartHistory = [
        { coin: 'BTC/USDT', platform: 'Binance/OKX', lev: 20, diff: '0.075%', margin: 100, pnl: 1.5 },
        { coin: 'ETH/USDT', platform: 'Bitget/Kucoin', lev: 20, diff: '0.062%', margin: 50, pnl: -0.5 },
    ];
    const mockFundingHistory = [
        { coin: 'BTC/USDT', platform: 'Binance/OKX', lev: 20, diff: '0.075%', pnl: 1.2 },
        { coin: 'ETH/USDT', platform: 'Bitget/Kucoin', lev: 20, diff: '0.062%', pnl: 0.8 },
    ];

    if (type === 'start') {
        title.textContent = 'History Start';
        head.innerHTML = `<tr><th>Coin</th><th>Platform</th><th>Lev</th><th>Diff</th><th>Margin</th><th>PNL</th></tr>`;
        mockStartHistory.forEach(row => {
            const pnlClass = row.pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
            body.innerHTML += `<tr>
                <td>${row.coin}</td>
                <td>${row.platform}</td>
                <td>${row.lev}x</td>
                <td>${row.diff}</td>
                <td>$${row.margin.toFixed(2)}</td>
                <td class="${pnlClass}">${row.pnl.toFixed(2)}</td>
            </tr>`;
        });
    } else { // funding
        title.textContent = 'History Funding';
        head.innerHTML = `<tr><th>Coin</th><th>Platform</th><th>Lev</th><th>Diff</th><th>Est. PNL</th></tr>`;
        mockFundingHistory.forEach(row => {
             const pnlClass = row.pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
            body.innerHTML += `<tr>
                <td>${row.coin}</td>
                <td>${row.platform}</td>
                <td>${row.lev}x</td>
                <td>${row.diff}</td>
                <td class="${pnlClass}">${row.pnl.toFixed(2)}</td>
            </tr>`;
        });
    }

    togglePopup('history-popup', true);
}


// --- API DATA FETCHING ---
async function fetchCoinData() {
    if (!AppState.isVip || !AppState.vipPanelVisible) return;
    try {
        const response = await fetch(COIN_DATA_URL);
        if (!response.ok) throw new Error('Network response was not ok');
        const data = await response.json();
        
        const tableBody = document.getElementById('predicted-coin-body');
        tableBody.innerHTML = ''; // Clear old data

        if (data && data.arbitrageData && data.arbitrageData.length > 0) {
            const top5 = data.arbitrageData.slice(0, 5); // Display top 5 opportunities
            top5.forEach(coin => {
                const fundingTime = new Date(coin.nextFundingTime).toLocaleTimeString('vi-VN');
                tableBody.innerHTML += `
                    <tr>
                        <td>${coin.coin}</td>
                        <td>${coin.commonLeverage}x</td>
                        <td>${coin.exchanges}</td>
                        <td>${fundingTime}</td>
                        <td>${coin.volume24h.toLocaleString()}</td>
                    </tr>
                `;
            });
        } else {
             tableBody.innerHTML = '<tr><td colspan="5">No data available.</td></tr>';
        }

    } catch (error) {
        console.error("Failed to fetch coin data:", error);
        document.getElementById('predicted-coin-body').innerHTML = '<tr><td colspan="5">Error loading data.</td></tr>';
    }
}
