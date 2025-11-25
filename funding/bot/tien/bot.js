const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

// [IMPORT FILE BALANCE.JS CŨ ĐỂ LẤY VÍ DỰ PHÒNG]
let fallbackBalance = {};
try {
    const balanceModule = require('./balance.js');
    if (balanceModule && balanceModule.usdtDepositAddressesByNetwork) {
        fallbackBalance = balanceModule.usdtDepositAddressesByNetwork;
    }
} catch (e) {
    console.log("[WARN] Không tìm thấy file balance.js, chức năng tự điền ví sẽ tắt.");
}

// [GLOBAL CONFIG]
const BOT_PORT = 2025;
const SERVER_DATA_URL = 'http://localhost:5005/api/data';
const USER_DATA_DIR = path.join(__dirname, 'user_data');

if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR);

// [CONSTANTS]
const MIN_PNL_PERCENTAGE = 1;
const MIN_COLLATERAL_FOR_TRADE = 0.05; 
const BLACKLISTED_COINS = ['GAIBUSDT', 'AIAUSDT', '42USDT'];
const BALANCE_CHECK_MINUTE = 30;
const MIN_DIFF_FOR_BALANCE = 20; 
const FUND_ARRIVAL_TOLERANCE = 2; 

// [TP/SL CONFIG]
const SL_PERCENTAGE = 95;  
const TP_PERCENTAGE = 135; 

function getSafeFileName(username) {
    return username.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// ============================================================
// CLASS: BOT ENGINE (FINAL COMPLETE VERSION)
// ============================================================
class BotEngine {
    constructor(username) {
        this.username = username;
        const safeName = getSafeFileName(username);
        this.configFile = path.join(USER_DATA_DIR, `${safeName}_config.json`);
        this.historyFile = path.join(USER_DATA_DIR, `${safeName}_history.json`);
        
        this.state = 'STOPPED';
        this.capitalManagementState = 'IDLE'; // Đồng bộ tên biến trạng thái
        this.loopId = null;
        this.lastScanTime = 0;
        this.lastBalCheckTime = 0;
        
        this.balances = {};
        this.history = [];
        this.activeTrades = [];
        
        this.candidates = []; // Danh sách coin ĐÃ ĐƯỢC LỌC (có trên sàn)
        this.opp = null;      // Coin tốt nhất để hiển thị UI
        this.lockedOpp = null; // Coin đã chốt để trade

        this.tradeConfig = { mode: 'percent', value: 50 };
        
        this.config = {
            username: username,
            password: '',
            binanceApiKey: '', binanceApiSecret: '', binanceDepositAddress: '',
            kucoinApiKey: '', kucoinApiSecret: '', kucoinPassword: '', kucoinDepositAddress: '',
            autoBalance: false
        };
        
        this.exchanges = {};
        this.loadConfig();
        this.loadHistory();
    }

    // --- LOGGING GỌN GÀNG (1 DÒNG) ---
    log(type, msg) {
        // Chỉ log: error, trade (open), result (close/pnl)
        if (!['error', 'trade', 'result'].includes(type)) return;

        const t = new Date().toLocaleTimeString('vi-VN', { hour12: false });
        // Format: [TIME] [USER] [TYPE] Content
        const prefix = `[${t}] [USER: ${this.username}]`;

        if (type === 'error') {
            console.error(`${prefix} ❌ ${msg}`);
        } else if (type === 'trade') {
            console.log(`${prefix} 🚀 ${msg}`);
        } else if (type === 'result') {
            console.log(`${prefix} 💰 ${msg}`);
        }
    }

    // --- CONFIG & HISTORY ---
    loadConfig() {
        try { if (fs.existsSync(this.configFile)) this.config = { ...this.config, ...JSON.parse(fs.readFileSync(this.configFile, 'utf8')) }; } catch (e) {}
    }
    loadHistory() {
        try { if (fs.existsSync(this.historyFile)) this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8')); } catch(e) {}
    }
    saveConfig(newConfig = {}) {
        for (let k in newConfig) if (newConfig[k] !== undefined) this.config[k] = newConfig[k];
        fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2));
    }
    saveHistory(trade) {
        this.history.unshift(trade);
        if(this.history.length > 50) this.history = this.history.slice(0,50);
        fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2));
    }

    // --- WALLET & INIT ---
    getTargetDepositAddress(exchangeId) {
        if (exchangeId === 'binanceusdm' && this.config.binanceDepositAddress) return { address: this.config.binanceDepositAddress, network: 'APT' };
        if (exchangeId === 'kucoinfutures' && this.config.kucoinDepositAddress) return { address: this.config.kucoinDepositAddress, network: 'BEP20' };
        
        let k = exchangeId === 'binanceusdm' ? 'binance' : 'kucoin';
        let n = exchangeId === 'binanceusdm' ? 'APT' : 'BEP20';
        
        if (fallbackBalance[k]?.[n]) return { address: fallbackBalance[k][n], network: n };
        if (fallbackBalance[exchangeId]?.[n]) return { address: fallbackBalance[exchangeId][n], network: n };
        return null;
    }

    async initExchanges() {
        const cfg = this.config;
        this.exchanges = {}; this.balances = {};
        try {
            if (cfg.binanceApiKey) {
                this.exchanges['binanceusdm'] = new ccxt.binanceusdm({ apiKey: cfg.binanceApiKey, secret: cfg.binanceApiSecret, enableRateLimit:true, options: { defaultType: 'swap' } });
                this.exchanges['binance'] = new ccxt.binance({ apiKey: cfg.binanceApiKey, secret: cfg.binanceApiSecret, enableRateLimit:true });
                // Load markets ngay để phục vụ lọc coin
                await this.exchanges['binanceusdm'].loadMarkets();
                setTimeout(async()=>{try{await this.exchanges['binanceusdm'].fapiPrivatePostPositionSideDual({'dualSidePosition':'true'})}catch(e){}},1000);
            }
            if (cfg.kucoinApiKey) {
                this.exchanges['kucoinfutures'] = new ccxt.kucoinfutures({ apiKey: cfg.kucoinApiKey, secret: cfg.kucoinApiSecret, password: cfg.kucoinPassword, enableRateLimit:true });
                this.exchanges['kucoin'] = new ccxt.kucoin({ apiKey: cfg.kucoinApiKey, secret: cfg.kucoinApiSecret, password: cfg.kucoinPassword, enableRateLimit:true });
                // Load markets ngay để phục vụ lọc coin
                await this.exchanges['kucoinfutures'].loadMarkets();
                setTimeout(async()=>{try{await this.exchanges['kucoinfutures'].privatePostPositionSideDual({'dualSidePosition':'true'})}catch(e){}},1000);
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
    }

    async getSymbol(ex, coin) {
        try {
            if(!ex.markets) await ex.loadMarkets();
            const base = coin.replace('USDT','');
            if (ex.id === 'binanceusdm') {
               const k = Object.keys(ex.markets).find(k => k.startsWith(base) && k.endsWith('USDT'));
               return ex.markets[k]?.id;
            }
            const attempts = [`${base}/USDT:USDT`, `${base}USDTM`, `${base}USDT`];
            for(const a of attempts) if(ex.markets[a]) return ex.markets[a].id;
        } catch(e) {}
        return null;
    }

    // --- TRANSFER LOGIC ---
    async attemptInternalTransferOnArrival(toId, fromId, amt) {
        const checker = this.exchanges[toId==='kucoinfutures'?'kucoin':'binance'];
        const transferer = this.exchanges[toId];
        if(!checker || !transferer) return;
        for(let i=0; i<30; i++) {
            await new Promise(r=>setTimeout(r,20000));
            try {
                const bal = await checker.fetchBalance();
                const spot = bal.free.USDT||0;
                if(spot >= amt - FUND_ARRIVAL_TOLERANCE) {
                    await transferer.transfer('USDT', spot, toId==='binanceusdm'?'spot':'main', 'future');
                    await this.fetchBalances();
                    return;
                }
            } catch(e){}
        }
    }

    async executeSingleFundTransfer(fromId, toId, amt) {
        const src = this.exchanges[fromId];
        const tgt = this.getTargetDepositAddress(toId);
        if(!tgt || !src) return;
        try {
            await src.transfer('USDT', amt, 'future', fromId==='binanceusdm'?'spot':'main');
            await new Promise(r=>setTimeout(r,3000));
            const wEx = fromId==='binanceusdm'?this.exchanges['binance']:this.exchanges['kucoin'];
            await wEx.withdraw('USDT', amt, tgt.address, undefined, {network: fromId==='binanceusdm'?'BSC':'APT'});
            this.attemptInternalTransferOnArrival(toId, fromId, amt);
        } catch(e) { this.log('error', `Transfer Fail: ${e.message}`); }
    }

    async checkAndBalanceCapital() {
        if (!this.config.autoBalance) return;
        const now = new Date();
        if (now.getMinutes() !== BALANCE_CHECK_MINUTE) return;
        if (Date.now() - this.lastBalCheckTime < 60000) return;
        this.lastBalCheckTime = Date.now();
        await this.fetchBalances();
        const b = this.balances['binanceusdm']?.total||0, k = this.balances['kucoinfutures']?.total||0;
        const diff = Math.abs(b - k), amt = diff / 2;
        if (diff > MIN_DIFF_FOR_BALANCE && amt > 5) {
            if (b > k) await this.executeSingleFundTransfer('binanceusdm', 'kucoinfutures', amt);
            else await this.executeSingleFundTransfer('kucoinfutures', 'binanceusdm', amt);
        }
    }

    // --- HELPER: LỌC COIN TRƯỚC KHI HIỂN THỊ (QUAN TRỌNG) ---
    async filterTradableOps(rawOps) {
        const tradable = [];
        for (const op of rawOps) {
            if (op.estimatedPnl < MIN_PNL_PERCENTAGE || BLACKLISTED_COINS.includes(op.coin)) continue;
            
            const [s, l] = op.exchanges.toLowerCase().split(' / ');
            if (!((s.includes('binance')||l.includes('binance')) && (s.includes('kucoin')||l.includes('kucoin')))) continue;

            const opDetail = { ...op, details: {
                shortExchange: s.includes('binance') ? 'binanceusdm' : 'kucoinfutures',
                longExchange: l.includes('binance') ? 'binanceusdm' : 'kucoinfutures'
            }};

            // CHECK KỸ: Sàn đã init chưa?
            const sEx = this.exchanges[opDetail.details.shortExchange];
            const lEx = this.exchanges[opDetail.details.longExchange];
            if (!sEx || !lEx) continue;

            // CHECK KỸ: Coin có trên Futures cả 2 sàn không?
            const sSym = await this.getSymbol(sEx, op.coin);
            const lSym = await this.getSymbol(lEx, op.coin);

            // Chỉ lấy nếu cả 2 đều hỗ trợ
            if (sSym && lSym) {
                tradable.push(opDetail);
            }
        }
        return tradable.sort((a,b) => b.estimatedPnl - a.estimatedPnl);
    }

    // --- MAIN LOOP ---
    async loop() {
        if (this.state !== 'RUNNING') return;
        try {
            const now = new Date();
            const m = now.getUTCMinutes(), s = now.getUTCSeconds();
            const nowMs = Date.now();

            // Reset chu kỳ mới
            if (m === 1 && this.capitalManagementState === 'FUNDS_READY') {
                this.capitalManagementState = 'IDLE';
                this.lockedOpp = null;
            }

            // Lấy dữ liệu & LỌC NGAY
            if (!this.lockedOpp) {
                try {
                    const res = await fetch(SERVER_DATA_URL);
                    const data = await res.json();
                    if (data && data.arbitrageData) {
                        // Gọi hàm lọc kỹ
                        const filtered = await this.filterTradableOps(data.arbitrageData);
                        
                        this.candidates = filtered; 
                        this.opp = this.candidates[0] || null; // Coin hiển thị UI là coin chắc chắn trade được
                    }
                } catch(err) {}
            }

            await this.checkAndBalanceCapital();

            // 1. Quét tìm cơ hội (Phút 55 -> 59)
            if (this.capitalManagementState === 'IDLE' && m >= 55 && m <= 59) {
                if ((m !== 59 || s < 30) && (nowMs - this.lastScanTime >= 25000)) {
                    if (this.candidates && this.candidates.length > 0) { 
                        await this.runSelection(this.candidates);
                        this.lastScanTime = nowMs;
                    }
                }
            } 
            // 2. Vào lệnh (59:30)
            else if (this.capitalManagementState === 'FUNDS_READY') {
                if (m === 59 && s >= 30) {
                    if (this.lockedOpp) await this.executeTrade(this.lockedOpp);
                }
            }
        } catch (e) { this.log('error', `Loop Error: ${e.message}`); }

        if (this.state === 'RUNNING') this.loopId = setTimeout(() => this.loop(), 1000);
    }

    async hasOpenPosition(ex, sym) {
        try {
            const positions = await ex.fetchPositions();
            return !!positions.find(p => (p.symbol === sym || p.info.symbol === sym) && parseFloat(p.contracts || p.info.positionAmt || 0) !== 0);
        } catch (e) { return false; }
    }

    // --- LOGIC CHỌN COIN (ĐÃ ĐƯỢC LỌC, CHỈ CHECK VỊ THẾ & TIỀN) ---
    async runSelection(candidates) {
        // Duyệt toàn bộ danh sách đã lọc
        for (const op of candidates) {
            // Check 1: Đang active trade con này chưa?
            if (this.activeTrades.some(t => t.coin === op.coin)) continue;
            
            const sEx = this.exchanges[op.details.shortExchange];
            const lEx = this.exchanges[op.details.longExchange];
            
            // Check 2: Lấy Symbol (Chắc chắn có vì đã lọc ở filterTradableOps)
            const sSym = await this.getSymbol(sEx, op.coin);
            const lSym = await this.getSymbol(lEx, op.coin);

            // Check 3: Có đang mở vị thế (treo lệnh) trên sàn không?
            const hasShort = await this.hasOpenPosition(sEx, sSym);
            const hasLong = await this.hasOpenPosition(lEx, lSym);
            if (hasShort || hasLong) continue;

            // Check 4: Đủ tiền không?
            const sBal = this.balances[op.details.shortExchange]?.available || 0;
            const lBal = this.balances[op.details.longExchange]?.available || 0;
            if (sBal <= MIN_COLLATERAL_FOR_TRADE || lBal <= MIN_COLLATERAL_FOR_TRADE) continue;

            // THỎA MÃN TẤT CẢ -> CHỐT KÈO
            this.lockedOpp = op;
            this.opp = op; // Update UI hiển thị con chốt
            this.capitalManagementState = 'FUNDS_READY';
            return;
        }
    }

    // --- EXECUTE TRADE ---
    async executeTrade(op) {
        const sEx = this.exchanges[op.details.shortExchange];
        const lEx = this.exchanges[op.details.longExchange];
        if(!sEx || !lEx) return;

        const sSym = await this.getSymbol(sEx, op.coin);
        const lSym = await this.getSymbol(lEx, op.coin);
        if(!sSym || !lSym) {
            this.log('error', `Exec Fail: ${op.coin} symbol missing`);
            return;
        }

        const sBal = this.balances[op.details.shortExchange].available;
        const lBal = this.balances[op.details.longExchange].available;
        const minBal = Math.min(sBal, lBal);
        
        let coll = (this.tradeConfig.mode === 'fixed') ? this.tradeConfig.value : minBal * (this.tradeConfig.value / 100);
        if (coll > minBal) coll = minBal;
        if (coll < MIN_COLLATERAL_FOR_TRADE) {
            this.log('error', `Exec Fail: Low Balance (${coll.toFixed(1)}$)`);
            return;
        }

        const lev = op.commonLeverage;
        try {
            if (sEx.id === 'kucoinfutures') try { await sEx.setMarginMode('cross', sSym); } catch(e){}
            if (lEx.id === 'kucoinfutures') try { await lEx.setMarginMode('cross', lSym); } catch(e){}
            await Promise.all([ sEx.setLeverage(lev, sSym), lEx.setLeverage(lev, lSym) ]);
        } catch(e){}

        const sTicker = await sEx.fetchTicker(sSym);
        const lTicker = await lEx.fetchTicker(lSym);
        const sPrice = sTicker.last;
        const lPrice = lTicker.last;

        const sAmt = parseFloat(sEx.amountToPrecision(sSym, (coll*lev)/sPrice));
        const lAmt = parseFloat(lEx.amountToPrecision(lSym, (coll*lev)/lPrice));

        try {
            const [sOrd, lOrd] = await Promise.all([
                sEx.createMarketSellOrder(sSym, sAmt, sEx.id==='binanceusdm'?{positionSide:'SHORT'}:{}),
                lEx.createMarketBuyOrder(lSym, lAmt, lEx.id==='binanceusdm'?{positionSide:'LONG'}:{})
            ]);

            const trade = {
                id: Date.now(), coin: op.coin, 
                shortExchange: sEx.id, longExchange: lEx.id,
                shortSymbol: sSym, longSymbol: lSym, 
                shortOrderId: sOrd.id, longOrderId: lOrd.id,
                entryTime: Date.now(), estimatedPnlFromOpportunity: op.estimatedPnl, 
                shortAmount: sAmt, longAmount: lAmt, status: 'OPEN',
                leverage: lev,
                entryPriceShort: sPrice, entryPriceLong: lPrice,
                collateral: coll
            };
            this.activeTrades.push(trade);
            this.capitalManagementState = 'TRADE_OPEN';
            this.lockedOpp = null;
            
            // LOG OPEN GỌN GÀNG
            this.log('trade', `OPEN | Coin: ${op.coin} | Money: ${coll.toFixed(1)}$ (x${lev}) | Est PnL: ${op.estimatedPnl}%`);
            
            this.placeTpSl(sEx, sSym, 'sell', sAmt, sPrice, coll, lev);
            this.placeTpSl(lEx, lSym, 'buy', lAmt, lPrice, coll, lev);

        } catch(e) {
            this.log('error', `Order Fail ${op.coin}: ${e.message}`);
        }
    }

    async placeTpSl(ex, sym, side, amt, price, coll, lev) {
        try {
            const slChg = price * (SL_PERCENTAGE/100/lev);
            const tpChg = price * (TP_PERCENTAGE/100/lev);
            let tp = side==='sell' ? price - tpChg : price + tpChg;
            let sl = side==='sell' ? price + slChg : price - slChg;
            
            const bP = {'closePosition': 'true', 'positionSide': side==='sell'?'SHORT':'LONG'};
            const kP = {'reduceOnly': true, 'marginMode': 'cross'};
            const oSide = side==='sell'?'buy':'sell';

            if (ex.id === 'binanceusdm') {
                await ex.createOrder(sym, 'TAKE_PROFIT_MARKET', oSide, amt, undefined, {...bP, 'stopPrice':ex.priceToPrecision(sym, tp)});
                await ex.createOrder(sym, 'STOP_MARKET', oSide, amt, undefined, {...bP, 'stopPrice':ex.priceToPrecision(sym, sl)});
            } else {
                await ex.createOrder(sym, 'market', oSide, amt, undefined, {...kP, 'stop':(side==='sell'?'down':'up'), 'stopPrice':ex.priceToPrecision(sym, tp), 'stopPriceType':'MP'});
                await ex.createOrder(sym, 'market', oSide, amt, undefined, {...kP, 'stop':(side==='sell'?'up':'down'), 'stopPrice':ex.priceToPrecision(sym, sl), 'stopPriceType':'MP'});
            }
        } catch(e) { this.log('error', `TP/SL Fail ${sym}: ${e.message}`); }
    }

    // --- CLOSE ALL & CALC REAL PNL ---
    async closeAll() {
        for (const t of this.activeTrades) {
            const sEx = this.exchanges[t.shortExchange];
            const lEx = this.exchanges[t.longExchange];
            
            let exitShortPrice = t.entryPriceShort; 
            let exitLongPrice = t.entryPriceLong;
            try {
                const sTick = await sEx.fetchTicker(t.shortSymbol);
                const lTick = await lEx.fetchTicker(t.longSymbol);
                exitShortPrice = sTick.last;
                exitLongPrice = lTick.last;
            } catch(e) {}

            try { await sEx.createMarketBuyOrder(t.shortSymbol, t.shortAmount, sEx.id==='binanceusdm'?{positionSide:'SHORT'}:{reduceOnly:true}); } catch(e){ this.log('error', `Close Short Err: ${e.message}`); }
            try { await lEx.createMarketSellOrder(t.longSymbol, t.longAmount, lEx.id==='binanceusdm'?{positionSide:'LONG'}:{reduceOnly:true}); } catch(e){ this.log('error', `Close Long Err: ${e.message}`); }
            
            t.status = 'CLOSED';
            this.saveHistory(t);

            // TÍNH REAL PNL
            // Short: (Entry - Exit) * Amount
            // Long: (Exit - Entry) * Amount
            const pnlShort = (t.entryPriceShort - exitShortPrice) * t.shortAmount;
            const pnlLong = (exitLongPrice - t.entryPriceLong) * t.longAmount;
            const totalRealizedPnl = pnlShort + pnlLong;

            // LOG CLOSE KÈM PNL THỰC
            this.log('result', `CLOSE | Coin: ${t.coin} | Real PnL: ${totalRealizedPnl > 0 ? '+' : ''}${totalRealizedPnl.toFixed(2)}$`);
        }
        this.activeTrades = [];
        this.capitalManagementState = 'IDLE';
        this.lockedOpp = null;
    }

    async start(tradeCfg) {
        if (this.state === 'RUNNING') return;
        if (tradeCfg) this.tradeConfig = tradeCfg;
        await this.initExchanges();
        await this.fetchBalances();
        this.state = 'RUNNING';
        this.activeTrades = []; 
        this.loop();
    }

    stop() {
        this.state = 'STOPPED';
        if (this.loopId) clearTimeout(this.loopId);
    }
}

// ============================================================
// SERVER
// ============================================================
const userSessions = new Map(); 

function getSession(req) {
    const username = req.headers['x-username'];
    if (!username) return null;
    const safeUser = getSafeFileName(username);
    if (!userSessions.has(safeUser)) {
        userSessions.set(safeUser, new BotEngine(username));
    }
    return userSessions.get(safeUser);
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-username'); 
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url;

    if (url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            if (err) { res.writeHead(500); res.end('No UI'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content);
        });
        return;
    }

    if (req.method === 'POST' || req.method === 'GET') {
        let body = '';
        if (req.method === 'POST') {
            req.on('data', chunk => body += chunk.toString());
            await new Promise(r => req.on('end', r));
        }

        // AUTH ROUTES
        if (url === '/bot-api/register' && req.method === 'POST') {
            try {
                const { username, password, email } = JSON.parse(body);
                const safeName = getSafeFileName(username);
                const cfgPath = path.join(USER_DATA_DIR, `${safeName}_config.json`);
                if (fs.existsSync(cfgPath)) {
                    res.writeHead(400); res.end(JSON.stringify({ success: false, message: 'User exists' }));
                    return;
                }
                const newConfig = {
                    username, password, email,
                    binanceApiKey: '', binanceApiSecret: '', 
                    kucoinApiKey: '', kucoinApiSecret: '', kucoinPassword: ''
                };
                fs.writeFileSync(cfgPath, JSON.stringify(newConfig, null, 2));
                res.end(JSON.stringify({ success: true }));
            } catch(e) { res.writeHead(500); res.end(JSON.stringify({ success: false })); }
            return;
        }

        if (url === '/bot-api/login' && req.method === 'POST') {
            try {
                const { username, password } = JSON.parse(body);
                const safeName = getSafeFileName(username);
                const cfgPath = path.join(USER_DATA_DIR, `${safeName}_config.json`);
                if (!fs.existsSync(cfgPath)) {
                    res.writeHead(401); res.end(JSON.stringify({ success: false, message: 'User not found' }));
                    return;
                }
                const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
                if (cfg.password === password) res.end(JSON.stringify({ success: true }));
                else res.writeHead(401); res.end(JSON.stringify({ success: false, message: 'Wrong password' }));
            } catch(e) { res.writeHead(500); res.end(JSON.stringify({ success: false })); }
            return;
        }

        // PROTECTED ROUTES
        const bot = getSession(req);
        if (!bot) {
            res.writeHead(401); res.end(JSON.stringify({ success: false, message: 'Invalid Session' }));
            return;
        }

        try {
            if (url === '/bot-api/start' && req.method === 'POST') {
                const payload = JSON.parse(body);
                bot.saveConfig(payload); 
                if(payload.autoBalance !== undefined) bot.config.autoBalance = payload.autoBalance;
                bot.saveConfig({}); 
                await bot.start(payload.tradeConfig);
                res.end(JSON.stringify({ success: true }));
            }
            else if (url === '/bot-api/stop') {
                bot.stop();
                res.end(JSON.stringify({ success: true }));
            }
            else if (url === '/bot-api/save-config') {
                bot.saveConfig(JSON.parse(body));
                res.end(JSON.stringify({ success: true }));
            }
            else if (url === '/bot-api/close-trade-now') {
                await bot.closeAll();
                res.end(JSON.stringify({ success: true }));
            }
            else if (url === '/bot-api/status') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                // Hiển thị coin đang khóa hoặc coin tốt nhất ĐÃ ĐƯỢC LỌC
                const displayOpp = (bot.capitalManagementState === 'FUNDS_READY' && bot.lockedOpp) ? bot.lockedOpp : bot.opp;
                res.end(JSON.stringify({
                    username: bot.username,
                    botState: bot.state,
                    capitalManagementState: bot.capitalManagementState,
                    balances: bot.balances,
                    tradeHistory: bot.history,
                    bestPotentialOpportunityForDisplay: displayOpp,
                    activeTrades: bot.activeTrades
                }));
            }
            else if (url === '/bot-api/config') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(bot.config));
            }
            else if (url === '/bot-api/update-balance-config') {
                const cfg = JSON.parse(body);
                bot.config.autoBalance = cfg.autoBalance;
                bot.saveConfig({});
                res.end(JSON.stringify({ success: true }));
            }
            else {
                res.writeHead(404); res.end();
            }
        } catch (e) {
            res.writeHead(500); res.end(JSON.stringify({ success: false, message: e.message }));
        }
    }
});

server.listen(BOT_PORT, () => {
    console.log(`Bot Server running on port ${BOT_PORT}`);
});
