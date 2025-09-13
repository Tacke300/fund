const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const safeLog = (type, ...args) => {
    try {
        const timestamp = new Date().toLocaleTimeString('vi-VN');
        const message = args.map(arg => {
            if (arg instanceof Error) {
                return arg.stack || arg.message;
            }
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

// === Core Bot Logic (GIỮ NGUYÊN TỪ BẢN MỚI CỦA BẠN) ===

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
    safeLog('log', '[BALANCES] Đang cập nhật số dư cho các sàn...');
    await Promise.all(activeExchangeIds.map(async (id) => {
        if (!exchanges[id] || exchangeHealth[id].isDisabled) return;

        try {
            let balanceData;
            if (id === 'kucoin') {
                balanceData = await exchanges[id].fetchBalance();
            } else {
                balanceData = await exchanges[id].fetchBalance({ 'type': 'future' });
            }
            
            const usdtAvailable = balanceData?.free?.USDT || 0;
            const usdtTotal = balanceData?.total?.USDT || 0;
            
            balances[id] = { available: usdtAvailable, total: usdtTotal };
            safeLog('log', `[BALANCES] Số dư ${id.toUpperCase()} cập nhật: Khả dụng = ${usdtAvailable.toFixed(2)}, Tổng = ${usdtTotal.toFixed(2)}`);
            
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
                safeLog('warn', `[HEALTH] Sàn ${id.toUpperCase()} đã bị tạm vô hiệu hóa do lỗi liên tục.`);
            }
        }
    }));
    safeLog('log', '[BALANCES] Hoàn tất cập nhật số dư.');
}

async function getExchangeSpecificSymbol(exchange, rawCoinSymbol) {
    try {
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) {
            await exchange.loadMarkets(true);
        }
    } catch (e) {
        safeLog('error', `[HELPER] Lỗi tải markets cho ${exchange.id}: ${e.message}`);
        return null;
    }
    const base = rawCoinSymbol.replace(/USDT$/, '');
    const quote = 'USDT';
    const attempts = [ `${base}/${quote}:${quote}`, `${base}/${quote}`, rawCoinSymbol, `${base}USDTM`, `${base}-${quote}-SWAP` ];
    for (const attempt of attempts) {
        const market = exchange.markets[attempt];
        if (market && market.active && (market.contract || market.swap || market.future)) {
            safeLog('debug', `[SYMBOL] Tìm thấy symbol ${market.id} cho ${rawCoinSymbol} trên ${exchange.id}`);
            return market.id;
        }
    }
    safeLog('warn', `[SYMBOL] KHÔNG tìm thấy symbol hợp lệ cho ${rawCoinSymbol} trên ${exchange.id}`);
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
        safeLog('warn', '[PROCESS] Dữ liệu từ server trống hoặc không có arbitrageData.');
        return;
    }

    const opportunities = [];
    for(const op of serverData.arbitrageData){
        if (!op || !op.exchanges || typeof op.exchanges !== 'string' || op.estimatedPnl < MIN_PNL_PERCENTAGE) continue;
        const exchangeParts = op.exchanges.split(' / ');
        if (exchangeParts.length !== 2) continue;

        const shortExchange = normalizeExchangeId(exchangeParts[0]);
        const longExchange = normalizeExchangeId(exchangeParts[1]);

        const isShortHealthy = exchanges[shortExchange] && !exchangeHealth[shortExchange]?.isDisabled;
        const isLongHealthy = exchanges[longExchange] && !exchangeHealth[longExchange]?.isDisabled;

        if (isShortHealthy && isLongHealthy) {
            op.details = { shortExchange, longExchange };
            opportunities.push(op);
        }
    }

    allCurrentOpportunities = opportunities.sort((a, b) => b.estimatedPnl - a.estimatedPnl);
    bestPotentialOpportunityForDisplay = allCurrentOpportunities.length > 0 ? allCurrentOpportunities[0] : null;
}

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

    safeLog('log', `[BOT_TRADE] Chuẩn bị giao dịch ${coin} (Short: ${shortExchange.toUpperCase()}, Long: ${longExchange.toUpperCase()})...`);
    await updateBalances();
    const shortBalanceBefore = balances[shortExchange].available;
    const longBalanceBefore = balances[longExchange].available;

    const shortOriginalSymbol = await getExchangeSpecificSymbol(shortEx, coin);
    const longOriginalSymbol = await getExchangeSpecificSymbol(longEx, coin);

    if (!shortOriginalSymbol || !longOriginalSymbol) {
        safeLog('error', `[BOT_TRADE] Không tìm thấy symbol cho ${coin}. Hủy bỏ.`);
        return false;
    }

    const minBalance = Math.min(shortBalanceBefore, longBalanceBefore);
    const collateral = minBalance * (percentageToUse / 100);
    if (collateral <= 1) {
        safeLog('error', `[BOT_TRADE] Vốn thế chấp (${collateral.toFixed(2)} USDT) quá nhỏ. Hủy bỏ.`);
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
            shortBalanceBefore, longBalanceBefore, shortOrderId: shortOrder.id, longOrderId: longOrder.id
        };
        safeLog('log', `[BOT_TRADE] Mở lệnh thành công cho ${coin}.`, currentTradeDetails);
        return true;
    } catch (e) {
        safeLog('error', `[BOT_TRADE] Mở lệnh cho ${coin} thất bại: ${e.message}`);
        return false;
    }
}

async function closeTrades() {
    if (!currentTradeDetails || currentTradeDetails.status !== 'OPEN') {
        safeLog('warn', '[BOT_PNL] Không có giao dịch nào đang mở để đóng.');
        return;
    }
    safeLog('log', `[BOT_PNL] Đang đóng giao dịch cho ${currentTradeDetails.coin}...`);
    const { shortExchange, longExchange, shortOriginalSymbol, longOriginalSymbol, shortOrderAmount, longOrderAmount } = currentTradeDetails;
    try {
        await exchanges[shortExchange].createMarketBuyOrder(shortOriginalSymbol, shortOrderAmount);
        await exchanges[longExchange].createMarketSellOrder(longOriginalSymbol, longOrderAmount);
        
        currentTradeDetails.status = 'PENDING_PNL_CALC';
        currentTradeDetails.closeTime = Date.now();
        tradeAwaitingPnl = { ...currentTradeDetails };
        safeLog('log', `[BOT_PNL] Đã gửi lệnh đóng cho ${currentTradeDetails.coin}. Chờ tính PNL...`);
        currentTradeDetails = null;
    } catch (e) { 
        safeLog('error', `[BOT_PNL] Lỗi khi đóng vị thế cho ${currentTradeDetails.coin}: ${e.message}`); 
    }
}

async function calculatePnlAfterDelay(closedTrade) {
    safeLog('log', `[BOT_PNL] Đang tính PNL cho giao dịch đã đóng (${closedTrade.coin})...`);
    await updateBalances();
    const shortBalanceAfter = balances[closedTrade.shortExchange].available;
    const longBalanceAfter = balances[closedTrade.longExchange].available;

    const pnlShort = shortBalanceAfter - closedTrade.shortBalanceBefore;
    const pnlLong = longBalanceAfter - closedTrade.longBalanceBefore;
    const totalPnl = pnlShort + pnlLong;

    safeLog('log', `[BOT_PNL] KẾT QUẢ PNL PHIÊN (${closedTrade.coin}):`);
    safeLog('log', `  > Sàn SHORT ${closedTrade.shortExchange.toUpperCase()}: PNL = ${pnlShort.toFixed(4)} USDT`);
    safeLog('log', `  > Sàn LONG ${closedTrade.longExchange.toUpperCase()}: PNL = ${pnlLong.toFixed(4)} USDT`);
    safeLog('log', `  > TỔNG PNL: ${totalPnl.toFixed(4)} USDT`);

    tradeHistory.unshift({ ...closedTrade, status: 'CLOSED', actualPnl: totalPnl });
    if (tradeHistory.length > 50) tradeHistory.pop();
    tradeAwaitingPnl = null;
}

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
                safeLog('log', `[BOT_LOOP] Phát hiện cơ hội đủ điều kiện để mở: ${opportunity.coin}.`);
                const tradeSuccess = await executeTrades(opportunity, currentPercentageToUse);
                if (tradeSuccess) break;
            }
        }
    }
    
    if (currentMinute === 0 && currentSecond >= 5 && currentSecond < 10 && currentTradeDetails?.status === 'OPEN') {
        safeLog('log', `[BOT_LOOP] Phát hiện thời điểm đóng lệnh cho ${currentTradeDetails.coin}.`);
        await closeTrades();
    }

    botLoopIntervalId = setTimeout(mainBotLoop, DATA_FETCH_INTERVAL_SECONDS * 1000);
}

function startBot() {
    if (botState === 'RUNNING') return false;
    botState = 'RUNNING';
    safeLog('log', '[BOT] Khởi động Bot...');
    updateBalances().then(() => {
        mainBotLoop();
    }).catch(e => {
        safeLog('error', `[BOT] Lỗi cập nhật số dư ban đầu, không thể khởi động: ${e}`);
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
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try { currentPercentageToUse = parseFloat(JSON.parse(body).percentageToUse) || 50; } catch { currentPercentageToUse = 50; }
            const started = startBot();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: started, message: started ? 'Bot đã khởi động.' : 'Bot đã chạy.' }));
        });
    } else if (req.url === '/bot-api/stop' && req.method === 'POST') {
        const stopped = stopBot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: stopped, message: stopped ? 'Bot đã dừng.' : 'Bot không chạy.' }));
    } 
    
    else if (req.url === '/bot-api/test-trade' && req.method === 'POST') {
        // Hàm này xử lý body request, nên nó phải nằm trong callback của req.on('end')
        // Callback này có thể là async
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const data = body ? JSON.parse(body) : {};
                const testPercentageToUse = parseFloat(data.percentageToUse);

                if (isNaN(testPercentageToUse) || testPercentageToUse < 1 || testPercentageToUse > 100) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, message: 'Phần trăm vốn không hợp lệ (1-100).' }));
                }
                if (!bestPotentialOpportunityForDisplay) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, message: 'Không có cơ hội nào để test.' }));
                }
                if (currentTradeDetails) {
                    res.writeHead(409, { 'Content-Type': 'application/json' }); 
                    return res.end(JSON.stringify({ success: false, message: 'Đã có lệnh đang mở. Vui lòng đóng lệnh hiện tại trước.' }));
                }
                
                safeLog('log', `[API_TEST] Yêu cầu TEST MỞ LỆNH: ${bestPotentialOpportunityForDisplay.coin} với ${testPercentageToUse}% vốn.`);
                const tradeSuccess = await executeTrades(bestPotentialOpportunityForDisplay, testPercentageToUse);

                if (tradeSuccess) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Lệnh TEST đã được gửi thành công!' }));
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Lỗi khi gửi lệnh TEST. Kiểm tra log bot.' }));
                }
            } catch (error) {
                safeLog('error', `[API_TEST] Lỗi xử lý /bot-api/test-trade: ${error.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Lỗi server khi thực hiện lệnh test.' }));
            }
        });
    } else if (req.url === '/bot-api/stop-test-trade' && req.method === 'POST') {
        if (!currentTradeDetails || currentTradeDetails.status !== 'OPEN') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, message: 'Không có lệnh nào đang mở để dừng.' }));
        }
        
        safeLog('log', '[API_TEST] Yêu cầu DỪNG LỆNH ĐANG MỞ...');
        // Bây giờ 'await' là hợp lệ vì hàm cha đã là 'async'
        await closeTrades(); 
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Đã gửi lệnh đóng vị thế. PNL sẽ được tính sau giây lát.' }));

    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

botServer.listen(BOT_PORT, () => {
    safeLog('log', `Máy chủ UI của Bot đang chạy tại http://localhost:${BOT_PORT}`);
});
