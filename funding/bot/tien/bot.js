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
const MIN_MINUTES_FOR_EXECUTION = 15; 
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
// CLASS: BOT ENGINE (Đa người dùng)
// ============================================================
class BotEngine {
    constructor(username) {
        this.username = username;
        const safeName = getSafeFileName(username);
        this.configFile = path.join(USER_DATA_DIR, `${safeName}_config.json`);
        this.historyFile = path.join(USER_DATA_DIR, `${safeName}_history.json`);
        
        this.state = 'STOPPED';
        this.capitalState = 'IDLE';
        this.loopId = null;
        this.lastScanTime = 0;
        this.lastBalCheckTime = 0;
        this.balances = {};
        this.history = [];
        this.activeTrades = [];
        this.opp = null; 
        this.lockedOpp = null;
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

    log(type, ...args) {
        const t = new Date().toLocaleTimeString('vi-VN');
        let msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
        if (msg.includes('<!DOCTYPE') || msg.includes('<html>')) return;
        console.log(`[${t}] [USER:${this.username}] [${type.toUpperCase()}] ${msg}`);
    }

    // --- CONFIG & HISTORY ---
    loadConfig() {
        try {
            if (fs.existsSync(this.configFile)) {
                const saved = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
                this.config = { ...this.config, ...saved };
            }
        } catch (e) {}
    }

    loadHistory() {
        try {
            if (fs.existsSync(this.historyFile)) {
                this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
            }
        } catch(e) {}
    }

    saveConfig(newConfig = {}) {
        for (let k in newConfig) {
            if (newConfig[k] !== undefined) this.config[k] = newConfig[k];
        }
        fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2));
        this.log('info', 'Config Saved.');
    }

    saveHistory(trade) {
        this.history.unshift(trade);
        if(this.history.length > 50) this.history = this.history.slice(0,50);
        fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2));
    }

    // --- HELPER: LẤY ĐỊA CHỈ VÍ (Ưu tiên Config User -> Fallback balance.js) ---
    getTargetDepositAddress(exchangeId) {
        // 1. Check User Config trước
        if (exchangeId === 'binanceusdm' && this.config.binanceDepositAddress) return { address: this.config.binanceDepositAddress, network: 'APT' };
        if (exchangeId === 'kucoinfutures' && this.config.kucoinDepositAddress) return { address: this.config.kucoinDepositAddress, network: 'BEP20' };

        // 2. Fallback sang file balance.js
        // Mapping ID sàn trong balance.js (binance, kucoin)
        let lookupKey = exchangeId === 'binanceusdm' ? 'binance' : 'kucoin';
        let network = exchangeId === 'binanceusdm' ? 'APT' : 'BEP20'; // Binance nhận Aptos, Kucoin nhận BEP20

        // Thử tìm trong fallbackBalance
        // Cấu trúc balance.js thường là: { kucoin: { BEP20: "0x..." }, binance: { APT: "0x..." } }
        let addr = null;
        
        // Case 1: Structure usdtDepositAddressesByNetwork.kucoin.BEP20
        if (fallbackBalance[lookupKey] && fallbackBalance[lookupKey][network]) {
            addr = fallbackBalance[lookupKey][network];
        }
        // Case 2: Structure usdtDepositAddressesByNetwork.kucoinfutures.BEP20
        else if (fallbackBalance[exchangeId] && fallbackBalance[exchangeId][network]) {
            addr = fallbackBalance[exchangeId][network];
        }

        if (addr) {
            this.log('info', `[WALLET] Using fallback address from balance.js for ${exchangeId}`);
            return { address: addr, network: network };
        }

        return null;
    }

    // --- EXCHANGE INIT ---
    async initExchanges() {
        const cfg = this.config;
        this.exchanges = {}; 
        this.balances = {};

        // Binance (Future & Spot)
        if (cfg.binanceApiKey && cfg.binanceApiSecret) {
            try {
                this.exchanges['binanceusdm'] = new ccxt.binanceusdm({ apiKey: cfg.binanceApiKey, secret: cfg.binanceApiSecret, enableRateLimit:true, options: { defaultType: 'swap' } });
                this.exchanges['binance'] = new ccxt.binance({ apiKey: cfg.binanceApiKey, secret: cfg.binanceApiSecret, enableRateLimit:true });
                setTimeout(async () => {
                    try { await this.exchanges['binanceusdm'].fapiPrivatePostPositionSideDual({ 'dualSidePosition': 'true' }); } catch(e){}
                }, 1000);
            } catch (e) { this.log('error', 'Binance Init Fail'); }
        }

        // Kucoin (Future & Spot)
        if (cfg.kucoinApiKey && cfg.kucoinApiSecret && cfg.kucoinPassword) {
            try {
                this.exchanges['kucoinfutures'] = new ccxt.kucoinfutures({ apiKey: cfg.kucoinApiKey, secret: cfg.kucoinApiSecret, password: cfg.kucoinPassword, enableRateLimit:true });
                this.exchanges['kucoin'] = new ccxt.kucoin({ apiKey: cfg.kucoinApiKey, secret: cfg.kucoinApiSecret, password: cfg.kucoinPassword, enableRateLimit:true });
                setTimeout(async () => {
                    try { await this.exchanges['kucoinfutures'].privatePostPositionSideDual({ 'dualSidePosition': 'true' }); } catch(e){}
                }, 1000);
            } catch (e) { this.log('error', 'KuCoin Init Fail'); }
        }
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

    // --- TRANSFER LOGIC (PORTED FROM OLD BOT) ---
    
    // Helper để chờ tiền về và chuyển sang Future
    async attemptInternalTransferOnArrival(toExchangeId, fromExchangeId, amountSent) {
        this.log('info', `[RETRY-TRANSFER] Monitoring arrival on ${toExchangeId}...`);
        const maxRetries = 30; // 10 phút
        
        let checkerId = (toExchangeId === 'kucoinfutures') ? 'kucoin' : 'binance';
        let transfererId = toExchangeId;
        
        const checkerEx = this.exchanges[checkerId];
        const transfererEx = this.exchanges[transfererId];

        if (!checkerEx || !transfererEx) return;

        for (let i = 1; i <= maxRetries; i++) {
            await new Promise(r => setTimeout(r, 20000)); // Chờ 20s
            try {
                const bal = await checkerEx.fetchBalance();
                // Kucoin spot nằm ở 'trade' hoặc 'main' tùy account, thường 'main' cho deposit
                // Binance spot là 'free'
                const spotBal = bal.free.USDT || 0; 

                // Kiểm tra xem tiền đã về chưa (chấp nhận sai số phí)
                if (spotBal >= amountSent - FUND_ARRIVAL_TOLERANCE) {
                    this.log('info', `[RETRY-TRANSFER] ✅ Funds arrived in Spot! (${spotBal.toFixed(2)}$). Transferring to Future...`);
                    
                    // Chuyển Spot -> Future
                    // Binance: spot -> future
                    // Kucoin: main -> future
                    let fromType = (toExchangeId === 'binanceusdm') ? 'spot' : 'main';
                    let toType = 'future'; // Kucoin cũng dùng 'future' ở param 4
                    
                    await transfererEx.transfer('USDT', spotBal, fromType, toType);
                    this.log('info', `[RETRY-TRANSFER] ✅ Successfully moved to Futures wallet!`);
                    await this.fetchBalances(); // Update balance hiển thị
                    return;
                } else {
                    this.log('info', `[RETRY-TRANSFER] Waiting... (${spotBal.toFixed(2)} / ${amountSent})`);
                }
            } catch (e) {
                this.log('warn', `[RETRY-TRANSFER] Check failed: ${e.message}`);
            }
        }
        this.log('error', `[RETRY-TRANSFER] ❌ Timeout waiting for funds.`);
    }

    async executeSingleFundTransfer(fromExchangeId, toExchangeId, amount) {
        this.log('info', `[TRANSFER] Starting transfer ${amount}$ from ${fromExchangeId} -> ${toExchangeId}`);
        
        const sourceEx = this.exchanges[fromExchangeId];
        
        // 1. Lấy địa chỉ ví đích
        const targetInfo = this.getTargetDepositAddress(toExchangeId);
        if (!targetInfo) {
            this.log('error', `[TRANSFER] ❌ Missing Deposit Address for ${toExchangeId}. Check config or balance.js`);
            return false;
        }

        try {
            // 2. Chuyển Future -> Spot/Main
            let fromWallet = 'future';
            let toWallet = (fromExchangeId === 'binanceusdm') ? 'spot' : 'main'; // Kucoin future -> main
            
            this.log('info', `[TRANSFER] 1/3: Internal Transfer Future -> Spot...`);
            await sourceEx.transfer('USDT', amount, fromWallet, toWallet);
            
            await new Promise(r => setTimeout(r, 3000));

            // 3. Rút tiền (Withdraw)
            let withdrawerEx = (fromExchangeId === 'binanceusdm') ? this.exchanges['binance'] : this.exchanges['kucoin'];
            
            // Params rút tiền
            // Binance -> Kucoin (BEP20/BSC)
            // Kucoin -> Binance (APT)
            const params = {};
            if (fromExchangeId === 'binanceusdm') params.network = 'BSC'; 
            else params.network = 'APT';

            this.log('info', `[TRANSFER] 2/3: Withdrawing to ${targetInfo.address} (${params.network})...`);
            
            await withdrawerEx.withdraw('USDT', amount, targetInfo.address, undefined, params);
            
            // 4. Kích hoạt theo dõi tiền về
            this.log('info', `[TRANSFER] 3/3: Withdraw sent. Monitoring arrival...`);
            this.attemptInternalTransferOnArrival(toExchangeId, fromExchangeId, amount);
            
            return true;

        } catch (e) {
            this.log('error', `[TRANSFER] Failed: ${e.message}`);
            return false;
        }
    }

    // --- AUTO BALANCE CHECK ---
    async checkAndBalanceCapital() {
        if (!this.config.autoBalance) return;
        
        const now = new Date();
        if (now.getMinutes() !== BALANCE_CHECK_MINUTE) return;
        if (Date.now() - this.lastBalCheckTime < 60000) return;
        this.lastBalCheckTime = Date.now();

        this.log('info', '[BALANCE] ⚖️ Checking balance...');
        await this.fetchBalances();
        
        const bBal = this.balances['binanceusdm']?.total || 0;
        const kBal = this.balances['kucoinfutures']?.total || 0;
        const diff = Math.abs(bBal - kBal);
        const amount = diff / 2;

        if (diff > MIN_DIFF_FOR_BALANCE && amount > 5) { 
            this.log('warn', `[BALANCE] Diff > 20$ (${diff.toFixed(2)}). Balancing...`);
            if (bBal > kBal) await this.executeSingleFundTransfer('binanceusdm', 'kucoinfutures', amount);
            else await this.executeSingleFundTransfer('kucoinfutures', 'binanceusdm', amount);
        }
    }

    // --- MAIN LOOP ---
    async loop() {
        if (this.state !== 'RUNNING') return;
        try {
            const now = new Date();
            const m = now.getUTCMinutes(), s = now.getUTCSeconds();
            const nowMs = Date.now();

            // Reset lock phút 01
            if (m === 1 && this.capitalManagementState === 'FUNDS_READY') {
                this.capitalManagementState = 'IDLE';
                this.lockedOpp = null;
            }

            // Lấy dữ liệu server
            if (!this.lockedOpp) {
                const res = await fetch(SERVER_DATA_URL);
                const data = await res.json();
                if (data && data.arbitrageData) {
                    const cands = data.arbitrageData.filter(op => {
                        const [s, l] = op.exchanges.toLowerCase().split(' / ');
                        const isBinance = s.includes('binance') || l.includes('binance');
                        const isKucoin = s.includes('kucoin') || l.includes('kucoin');
                        
                        return isBinance && isKucoin && 
                               op.estimatedPnl >= MIN_PNL_PERCENTAGE && 
                               !BLACKLISTED_COINS.includes(op.coin);
                    }).map(op => {
                        const [s,l] = op.exchanges.toLowerCase().split(' / ');
                        op.details = { 
                            shortExchange: s.includes('binance') ? 'binanceusdm' : 'kucoinfutures', 
                            longExchange: l.includes('binance') ? 'binanceusdm' : 'kucoinfutures' 
                        };
                        return op;
                    }).sort((a,b) => b.estimatedPnl - a.estimatedPnl);
                    this.opp = cands[0];
                }
            }

            // Auto Balance
            await this.checkAndBalanceCapital();

            // 1. Quét (Phút 55 - 59)
            if (this.capitalManagementState === 'IDLE' && m >= 55 && m <= 59) {
                if ((m !== 59 || s < 30) && (nowMs - this.lastScanTime >= 25000)) {
                    if (this.opp) { 
                        await this.runSelection([this.opp]);
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

        } catch (e) { }

        if (this.state === 'RUNNING') {
            this.loopId = setTimeout(() => this.loop(), 1000);
        }
    }

    // --- LOGIC CHỌN COIN, EXECUTE, MONITOR ... GIỮ NGUYÊN TỪ BẢN TRƯỚC ---
    // (Tôi copy lại để đảm bảo file hoàn chỉnh)
    
    async hasOpenPosition(exchange, symbol) {
        try {
            const positions = await exchange.fetchPositions();
            const pos = positions.find(p => 
                (p.symbol === symbol || p.info.symbol === symbol) && 
                parseFloat(p.contracts || p.info.positionAmt || 0) !== 0
            );
            return !!pos;
        } catch (e) { return false; }
    }

    async runSelection(candidates) {
        for (const op of candidates) {
            if (this.activeTrades.some(t => t.coin === op.coin)) continue;
            
            const sEx = this.exchanges[op.details.shortExchange];
            const lEx = this.exchanges[op.details.longExchange];
            if(!sEx || !lEx) continue;

            const sBal = this.balances[op.details.shortExchange]?.available || 0;
            const lBal = this.balances[op.details.longExchange]?.available || 0;
            
            if (sBal <= MIN_COLLATERAL_FOR_TRADE || lBal <= MIN_COLLATERAL_FOR_TRADE) continue;

            const sSym = await this.getSymbol(sEx, op.coin);
            const lSym = await this.getSymbol(lEx, op.coin);
            if(!sSym || !lSym) continue;

            const hasShortPos = await this.hasOpenPosition(sEx, sSym);
            const hasLongPos = await this.hasOpenPosition(lEx, lSym);

            if (hasShortPos || hasLongPos) continue;

            this.lockedOpp = op;
            this.capitalManagementState = 'FUNDS_READY';
            this.log('info', `🎯 Selected ${op.coin} (Waiting 59:30)`);
            return;
        }
    }

    async executeTrade(op) {
        this.log('info', `🚀 Executing ${op.coin}`);
        const sEx = this.exchanges[op.details.shortExchange];
        const lEx = this.exchanges[op.details.longExchange];
        if(!sEx || !lEx) return;

        const sSym = await this.getSymbol(sEx, op.coin);
        const lSym = await this.getSymbol(lEx, op.coin);
        if(!sSym || !lSym) return;

        const sBal = this.balances[op.details.shortExchange].available;
        const lBal = this.balances[op.details.longExchange].available;
        const minBal = Math.min(sBal, lBal);
        
        let coll = (this.tradeConfig.mode === 'fixed') ? this.tradeConfig.value : minBal * (this.tradeConfig.value / 100);
        if (coll > minBal) coll = minBal;
        if (coll < MIN_COLLATERAL_FOR_TRADE) return;

        const lev = op.commonLeverage;
        try {
            if (sEx.id === 'kucoinfutures') try { await sEx.setMarginMode('cross', sSym); } catch(e){}
            if (lEx.id === 'kucoinfutures') try { await lEx.setMarginMode('cross', lSym); } catch(e){}
            await Promise.all([ sEx.setLeverage(lev, sSym), lEx.setLeverage(lev, lSym) ]);
        } catch(e){}

        const sPrice = (await sEx.fetchTicker(sSym)).last;
        const lPrice = (await lEx.fetchTicker(lSym)).last;
        const sAmt = parseFloat(sEx.amountToPrecision(sSym, (coll*lev)/sPrice));
        const lAmt = parseFloat(lEx.amountToPrecision(lSym, (coll*lev)/lPrice));

        try {
            const [sOrd, lOrd] = await Promise.all([
                sEx.createMarketSellOrder(sSym, sAmt, sEx.id==='binanceusdm'?{positionSide:'SHORT'}:{}),
                lEx.createMarketBuyOrder(lSym, lAmt, lEx.id==='binanceusdm'?{positionSide:'LONG'}:{})
            ]);

            const trade = {
                id: Date.now(), coin: op.coin, shortExchange: sEx.id, longExchange: lEx.id,
                shortSymbol: sSym, longSymbol: lSym, shortOrderId: sOrd.id, longOrderId: lOrd.id,
                entryTime: Date.now(), estimatedPnlFromOpportunity: op.estimatedPnl, 
                shortAmount: sAmt, longAmount: lAmt, status: 'OPEN',
                leverage: lev
            };
            this.activeTrades.push(trade);
            this.capitalManagementState = 'TRADE_OPEN';
            this.lockedOpp = null;
            this.log('info', '✅ Trade Opened');
            
            // Place TP/SL
            this.placeTpSl(sEx, sSym, 'sell', sAmt, sPrice, coll, lev);
            this.placeTpSl(lEx, lSym, 'buy', lAmt, lPrice, coll, lev);

        } catch(e) {
            this.log('error', `Open Failed: ${e.message}`);
        }
    }

    async placeTpSl(exchange, symbol, side, amount, entryPrice, collateral, leverage) {
        try {
            const notional = collateral * leverage;
            const slChange = entryPrice * (SL_PERCENTAGE / 100 / leverage);
            const tpChange = entryPrice * (TP_PERCENTAGE / 100 / leverage);

            let tpPrice, slPrice;
            if (side === 'sell') { 
                tpPrice = entryPrice - tpChange;
                slPrice = entryPrice + slChange;
            } else { 
                tpPrice = entryPrice + tpChange;
                slPrice = entryPrice - slChange;
            }

            const binanceParams = { 'closePosition': 'true' };
            if (exchange.id === 'binanceusdm') binanceParams.positionSide = (side === 'sell') ? 'SHORT' : 'LONG';
            const kucoinParams = { 'reduceOnly': true, 'marginMode': 'cross' };
            const orderSide = (side === 'sell') ? 'buy' : 'sell';

            if (exchange.id === 'binanceusdm') {
                await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', orderSide, amount, undefined, { ...binanceParams, 'stopPrice': exchange.priceToPrecision(symbol, tpPrice) });
                await exchange.createOrder(symbol, 'STOP_MARKET', orderSide, amount, undefined, { ...binanceParams, 'stopPrice': exchange.priceToPrecision(symbol, slPrice) });
            } else {
                await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, { ...kucoinParams, 'stop': (side==='sell'?'down':'up'), 'stopPrice': exchange.priceToPrecision(symbol, tpPrice), 'stopPriceType':'MP' });
                await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, { ...kucoinParams, 'stop': (side==='sell'?'up':'down'), 'stopPrice': exchange.priceToPrecision(symbol, slPrice), 'stopPriceType':'MP' });
            }
        } catch(e) { this.log('error', `TP/SL Failed: ${e.message}`); }
    }

    async closeAll() {
        this.log('warn', 'Closing All Trades...');
        for (const t of this.activeTrades) {
            const sEx = this.exchanges[t.shortExchange];
            const lEx = this.exchanges[t.longExchange];
            try { await sEx.createMarketBuyOrder(t.shortSymbol, t.shortAmount, sEx.id==='binanceusdm'?{positionSide:'SHORT'}:{reduceOnly:true}); } catch(e){}
            try { await lEx.createMarketSellOrder(t.longSymbol, t.longAmount, lEx.id==='binanceusdm'?{positionSide:'LONG'}:{reduceOnly:true}); } catch(e){}
            t.status = 'CLOSED';
            this.saveHistory(t);
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
