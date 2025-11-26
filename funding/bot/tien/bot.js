const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

// [IMPORT VÍ ADMIN]
let adminWallets = {};
let fallbackBalance = {};
try {
    const balanceModule = require('./balance.js');
    if (balanceModule && balanceModule.usdtDepositAddressesByNetwork) {
        fallbackBalance = balanceModule.usdtDepositAddressesByNetwork;
        adminWallets = balanceModule.usdtDepositAddressesByNetwork;
    }
} catch (e) { console.log("[WARN] Không tìm thấy file balance.js"); }

// [GLOBAL CONFIG]
const BOT_PORT = 2025;
const SERVER_DATA_URL = 'http://localhost:5005/api/data';
const USER_DATA_DIR = path.join(__dirname, 'user_data');
if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR);

// [CONSTANTS]
const MIN_PNL_PERCENTAGE = 1;
const MIN_COLLATERAL_FOR_TRADE = 0.05; 
const BLACKLISTED_COINS = ['GAIBUSDT', 'AIAUSDT', '42USDT', 'WAVESUSDT'];
const FUND_ARRIVAL_TOLERANCE = 1; 

// [FEE CONFIG]
const FEE_AUTO_ON = 10;
const FEE_AUTO_OFF = 5;
const FEE_VIP_MONTHLY = 200;
const FEE_CHECK_DELAY = 60000; // 1 phút (60s)

// [TP/SL CONFIG]
const SL_PERCENTAGE = 95;  
const TP_PERCENTAGE = 135; 

function getSafeFileName(username) {
    return username.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class BotEngine {
    constructor(username) {
        this.username = username;
        const safeName = getSafeFileName(username);
        this.configFile = path.join(USER_DATA_DIR, `${safeName}_config.json`);
        this.historyFile = path.join(USER_DATA_DIR, `${safeName}_history.json`);
        
        this.state = 'STOPPED';
        this.capitalManagementState = 'IDLE';
        this.loopId = null;
        this.feeTimer = null; // Timer cho việc thu phí
        
        this.lastScanTime = 0;
        this.lastBalCheckTime = 0;
        
        this.balances = {};
        this.history = [];
        this.activeTrades = [];
        this.candidates = [];
        this.opp = null;      
        this.lockedOpp = null;

        this.tradeConfig = { mode: 'percent', value: 50 };
        
        this.config = {
            username: username,
            password: '',
            binanceApiKey: '', binanceApiSecret: '', binanceDepositAddress: '',
            kucoinApiKey: '', kucoinApiSecret: '', kucoinPassword: '', kucoinDepositAddress: '',
            autoBalance: false,
            vipStatus: 'none', 
            vipExpiry: 0,
            lastFeePaidDate: '',
            savedBinanceFut: 0,
            savedKucoinFut: 0,
            savedTotalAssets: 0
        };
        
        this.exchanges = {};
        this.loadConfig();
        this.loadHistory();
    }

    log(type, msg) {
        const allowedTypes = ['error', 'trade', 'result', 'fee', 'vip', 'transfer', 'info', 'warn', 'pm2'];
        if (!allowedTypes.includes(type)) return;
        const t = new Date().toLocaleTimeString('vi-VN', { hour12: false });
        
        // Log đặc biệt để PM2 bắt (nếu cần filter logs)
        if (type === 'pm2') {
            console.error(`[${t}] [USER: ${this.username}] [PM2_ALERT] ${msg}`);
        } else {
            console.log(`[${t}] [USER: ${this.username}] [${type.toUpperCase()}] ${msg}`);
        }
    }

    loadConfig() { try { if (fs.existsSync(this.configFile)) { const saved = JSON.parse(fs.readFileSync(this.configFile, 'utf8')); this.config = { ...this.config, ...saved }; } } catch (e) {} }
    saveConfig(newConfig = {}) { for (let k in newConfig) if (newConfig[k] !== undefined) this.config[k] = newConfig[k]; fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2)); }
    loadHistory() { try { if (fs.existsSync(this.historyFile)) this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8')); } catch(e) {} }
    saveHistory(trade) { this.history.unshift(trade); if(this.history.length > 50) this.history = this.history.slice(0,50); fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2)); }

    // --- LOGIC MẠNG LƯỚI & VÍ ADMIN (MỚI) ---
    getWithdrawParams(exchangeId, targetNetwork) {
        const net = targetNetwork.toUpperCase();
        if (exchangeId.includes('binance')) {
            if (net === 'BEP20' || net === 'BSC') return { network: 'BSC' };
        }
        if (exchangeId.includes('kucoin')) {
            // Kucoin gửi APTOS
            if (net === 'APTOS' || net === 'APT') return { network: 'APT' };
            // Fallback BEP20
            if (net === 'BEP20' || net === 'BSC') return { network: 'BEP20' }; 
        }
        return { network: net };
    }

    getAdminFeeWallet(sourceExchangeId) {
        if (!adminWallets) return null;
        // Từ Binance (BEP20) -> Admin nhận Kucoin (BEP20)
        if (sourceExchangeId === 'binanceusdm') return { address: adminWallets['kucoin']?.['BEP20'], network: 'BEP20' };
        // Từ Kucoin (APTOS) -> Admin nhận Binance (APT)
        else {
            const aptAddr = adminWallets['binance']?.['APT'] || adminWallets['binance']?.['APTOS'];
            return { address: aptAddr, network: 'APT' };
        }
    }

    getUserDepositAddress(targetExchangeId) {
        if (targetExchangeId === 'binanceusdm' && this.config.binanceDepositAddress) return { address: this.config.binanceDepositAddress, network: 'BEP20' };
        if (targetExchangeId === 'kucoinfutures' && this.config.kucoinDepositAddress) return { address: this.config.kucoinDepositAddress, network: 'BEP20' };
        let k = targetExchangeId === 'binanceusdm' ? 'binance' : 'kucoin';
        let n = 'BEP20'; 
        if (fallbackBalance[k]?.[n]) return { address: fallbackBalance[k][n], network: n };
        return null;
    }

    async initExchanges() {
        const cfg = this.config;
        this.exchanges = {}; this.balances = {};
        try {
            if (cfg.binanceApiKey) {
                this.exchanges['binanceusdm'] = new ccxt.binanceusdm({ apiKey: cfg.binanceApiKey, secret: cfg.binanceApiSecret, enableRateLimit:true, options: { defaultType: 'swap' } });
                this.exchanges['binance'] = new ccxt.binance({ apiKey: cfg.binanceApiKey, secret: cfg.binanceApiSecret, enableRateLimit:true });
                await this.exchanges['binanceusdm'].loadMarkets();
            }
            if (cfg.kucoinApiKey) {
                this.exchanges['kucoinfutures'] = new ccxt.kucoinfutures({ apiKey: cfg.kucoinApiKey, secret: cfg.kucoinApiSecret, password: cfg.kucoinPassword, enableRateLimit:true });
                this.exchanges['kucoin'] = new ccxt.kucoin({ apiKey: cfg.kucoinApiKey, secret: cfg.kucoinApiSecret, password: cfg.kucoinPassword, enableRateLimit:true });
                await this.exchanges['kucoinfutures'].loadMarkets();
            }
        } catch(e) { this.log('error', `Init Fail: ${e.message}`); }
    }

    async fetchBalances() {
        for (const id of ['binanceusdm', 'kucoinfutures']) {
            if (!this.exchanges[id]) { this.balances[id] = { available: 0, total: 0 }; continue; }
            try {
                const bal = await this.exchanges[id].fetchBalance({ type: 'future' });
                this.balances[id] = { available: bal.free.USDT || 0, total: bal.total.USDT || 0 };
            } catch (e) { this.balances[id] = { available: 0, total: 0 }; }
        }
        return this.balances;
    }

    // --- FEE PAYMENT & VERIFICATION ---
    async performWithdrawalSimple(sourceId, amount, targetInfo) {
        const sourceEx = this.exchanges[sourceId];
        const wEx = sourceId === 'binanceusdm' ? this.exchanges['binance'] : this.exchanges['kucoin']; 
        try {
            let from = 'future';
            let to = sourceId === 'binanceusdm' ? 'spot' : 'main';
            await sourceEx.transfer('USDT', amount, from, to);
            await sleep(2000);
            const params = this.getWithdrawParams(sourceId, targetInfo.network);
            await wEx.withdraw('USDT', amount, targetInfo.address, undefined, params);
            return true;
        } catch (e) { 
            this.log('error', `Rút tiền thất bại (${sourceId}): ${e.message}`);
            return false; 
        }
    }

    // Hàm xử lý phí (bao gồm trì hoãn, thanh toán, verify)
    async processFeeSequence() {
        this.log('info', `⏳ Bắt đầu quy trình thu phí sau 1 phút khởi động...`);
        
        // 1. Kiểm tra trạng thái VIP/Ngày
        this.loadConfig();
        const todayUTC = new Date().toISOString().split('T')[0];
        if (this.config.lastFeePaidDate === todayUTC && this.config.vipStatus !== 'none') {
            this.log('info', '✅ Đã thanh toán phí hôm nay/VIP. Bỏ qua.');
            return;
        }

        const fee = this.config.autoBalance ? FEE_AUTO_ON : FEE_AUTO_OFF;
        
        // 2. Snapshot số dư TRƯỚC khi trừ (Dùng Total để ít biến động hơn Available nếu đang trade)
        await this.fetchBalances();
        const preBinance = this.balances['binanceusdm']?.total || 0;
        const preKucoin = this.balances['kucoinfutures']?.total || 0;
        
        this.log('fee', `🔍 Checking balance for fee: ${fee}$ (Pre-B: ${preBinance.toFixed(1)}$, Pre-K: ${preKucoin.toFixed(1)}$)`);

        // 3. Thực hiện thanh toán
        let paid = false;
        let paidSource = '';
        const safetyBuffer = 1;

        // Ưu tiên Kucoin (APT) -> Binance
        if (this.balances['kucoinfutures']?.available >= fee + safetyBuffer) {
            const adminInfo = this.getAdminFeeWallet('kucoinfutures');
            if (adminInfo) {
                this.log('fee', `💸 Đang trừ phí từ Kucoin (mạng APTOS)...`);
                paid = await this.performWithdrawalSimple('kucoinfutures', fee, adminInfo);
                paidSource = 'kucoin';
            }
        } 
        // Sau đó đến Binance (BEP20) -> Kucoin
        else if (this.balances['binanceusdm']?.available >= fee + safetyBuffer) {
            const adminInfo = this.getAdminFeeWallet('binanceusdm');
            if (adminInfo) {
                this.log('fee', `💸 Đang trừ phí từ Binance (mạng BEP20)...`);
                paid = await this.performWithdrawalSimple('binanceusdm', fee, adminInfo);
                paidSource = 'binance';
            }
        }

        // 4. Xử lý kết quả thanh toán
        if (paid) {
            // Update Config ngay
            this.config.lastFeePaidDate = todayUTC;
            this.saveConfig();
            this.log('fee', `✅ Thanh toán thành công! Bot tiếp tục chạy.`);

            // 5. VERIFICATION (Check chéo lại số dư sau 30s)
            // Chỉ log cảnh báo, không dừng bot
            setTimeout(async () => {
                this.log('info', '🕵️ Đang kiểm tra đối chiếu số dư (Verification)...');
                await this.fetchBalances();
                const postBinance = this.balances['binanceusdm']?.total || 0;
                const postKucoin = this.balances['kucoinfutures']?.total || 0;

                let delta = 0;
                if (paidSource === 'kucoin') delta = preKucoin - postKucoin;
                else delta = preBinance - postBinance;

                // Cho phép chênh lệch 1-2$ (Phí + Gas)
                const expectedDrop = fee; 
                const tolerance = 2; // 2$

                const diff = Math.abs(delta - expectedDrop);
                const isVerified = diff <= tolerance;

                this.log('info', `📊 Verify Data: Paid Source=${paidSource}, Delta=${delta.toFixed(2)}$, Expected=${expectedDrop}$`);

                if (isVerified) {
                    this.log('info', `✅ Verification Passed: Số dư giảm đúng với mức phí.`);
                } else {
                    // Logic riêng cho user monkey_d_luffy hoặc bất kỳ user nào
                    if (this.username === 'monkey_d_luffy' || this.username === 'luffy') {
                        this.log('pm2', `⚠️ WARNING: User ${this.username} đã thanh toán nhưng số dư không giảm đúng mức! (Delta: ${delta.toFixed(2)}, Fee: ${fee})`);
                    } else {
                        this.log('warn', `⚠️ Verification Failed: Số dư giảm không khớp (Delta: ${delta.toFixed(2)} vs Fee: ${fee}). Check ví admin.`);
                    }
                    // QUAN TRỌNG: Bot vẫn chạy bình thường, không gọi this.stop()
                }
            }, 30000); // Đợi 30s sau khi báo paid true để blockchain update

        } else {
            this.log('error', `❌ Không thể thu phí (Không đủ tiền hoặc lỗi mạng). Dừng bot.`);
            this.stop();
        }
    }

    // ... (Giữ nguyên các hàm snapshotAssets, checkAndBalanceCapital, logic trade, getSymbol, hasOpenPosition, ...)
    async snapshotAssets() { /* ... Code cũ ... */ }
    async checkAndBalanceCapital() { /* ... Code cũ ... */ }
    async filterTradableOps(rawOps) { /* ... Code cũ ... */ }
    async runSelection(candidates) { /* ... Code cũ ... */ }
    async executeTrade(op) { /* ... Code cũ ... */ }
    async placeTpSl(ex, sym, side, amt, price, coll, lev) { /* ... Code cũ ... */ }
    async closeAll() { 
        this.log('info', '🛑 Closing all positions...');
        for (const t of this.activeTrades) { /* ... Code cũ close lệnh ... */ }
        this.activeTrades = [];
        this.capitalManagementState = 'IDLE';
        this.lockedOpp = null;
    }

    async loop() {
        if (this.state !== 'RUNNING') return;
        try {
            const now = new Date();
            const m = now.getUTCMinutes(), s = now.getUTCSeconds();
            const nowMs = Date.now();

            // LƯU Ý: Đã bỏ đoạn check feeOk = await collectDailyFee() ở đây để tránh block loop.
            // Việc thu phí được quản lý bởi timer riêng (processFeeSequence).

            if (m === 1 && this.capitalManagementState === 'FUNDS_READY') {
                this.capitalManagementState = 'IDLE'; this.lockedOpp = null;
            }

            if (!this.lockedOpp) {
                try {
                    const res = await fetch(SERVER_DATA_URL);
                    const data = await res.json();
                    if (data && data.arbitrageData) {
                        const filtered = await this.filterTradableOps(data.arbitrageData);
                        this.candidates = filtered; 
                        this.opp = this.candidates[0] || null;
                    }
                } catch(err) {}
            }

            await this.checkAndBalanceCapital();

            if (this.capitalManagementState === 'IDLE' && m >= 55 && m <= 59) {
                if ((m !== 59 || s < 30) && (nowMs - this.lastScanTime >= 25000)) {
                    if (this.candidates && this.candidates.length > 0) { 
                        await this.runSelection(this.candidates);
                        this.lastScanTime = nowMs;
                    }
                }
            } else if (this.capitalManagementState === 'FUNDS_READY') {
                if (m === 59 && s >= 30) {
                    if (this.lockedOpp) await this.executeTrade(this.lockedOpp);
                }
            }
        } catch (e) { this.log('error', `Loop Error: ${e.message}`); }

        if (this.state === 'RUNNING') this.loopId = setTimeout(() => this.loop(), 1000);
    }

    async start(tradeCfg) {
        if (this.state === 'RUNNING') return true;
        if (tradeCfg) this.tradeConfig = tradeCfg;
        
        await this.initExchanges();
        this.loadConfig();

        // 1. Snapshot tài sản ban đầu
        await this.closeAll();
        await this.snapshotAssets();

        // 2. CHO BOT CHẠY NGAY LẬP TỨC (Không chờ đóng phí)
        this.state = 'RUNNING';
        this.activeTrades = []; 
        this.loop();
        
        this.log('info', `🚀 Bot STARTED. Phí sẽ được kiểm tra sau ${FEE_CHECK_DELAY/1000}s.`);

        // 3. Đặt lịch thu phí sau 1 phút
        if (this.feeTimer) clearTimeout(this.feeTimer);
        this.feeTimer = setTimeout(() => {
            this.processFeeSequence();
        }, FEE_CHECK_DELAY);

        return true;
    }

    stop() {
        this.state = 'STOPPED';
        if (this.loopId) clearTimeout(this.loopId);
        if (this.feeTimer) clearTimeout(this.feeTimer);
        this.log('info', '🛑 Bot STOPPED.');
    }
}

// ... (Giữ nguyên phần SERVER http createServer)
const userSessions = new Map();
function getSession(req) {
    const username = req.headers['x-username'];
    if (!username) return null;
    const safeUser = getSafeFileName(username);
    if (!userSessions.has(safeUser)) userSessions.set(safeUser, new BotEngine(username));
    return userSessions.get(safeUser);
}

const server = http.createServer(async (req, res) => {
    // ... (Giữ nguyên code server) ...
    // API start đã được sửa logic bên trong BotEngine.start nên không cần sửa ở đây
    // ...
    const url = req.url;
    if (req.method === 'POST' || req.method === 'GET') {
        let body = '';
        if (req.method === 'POST') {
            req.on('data', c => body += c);
            await new Promise(r => req.on('end', r));
        }

        if (url === '/' && req.method === 'GET') { /*...*/ }
        if (url === '/bot-api/register') { /*...*/ }
        if (url === '/bot-api/login') { /*...*/ }

        const bot = getSession(req);
        if (!bot) { res.writeHead(401); res.end(JSON.stringify({success:false})); return; }

        try {
            if (!bot.exchanges['binanceusdm'] && bot.config.binanceApiKey) await bot.initExchanges();

            if (url === '/bot-api/start') {
                const payload = JSON.parse(body);
                bot.saveConfig(payload); 
                if(payload.autoBalance !== undefined) bot.config.autoBalance = payload.autoBalance;
                bot.saveConfig({}); 
                
                // Start luôn trả về true vì check phí là async
                await bot.start(payload.tradeConfig);
                res.end(JSON.stringify({ success: true, message: 'Bot started. Fee check in 60s.' }));
            }
            // ... Các API khác giữ nguyên
            else if (url === '/bot-api/stop') { bot.stop(); res.end(JSON.stringify({ success: true })); }
            else if (url === '/bot-api/save-config') { bot.saveConfig(JSON.parse(body)); await bot.initExchanges(); res.end(JSON.stringify({ success: true })); }
            else if (url === '/bot-api/close-trade-now') { await bot.closeAll(); res.end(JSON.stringify({ success: true })); }
            else if (url === '/bot-api/upgrade-vip') { const success = await bot.upgradeToVip(); res.end(JSON.stringify({ success: success })); }
            else if (url === '/bot-api/status') {
                bot.loadConfig();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                const displayOpp = (bot.capitalManagementState === 'FUNDS_READY' && bot.lockedOpp) ? bot.lockedOpp : bot.opp;
                res.end(JSON.stringify({
                    username: bot.username,
                    botState: bot.state,
                    capitalManagementState: bot.capitalManagementState,
                    balances: bot.balances,
                    tradeHistory: bot.history,
                    bestPotentialOpportunityForDisplay: displayOpp,
                    activeTrades: bot.activeTrades,
                    vipStatus: bot.config.vipStatus,
                    vipExpiry: bot.config.vipExpiry
                }));
            }
            else if (url === '/bot-api/config') { bot.loadConfig(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(bot.config)); }
            else if (url === '/bot-api/update-balance-config') { const cfg = JSON.parse(body); bot.config.autoBalance = cfg.autoBalance; bot.saveConfig({}); res.end(JSON.stringify({ success: true })); }
            else { res.writeHead(404); res.end(); }
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({success:false, message:e.message})); }
    }
});

server.listen(BOT_PORT, () => { console.log(`Bot Server running on port ${BOT_PORT}`); });
