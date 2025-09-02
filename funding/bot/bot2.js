const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

// --- Cài đặt Ghi Log ---
const safeLog = (type, ...args) => {
    try {
        const timestamp = new Date().toLocaleTimeString('vi-VN');
        const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg).join(' ');
        console[type](`[${timestamp} ${type.toUpperCase()}]`, message);
    } catch (e) {
        process.stderr.write(`FATAL LOG ERROR: ${e.message}\n`);
    }
};

// --- Cấu hình API Keys (lấy từ file config.js) ---
const {
    binanceApiKey, binanceApiSecret,
    okxApiKey, okxApiSecret, okxPassword,
    bitgetApiKey, bitgetApiSecret, bitgetApiPassword,
    kucoinApiKey, kucoinApiSecret, kucoinApiPassword
} = require('../config.js');

// --- Cài đặt Bot ---
const BOT_PORT = 5008;
// Dùng localhost vì bot và server chạy chung máy
const SERVER_DATA_URL = 'http://localhost:5005/api/data'; 

// --- Cài đặt Giao dịch ---
const MIN_PNL_PERCENTAGE = 1; 
const MIN_MINUTES_FOR_EXECUTION = 915; 
const DATA_FETCH_INTERVAL_SECONDS = 5;
const MAX_CONSECUTIVE_FAILS = 3; // Số lần lỗi liên tiếp trước khi tạm vô hiệu hóa sàn

// --- Khởi tạo Sàn Giao Dịch ---
const ALL_POSSIBLE_EXCHANGE_IDS = ['binanceusdm', 'bitget', 'okx', 'kucoin'];
const DISABLED_EXCHANGES = [];

const activeExchangeIds = ALL_POSSIBLE_EXCHANGE_IDS.filter(id => !DISABLED_EXCHANGES.includes(id));

const exchanges = {};
activeExchangeIds.forEach(id => {
    try {
        const exchangeClass = ccxt[id];
        const config = { 'options': { 'defaultType': 'swap' }, 'enableRateLimit': true };
        if (id === 'binanceusdm') { config.apiKey = binanceApiKey; config.secret = binanceApiSecret; }
        else if (id === 'okx') { config.apiKey = okxApiKey; config.secret = okxApiSecret; config.password = okxPassword; }
        else if (id === 'bitget') { config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret; config.password = bitgetApiPassword; }
        else if (id === 'kucoin') { config.apiKey = kucoinApiKey; config.secret = kucoinApiSecret; config.password = kucoinApiPassword; }

        if (config.apiKey && config.secret) {
            exchanges[id] = new exchangeClass(config);
        } else {
            safeLog('warn', `[INIT] Bỏ qua ${id.toUpperCase()} do thiếu API Key/Secret.`);
        }
    } catch (e) {
        safeLog('error', `[INIT] Lỗi khi khởi tạo sàn ${id.toUpperCase()}: ${e.message}`);
    }
});

// --- Biến Trạng thái Bot ---
let botState = 'STOPPED';
let botLoopIntervalId = null;
let balances = {};
let tradeHistory = [];
let bestPotentialOpportunityForDisplay = null;
let allCurrentOpportunities = []; 
let currentTradeDetails = null;
let tradeAwaitingPnl = null;
let currentPercentageToUse = 50;

// *** LOGIC MỚI: Hệ thống theo dõi sức khỏe sàn ***
let exchangeHealth = {};
activeExchangeIds.forEach(id => {
    balances[id] = { available: 0 };
    exchangeHealth[id] = { consecutiveFails: 0, isDisabled: false };
});


function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// --- Lấy Dữ Liệu Từ Server ---
async function fetchDataFromServer() {
    try {
        const response = await fetch(SERVER_DATA_URL);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return await response.json();
    } catch (error) {
        safeLog('error', `[BOT] Lỗi khi lấy dữ liệu từ server: ${error.message}.`);
        return null;
    }
}

// --- Quản lý Số dư (Đã nâng cấp với Health Check) ---
async function updateBalances() {
    safeLog('log', '[BOT] Cập nhật số dư...');
    await Promise.all(activeExchangeIds.map(async (id) => {
        if (!exchanges[id]) return; 
        try {
            const balance = await exchanges[id].fetchBalance({ 'type': 'future' });
            balances[id] = { available: balance.free?.USDT || 0 };

            // Nếu thành công, reset bộ đếm lỗi và kích hoạt lại sàn nếu cần
            if (exchangeHealth[id].isDisabled) {
                safeLog('info', `[HEALTH] Sàn ${id.toUpperCase()} đã hoạt động trở lại.`);
                exchangeHealth[id].isDisabled = false;
            }
            exchangeHealth[id].consecutiveFails = 0;

        } catch (e) {
            balances[id] = { available: 0 };
            exchangeHealth[id].consecutiveFails++; // Tăng bộ đếm lỗi
            
            safeLog('error', `[BOT] Lỗi khi lấy số dư ${id.toUpperCase()} (lần ${exchangeHealth[id].consecutiveFails}): ${e.message}`);

            // Nếu lỗi quá nhiều lần, tạm thời vô hiệu hóa sàn
            if (exchangeHealth[id].consecutiveFails >= MAX_CONSECUTIVE_FAILS && !exchangeHealth[id].isDisabled) {
                exchangeHealth[id].isDisabled = true;
                safeLog('warn', `[HEALTH] Sàn ${id.toUpperCase()} đã bị tạm vô hiệu hóa do lỗi liên tục. Các cơ hội liên quan sẽ bị bỏ qua.`);
            }
        }
    }));
}

// --- Xử lý Dữ liệu Cơ hội (Đã nâng cấp với Health Check) ---
async function getExchangeSpecificSymbol(exchange, rawCoinSymbol) {
    try {
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) await exchange.loadMarkets();
        const base = rawCoinSymbol.substring(0, rawCoinSymbol.length - 4);
        const quote = 'USDT';
        const attempts = [`${base}/${quote}`, `${base}/${quote}:${quote}`, `${base}-${quote}-SWAP`, rawCoinSymbol];
        for (const attempt of attempts) {
            try {
                const market = exchange.market(attempt);
                if (market && market.active) return market.id;
            } catch (e) {}
        }
        return null;
    } catch (e) { return null; }
}

const normalizeExchangeId = (id) => {
    if (!id) return null;
    const lowerId = id.toLowerCase();
    return lowerId.replace('usdm', '') === 'binance' ? 'binanceusdm' : lowerId;
};

async function processServerData(serverData) {
    if (!serverData || !serverData.arbitrageData) {
        allCurrentOpportunities = [];
        bestPotentialOpportunityForDisplay = null;
        return;
    }

    allCurrentOpportunities = serverData.arbitrageData
        .map(op => {
            if (!op || !op.details || op.estimatedPnl < MIN_PNL_PERCENTAGE) return null;
            op.details.shortExchange = normalizeExchangeId(op.details.shortExchange);
            op.details.longExchange = normalizeExchangeId(op.details.longExchange);
            return op;
        })
        .filter(op => {
            if (!op) return false;
            const { shortExchange, longExchange } = op.details;
            // *** LOGIC MỚI: Lọc bỏ cơ hội liên quan đến sàn đang bị vô hiệu hóa ***
            const isShortHealthy = exchanges[shortExchange] && !exchangeHealth[shortExchange]?.isDisabled;
            const isLongHealthy = exchanges[longExchange] && !exchangeHealth[longExchange]?.isDisabled;
            return isShortHealthy && isLongHealthy;
        })
        .sort((a, b) => {
            if (a.nextFundingTime !== b.nextFundingTime) return a.nextFundingTime - b.nextFundingTime;
            return b.estimatedPnl - a.estimatedPnl;
        });

    bestPotentialOpportunityForDisplay = allCurrentOpportunities.length > 0 ? allCurrentOpportunities[0] : null;
}

// --- Logic Thực thi Giao dịch (Không thay đổi nhiều) ---
async function setLeverage(exchange, symbol, leverage) {
    try {
        await exchange.setLeverage(leverage, symbol);
        safeLog('log', `[BOT_TRADE] Đặt đòn bẩy x${leverage} cho ${symbol} trên ${exchange.id} thành công.`);
        return true;
    } catch (e) {
        safeLog('error', `[BOT_TRADE] Lỗi đặt đòn bẩy x${leverage} cho ${symbol} trên ${exchange.id}: ${e.message}`);
        return false;
    }
}

async function executeTrades(opportunity, percentageToUse) {
    const { coin, commonLeverage } = opportunity;
    const { shortExchange, longExchange } = opportunity.details;
    const shortEx = exchanges[shortExchange];
    const longEx = exchanges[longExchange];

    await updateBalances(); 
    const shortBalanceBefore = balances[shortExchange].available;
    const longBalanceBefore = balances[longExchange].available;

    const shortOriginalSymbol = await getExchangeSpecificSymbol(shortEx, coin);
    const longOriginalSymbol = await getExchangeSpecificSymbol(longEx, coin);

    if (!shortOriginalSymbol || !longOriginalSymbol) {
        safeLog('error', `[BOT_TRADE] Không tìm thấy symbol hợp lệ cho ${coin}. Hủy bỏ cơ hội này.`);
        return false; 
    }

    const minBalance = Math.min(shortBalanceBefore, longBalanceBefore);
    const collateral = minBalance * (percentageToUse / 100);
    if (collateral <= 1) { 
        safeLog('error', `[BOT_TRADE] Vốn thế chấp (${collateral.toFixed(2)} USDT) quá nhỏ. Hủy bỏ cơ hội này.`);
        return false;
    }

    try {
        if (!(await setLeverage(shortEx, shortOriginalSymbol, commonLeverage)) || !(await setLeverage(longEx, longOriginalSymbol, commonLeverage))) throw new Error(`Không thể đặt đòn bẩy chung x${commonLeverage}.`);
        const shortPrice = (await shortEx.fetchTicker(shortOriginalSymbol)).last;
        const longPrice = (await longEx.fetchTicker(longOriginalSymbol)).last;
        const shortAmount = shortEx.amountToPrecision(shortOriginalSymbol, (collateral * commonLeverage) / shortPrice);
        const longAmount = longEx.amountToPrecision(longOriginalSymbol, (collateral * commonLeverage) / longPrice);
        const shortOrder = await shortEx.createMarketSellOrder(shortOriginalSymbol, shortAmount);
        const longOrder = await longEx.createMarketBuyOrder(longOriginalSymbol, longAmount);
        
        currentTradeDetails = { ...opportunity.details, coin, status: 'OPEN', openTime: Date.now(), shortOrderAmount: shortOrder.amount, longOrderAmount: longOrder.amount, commonLeverageUsed: commonLeverage, shortOriginalSymbol, longOriginalSymbol, shortBalanceBefore, longBalanceBefore };
        safeLog('log', `[BOT_TRADE] Mở lệnh thành công cho ${coin}.`);
        return true;
    } catch (e) {
        safeLog('error', `[BOT_TRADE] Mở lệnh cho ${coin} thất bại: ${e.message}.`);
        return false;
    }
}

async function closeTrades() {
    if (!currentTradeDetails || currentTradeDetails.status !== 'OPEN') return;
    const { shortExchange, longExchange, shortOriginalSymbol, longOriginalSymbol, shortOrderAmount, longOrderAmount } = currentTradeDetails;
    try {
        await exchanges[shortExchange].createMarketBuyOrder(shortOriginalSymbol, shortOrderAmount);
        await exchanges[longExchange].createMarketSellOrder(longOriginalSymbol, longOrderAmount);
        currentTradeDetails.status = 'PENDING_PNL_CALC';
        currentTradeDetails.closeTime = Date.now();
        tradeAwaitingPnl = currentTradeDetails;
        currentTradeDetails = null;
    } catch (e) { safeLog('error', `[BOT_PNL] Lỗi khi đóng vị thế: ${e.message}`); }
}

async function calculatePnlAfterDelay(closedTrade) {
    await updateBalances();
    const shortBalanceAfter = balances[closedTrade.shortExchange].available;
    const longBalanceAfter = balances[closedTrade.longExchange].available;
    const totalPnl = (shortBalanceAfter - closedTrade.shortBalanceBefore) + (longBalanceAfter - closedTrade.longBalanceBefore);
    safeLog('log', `[BOT_PNL] TỔNG PNL PHIÊN (${closedTrade.coin}): ${totalPnl.toFixed(4)} USDT`);
    tradeHistory.unshift({ ...closedTrade, status: 'CLOSED', actualPnl: totalPnl });
    if (tradeHistory.length > 50) tradeHistory.pop();
    tradeAwaitingPnl = null;
}

// --- Vòng lặp Chính của Bot ---
async function mainBotLoop() {
    if (botState !== 'RUNNING') return;
    
    if (tradeAwaitingPnl && (Date.now() - tradeAwaitingPnl.closeTime >= 60000)) {
        await calculatePnlAfterDelay(tradeAwaitingPnl);
    }
    
    const serverData = await fetchDataFromServer();
    await processServerData(serverData); 

    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentSecond = now.getUTCSeconds();

    if (currentMinute === 59 && currentSecond >= 30 && currentSecond < 35 && !currentTradeDetails) {
        for (const opportunity of allCurrentOpportunities) {
            const minutesToFunding = (opportunity.nextFundingTime - Date.now()) / 60000;
            if (minutesToFunding < MIN_MINUTES_FOR_EXECUTION) {
                const tradeSuccess = await executeTrades(opportunity, currentPercentageToUse);
                if (tradeSuccess) break; 
            }
        }
    }
    
    if (currentMinute === 0 && currentSecond >= 5 && currentSecond < 10 && currentTradeDetails?.status === 'OPEN') {
        await closeTrades();
    }

    botLoopIntervalId = setTimeout(mainBotLoop, DATA_FETCH_INTERVAL_SECONDS * 1000);
}

// --- Các hàm điều khiển Bot ---
function startBot() {
    if (botState === 'RUNNING') return false;
    botState = 'RUNNING';
    safeLog('log', '[BOT] Khởi động Bot...');
    updateBalances().then(mainBotLoop);
    return true;
}

function stopBot() {
    if (botState !== 'RUNNING') return false;
    botState = 'STOPPED';
    clearTimeout(botLoopIntervalId);
    botLoopIntervalId = null;
    safeLog('log', '[BOT] Dừng Bot...');
    return true;
}

// --- Server HTTP cho Giao diện người dùng (UI) ---
const botServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            res.writeHead(err ? 500 : 200, {'Content-Type': 'text/html; charset=utf-8'});
            res.end(err ? 'Lỗi đọc file index.html' : content);
        });
    } else if (req.url === '/bot-api/status' && req.method === 'GET') {
        const statusData = { botState, balances, tradeHistory, bestPotentialOpportunityForDisplay, currentTradeDetails, activeExchangeIds, exchangeHealth };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(statusData));
    } else if (req.url === '/bot-api/start' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try { currentPercentageToUse = parseFloat(JSON.parse(body).percentageToUse) || 50; } catch { currentPercentageToUse = 50; }
            const started = startBot();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: started, message: 'Bot đã khởi động.' }));
        });
    } else if (req.url === '/bot-api/stop' && req.method === 'POST') {
        const stopped = stopBot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: stopped, message: 'Bot đã dừng.' }));
    } else if (req.url === '/bot-api/stop-test-trade' && req.method === 'POST') {
        req.on('end', async () => {
            await closeTrades();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Đã gửi lệnh đóng.' }));
        });
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

botServer.listen(BOT_PORT, () => {
    safeLog('log', `Máy chủ UI của Bot đang chạy tại http://localhost:${BOT_PORT}`);
});
