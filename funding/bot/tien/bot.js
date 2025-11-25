const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

// [IMPORT VÍ ADMIN]
let adminWallets = {};
try {
    const balanceModule = require('./balance.js');
    if (balanceModule && balanceModule.usdtDepositAddressesByNetwork) {
        adminWallets = balanceModule.usdtDepositAddressesByNetwork;
    }
} catch (e) {
    console.log("[WARN] Không tìm thấy file balance.js. Chức năng thu phí sẽ lỗi!");
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
const FUND_ARRIVAL_TOLERANCE = 2; 
const BALANCE_CHECK_MINUTE = 30; // Phút quét auto balance
const MIN_DIFF_FOR_BALANCE = 20; // Chênh lệch > 20$ mới cân bằng

// [FEE CONFIG]
const FEE_AUTO_ON = 10;
const FEE_AUTO_OFF = 5;
const FEE_VIP_MONTHLY = 200;
const MIN_BAL_REQ_BINANCE = 15;
const MIN_BAL_REQ_KUCOIN = 10;

// [TP/SL CONFIG]
const SL_PERCENTAGE = 95;  
const TP_PERCENTAGE = 135; 

function getSafeFileName(username) {
    return username.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// ============================================================
// CLASS: BOT ENGINE (V2 FINAL)
// ============================================================
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
            vipStatus: 'none', // none, vip, vip_pro
            vipExpiry: 0,
            lastFeePaidDate: ''
        };
        
        this.exchanges = {};
        this.loadConfig();
        this.loadHistory();
    }

    // --- LOGGING ---
    log(type, msg) {
        if (!['error', 'trade', 'result', 'fee', 'vip', 'transfer'].includes(type)) return;
        const t = new Date().toLocaleTimeString('vi-VN', { hour12: false });
        const prefix = `[${t}] [USER: ${this.username}]`;
        if (type === 'error') console.error(`${prefix} ❌ ${msg}`);
        else if (type === 'trade') console.log(`${prefix} 🚀 ${msg}`);
        else if (type === 'result') console.log(`${prefix} 💰 ${msg}`);
        else if (type === 'fee') console.log(`${prefix} 💸 ${msg}`);
        else if (type === 'vip') console.log(`${prefix} 👑 ${msg}`);
        else if (type === 'transfer') console.log(`${prefix} 🏦 ${msg}`);
    }

    // --- CONFIG & HISTORY ---
    loadConfig() { try { if (fs.existsSync(this.configFile)) this.config = { ...this.config, ...JSON.parse(fs.readFileSync(this.configFile, 'utf8')) }; } catch (e) {} }
    saveConfig(newConfig = {}) { for (let k in newConfig) if (newConfig[k] !== undefined) this.config[k] = newConfig[k]; fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2)); }
    loadHistory() { try { if (fs.existsSync(this.historyFile)) this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8')); } catch(e) {} }
    saveHistory(trade) { this.history.unshift(trade); if(this.history.length > 50) this.history = this.history.slice(0,50); fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2)); }

    // --- WALLET HELPERS ---
    
    // 1. Lấy ví ADMIN để nhận phí (Chéo sàn)
    getAdminFeeWallet(sourceExchangeId) {
        if (!adminWallets) return null;
        // Nếu lấy từ Binance User -> Chuyển về Kucoin Admin (BEP20)
        if (sourceExchangeId === 'binanceusdm') {
            return { address: adminWallets['kucoin']?.['BEP20'], network: 'BSC' };
        } 
        // Nếu lấy từ Kucoin User -> Chuyển về Binance Admin (APT)
        else {
            return { address: adminWallets['binance']?.['APT'], network: 'APT' };
        }
    }

    // 2. Lấy ví USER để Auto Balance / Manual Transfer
    getUserDepositAddress(targetExchangeId) {
        // Ưu tiên config của user
        if (targetExchangeId === 'binanceusdm' && this.config.binanceDepositAddress) return { address: this.config.binanceDepositAddress, network: 'APT' };
        if (targetExchangeId === 'kucoinfutures' && this.config.kucoinDepositAddress) return { address: this.config.kucoinDepositAddress, network: 'BEP20' };
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

    async fetchBalances() {
        for (const id of ['binanceusdm', 'kucoinfutures']) {
            if (!this.exchanges[id]) { this.balances[id] = { available: 0, total: 0 }; continue; }
            try {
                const bal = await this.exchanges[id].fetchBalance({ type: 'future' });
                this.balances[id] = { available: bal.free.USDT || 0, total: bal.total.USDT || 0 };
            } catch (e) { this.balances[id] = { available: 0, total: 0 }; }
        }
    }

    // --- CORE TRANSFER FUNCTION (Dùng chung cho Fee, Auto, Manual) ---
    async performWithdrawal(sourceId, amount, targetInfo) {
        const sourceEx = this.exchanges[sourceId];
        // Sàn Spot dùng để rút tiền
        const wEx = sourceId === 'binanceusdm' ? this.exchanges['binance'] : this.exchanges['kucoin']; 

        if (!sourceEx || !wEx || !targetInfo || !targetInfo.address) return false;

        try {
            // 1. Chuyển từ Future -> Spot/Main
            // Binance: future -> spot
            // Kucoin: future -> main
            let fromType = 'future';
            let toType = sourceId === 'binanceusdm' ? 'spot' : 'main';
            
            await sourceEx.transfer('USDT', amount, fromType, toType);
            await new Promise(r => setTimeout(r, 3000));

            // 2. Thực hiện lệnh rút
            // targetInfo chứa { address, network }
            // Lưu ý: Kucoin cần tham số 'chain' cho một số mạng, Binance dùng 'network'
            // Code V1 map logic này
            let params = {};
            if (sourceId === 'binanceusdm') params = { network: targetInfo.network }; 
            else params = { network: targetInfo.network }; // Kucoin ccxt handle tốt params network

            await wEx.withdraw('USDT', amount, targetInfo.address, undefined, params);
            return true;
        } catch (e) {
            this.log('error', `Withdraw Error (${sourceId}): ${e.message}`);
            return false;
        }
    }

    // --- FEE LOGIC (THU PHÍ) ---
    async collectDailyFee() {
        // VIP PRO: Free
        if (this.config.vipStatus === 'vip_pro') return true;
        // VIP: Check expiry
        if (this.config.vipStatus === 'vip') {
            if (Date.now() < this.config.vipExpiry) return true;
            this.config.vipStatus = 'none';
            this.saveConfig();
        }

        const todayUTC = new Date().toISOString().split('T')[0];
        if (this.config.lastFeePaidDate === todayUTC) return true;

        const fee = this.config.autoBalance ? FEE_AUTO_ON : FEE_AUTO_OFF;
        this.log('fee', `Collecting daily fee: ${fee}$ (${todayUTC})`);

        await this.fetchBalances();
        const bBal = this.balances['binanceusdm']?.available || 0;
        const kBal = this.balances['kucoinfutures']?.available || 0;

        if (bBal < MIN_BAL_REQ_BINANCE && kBal < MIN_BAL_REQ_KUCOIN) {
            this.log('error', `Low Balance for Fee. Stopping Bot.`);
            this.stop();
            return false;
        }

        // Ưu tiên trừ Kucoin (Chuyển về Admin Binance)
        if (kBal >= fee) {
            const adminTarget = this.getAdminFeeWallet('kucoinfutures'); // Ví Binance APT của Admin
            if (await this.performWithdrawal('kucoinfutures', fee, adminTarget)) {
                this.config.lastFeePaidDate = todayUTC; this.saveConfig();
                this.log('fee', `Paid ${fee}$ from Kucoin -> Admin Binance.`);
                return true;
            }
        }
        
        // Trừ Binance (Chuyển về Admin Kucoin)
        if (bBal >= fee) {
            const adminTarget = this.getAdminFeeWallet('binanceusdm'); // Ví Kucoin BEP20 của Admin
            if (await this.performWithdrawal('binanceusdm', fee, adminTarget)) {
                this.config.lastFeePaidDate = todayUTC; this.saveConfig();
                this.log('fee', `Paid ${fee}$ from Binance -> Admin Kucoin.`);
                return true;
            }
        }

        this.log('error', `Fee collection failed.`);
        this.stop();
        return false;
    }

    // --- VIP UPGRADE ---
    async upgradeToVip() {
        this.log('vip', 'Processing VIP Upgrade ($200)...');
        await this.fetchBalances();
        const bBal = this.balances['binanceusdm']?.available || 0;
        const kBal = this.balances['kucoinfutures']?.available || 0;
        const cost = FEE_VIP_MONTHLY;
        let success = false;

        // Logic lấy tiền: 1 hoặc cả 2 sàn
        // Target của Admin luôn là chéo sàn
        const adminBinanceTarget = this.getAdminFeeWallet('kucoinfutures'); 
        const adminKucoinTarget = this.getAdminFeeWallet('binanceusdm');

        if (kBal >= cost) {
            success = await this.performWithdrawal('kucoinfutures', cost, adminBinanceTarget);
        } else if (bBal >= cost) {
            success = await this.performWithdrawal('binanceusdm', cost, adminKucoinTarget);
        } else if (bBal + kBal >= cost) {
            const takeK = kBal - 1; 
            const takeB = cost - takeK;
            if (takeK > 0 && takeB > 0) {
                const s1 = await this.performWithdrawal('kucoinfutures', takeK, adminBinanceTarget);
                const s2 = await this.performWithdrawal('binanceusdm', takeB, adminKucoinTarget);
                success = s1 && s2;
            }
        }

        if (success) {
            this.config.vipStatus = 'vip';
            this.config.vipExpiry = Date.now() + (30 * 24 * 60 * 60 * 1000);
            this.saveConfig();
            return true;
        }
        return false;
    }

    // --- AUTO BALANCE & MANUAL TRANSFER (User to User) ---
    // Logic: Chuyển tiền vào ví do người dùng cài đặt trong config
    async userFundTransfer(fromId, toId, amount) {
        const targetInfo = this.getUserDepositAddress(toId);
        if (!targetInfo) {
            this.log('error', `Missing User Deposit Address for ${toId}`);
            return false;
        }
        this.log('transfer', `Sending ${amount}$ from ${fromId} -> ${toId} (User Wallet)...`);
        
        // Thực hiện rút
        const sent = await this.performWithdrawal(fromId, amount, targetInfo);
        
        if (sent) {
            // Monitor tiền về (Logic V1)
            this.monitorArrival(toId, fromId, amount);
            return true;
        }
        return false;
    }

    async monitorArrival(toId, fromId, amount) {
        // Kucoin check 'main', Binance check 'spot'
        // Nếu thấy tiền -> Chuyển vào Future
        const checkerEx = this.exchanges[toId==='kucoinfutures'?'kucoin':'binance'];
        const transfererEx = this.exchanges[toId];
        
        for(let i=0; i<30; i++) {
            await new Promise(r=>setTimeout(r, 20000)); // Check mỗi 20s
            try {
                const bal = await checkerEx.fetchBalance();
                const spotBal = bal.free.USDT || 0;
                if (spotBal >= amount - FUND_ARRIVAL_TOLERANCE) {
                    await transfererEx.transfer('USDT', spotBal, toId==='binanceusdm'?'spot':'main', 'future');
                    this.log('transfer', `✅ Funds arrived & moved to Future (${toId})`);
                    await this.fetchBalances();
                    return;
                }
            } catch(e){}
        }
    }

    async checkAndBalanceCapital() {
        if (!this.config.autoBalance) return;
        
        // Điều kiện: Chênh lệch > 20$
        const now = new Date();
        // Chỉ chạy phút 30 hoặc khi không có lệnh
        if (this.activeTrades.length > 0) return; 
        if (Date.now() - this.lastBalCheckTime < 60000) return;
        this.lastBalCheckTime = Date.now();

        await this.fetchBalances();
        const b = this.balances['binanceusdm']?.total || 0;
        const k = this.balances['kucoinfutures']?.total || 0;
        const diff = Math.abs(b - k);
        const amount = diff / 2;

        if (diff > MIN_DIFF_FOR_BALANCE && amount > 5) {
            if (b > k) await this.userFundTransfer('binanceusdm', 'kucoinfutures', amount);
            else await this.userFundTransfer('kucoinfutures', 'binanceusdm', amount);
        }
    }

    // --- TRADING LOGIC ---
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
        if(!sSym || !lSym) { this.log('error', `Exec Fail: ${op.coin} symbol missing`); return; }

        const sBal = this.balances[op.details.shortExchange].available;
        const lBal = this.balances[op.details.longExchange].available;
        const minBal = Math.min(sBal, lBal);
        
        let coll = (this.tradeConfig.mode === 'fixed') ? this.tradeConfig.value : minBal * (this.tradeConfig.value / 100);
        if (coll > minBal) coll = minBal;
        if (coll < MIN_COLLATERAL_FOR_TRADE) { this.log('error', `Exec Fail: Low Balance (${coll.toFixed(1)}$)`); return; }

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
            this.log('trade', `OPEN | Coin: ${op.coin} | Money: ${coll.toFixed(1)}$ (x${lev}) | Est PnL: ${op.estimatedPnl}%`);
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

    // --- MAIN LOOP ---
    async loop() {
        if (this.state !== 'RUNNING') return;
        try {
            const now = new Date();
            const m = now.getUTCMinutes(), s = now.getUTCSeconds();
            const nowMs = Date.now();

            // 1. Fee Check
            const feeOk = await this.collectDailyFee();
            if (!feeOk) return;

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

            // Auto Balance (Check every 30m if idle)
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
        if (this.state === 'RUNNING') return;
        if (tradeCfg) this.tradeConfig = tradeCfg;
        
        await this.initExchanges();
        
        // Trừ phí ngay khi Start
        const feeOk = await this.collectDailyFee();
        if (!feeOk) return;

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
                fs.writeFileSync(p, JSON.stringify({username, password, email, vipStatus: 'none'}, null, 2));
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
            if (url === '/bot-api/start') {
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
            // API nâng cấp VIP
            else if (url === '/bot-api/upgrade-vip') {
                const success = await bot.upgradeToVip();
                res.end(JSON.stringify({ success: success }));
            }
            // API chuyển tiền thủ công (User Manual Transfer)
            else if (url === '/bot-api/transfer-funds') {
                const { fromExchangeId, toExchangeId, amount } = JSON.parse(body);
                const success = await bot.userFundTransfer(fromExchangeId, toExchangeId, parseFloat(amount));
                res.end(JSON.stringify({ success: success }));
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
                    activeTrades: bot.activeTrades,
                    vipStatus: bot.config.vipStatus,
                    vipExpiry: bot.config.vipExpiry
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
            else { res.writeHead(404); res.end(); }
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({success:false, message:e.message})); }
    }
});

server.listen(BOT_PORT, () => { console.log(`Bot Server running on port ${BOT_PORT}`); });
