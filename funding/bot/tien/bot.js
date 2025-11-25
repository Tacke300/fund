const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

// [GLOBAL CONFIG]
const BOT_PORT = 5004;
const SERVER_DATA_URL = 'http://localhost:5005/api/data';
const CONFIG_FILE_PATH = path.join(__dirname, 'bot_config.json');
const HTML_FILE_PATH = path.join(__dirname, 'index.html');

// [DEFAULT SETTINGS]
const MIN_PNL_PERCENTAGE = 1;
const MIN_MINUTES_FOR_EXECUTION = 15; 
const DATA_FETCH_INTERVAL_SECONDS = 1; 
const MIN_COLLATERAL_FOR_TRADE = 0.05; 
const BLACKLISTED_COINS = ['GAIBUSDT', 'AIAUSDT', '42USDT'];
const SL_PERCENTAGE = 95;  
const TP_PERCENTAGE = 155; 

// [CONSTANTS FOR BALANCING]
const BALANCE_CHECK_MINUTE = 30;
const MIN_DIFF_FOR_BALANCE = 20; // Chênh lệch > 20$ mới cân bằng

// [STATE VARIABLES]
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

// Dynamic Config
let dynamicConfig = {
    binanceApiKey: '', binanceApiSecret: '', binanceDepositAddress: '', 
    kucoinApiKey: '', kucoinApiSecret: '', kucoinPassword: '', kucoinDepositAddress: '' 
};

// Exchange Instances
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

// --- CONFIG MANAGEMENT ---
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE_PATH)) {
            const data = fs.readFileSync(CONFIG_FILE_PATH, 'utf8');
            dynamicConfig = JSON.parse(data);
            return true;
        }
    } catch (e) { safeLog('error', 'Lỗi đọc file config:', e); }
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
        safeLog('info', 'Đã lưu cấu hình mới và backup cấu hình cũ.');
    } catch (e) { safeLog('error', 'Lỗi lưu file config:', e); }
}

// --- INITIALIZE EXCHANGES ---
async function initExchanges() {
    activeExchangeIds.forEach(id => {
        delete exchanges[id];
        balances[id] = { available: 0, total: 0 };
    });

    if (dynamicConfig.binanceApiKey && dynamicConfig.binanceApiSecret) {
        try {
            exchanges['binanceusdm'] = new ccxt.binanceusdm({
                apiKey: dynamicConfig.binanceApiKey,
                secret: dynamicConfig.binanceApiSecret,
                enableRateLimit: true,
                options: { defaultType: 'swap' }
            });
            exchanges['binance'] = new ccxt.binance({
                apiKey: dynamicConfig.binanceApiKey,
                secret: dynamicConfig.binanceApiSecret,
                enableRateLimit: true
            });
            
            setTimeout(async () => {
                try {
                    await exchanges['binanceusdm'].fapiPrivatePostPositionSideDual({ 'dualSidePosition': 'true' });
                    safeLog('info', `[INIT] ✅ Binance: Hedge Mode ON.`);
                } catch (e) {
                    if (e.message.includes("-4046") || e.message.includes("No need")) safeLog('info', `[INIT] ✅ Binance đã ở Hedge Mode.`);
                    else safeLog('warn', `[INIT] Binance Hedge Mode Check: ${e.message}`);
                }
            }, 1000);
        } catch (e) { safeLog('error', `[INIT] Lỗi tạo instance Binance: ${e.message}`); }
    }

    if (dynamicConfig.kucoinApiKey && dynamicConfig.kucoinApiSecret && dynamicConfig.kucoinPassword) {
        try {
            exchanges['kucoinfutures'] = new ccxt.kucoinfutures({
                apiKey: dynamicConfig.kucoinApiKey,
                secret: dynamicConfig.kucoinApiSecret,
                password: dynamicConfig.kucoinPassword,
                enableRateLimit: true
            });
             exchanges['kucoin'] = new ccxt.kucoin({
                apiKey: dynamicConfig.kucoinApiKey,
                secret: dynamicConfig.kucoinApiSecret,
                password: dynamicConfig.kucoinPassword,
                enableRateLimit: true
            });

            setTimeout(async () => {
                try {
                    await exchanges['kucoinfutures'].privatePostPositionSideDual({ 'dualSidePosition': 'true' });
                    safeLog('info', `[INIT] ✅ KuCoin: Hedge Mode ON.`);
                } catch (e) { safeLog('info', `[INIT] ✅ KuCoin đã ở Hedge Mode.`); }
            }, 1500);
        } catch (e) { safeLog('error', `[INIT] Lỗi tạo instance KuCoin: ${e.message}`); }
    }
}

// --- BALANCING LOGIC ---
async function checkAndBalanceCapital() {
    if (!isAutoBalanceEnabled) return;
    
    const now = new Date();
    if (now.getMinutes() !== BALANCE_CHECK_MINUTE) return;
    
    if (Date.now() - lastBalanceCheckTime < 60000) return;
    lastBalanceCheckTime = Date.now();

    safeLog('info', '[BALANCE] ⚖️ Đang kiểm tra cân bằng vốn...');

    await fetchAllBalances();
    const binanceBal = balances['binanceusdm']?.total || 0;
    const kucoinBal = balances['kucoinfutures']?.total || 0;
    const diff = Math.abs(binanceBal - kucoinBal);
    const transferAmount = diff / 2;

    safeLog('info', `[BALANCE] Binance: ${binanceBal.toFixed(2)}$, KuCoin: ${kucoinBal.toFixed(2)}$. Chênh lệch: ${diff.toFixed(2)}$.`);

    if (diff > MIN_DIFF_FOR_BALANCE && transferAmount > 5) { 
        safeLog('warn', `[BALANCE] ⚠️ Chênh lệch > 20$. Tiến hành điều chuyển ${transferAmount.toFixed(2)}$...`);
        if (binanceBal > kucoinBal) {
            await executeAutoTransfer('binance', 'kucoin', transferAmount);
        } else {
            await executeAutoTransfer('kucoin', 'binance', transferAmount);
        }
    } else {
        safeLog('info', '[BALANCE] ✅ Vốn cân bằng.');
    }
}

async function executeAutoTransfer(fromExName, toExName, amount) {
    safeLog('info', `[AUTO-TRANSFER] 🚀 Chuyển ${amount}$ từ ${fromExName} sang ${toExName}.`);
    try {
        let sourceEx, spotEx;
        if (fromExName === 'binance') {
            sourceEx = exchanges['binanceusdm'];
            spotEx = exchanges['binance'];
            await sourceEx.transfer('USDT', amount, 'future', 'spot');
        } else {
            sourceEx = exchanges['kucoinfutures'];
            spotEx = exchanges['kucoin'];
            await sourceEx.transfer('USDT', amount, 'future', 'main');
        }
        safeLog('info', `[AUTO-TRANSFER] 1/2: Đã chuyển về Spot.`);
        await sleep(2000);

        let address = '', network = '';
        if (toExName === 'binance') {
            address = dynamicConfig.binanceDepositAddress;
            if (!address) throw new Error("Chưa cấu hình ví Binance Aptos");
        } else {
            address = dynamicConfig.kucoinDepositAddress;
            if (!address) throw new Error("Chưa cấu hình ví KuCoin BEP20");
        }

        if (toExName === 'kucoin') { 
            await spotEx.withdraw('USDT', amount, address, undefined, { network: 'BSC' });
        } else {
            await spotEx.withdraw('USDT', amount, address, undefined, { network: 'APT' });
        }
        safeLog('info', `[AUTO-TRANSFER] 2/2: Đã gửi lệnh rút on-chain!`);
    } catch (e) {
        safeLog('error', `[AUTO-TRANSFER] Lỗi: ${e.message}`);
    }
}

// --- HELPER FUNCTIONS ---
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchDataFromServer() {
    try {
        const response = await fetch(SERVER_DATA_URL);
        if (!response.ok) throw new Error(`${response.status}`);
        return await response.json();
    } catch (error) { return null; }
}

async function fetchAllBalances(type = 'future') {
    const allBalances = {};
    for (const id of activeExchangeIds) {
        if (!exchanges[id]) { allBalances[id] = 0; continue; }
        try {
            const balanceData = (id === 'kucoinfutures') ? await exchanges[id].fetchBalance() : await exchanges[id].fetchBalance({ 'type': type });
            const freeBalance = balanceData?.free?.USDT || 0;
            const totalBalance = balanceData?.total?.USDT || 0;
            allBalances[id] = freeBalance;
            balances[id] = { available: freeBalance, total: totalBalance };
        } catch (e) {
            safeLog('warn', `[BALANCE] Lỗi lấy số dư ${id}: ${e.message}`);
            allBalances[id] = 0;
        }
    }
    return allBalances;
}
const updateBalances = () => fetchAllBalances('future');

async function getExchangeSpecificSymbol(exchange, rawCoinSymbol) {
    try {
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) await exchange.loadMarkets(true);
    } catch (e) { return null; }
    
    const base = String(rawCoinSymbol).toUpperCase();
    if (exchange.id === 'binanceusdm') {
        const simpleCheck = Object.keys(exchange.markets).some(k => k.replace('/','').replace(':USDT','') === base.replace('USDT',''));
        if (!simpleCheck) return null;
    }

    const cleanBase = base.replace(/USDT$/, '');
    const attempts = [`${cleanBase}/USDT:USDT`, `${cleanBase}USDT`, `${cleanBase}-USDT-SWAP`, `${cleanBase}USDTM`, `${cleanBase}/USDT`];
    for (const attempt of attempts) {
        const market = exchange.markets[attempt];
        if (market?.active && (market.contract || market.swap || market.future)) { return market.id; }
    }
    return null;
}

async function setLeverageSafely(exchange, symbol, desiredLeverage) {
    const params = (exchange.id === 'kucoinfutures') ? { 'marginMode': 'cross' } : {};
    try {
        await exchange.setLeverage(desiredLeverage, symbol, params);
        return desiredLeverage;
    } catch (e) { return null; }
}

async function computeOrderDetails(exchange, symbol, targetNotionalUSDT, leverage, availableBalance) {
    await exchange.loadMarkets();
    const market = exchange.market(symbol);
    const ticker = await exchange.fetchTicker(symbol);
    const price = ticker?.last || ticker?.close;
    if (!price) throw new Error(`No price for ${symbol}`);
    const contractSize = market.contractSize ?? 1;
    let amount = parseFloat(exchange.amountToPrecision(symbol, targetNotionalUSDT / (price * contractSize)));
    if (exchange.id === 'kucoinfutures' && market.precision.amount === 0) amount = Math.round(amount);
    if (amount <= (market.limits.amount.min || 0)) throw new Error(`Amount too small`);
    return { amount, price, notional: amount * price * contractSize };
}

async function executeTrades(opportunity) {
    const { coin, commonLeverage: desiredLeverage } = opportunity;
    const { shortExchange, longExchange } = opportunity.details;
    safeLog('info', `[EXECUTE] 🚀 Starting trade for ${coin}...`);

    try {
        await updateBalances();
        const shortEx = exchanges[shortExchange], longEx = exchanges[longExchange];
        if (!shortEx || !longEx) return false;

        const shortBalance = balances[shortExchange]?.available || 0;
        const longBalance = balances[longExchange]?.available || 0;
        const minBalance = Math.min(shortBalance, longBalance);
        
        let collateral = (currentTradeConfig.mode === 'fixed') ? currentTradeConfig.value : minBalance * (currentTradeConfig.value / 100);
        if (collateral > minBalance) collateral = minBalance;
        if (collateral < MIN_COLLATERAL_FOR_TRADE) { safeLog('warn', `Insufficient funds: ${collateral}`); return false; }

        const shortSymbol = await getExchangeSpecificSymbol(shortEx, coin);
        const longSymbol = await getExchangeSpecificSymbol(longEx, coin);
        if (!shortSymbol || !longSymbol) return false;

        const [l1, l2] = await Promise.all([ setLeverageSafely(shortEx, shortSymbol, desiredLeverage), setLeverageSafely(longEx, longSymbol, desiredLeverage) ]);
        if (!l1 || !l2) return false;
        const leverageToUse = Math.min(l1, l2);

        let shortDetails, longDetails;
        try {
            const targetNotional = collateral * leverageToUse;
            [shortDetails, longDetails] = await Promise.all([
                computeOrderDetails(shortEx, shortSymbol, targetNotional, leverageToUse, shortBalance),
                computeOrderDetails(longEx, longSymbol, targetNotional, leverageToUse, longBalance)
            ]);
        } catch (e) { safeLog('error', `Calc error: ${e.message}`); return false; }

        const shortParams = (shortEx.id === 'binanceusdm') ? { 'positionSide': 'SHORT' } : (shortEx.id === 'kucoinfutures' ? {'marginMode':'cross'} : {});
        const longParams = (longEx.id === 'binanceusdm') ? { 'positionSide': 'LONG' } : (longEx.id === 'kucoinfutures' ? {'marginMode':'cross'} : {});

        const [shortOrder, longOrder] = await Promise.all([
            shortEx.createMarketSellOrder(shortSymbol, shortDetails.amount, shortParams),
            longEx.createMarketBuyOrder(longSymbol, longDetails.amount, longParams)
        ]);

        const trade = {
            id: Date.now(), coin, shortExchange, longExchange, shortSymbol, longSymbol,
            shortOrderId: shortOrder.id, longOrderId: longOrder.id,
            entryTime: Date.now(), shortAmount: shortDetails.amount, longAmount: longDetails.amount,
            collateralUsed: collateral, status: 'OPEN', isManual: false
        };
        activeTrades.push(trade);
        capitalManagementState = 'TRADE_OPEN'; 
        selectedOpportunityForNextTrade = null;
        safeLog('info', `[EXECUTE] ✅ Open Success! Active Trades: ${activeTrades.length}`);
        return true;

    } catch (e) { safeLog('error', `[EXECUTE] Failed: ${e.message}`); return false; }
}

async function monitorActiveTrades() {
    if (activeTrades.length === 0) return;
    for (let i = activeTrades.length - 1; i >= 0; i--) {
        const trade = activeTrades[i];
        const shortEx = exchanges[trade.shortExchange];
        const longEx = exchanges[trade.longExchange];
        if (typeof trade.isShortFinished === 'undefined') trade.isShortFinished = false;
        if (typeof trade.isLongFinished === 'undefined') trade.isLongFinished = false;

        try {
            // Simplified Monitor Logic: Just check open orders or positions manually via Close Button
            // No automatic TP/SL for now as requested "Manual/Test" style
        } catch (e) {}
    }
}

async function closeTradeNow() {
    if (activeTrades.length === 0) return false;
    safeLog('info', `[CLEANUP] 🛑 Closing ${activeTrades.length} trades...`);
    for (const trade of activeTrades) {
        const shortEx = exchanges[trade.shortExchange];
        const longEx = exchanges[trade.longExchange];
        
        try { await shortEx.cancelAllOrders(trade.shortSymbol); } catch {}
        try { await longEx.cancelAllOrders(trade.longSymbol); } catch {}

        const closeShortParams = (shortEx.id === 'binanceusdm') ? { 'positionSide': 'SHORT' } : {'reduceOnly': true, ...(shortEx.id === 'kucoinfutures' && {'marginMode': 'cross'})};
        const closeLongParams = (longEx.id === 'binanceusdm') ? { 'positionSide': 'LONG' } : {'reduceOnly': true, ...(longEx.id === 'kucoinfutures' && {'marginMode': 'cross'})};

        if (!trade.isShortFinished) {
            try { await shortEx.createMarketBuyOrder(trade.shortSymbol, trade.shortAmount, closeShortParams); trade.isShortFinished = true; } 
            catch (e) { if (e.message.includes('No open') || e.message.includes('300009')) trade.isShortFinished = true; }
        }
        if (!trade.isLongFinished) {
            try { await longEx.createMarketSellOrder(trade.longSymbol, trade.longAmount, closeLongParams); trade.isLongFinished = true; } 
            catch (e) { if (e.message.includes('No open') || e.message.includes('300009')) trade.isLongFinished = true; }
        }
        trade.status = 'CLOSED';
        tradeHistory.unshift(trade);
    }
    activeTrades = [];
    capitalManagementState = 'IDLE';
    return true;
}

// --- MAIN LOOP ---
async function mainBotLoop() {
    if (botState !== 'RUNNING') return;

    try {
        await monitorActiveTrades();
        await checkAndBalanceCapital(); 

        const serverData = await fetchDataFromServer();
        if(serverData && serverData.arbitrageData) {
             const opportunities = serverData.arbitrageData.filter(op => {
                if (!op?.exchanges || typeof op.exchanges !== 'string' || op.estimatedPnl < MIN_PNL_PERCENTAGE) return false;
                if (BLACKLISTED_COINS.includes(op.coin)) return false;
                const [s, l] = op.exchanges.split(' / ');
                if ((s.includes('binance') && l.includes('kucoin')) || (s.includes('kucoin') && l.includes('binance'))) return true;
                return false;
            }).map(op => {
                const [s, l] = op.exchanges.split(' / ');
                op.details = { shortExchange: s.includes('binance')?'binanceusdm':'kucoinfutures', longExchange: l.includes('binance')?'binanceusdm':'kucoinfutures' };
                return op;
            });
            allCurrentOpportunities = opportunities.sort((a,b) => b.estimatedPnl - a.estimatedPnl);
            bestPotentialOpportunityForDisplay = allCurrentOpportunities[0];
        }

        const now = new Date();
        const currentMinute = now.getUTCMinutes();
        const currentSecond = now.getUTCSeconds();
        
        // SCAN (50-59, 25s)
        if (capitalManagementState === 'IDLE' && currentMinute >= 50 && currentMinute <= 59) {
            const nowTime = Date.now();
            if ((currentMinute !== 59 || currentSecond < 50) && (nowTime - lastSelectionScanTime >= 25000)) {
                if(allCurrentOpportunities.length > 0) {
                    const op = allCurrentOpportunities[0];
                     const sEx = exchanges[op.details.shortExchange], lEx = exchanges[op.details.longExchange];
                     const sSym = await getExchangeSpecificSymbol(sEx, op.coin);
                     const lSym = await getExchangeSpecificSymbol(lEx, op.coin);
                     
                     if(sSym && lSym) {
                         const sBal = balances[op.details.shortExchange]?.available || 0;
                         const lBal = balances[op.details.longExchange]?.available || 0;
                         if(sBal > 0 && lBal > 0) {
                             selectedOpportunityForNextTrade = op;
                             capitalManagementState = 'FUNDS_READY';
                             safeLog('info', `[SELECTION] 🎯 Selected ${op.coin}. Waiting for 59:50.`);
                         }
                     }
                     lastSelectionScanTime = nowTime;
                }
            }
        }
        
        // EXECUTE (59:50)
        else if (capitalManagementState === 'FUNDS_READY') {
            if (currentMinute === 59 && currentSecond >= 50) {
                if (selectedOpportunityForNextTrade) {
                    await executeTrades(selectedOpportunityForNextTrade);
                }
            }
        }

    } catch (e) { safeLog('error', 'Loop Error:', e); }

    if (botState === 'RUNNING') botLoopIntervalId = setTimeout(mainBotLoop, 1000);
}

// --- SERVER ---
const botServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url;
    
    // SERVE HTML
    if (url === '/' && req.method === 'GET') {
        fs.readFile(HTML_FILE_PATH, (err, content) => {
            if (err) { res.writeHead(500); res.end('Error loading UI'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content);
        });
        return;
    }

    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        await new Promise(r => req.on('end', r));

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
        else if (url === '/bot-api/custom-test-trade') {
            const data = JSON.parse(body);
            if(bestPotentialOpportunityForDisplay) {
                currentTradeConfig = { mode: 'percent', value: parseFloat(data.percentage) };
                const opp = { ...bestPotentialOpportunityForDisplay, commonLeverage: parseInt(data.leverage) };
                executeTrades(opp);
                res.end(JSON.stringify({ success: true }));
            } else {
                res.end(JSON.stringify({ success: false, message: 'No opportunity found' }));
            }
        }
    } 
    else if (url === '/bot-api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            botState, capitalManagementState, balances, tradeHistory, 
            bestPotentialOpportunityForDisplay, activeTrades, 
            exchangeHealth
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
    safeLog('log', `Bot UI Server: http://localhost:${BOT_PORT}`);
});
