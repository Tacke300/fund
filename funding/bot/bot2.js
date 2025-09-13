const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const safeLog = (type, ...args) => {
    try {
        const timestamp = new Date().toLocaleTimeString('vi-VN');
        const message = args.map(arg => {
            if (arg instanceof Error) { return arg.stack || arg.message; }
            return typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg;
        }).join(' ');
        console[type](`[${timestamp} ${type.toUpperCase()}]`, message);
    } catch (e) {
        process.stderr.write(`FATAL LOG ERROR: ${e.message}\n`);
    }
};

const {
    binanceApiKey, binanceApiSecret,
    okxApiKey, okxApiSecret, okxPassword,
    bitgetApiKey, bitgetApiSecret, bitgetApiPassword,
    kucoinApiKey, kucoinApiSecret, kucoinApiPassword
} = require('../config.js');

// === Configuration ===
const BOT_PORT = 5008;
const SERVER_DATA_URL = 'http://localhost:5005/api/data';
const MIN_PNL_PERCENTAGE = 1;
const MIN_MINUTES_FOR_EXECUTION = 15;
const DATA_FETCH_INTERVAL_SECONDS = 5;
const MAX_CONSECUTIVE_FAILS = 3;

const ALL_POSSIBLE_EXCHANGE_IDS = ['binanceusdm', 'bitget', 'okx', 'kucoin'];
const DISABLED_EXCHANGES = [];
const activeExchangeIds = ALL_POSSIBLE_EXCHANGE_IDS.filter(id => !DISABLED_EXCHANGES.includes(id));

// === Global State ===
let botState = 'STOPPED';
let botLoopIntervalId = null;
let balances = {};
let tradeHistory = [];
let bestPotentialOpportunityForDisplay = null;
let allCurrentOpportunities = [];
let currentTradeDetails = null;
let tradeAwaitingPnl = null;
let currentPercentageToUse = 50;
let exchangeHealth = {};

activeExchangeIds.forEach(id => {
    balances[id] = { available: 0, total: 0 };
    exchangeHealth[id] = { consecutiveFails: 0, isDisabled: false };
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// === Exchange Initialization ===
const exchanges = {};
activeExchangeIds.forEach(id => {
    try {
        let exchangeClass;
        let config = { 'enableRateLimit': true, 'verbose': false };

        if (id === 'binanceusdm') {
            exchangeClass = ccxt.binanceusdm;
            config.apiKey = binanceApiKey; config.secret = binanceApiSecret;
            config.options = { 'defaultType': 'swap' };
        } else if (id === 'okx') {
            exchangeClass = ccxt.okx;
            config.apiKey = okxApiKey; config.secret = okxApiSecret; config.password = okxPassword;
            config.options = { 'defaultType': 'swap' };
        } else if (id === 'bitget') {
            exchangeClass = ccxt.bitget;
            config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret; config.password = bitgetApiPassword;
            config.options = { 'defaultType': 'swap' };
        } else if (id === 'kucoin') {
            exchangeClass = ccxt.kucoinfutures;
            config.apiKey = kucoinApiKey; config.secret = kucoinApiSecret; config.password = kucoinApiPassword;
        }

        if (config.apiKey && config.secret && (id !== 'kucoin' || config.password)) {
            exchanges[id] = new exchangeClass(config);
            safeLog('log', `[INIT] Khởi tạo sàn ${id.toUpperCase()} thành công.`);
        } else {
            safeLog('warn', `[INIT] Bỏ qua ${id.toUpperCase()} do thiếu API Key/Secret/Password.`);
        }
    } catch (e) {
        safeLog('error', `[INIT] Lỗi khi khởi tạo sàn ${id.toUpperCase()}: ${e}`);
    }
});

// === Core Bot Logic ===
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
    safeLog('log', '[BALANCES] Đang cập nhật số dư...');
    await Promise.all(activeExchangeIds.map(async (id) => {
        if (!exchanges[id] || exchangeHealth[id].isDisabled) return;
        try {
            let balanceData = (id === 'kucoin') ? await exchanges[id].fetchBalance() : await exchanges[id].fetchBalance({ 'type': 'future' });
            const usdtAvailable = balanceData?.free?.USDT || 0;
            const usdtTotal = balanceData?.total?.USDT || 0;
            balances[id] = { available: usdtAvailable, total: usdtTotal };
            safeLog('log', `[BALANCES] ${id.toUpperCase()}: Khả dụng ${usdtAvailable.toFixed(2)}, Tổng ${usdtTotal.toFixed(2)}`);
            exchangeHealth[id].consecutiveFails = 0;
            if (exchangeHealth[id].isDisabled) {
                exchangeHealth[id].isDisabled = false;
                safeLog('info', `[HEALTH] Sàn ${id.toUpperCase()} đã hoạt động trở lại.`);
            }
        } catch (e) {
            balances[id] = { available: 0, total: 0 };
            exchangeHealth[id].consecutiveFails++;
            safeLog('error', `[BALANCES] Lỗi lấy số dư ${id.toUpperCase()} (lần ${exchangeHealth[id].consecutiveFails}): ${e.message}`);
            if (exchangeHealth[id].consecutiveFails >= MAX_CONSECUTIVE_FAILS && !exchangeHealth[id].isDisabled) {
                exchangeHealth[id].isDisabled = true;
                safeLog('warn', `[HEALTH] Sàn ${id.toUpperCase()} đã bị tạm vô hiệu hóa.`);
            }
        }
    }));
    safeLog('log', '[BALANCES] Hoàn tất cập nhật số dư.');
}

// *** NÂNG CẤP HÀM TÌM SYMBOL ***
async function getExchangeSpecificSymbol(exchange, rawCoinSymbol) {
    try {
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) await exchange.loadMarkets(true);
    } catch (e) {
        safeLog('error', `[SYMBOL] Lỗi tải markets cho ${exchange.id}: ${e.message}`);
        return null;
    }
    const base = String(rawCoinSymbol).toUpperCase().replace(/USDT$/, '');
    
    // Thêm nhiều định dạng hơn để thử
    const attempts = [
        `${base}/USDT:USDT`,  // Binance
        `${base}USDT.P`,      // Bybit
        `${base}USDT`,        // Dạng chung
        `${base}-USDT-SWAP`,  // OKX
        `${base}USDTM`,       // KuCoin
        `${base}PERP`,        // Một số sàn khác
        `${base}/USDT`,       // Dạng chung
    ];

    if (base === 'BTC') { // Trường hợp đặc biệt cho Bitcoin
        attempts.unshift('XBTUSDTM');
    }

    safeLog('debug', `[SYMBOL] Đang tìm ${rawCoinSymbol} trên ${exchange.id}. Thử các định dạng: ${attempts.join(', ')}`);

    for (const attempt of attempts) {
        const market = exchange.markets[attempt];
        if (market?.active && (market.contract || market.swap || market.future)) {
            safeLog('log', `[SYMBOL] ✅ Tìm thấy symbol: ${market.id} cho ${rawCoinSymbol} trên ${exchange.id}`);
            return market.id;
        }
    }

    safeLog('warn', `[SYMBOL] ❌ KHÔNG tìm thấy symbol hợp lệ cho ${rawCoinSymbol} trên ${exchange.id} sau khi thử tất cả định dạng.`);
    return null;
}


const normalizeExchangeId = (id) => {
    if (!id) return null;
    const lowerId = id.toLowerCase().trim();
    if (lowerId.includes('binance')) return 'binanceusdm';
    if (lowerId.includes('kucoin')) return 'kucoin';
    return lowerId;
};

async function processServerData(serverData) {
    if (!serverData || !serverData.arbitrageData) {
        allCurrentOpportunities = [];
        bestPotentialOpportunityForDisplay = null;
        return;
    }
    const opportunities = [];
    for (const op of serverData.arbitrageData) {
        if (!op?.exchanges || typeof op.exchanges !== 'string' || op.estimatedPnl < MIN_PNL_PERCENTAGE) continue;
        const [shortExRaw, longExRaw] = op.exchanges.split(' / ');
        if (!shortExRaw || !longExRaw) continue;

        const shortExchange = normalizeExchangeId(shortExRaw);
        const longExchange = normalizeExchangeId(longExRaw);
        if (!exchanges[shortExchange] || exchangeHealth[shortExchange]?.isDisabled || !exchanges[longExchange] || exchangeHealth[longExchange]?.isDisabled) continue;
        
        op.details = { shortExchange, longExchange };
        opportunities.push(op);
    }
    allCurrentOpportunities = opportunities.sort((a, b) => b.estimatedPnl - a.estimatedPnl);
    bestPotentialOpportunityForDisplay = allCurrentOpportunities.length > 0 ? allCurrentOpportunities[0] : null;
}

async function setLeverage(exchange, symbol, leverage) {
    try {
        await exchange.setLeverage(leverage, symbol);
        safeLog('log', `[TRADE] Đặt đòn bẩy x${leverage} cho ${symbol} trên ${exchange.id} thành công.`);
        return true;
    } catch (e) {
        safeLog('error', `[TRADE] Lỗi đặt đòn bẩy x${leverage} cho ${symbol} trên ${exchange.id}: ${e.message}`);
        return false;
    }
}

async function executeTrades(opportunity, percentageToUse) {
    const { coin, commonLeverage } = opportunity;
    const { shortExchange, longExchange } = opportunity.details;

    safeLog('log', `[TRADE] Chuẩn bị giao dịch ${coin} (Short: ${shortExchange.toUpperCase()}, Long: ${longExchange.toUpperCase()})...`);
    await updateBalances();
    
    const shortBalanceBefore = balances[shortExchange]?.available || 0;
    const longBalanceBefore = balances[longExchange]?.available || 0;
    
    const shortEx = exchanges[shortExchange];
    const longEx = exchanges[longExchange];
    const shortOriginalSymbol = await getExchangeSpecificSymbol(shortEx, coin);
    const longOriginalSymbol = await getExchangeSpecificSymbol(longEx, coin);

    if (!shortOriginalSymbol || !longOriginalSymbol) {
        safeLog('error', `[TRADE] Không tìm thấy symbol cho ${coin}. Hủy bỏ.`);
        return false;
    }

    const minBalance = Math.min(shortBalanceBefore, longBalanceBefore);
    const collateral = minBalance * (percentageToUse / 100);
    if (collateral <= 1) {
        safeLog('error', `[TRADE] Vốn thế chấp (${collateral.toFixed(2)} USDT) quá nhỏ. Hủy bỏ.`);
        return false;
    }

    try {
        if (!(await setLeverage(shortEx, shortOriginalSymbol, commonLeverage))) throw new Error(`Set leverage SHORT thất bại.`);
        if (!(await setLeverage(longEx, longOriginalSymbol, commonLeverage))) throw new Error(`Set leverage LONG thất bại.`);
        
        const shortPrice = (await shortEx.fetchTicker(shortOriginalSymbol)).last;
        const longPrice = (await longEx.fetchTicker(longOriginalSymbol)).last;
        const shortAmount = shortEx.amountToPrecision(shortOriginalSymbol, (collateral * commonLeverage) / shortPrice);
        const longAmount = longEx.amountToPrecision(longOriginalSymbol, (collateral * commonLeverage) / longPrice);

        const shortOrder = await shortEx.createMarketSellOrder(shortOriginalSymbol, shortAmount);
        const longOrder = await longEx.createMarketBuyOrder(longOriginalSymbol, longAmount);
        
        currentTradeDetails = {
            ...opportunity.details, coin, status: 'OPEN', openTime: Date.now(),
            shortOrderAmount: shortOrder.amount, longOrderAmount: longOrder.amount,
            commonLeverageUsed: commonLeverage, shortOriginalSymbol, longOriginalSymbol,
            shortBalanceBefore, longBalanceBefore
        };
        safeLog('log', `[TRADE] Mở lệnh thành công cho ${coin}.`, currentTradeDetails);
        return true;
    } catch (e) {
        safeLog('error', `[TRADE] Mở lệnh cho ${coin} thất bại: ${e.message}`);
        return false;
    }
}

async function closeTrades() {
    if (!currentTradeDetails || currentTradeDetails.status !== 'OPEN') {
        safeLog('warn', '[PNL] Không có giao dịch nào đang mở để đóng.');
        return;
    }
    const tradeToClose = { ...currentTradeDetails };
    safeLog('log', `[PNL] Đang đóng giao dịch cho ${tradeToClose.coin}...`);
    try {
        await exchanges[tradeToClose.shortExchange].createMarketBuyOrder(tradeToClose.shortOriginalSymbol, tradeToClose.shortOrderAmount);
        await exchanges[tradeToClose.longExchange].createMarketSellOrder(tradeToClose.longOriginalSymbol, tradeToClose.longOrderAmount);
        
        currentTradeDetails.status = 'PENDING_PNL_CALC';
        currentTradeDetails.closeTime = Date.now();
        tradeAwaitingPnl = { ...currentTradeDetails };
        safeLog('log', `[PNL] Đã gửi lệnh đóng cho ${tradeToClose.coin}. Chờ tính PNL...`);
        currentTradeDetails = null;
    } catch (e) { 
        safeLog('error', `[PNL] Lỗi khi đóng vị thế cho ${tradeToClose.coin}: ${e.message}`); 
    }
}

async function calculatePnlAfterDelay(closedTrade) {
    safeLog('log', `[PNL] Đang tính PNL cho giao dịch đã đóng (${closedTrade.coin})...`);
    await updateBalances();
    const shortBalanceAfter = balances[closedTrade.shortExchange].available;
    const longBalanceAfter = balances[closedTrade.longExchange].available;
    const pnlShort = shortBalanceAfter - closedTrade.shortBalanceBefore;
    const pnlLong = longBalanceAfter - closedTrade.longBalanceBefore;
    const totalPnl = pnlShort + pnlLong;

    safeLog('log', `[PNL] KẾT QUẢ PHIÊN (${closedTrade.coin}):`);
    safeLog('log', `  > ${closedTrade.shortExchange.toUpperCase()} PNL: ${pnlShort.toFixed(4)} USDT`);
    safeLog('log', `  > ${closedTrade.longExchange.toUpperCase()} PNL: ${pnlLong.toFixed(4)} USDT`);
    safeLog('log', `  > TỔNG PNL: ${totalPnl.toFixed(4)} USDT`);

    tradeHistory.unshift({ ...closedTrade, status: 'CLOSED', actualPnl: totalPnl });
    if (tradeHistory.length > 50) tradeHistory.pop();
    tradeAwaitingPnl = null;
}

async function mainBotLoop() {
    if (botState !== 'RUNNING') return;
    
    if (tradeAwaitingPnl && (Date.now() - tradeAwaitingPnl.closeTime >= 45000)) {
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
                safeLog('log', `[LOOP] Phát hiện cơ hội đủ điều kiện để mở: ${opportunity.coin}.`);
                if (await executeTrades(opportunity, currentPercentageToUse)) break;
            }
        }
    }
    
    if (currentMinute === 0 && currentSecond >= 5 && currentSecond < 10 && currentTradeDetails?.status === 'OPEN') {
        safeLog('log', `[LOOP] Phát hiện thời điểm đóng lệnh cho ${currentTradeDetails.coin}.`);
        await closeTrades();
    }

    botLoopIntervalId = setTimeout(mainBotLoop, DATA_FETCH_INTERVAL_SECONDS * 1000);
}

function startBot() {
    if (botState === 'RUNNING') return false;
    botState = 'RUNNING';
    safeLog('log', '[BOT] Khởi động Bot...');
    updateBalances().then(() => mainBotLoop()).catch(e => {
        safeLog('error', `[BOT] Lỗi cập nhật số dư ban đầu: ${e}`);
        botState = 'STOPPED';
    });
    return true;
}

function stopBot() {
    if (botState !== 'RUNNING') return false;
    botState = 'STOPPED';
    if (botLoopIntervalId) clearTimeout(botLoopIntervalId);
    safeLog('log', '[BOT] Dừng Bot...');
    return true;
}

// === HTTP Server for UI ===
// *** SỬA LỖI CÚ PHÁP: Thêm "async" vào đây ***
const botServer = http.createServer(async (req, res) => {
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
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try { currentPercentageToUse = parseFloat(JSON.parse(body).percentageToUse) || 50; } catch { currentPercentageToUse = 50; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: startBot(), message: 'Đã gửi yêu cầu khởi động bot.' }));
        });
    } else if (req.url === '/bot-api/stop' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: stopBot(), message: 'Đã gửi yêu cầu dừng bot.' }));
    } 
    
    // API DÀNH CHO TEST TÙY CHỈNH
    else if (req.url === '/bot-api/custom-test-trade' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { shortExchange, longExchange, leverage, percentage } = data;

                if (!bestPotentialOpportunityForDisplay) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, message: 'Hiện không có cơ hội nào để lấy coin test.' }));
                }
                if (currentTradeDetails) {
                    res.writeHead(409, { 'Content-Type': 'application/json' }); 
                    return res.end(JSON.stringify({ success: false, message: 'Đã có lệnh đang mở. Vui lòng đóng lệnh hiện tại trước.' }));
                }

                const testOpportunity = {
                    coin: bestPotentialOpportunityForDisplay.coin,
                    commonLeverage: parseInt(leverage, 10) || 20,
                    details: { shortExchange, longExchange }
                };
                
                safeLog('log', `[API_TEST] Yêu cầu Test Tùy Chỉnh:`, testOpportunity);
                const tradeSuccess = await executeTrades(testOpportunity, parseFloat(percentage));

                if (tradeSuccess) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Lệnh Test Tùy Chỉnh đã được gửi thành công!' }));
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Lỗi khi gửi lệnh Test Tùy Chỉnh. Kiểm tra log bot.' }));
                }
            } catch (error) {
                safeLog('error', `[API_TEST] Lỗi xử lý /custom-test-trade: ${error.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Lỗi server khi thực hiện lệnh test.' }));
            }
        });
    } 
    
    else if (req.url === '/bot-api/stop-test-trade' && req.method === 'POST') {
        if (!currentTradeDetails || currentTradeDetails.status !== 'OPEN') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, message: 'Không có lệnh nào đang mở để dừng.' }));
        }
        safeLog('log', '[API] Yêu cầu DỪNG LỆNH ĐANG MỞ...');
        await closeTrades(); 
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Đã gửi lệnh đóng vị thế. PNL sẽ được tính sau giây lát.' }));
    } 
    
    else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

botServer.listen(BOT_PORT, () => {
    safeLog('log', `Máy chủ UI của Bot đang chạy tại http://localhost:${BOT_PORT}`);
});
