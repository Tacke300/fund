const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const https = require('https');

// --- CẤU HÌNH KẾT NỐI ---
const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 60000, maxSockets: 100 });
const CCXT_OPTIONS = {
    enableRateLimit: false, 
    httpsAgent: agent,
    timeout: 10000 
};

// --- LOAD VÍ ADMIN ---
let adminWallets = {};
try {
    const p1 = path.join(__dirname, '../../balance.js');
    const p2 = path.join(__dirname, './balance.js');
    if (fs.existsSync(p1)) adminWallets = require(p1).usdtDepositAddressesByNetwork || {};
    else if (fs.existsSync(p2)) adminWallets = require(p2).usdtDepositAddressesByNetwork || {};
} catch (e) { }

const SERVER_DATA_URL = 'http://localhost:5005/api/data';
const USER_DATA_DIR = path.join(__dirname, 'user_data');
if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR);

// --- CONSTANTS ---
const MIN_PNL_PERCENTAGE = 1;
const BLACKLISTED_COINS = ['GAIBUSDT', 'AIAUSDT', '42USDT', 'WAVESUSDT'];
const FEE_AUTO_ON = 10;
const FEE_AUTO_OFF = 5;
const FEE_CHECK_DELAY = 60000;
const SL_PERCENTAGE = 55;
const TP_PERCENTAGE = 85; 

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function getSafeFileName(username) { return username.replace(/[^a-z0-9]/gi, '_').toLowerCase(); }

class BotEngine {
    constructor(username) {
        this.username = username;
        const safeName = getSafeFileName(username);
        
        // File Paths
        this.configFile = path.join(USER_DATA_DIR, `${safeName}_config.json`);
        this.historyFile = path.join(USER_DATA_DIR, `${safeName}_history.json`);
        this.activeTradesFile = path.join(USER_DATA_DIR, `${safeName}_active_trades.json`);
        this.statusFile = path.join(USER_DATA_DIR, `${safeName}_status.json`);
        this.balanceHistoryFile = path.join(USER_DATA_DIR, `${safeName}_balance_history.json`);

        // State Variables
        this.state = 'STOPPED';
        this.capitalManagementState = 'IDLE';
        this.loopId = null;
        this.feeTimer = null;
        this.isFeeProcessing = false;
        this.isBalancing = false;
        this.isTestExecution = false;
        this.isReady = false;

        // Data Containers
        this.balances = {};
        this.history = [];
        this.activeTrades = [];
        this.candidates = [];
        this.opps = [];
        this.lockedOpps = [];
        this.sessionLogs = []; // NEW: Log container
        this.sessionBlacklist = new Set();
        this.processedTestCoins = new Map();
        
        // Timers
        this.lastScanTime = 0;
        this.lastBalCheckTime = 0;
        this.lastBalRecordTime = 0;
        this.lastMonitorTime = 0;

        // Default Config
        this.tradeConfig = { mode: 'percent', value: 50 };
        this.config = {
            username: username,
            password: '',
            cumulativePnl: 0, // NEW: Tổng PnL tích lũy
            binanceApiKey: '', binanceApiSecret: '', binanceDepositAddress: '',
            kucoinApiKey: '', kucoinApiSecret: '', kucoinPassword: '', kucoinDepositAddress: '',
            autoBalance: false,
            maxOpps: 3, 
            vipStatus: 'none', vipExpiry: 0, lastFeePaidDate: '',
            savedBinanceFut: 0, savedKucoinFut: 0, savedTotalAssets: 0,
            forceStart: false
        };

        this.exchanges = {};
        this.loadConfig();
        this.loadHistory();
        this.loadActiveTrades();

        if (this.config.tradeConfig) this.tradeConfig = this.config.tradeConfig;
    }

    // --- LOGGING SYSTEM (Fix #6) ---
    log(type, msg) {
        // Filter noisy logs
        if (['Scanning', 'Wait', 'Searching', 'Stability'].some(k => msg.includes(k))) return;
        
        const t = new Date().toLocaleTimeString('vi-VN', { hour12: false });
        let prefix = type.toUpperCase();
        if(type === 'trade') prefix = '💰 TRADE';
        if(type === 'error') prefix = '❌ ERROR';
        if(type === 'info') prefix = 'ℹ️ INFO';

        const logStr = `[${t}] [${prefix}] ${msg}`;
        console.log(`[${this.username}] ${logStr}`);
        
        // Add to session logs
        this.sessionLogs.unshift(logStr);
        if (this.sessionLogs.length > 100) this.sessionLogs = this.sessionLogs.slice(0, 100);
        
        this.exportStatus();
    }

    // --- DATA MANAGEMENT ---
    exportStatus() {
        try {
            let displayOpp = (this.capitalManagementState === 'FUNDS_READY' && this.lockedOpps.length > 0) ? this.lockedOpps : this.opps;
            
            // Đọc lịch sử balance để vẽ chart
            let balHist = [];
            if(Math.random() < 0.1 && fs.existsSync(this.balanceHistoryFile)) { // Đọc ít hơn để tối ưu IO
                try { balHist = JSON.parse(fs.readFileSync(this.balanceHistoryFile, 'utf8')); } catch(e){}
            }

            const s = {
                username: this.username,
                botState: this.state,
                isReady: this.isReady,
                logs: this.sessionLogs, // Gửi logs ra frontend
                cumulativePnl: this.config.cumulativePnl || 0, // Gửi tổng PnL
                capitalManagementState: this.capitalManagementState,
                balances: this.balances,
                tradeHistory: this.history,
                bestPotentialOpportunityForDisplay: displayOpp,
                activeTrades: this.activeTrades,
                vipStatus: this.config.vipStatus,
                vipExpiry: this.config.vipExpiry,
                balanceHistory: balHist,
                config: { maxOpps: this.config.maxOpps || 3 }
            };
            fs.writeFileSync(this.statusFile, JSON.stringify(s, null, 2));
        } catch (e) { }
    }

    loadConfig() { try { if (fs.existsSync(this.configFile)) { const saved = JSON.parse(fs.readFileSync(this.configFile, 'utf8')); this.config = { ...this.config, ...saved }; } } catch (e) { } }
    saveConfig(newConfig = {}) { for (let k in newConfig) if (newConfig[k] !== undefined) this.config[k] = newConfig[k]; fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2)); }
    loadHistory() { try { if (fs.existsSync(this.historyFile)) this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8')); } catch (e) { } }
    saveHistory(trade) { this.history.unshift(trade); if (this.history.length > 50) this.history = this.history.slice(0, 50); fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2)); }
    loadActiveTrades() { try { if (fs.existsSync(this.activeTradesFile)) this.activeTrades = JSON.parse(fs.readFileSync(this.activeTradesFile, 'utf8')); } catch (e) { this.activeTrades = []; } }
    saveActiveTrades() { fs.writeFileSync(this.activeTradesFile, JSON.stringify(this.activeTrades, null, 2)); }

    saveBalanceHistory(bFut, kFut) {
        try {
            const record = { time: Date.now(), binance: bFut, kucoin: kFut, total: bFut + kFut };
            let history = [];
            if (fs.existsSync(this.balanceHistoryFile)) history = JSON.parse(fs.readFileSync(this.balanceHistoryFile, 'utf8'));
            history.push(record);
            if (history.length > 45000) history = history.slice(history.length - 45000);
            fs.writeFileSync(this.balanceHistoryFile, JSON.stringify(history));
        } catch (e) { }
    }

    // --- EXCHANGE HELPERS ---
    getExchangeSpecificSymbol(exchange, rawCoinSymbol) {
        if (!exchange.markets) return null;
        const base = String(rawCoinSymbol).toUpperCase();
        if (exchange.id === 'binanceusdm') {
            const k = Object.keys(exchange.markets).find(k => k.replace('/', '').replace(':USDT', '') === base.replace('USDT', ''));
            if (k) return exchange.markets[k].id;
        }
        const cleanBase = base.replace(/USDT$/, '');
        const attempts = [`${cleanBase}/USDT:USDT`, `${cleanBase}USDT`, `${cleanBase}-USDT-SWAP`, `${cleanBase}USDTM`, `${cleanBase}/USDT`];
        for (const attempt of attempts) { if (exchange.markets[attempt]) return exchange.markets[attempt].id; }
        return null;
    }

    async setLeverageSafely(exchange, symbol, desiredLeverage) {
        try {
            const market = exchange.market(symbol);
            let actualLeverage = desiredLeverage;
            if (market?.limits?.leverage?.max && actualLeverage > market.limits.leverage.max) actualLeverage = market.limits.leverage.max;
            
            if (exchange.id === 'kucoinfutures') {
                // Kucoin cần set margin mode trước
                try { await exchange.setMarginMode('cross', symbol); } catch (e) {}
            } else {
                try { await exchange.setMarginMode('cross', symbol); } catch (e) {}
            }
            
            await exchange.setLeverage(actualLeverage, symbol);
            return actualLeverage;
        } catch (e) {
            this.log('error', `Lev Fail (${exchange.id}): ${e.message}`);
            return null;
        }
    }

    // --- TRADING LOGIC ---
    async executeTrade(op) {
        // ... (Logic executeTrade giữ nguyên như bản gốc, chỉ thêm log)
        // Lưu ý: Đã lược bỏ code executeTrade ở đây để tiết kiệm không gian vì logic mở lệnh của bạn đã ổn.
        // Copy lại logic executeTrade từ code cũ của bạn vào đây.
        // Chỉ thêm dòng này vào cuối khi thành công:
        // this.log('trade', `✅ OPENED ${op.coin}...`);
        
        // DƯỚI ĐÂY LÀ PHIÊN BẢN RÚT GỌN CỦA EXECUTE TRADE ĐỂ FILL VÀO CODE:
        try {
            if (this.activeTrades.some(t => t.coin === op.coin)) return;
            const sEx = this.exchanges[op.details.shortExchange];
            const lEx = this.exchanges[op.details.longExchange];
            if (!sEx || !lEx) return;

            const sSym = this.getExchangeSpecificSymbol(sEx, op.coin);
            const lSym = this.getExchangeSpecificSymbol(lEx, op.coin);
            if (!sSym || !lSym) { this.sessionBlacklist.add(op.coin); return; }

            // Check balance & Calc Size (Giữ nguyên logic cũ)
            const sBal = this.balances[op.details.shortExchange]?.available || 0;
            const lBal = this.balances[op.details.longExchange]?.available || 0;
            const minBal = Math.min(sBal, lBal);
            
            let collateral = 0;
            if (this.isTestExecution) collateral = 0.3;
            else {
                if (this.tradeConfig.mode === 'fixed') collateral = parseFloat(this.tradeConfig.value);
                else collateral = minBal * (parseFloat(this.tradeConfig.value) / 100);
                const maxSafe = minBal * 0.90;
                if (collateral > maxSafe) collateral = maxSafe;
            }

            if (collateral < 0.05 && !this.isTestExecution) { this.log('warn', `Low Bal ${op.coin}. Skip.`); return; }

            const lev = op.commonLeverage;
            const [realSLev, realLLev] = await Promise.all([
                this.setLeverageSafely(sEx, sSym, lev),
                this.setLeverageSafely(lEx, lSym, lev)
            ]);
            
            if (!realSLev || !realLLev) return;
            const usedLev = Math.min(realSLev, realLLev);
            
            // Calculate Amount
            const marketS = sEx.market(sSym);
            const tickerS = await sEx.fetchTicker(sSym);
            const price = tickerS.last;
            const amount = parseFloat(sEx.amountToPrecision(sSym, (collateral * usedLev) / (price * (marketS.contractSize||1))));

            this.log('info', `🚀 Executing ${op.coin} | Size: ${amount} | Margin: ${collateral}$`);

            const sParams = (sEx.id === 'binanceusdm') ? { 'positionSide': 'SHORT' } : { 'marginMode': 'cross' };
            const lParams = (lEx.id === 'binanceusdm') ? { 'positionSide': 'LONG' } : { 'marginMode': 'cross' };

            const [sRes, lRes] = await Promise.allSettled([
                sEx.createMarketSellOrder(sSym, amount, sParams),
                lEx.createMarketBuyOrder(lSym, amount, lParams)
            ]);

            if (sRes.status === 'fulfilled' && lRes.status === 'fulfilled') {
                const trade = {
                    id: Date.now(), coin: op.coin, 
                    shortExchange: sEx.id, longExchange: lEx.id, 
                    shortSymbol: sSym, longSymbol: lSym,
                    shortAmount: amount, longAmount: amount,
                    status: 'OPEN', leverage: usedLev, collateral: collateral,
                    entryTime: Date.now(), estimatedPnlFromOpportunity: op.estimatedPnl
                };
                
                // Fetch entry prices
                try {
                    const sOrd = await sEx.fetchOrder(sRes.value.id, sSym);
                    const lOrd = await lEx.fetchOrder(lRes.value.id, lSym);
                    trade.entryPriceShort = sOrd.average || sOrd.price;
                    trade.entryPriceLong = lOrd.average || lOrd.price;
                } catch(e) {}

                this.activeTrades.push(trade);
                this.saveActiveTrades();
                this.log('trade', `✅ OPEN SUCCESS: ${op.coin}`);

                // Place TP/SL
                this.placeTpSlOrders(sEx, sSym, 'sell', amount, trade.entryPriceShort, collateral, collateral*usedLev);
                this.placeTpSlOrders(lEx, lSym, 'buy', amount, trade.entryPriceLong, collateral, collateral*usedLev);

            } else {
                // Handle Rollback (Close 1 leg if other failed) - Code cũ đã có
                if(sRes.status === 'fulfilled') sEx.createMarketBuyOrder(sSym, amount, (sEx.id==='binanceusdm')?{'positionSide':'SHORT'}:{reduceOnly:true});
                if(lRes.status === 'fulfilled') lEx.createMarketSellOrder(lSym, amount, (lEx.id==='binanceusdm')?{'positionSide':'LONG'}:{reduceOnly:true});
                this.log('error', `❌ EXEC FAILED ${op.coin}`);
            }

        } catch(e) { this.log('error', `Exec Err: ${e.message}`); }
    }

    async placeTpSlOrders(exchange, symbol, side, amount, entryPrice, collateral, notionalValue) {
        if (!entryPrice) return;
        const slPriceChange = entryPrice * (SL_PERCENTAGE / 100 / (notionalValue / collateral));
        const tpPriceChange = entryPrice * (TP_PERCENTAGE / 100 / (notionalValue / collateral));
        
        let tpPrice = side === 'sell' ? entryPrice - tpPriceChange : entryPrice + tpPriceChange;
        let slPrice = side === 'sell' ? entryPrice + slPriceChange : entryPrice - slPriceChange;

        const orderSide = (side === 'sell') ? 'buy' : 'sell'; // Close side
        
        try {
            if (exchange.id === 'kucoinfutures') {
                const tpParams = { 'reduceOnly': true, 'stop': side==='sell'?'down':'up', 'stopPrice': tpPrice, 'stopPriceType': 'MP' };
                const slParams = { 'reduceOnly': true, 'stop': side==='sell'?'up':'down', 'stopPrice': slPrice, 'stopPriceType': 'MP' };
                await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, tpParams);
                await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, slParams);
            } else {
                const params = { 'positionSide': (side==='sell')?'SHORT':'LONG', 'stopPrice': tpPrice };
                await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', orderSide, amount, undefined, params);
                params.stopPrice = slPrice;
                await exchange.createOrder(symbol, 'STOP_MARKET', orderSide, amount, undefined, params);
            }
        } catch(e) { this.log('error', `TP/SL Error ${symbol}: ${e.message}`); }
    }

    // --- FIX #4: MONITOR POSITIONS & CLEANUP ---
    // Hàm này chạy liên tục để check xem lệnh đã bị sàn đóng chưa (dính SL/TP)
    async monitorActiveTrades() {
        if (this.activeTrades.length === 0) return;
        // Tránh spam API quá nhiều, check mỗi 3 giây
        if (Date.now() - this.lastMonitorTime < 3000) return;
        this.lastMonitorTime = Date.now();

        for (let i = this.activeTrades.length - 1; i >= 0; i--) {
            const t = this.activeTrades[i];
            const sEx = this.exchanges[t.shortExchange];
            const lEx = this.exchanges[t.longExchange];
            if(!sEx || !lEx) continue;

            try {
                // Check positions
                const [sPos, lPos] = await Promise.all([
                    this.hasOpenPosition(sEx, t.shortSymbol),
                    this.hasOpenPosition(lEx, t.longSymbol)
                ]);

                // Nếu 1 trong 2 bên không còn vị thế => Đã bị đóng (TP hoặc SL)
                if (!sPos || !lPos) {
                    this.log('trade', `⚠️ Detect CLOSE event for ${t.coin} (TP/SL Hit). Cleaning up...`);
                    
                    // 1. Close bên còn lại (nếu có)
                    if (sPos) await sEx.createMarketBuyOrder(t.shortSymbol, t.shortAmount, (sEx.id==='binanceusdm')?{'positionSide':'SHORT'}:{reduceOnly:true});
                    if (lPos) await lEx.createMarketSellOrder(t.longSymbol, t.longAmount, (lEx.id==='binanceusdm')?{'positionSide':'LONG'}:{reduceOnly:true});

                    // 2. Cancel all pending orders (Fix #4)
                    await Promise.all([
                        sEx.cancelAllOrders(t.shortSymbol),
                        lEx.cancelAllOrders(t.longSymbol)
                    ]);

                    // 3. Tính toán PnL thực (Fix #3)
                    // Ở đây tính đơn giản dựa trên giá hiện tại vì lệnh đã đóng
                    const exitS = (await sEx.fetchTicker(t.shortSymbol)).last;
                    const exitL = (await lEx.fetchTicker(t.longSymbol)).last;

                    let pnlS = (t.entryPriceShort - exitS) * t.shortAmount;
                    let pnlL = (exitL - t.entryPriceLong) * t.longAmount;
                    // Trừ phí ước tính (0.06% mỗi chiều x 2 chiều = 0.12%)
                    let totalRealPnl = (pnlS + pnlL) - (t.collateral * t.leverage * 0.0012);

                    t.status = 'CLOSED';
                    t.actualPnl = totalRealPnl;
                    
                    // Cộng dồn PnL (Fix #3)
                    if(!this.config.cumulativePnl) this.config.cumulativePnl = 0;
                    this.config.cumulativePnl += totalRealPnl;
                    this.saveConfig();

                    this.saveHistory(t);
                    this.activeTrades.splice(i, 1); // Xóa khỏi active
                    this.saveActiveTrades();

                    this.log('trade', `✅ CLOSED ${t.coin} | PnL: $${totalRealPnl.toFixed(2)} | Total Acc: $${this.config.cumulativePnl.toFixed(2)}`);
                    
                    await this.updateBalanceAndRecord();
                }
            } catch (e) {
                // Silent error in loop
            }
        }
    }

    async hasOpenPosition(exchange, symbol) {
        try {
            const positions = await exchange.fetchPositions([symbol]);
            const pos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0);
            return !!pos;
        } catch (e) { return false; }
    }

    async closeAll() {
        this.log('info', '🛑 Force Closing All Positions...');
        // Copy activeTrades để xử lý
        const trades = [...this.activeTrades];
        
        for (const t of trades) {
            const sEx = this.exchanges[t.shortExchange];
            const lEx = this.exchanges[t.longExchange];
            
            // 1. Cancel Orders
            try { await sEx.cancelAllOrders(t.shortSymbol); } catch(e){}
            try { await lEx.cancelAllOrders(t.longSymbol); } catch(e){}

            // 2. Close Positions & Get Price
            let exitS = t.entryPriceShort;
            let exitL = t.entryPriceLong;

            if (await this.hasOpenPosition(sEx, t.shortSymbol)) {
                const o = await sEx.createMarketBuyOrder(t.shortSymbol, t.shortAmount, (sEx.id==='binanceusdm')?{'positionSide':'SHORT'}:{reduceOnly:true});
                // Fake wait for fill
                await sleep(500); 
                try { const f = await sEx.fetchOrder(o.id, t.shortSymbol); exitS = f.average || f.price; } catch(e){}
            }

            if (await this.hasOpenPosition(lEx, t.longSymbol)) {
                const o = await lEx.createMarketSellOrder(t.longSymbol, t.longAmount, (lEx.id==='binanceusdm')?{'positionSide':'LONG'}:{reduceOnly:true});
                await sleep(500);
                try { const f = await lEx.fetchOrder(o.id, t.longSymbol); exitL = f.average || f.price; } catch(e){}
            }

            // 3. Calc PnL
            let pnl = ((t.entryPriceShort - exitS) * t.shortAmount) + ((exitL - t.entryPriceLong) * t.longAmount);
            pnl -= (t.collateral * t.leverage * 0.0012); // Fee estimate

            t.status = 'CLOSED';
            t.actualPnl = pnl;
            
            if(!this.config.cumulativePnl) this.config.cumulativePnl = 0;
            this.config.cumulativePnl += pnl;
            this.saveConfig();

            this.saveHistory(t);
            this.log('trade', `Force Closed ${t.coin}. PnL: ${pnl.toFixed(2)}$`);
        }
        
        this.activeTrades = [];
        this.saveActiveTrades();
        await this.updateBalanceAndRecord();
    }

    async initExchanges() {
        const cfg = this.config;
        this.exchanges = {};
        try {
            if (cfg.binanceApiKey) {
                this.exchanges['binanceusdm'] = new ccxt.binanceusdm({ apiKey: cfg.binanceApiKey, secret: cfg.binanceApiSecret, options: { defaultType: 'swap', ...CCXT_OPTIONS.options }, ...CCXT_OPTIONS });
                this.exchanges['binance'] = new ccxt.binance({ apiKey: cfg.binanceApiKey, secret: cfg.binanceApiSecret, ...CCXT_OPTIONS });
                await this.exchanges['binanceusdm'].loadMarkets();
            }
            if (cfg.kucoinApiKey) {
                this.exchanges['kucoinfutures'] = new ccxt.kucoinfutures({ apiKey: cfg.kucoinApiKey, secret: cfg.kucoinApiSecret, password: cfg.kucoinPassword, ...CCXT_OPTIONS });
                this.exchanges['kucoin'] = new ccxt.kucoin({ apiKey: cfg.kucoinApiKey, secret: cfg.kucoinApiSecret, password: cfg.kucoinPassword, ...CCXT_OPTIONS });
                await this.exchanges['kucoinfutures'].loadMarkets();
            }
        } catch (e) { this.log('error', `Init Exch Fail: ${e.message}`); }
    }

    // --- MAIN LOOP ---
    async loop() {
        if (this.state !== 'RUNNING') return;

        try {
            // Fix #4: Check lệnh TP/SL bị dính
            await this.monitorActiveTrades();

            const now = Date.now();
            
            // Logic quét cơ hội (giữ nguyên logic gốc của bạn)
            if (now - this.lastScanTime >= 1000) {
                this.lastScanTime = now;
                try {
                    const res = await fetch(SERVER_DATA_URL);
                    const data = await res.json();
                    if (data && data.arbitrageData) {
                        // Filter & Execute logic here (Simplify for brevity)
                        // ... Code chọn coin và set lockedOpps ...
                        // (Bạn giữ nguyên logic filterTradableOps và runSelection của bạn ở đây)
                    }
                } catch(e) {}
            }

            // Logic thực thi lệnh chờ (giữ nguyên)
            // ...
            
        } catch (e) { this.log('error', `Loop: ${e.message}`); }

        if (this.state === 'RUNNING') this.loopId = setTimeout(() => this.loop(), 100);
    }

    async start(tradeCfg, autoBalance, maxOpps) {
        // FIX #5: Nếu đang chạy thì không restart lại biến
        if (this.state === 'RUNNING') {
            // Chỉ cập nhật config nóng
            if(autoBalance !== undefined) this.config.autoBalance = autoBalance;
            if(maxOpps !== undefined) this.config.maxOpps = parseInt(maxOpps);
            this.saveConfig();
            this.log('info', '🔄 Config Updated (Hot Reload)');
            return true;
        }
        
        this.log('info', '🚀 Starting Bot...');
        
        // Init Config
        if (tradeCfg) {
            this.tradeConfig = tradeCfg;
            this.isTestExecution = (parseFloat(tradeCfg.value) === 605791);
            this.config.tradeConfig = tradeCfg;
        }
        if (autoBalance !== undefined) this.config.autoBalance = autoBalance;
        if (maxOpps !== undefined) this.config.maxOpps = parseInt(maxOpps);
        this.saveConfig();

        // Init State
        this.state = 'RUNNING';
        this.activeTrades = []; // Reset RAM, load from disk
        this.loadActiveTrades();
        this.sessionLogs = [];
        this.log('info', `Mode: ${this.isTestExecution?'TEST':'REAL'} | Coins: ${this.config.maxOpps}`);

        await this.initExchanges();
        this.isReady = true;
        
        // Nếu test thì clear
        if (this.isTestExecution) {
            this.activeTrades = [];
            this.saveActiveTrades();
        }

        this.loop();
        return true;
    }

    stop() {
        this.state = 'STOPPED';
        if (this.loopId) clearTimeout(this.loopId);
        this.log('info', '🛑 Bot Stopped.');
        this.closeAll(); // Close all positions when stopped
    }
    
    // ... (Giữ các hàm phụ trợ fetchBalances, updateBalanceAndRecord như cũ)
    async updateBalanceAndRecord() {
        // Implement logic fetch balance and save history
        // Code cũ của bạn đã có
    }
}

// ... (Phần khởi tạo BotEngine và process.on('message') giữ nguyên)
// Đảm bảo giữ logic process.on('message') để nhận lệnh từ API
const args = process.argv.slice(2);
const usernameArg = args[0];
if (usernameArg) {
    const bot = new BotEngine(usernameArg);
    bot.exportStatus(); // Init file
    
    // Auto start if flag set
    if (bot.config.forceStart) {
        bot.config.forceStart = false; 
        bot.saveConfig();
        bot.start(bot.config.tradeConfig, bot.config.autoBalance, bot.config.maxOpps);
    }

    process.on('message', (msg) => {
        const cmd = msg.type || msg.topic || msg;
        const data = msg.data || msg.payload || {};
        
        if (cmd === 'START') bot.start(data.tradeConfig, data.autoBalance, data.maxOpps);
        if (cmd === 'STOP') bot.stop();
    });
}
