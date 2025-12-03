const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const https = require('https');

// TỐI ƯU KẾT NỐI
const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 60000, maxSockets: 100 });
const CCXT_OPTIONS = {
    enableRateLimit: false, 
    httpsAgent: agent,
    timeout: 10000 
};

let adminWallets = {};
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
} catch (e) { }

const SERVER_DATA_URL = 'http://localhost:5005/api/data';
const USER_DATA_DIR = path.join(__dirname, 'user_data');
if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR);

const MIN_PNL_PERCENTAGE = 1;
const BLACKLISTED_COINS = ['GAIBUSDT', 'AIAUSDT', '42USDT', 'WAVESUSDT'];

const FEE_AUTO_ON = 10;
const FEE_AUTO_OFF = 5;
const FEE_CHECK_DELAY = 60000;

const SL_PERCENTAGE = 65;
const TP_PERCENTAGE = 115; 

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
        this.activeTradesFile = path.join(USER_DATA_DIR, `${safeName}_active_trades.json`);
        this.statusFile = path.join(USER_DATA_DIR, `${safeName}_status.json`);
        this.balanceHistoryFile = path.join(USER_DATA_DIR, `${safeName}_balance_history.json`);

        this.state = 'STOPPED';
        this.capitalManagementState = 'IDLE';
        this.loopId = null;
        this.feeTimer = null;
        this.isFeeProcessing = false;
        this.isBalancing = false;
        this.isTestExecution = false;
        this.isReady = false;

        this.lastScanTime = 0;
        this.lastBalCheckTime = 0;
        this.lastBalRecordTime = 0;

        this.balances = {};
        this.history = [];
        this.activeTrades = [];
        this.candidates = [];
        this.opps = [];
        this.lockedOpps = [];
        this.lastKnownOpps = [];

        this.sessionBlacklist = new Set();
        this.processedTestCoins = new Map();
        
        this.tradeConfig = { mode: 'percent', value: 50 };

        this.config = {
            username: username,
            password: '',
            binanceApiKey: '', binanceApiSecret: '', binanceDepositAddress: '',
            kucoinApiKey: '', kucoinApiSecret: '', kucoinPassword: '', kucoinDepositAddress: '',
            autoBalance: false,
            maxOpps: 3, 
            vipStatus: 'none',
            vipExpiry: 0,
            lastFeePaidDate: '',
            savedBinanceFut: 0,
            savedKucoinFut: 0,
            savedTotalAssets: 0,
            forceStart: false
        };

        this.exchanges = {};
        this.loadConfig();
        this.loadHistory();
        this.loadActiveTrades();

        if (this.config.tradeConfig) this.tradeConfig = this.config.tradeConfig;
    }

    exportStatus() {
        try {
            let displayOpp = (this.capitalManagementState === 'FUNDS_READY' && this.lockedOpps.length > 0) ? this.lockedOpps : this.opps;
            if (!displayOpp || displayOpp.length === 0) displayOpp = this.lastKnownOpps;
            else this.lastKnownOpps = displayOpp;

            let balHist = [];
            // Đọc file history để gửi ra UI vẽ biểu đồ
            if(fs.existsSync(this.balanceHistoryFile)) {
                try { balHist = JSON.parse(fs.readFileSync(this.balanceHistoryFile, 'utf8')); } catch(e){}
            }

            const s = {
                username: this.username,
                botState: this.state,
                isReady: this.isReady,
                capitalManagementState: this.capitalManagementState,
                balances: this.balances,
                tradeHistory: this.history,
                bestPotentialOpportunityForDisplay: displayOpp,
                activeTrades: this.activeTrades,
                vipStatus: this.config.vipStatus,
                vipExpiry: this.config.vipExpiry,
                balanceHistory: balHist, // Data cho biểu đồ
                config: { maxOpps: this.config.maxOpps || 3 }
            };
            fs.writeFileSync(this.statusFile, JSON.stringify(s, null, 2));
        } catch (e) { }
    }

    log(type, msg) {
        if (['Scanning', 'Wait', 'Searching', 'Stability'].some(k => msg.includes(k))) return;
        const t = new Date().toLocaleTimeString('vi-VN', { hour12: false });
        let prefix = type.toUpperCase();
        if(type === 'trade') prefix = '💰 TRADE';
        if(type === 'error') prefix = '❌ ERROR';
        console.log(`[${t}] [${this.username}] [${prefix}] ${msg}`);
        this.exportStatus();
    }

    loadConfig() { try { if (fs.existsSync(this.configFile)) { const saved = JSON.parse(fs.readFileSync(this.configFile, 'utf8')); this.config = { ...this.config, ...saved }; } } catch (e) { } }
    saveConfig(newConfig = {}) { for (let k in newConfig) if (newConfig[k] !== undefined) this.config[k] = newConfig[k]; fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2)); }
    loadHistory() { try { if (fs.existsSync(this.historyFile)) this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8')); } catch (e) { } }
    saveHistory(trade) { this.history.unshift(trade); if (this.history.length > 50) this.history = this.history.slice(0, 50); fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2)); }
    loadActiveTrades() { try { if (fs.existsSync(this.activeTradesFile)) this.activeTrades = JSON.parse(fs.readFileSync(this.activeTradesFile, 'utf8')); } catch (e) { this.activeTrades = []; } }
    saveActiveTrades() { fs.writeFileSync(this.activeTradesFile, JSON.stringify(this.activeTrades, null, 2)); }

    // [QUAN TRỌNG] Hàm lưu lịch sử số dư cho biểu đồ
    saveBalanceHistory(bFut, kFut) {
        try {
            const record = { time: Date.now(), binance: bFut, kucoin: kFut, total: bFut + kFut };
            let history = [];
            if (fs.existsSync(this.balanceHistoryFile)) history = JSON.parse(fs.readFileSync(this.balanceHistoryFile, 'utf8'));
            history.push(record);
            // Giữ lại 45000 điểm dữ liệu
            if (history.length > 45000) history = history.slice(history.length - 45000);
            fs.writeFileSync(this.balanceHistoryFile, JSON.stringify(history));
        } catch (e) { }
    }

    getWithdrawParams(exchangeId, targetNetwork) {
        if (exchangeId.includes('binance')) return targetNetwork === 'BEP20' ? { network: 'BSC' } : { network: targetNetwork };
        if (exchangeId.includes('kucoin')) {
            if (targetNetwork === 'APTOS' || targetNetwork === 'APT') return { network: 'APT' };
            if (targetNetwork === 'BEP20' || targetNetwork === 'BSC') return { network: 'BEP20' };
        }
        return { network: targetNetwork };
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
        if (targetExchangeId === 'binanceusdm') return this.config.binanceDepositAddress ? { address: this.config.binanceDepositAddress, network: 'APTOS' } : null;
        if (targetExchangeId === 'kucoinfutures') return this.config.kucoinDepositAddress ? { address: this.config.kucoinDepositAddress, network: 'BEP20' } : null;
        return null;
    }

    getExchangeSpecificSymbol(exchange, rawCoinSymbol) {
        if (!exchange.markets) return null;
        const base = String(rawCoinSymbol).toUpperCase();
        if (exchange.id === 'binanceusdm') {
            const k = Object.keys(exchange.markets).find(k => k.replace('/', '').replace(':USDT', '') === base.replace('USDT', ''));
            if (k) return exchange.markets[k].id;
        }
        const cleanBase = base.replace(/USDT$/, '');
        const attempts = [`${cleanBase}/USDT:USDT`, `${cleanBase}USDT`, `${cleanBase}-USDT-SWAP`, `${cleanBase}USDTM`, `${cleanBase}/USDT`];
        for (const attempt of attempts) {
            if (exchange.markets[attempt]) return exchange.markets[attempt].id;
        }
        return null;
    }

    async setLeverageSafely(exchange, symbol, desiredLeverage) {
        try {
            const market = exchange.market(symbol);
            let actualLeverage = desiredLeverage;
            if (market && market.limits && market.limits.leverage && market.limits.leverage.max) {
                if (actualLeverage > market.limits.leverage.max) actualLeverage = market.limits.leverage.max;
            }
            try { await exchange.setMarginMode('cross', symbol); } catch (e) { }
            let params = exchange.id === 'kucoinfutures' ? { 'marginMode': 'cross' } : {};
            await exchange.setLeverage(actualLeverage, symbol, params);
            if (exchange.id === 'kucoinfutures') await sleep(200);
            return actualLeverage;
        } catch (e) {
            this.log('error', `Lev Fail (${exchange.id}): ${e.message}`);
            return null;
        }
    }

    async computeOrderDetails(exchange, symbol, targetNotionalUSDT, leverage) {
        const market = exchange.market(symbol);
        const ticker = await exchange.fetchTicker(symbol);
        const price = ticker?.last || ticker?.close;
        if (!price) throw new Error(`Price not found for ${symbol}`);
        const contractSize = market.contractSize ?? 1;
        let amount = parseFloat(exchange.amountToPrecision(symbol, targetNotionalUSDT / (price * contractSize)));
        if (exchange.id === 'kucoinfutures' && market.precision.amount === 0) amount = Math.round(amount);
        if (amount <= (market.limits.amount.min || 0)) amount = market.limits.amount.min;
        return { amount, price, notional: amount * price * contractSize };
    }

    async placeTpSlOrders(exchange, symbol, side, amount, entryPrice, collateral, notionalValue) {
        if (!entryPrice || entryPrice <= 0) return;
        const slPriceChange = entryPrice * (SL_PERCENTAGE / 100 / (notionalValue / collateral));
        const tpPriceChange = entryPrice * (TP_PERCENTAGE / 100 / (notionalValue / collateral));
        let tpPrice = side === 'sell' ? entryPrice - tpPriceChange : entryPrice + tpPriceChange;
        let slPrice = side === 'sell' ? entryPrice + slPriceChange : entryPrice - slPriceChange;
        let binanceParams = exchange.id === 'binanceusdm' ? { 'positionSide': (side === 'sell') ? 'SHORT' : 'LONG' } : {};

        const orderSide = (side === 'sell') ? 'buy' : 'sell';
        const maxRetries = 2;
        for (let i = 0; i < maxRetries; i++) {
            try {
                if (exchange.id === 'kucoinfutures') {
                    const tpParams = { 'reduceOnly': true, 'stop': side === 'sell' ? 'down' : 'up', 'stopPrice': exchange.priceToPrecision(symbol, tpPrice), 'stopPriceType': 'MP', 'marginMode': 'cross' };
                    await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, tpParams);
                    const slParams = { 'reduceOnly': true, 'stop': side === 'sell' ? 'up' : 'down', 'stopPrice': exchange.priceToPrecision(symbol, slPrice), 'stopPriceType': 'MP', 'marginMode': 'cross' };
                    await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, slParams);
                } else {
                    const commonParams = { ...binanceParams };
                    await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', orderSide, amount, undefined, { ...commonParams, 'stopPrice': exchange.priceToPrecision(symbol, tpPrice) });
                    await exchange.createOrder(symbol, 'STOP_MARKET', orderSide, amount, undefined, { ...commonParams, 'stopPrice': exchange.priceToPrecision(symbol, slPrice) });
                }
                this.log('trade', `✅ TP/SL Set: ${symbol}`);
                break; 
            } catch (e) { await sleep(500); }
        }
    }

    async getReliableFillPrice(exchange, symbol, orderId) {
        for (let i = 0; i < 3; i++) {
            try {
                const order = await exchange.fetchOrder(orderId, symbol);
                if (order.average) return order.average;
                if (order.price) return order.price;
                if (order.filled > 0 && order.cost > 0) return order.cost / order.filled;
                const trades = await exchange.fetchMyTrades(symbol, undefined, 1, { 'orderId': orderId });
                if (trades.length > 0) return trades[0].price;
            } catch (e) { }
            await sleep(300);
        }
        return null;
    }

    async executeTrade(op) {
        try {
            if (this.activeTrades.some(t => t.coin === op.coin)) return;

            const sEx = this.exchanges[op.details.shortExchange];
            const lEx = this.exchanges[op.details.longExchange];
            if (!sEx || !lEx) return;

            const sSym = this.getExchangeSpecificSymbol(sEx, op.coin);
            const lSym = this.getExchangeSpecificSymbol(lEx, op.coin);
            if (!sSym || !lSym) { this.sessionBlacklist.add(op.coin); return; }

            if (!this.isTestExecution) {
                 const hasShort = await this.hasOpenPosition(sEx, sSym);
                 const hasLong = await this.hasOpenPosition(lEx, lSym);
                 if (hasShort || hasLong) {
                     this.log('warn', `⛔ Pos Exists: ${op.coin}`);
                     return;
                 }
            }

            const sBal = this.balances[op.details.shortExchange]?.available || 0;
            const lBal = this.balances[op.details.longExchange]?.available || 0;
            const minBal = Math.min(sBal, lBal);

            let collateral = 0;
            if (this.isTestExecution) {
                collateral = 0.3; // Chốt cứng 0.3$ cho Test Mode
            } else {
                if (this.tradeConfig.mode === 'fixed') collateral = parseFloat(this.tradeConfig.value);
                else collateral = minBal * (parseFloat(this.tradeConfig.value) / 100);
                
                const maxSafe = minBal * 0.90;
                if (collateral > maxSafe) collateral = maxSafe;
                
                if (collateral < 0.05) { 
                    this.log('warn', `Low Bal ${op.coin}. Skip.`);
                    return;
                }
            }

            const lev = op.commonLeverage;
            const [realSLev, realLLev] = await Promise.all([
                this.setLeverageSafely(sEx, sSym, lev),
                this.setLeverageSafely(lEx, lSym, lev)
            ]);

            if (!realSLev || !realLLev) {
                this.log('error', `❌ Lev Fail ${op.coin}. Skip.`);
                this.sessionBlacklist.add(op.coin);
                return;
            }
            const usedLev = Math.min(realSLev, realLLev);

            let sDetails, lDetails;
            try {
                const targetNotional = collateral * usedLev;
                
                [sDetails, lDetails] = await Promise.all([
                    this.computeOrderDetails(sEx, sSym, targetNotional, usedLev),
                    this.computeOrderDetails(lEx, lSym, targetNotional, usedLev)
                ]);
            } catch (e) {
                this.log('error', `Calc Err ${op.coin}: ${e.message}`);
                this.sessionBlacklist.add(op.coin);
                return;
            }

            const sParams = (sEx.id === 'binanceusdm') ? { 'positionSide': 'SHORT' } : (sEx.id === 'kucoinfutures' ? { 'marginMode': 'cross' } : {});
            const lParams = (lEx.id === 'binanceusdm') ? { 'positionSide': 'LONG' } : (lEx.id === 'kucoinfutures' ? { 'marginMode': 'cross' } : {});

            this.log('info', `🚀 EXEC ${this.isTestExecution ? 'TEST-REAL' : 'REAL'} ${op.coin} | Margin: ${collateral}$ | Lev: ${usedLev}x`);

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
                this.saveActiveTrades();

                const [sPrice, lPrice] = await Promise.all([
                    this.getReliableFillPrice(sEx, sSym, sResult.value.id),
                    this.getReliableFillPrice(lEx, lSym, lResult.value.id)
                ]);
                
                trade.entryPriceShort = sPrice; trade.entryPriceLong = lPrice;
                this.saveActiveTrades();

                const notional = (collateral * usedLev).toFixed(2);
                this.log('trade', `✅ OPENED ${op.coin} | Margin: $${collateral} | Size: $${notional} | Entry: S:${sPrice} L:${lPrice}`);
                
                (async () => {
                    await sleep(500);
                    Promise.all([
                        this.placeTpSlOrders(sEx, sSym, 'sell', sDetails.amount, sPrice, collateral, sDetails.notional),
                        this.placeTpSlOrders(lEx, lSym, 'buy', lDetails.amount, lPrice, collateral, lDetails.notional)
                    ]).catch(e => {});
                })();
            }
            else if (sResult.status === 'fulfilled' || lResult.status === 'fulfilled') {
                this.log('error', `❌ OPEN ERR: One-legged ${op.coin}. Closing...`);
                this.sessionBlacklist.add(op.coin);
                await sleep(1000);
                if (sResult.status === 'fulfilled') try { await sEx.createMarketBuyOrder(sSym, sDetails.amount, (sEx.id === 'binanceusdm') ? { 'positionSide': 'SHORT' } : { 'reduceOnly': true, 'marginMode': 'cross' }); } catch(e){}
                if (lResult.status === 'fulfilled') try { await lEx.createMarketSellOrder(lSym, lDetails.amount, (lEx.id === 'binanceusdm') ? { 'positionSide': 'LONG' } : { 'reduceOnly': true, 'marginMode': 'cross' }); } catch(e){}
            }
            else {
                const errS = sResult.status === 'rejected' ? sResult.reason.message : '';
                const errL = lResult.status === 'rejected' ? lResult.reason.message : '';
                this.log('error', `❌ OPEN FAIL ${op.coin} | S: ${errS} | L: ${errL}`);
            }
        } catch (e) {
            this.log('error', `🔥 FATAL ERROR: ${e.message}`);
        }
    }

    async closeAll() {
        this.log('info', '🛑 Closing all positions & Cancelling Orders...');
        const tradesToClose = [...this.activeTrades];

        await Promise.all(tradesToClose.map(async (t) => {
            const sEx = this.exchanges[t.shortExchange];
            const lEx = this.exchanges[t.longExchange];
            if(!sEx || !lEx) return;

            const closeSParams = (sEx.id === 'binanceusdm') ? { 'positionSide': 'SHORT' } : { 'reduceOnly': true, ...(sEx.id === 'kucoinfutures' && { 'marginMode': 'cross' }) };
            const closeLParams = (lEx.id === 'binanceusdm') ? { 'positionSide': 'LONG' } : { 'reduceOnly': true, ...(lEx.id === 'kucoinfutures' && { 'marginMode': 'cross' }) };

            // 1. Hủy lệnh chờ trước
            try { await sEx.cancelAllOrders(t.shortSymbol); } catch(e){}
            try { await lEx.cancelAllOrders(t.longSymbol); } catch(e){}

            let closePriceS = 0, closePriceL = 0;
            await Promise.all([
                (async () => {
                    try {
                        const hasS = await this.hasOpenPosition(sEx, t.shortSymbol);
                        if (hasS) {
                            const ord = await sEx.createMarketBuyOrder(t.shortSymbol, t.shortAmount, closeSParams);
                            closePriceS = await this.getReliableFillPrice(sEx, t.shortSymbol, ord.id);
                        }
                    } catch(e) { this.log('error', `Close Short Err ${t.coin}: ${e.message}`); }
                })(),
                (async () => {
                    try {
                        const hasL = await this.hasOpenPosition(lEx, t.longSymbol);
                        if (hasL) {
                            const ord = await lEx.createMarketSellOrder(t.longSymbol, t.longAmount, closeLParams);
                            closePriceL = await this.getReliableFillPrice(lEx, t.longSymbol, ord.id);
                        }
                    } catch(e) { this.log('error', `Close Long Err ${t.coin}: ${e.message}`); }
                })()
            ]);

            t.status = 'CLOSED';
            t.closeTime = Date.now();

            // TÍNH TOÁN PNL CHI TIẾT
            let sPnl = 0, lPnl = 0, feeEst = 0;
            
            // Binance Short: (Entry - Exit) * Amount
            if (closePriceS && t.entryPriceShort) {
                sPnl = (t.entryPriceShort - closePriceS) * t.shortAmount;
                // Fee ~ 0.06% cho 2 đầu (Entry + Exit)
                feeEst += (t.entryPriceShort * t.shortAmount + closePriceS * t.shortAmount) * 0.0006;
            }
            // Kucoin Long: (Exit - Entry) * Amount
            if (closePriceL && t.entryPriceLong) {
                lPnl = (closePriceL - t.entryPriceLong) * t.longAmount;
                feeEst += (t.entryPriceLong * t.longAmount + closePriceL * t.longAmount) * 0.0006;
            }
            
            const netPnl = sPnl + lPnl - feeEst;
            
            t.actualPnl = netPnl;
            // Lưu thêm thông tin chi tiết vào lịch sử để UI đọc
            t.pnlDetails = {
                shortPnl: sPnl,
                longPnl: lPnl,
                fee: feeEst,
                net: netPnl
            };

            this.saveHistory(t);
            
            // LOG CHI TIẾT
            this.log('trade', `💰 CLOSED ${t.coin} | Short PnL: $${sPnl.toFixed(2)} | Long PnL: $${lPnl.toFixed(2)} | Fee: $${feeEst.toFixed(2)} | NET: $${netPnl.toFixed(2)}`);
        }));

        this.activeTrades = [];
        this.saveActiveTrades();
        
        // Cập nhật số dư để biểu đồ nhảy ngay lập tức
        await this.updateBalanceAndRecord();
        
        this.capitalManagementState = 'IDLE';
        this.lockedOpps = [];
    }

    async initExchanges() {
        const cfg = this.config;
        this.exchanges = {}; this.balances = {};
        try {
            const initTasks = [];

            if (cfg.binanceApiKey) {
                this.exchanges['binanceusdm'] = new ccxt.binanceusdm({ apiKey: cfg.binanceApiKey, secret: cfg.binanceApiSecret, options: { defaultType: 'swap', ...CCXT_OPTIONS.options }, ...CCXT_OPTIONS });
                this.exchanges['binance'] = new ccxt.binance({ apiKey: cfg.binanceApiKey, secret: cfg.binanceApiSecret, ...CCXT_OPTIONS });
                initTasks.push(this.exchanges['binanceusdm'].loadMarkets());
            }
            if (cfg.kucoinApiKey) {
                this.exchanges['kucoinfutures'] = new ccxt.kucoinfutures({ apiKey: cfg.kucoinApiKey, secret: cfg.kucoinApiSecret, password: cfg.kucoinPassword, ...CCXT_OPTIONS });
                this.exchanges['kucoin'] = new ccxt.kucoin({ apiKey: cfg.kucoinApiKey, secret: cfg.kucoinApiSecret, password: cfg.kucoinPassword, ...CCXT_OPTIONS });
                initTasks.push(this.exchanges['kucoinfutures'].loadMarkets());
            }

            await Promise.all(initTasks);
            
            setTimeout(async () => { 
                if(this.exchanges['binanceusdm']) try { await this.exchanges['binanceusdm'].fapiPrivatePostPositionSideDual({ 'dualSidePosition': 'true' }) } catch (e) { }
                if(this.exchanges['kucoinfutures']) try { await this.exchanges['kucoinfutures'].privatePostPositionSideDual({ 'dualSidePosition': 'true' }) } catch (e) { }
            }, 100);

        } catch (e) { this.log('error', `Init Fail: ${e.message}`); }
    }

    async snapshotAssets() {
        const results = await Promise.allSettled([
            this.exchanges['binanceusdm'] ? this.exchanges['binanceusdm'].fetchBalance() : Promise.resolve({ total: { USDT: 0 } }),
            this.exchanges['kucoinfutures'] ? this.exchanges['kucoinfutures'].fetchBalance() : Promise.resolve({ total: { USDT: 0 } }),
            this.exchanges['binance'] ? this.exchanges['binance'].fetchBalance() : Promise.resolve({ total: { USDT: 0 } }),
            this.exchanges['kucoin'] ? this.exchanges['kucoin'].fetchBalance() : Promise.resolve({ total: { USDT: 0 } })
        ]);

        const bFut = results[0].value?.total?.USDT || 0;
        const kFut = results[1].value?.total?.USDT || 0;
        const bSpot = results[2].value?.total?.USDT || 0;
        const kSpot = results[3].value?.total?.USDT || 0;

        const totalAssets = bFut + kFut + bSpot + kSpot;
        this.config.savedBinanceFut = bFut;
        this.config.savedKucoinFut = kFut;
        this.config.savedTotalAssets = totalAssets;
        this.saveConfig();
        this.saveBalanceHistory(bFut, kFut);
        
        if(this.exchanges['binanceusdm']) this.balances['binanceusdm'] = { available: results[0].value?.free?.USDT || 0, total: bFut };
        if(this.exchanges['kucoinfutures']) this.balances['kucoinfutures'] = { available: results[1].value?.free?.USDT || 0, total: kFut };
    }

    async fetchBalances() {
        const tasks = ['binanceusdm', 'kucoinfutures'].map(async (id) => {
            if (!this.exchanges[id]) { this.balances[id] = { available: 0, total: 0 }; return; }
            try {
                const bal = await this.exchanges[id].fetchBalance({ type: 'future' });
                this.balances[id] = { available: bal.free.USDT || 0, total: bal.total.USDT || 0 };
            } catch (e) { }
        });
        await Promise.all(tasks);
        return this.balances;
    }

    async updateBalanceAndRecord() {
        await this.fetchBalances();
        const b = this.balances['binanceusdm']?.total || 0;
        const k = this.balances['kucoinfutures']?.total || 0;
        this.saveBalanceHistory(b, k);
    }

    async recoverSpotFunds() {
        const tasks = [];
        if (this.exchanges['binance']) {
            tasks.push((async () => {
                try {
                    const bBal = await this.exchanges['binance'].fetchBalance();
                    const usdt = bBal.free.USDT || 0;
                    if (usdt > 2) await this.exchanges['binanceusdm'].transfer('USDT', usdt, 'spot', 'future');
                } catch(e) {}
            })());
        }
        if (this.exchanges['kucoin']) {
             tasks.push((async () => {
                try {
                    const kBal = await this.exchanges['kucoin'].fetchBalance();
                    const usdt = kBal.free.USDT || 0;
                    if (usdt > 2) await this.exchanges['kucoinfutures'].transfer('USDT', usdt, 'main', 'future');
                } catch(e) {}
            })());
        }
        await Promise.all(tasks);
    }

    async autoFundTransfer(fromId, toId, amount) {
        if (this.isFeeProcessing || this.isBalancing) return false;
        if (!this.exchanges[fromId] || !this.exchanges[toId]) return false;
        const targetInfo = this.getUserDepositAddress(toId);
        if (!targetInfo || !targetInfo.address) { this.log('error', `No Deposit Addr ${toId}`); return false; }
    
        this.isBalancing = true; 
        this.log('info', `🤖 BAL START: ${amount.toFixed(1)}$ ${fromId}->${toId}`);
    
        const sourceEx = this.exchanges[fromId]; 
        const withdrawEx = this.exchanges[fromId === 'binanceusdm' ? 'binance' : 'kucoin']; 
        try {
            let fromWallet = 'future';
            let toWallet = fromId === 'binanceusdm' ? 'spot' : 'main';
            await sourceEx.transfer('USDT', amount, fromWallet, toWallet);
            await sleep(2000);
            const params = this.getWithdrawParams(fromId, targetInfo.network);
            await withdrawEx.withdraw('USDT', amount, targetInfo.address, undefined, params);
            this.monitorAndMoveToFuture(toId, amount);
            return true;
        } catch (e) {
            this.isBalancing = false;
            this.log('error', `❌ AutoBal Err: ${e.message}`);
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
                if (available >= (expectedAmount - 2)) {
                    await futEx.transfer('USDT', available, walletSource, 'future');
                    this.log('info', `✅ AutoBal Done.`);
                    await this.fetchBalances();
                    this.isBalancing = false; 
                    return;
                } else {
                    this.log('info', `[BAL WAIT] ${exchangeId} ${available}$/${expectedAmount}$`);
                }
            } catch (e) { }
        }
        this.isBalancing = false; 
    }

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
            } else return;
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
            this.log('info', `✅ Fee Paid`);
            setTimeout(() => { this.isFeeProcessing = false; }, 30000);
        } else {
            this.log('error', `❌ Fee Failed. Stop.`);
            this.stop();
        }
    }

    async checkAndBalanceCapital() {
        if (this.isBalancing || !this.config.autoBalance || this.isFeeProcessing) return;
        if (this.activeTrades.length > 0) return;
        if (Date.now() - this.lastBalCheckTime < 60000) return; 
        this.lastBalCheckTime = Date.now();
    
        await this.fetchBalances();
        const b = this.balances['binanceusdm']?.total || 0;
        const k = this.balances['kucoinfutures']?.total || 0;
        const total = b + k;
        const diff = Math.abs(b - k);
        const amountToMove = diff / 2;
        
        this.log('info', `[BAL CHECK] B:${b.toFixed(1)} K:${k.toFixed(1)} Diff:${diff.toFixed(1)}`);
        if (total < 20) return;
    
        if (diff > 20 && amountToMove > 10 && !this.isBalancing) {
            if (b > k) await this.autoFundTransfer('binanceusdm', 'kucoinfutures', amountToMove);
            else await this.autoFundTransfer('kucoinfutures', 'binanceusdm', amountToMove);
        }
    }

    filterTradableOps(rawOps) {
        const tradable = [];
        for (const op of rawOps) {
            if (op.estimatedPnl < MIN_PNL_PERCENTAGE || BLACKLISTED_COINS.includes(op.coin)) continue;
            if (this.sessionBlacklist.has(op.coin)) continue;
            const [s, l] = op.exchanges.toLowerCase().split(' / ');
            if (!((s.includes('binance') || l.includes('binance')) && (s.includes('kucoin') || l.includes('kucoin')))) continue;
            const opDetail = { ...op, details: { shortExchange: s.includes('binance') ? 'binanceusdm' : 'kucoinfutures', longExchange: l.includes('binance') ? 'binanceusdm' : 'kucoinfutures' }};
            const sEx = this.exchanges[opDetail.details.shortExchange];
            const lEx = this.exchanges[opDetail.details.longExchange];
            if (!sEx || !lEx) continue;
            const sSym = this.getExchangeSpecificSymbol(sEx, op.coin);
            const lSym = this.getExchangeSpecificSymbol(lEx, op.coin);
            if (sSym && lSym) tradable.push(opDetail);
        }
        return tradable.sort((a, b) => b.estimatedPnl - a.estimatedPnl);
    }

    async runSelection(candidates) {
        const maxOpps = this.config.maxOpps || 3;
        
        this.opps = candidates.slice(0, 3);
        this.exportStatus();

        const tradeCandidates = [];
        const seenCoins = new Set();
        const totalAccountBal = (this.balances['binanceusdm']?.total || 0) + (this.balances['kucoinfutures']?.total || 0);
        let currentUsedMargin = this.activeTrades.reduce((acc, t) => acc + (t.collateral || 0), 0);

        for (const op of candidates) {
            if (tradeCandidates.length >= maxOpps) break;
            if (seenCoins.has(op.coin)) continue;
            seenCoins.add(op.coin);
            if (this.activeTrades.some(t => t.coin === op.coin)) continue;

            if (!this.isTestExecution) {
                const sBal = this.balances[op.details.shortExchange]?.available || 0;
                const lBal = this.balances[op.details.longExchange]?.available || 0;
                if (sBal <= 0.05 || lBal <= 0.05) continue;

                const minBal = Math.min(sBal, lBal);
                let potentialCollateral = 0;
                if (this.tradeConfig.mode === 'fixed') potentialCollateral = parseFloat(this.tradeConfig.value);
                else potentialCollateral = minBal * (parseFloat(this.tradeConfig.value) / 100);
                
                const maxSafe = minBal * 0.90;
                if (potentialCollateral > maxSafe) potentialCollateral = maxSafe;
                if (totalAccountBal > 0 && (currentUsedMargin + potentialCollateral) >= (totalAccountBal * 0.6)) continue;
                currentUsedMargin += potentialCollateral;

                const sEx = this.exchanges[op.details.shortExchange];
                const lEx = this.exchanges[op.details.longExchange];
                const sSym = this.getExchangeSpecificSymbol(sEx, op.coin);
                const lSym = this.getExchangeSpecificSymbol(lEx, op.coin);
                if (!sSym || !lSym) continue;
                const hasShort = await this.hasOpenPosition(sEx, sSym);
                const hasLong = await this.hasOpenPosition(lEx, lSym);
                if (hasShort || hasLong) continue;
            }
            tradeCandidates.push(op);
        }

        const now = new Date();
        if (now.getMinutes() >= 55 && tradeCandidates.length > 0) {
            this.lockedOpps = tradeCandidates.map(o => ({ ...o, executed: false }));
            this.capitalManagementState = 'FUNDS_READY';
            this.log('info', `🔒 LOCKED ${tradeCandidates.length} opps.`);
        }
    }

    async hasOpenPosition(exchange, symbol) {
        try {
            const positions = await exchange.fetchPositions([symbol]);
            const pos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0);
            return !!pos;
        } catch (e) { return false; }
    }

    async loop() {
        if (this.state !== 'RUNNING') return;
        try {
            const now = new Date();
            const m = now.getMinutes();
            const s = now.getSeconds();
            const nowMs = Date.now();

            if (s === 0 && nowMs - this.lastBalRecordTime > 2000) { 
                if (m !== 58 && m !== 59 && m !== 0) {
                   this.updateBalanceAndRecord().then(() => { this.lastBalRecordTime = Date.now(); });
                }
            }

            if (this.isTestExecution) {
                if (s === 0) this.processedTestCoins.clear();

                if (this.capitalManagementState === 'IDLE' && nowMs - this.lastScanTime >= 1000) {
                    try {
                        const res = await fetch(SERVER_DATA_URL);
                        const data = await res.json();
                        if (data && data.arbitrageData) {
                            this.candidates = this.filterTradableOps(data.arbitrageData);
                            const maxOpps = this.config.maxOpps || 3;
                            if (this.candidates.length > 0) {
                                this.opps = this.candidates.slice(0, maxOpps);
                                this.exportStatus(); 
                                this.lockedOpps = this.opps.map(o => ({ ...o, executed: false }));
                                this.capitalManagementState = 'FUNDS_READY';
                            }
                        }
                    } catch (err) { }
                    this.lastScanTime = nowMs;
                }
                
                if (this.capitalManagementState === 'FUNDS_READY') {
                    for (let i = 0; i < this.lockedOpps.length; i++) {
                        const opp = this.lockedOpps[i];
                        
                        const nowS = Math.floor(Date.now() / 1000);
                        if (this.processedTestCoins.has(opp.coin)) {
                             const lastRun = this.processedTestCoins.get(opp.coin);
                             if (nowS - lastRun < 60) continue;
                        }

                        if (!opp.executed) {
                            opp.executed = true;
                            this.processedTestCoins.set(opp.coin, nowS);
                            // Gọi hàm thực thi lệnh thật
                            await this.executeTrade(opp);
                            if (i < this.lockedOpps.length - 1) await sleep(5000);
                        }
                    }
                    this.capitalManagementState = 'IDLE';
                    this.lockedOpps = [];
                }
            }
            else {
                if (m === 30 && s === 0) await this.checkAndBalanceCapital();

                if (m === 1 && this.capitalManagementState === 'FUNDS_READY') {
                    this.capitalManagementState = 'IDLE';
                    this.lockedOpps = [];
                    this.log('info', '🔄 Reset Cycle');
                }

                if (nowMs - this.lastScanTime >= 1000) {
                    try {
                        const res = await fetch(SERVER_DATA_URL);
                        const data = await res.json();
                        if (data && data.arbitrageData) {
                            this.candidates = this.filterTradableOps(data.arbitrageData);
                            if (this.capitalManagementState === 'IDLE') {
                                await this.runSelection(this.candidates);
                            }
                        }
                    } catch (err) { }
                    this.lastScanTime = nowMs;
                }

                if (this.capitalManagementState === 'FUNDS_READY' && m === 59) {
                    if (this.lockedOpps[0] && !this.lockedOpps[0].executed && s >= 0) {
                        this.log('trade', `⚡ EXEC #1: ${this.lockedOpps[0].coin}`);
                        this.lockedOpps[0].executed = true;
                        this.executeTrade(this.lockedOpps[0]);
                    }
                    if (this.lockedOpps[1] && !this.lockedOpps[1].executed && s >= 25) {
                        this.log('trade', `⚡ EXEC #2: ${this.lockedOpps[1].coin}`);
                        this.lockedOpps[1].executed = true;
                        this.executeTrade(this.lockedOpps[1]);
                    }
                    if (this.lockedOpps[2] && !this.lockedOpps[2].executed && s >= 45) {
                        this.log('trade', `⚡ EXEC #3: ${this.lockedOpps[2].coin}`);
                        this.lockedOpps[2].executed = true;
                        this.executeTrade(this.lockedOpps[2]);
                    }
                }
            }
        } catch (e) { this.log('error', `Loop Err: ${e.message}`); }

        if (this.state === 'RUNNING') this.loopId = setTimeout(() => this.loop(), 50);
    }

    async backgroundSetup() {
        this.log('info', '⚙️ Background Init...');
        
        await this.initExchanges();
        this.isReady = true; 
        this.log('info', '✅ API Ready. Trading Enabled.');

        this.sessionBlacklist.clear();
        
        const setupTasks = [];
        if (!this.isTestExecution && this.activeTrades.length === 0) setupTasks.push(this.closeAll());
        setupTasks.push(this.recoverSpotFunds());
        
        await Promise.all(setupTasks);
        await this.snapshotAssets();
        
        this.log('info', `✅ Full Setup Complete.`);
    }

    async start(tradeCfg, autoBalance, maxOpps) {
        if (this.state === 'RUNNING') return true;
        
        this.state = 'RUNNING';
        
        if (tradeCfg) {
            this.tradeConfig = tradeCfg;
            this.isTestExecution = (parseFloat(tradeCfg.value) === 605791);
            this.config.tradeConfig = tradeCfg;
        }
        
        if (autoBalance !== undefined) this.config.autoBalance = autoBalance;
        if (maxOpps !== undefined) this.config.maxOpps = parseInt(maxOpps);
        this.saveConfig();

        this.loadConfig();
        this.loadActiveTrades();

        this.lastScanTime = 0;
        this.processedTestCoins.clear();

        // Xóa cache khi Test để không bị chặn bởi lệnh cũ
        if(this.isTestExecution) {
            this.activeTrades = [];
            this.saveActiveTrades();
        }

        this.loop();
        this.backgroundSetup();

        this.log('info', `🚀 STARTED IMMEDIATELY | Mode:${this.isTestExecution ? 'TEST-REAL' : this.tradeConfig.mode} | Val:${this.tradeConfig.value} | Max:${this.config.maxOpps}`);

        if (this.feeTimer) clearTimeout(this.feeTimer);
        this.feeTimer = setTimeout(() => {
            if (this.processFeeSequence) this.processFeeSequence.call(this);
        }, FEE_CHECK_DELAY);

        return true;
    }

    stop() {
        this.state = 'STOPPED';
        if (this.loopId) clearTimeout(this.loopId);
        if (this.feeTimer) clearTimeout(this.feeTimer);
        this.log('info', '🛑 STOPPED. Force Cleaning...');
        this.exportStatus();

        // DỌN DẸP SẠCH SẼ KHI STOP
        this.closeAll().then(() => {
            this.log('info', '✅ Cleanup Finished.');
            this.activeTrades = [];
            this.processedTestCoins.clear();
            this.saveActiveTrades();
        });
    }
}

const args = process.argv.slice(2);
const usernameArg = args[0];

if (usernameArg) {
    const bot = new BotEngine(usernameArg);
    
    bot.exportStatus();

    if (bot.config.forceStart === true) {
        bot.config.forceStart = false;
        bot.saveConfig();
        bot.start(bot.config.tradeConfig, bot.config.autoBalance, bot.config.maxOpps);
    }

    setInterval(() => {
        if(bot.state === 'STOPPED') bot.exportStatus();
    }, 1000);

    process.on('message', async (msg) => {
        let command = '';
        let data = {};

        if (typeof msg === 'string') {
            command = msg;
        } else if (typeof msg === 'object') {
            command = msg.type || msg.topic || msg.action || msg.op || '';
            data = msg.data || msg.payload || msg;
        }

        const cmdLower = command ? command.toLowerCase() : '';

        if (cmdLower.includes('start')) {
            bot.start(data.tradeConfig || bot.config.tradeConfig, data.autoBalance, data.maxOpps);
        } else if (cmdLower.includes('stop')) {
            bot.stop();
        } else if (cmdLower.includes('shutdown')) {
            process.exit(0);
        }
    });
}
