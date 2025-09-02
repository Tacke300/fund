const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const safeLog = (type, ...args) => {
    try {
        const timestamp = new Date().toLocaleTimeString('vi-VN');
        const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg).join(' ');
        console[type](`[${timestamp} ${type.toUpperCase()}]`, message);
    } catch (e) {
        process.stderr.write(`FATAL LOG ERROR: ${e.message}\n`);
    }
};

const {
    binanceApiKey, binanceApiSecret,
    bingxApiKey, bingxApiSecret,
    okxApiKey, okxApiSecret, okxPassword,
    bitgetApiKey, bitgetApiSecret, bitgetApiPassword,
    kucoinApiKey, kucoinApiSecret, kucoinApiPassword
} = require('../config.js');

const BOT_PORT = 5008;
const SERVER_DATA_URL = 'http://localhost:5005/api/data';

const MIN_PNL_PERCENTAGE = 1;
const MAX_MINUTES_UNTIL_FUNDING = 30;
const MIN_MINUTES_FOR_EXECUTION = 15;
const DATA_FETCH_INTERVAL_SECONDS = 5;

const ALL_POSSIBLE_EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget', 'kucoin'];
const DISABLED_EXCHANGES = ['bitget', 'okx'];

const activeExchangeIds = ALL_POSSIBLE_EXCHANGE_IDS.filter(id => !DISABLED_EXCHANGES.includes(id));

const exchanges = {};
activeExchangeIds.forEach(id => {
    try {
        const exchangeClass = ccxt[id];
        const config = { 'options': { 'defaultType': 'swap' }, 'enableRateLimit': true };
        if (id === 'binanceusdm') { config.apiKey = binanceApiKey; config.secret = binanceApiSecret; }
        else if (id === 'bingx') { config.apiKey = bingxApiKey; config.secret = bingxApiSecret; }
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

let botState = 'STOPPED';
let botLoopIntervalId = null;
let balances = {};
activeExchangeIds.forEach(id => { balances[id] = { available: 0 }; });
let tradeHistory = [];
let bestPotentialOpportunityForDisplay = null;
let allCurrentOpportunities = [];
let currentTradeDetails = null;
let currentPercentageToUse = 50;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchDataFromServer() {
    try {
        const response = await fetch(SERVER_DATA_URL);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return await response.json();
    } catch (error) {
        safeLog('error', `[BOT] Lỗi khi lấy dữ liệu từ server: ${error.message}`);
        return null;
    }
}

async function updateBalances() {
    safeLog('log', '[BOT] Cập nhật số dư...');
    await Promise.all(activeExchangeIds.map(async (id) => {
        try {
            const balance = await exchanges[id].fetchBalance({ 'type': 'future' });
            balances[id] = { available: balance.free?.USDT || 0 };
        } catch (e) {
            safeLog('error', `[BOT] Lỗi khi lấy số dư ${id.toUpperCase()}: ${e.message}`);
            balances[id] = { available: 0 };
        }
    }));
}

async function getExchangeSpecificSymbol(exchange, rawCoinSymbol) {
    try {
        await exchange.loadMarkets();
        const base = rawCoinSymbol.substring(0, rawCoinSymbol.length - 4);
        const quote = 'USDT';
        const attempts = [`${base}/${quote}`, `${base}/${quote}:${quote}`, `${base}-${quote}-SWAP`, rawCoinSymbol];
        for (const attempt of attempts) {
            try {
                const market = exchange.market(attempt);
                if (market && market.active) return market.id;
            } catch (e) {}
        }
        safeLog('warn', `[HELPER] Không tìm thấy symbol ${rawCoinSymbol} trên ${exchange.id}`);
        return null;
    } catch (e) {
        safeLog('error', `[HELPER] Lỗi tải markets cho ${exchange.id}: ${e.message}`);
        return null;
    }
}

async function processServerData(serverData) {
    if (!serverData || !serverData.arbitrageData) {
        allCurrentOpportunities = [];
        bestPotentialOpportunityForDisplay = null;
        return;
    }
    allCurrentOpportunities = serverData.arbitrageData
        .filter(op => op && op.details && exchanges[op.details.shortExchange] && exchanges[op.details.longExchange])
        .sort((a, b) => {
            if (a.nextFundingTime !== b.nextFundingTime) {
                return a.nextFundingTime - b.nextFundingTime;
            }
            return b.estimatedPnl - a.estimatedPnl;
        });
    bestPotentialOpportunityForDisplay = allCurrentOpportunities.length > 0 ? allCurrentOpportunities[0] : null;
}

async function setLeverage(exchange, symbol, leverage, positionSide) {
    try {
        const params = exchange.id === 'bingx' ? { 'side': positionSide.toUpperCase() } : {};
        await exchange.setLeverage(leverage, symbol, params);
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

    const shortOriginalSymbol = await getExchangeSpecificSymbol(shortEx, coin);
    const longOriginalSymbol = await getExchangeSpecificSymbol(longEx, coin);

    if (!shortOriginalSymbol || !longOriginalSymbol) {
        safeLog('error', `[BOT_TRADE] Không tìm thấy symbol hợp lệ cho ${coin}. Hủy bỏ.`);
        return false;
    }

    const minBalance = Math.min(balances[shortExchange].available, balances[longExchange].available);
    const collateral = minBalance * (percentageToUse / 100);
    if (collateral <= 1) {
        safeLog('error', `[BOT_TRADE] Vốn thế chấp (${collateral.toFixed(2)} USDT) quá nhỏ. Hủy bỏ.`);
        return false;
    }

    try {
        safeLog('log', `[BOT_TRADE] Ưu tiên 1: Thử mở lệnh cho ${coin} với đòn bẩy chung x${commonLeverage}...`);
        const setLeverageShortSuccess = await setLeverage(shortEx, shortOriginalSymbol, commonLeverage, 'SHORT');
        const setLeverageLongSuccess = await setLeverage(longEx, longOriginalSymbol, commonLeverage, 'LONG');
        if (!setLeverageShortSuccess || !setLeverageLongSuccess) throw new Error("Không thể đặt đòn bẩy chung.");

        const shortPrice = (await shortEx.fetchTicker(shortOriginalSymbol)).last;
        const longPrice = (await longEx.fetchTicker(longOriginalSymbol)).last;
        const shortAmount = shortEx.amountToPrecision(shortOriginalSymbol, (collateral * commonLeverage) / shortPrice);
        const longAmount = longEx.amountToPrecision(longOriginalSymbol, (collateral * commonLeverage) / longPrice);

        const shortOrder = await shortEx.createMarketSellOrder(shortOriginalSymbol, shortAmount);
        const longOrder = await longEx.createMarketBuyOrder(longOriginalSymbol, longAmount);

        currentTradeDetails = { ...opportunity.details, coin, status: 'OPEN', openTime: Date.now(), shortOrderId: shortOrder.id, longOrderId: longOrder.id, shortOrderAmount: shortOrder.amount, longOrderAmount: longOrder.amount, commonLeverageUsed: commonLeverage, shortOriginalSymbol, longOriginalSymbol };
        safeLog('log', `[BOT_TRADE] Mở lệnh thành công với đòn bẩy chung.`);
        return true;
    } catch (e) {
        safeLog('warn', `[BOT_TRADE] Ưu tiên 1 thất bại: ${e.message}. Chuyển sang Ưu tiên 2 (dự phòng).`);
    }

    try {
        safeLog('log', `[BOT_TRADE] Ưu tiên 2: Thử mở lệnh với vốn bằng nhau, đòn bẩy tối đa...`);
        const maxLeverageShort = (await shortEx.fetchLeverageTiers([shortOriginalSymbol]))?.[shortOriginalSymbol]?.[0]?.maxLeverage || 20;
        const maxLeverageLong = (await longEx.fetchLeverageTiers([longOriginalSymbol]))?.[longOriginalSymbol]?.[0]?.maxLeverage || 20;

        await setLeverage(shortEx, shortOriginalSymbol, maxLeverageShort, 'SHORT');
        await setLeverage(longEx, longOriginalSymbol, maxLeverageLong, 'LONG');

        const shortPrice = (await shortEx.fetchTicker(shortOriginalSymbol)).last;
        const longPrice = (await longEx.fetchTicker(longOriginalSymbol)).last;
        const shortAmount = shortEx.amountToPrecision(shortOriginalSymbol, (collateral * maxLeverageShort) / shortPrice);
        const longAmount = longEx.amountToPrecision(longOriginalSymbol, (collateral * maxLeverageLong) / longPrice);

        const shortOrder = await shortEx.createMarketSellOrder(shortOriginalSymbol, shortAmount);
        const longOrder = await longEx.createMarketBuyOrder(longOriginalSymbol, longAmount);

        currentTradeDetails = { ...opportunity.details, coin, status: 'OPEN', openTime: Date.now(), shortOrderId: shortOrder.id, longOrderId: longOrder.id, shortOrderAmount: shortOrder.amount, longOrderAmount: longOrder.amount, commonLeverageUsed: `Max(${maxLeverageShort}/${maxLeverageLong})`, shortOriginalSymbol, longOriginalSymbol };
        safeLog('log', `[BOT_TRADE] Mở lệnh thành công với chiến lược dự phòng.`);
        return true;
    } catch (e) {
        safeLog('error', `[BOT_TRADE] Cả hai ưu tiên đều thất bại: ${e.message}. Không thể mở lệnh.`);
        currentTradeDetails = null;
        return false;
    }
}

async function closeTradesAndCalculatePnL() {
    if (!currentTradeDetails || currentTradeDetails.status !== 'OPEN') return;
    safeLog('log', '[BOT_PNL] Đang đóng các vị thế...');
    const { shortExchange, longExchange, shortOriginalSymbol, longOriginalSymbol, shortOrderAmount, longOrderAmount } = currentTradeDetails;
    try {
        await exchanges[shortExchange].createMarketBuyOrder(shortOriginalSymbol, shortOrderAmount);
        await exchanges[longExchange].createMarketSellOrder(longOriginalSymbol, longOrderAmount);
        safeLog('log', '[BOT_PNL] Gửi lệnh đóng cả hai vị thế thành công.');
    } catch (e) {
        safeLog('error', `[BOT_PNL] Lỗi khi đóng vị thế: ${e.message}`);
    } finally {
        currentTradeDetails.status = 'CLOSED';
        tradeHistory.unshift({ ...currentTradeDetails, closeTime: Date.now() });
        if (tradeHistory.length > 50) tradeHistory.pop();
        currentTradeDetails = null;
    }
}

async function mainBotLoop() {
    if (botState !== 'RUNNING') return;
    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentSecond = now.getUTCSeconds();

    const serverData = await fetchDataFromServer();
    await processServerData(serverData);

    const opportunityToExecute = bestPotentialOpportunityForDisplay;
    if (currentMinute === 59 && currentSecond >= 30 && currentSecond < 35 && !currentTradeDetails) {
        if (opportunityToExecute && (opportunityToExecute.nextFundingTime - Date.now()) / 60000 < MIN_MINUTES_FOR_EXECUTION) {
            safeLog('log', `[BOT_LOOP] Kích hoạt mở lệnh cho ${opportunityToExecute.coin}.`);
            await updateBalances();
            await executeTrades(opportunityToExecute, currentPercentageToUse);
        }
    }
    
    if (currentMinute === 0 && currentSecond >= 5 && currentSecond < 10 && currentTradeDetails?.status === 'OPEN') {
        safeLog('log', '[BOT_LOOP] Kích hoạt đóng lệnh.');
        await closeTradesAndCalculatePnL();
    }
    botLoopIntervalId = setTimeout(mainBotLoop, DATA_FETCH_INTERVAL_SECONDS * 1000);
}

function startBot() {
    if (botState === 'RUNNING') return false;
    safeLog('log', '[BOT] Khởi động Bot...');
    botState = 'RUNNING';
    updateBalances().then(mainBotLoop);
    return true;
}

function stopBot() {
    if (botState !== 'RUNNING') return false;
    safeLog('log', '[BOT] Dừng Bot...');
    clearTimeout(botLoopIntervalId);
    botLoopIntervalId = null;
    botState = 'STOPPED';
    return true;
}

const botServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            res.writeHead(err ? 500 : 200, {'Content-Type': 'text/html; charset=utf-8'});
            res.end(err ? 'Lỗi đọc file' : content);
        });
    } else if (req.url === '/bot-api/status' && req.method === 'GET') {
        const statusData = { botState, balances, tradeHistory, bestPotentialOpportunityForDisplay, currentTradeDetails, activeExchangeIds };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(statusData));
    } else if (req.url === '/bot-api/start' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            currentPercentageToUse = parseFloat(JSON.parse(body).percentageToUse) || 50;
            const started = startBot();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: started }));
        });
    } else if (req.url === '/bot-api/stop' && req.method === 'POST') {
        const stopped = stopBot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: stopped }));
    } else if (req.url === '/bot-api/test-trade' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                if (!bestPotentialOpportunityForDisplay || !data.shortExchange || !data.longExchange) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, message: 'Dữ liệu không hợp lệ hoặc không có cơ hội.' }));
                }
                if (currentTradeDetails) {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, message: 'Đã có lệnh đang mở.' }));
                }
                const testOpportunity = {
                    ...bestPotentialOpportunityForDisplay,
                    details: { ...bestPotentialOpportunityForDisplay.details, shortExchange: data.shortExchange, longExchange: data.longExchange }
                };
                await updateBalances();
                const tradeSuccess = await executeTrades(testOpportunity, parseFloat(data.percentageToUse) || 50);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: tradeSuccess, message: tradeSuccess ? 'Lệnh test đã gửi.' : 'Lỗi gửi lệnh test.' }));
            } catch (e) {
                safeLog('error', `[TEST_TRADE] Lỗi: ${e.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Lỗi server.' }));
            }
        });
    } else if (req.url === '/bot-api/stop-test-trade' && req.method === 'POST') {
        await closeTradesAndCalculatePnL();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Đã gửi lệnh đóng.' }));
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

botServer.listen(BOT_PORT, () => {
    safeLog('log', `Máy chủ UI của Bot đang chạy tại http://localhost:${BOT_PORT}`);
});
