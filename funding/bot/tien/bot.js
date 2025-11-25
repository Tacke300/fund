const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

// [IMPORT LEGACY FILES - FALLBACK]
let legacyConfig = {};
let legacyBalance = {};
try { legacyConfig = require('./config.js'); } catch(e) {}
try { legacyBalance = require('./balance.js'); } catch(e) {}

// [GLOBAL CONFIG]
const BOT_PORT = 5004;
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

function getSafeFileName(username) {
    return username.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// ============================================================
// CLASS: BOT ENGINE
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
        this.opp = null; // Live data
        this.lockedOpp = null; // [LOGIC CŨ] Cơ hội đã chốt
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

    loadConfig() {
        try {
            if (fs.existsSync(this.configFile)) {
                const saved = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
                this.config = { ...this.config, ...saved };
            } else {
                // Fallback config.js cũ
                this.config.binanceApiKey = legacyConfig.binanceApiKey || '';
                this.config.binanceApiSecret = legacyConfig.binanceApiSecret || '';
                this.config.kucoinApiKey = legacyConfig.kucoinApiKey || '';
                this.config.kucoinApiSecret = legacyConfig.kucoinApiSecret || '';
                this.config.kucoinPassword = legacyConfig.kucoinPassword || legacyConfig.kucoinApiPassword || '';
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
    }

    saveHistory(trade) {
        this.history.unshift(trade);
        if(this.history.length > 50) this.history = this.history.slice(0,50);
        fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2));
    }

    async initExchanges() {
        const cfg = this.config;
        this.exchanges = {}; 
        this.balances = {};

        if (cfg.binanceApiKey && cfg.binanceApiSecret) {
            try {
                this.exchanges['binanceusdm'] = new ccxt.binanceusdm({ apiKey: cfg.binanceApiKey, secret: cfg.binanceApiSecret, enableRateLimit:true, options: { defaultType: 'swap' } });
                this.exchanges['binance'] = new ccxt.binance({ apiKey: cfg.binanceApiKey, secret: cfg.binanceApiSecret, enableRateLimit:true });
                setTimeout(async () => {
                    try { await this.exchanges['binanceusdm'].fapiPrivatePostPositionSideDual({ 'dualSidePosition': 'true' }); } catch(e){}
                }, 1000);
            } catch (e) { this.log('error', 'Binance Init Fail'); }
        }

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

    // --- LOGIC CHỌN COIN ---
    async runSelection(candidates) {
        for (const op of candidates) {
            if (this.activeTrades.some(t => t.coin === op.coin)) continue;
            
            const sBal = this.balances[op.details.shortExchange]?.available || 0;
            const lBal = this.balances[op.details.longExchange]?.available || 0;
            
            if (sBal > MIN_COLLATERAL_FOR_TRADE && lBal > MIN_COLLATERAL_FOR_TRADE) {
                this.lockedOpp = op; // [LOGIC CŨ] Khóa cứng cơ hội này
                this.capitalManagementState = 'FUNDS_READY';
                this.log('info', `🎯 Selected ${op.coin}. Locked until execution.`);
                return;
            }
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
                shortAmount: sAmt, longAmount: lAmt, status: 'OPEN'
            };
            this.activeTrades.push(trade);
            this.capitalManagementState = 'TRADE_OPEN';
            this.lockedOpp = null;
            this.log('info', '✅ Trade Opened');
        } catch(e) {
            this.log('error', `Open Failed: ${e.message}`);
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
                this.log('info', 'Reset selection (New Hour).');
            }

            // Lấy dữ liệu server (chỉ khi chưa lock)
            if (!this.lockedOpp) {
                const res = await fetch(SERVER_DATA_URL);
                const data = await res.json();
                if (data && data.arbitrageData) {
                    const cands = data.arbitrageData.filter(op => {
                        // [BỘ LỌC CỐT LÕI] Chỉ lấy Binance và Kucoin
                        const [s, l] = op.exchanges.toLowerCase().split(' / ');
                        const isBinance = s.includes('binance') || l.includes('binance');
                        const isKucoin = s.includes('kucoin') || l.includes('kucoin');
                        
                        return isBinance && isKucoin && 
                               op.estimatedPnl >= MIN_PNL_PERCENTAGE && 
                               !BLACKLISTED_COINS.includes(op.coin);
                    }).map(op => {
                        const [s,l] = op.exchanges.toLowerCase().split(' / ');
                        // Map lại ID chuẩn
                        op.details = { 
                            shortExchange: s.includes('binance') ? 'binanceusdm' : 'kucoinfutures', 
                            longExchange: l.includes('binance') ? 'binanceusdm' : 'kucoinfutures' 
                        };
                        return op;
                    }).sort((a,b) => b.estimatedPnl - a.estimatedPnl);
                    this.opp = cands[0];
                }
            }

            // 1. Quét (Phút 55 - 59)
            if (this.capitalManagementState === 'IDLE' && m >= 55 && m <= 59) {
                if ((m !== 59 || s < 50) && (nowMs - this.lastScanTime >= 25000)) {
                    if (this.opp) { 
                        await this.runSelection([this.opp]);
                        this.lastScanTime = nowMs;
                    }
                }
            } 
            // 2. Vào lệnh (59:50)
            else if (this.capitalManagementState === 'FUNDS_READY') {
                if (m === 59 && s >= 50) {
                    if (this.lockedOpp) await this.executeTrade(this.lockedOpp);
                }
            }

        } catch (e) { }

        if (this.state === 'RUNNING') {
            this.loopId = setTimeout(() => this.loop(), 1000);
        }
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

        // REGISTER
        if (url === '/bot-api/register' && req.method === 'POST') {
            try {
                const { username, password } = JSON.parse(body);
                const safeName = getSafeFileName(username);
                const cfgPath = path.join(USER_DATA_DIR, `${safeName}_config.json`);
                
                if (fs.existsSync(cfgPath)) {
                    res.writeHead(400); res.end(JSON.stringify({ success: false, message: 'User exists' }));
                    return;
                }
                
                const newConfig = {
                    username, password,
                    binanceApiKey: '', binanceApiSecret: '', 
                    kucoinApiKey: '', kucoinApiSecret: '', kucoinPassword: ''
                };
                fs.writeFileSync(cfgPath, JSON.stringify(newConfig, null, 2));
                res.end(JSON.stringify({ success: true }));
            } catch(e) { res.writeHead(500); res.end(JSON.stringify({ success: false })); }
            return;
        }

        // LOGIN
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
                if (cfg.password === password) {
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(401); res.end(JSON.stringify({ success: false, message: 'Wrong password' }));
                }
            } catch(e) { res.writeHead(500); res.end(JSON.stringify({ success: false })); }
            return;
        }

        // PROTECTED
        const bot = getSession(req);
        if (!bot) {
            res.writeHead(401); res.end(JSON.stringify({ success: false, message: 'No Session' }));
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
            else if (url === '/bot-api/status') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                // [REQ] Trả về lockedOpp nếu có để UI đứng im
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
