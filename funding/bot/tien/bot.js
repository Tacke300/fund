const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

// [IMPORT VÍ ADMIN - NẾU CÓ]
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
        const allowedTypes = ['error', 'trade', 'result', 'fee', 'vip', 'transfer', 'info', 'warn'];
        if (!allowedTypes.includes(type)) return;
        const t = new Date().toLocaleTimeString('vi-VN', { hour12: false });
        console.log(`[${t}] [USER: ${this.username}] [${type.toUpperCase()}] ${msg}`);
    }

    loadConfig() { try { if (fs.existsSync(this.configFile)) { const saved = JSON.parse(fs.readFileSync(this.configFile, 'utf8')); this.config = { ...this.config, ...saved }; } } catch (e) {} }
    saveConfig(newConfig = {}) { for (let k in newConfig) if (newConfig[k] !== undefined) this.config[k] = newConfig[k]; fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2)); }
    loadHistory() { try { if (fs.existsSync(this.historyFile)) this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8')); } catch(e) {} }
    saveHistory(trade) { this.history.unshift(trade); if(this.history.length > 50) this.history = this.history.slice(0,50); fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2)); }

    // --- HELPER: Lấy tham số mạng lưới ---
    getWithdrawParams(exchangeId, targetNetwork) {
        const net = targetNetwork.toUpperCase();
        if (exchangeId.includes('binance')) {
            if (net === 'BEP20' || net === 'BSC') return { network: 'BSC' };
        }
        if (exchangeId.includes('kucoin')) {
            if (net === 'BEP20' || net === 'BSC') return { network: 'BEP20' }; 
            if (net === 'APTOS' || net === 'APT') return { network: 'APT' };
        }
        return { network: net };
    }

    getAdminFeeWallet(sourceExchangeId) {
        if (!adminWallets) return null;
        if (sourceExchangeId === 'binanceusdm') return { address: adminWallets['kucoin']?.['BEP20'], network: 'BEP20' };
        else return { address: adminWallets['binance']?.['BEP20'], network: 'BEP20' };
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
                setTimeout(async()=>{try{await this.exchanges['binanceusdm'].fapiPrivatePostPositionSideDual({'dualSidePosition':'true'})}catch(e){}},1000);
            }
            if (cfg.kucoinApiKey) {
                this.exchanges['kucoinfutures'] = new ccxt.kucoinfutures({ apiKey: cfg.kucoinApiKey, secret: cfg.kucoinApiSecret, password: cfg.kucoinPassword, enableRateLimit:true });
                this.exchanges['kucoin'] = new ccxt.kucoin({ apiKey: cfg.kucoinApiKey, secret: cfg.kucoinApiSecret, password: cfg.kucoinPassword, enableRateLimit:true });
                await this.exchanges['kucoinfutures'].loadMarkets();
                setTimeout(async()=>{try{await this.exchanges['kucoinfutures'].privatePostPositionSideDual({'dualSidePosition':'true'})}catch(e){}},1000);
            }
        } catch(e) { this.log('error', `Init Fail: ${e.message}`); }
    }

    async snapshotAssets() {
        this.log('info', '📸 Snapshotting assets...');
        let bFut = 0, kFut = 0, bSpot = 0, kSpot = 0;
        try { if (this.exchanges['binanceusdm']) bFut = (await this.exchanges['binanceusdm'].fetchBalance()).total.USDT || 0; } catch(e) {}
        try { if (this.exchanges['kucoinfutures']) kFut = (await this.exchanges['kucoinfutures'].fetchBalance()).total.USDT || 0; } catch(e) {}
        try { if (this.exchanges['binance']) bSpot = (await this.exchanges['binance'].fetchBalance()).total.USDT || 0; } catch(e) {}
        try { if (this.exchanges['kucoin']) kSpot = (await this.exchanges['kucoin'].fetchBalance()).total.USDT || 0; } catch(e) {}

        const totalAssets = bFut + kFut + bSpot + kSpot;
        this.config.savedBinanceFut = bFut;
        this.config.savedKucoinFut = kFut;
        this.config.savedTotalAssets = totalAssets;
        this.saveConfig();
        this.log('info', `✅ Snapshot: B-Fut:${bFut.toFixed(1)}$, K-Fut:${kFut.toFixed(1)}$, Total:${totalAssets.toFixed(1)}$`);
        await this.fetchBalances();
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

    // --- LOGIC CHUYỂN TIỀN TỰ ĐỘNG (DÙNG CHO AUTO BALANCE) ---
    async autoFundTransfer(fromId, toId, amount) {
        if (!this.exchanges[fromId] || !this.exchanges[toId]) return false;

        const targetInfo = this.getUserDepositAddress(toId);
        if (!targetInfo || !targetInfo.address) { 
            this.log('error', `Thiếu địa chỉ nạp tiền ${toId}. Không thể Auto-Balance.`); 
            return false; 
        }

        this.log('transfer', `🤖 Auto-Balance: Đang chuyển ${amount.toFixed(1)}$ từ ${fromId} -> ${toId}`);

        const sourceEx = this.exchanges[fromId]; 
        const withdrawEx = this.exchanges[fromId === 'binanceusdm' ? 'binance' : 'kucoin']; 

        try {
            // 1. Chuyển Future -> Spot
            let fromWallet = 'future';
            let toWallet = fromId === 'binanceusdm' ? 'spot' : 'main';
            await sourceEx.transfer('USDT', amount, fromWallet, toWallet);
            await sleep(2000);

            // 2. Rút tiền (Spot -> Sàn kia)
            const params = this.getWithdrawParams(fromId, targetInfo.network);
            await withdrawEx.withdraw('USDT', amount, targetInfo.address, undefined, params);
            
            this.log('transfer', `✅ Auto-Balance: Đã rút tiền. Đang chờ tiền về ${toId}...`);

            // 3. Gọi hàm canh tiền về (Chạy ngầm)
            this.monitorAndMoveToFuture(toId, amount);
            return true;

        } catch (e) {
            this.log('error', `❌ Auto-Balance Error: ${e.message}`);
            return false;
        }
    }

    // Hàm canh tiền và chuyển vào Future
    async monitorAndMoveToFuture(exchangeId, expectedAmount) {
        const spotEx = this.exchanges[exchangeId === 'binanceusdm' ? 'binance' : 'kucoin'];
        const futEx = this.exchanges[exchangeId];
        const maxRetries = 60; // 30 phút
        const checkInterval = 30000;
        let walletSource = exchangeId === 'binanceusdm' ? 'spot' : 'main';

        for (let i = 0; i < maxRetries; i++) {
            await sleep(checkInterval);
            try {
                const bal = await spotEx.fetchBalance();
                const available = bal.free.USDT || 0;

                // Nếu tiền về (cho phép lệch 1 ít)
                if (available >= (expectedAmount - FUND_ARRIVAL_TOLERANCE)) {
                    this.log('transfer', `💰 Tiền đã về (${available}$). Đang chuyển vào Future...`);
                    await futEx.transfer('USDT', available, walletSource, 'future');
                    this.log('transfer', `✅ Hoàn tất Auto-Balance cho ${exchangeId}.`);
                    await this.fetchBalances();
                    return;
                }
            } catch (e) { console.log(`[Monitor Error] ${e.message}`); }
        }
        this.log('warn', `⚠️ Quá thời gian chờ tiền về trên ${exchangeId}.`);
    }

    // --- FEE PAYMENT (Logic rút đơn giản) ---
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
        } catch (e) { return false; }
    }

    async collectDailyFee() {
        this.loadConfig(); 
        if (this.config.vipStatus === 'vip_pro') return true;
        if (this.config.vipStatus === 'vip') {
            if (Date.now() < this.config.vipExpiry) return true;
            this.config.vipStatus = 'none'; this.saveConfig();
        }
        const todayUTC = new Date().toISOString().split('T')[0];
        if (this.config.lastFeePaidDate === todayUTC) return true;

        const fee = this.config.autoBalance ? FEE_AUTO_ON : FEE_AUTO_OFF;
        this.log('fee', `Collecting daily fee: ${fee}$`);
        
        await this.fetchBalances();
        const bBal = this.balances['binanceusdm']?.available || 0;
        const kBal = this.balances['kucoinfutures']?.available || 0;

        if (bBal < 5 && kBal < 5) return false; 

        let paid = false;
        if (kBal >= fee + 1) {
             const adminInfo = this.getAdminFeeWallet('kucoinfutures');
             if(adminInfo) paid = await this.performWithdrawalSimple('kucoinfutures', fee, adminInfo);
        } else if (bBal >= fee + 1) {
             const adminInfo = this.getAdminFeeWallet('binanceusdm');
             if(adminInfo) paid = await this.performWithdrawalSimple('binanceusdm', fee, adminInfo);
        }

        if (paid) {
            this.config.lastFeePaidDate = todayUTC; this.saveConfig();
            this.log('fee', `Fee Paid.`);
            return true;
        }
        return false;
    }

    async upgradeToVip() {
        this.loadConfig(); 
        await this.fetchBalances();
        const bBal = this.balances['binanceusdm']?.available || 0;
        const kBal = this.balances['kucoinfutures']?.available || 0;
        const cost = FEE_VIP_MONTHLY;
        let success = false;
        
        if (kBal >= cost + 1) {
            const t = this.getAdminFeeWallet('kucoinfutures');
            success = await this.performWithdrawalSimple('kucoinfutures', cost, t);
        } else if (bBal >= cost + 1) {
            const t = this.getAdminFeeWallet('binanceusdm');
            success = await this.performWithdrawalSimple('binanceusdm', cost, t);
        }
        
        if (success) {
            this.config.vipStatus = 'vip';
            this.config.vipExpiry = Date.now() + (30 * 24 * 60 * 60 * 1000);
            this.saveConfig(); return true;
        }
        return false;
    }

    // --- AUTO BALANCE CHECKER ---
    async checkAndBalanceCapital() {
        if (!this.config.autoBalance) return;
        if (this.activeTrades.length > 0) return; 
        if (Date.now() - this.lastBalCheckTime < 60000) return; // Check mỗi phút
        this.lastBalCheckTime = Date.now();

        await this.fetchBalances();
        const b = this.balances['binanceusdm']?.total || 0;
        const k = this.balances['kucoinfutures']?.total || 0;
        const total = b + k;
        if (total < 20) return;

        const diff = Math.abs(b - k);
        const amountToMove = diff / 2;

        // Chỉ cân bằng nếu lệch > 20$ và lượng chuyển > 10$
        if (diff > 20 && amountToMove > 10) {
            this.log('info', `⚖️ Phát hiện lệch vốn (Delta=${diff.toFixed(1)}$). Kích hoạt Auto-Balance...`);
            // GỌI HÀM CHUYỂN TIỀN TỰ ĐỘNG Ở ĐÂY
            if (b > k) await this.autoFundTransfer('binanceusdm', 'kucoinfutures', amountToMove);
            else await this.autoFundTransfer('kucoinfutures', 'binanceusdm', amountToMove);
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

    async hasOpenPosition(ex, sym) {
        try {
            const positions = await ex.fetchPositions();
            return !!positions.find(p => (p.symbol === sym || p.info.symbol === sym) && parseFloat(p.contracts || p.info.positionAmt || 0) !== 0);
        } catch (e) { return false; }
    }

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
            const sEx = this.exchanges[opDetail.details.shortExchange];
            const lEx = this.exchanges[opDetail.details.longExchange];
            if (!sEx || !lEx) continue;
            const sSym = await this.getSymbol(sEx, op.coin);
            const lSym = await this.getSymbol(lEx, op.coin);
            if (sSym && lSym) tradable.push(opDetail);
        }
        return tradable.sort((a,b) => b.estimatedPnl - a.estimatedPnl);
    }

    async runSelection(candidates) {
        for (const op of candidates) {
            if (this.activeTrades.some(t => t.coin === op.coin)) continue;
            const sEx = this.exchanges[op.details.shortExchange];
            const lEx = this.exchanges[op.details.longExchange];
            const sSym = await this.getSymbol(sEx, op.coin);
            const lSym = await this.getSymbol(lEx, op.coin);
            const hasShort = await this.hasOpenPosition(sEx, sSym);
            const hasLong = await this.hasOpenPosition(lEx, lSym);
            if (hasShort || hasLong) continue;
            const sBal = this.balances[op.details.shortExchange]?.available || 0;
            const lBal = this.balances[op.details.longExchange]?.available || 0;
            if (sBal <= MIN_COLLATERAL_FOR_TRADE || lBal <= MIN_COLLATERAL_FOR_TRADE) continue;

            this.lockedOpp = op; this.opp = op;
            this.capitalManagementState = 'FUNDS_READY';
            return;
        }
    }

    async executeTrade(op) {
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
                id: Date.now(), coin: op.coin, shortExchange: sEx.id, longExchange: lEx.id, shortSymbol: sSym, longSymbol: lSym, shortOrderId: sOrd.id, longOrderId: lOrd.id, entryTime: Date.now(), estimatedPnlFromOpportunity: op.estimatedPnl, shortAmount: sAmt, longAmount: lAmt, status: 'OPEN', leverage: lev, entryPriceShort: sPrice, entryPriceLong: lPrice, collateral: coll
            };
            this.activeTrades.push(trade);
            this.capitalManagementState = 'TRADE_OPEN';
            this.lockedOpp = null;
            this.log('trade', `OPEN | Coin: ${op.coin} | Money: ${coll.toFixed(1)}$ (x${lev})`);
            this.placeTpSl(sEx, sSym, 'sell', sAmt, sPrice, coll, lev);
            this.placeTpSl(lEx, lSym, 'buy', lAmt, lPrice, coll, lev);
        } catch(e) { this.log('error', `Order Fail ${op.coin}: ${e.message}`); }
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

    async closeAll() {
        this.log('info', '🛑 Closing all positions...');
        for (const t of this.activeTrades) {
            const sEx = this.exchanges[t.shortExchange];
            const lEx = this.exchanges[t.longExchange];
            let exitShort = t.entryPriceShort; let exitLong = t.entryPriceLong;
            try { exitShort = (await sEx.fetchTicker(t.shortSymbol)).last; exitLong = (await lEx.fetchTicker(t.longSymbol)).last; } catch(e){}
            try { await sEx.createMarketBuyOrder(t.shortSymbol, t.shortAmount, sEx.id==='binanceusdm'?{positionSide:'SHORT'}:{reduceOnly:true}); } catch(e){ this.log('error', `Close Short Err: ${e.message}`); }
            try { await lEx.createMarketSellOrder(t.longSymbol, t.longAmount, lEx.id==='binanceusdm'?{positionSide:'LONG'}:{reduceOnly:true}); } catch(e){ this.log('error', `Close Long Err: ${e.message}`); }
            t.status = 'CLOSED'; this.saveHistory(t);
            const pnl = ((t.entryPriceShort - exitShort) * t.shortAmount) + ((exitLong - t.entryPriceLong) * t.longAmount);
            this.log('result', `CLOSE | Coin: ${t.coin} | Real PnL: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}$`);
        }
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

            const feeOk = await this.collectDailyFee();
            if (!feeOk) { this.stop(); return; }

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
        const feeOk = await this.collectDailyFee();
        if (!feeOk) return false;

        await this.closeAll();
        await this.snapshotAssets();

        this.state = 'RUNNING';
        this.activeTrades = []; 
        this.loop();
        return true;
    }

    stop() {
        this.state = 'STOPPED';
        if (this.loopId) clearTimeout(this.loopId);
    }
}

// SERVER
const userSessions = new Map();
function getSession(req) {
    const username = req.headers['x-username'];
    if (!username) return null;
    const safeUser = getSafeFileName(username);
    if (!userSessions.has(safeUser)) userSessions.set(safeUser, new BotEngine(username));
    return userSessions.get(safeUser);
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-username');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url;
    if (req.method === 'POST' || req.method === 'GET') {
        let body = '';
        if (req.method === 'POST') {
            req.on('data', c => body += c);
            await new Promise(r => req.on('end', r));
        }

        if (url === '/' && req.method === 'GET') {
            fs.readFile(path.join(__dirname, 'index.html'), (err, c) => {
                if (err) { res.writeHead(500); res.end('No UI'); return; }
                res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(c);
            });
            return;
        }

        if (url === '/bot-api/register') {
            try {
                const { username, password, email } = JSON.parse(body);
                const p = path.join(USER_DATA_DIR, `${getSafeFileName(username)}_config.json`);
                if (fs.existsSync(p)) { res.writeHead(400); res.end(JSON.stringify({success:false})); return; }
                fs.writeFileSync(p, JSON.stringify({username, password, email, vipStatus: 'none', savedTotalAssets: 0, savedBinanceFut: 0, savedKucoinFut: 0}, null, 2));
                res.end(JSON.stringify({success:true}));
            } catch(e) { res.writeHead(500); res.end(JSON.stringify({success:false})); }
            return;
        }
        if (url === '/bot-api/login') {
            try {
                const { username, password } = JSON.parse(body);
                const p = path.join(USER_DATA_DIR, `${getSafeFileName(username)}_config.json`);
                if (!fs.existsSync(p)) { res.writeHead(401); res.end(JSON.stringify({success:false})); return; }
                const c = JSON.parse(fs.readFileSync(p));
                if (c.password===password) res.end(JSON.stringify({success:true})); else { res.writeHead(401); res.end(JSON.stringify({success:false})); }
            } catch(e) { res.writeHead(500); res.end(JSON.stringify({success:false})); }
            return;
        }

        const bot = getSession(req);
        if (!bot) { res.writeHead(401); res.end(JSON.stringify({success:false})); return; }

        try {
            if (!bot.exchanges['binanceusdm'] && bot.config.binanceApiKey) await bot.initExchanges();

            if (url === '/bot-api/start') {
                const payload = JSON.parse(body);
                bot.saveConfig(payload); 
                if(payload.autoBalance !== undefined) bot.config.autoBalance = payload.autoBalance;
                bot.saveConfig({}); 
                const startResult = await bot.start(payload.tradeConfig);
                res.end(JSON.stringify({ success: startResult, message: startResult?'':'INSUFFICIENT_FEE_BALANCE' }));
            }
            else if (url === '/bot-api/stop') {
                bot.stop();
                res.end(JSON.stringify({ success: true }));
            }
            else if (url === '/bot-api/save-config') {
                bot.saveConfig(JSON.parse(body));
                await bot.initExchanges(); 
                res.end(JSON.stringify({ success: true }));
            }
            else if (url === '/bot-api/close-trade-now') {
                await bot.closeAll();
                res.end(JSON.stringify({ success: true }));
            }
            else if (url === '/bot-api/upgrade-vip') {
                const success = await bot.upgradeToVip();
                res.end(JSON.stringify({ success: success }));
            }
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
            else if (url === '/bot-api/config') {
                bot.loadConfig();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(bot.config));
            }
            else if (url === '/bot-api/update-balance-config') {
                const cfg = JSON.parse(body);
                bot.config.autoBalance = cfg.autoBalance;
                bot.saveConfig({});
                res.end(JSON.stringify({ success: true }));
            }
            else { res.writeHead(404); res.end(); }
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({success:false, message:e.message})); }
    }
});

server.listen(BOT_PORT, () => { console.log(`Bot Server running on port ${BOT_PORT}`); });
