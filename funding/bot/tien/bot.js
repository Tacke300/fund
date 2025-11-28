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
const MIN_MINUTES_FOR_EXECUTION = 15; // [MỚI] Giới hạn 15 phút funding

// [FEE CONFIG]
const FEE_AUTO_ON = 10;
const FEE_AUTO_OFF = 5;
const FEE_VIP_MONTHLY = 200;
const FEE_CHECK_DELAY = 60000; 

// [TP/SL CONFIG - UPDATED]
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
        
        this.state = 'STOPPED';
        this.capitalManagementState = 'IDLE';
        this.loopId = null;
        this.feeTimer = null;
        this.isFeeProcessing = false; 
        this.isBalancing = false; 
        this.isTestExecution = false; 
        
        this.lastScanTime = 0;
        this.lastBalCheckTime = 0;
        
        this.balances = {};
        this.history = [];
        this.activeTrades = [];
        this.candidates = [];
        this.opp = null;      
        this.lockedOpp = null;
        
        this.sessionBlacklist = new Set(); 

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
        const allowedTypes = ['error', 'trade', 'result', 'fee', 'vip', 'transfer', 'info', 'warn', 'pm2', 'fatal', 'test'];
        if (!allowedTypes.includes(type)) return;
        const t = new Date().toLocaleTimeString('vi-VN', { hour12: false });
        if (type === 'pm2' || type === 'fatal') console.error(`[${t}] [USER: ${this.username}] [${type.toUpperCase()}] ${msg}`);
        else console.log(`[${t}] [USER: ${this.username}] [${type.toUpperCase()}] ${msg}`);
    }

    loadConfig() { try { if (fs.existsSync(this.configFile)) { const saved = JSON.parse(fs.readFileSync(this.configFile, 'utf8')); this.config = { ...this.config, ...saved }; } } catch (e) {} }
    saveConfig(newConfig = {}) { for (let k in newConfig) if (newConfig[k] !== undefined) this.config[k] = newConfig[k]; fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2)); }
    loadHistory() { try { if (fs.existsSync(this.historyFile)) this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8')); } catch(e) {} }
    saveHistory(trade) { this.history.unshift(trade); if(this.history.length > 50) this.history = this.history.slice(0,50); fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2)); }

    // --- HELPER NETWORK ---
    getWithdrawParams(exchangeId, targetNetwork) {
        if (exchangeId.includes('binance')) {
            if (targetNetwork === 'BEP20') return { network: 'BSC' };
        }
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
        if (targetExchangeId === 'binanceusdm') {
            if (this.config.binanceDepositAddress) return { address: this.config.binanceDepositAddress, network: 'APTOS' };
        }
        if (targetExchangeId === 'kucoinfutures') {
            if (this.config.kucoinDepositAddress) return { address: this.config.kucoinDepositAddress, network: 'BEP20' };
        }
        return null;
    }

    // --- LOGIC GIAO DỊCH ---
    async getExchangeSpecificSymbol(exchange, rawCoinSymbol) {
        const find = (ex) => {
            if (!ex.markets) return null;
            const base = String(rawCoinSymbol).toUpperCase();
            
            if (ex.id === 'binanceusdm') {
                const k = Object.keys(ex.markets).find(k => k.replace('/','').replace(':USDT','') === base.replace('USDT',''));
                if(k) return ex.markets[k].id;
            }
            const cleanBase = base.replace(/USDT$/, '');
            const attempts = [`${cleanBase}/USDT:USDT`, `${cleanBase}USDT`, `${cleanBase}-USDT-SWAP`, `${cleanBase}USDTM`, `${cleanBase}/USDT`];
            for (const attempt of attempts) {
                if(ex.markets[attempt]) return ex.markets[attempt].id;
            }
            return null;
        };

        let sym = find(exchange);
        if (!sym) {
            try { await exchange.loadMarkets(true); sym = find(exchange); } catch (e) { return null; }
        }
        return sym;
    }

    // [THÊM] Hàm kiểm tra vị thế (đã sửa lỗi thiếu hàm)
    async hasOpenPosition(exchange, symbol) {
        try {
            const positions = await exchange.fetchPositions([symbol]);
            const pos = positions.find(p => p.symbol === symbol);
            return pos && parseFloat(pos.contracts) > 0;
        } catch (e) {
            return false;
        }
    }

    // [FIX] KuCoin Leverage & Cross Mode
    async setLeverageSafely(exchange, symbol, desiredLeverage) {
        try {
            try {
                if (exchange.id === 'binanceusdm') {
                    await exchange.setMarginMode('cross', symbol);
                }
                if (exchange.id === 'kucoinfutures') {
                    await exchange.setMarginMode('cross', symbol);
                }
            } catch (e) { }

            let finalLev = desiredLeverage;
            if (exchange.id === 'kucoinfutures') {
                finalLev = Math.round(desiredLeverage);
            }

            await exchange.setLeverage(finalLev, symbol);
            return finalLev;
        } catch (e) { return null; }
    }

    async computeOrderDetails(exchange, symbol, targetNotionalUSDT, leverage) {
        await exchange.loadMarkets();
        const market = exchange.market(symbol);
        const ticker = await exchange.fetchTicker(symbol);
        const price = ticker?.last || ticker?.close;
        if (!price) throw new Error(`Không lấy được giá cho ${symbol}`);
        const contractSize = market.contractSize ?? 1;
        
        let amount = parseFloat(exchange.amountToPrecision(symbol, targetNotionalUSDT / (price * contractSize)));
        if (exchange.id === 'kucoinfutures' && market.precision.amount === 0) amount = Math.round(amount);
        if (amount <= (market.limits.amount.min || 0)) amount = market.limits.amount.min; 
        return { amount, price, notional: amount * price * contractSize };
    }

    // [FIX] Binance ID & ReduceOnly
    async placeTpSlOrders(exchange, symbol, side, amount, entryPrice, collateral, notionalValue) {
        if (!entryPrice || entryPrice <= 0) return;
        const slPriceChange = entryPrice * (SL_PERCENTAGE / 100 / (notionalValue / collateral));
        const tpPriceChange = entryPrice * (TP_PERCENTAGE / 100 / (notionalValue / collateral));
        let tpPrice = side === 'sell' ? entryPrice - tpPriceChange : entryPrice + tpPriceChange;
        let slPrice = side === 'sell' ? entryPrice + slPriceChange : entryPrice - slPriceChange;
        
        const orderSide = (side === 'sell') ? 'buy' : 'sell'; 
        const botId = `ab_${Date.now()}_${Math.floor(Math.random()*1000)}`;

        let commonParams = {};
        
        if (exchange.id === 'binanceusdm') {
            commonParams = { 
                'positionSide': (side === 'sell') ? 'SHORT' : 'LONG',
                'newClientOrderId': botId 
            };
        } else if (exchange.id === 'kucoinfutures') {
            commonParams = { 
                'reduceOnly': true, 
                'marginMode': 'cross',
                'clientOid': botId 
            };
        }

        try {
            if (exchange.id === 'kucoinfutures') {
                const tpParams = { ...commonParams, 'stop': side === 'sell' ? 'down' : 'up', 'stopPrice': exchange.priceToPrecision(symbol, tpPrice), 'stopPriceType': 'MP' };
                await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, tpParams);
                
                const botIdSL = `ab_${Date.now()}_sl_${Math.floor(Math.random()*1000)}`;
                const slParams = { ...commonParams, 'clientOid': botIdSL, 'stop': side === 'sell' ? 'up' : 'down', 'stopPrice': exchange.priceToPrecision(symbol, slPrice), 'stopPriceType': 'MP' };
                await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, slParams);
            } else {
                await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', orderSide, amount, undefined, { ...commonParams, 'stopPrice': exchange.priceToPrecision(symbol, tpPrice) });
                
                const botIdSL = `ab_${Date.now()}_sl_${Math.floor(Math.random()*1000)}`;
                await exchange.createOrder(symbol, 'STOP_MARKET', orderSide, amount, undefined, { ...commonParams, 'newClientOrderId': botIdSL, 'stopPrice': exchange.priceToPrecision(symbol, slPrice) });
            }
        } catch (e) { this.log('warn', `[TP/SL] Fail: ${e.message}`); }
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
            await sleep(1000); 
        }
        return null;
    }

    // [TÍNH NĂNG 1] Lưu TP/SL cũ
    async saveUserOrders(exchange, symbol) {
        try {
            const orders = await exchange.fetchOpenOrders(symbol);
            return orders.filter(o => {
                const isTpSl = o.stopPrice && o.stopPrice > 0;
                const cid = o.clientOrderId || o.clientOid || (o.info && o.info.clientOid) || '';
                const isBotOrder = cid.includes('ab_');
                return isTpSl && !isBotOrder;
            }).map(o => ({
                type: o.type,
                side: o.side,
                amount: o.amount,
                price: o.price,
                stopPrice: o.stopPrice,
                info: o.info 
            }));
        } catch (e) { return []; }
    }

    // [TÍNH NĂNG 2] Khôi phục lệnh
    async restoreUserOrders(exchange, symbol, savedOrders) {
        if (!savedOrders || savedOrders.length === 0) return;
        this.log('info', `🔄 Đang khôi phục ${savedOrders.length} lệnh TP/SL cũ cho ${symbol}...`);
        
        for (const o of savedOrders) {
            try {
                let params = {};
                if (exchange.id === 'binanceusdm') {
                    params = { 
                        'stopPrice': exchange.priceToPrecision(symbol, o.stopPrice),
                        'positionSide': o.info.positionSide 
                    };
                    if (o.type === 'TAKE_PROFIT_MARKET' || o.type === 'STOP_MARKET') {
                        params.closePosition = 'false'; 
                    }
                } 
                else if (exchange.id === 'kucoinfutures') {
                    params = {
                        'stopPrice': exchange.priceToPrecision(symbol, o.stopPrice),
                        'stop': (o.side === 'sell' ? 'up' : 'down'), 
                        'reduceOnly': true,
                        'marginMode': 'cross'
                    };
                    if (o.info.stop) params.stop = o.info.stop; 
                }
                await exchange.createOrder(symbol, o.type, o.side, o.amount, o.price, params);
            } catch (e) { }
            await sleep(500);
        }
    }

    // [TÍNH NĂNG 3] Real PnL (Dùng fetchMyTrades)
    async calculateSessionPnL(exchange, symbol, startTime, endTime) {
        let totalPnl = 0;
        try {
            const trades = await exchange.fetchMyTrades(symbol, startTime, undefined, { 'endTime': endTime });
            let buyCost = 0, sellCost = 0, fees = 0;
            
            for (const t of trades) {
                const cost = t.cost ? parseFloat(t.cost) : (parseFloat(t.price) * parseFloat(t.amount)); 
                
                if (t.side === 'buy') buyCost += cost;
                if (t.side === 'sell') sellCost += cost;
                
                if (t.fee && t.fee.cost) {
                    fees += parseFloat(t.fee.cost);
                }
            }
            totalPnl = sellCost - buyCost - fees;

        } catch(e) { 
            this.log('error', `PnL Calc Error (${exchange.id}): ${e.message}`); 
        }
        return totalPnl;
    }

    // [TÍNH NĂNG 4] Chỉ dọn dẹp lệnh Bot
    async cleanupBotOrders(exchange, symbol) {
        try {
            const openOrders = await exchange.fetchOpenOrders(symbol);
            for (const o of openOrders) {
                const rawId = (o.info && o.info.clientOrderId) ? o.info.clientOrderId : (o.clientOrderId || '');
                if (rawId.startsWith('ab_')) {
                    try { await exchange.cancelOrder(o.id, symbol); } catch(e){}
                }
            }
        } catch(e){}
    }

    // --- EXECUTE TRADE ---
    async executeTrade(op) {
        const sEx = this.exchanges[op.details.shortExchange];
        const lEx = this.exchanges[op.details.longExchange];
        if(!sEx || !lEx) return;
        
        const sSym = await this.getExchangeSpecificSymbol(sEx, op.coin);
        const lSym = await this.getExchangeSpecificSymbol(lEx, op.coin);
        
        if(!sSym || !lSym) {
            this.log('warn', `Symbol ${op.coin} not found.`);
            this.sessionBlacklist.add(op.coin);
            this.lockedOpp = null; this.capitalManagementState = 'IDLE';
            return;
        }

        const savedShortOrders = await this.saveUserOrders(sEx, sSym);
        const savedLongOrders = await this.saveUserOrders(lEx, lSym);
        if (savedShortOrders.length > 0) this.log('info', `📝 Đã ghi nhớ ${savedShortOrders.length} lệnh treo cũ bên Short.`);
        if (savedLongOrders.length > 0) this.log('info', `📝 Đã ghi nhớ ${savedLongOrders.length} lệnh treo cũ bên Long.`);

        await this.fetchBalances();
        const sBal = this.balances[op.details.shortExchange].available;
        const lBal = this.balances[op.details.longExchange].available;
        const minBal = Math.min(sBal, lBal);

        let collateral = 0;
        if (this.isTestExecution) {
            collateral = 0.3; 
            this.log('test', `🛠️ TEST: ${op.coin} | MODE: CROSS | MARGIN: 0.3$`);
        } else {
            if (this.tradeConfig.mode === 'fixed') collateral = parseFloat(this.tradeConfig.value);
            else collateral = minBal * (parseFloat(this.tradeConfig.value) / 100);

            const maxSafe = minBal * 0.96;
            if (collateral > maxSafe) collateral = maxSafe;

            if (collateral < MIN_COLLATERAL_FOR_TRADE) {
                this.log('warn', `Vốn quá nhỏ. Bỏ qua.`);
                this.lockedOpp = null; this.capitalManagementState = 'IDLE';
                return;
            }
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
                this.computeOrderDetails(sEx, sSym, targetNotional, usedLev),
                this.computeOrderDetails(lEx, lSym, targetNotional, usedLev)
            ]);
        } catch(e) {
            this.log('error', `Tính toán lỗi: ${e.message}. Blacklisting.`);
            this.sessionBlacklist.add(op.coin); 
            this.lockedOpp = null; this.capitalManagementState = 'IDLE';
            return;
        }

        const finalLev = Math.round(usedLev);
        const sParams = (sEx.id === 'binanceusdm') 
            ? { 'positionSide': 'SHORT' } 
            : (sEx.id === 'kucoinfutures' ? {'marginMode': 'cross', 'leverage': finalLev} : {});
            
        const lParams = (lEx.id === 'binanceusdm') 
            ? { 'positionSide': 'LONG' } 
            : (lEx.id === 'kucoinfutures' ? {'marginMode': 'cross', 'leverage': finalLev} : {});

        const results = await Promise.allSettled([
            sEx.createMarketSellOrder(sSym, sDetails.amount, sParams),
            lEx.createMarketBuyOrder(lSym, lDetails.amount, lParams)
        ]);

        const sResult = results[0];
        const lResult = results[1];

        if (sResult.status === 'rejected') this.log('error', `SHORT Fail (${sEx.id}): ${sResult.reason.message}`);
        if (lResult.status === 'rejected') this.log('error', `LONG Fail (${lEx.id}): ${lResult.reason.message}`);

        if (sResult.status === 'fulfilled' && lResult.status === 'fulfilled') {
            const sPrice = await this.getReliableFillPrice(sEx, sSym, sResult.value.id);
            const lPrice = await this.getReliableFillPrice(lEx, lSym, lResult.value.id);

            const trade = {
                id: Date.now(), coin: op.coin, shortExchange: sEx.id, longExchange: lEx.id, shortSymbol: sSym, longSymbol: lSym, shortOrderId: sResult.value.id, longOrderId: lResult.value.id, entryTime: Date.now(), estimatedPnlFromOpportunity: op.estimatedPnl, shortAmount: sDetails.amount, longAmount: lDetails.amount, status: 'OPEN', leverage: usedLev, collateral: collateral,
                savedShortOrders: savedShortOrders,
                savedLongOrders: savedLongOrders
            };
            this.activeTrades.push(trade);
            this.capitalManagementState = 'TRADE_OPEN';
            this.lockedOpp = null;
            
            this.log('trade', `OPEN SUCCESS | ${op.coin} | Money: ${collateral.toFixed(1)}$`);
            this.placeTpSlOrders(sEx, sSym, 'sell', sDetails.amount, sPrice, collateral, sDetails.notional);
            this.placeTpSlOrders(lEx, lSym, 'buy', lDetails.amount, lPrice, collateral, lDetails.notional);
        }
        else if (sResult.status === 'fulfilled' || lResult.status === 'fulfilled') {
            this.log('warn', `⚠️ LỆCH LỆNH! Đang chờ 10s để Retry bên lỗi...`);
            let retrySuccess = false;
            for (let i = 0; i < 5; i++) { 
                await sleep(2000);
                if (sResult.status === 'rejected') {
                    try {
                        const retryOrd = await sEx.createMarketSellOrder(sSym, sDetails.amount, sParams);
                        this.log('info', `✅ Retry Short thành công!`);
                        sResult.status = 'fulfilled'; sResult.value = retryOrd;
                        retrySuccess = true;
                        break;
                    } catch(e) { this.log('warn', `Retry Short lần ${i+1} thất bại: ${e.message}`); }
                } else {
                    try {
                        const retryOrd = await lEx.createMarketBuyOrder(lSym, lDetails.amount, lParams);
                        this.log('info', `✅ Retry Long thành công!`);
                        lResult.status = 'fulfilled'; lResult.value = retryOrd;
                        retrySuccess = true;
                        break;
                    } catch(e) { this.log('warn', `Retry Long lần ${i+1} thất bại: ${e.message}`); }
                }
            }

            if (!retrySuccess) {
                this.log('fatal', `❌ RETRY THẤT BẠI. ĐÓNG KHẨN CẤP & DỪNG BOT!`);
                if (sResult.status === 'fulfilled') try { await sEx.createMarketBuyOrder(sSym, sDetails.amount, sEx.id==='binanceusdm'?{positionSide:'SHORT'}:{reduceOnly:true}); } catch(e){}
                if (lResult.status === 'fulfilled') try { await lEx.createMarketSellOrder(lSym, lDetails.amount, lEx.id==='binanceusdm'?{positionSide:'LONG'}:{reduceOnly:true}); } catch(e){}
                this.stop();
            } else {
                this.log('info', `⚠️ Đã cứu được lệnh lệch. Đóng ngay để bảo toàn vốn.`);
                 const trade = {
                    id: Date.now(), coin: op.coin, shortExchange: sEx.id, longExchange: lEx.id, shortSymbol: sSym, longSymbol: lSym, shortOrderId: sResult.value.id, longOrderId: lResult.value.id, entryTime: Date.now(), estimatedPnlFromOpportunity: op.estimatedPnl, shortAmount: sDetails.amount, longAmount: lDetails.amount, status: 'OPEN', leverage: usedLev, collateral: collateral
                };
                this.activeTrades.push(trade);
                this.closeAll();
            }
        } else {
            this.log('error', `Lỗi cả 2 sàn. Blacklisting.`);
            this.sessionBlacklist.add(op.coin);
            this.lockedOpp = null; this.capitalManagementState = 'IDLE';
        }
    }

    async closeAll() {
        this.log('info', '🛑 Closing positions...');
        for (const t of this.activeTrades) {
            const sEx = this.exchanges[t.shortExchange];
            const lEx = this.exchanges[t.longExchange];
            
            await this.cleanupBotOrders(sEx, t.shortSymbol);
            await this.cleanupBotOrders(lEx, t.longSymbol);
            
            const closeSParams = (sEx.id === 'binanceusdm') ? { 'positionSide': 'SHORT' } : {'reduceOnly': true, ...(sEx.id === 'kucoinfutures' && {'marginMode': 'cross'})};
            const closeLParams = (lEx.id === 'binanceusdm') ? { 'positionSide': 'LONG' } : {'reduceOnly': true, ...(lEx.id === 'kucoinfutures' && {'marginMode': 'cross'})};

            try { await sEx.createMarketBuyOrder(t.shortSymbol, t.shortAmount, closeSParams); } catch(e){ this.log('error', `Close Short Err: ${e.message}`); }
            try { await lEx.createMarketSellOrder(t.longSymbol, t.longAmount, closeLParams); } catch(e){ this.log('error', `Close Long Err: ${e.message}`); }
            
            if (t.savedShortOrders && t.savedShortOrders.length > 0) await this.restoreUserOrders(sEx, t.shortSymbol, t.savedShortOrders);
            if (t.savedLongOrders && t.savedLongOrders.length > 0) await this.restoreUserOrders(lEx, t.longSymbol, t.savedLongOrders);

            this.log('info', `⏳ Đợi 30s để sàn chốt sổ PnL...`);
            await sleep(30000);
            
            const closeTime = Date.now();
            const sPnl = await this.calculateSessionPnL(sEx, t.shortSymbol, t.entryTime - 1000, closeTime + 1000);
            const lPnl = await this.calculateSessionPnL(lEx, t.longSymbol, t.entryTime - 1000, closeTime + 1000);
            const totalRealPnl = sPnl + lPnl;

            t.status = 'CLOSED'; 
            t.pnl = totalRealPnl; 
            
            this.saveHistory(t);
            this.log('result', `CLOSE | Coin: ${t.coin} | Real PnL: ${totalRealPnl.toFixed(4)}$`);
        }
        this.activeTrades = [];
        this.capitalManagementState = 'IDLE';
        this.lockedOpp = null;
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

    async checkAndBalanceCapital() {
        if (this.isBalancing || !this.config.autoBalance || this.isFeeProcessing) return; 
        if (this.activeTrades.length > 0) return; 
        
        if (Date.now() - this.lastBalCheckTime < 60000) return; 
        this.lastBalCheckTime = Date.now();

        await this.fetchBalances();
        const b = this.balances['binanceusdm']?.total || 0;
        const k = this.balances['kucoinfutures']?.total || 0;
        const total = b + k;
        if (total < 20) return;

        try {
            const [bPos, kPos] = await Promise.all([
                this.exchanges['binanceusdm'].fetchPositions(),
                this.exchanges['kucoinfutures'].fetchPositions()
            ]);

            const bMarginUsed = bPos.reduce((sum, p) => sum + parseFloat(p.initialMargin || 0), 0);
            if (b > 0 && (bMarginUsed / b) >= 0.5) {
                this.log('warn', `⛔ Auto-Balance TẠM DỪNG: Binance dùng >50% vốn vào lệnh.`);
                return;
            }

            const kMarginUsed = kPos.reduce((sum, p) => {
                let margin = parseFloat(p.initialMargin || 0);
                if (margin === 0 && p.notional && p.leverage) margin = Math.abs(parseFloat(p.notional)) / parseFloat(p.leverage);
                return sum + margin;
            }, 0);
            if (k > 0 && (kMarginUsed / k) >= 0.5) {
                this.log('warn', `⛔ Auto-Balance TẠM DỪNG: KuCoin dùng >50% vốn vào lệnh.`);
                return;
            }
        } catch (err) {}

        const diff = Math.abs(b - k);
        const amountToMove = diff / 2;
        
        if (diff > 20 && amountToMove > 10 && !this.isBalancing) {
            this.log('info', `⚖️ Phát hiện lệch vốn (Delta=${diff.toFixed(1)}$). Kích hoạt Auto-Balance...`);
            if (b > k) await this.autoFundTransfer('binanceusdm', 'kucoinfutures', amountToMove);
            else await this.autoFundTransfer('kucoinfutures', 'binanceusdm', amountToMove);
        }
    }

    // [THAY ĐỔI: LOGIC LỌC COIN 15 PHÚT]
    async filterTradableOps(rawOps) {
        const now = Date.now();
        const tradable = [];
        for (const op of rawOps) {
            if (op.estimatedPnl < MIN_PNL_PERCENTAGE || BLACKLISTED_COINS.includes(op.coin)) continue;
            if (this.sessionBlacklist.has(op.coin)) continue;

            // [LOGIC DEMO03] Kiểm tra 15 phút Funding
            if (op.nextFundingTime) {
                const diff = op.nextFundingTime - now;
                const minutes = diff / 60000;
                // Nếu < 0 hoặc > 15 phút thì bỏ qua
                if (minutes <= 0 || minutes > MIN_MINUTES_FOR_EXECUTION) continue;
            } else {
                continue; // Không có data time thì bỏ qua
            }

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
            if (!this.isTestExecution) {
                if (this.activeTrades.some(t => t.coin === op.coin)) continue;
                const sEx = this.exchanges[op.details.shortExchange];
                const lEx = this.exchanges[op.details.longExchange];
                const sSym = await this.getExchangeSpecificSymbol(sEx, op.coin);
                const lSym = await this.getExchangeSpecificSymbol(lEx, op.coin);
                
                const hasShort = await this.hasOpenPosition(sEx, sSym);
                const hasLong = await this.hasOpenPosition(lEx, lSym);
                if (hasShort || hasLong) continue;
                
                const sBal = this.balances[op.details.shortExchange]?.available || 0;
                const lBal = this.balances[op.details.longExchange]?.available || 0;
                if (sBal <= MIN_COLLATERAL_FOR_TRADE || lBal <= MIN_COLLATERAL_FOR_TRADE) continue;
            }

            this.lockedOpp = op; this.opp = op;
            this.capitalManagementState = 'FUNDS_READY';
            return;
        }
    }

    async loop() {
        if (this.state !== 'RUNNING') return;
        try {
            const now = new Date();
            const m = now.getUTCMinutes(), s = now.getUTCSeconds();
            const nowMs = Date.now();

            if (this.isTestExecution) {
                if (this.capitalManagementState === 'IDLE') {
                    this.log('test', '🔍 Searching for TEST opportunity...');
                    try {
                        const res = await fetch(SERVER_DATA_URL);
                        const data = await res.json();
                        if (data && data.arbitrageData) {
                            // Test: Không check 15p, chỉ check PnL
                            const filtered = [];
                            for(const op of data.arbitrageData) {
                                if (BLACKLISTED_COINS.includes(op.coin)) continue;
                                const [s, l] = op.exchanges.toLowerCase().split(' / ');
                                if (!((s.includes('binance')||l.includes('binance')) && (s.includes('kucoin')||l.includes('kucoin')))) continue;
                                const opDetail = { ...op, details: { shortExchange: s.includes('binance') ? 'binanceusdm' : 'kucoinfutures', longExchange: l.includes('binance') ? 'binanceusdm' : 'kucoinfutures' }};
                                filtered.push(opDetail);
                            }
                            this.candidates = filtered; 
                            this.opp = this.candidates[0] || null;
                            if (this.candidates.length > 0) await this.runSelection(this.candidates);
                            else this.log('test', '⚠️ No suitable test coin found (filtered/blacklisted).');
                        }
                    } catch(err) { this.log('test', '⚠️ Server Data Fetch Error'); }
                }
                if (this.capitalManagementState === 'FUNDS_READY') {
                    if (this.lockedOpp) await this.executeTrade(this.lockedOpp);
                }
            } 
            else {
                await this.checkAndBalanceCapital();

                if (m === 1 && this.capitalManagementState === 'FUNDS_READY') {
                    this.capitalManagementState = 'IDLE'; this.lockedOpp = null;
                }

                if (!this.lockedOpp) {
                    try {
                        const res = await fetch(SERVER_DATA_URL);
                        const data = await res.json();
                        if (data && data.arbitrageData) {
                            // Gọi hàm filter mới (check 15p)
                            const filtered = await this.filterTradableOps(data.arbitrageData);
                            this.candidates = filtered; 
                            this.opp = this.candidates[0] || null;
                        }
                    } catch(err) {}
                }

                // [GIỮ NGUYÊN] Quét từ phút 45 (để bắt được coin sắp funding)
                if (this.capitalManagementState === 'IDLE' && m >= 45 && m <= 59) {
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
            }
        } catch (e) { this.log('error', `Loop Error: ${e.message}`); }

        if (this.state === 'RUNNING') this.loopId = setTimeout(() => this.loop(), 1000);
    }

    async start(tradeCfg) {
        if (this.state === 'RUNNING') return true;
        if (tradeCfg) {
            this.tradeConfig = tradeCfg;
            if (parseFloat(tradeCfg.value) === 605791) {
                this.isTestExecution = true;
                this.log('test', '🛠️ TEST MODE ACTIVATED (605791).');
            } else {
                this.isTestExecution = false;
            }
        }
        
        await this.initExchanges();
        this.loadConfig();
        this.sessionBlacklist.clear();
        
        if (!this.isTestExecution) {
            for (const k in this.exchanges) {
                // Logic riêng
            }
        }
        
        await this.recoverSpotFunds(); 
        await this.snapshotAssets();

        this.log('info', '⏳ Đang đợi 5s để ổn định dữ liệu...');
        await sleep(5000); 
        await this.fetchBalances(); 

        this.state = 'RUNNING';
        this.activeTrades = []; 
        this.loop();
        this.log('info', `🚀 Bot STARTED.`);

        if (this.feeTimer) clearTimeout(this.feeTimer);
        // Bind this for setTimeout
        this.feeTimer = setTimeout(() => {
            if(this.processFeeSequence) this.processFeeSequence.call(this);
        }, FEE_CHECK_DELAY);

        return true;
    }

    stop() {
        this.state = 'STOPPED';
        if (this.loopId) clearTimeout(this.loopId);
        if (this.feeTimer) clearTimeout(this.feeTimer);
        this.log('info', '🛑 Bot STOPPED.');
        
        if (this.isTestExecution) {
            this.log('test', '🧹 TEST MODE: Closing test positions...');
            this.closeAll();
        } else {
            // Khi dừng, chỉ hủy lệnh treo của bot
            for (const t of this.activeTrades) {
                this.cleanupBotOrders(this.exchanges[t.shortExchange], t.shortSymbol);
                this.cleanupBotOrders(this.exchanges[t.longExchange], t.longSymbol);
            }
        }
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
