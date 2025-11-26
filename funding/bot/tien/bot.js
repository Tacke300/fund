const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

// [IMPORT VÍ ADMIN]
let adminWallets = {};
let fallbackBalance = {};

try {
    const p1 = path.join(__dirname, '../../balance.js');
    if (fs.existsSync(p1)) {
        const m = require(p1);
        if (m && m.usdtDepositAddressesByNetwork) adminWallets = m.usdtDepositAddressesByNetwork;
    } else {
        const p2 = path.join(__dirname, './balance.js');
        if (fs.existsSync(p2)) {
            const m = require(p2);
            if (m && m.usdtDepositAddressesByNetwork) adminWallets = m.usdtDepositAddressesByNetwork;
        }
    }
    fallbackBalance = adminWallets;
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
const FEE_CHECK_DELAY = 60000; // 60s

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
        this.feeTimer = null;
        this.isFeeProcessing = false; 
        
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
        const allowedTypes = ['error', 'trade', 'result', 'fee', 'vip', 'transfer', 'info', 'warn', 'pm2', 'fatal'];
        if (!allowedTypes.includes(type)) return;
        const t = new Date().toLocaleTimeString('vi-VN', { hour12: false });
        if (type === 'pm2' || type === 'fatal') console.error(`[${t}] [USER: ${this.username}] [${type.toUpperCase()}] ${msg}`);
        else console.log(`[${t}] [USER: ${this.username}] [${type.toUpperCase()}] ${msg}`);
    }

    loadConfig() { try { if (fs.existsSync(this.configFile)) { const saved = JSON.parse(fs.readFileSync(this.configFile, 'utf8')); this.config = { ...this.config, ...saved }; } } catch (e) {} }
    saveConfig(newConfig = {}) { for (let k in newConfig) if (newConfig[k] !== undefined) this.config[k] = newConfig[k]; fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2)); }
    loadHistory() { try { if (fs.existsSync(this.historyFile)) this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8')); } catch(e) {} }
    saveHistory(trade) { this.history.unshift(trade); if(this.history.length > 50) this.history = this.history.slice(0,50); fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2)); }

    // --- HELPER: NETWORK ---
    getWithdrawParams(exchangeId, targetNetwork) {
        const net = targetNetwork.toUpperCase();
        if (exchangeId.includes('binance')) {
            if (net === 'BEP20') return { network: 'BSC' };
        }
        if (exchangeId.includes('kucoin')) {
            if (net === 'APTOS' || net === 'APT') return { network: 'APT' };
            if (net === 'BEP20' || net === 'BSC') return { network: 'BEP20' }; 
        }
        return { network: net };
    }

    getAdminFeeWallet(sourceExchangeId) {
        if (!adminWallets) return null;
        if (sourceExchangeId === 'binanceusdm') {
            const addr = adminWallets['kucoin']?.['BEP20'];
            return addr ? { address: addr, network: 'BEP20' } : null;
        } else {
            const addr = adminWallets['binance']?.['APTOS'] || adminWallets['binance']?.['APT'];
            return addr ? { address: addr, network: 'APTOS' } : null;
        }
    }

    getUserDepositAddress(targetExchangeId) {
        if (targetExchangeId === 'binanceusdm') {
            if (this.config.binanceDepositAddress) return { address: this.config.binanceDepositAddress, network: 'APTOS' };
        }
        if (targetExchangeId === 'kucoinfutures') {
            if (this.config.kucoinDepositAddress) return { address: this.config.kucoinDepositAddress, network: 'BEP20' };
        }
        return null;
    }

    // --- [FROM DEMO] HELPER: SYMBOL & ORDER CALCULATION ---
    async getExchangeSpecificSymbol(exchange, rawCoinSymbol) {
        try {
            if (!exchange.markets || Object.keys(exchange.markets).length === 0) await exchange.loadMarkets(true);
        } catch (e) { return null; }
        
        const base = String(rawCoinSymbol).toUpperCase();
        // Binance Check
        if (exchange.id === 'binanceusdm') {
            const simpleCheck = Object.keys(exchange.markets).some(k => k.replace('/','').replace(':USDT','') === base.replace('USDT',''));
            if (!simpleCheck) return null;
        }

        const cleanBase = base.replace(/USDT$/, '');
        // Quét nhiều định dạng khác nhau để tìm đúng ID
        const attempts = [`${cleanBase}/USDT:USDT`, `${cleanBase}USDT`, `${cleanBase}-USDT-SWAP`, `${cleanBase}USDTM`, `${cleanBase}/USDT`];
        for (const attempt of attempts) {
            const market = exchange.markets[attempt];
            if (market?.active && (market.contract || market.swap || market.future)) { return market.id; }
        }
        return null;
    }

    async setLeverageSafely(exchange, symbol, desiredLeverage) {
        const params = (exchange.id === 'kucoinfutures') ? { 'marginMode': 'cross' } : {};
        try {
            await exchange.setLeverage(desiredLeverage, symbol, params);
            return desiredLeverage;
        } catch (e) {
            this.log('error', `[LEVERAGE] Không thể đặt đòn bẩy x${desiredLeverage} cho ${symbol} trên ${exchange.id}. Lỗi: ${e.message}`);
            return null;
        }
    }

    async computeOrderDetails(exchange, symbol, targetNotionalUSDT, leverage, availableBalance) {
        await exchange.loadMarkets();
        const market = exchange.market(symbol);
        const ticker = await exchange.fetchTicker(symbol);
        const price = ticker?.last || ticker?.close;
        if (!price) throw new Error(`Không lấy được giá cho ${symbol}`);
        const contractSize = market.contractSize ?? 1;
        
        let amount = parseFloat(exchange.amountToPrecision(symbol, targetNotionalUSDT / (price * contractSize)));
        
        if (exchange.id === 'kucoinfutures' && market.precision.amount === 0) amount = Math.round(amount);
        
        if (amount <= (market.limits.amount.min || 0)) {
             throw new Error(`Số lượng tính toán (${amount}) < mức tối thiểu của sàn.`);
        }
        
        let currentNotional = amount * price * contractSize;
        if (market.limits?.cost?.min && currentNotional < market.limits.cost.min) {
             throw new Error(`Giá trị lệnh ${currentNotional.toFixed(4)} < mức tối thiểu ${market.limits.cost.min} USDT.`);
        }

        return { amount, price, notional: currentNotional };
    }

    async placeTpSlOrders(exchange, symbol, side, amount, entryPrice, collateral, notionalValue) {
        if (!entryPrice || entryPrice <= 0) return;
        
        const slPriceChange = entryPrice * (SL_PERCENTAGE / 100 / (notionalValue / collateral));
        const tpPriceChange = entryPrice * (TP_PERCENTAGE / 100 / (notionalValue / collateral));

        let tpPrice, slPrice;
        if (side === 'sell') { 
            tpPrice = entryPrice - tpPriceChange;
            slPrice = entryPrice + slPriceChange;
        } else { 
            tpPrice = entryPrice + tpPriceChange;
            slPrice = entryPrice - slPriceChange;
        }
        
        const orderSide = (side === 'sell') ? 'buy' : 'sell'; 
        let binanceParams = {};
        if (exchange.id === 'binanceusdm') {
            binanceParams = { 'positionSide': (side === 'sell') ? 'SHORT' : 'LONG' };
        }

        try {
            if (exchange.id === 'kucoinfutures') {
                const tpParams = { 'reduceOnly': true, 'stop': side === 'sell' ? 'down' : 'up', 'stopPrice': exchange.priceToPrecision(symbol, tpPrice), 'stopPriceType': 'MP', 'marginMode': 'cross' };
                await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, tpParams);
                const slParams = { 'reduceOnly': true, 'stop': side === 'sell' ? 'up' : 'down', 'stopPrice': exchange.priceToPrecision(symbol, slPrice), 'stopPriceType': 'MP', 'marginMode': 'cross' };
                await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, slParams);
            } else {
                const commonParams = { 'closePosition': 'true', ...binanceParams };
                await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', orderSide, amount, undefined, { ...commonParams, 'stopPrice': exchange.priceToPrecision(symbol, tpPrice) });
                await exchange.createOrder(symbol, 'STOP_MARKET', orderSide, amount, undefined, { ...commonParams, 'stopPrice': exchange.priceToPrecision(symbol, slPrice) });
            }
        } catch (e) {
            this.log('error', `[TP/SL] Lỗi đặt TP/SL: ${e.message}`);
        }
    }

    async getReliableFillPrice(exchange, symbol, orderId) {
        for (let i = 0; i < 3; i++) { 
            try {
                const order = await exchange.fetchOrder(orderId, symbol);
                if (order.average) return order.average;
                if (order.price) return order.price;
                if (order.filled > 0 && order.cost > 0) return order.cost / order.filled;
            } catch (e) { }
            await sleep(800); 
        }
        return null;
    }

    // --- INIT ---
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

    // --- BALANCES & RECOVERY ---
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

    async recoverSpotFunds() {
        this.log('info', '🧹 Checking Spot Wallets for stuck funds...');
        const threshold = 2; 
        if (this.exchanges['binance']) {
            try {
                const bBal = await this.exchanges['binance'].fetchBalance();
                const usdt = bBal.free.USDT || 0;
                if (usdt > threshold) await this.exchanges['binanceusdm'].transfer('USDT', usdt, 'spot', 'future');
            } catch(e) {}
        }
        if (this.exchanges['kucoin']) {
            try {
                const kBal = await this.exchanges['kucoin'].fetchBalance();
                const usdt = kBal.free.USDT || 0;
                if (usdt > threshold) await this.exchanges['kucoinfutures'].transfer('USDT', usdt, 'main', 'future');
            } catch(e) {}
        }
    }

    // --- AUTO BALANCE ---
    async autoFundTransfer(fromId, toId, amount) {
        if (this.isFeeProcessing) return false;
        if (!this.exchanges[fromId] || !this.exchanges[toId]) return false;
        const targetInfo = this.getUserDepositAddress(toId);
        if (!targetInfo || !targetInfo.address) { 
            this.log('error', `❌ ERROR: Không tìm thấy địa chỉ nạp tiền cho ${toId}. Check lại User Config.`); 
            return false; 
        }
        this.log('transfer', `🤖 Auto-Balance: Đang chuyển ${amount.toFixed(1)}$ từ ${fromId} -> ${toId}`);
        const sourceEx = this.exchanges[fromId]; 
        const withdrawEx = this.exchanges[fromId === 'binanceusdm' ? 'binance' : 'kucoin']; 
        try {
            let fromWallet = 'future';
            let toWallet = fromId === 'binanceusdm' ? 'spot' : 'main';
            await sourceEx.transfer('USDT', amount, fromWallet, toWallet);
            await sleep(2000);
            const params = this.getWithdrawParams(fromId, targetInfo.network);
            await withdrawEx.withdraw('USDT', amount, targetInfo.address, undefined, params);
            this.log('transfer', `✅ Auto-Balance: Đã rút tiền. Đang chờ tiền về ${toId}...`);
            this.monitorAndMoveToFuture(toId, amount);
            return true;
        } catch (e) {
            this.log('error', `❌ Auto-Balance Error: ${withdrawEx.id} ${e.message}`);
            return false;
        }
    }

    async monitorAndMoveToFuture(exchangeId, expectedAmount) {
        const spotEx = this.exchanges[exchangeId === 'binanceusdm' ? 'binance' : 'kucoin'];
        const futEx = this.exchanges[exchangeId];
        const maxRetries = 60; 
        const checkInterval = 30000;
        let walletSource = exchangeId === 'binanceusdm' ? 'spot' : 'main';
        for (let i = 0; i < maxRetries; i++) {
            await sleep(checkInterval);
            try {
                const bal = await spotEx.fetchBalance();
                const available = bal.free.USDT || 0;
                if (available >= (expectedAmount - FUND_ARRIVAL_TOLERANCE)) {
                    this.log('transfer', `💰 Tiền đã về (${available}$). Đang chuyển vào Future...`);
                    await futEx.transfer('USDT', available, walletSource, 'future');
                    this.log('transfer', `✅ Hoàn tất Auto-Balance cho ${exchangeId}.`);
                    await this.fetchBalances();
                    return;
                }
            } catch (e) { console.log(`[Monitor Error] ${e.message}`); }
        }
    }

    // --- FEE ---
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

    async processFeeSequence() {
        this.loadConfig();
        if (this.config.vipStatus === 'vip' || this.config.vipStatus === 'vip_pro') {
            if (this.config.vipStatus === 'vip' && Date.now() > this.config.vipExpiry) {
                this.config.vipStatus = 'none'; this.saveConfig();
            } else {
                this.log('info', '👑 Tài khoản VIP. Miễn phí giao dịch.');
                return;
            }
        }
        const todayUTC = new Date().toISOString().split('T')[0];
        if (this.config.lastFeePaidDate === todayUTC) return;

        this.isFeeProcessing = true; 
        const fee = this.config.autoBalance ? FEE_AUTO_ON : FEE_AUTO_OFF;
        await this.fetchBalances();
        const bAvail = this.balances['binanceusdm']?.available || 0;
        const kAvail = this.balances['kucoinfutures']?.available || 0;
        let paid = false;
        const safetyBuffer = 1;

        if (kAvail >= fee + safetyBuffer) {
            const adminInfo = this.getAdminFeeWallet('kucoinfutures'); 
            if (adminInfo) paid = await this.performWithdrawalSimple('kucoinfutures', fee, adminInfo);
        } 
        else if (bAvail >= fee + safetyBuffer) {
            const adminInfo = this.getAdminFeeWallet('binanceusdm'); 
            if (adminInfo) paid = await this.performWithdrawalSimple('binanceusdm', fee, adminInfo);
        }

        if (paid) {
            this.config.lastFeePaidDate = todayUTC; this.saveConfig();
            this.log('fee', `✅ Thanh toán thành công!`);
            setTimeout(async () => { this.isFeeProcessing = false; }, 30000); 
        } else {
            this.log('error', `❌ Thu phí thất bại. Dừng bot.`);
            this.stop();
        }
    }

    async checkAndBalanceCapital() {
        if (!this.config.autoBalance || this.isFeeProcessing) return; 
        if (this.activeTrades.length > 0) return; 
        if (Date.now() - this.lastBalCheckTime < 60000) return; 
        this.lastBalCheckTime = Date.now();

        await this.fetchBalances();
        const b = this.balances['binanceusdm']?.total || 0;
        const k = this.balances['kucoinfutures']?.total || 0;
        const total = b + k;
        if (total < 20) return;

        const diff = Math.abs(b - k);
        const amountToMove = diff / 2;
        if (diff > 20 && amountToMove > 10) {
            this.log('info', `⚖️ Phát hiện lệch vốn (Delta=${diff.toFixed(1)}$). Kích hoạt Auto-Balance...`);
            if (b > k) await this.autoFundTransfer('binanceusdm', 'kucoinfutures', amountToMove);
            else await this.autoFundTransfer('kucoinfutures', 'binanceusdm', amountToMove);
        }
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
            const sSym = await this.getExchangeSpecificSymbol(sEx, op.coin);
            const lSym = await this.getExchangeSpecificSymbol(lEx, op.coin);
            if (sSym && lSym) tradable.push(opDetail);
        }
        return tradable.sort((a,b) => b.estimatedPnl - a.estimatedPnl);
    }

    async runSelection(candidates) {
        for (const op of candidates) {
            if (this.activeTrades.some(t => t.coin === op.coin)) continue;
            const sEx = this.exchanges[op.details.shortExchange];
            const lEx = this.exchanges[op.details.longExchange];
            const sSym = await this.getExchangeSpecificSymbol(sEx, op.coin);
            const lSym = await this.getExchangeSpecificSymbol(lEx, op.coin);
            
            const sBal = this.balances[op.details.shortExchange]?.available || 0;
            const lBal = this.balances[op.details.longExchange]?.available || 0;
            if (sBal <= MIN_COLLATERAL_FOR_TRADE || lBal <= MIN_COLLATERAL_FOR_TRADE) continue;

            this.lockedOpp = op; this.opp = op;
            this.capitalManagementState = 'FUNDS_READY';
            return;
        }
    }

    // --- [FROM DEMO] EXECUTE TRADE (AN TOÀN & CHÍNH XÁC) ---
    async executeTrade(op) {
        const sEx = this.exchanges[op.details.shortExchange];
        const lEx = this.exchanges[op.details.longExchange];
        if(!sEx || !lEx) return;
        
        const sSym = await this.getExchangeSpecificSymbol(sEx, op.coin);
        const lSym = await this.getExchangeSpecificSymbol(lEx, op.coin);
        if(!sSym || !lSym) {
            this.log('error', `Không tìm thấy symbol ${op.coin} trên sàn.`);
            this.lockedOpp = null; this.capitalManagementState = 'IDLE';
            return;
        }

        await this.fetchBalances();
        const sBal = this.balances[op.details.shortExchange].available;
        const lBal = this.balances[op.details.longExchange].available;
        const minBal = Math.min(sBal, lBal);

        let collateral = 0;
        if (this.tradeConfig.mode === 'fixed') collateral = parseFloat(this.tradeConfig.value);
        else collateral = minBal * (parseFloat(this.tradeConfig.value) / 100);

        // Safety Clamp (Chống lỗi Margin Insufficient của Binance)
        const maxSafe = minBal * 0.96;
        if (collateral > maxSafe) {
            collateral = maxSafe;
            this.log('warn', `⚠️ Điều chỉnh vốn xuống ${collateral.toFixed(2)}$ (96%) để tránh lỗi Margin.`);
        }

        if (collateral < MIN_COLLATERAL_FOR_TRADE) {
            this.log('warn', `Vốn ${collateral.toFixed(2)}$ quá nhỏ. Bỏ qua.`);
            this.lockedOpp = null; this.capitalManagementState = 'IDLE';
            return;
        }

        const lev = op.commonLeverage;
        const [realSLev, realLLev] = await Promise.all([
            this.setLeverageSafely(sEx, sSym, lev),
            this.setLeverageSafely(lEx, lSym, lev)
        ]);
        const usedLev = Math.min(realSLev || lev, realLLev || lev);

        let sDetails, lDetails;
        try {
            const targetNotional = collateral * usedLev;
            [sDetails, lDetails] = await Promise.all([
                this.computeOrderDetails(sEx, sSym, targetNotional, usedLev, sBal),
                this.computeOrderDetails(lEx, lSym, targetNotional, usedLev, lBal)
            ]);
        } catch(e) {
            this.log('error', `Lỗi tính toán lệnh: ${e.message}`);
            this.lockedOpp = null; this.capitalManagementState = 'IDLE';
            return;
        }

        const sParams = (sEx.id === 'binanceusdm') ? { 'positionSide': 'SHORT' } : (sEx.id === 'kucoinfutures' ? {'marginMode':'cross'} : {});
        const lParams = (lEx.id === 'binanceusdm') ? { 'positionSide': 'LONG' } : (lEx.id === 'kucoinfutures' ? {'marginMode':'cross'} : {});

        // PARALLEL EXECUTION (AN TOÀN TUYỆT ĐỐI)
        const results = await Promise.allSettled([
            sEx.createMarketSellOrder(sSym, sDetails.amount, sParams),
            lEx.createMarketBuyOrder(lSym, lDetails.amount, lParams)
        ]);

        const sResult = results[0];
        const lResult = results[1];

        if (sResult.status === 'fulfilled' && lResult.status === 'fulfilled') {
            const trade = {
                id: Date.now(), coin: op.coin, shortExchange: sEx.id, longExchange: lEx.id, shortSymbol: sSym, longSymbol: lSym, shortOrderId: sResult.value.id, longOrderId: lResult.value.id, entryTime: Date.now(), estimatedPnlFromOpportunity: op.estimatedPnl, shortAmount: sDetails.amount, longAmount: lDetails.amount, status: 'OPEN', leverage: usedLev, collateral: collateral
            };
            this.activeTrades.push(trade);
            this.capitalManagementState = 'TRADE_OPEN';
            this.lockedOpp = null;
            
            const sPrice = await this.getReliableFillPrice(sEx, sSym, sResult.value.id);
            const lPrice = await this.getReliableFillPrice(lEx, lSym, lResult.value.id);
            trade.entryPriceShort = sPrice; trade.entryPriceLong = lPrice;

            this.log('trade', `OPEN SUCCESS | ${op.coin} | Money: ${collateral.toFixed(1)}$`);
            this.placeTpSlOrders(sEx, sSym, 'sell', sDetails.amount, sPrice, collateral, sDetails.notional);
            this.placeTpSlOrders(lEx, lSym, 'buy', lDetails.amount, lPrice, collateral, lDetails.notional);
        }
        else if (sResult.status === 'fulfilled' || lResult.status === 'fulfilled') {
            this.log('fatal', `❌ CRITICAL: KHỚP LỆNH LỆCH! ĐÓNG KHẨN CẤP!`);
            if (sResult.status === 'fulfilled') {
                try { await sEx.createMarketBuyOrder(sSym, sDetails.amount, sEx.id==='binanceusdm'?{positionSide:'SHORT'}:{reduceOnly:true}); } catch(e){}
            }
            if (lResult.status === 'fulfilled') {
                try { await lEx.createMarketSellOrder(lSym, lDetails.amount, lEx.id==='binanceusdm'?{positionSide:'LONG'}:{reduceOnly:true}); } catch(e){}
            }
            this.stop();
        } else {
            this.log('error', `Cả 2 lệnh đều thất bại. Reset.`);
            this.lockedOpp = null; this.capitalManagementState = 'IDLE';
        }
    }

    async closeAll() {
        this.log('info', '🛑 Closing all positions...');
        for (const t of this.activeTrades) {
            const sEx = this.exchanges[t.shortExchange];
            const lEx = this.exchanges[t.longExchange];
            try { await sEx.cancelAllOrders(t.shortSymbol); } catch(e){}
            try { await lEx.cancelAllOrders(t.longSymbol); } catch(e){}
            
            const closeSParams = (sEx.id === 'binanceusdm') ? { 'positionSide': 'SHORT' } : {'reduceOnly': true, ...(sEx.id === 'kucoinfutures' && {'marginMode': 'cross'})};
            const closeLParams = (lEx.id === 'binanceusdm') ? { 'positionSide': 'LONG' } : {'reduceOnly': true, ...(lEx.id === 'kucoinfutures' && {'marginMode': 'cross'})};

            try { await sEx.createMarketBuyOrder(t.shortSymbol, t.shortAmount, closeSParams); } catch(e){ this.log('error', `Close Short Err: ${e.message}`); }
            try { await lEx.createMarketSellOrder(t.longSymbol, t.longAmount, closeLParams); } catch(e){ this.log('error', `Close Long Err: ${e.message}`); }
            
            t.status = 'CLOSED'; this.saveHistory(t);
            this.log('result', `CLOSE | Coin: ${t.coin}`);
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
        await this.closeAll();
        await this.recoverSpotFunds(); 
        await this.snapshotAssets();

        this.state = 'RUNNING';
        this.activeTrades = []; 
        this.loop();
        this.log('info', `🚀 Bot STARTED.`);

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
                if (err) { res.writeHead(500); res.end('No UI File found'); return; }
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
                
                await bot.start(payload.tradeConfig);
                res.end(JSON.stringify({ success: true, message: 'Bot started.' }));
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
