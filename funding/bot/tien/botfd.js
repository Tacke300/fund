<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Arbitrage Bot Multi</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root {
            --bg-color: #000000;
            --card-bg: #111111;
            --binance-yellow: #F0B90B;
            --kucoin-green: #00D095;
            --text-color: #EAECEF;
            --danger: #F6465D;
            --border-color: #333;
        }

        body { font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: var(--bg-color); color: var(--text-color); margin: 0; padding: 15px; }

        .auth-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: #000; z-index: 2000; display: flex; justify-content: center; align-items: center; flex-direction: column; }
        .auth-box { background: #1a1a1a; padding: 30px; border-radius: 12px; border: 1px solid var(--binance-yellow); text-align: center; width: 300px; box-shadow: 0 0 20px rgba(240, 185, 11, 0.2); }
        .auth-box h2 { color: var(--binance-yellow); margin-bottom: 20px; }
        .auth-box input { width: 100%; padding: 12px; margin: 8px 0; background: #000; border: 1px solid #444; color: #fff; border-radius: 6px; font-size: 1rem; box-sizing: border-box; text-align: center; }
        .btn-auth { width: 100%; padding: 12px; background: var(--binance-yellow); color: #000; font-weight: bold; border: none; border-radius: 6px; cursor: pointer; font-size: 1rem; margin-top: 15px; }
        .link-text { color: #888; margin-top: 15px; font-size: 0.9rem; cursor: pointer; text-decoration: underline; }

        .header-container { background: #0a0a0a; padding: 15px; margin-bottom: 20px; border-bottom: 1px solid #222; display: flex; flex-direction: column; align-items: center; gap: 15px; }
        .logos-row { display: flex; align-items: center; gap: 30px; }
        .brand { display: flex; align-items: center; gap: 8px; font-weight: bold; font-size: 1.2rem; }
        .logo { height: 35px; }
        .logo-kucoin { height: 35px; filter: grayscale(100%) brightness(80%) sepia(100%) hue-rotate(100deg) saturate(500%); }
        .text-yellow { color: var(--binance-yellow); } .text-green { color: var(--kucoin-green); }
        .user-info-row { display: flex; align-items: center; gap: 15px; background: #1a1a1a; padding: 5px 20px; border-radius: 20px; font-size: 0.9rem; color: #ccc; border: 1px solid #333; }
        .logout-btn { color: var(--danger); cursor: pointer; font-weight: bold; font-size: 0.75rem; text-transform: uppercase; }
        .vip-badge { color: gold; font-weight: bold; border: 1px solid gold; padding: 0 5px; border-radius: 4px; font-size: 0.7rem; display: none; }

        .container { max-width: 1200px; margin: 0 auto; }
        .controls-bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; background: var(--card-bg); border: 1px solid #222; padding: 15px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 5px 15px rgba(0,0,0,0.3); }
        .hide-on-run.active { display: none !important; }
        .input-group { display: flex; align-items: center; gap: 8px; background: #000; padding: 8px 12px; border: 1px solid #444; border-radius: 4px; }
        input[type="number"], select { background: #222; border: 1px solid #444; color: var(--binance-yellow); padding: 5px; border-radius: 3px; text-align: center; font-weight: bold; }
        input[type="number"] { width: 60px; }
        
        .auto-bal-wrapper { display: flex; align-items: center; gap: 6px; position: relative; }
        .checkbox-label { cursor: pointer; font-size: 0.9rem; color: #ccc; display: flex; align-items: center; gap: 6px; }
        input[type="checkbox"] { accent-color: var(--kucoin-green); cursor: pointer; width: 16px; height: 16px; }

        .terms-group { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; color: #aaa; margin-right: 10px; }
        .terms-link { color: var(--binance-yellow); text-decoration: underline; cursor: pointer; }

        .btn { padding: 10px 20px; border: none; border-radius: 4px; font-weight: bold; cursor: pointer; text-transform: uppercase; white-space: nowrap; }
        .btn-config { background: #333; color: #fff; border: 1px solid #555; }
        .btn-start { background: var(--binance-yellow); color: #000; }
        .btn-start:disabled { background: #444; color: #888; cursor: not-allowed; opacity: 0.7; }
        .btn-stop { background: var(--danger); color: #fff; }
        .btn-vip { background: gold; color: #000; font-size: 0.7rem; padding: 5px 10px; display: inline-block; }

        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .card { background: var(--card-bg); border: 1px solid #222; border-radius: 12px; padding: 15px; box-shadow: 4px 4px 10px rgba(0,0,0,0.5); }
        .card h3 { margin: 0 0 10px 0; border-bottom: 1px solid #333; padding-bottom: 8px; color: var(--binance-yellow); font-size: 1rem; text-transform: uppercase; }

        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); z-index: 1000; justify-content: center; align-items: center; }
        .modal-content { background: #111; border: 2px solid var(--binance-yellow); padding: 20px; border-radius: 10px; width: 90%; max-width: 500px; max-height: 90vh; overflow-y: auto; }
        .form-row { margin-bottom: 12px; }
        .form-row label { display: block; margin-bottom: 4px; color: #aaa; font-size: 0.8rem; }
        .form-row input, .form-row select { width: 100%; padding: 10px; background: #222; border: 1px solid #444; color: #fff; box-sizing: border-box; font-family: monospace; }
        .btn-save { width: 100%; background: var(--kucoin-green); color: #000; margin-top: 10px; padding: 12px; border:none; font-weight:bold; cursor:pointer; }

        .terms-content { color: #ddd; font-size: 0.9rem; line-height: 1.6; text-align: left; }
        .terms-content h4 { color: var(--binance-yellow); margin-top: 15px; margin-bottom: 5px; }
        .terms-content ul { padding-left: 20px; margin: 0; }
        .terms-content li { margin-bottom: 5px; }

        table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-top: 10px; }
        th { text-align: left; color: #777; padding: 8px 5px; border-bottom: 1px solid #333; }
        td { padding: 8px 5px; border-bottom: 1px solid #222; }
        .text-pos { color: var(--kucoin-green); } .text-neg { color: var(--danger); }
        
        .opp-item { 
            background: #1a1a1a; 
            border: 1px solid #333; 
            border-radius: 8px; 
            padding: 12px; 
            margin-bottom: 12px; 
            transition: all 0.2s;
        }
        .opp-item:hover { border-color: var(--binance-yellow); background: #222; }
        .opp-row-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
        .opp-coin-name { font-size: 1.4rem; font-weight: 800; color: #fff; display: flex; align-items: center; gap: 8px; }
        .rank-badge { background: var(--binance-yellow); color: #000; font-size: 0.8rem; padding: 2px 6px; border-radius: 4px; font-weight: bold; }
        .opp-pnl { font-size: 1.2rem; font-weight: bold; color: var(--kucoin-green); text-shadow: 0 0 10px rgba(0, 208, 149, 0.2); }
        
        .opp-row-mid { display: flex; gap: 10px; margin-bottom: 10px; font-size: 0.85rem; }
        .tag { background: #333; padding: 4px 8px; border-radius: 4px; color: #ccc; border: 1px solid #444; display: flex; align-items: center; gap: 4px; }
        .tag-highlight { border-color: #666; color: #fff; }

        .opp-row-bot { display: flex; justify-content: space-between; align-items: center; font-size: 0.9rem; padding-top: 8px; border-top: 1px solid #333; color: #aaa; }
        .exec-timer { color: #fff; font-weight: bold; display: flex; align-items: center; gap: 5px; }

        .chart-controls { display: flex; gap: 5px; margin-bottom: 10px; justify-content: flex-end; }
        .chart-btn { background: #222; border: 1px solid #444; color: #aaa; padding: 4px 8px; font-size: 0.75rem; cursor: pointer; border-radius: 3px; }
        .chart-btn.active { background: var(--binance-yellow); color: #000; border-color: var(--binance-yellow); font-weight: bold; }

        .log-container { background: #000; border: 1px solid #333; height: 150px; overflow-y: scroll; padding: 10px; font-family: monospace; font-size: 0.8rem; margin-bottom: 20px; color: #aaa; }
        .log-line { margin-bottom: 2px; border-bottom: 1px solid #111; }
        .log-TRADE { color: var(--kucoin-green); }
        .log-ERROR { color: var(--danger); }
        .log-INFO { color: #aaa; }

        @media (max-width: 600px) {
            .brand { font-size: 0.9rem; } .logo, .logo-kucoin { height: 25px; }
            .controls-bar { flex-direction: column; align-items: stretch; }
            .input-group { justify-content: space-between; }
        }
    </style>
</head>
<body>

<div id="loginSection" class="auth-overlay">
    <div class="auth-box">
        <h2>LOGIN</h2>
        <input type="text" id="loginUser" placeholder="Username">
        <input type="password" id="loginPass" placeholder="Password">
        <button class="btn-auth" onclick="handleLogin()">LOGIN</button>
        <div class="link-text" onclick="showRegister()">Create New Account</div>
    </div>
</div>

<div id="registerSection" class="auth-overlay" style="display:none;">
    <div class="auth-box">
        <h2 style="color: var(--kucoin-green);">REGISTER</h2>
        <input type="text" id="regEmail" placeholder="Email">
        <input type="text" id="regUser" placeholder="Username">
        <input type="password" id="regPass1" placeholder="Password">
        <input type="password" id="regPass2" placeholder="Confirm Password">
        <button class="btn-auth" style="background: var(--kucoin-green);" onclick="handleRegister()">REGISTER</button>
        <div class="link-text" onclick="showLogin()">Back to Login</div>
    </div>
</div>

<div id="dashboardSection" style="display:none;">
    <div class="header-container">
        <div class="logos-row">
            <div class="brand"><img src="https://upload.wikimedia.org/wikipedia/commons/e/e8/Binance_Logo.svg" class="logo"><span class="text-yellow">BINANCE</span></div>
            <span style="color:#444; font-size:1.2rem;">✕</span>
            <div class="brand"><img src="https://cryptologos.cc/logos/kucoin-token-kcs-logo.png?v=025" class="logo-kucoin"><span class="text-green">KUCOIN</span></div>
        </div>
        <div class="user-info-row">
            <span id="userDisplay">User</span>
            <span id="vipBadge" class="vip-badge" style="display:none">VIP</span>
            <button id="upgradeBtn" class="btn-vip" onclick="upgradeVip()">UPGRADE VIP ($200/Mo)</button>
            <span class="logout-btn" onclick="logout()">LOGOUT ➔</span>
        </div>
    </div>

    <div class="container">
        <div class="controls-bar" id="controlsBar">
            <div class="input-group hide-on-run">
                <label style="margin-right:10px"><input type="radio" name="capMode" value="percent" checked> % Cap</label>
                <label><input type="radio" name="capMode" value="fixed"> Fixed $</label>
            </div>
            <div class="input-group hide-on-run" style="border-color: var(--binance-yellow);">
                <span style="color:#aaa">Value:</span><input type="number" id="capitalInput" value="1">
            </div>
            <div class="input-group hide-on-run">
                <span style="color:#aaa">Max Orders:</span>
                <select id="maxOppsSelect">
                    <option value="1">1</option>
                    <option value="2">2</option>
                    <option value="3" selected>3</option>
                </select>
            </div>
            
            <div class="auto-bal-wrapper hide-on-run">
                <label class="checkbox-label"><input type="checkbox" id="autoBalanceDisplay" onchange="updateAutoBalance()"> Auto-Balance</label>
            </div>

            <div style="flex-grow: 1;"></div>

            <button class="btn btn-config hide-on-run" onclick="openModal()">⚙️ Set Bot</button>

            <div class="terms-group hide-on-run">
                <input type="checkbox" id="termsCheck" onchange="checkTerms()">
                <label>Agree to <span class="terms-link" onclick="openTerms()">Terms & Disclaimer</span></label>
            </div>

            <button id="btnStart" class="btn btn-start" onclick="startBot()" disabled>▶ START</button>
            <button id="btnStop" class="btn btn-stop" onclick="stopBot()" style="display:none;">⏹ STOP</button>
            <div id="statusText" style="padding: 5px 10px; border-radius: 4px; background:#222; color:#777; font-weight:bold; font-size:0.8rem;">STOPPED</div>
        </div>
        
        <div class="grid">
            <div class="card">
                <h3>Wallet Balances</h3>
                <div id="balancesContent" style="min-height: 40px; padding-top:5px;"><span style="color:#555;">Waiting...</span></div>
            </div>
            <div class="card">
                <h3>Top Opportunities</h3>
                <div id="oppContent" style="padding: 0;"><span style="color:#555; padding: 10px; display:block;">Scanning...</span></div>
            </div>
        </div>

        <div class="card" style="margin-bottom: 20px;">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #333; padding-bottom:10px; margin-bottom:10px;">
                <h3 style="margin:0; border:none;">Balance Growth</h3>
                <div style="display:flex; align-items:center;">
                    <h3 id="totalPnlDisplay" style="color:#fff; margin:0 15px 0 0; font-size:0.9rem;">Total PnL: $0.00</h3>
                    <div class="chart-controls" style="margin:0;">
                        <button class="chart-btn active" onclick="updateChartTimeframe('24h', this)">24H</button>
                        <button class="chart-btn" onclick="updateChartTimeframe('7d', this)">7D</button>
                        <button class="chart-btn" onclick="updateChartTimeframe('30d', this)">30D</button>
                        <button class="chart-btn" onclick="updateChartTimeframe('all', this)">ALL</button>
                    </div>
                </div>
            </div>
            <div style="height: 300px; position: relative;">
                <canvas id="balanceChart"></canvas>
            </div>
        </div>

        <div class="card" style="margin-bottom: 20px;">
            <h3>📝 Live Logs</h3>
            <div id="logBox" class="log-container">Initializing...</div>
        </div>
    </div>
</div>

<div id="configModal" class="modal">
    <div class="modal-content">
        <div class="modal-header" style="display:flex; justify-content:space-between; margin-bottom:20px;">
            <h3 style="margin:0; color:#fff;">BOT SETUP</h3><span style="cursor: pointer; color:#666;" onclick="closeModal()">✕</span>
        </div>
        <div class="form-row"><label>Binance API Key</label><input type="text" id="cfgBinKey"></div>
        <div class="form-row"><label>Binance Secret</label><input type="text" id="cfgBinSec"></div>
        <div class="form-row"><label>Wallet Binance (APTOS)</label><input type="text" id="cfgBinWal"></div>
        <hr style="border-color: #333; margin: 15px 0;">
        <div class="form-row"><label>KuCoin API Key</label><input type="text" id="cfgKuKey"></div>
        <div class="form-row"><label>KuCoin Secret</label><input type="text" id="cfgKuSec"></div>
        <div class="form-row"><label>KuCoin Passphrase</label><input type="text" id="cfgKuPass"></div>
        <div class="form-row"><label>Wallet KuCoin (BEP20)</label><input type="text" id="cfgKuWal"></div>
        <button class="btn btn-save" onclick="saveConfig()">SAVE CONFIG</button>
    </div>
</div>

<div id="termsModal" class="modal">
    <div class="modal-content" style="border-color: var(--danger);">
        <div class="modal-header" style="display:flex; justify-content:space-between; margin-bottom:10px;">
            <h3 style="margin:0; color:var(--danger);">TERMS & DISCLAIMER</h3>
            <span style="cursor: pointer; color:#666;" onclick="document.getElementById('termsModal').style.display='none'">✕</span>
        </div>
        <div class="terms-content">
            <h4>High Market Risk:</h4>
            <p>Futures trading carries substantial market risk and high price volatility. You may lose all of your investment.</p>
            <h4>User Responsibility:</h4>
            <p>You are solely responsible for your investment decisions. Binance/KuCoin are not liable for any losses.</p>
            
            <h4>* Bot Management Fees:</h4>
            <p>We directly collect management fees from your account at the following rates:</p>
            <ul>
                <li><strong>Auto balance:</strong> 10$/ day</li>
                <li><strong>Standard:</strong> 5$/ day</li>
            </ul>
            <p style="color: #ff9800; font-style: italic;">Note: If the balance is insufficient to pay the fee, the bot will stop.</p>
            
            <h4>* VIP Upgrade:</h4>
            <p>To waive daily fees, you can upgrade to a VIP account for <strong>200$/ month</strong>.</p>
            <button class="btn-save" style="background: gold; color: #000; margin-top:10px;" onclick="upgradeVip()">CLICK HERE TO UPGRADE VIP ($200)</button>
        </div>
    </div>
</div>

<script>
    let currentUsername = localStorage.getItem('bot_username');
    let balanceChart = null;
    let chartTimeframe = '24h';
    let balanceHistoryData = [];
    let currentChartData = { bin: [], kuc: [] };

    function showLogin() { document.getElementById('registerSection').style.display='none'; document.getElementById('loginSection').style.display='flex'; }
    function showRegister() { document.getElementById('loginSection').style.display='none'; document.getElementById('registerSection').style.display='flex'; }
    function logout() { localStorage.removeItem('bot_username'); location.reload(); }

    function formatTime(ms) {
        if (ms < 0) return "00:00";
        const m = Math.floor(ms / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        return `${m}:${s < 10 ? '0'+s : s}`;
    }
    
    function formatCountDown(ms) {
        if (ms <= 0) return "00:00:00";
        const h = Math.floor(ms / (1000 * 60 * 60));
        const m = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
        const s = Math.floor((ms % (1000 * 60)) / 1000);
        return `${h}:${m < 10 ? '0'+m : m}:${s < 10 ? '0'+s : s}`;
    }

    async function handleRegister() {
        const res = await fetch('/bot-api/register', { method:'POST', body:JSON.stringify({username:document.getElementById('regUser').value, password:document.getElementById('regPass1').value, email:document.getElementById('regEmail').value}) });
        const data = await res.json();
        if(data.success) { alert("Registered!"); showLogin(); } else alert("Error");
    }
    async function handleLogin() {
        const res = await fetch('/bot-api/login', { method:'POST', body:JSON.stringify({username:document.getElementById('loginUser').value, password:document.getElementById('loginPass').value}) });
        const data = await res.json();
        if(data.success) { currentUsername=document.getElementById('loginUser').value; localStorage.setItem('bot_username', currentUsername); initApp(); } else alert("Login Failed");
    }
    if (currentUsername) initApp();

    function initApp() {
        document.querySelectorAll('.auth-overlay').forEach(e=>e.style.display='none');
        document.getElementById('dashboardSection').style.display='block';
        document.getElementById('userDisplay').innerText = currentUsername;
        loadInitConfig();
        initChart();
        updateUI(); 
    }

    async function apiCall(ep, method='GET', body) {
        try {
            const res = await fetch(ep, { method, headers: {'x-username':currentUsername}, body:body?JSON.stringify(body):undefined });
            if(res.status===401) logout();
            return await res.json();
        } catch(e) { return null; }
    }

    function openModal() { document.getElementById('configModal').style.display='flex'; }
    function closeModal() { document.getElementById('configModal').style.display='none'; }
    function openTerms() { document.getElementById('termsModal').style.display='flex'; }
    function checkTerms() {
        const t = document.getElementById('termsCheck').checked;
        const r = document.getElementById('statusText').innerText === 'RUNNING';
        document.getElementById('btnStart').disabled = r || !t;
    }

    async function loadInitConfig() {
        const c = await apiCall('/bot-api/config');
        if(c) {
            document.getElementById('autoBalanceDisplay').checked = c.autoBalance;
            if(c.maxOpps) document.getElementById('maxOppsSelect').value = c.maxOpps;
            updateVipButton(c.vipStatus);
        }
    }
    
    function updateVipButton(status) {
        const btn = document.getElementById('upgradeBtn');
        const badge = document.getElementById('vipBadge');
        if (status === 'vip' || status === 'vip_pro') {
            btn.style.display = 'none';
            badge.style.display = 'inline-block';
            badge.innerText = status === 'vip_pro' ? 'VIP PRO' : 'VIP';
        } else {
            btn.style.display = 'inline-block';
            badge.style.display = 'none';
        }
    }
    
    async function updateAutoBalance() { await apiCall('/bot-api/update-balance-config','POST', {autoBalance: document.getElementById('autoBalanceDisplay').checked}); }

    async function saveConfig() {
        const body = {
            binanceApiKey: document.getElementById('cfgBinKey').value, binanceApiSecret: document.getElementById('cfgBinSec').value, binanceDepositAddress: document.getElementById('cfgBinWal').value,
            kucoinApiKey: document.getElementById('cfgKuKey').value, kucoinApiSecret: document.getElementById('cfgKuSec').value, kucoinPassword: document.getElementById('cfgKuPass').value, kucoinDepositAddress: document.getElementById('cfgKuWal').value
        };
        await apiCall('/bot-api/save-config','POST', body);
        alert("Saved!"); closeModal(); loadInitConfig();
    }

    async function upgradeVip() {
        const r = await apiCall('/bot-api/upgrade-vip','POST');
        if(r.success) { alert("Upgrade successful! You are now a VIP."); loadInitConfig(); } 
        else alert("Failed: Insufficient balance on exchanges.");
    }

    async function startBot() {
        const btn = document.getElementById('btnStart');
        btn.disabled = true;
        btn.innerText = "STARTING...";
        
        try {
            const maxOpps = document.getElementById('maxOppsSelect').value;
            const res = await apiCall('/bot-api/start','POST', { 
                tradeConfig: {mode: document.querySelector('input[name="capMode"]:checked').value, value: document.getElementById('capitalInput').value}, 
                autoBalance: document.getElementById('autoBalanceDisplay').checked,
                maxOpps: maxOpps 
            });
            
            if(res && res.success) {
            } else {
                if (res && res.message === 'INSUFFICIENT_FEE_BALANCE') {
                    alert("Insufficient balance for bot fees! Please deposit more funds.");
                } else {
                    alert("Start failed.");
                }
                btn.disabled = false;
                btn.innerText = "▶ START";
            }
        } catch(e) {
            btn.disabled = false;
            btn.innerText = "▶ START";
        }
        updateUI();
    }

    async function stopBot() { 
        document.getElementById('btnStop').disabled = true;
        await apiCall('/bot-api/stop','POST'); 
        updateUI(); 
        document.getElementById('btnStop').disabled = false;
    }

    function initChart() {
        const ctx = document.getElementById('balanceChart').getContext('2d');
        balanceChart = new Chart(ctx, {
            type: 'line',
            data: { labels: [], datasets: [] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                tension: 0.4,
                interaction: { mode: 'index', intersect: false },
                animation: { duration: 0 },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        mode: 'index', intersect: false,
                        backgroundColor: 'rgba(0,0,0,0.9)',
                        titleColor: '#F0B90B',
                        bodyColor: '#fff',
                        borderColor: '#333',
                        borderWidth: 1,
                        callbacks: {
                            title: function(context) {
                                if (context[0]) return new Date(balanceHistoryData[context[0].dataIndex].time).toLocaleString();
                                return '';
                            },
                            label: function(context) { 
                                if (context.datasetIndex !== 0) return null;
                                const idx = context.dataIndex;
                                const b = currentChartData.bin[idx] || 0;
                                const k = currentChartData.kuc[idx] || 0;
                                const t = context.raw || 0;
                                return [`💰 Total: $${t.toFixed(2)}`, `🟡 Binance: $${b.toFixed(2)}`, `🟢 KuCoin: $${k.toFixed(2)}`];
                            } 
                        }
                    }
                },
                scales: {
                    x: { display: false },
                    y: { grid: { color: '#222' }, ticks: { color: '#666' } }
                }
            }
        });
    }

    function updateChartTimeframe(tf, btn) {
        chartTimeframe = tf;
        document.querySelectorAll('.chart-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderChart();
    }

    function renderChart() {
        if (!balanceHistoryData || !balanceHistoryData.length) return;
        
        const now = Date.now();
        let limit = 0;
        let downsampleInterval = 0;

        if (chartTimeframe === '24h') {
            limit = 24 * 60 * 60 * 1000;
        } else if (chartTimeframe === '7d') {
            limit = 7 * 24 * 60 * 60 * 1000;
            downsampleInterval = 60 * 60 * 1000; 
        } else if (chartTimeframe === '30d') {
            limit = 30 * 24 * 60 * 60 * 1000;
            downsampleInterval = 4 * 60 * 60 * 1000;
        } else if (chartTimeframe === 'all') {
            limit = 0;
            downsampleInterval = 24 * 60 * 60 * 1000;
        }
        
        let filtered = balanceHistoryData;
        if (limit > 0) filtered = balanceHistoryData.filter(d => (now - d.time) <= limit);

        if (downsampleInterval > 0 && filtered.length > 0) {
            const downsampled = [];
            let lastTime = 0;
            for (let i = 0; i < filtered.length; i++) {
                if (filtered[i].time - lastTime >= downsampleInterval) {
                    downsampled.push(filtered[i]);
                    lastTime = filtered[i].time;
                }
            }
            if (downsampled.length === 0 || downsampled[downsampled.length-1].time !== filtered[filtered.length-1].time) {
                downsampled.push(filtered[filtered.length-1]);
            }
            filtered = downsampled;
        }

        if (filtered.length === 0) return;

        const labels = filtered.map(d => {
            const date = new Date(d.time);
            return (chartTimeframe === '24h') ? date.toLocaleTimeString() : date.toLocaleString();
        });
        const totalData = filtered.map(d => d.total);
        currentChartData.bin = filtered.map(d => d.binance);
        currentChartData.kuc = filtered.map(d => d.kucoin);

        const startBal = totalData[0] || 0;
        const endBal = totalData[totalData.length - 1] || 0;
        const mainColor = endBal >= startBal ? '#00D095' : '#F6465D';

        balanceChart.data = {
            labels: labels,
            datasets: [{
                label: 'Total', data: totalData, borderColor: mainColor, backgroundColor: mainColor, borderWidth: 2, pointRadius: 0, pointHoverRadius: 6, fill: false
            }]
        };
        balanceChart.update();
    }

    let isUpdating = false;
    async function updateUI() {
        if(!currentUsername) return;
        if(isUpdating) return; 
        isUpdating = true;

        try {
            const d = await apiCall('/bot-api/status');
            
            if(d) {
                const run = d.botState === 'RUNNING';
                document.getElementById('btnStart').style.display = run ? 'none':'inline-block';
                document.getElementById('btnStart').disabled = run; 
                if(!run) document.getElementById('btnStart').innerText = "▶ START"; 
                
                document.getElementById('btnStop').style.display = run ? 'inline-block':'none';
                document.getElementById('statusText').innerText = run ? 'RUNNING' : 'STOPPED';
                document.getElementById('statusText').style.color = run ? '#00D095' : '#777';

                if(run) {
                    document.querySelectorAll('.hide-on-run').forEach(e=>e.classList.add('active'));
                    if (d.config && d.config.tradeConfig) {
                        if (d.config.tradeConfig.mode) {
                            const radio = document.querySelector(`input[name="capMode"][value="${d.config.tradeConfig.mode}"]`);
                            if(radio) radio.checked = true;
                        }
                        if (d.config.tradeConfig.value) document.getElementById('capitalInput').value = d.config.tradeConfig.value;
                    }
                    if (d.config && d.config.maxOpps) document.getElementById('maxOppsSelect').value = d.config.maxOpps;
                    if (d.config && d.config.autoBalance !== undefined) document.getElementById('autoBalanceDisplay').checked = d.config.autoBalance;
                }
                else { 
                    document.querySelectorAll('.hide-on-run').forEach(e=>e.classList.remove('active')); 
                    checkTerms(); 
                }

                updateVipButton(d.vipStatus);
                if(d.config && d.config.maxOpps && !run) document.getElementById('maxOppsSelect').value = d.config.maxOpps;

                if (d.logs && d.logs.length) {
                    const logHtml = d.logs.map(l => {
                        let cls = 'log-INFO';
                        if(l.includes('TRADE')) cls = 'log-TRADE';
                        if(l.includes('ERROR')) cls = 'log-ERROR';
                        return `<div class="log-line ${cls}">${l}</div>`;
                    }).join('');
                    document.getElementById('logBox').innerHTML = logHtml;
                }

                if (d.totalPnl !== undefined) {
                    const c = d.totalPnl >= 0 ? 'var(--kucoin-green)' : 'var(--danger)';
                    document.getElementById('totalPnlDisplay').innerHTML = `Total PnL: <span style="color:${c}">${d.totalPnl.toFixed(2)}$</span>`;
                }

                let bH = '';
                if(d.balances) {
                    for(let k in d.balances) bH += `<div style="display:flex;justify-content:space-between;border-bottom:1px solid #333;padding:5px"><span>${k.includes('binance')?'BINANCE':'KUCOIN'}</span><span>${d.balances[k].available.toFixed(2)}$</span></div>`;
                }
                document.getElementById('balancesContent').innerHTML = bH || '<span style="color:#555;">No Data</span>';

                if (d.balanceHistory && Array.isArray(d.balanceHistory) && d.balanceHistory.length !== balanceHistoryData.length) {
                    balanceHistoryData = d.balanceHistory;
                    renderChart();
                }

                const opps = d.bestPotentialOpportunityForDisplay;
                if (Array.isArray(opps) && opps.length > 0) {
                    let html = '';
                    const delays = ['59:00', '59:25', '59:45'];
                    const now = Date.now();
                    opps.forEach((op, idx) => {
                        const timeLeft = op.nextFundingTime ? (op.nextFundingTime - now) : 0;
                        const timerText = timeLeft > 0 ? formatCountDown(timeLeft) : "--:--:--";
                        const sExName = op.details.shortExchange.includes('binance') ? 'BIN' : 'KUC';
                        const lExName = op.details.longExchange.includes('binance') ? 'BIN' : 'KUC';
                        const sColor = sExName === 'BIN' ? 'var(--binance-yellow)' : 'var(--kucoin-green)';
                        const lColor = lExName === 'BIN' ? 'var(--binance-yellow)' : 'var(--kucoin-green)';
                        const executeTime = delays[idx] || '';
                        const leverage = op.commonLeverage || 1;

                        html += `
                        <div class="opp-item">
                            <div class="opp-row-top">
                                <div class="opp-coin-name"><span class="rank-badge">#${idx+1}</span> ${op.coin}</div>
                                <div class="opp-pnl">+${op.estimatedPnl.toFixed(2)}%</div>
                            </div>
                            <div class="opp-row-mid">
                                <div class="tag tag-highlight">Lev: x${leverage}</div>
                                <div class="tag">Funding: ⏳ ${timerText}</div>
                            </div>
                            <div class="opp-row-bot">
                                <div><span style="color:${sColor}">S: ${sExName}</span> ⚡ <span style="color:${lColor}">L: ${lExName}</span></div>
                                <div class="exec-timer">⏰ Exec: ${executeTime}</div>
                            </div>
                        </div>`;
                    });
                    document.getElementById('oppContent').innerHTML = html;
                } else {
                    document.getElementById('oppContent').innerHTML = `<span style="color:#555; padding: 10px; display:block;">Scanning...</span>`;
                }
            }
        } catch(e) {
            console.log("UI Update Err:", e);
        } finally {
            isUpdating = false;
            setTimeout(updateUI, 1000);
        }
    }
</script>
</body>
</html>
