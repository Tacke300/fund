const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

// [GLOBAL CONFIG]
const BOT_PORT = 5004;
const SERVER_DATA_URL = 'http://localhost:5005/api/data';
const CONFIG_FILE_PATH = path.join(__dirname, 'bot_config.json');
const HTML_FILE_PATH = path.join(__dirname, 'index.html');

// [TRADING SETTINGS]
const MIN_PNL_PERCENTAGE = 1;
const MIN_MINUTES_FOR_EXECUTION = 15; 
const DATA_FETCH_INTERVAL_SECONDS = 1; 
const MIN_COLLATERAL_FOR_TRADE = 0.05; 
const BLACKLISTED_COINS = ['GAIBUSDT', 'AIAUSDT', '42USDT'];
const SL_PERCENTAGE = 95;  
const TP_PERCENTAGE = 155; 

// [BALANCING SETTINGS]
const BALANCE_CHECK_MINUTE = 30;
const MIN_DIFF_FOR_BALANCE = 20; 

// [STATE]
let botState = 'STOPPED';
let capitalManagementState = 'IDLE';
let botLoopIntervalId = null;
let lastSelectionScanTime = 0; 
let lastBalanceCheckTime = 0; 
let balances = {};
let tradeHistory = [];
let allCurrentOpportunities = [];
let activeTrades = []; 
let selectedOpportunityForNextTrade = null;
let currentTradeConfig = { mode: 'percent', value: 50 };
let isAutoBalanceEnabled = false;

// Config object
let dynamicConfig = {
    binanceApiKey: '', binanceApiSecret: '', binanceDepositAddress: '', 
    kucoinApiKey: '', kucoinApiSecret: '', kucoinPassword: '', kucoinDepositAddress: '',
    autoBalance: false
};

const exchanges = {};
const activeExchangeIds = ['binanceusdm', 'kucoinfutures']; 

// --- LOGGER ---
const safeLog = (type, ...args) => {
    try {
        const timestamp = new Date().toLocaleTimeString('vi-VN');
        let message = args.map(arg => (arg instanceof Error) ? (arg.stack || arg.message) : (typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg)).join(' ');
        if (message.includes('<!DOCTYPE html>') || message.includes('<html>')) {
            if (type === 'error') console.warn(`[${timestamp} WARN] ⚠️ Sàn trả về lỗi HTML/404. Đã ẩn log.`);
            return;
        }
        console[type](`[${timestamp} ${type.toUpperCase()}]`, message);
    } catch (e) { process.stderr.write(`LOG ERROR: ${e.message}\n`); }
};

// --- CONFIG ---
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE_PATH)) {
            const data = fs.readFileSync(CONFIG_FILE_PATH, 'utf8');
            dynamicConfig = JSON.parse(data);
            return true;
        }
    } catch (e) { safeLog('error', 'Lỗi đọc config:', e.message); }
    return false;
}

function saveConfig(newConfig) {
    try {
        if (fs.existsSync(CONFIG_FILE_PATH)) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            fs.copyFileSync(CONFIG_FILE_PATH, path.join(__dirname, `bot_config_history_${timestamp}.json`));
        }
        dynamicConfig = { ...dynamicConfig, ...newConfig };
        fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(dynamicConfig, null, 2));
        safeLog('info', 'Đã lưu cấu hình.');
    } catch (e) { safeLog('error', 'Lỗi lưu config:', e.message); }
}

// --- EXCHANGES ---
async function initExchanges() {
    activeExchangeIds.forEach(id => { delete exchanges[id]; balances[id] = { available: 0, total: 0 }; });

    if (dynamicConfig.binanceApiKey && dynamicConfig.binanceApiSecret) {
        try {
            exchanges['binanceusdm'] = new ccxt.binanceusdm({ apiKey: dynamicConfig.binanceApiKey, secret: dynamicConfig.binanceApiSecret, enableRateLimit: true, options: { defaultType: 'swap' } });
            exchanges['binance'] = new ccxt.binance({ apiKey: dynamicConfig.binanceApiKey, secret: dynamicConfig.binanceApiSecret, enableRateLimit: true });
            setTimeout(async () => {
                try { await exchanges['binanceusdm'].fapiPrivatePostPositionSideDual({ 'dualSidePosition': 'true' }); safeLog('info', `[INIT] ✅ Binance Hedge Mode ON.`); } 
                catch (e) { if (e.message.includes("-4046") || e.message.includes("No need")) safeLog('info', `[INIT] ✅ Binance đã ở Hedge Mode.`); }
            }, 1000);
        } catch (e) { safeLog('error', `[INIT] Lỗi Binance: ${e.message}`); }
    }

    if (dynamicConfig.kucoinApiKey && dynamicConfig.kucoinApiSecret && dynamicConfig.kucoinPassword) {
        try {
            exchanges['kucoinfutures'] = new ccxt.kucoinfutures({ apiKey: dynamicConfig.kucoinApiKey, secret: dynamicConfig.kucoinApiSecret, password: dynamicConfig.kucoinPassword, enableRateLimit: true });
            exchanges['kucoin'] = new ccxt.kucoin({ apiKey: dynamicConfig.kucoinApiKey, secret: dynamicConfig.kucoinApiSecret, password: dynamicConfig.kucoinPassword, enableRateLimit: true });
            setTimeout(async () => {
                try { await exchanges['kucoinfutures'].privatePostPositionSideDual({ 'dualSidePosition': 'true' }); safeLog('info', `[INIT] ✅ KuCoin Hedge Mode ON.`); } 
                catch (e) { safeLog('info', `[INIT] ✅ KuCoin đã ở Hedge Mode.`); }
            }, 1500);
        } catch (e) { safeLog('error', `[INIT] Lỗi KuCoin: ${e.message}`); }
    }
}

// --- BALANCING ---
async function checkAndBalanceCapital() {
    if (!isAutoBalanceEnabled) return;
    const now = new Date();
    if (now.getMinutes() !== BALANCE_CHECK_MINUTE) return;
    if (Date.now() - lastBalanceCheckTime < 60000) return;
    lastBalanceCheckTime = Date.now();

    safeLog('info', '[BALANCE] ⚖️ Checking balance...');
    await fetchAllBalances();
    const bBal = balances['binanceusdm']?.total || 0;
    const kBal = balances['kucoinfutures']?.total || 0;
    const diff = Math.abs(bBal - kBal);
    const amount = diff / 2;

    if (diff > MIN_DIFF_FOR_BALANCE && amount > 5) { 
        safeLog('warn', `[BALANCE] Diff > 20$ (${diff.toFixed(2)}). Balancing...`);
        if (bBal > kBal) await executeAutoTransfer('binance', 'kucoin', amount);
        else await executeAutoTransfer('kucoin', 'binance', amount);
    }
}

async function executeAutoTransfer(from, to, amount) {
    safeLog('info', `[AUTO-TRANSFER] 🚀 ${from} -> ${to}: ${amount}$`);
    try {
        let srcEx = (from === 'binance') ? exchanges['binanceusdm'] : exchanges['kucoinfutures'];
        let spotEx = (from === 'binance') ? exchanges['binance'] : exchanges['kucoin'];
        let srcType = (from === 'binance') ? 'future' : 'future';
        let dstType = (from === 'binance') ? 'spot' : 'main';

        await srcEx.transfer('USDT', amount, srcType, dstType);
        await sleep(2000);

        let addr = (to === 'binance') ? dynamicConfig.binanceDepositAddress : dynamicConfig.kucoinDepositAddress;
        let net = (to === 'binance') ? 'APT' : 'BSC'; // Binance nhận Aptos, Kucoin nhận BEP20
        
        if (!addr) throw new Error("Missing Wallet Address");
        await spotEx.withdraw('USDT', amount, addr, undefined, { network: net });
        safeLog('info', `[AUTO-TRANSFER] Withdraw sent!`);
    } catch (e) { safeLog('error', `[AUTO-TRANSFER] Error: ${e.message}`); }
}

// --- HELPERS ---
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchDataFromServer() {
    try {
        const res = await fetch(SERVER_DATA_URL);
        if (!res.ok) throw new Error(`${res.status}`);
        return await res.json();
    } catch (e) { return null; }
}

async function fetchAllBalances() {
    for (const id of activeExchangeIds) {
        if (!exchanges[id]) { balances[id] = { available: 0, total: 0 }; continue; }
        try {
            const bal = await exchanges[id].fetchBalance({ type: 'future' }); // Kucoin future is implicit
            balances[id] = { available: bal.free.USDT || 0, total: bal.total.USDT || 0 };
        } catch (e) { balances[id] = { available: 0, total: 0 }; }
    }
}
const updateBalances = () => fetchAllBalances();

// --- TRADING CORE ---
async function getExchangeSpecificSymbol(exchange, rawCoinSymbol) {
    try {
        if (!exchange.markets) await exchange.loadMarkets(true);
        const base = String(rawCoinSymbol).toUpperCase().replace('USDT','');
        // Binance check
        if (exchange.id === 'binanceusdm') {
            const exists = Object.keys(exchange.markets).some(k => k.startsWith(base) && k.endsWith('USDT'));
            if(!exists) return null;
        }
        const attempts = [`${base}/USDT:USDT`, `${base}USDT`, `${base}USDTM`];
        for (const a of attempts) {
            if (exchange.markets[a] && exchange.markets[a].active) return exchange.markets[a].id;
        }
    } catch (e) { return null; }
    return null;
}

async function executeTrades(op) {
    const { coin, commonLeverage: lev } = op;
    safeLog('info', `[EXECUTE] 🚀 Entering ${coin}...`);
    try {
        await updateBalances();
        const sEx = exchanges[op.details.shortExchange], lEx = exchanges[op.details.longExchange];
        if(!sEx || !lEx) return false;

        const sBal = balances[op.details.shortExchange].available;
        const lBal = balances[op.details.longExchange].available;
        const minBal = Math.min(sBal, lBal);
        
        let coll = (currentTradeConfig.mode === 'fixed') ? currentTradeConfig.value : minBal * (currentTradeConfig.value / 100);
        if (coll > minBal) coll = minBal;
        if (coll < MIN_COLLATERAL_FOR_TRADE) { safeLog('warn', 'Low Balance'); return false; }

        const sSym = await getExchangeSpecificSymbol(sEx, coin);
        const lSym = await getExchangeSpecificSymbol(lEx, coin);
        if(!sSym || !lSym) return false;

        try {
            await Promise.all([
                sEx.setLeverage(lev, sSym, sEx.id==='kucoinfutures'?{marginMode:'cross'}:{}),
                lEx.setLeverage(lev, lSym, lEx.id==='kucoinfutures'?{marginMode:'cross'}:{})
            ]);
        } catch(e){}

        // Calc Amount
        const sPrice = (await sEx.fetchTicker(sSym)).last;
        const lPrice = (await lEx.fetchTicker(lSym)).last;
        const sAmt = parseFloat(sEx.amountToPrecision(sSym, (coll*lev)/sPrice));
        const lAmt = parseFloat(lEx.amountToPrecision(lSym, (coll*lev)/lPrice));

        // Orders
        const [sOrd, lOrd] = await Promise.all([
            sEx.createMarketSellOrder(sSym, sAmt, sEx.id==='binanceusdm'?{positionSide:'SHORT'}:{}),
            lEx.createMarketBuyOrder(lSym, lAmt, lEx.id==='binanceusdm'?{positionSide:'LONG'}:{})
        ]);

        activeTrades.push({
            id: Date.now(), coin, shortExchange: sEx.id, longExchange: lEx.id,
            shortSymbol: sSym, longSymbol: lSym, shortOrderId: sOrd.id, longOrderId: lOrd.id,
            entryTime: Date.now(), shortAmount: sAmt, longAmount: lAmt, 
            status: 'OPEN', estimatedPnlFromOpportunity: op.estimatedPnl
        });
        capitalManagementState = 'TRADE_OPEN';
        selectedOpportunityForNextTrade = null;
        safeLog('info', `[EXECUTE] ✅ SUCCESS!`);
        return true;
    } catch (e) { safeLog('error', `[EXECUTE] Failed: ${e.message}`); return false; }
}

async function monitorActiveTrades() {
    if (activeTrades.length === 0) return;
    // Monitor logic simplified: waiting for manual close or liquidation
    // Or advanced auto-close when both sides trigger SL/TP (implemented in previous full version)
    // Keeping it simple for stability as requested.
}

async function closeTradeNow() {
    if (activeTrades.length === 0) return false;
    safeLog('info', `[CLEANUP] 🛑 Closing all...`);
    for (const t of activeTrades) {
        const sEx = exchanges[t.shortExchange], lEx = exchanges[t.longExchange];
        try { await sEx.cancelAllOrders(t.shortSymbol); } catch {}
        try { await lEx.cancelAllOrders(t.longSymbol); } catch {}
        
        try {
            const sP = sEx.id==='binanceusdm'?{positionSide:'SHORT'}:{reduceOnly:true};
            await sEx.createMarketBuyOrder(t.shortSymbol, t.shortAmount, sP);
        } catch (e) {} // Ignore if already closed
        
        try {
            const lP = lEx.id==='binanceusdm'?{positionSide:'LONG'}:{reduceOnly:true};
            await lEx.createMarketSellOrder(t.longSymbol, t.longAmount, lP);
        } catch (e) {}

        t.status = 'CLOSED';
        t.actualPnl = 0; // Placeholder, real calc needs fetching trades
        tradeHistory.unshift(t);
    }
    activeTrades = [];
    capitalManagementState = 'IDLE';
    return true;
}

// --- LOOP ---
async function mainBotLoop() {
    if (botState !== 'RUNNING') return;
    try {
        await monitorActiveTrades();
        await checkAndBalanceCapital();

        const data = await fetchDataFromServer();
        if(data && data.arbitrageData) {
            const nowTime = Date.now();
            allCurrentOpportunities = data.arbitrageData.filter(op => {
                if(op.estimatedPnl < MIN_PNL_PERCENTAGE || BLACKLISTED_COINS.includes(op.coin)) return false;
                const [s,l] = op.exchanges.split(' / ');
                return (s.includes('binance') && l.includes('kucoin')) || (s.includes('kucoin') && l.includes('binance'));
            }).map(op => {
                const [s,l] = op.exchanges.split(' / ');
                op.details = { 
                    shortExchange: s.includes('binance')?'binanceusdm':'kucoinfutures',
                    longExchange: l.includes('binance')?'binanceusdm':'kucoinfutures'
                };
                return op;
            }).sort((a,b) => b.estimatedPnl - a.estimatedPnl);
            bestPotentialOpportunityForDisplay = allCurrentOpportunities[0];
        } else {
            bestPotentialOpportunityForDisplay = null; // No data
        }

        const now = new Date();
        const m = now.getUTCMinutes(), s = now.getUTCSeconds();
        
        // SCAN (50-59, 25s)
        if (capitalManagementState === 'IDLE' && m >= 50 && m <= 59) {
            if ((m !== 59 || s < 50) && (Date.now() - lastSelectionScanTime >= 25000)) {
                if(allCurrentOpportunities.length > 0) {
                    const op = allCurrentOpportunities[0];
                    const sEx = exchanges[op.details.shortExchange], lEx = exchanges[op.details.longExchange];
                    const sSym = await getExchangeSpecificSymbol(sEx, op.coin);
                    const lSym = await getExchangeSpecificSymbol(lEx, op.coin);
                    
                    if(sSym && lSym) {
                        const sBal = balances[op.details.shortExchange].available;
                        const lBal = balances[op.details.longExchange].available;
                        if(sBal > 0 && lBal > 0) {
                            selectedOpportunityForNextTrade = op;
                            capitalManagementState = 'FUNDS_READY';
                            safeLog('info', `[SELECTION] 🎯 ${op.coin} selected. Waiting 59:50.`);
                        }
                    }
                    lastSelectionScanTime = Date.now();
                }
            }
        }
        
        // EXECUTE
        else if (capitalManagementState === 'FUNDS_READY') {
            if (m === 59 && s >= 50) {
                if (selectedOpportunityForNextTrade) await executeTrades(selectedOpportunityForNextTrade);
            }
        }

    } catch (e) { safeLog('error', 'Loop:', e); }

    if (botState === 'RUNNING') botLoopIntervalId = setTimeout(mainBotLoop, 1000);
}

// --- SERVER ---
const botServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = req.url;

    if (url === '/' && req.method === 'GET') {
        fs.readFile(HTML_FILE_PATH, (err, content) => {
            if (err) { res.writeHead(500); res.end('No UI File'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content);
        });
        return;
    }

    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        await new Promise(r => req.on('end', r));
        
        try {
            if (url === '/bot-api/start') {
                const cfg = JSON.parse(body);
                saveConfig(cfg);
                dynamicConfig = cfg;
                isAutoBalanceEnabled = cfg.autoBalance;
                await initExchanges();
                botState = 'RUNNING';
                updateBalances().then(mainBotLoop);
                res.end(JSON.stringify({ success: true }));
            }
            else if (url === '/bot-api/stop') {
                botState = 'STOPPED';
                if (botLoopIntervalId) clearTimeout(botLoopIntervalId);
                res.end(JSON.stringify({ success: true }));
            }
            else if (url === '/bot-api/close-trade-now') {
                await closeTradeNow();
                res.end(JSON.stringify({ success: true }));
            }
        } catch(e) {
            res.writeHead(500); res.end(JSON.stringify({ success: false, message: e.message }));
        }
    } 
    else if (url === '/bot-api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            botState, capitalManagementState, balances, tradeHistory, 
            bestPotentialOpportunityForDisplay, activeTrades 
        }));
    }
    else if (url === '/bot-api/config') {
        loadConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(dynamicConfig));
    }
});

botServer.listen(BOT_PORT, () => {
    loadConfig();
    safeLog('log', `Bot UI: http://localhost:${BOT_PORT}`);
});
