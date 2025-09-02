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
const SERVER_DATA_URL = 'http://34.87.86.74:5005/api/data'; 

// --- Cài đặt Giao dịch ---
const MIN_PNL_PERCENTAGE = 1; 
const MIN_MINUTES_FOR_EXECUTION = 15; 
const DATA_FETCH_INTERVAL_SECONDS = 5;

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
activeExchangeIds.forEach(id => { balances[id] = { available: 0 }; });
let tradeHistory = [];
let bestPotentialOpportunityForDisplay = null;
let allCurrentOpportunities = []; 
let currentTradeDetails = null;
let tradeAwaitingPnl = null;
let currentPercentageToUse = 50;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// --- Lấy Dữ Liệu Từ Server ---
async function fetchDataFromServer() {
    try {
        const response = await fetch(SERVER_DATA_URL);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return await response.json();
    } catch (error) {
        safeLog('error', `[BOT] Lỗi khi lấy dữ liệu từ server: ${error.message}. Kiểm tra lại SERVER_DATA_URL và kết nối mạng.`);
        return null;
    }
}

// --- Quản lý Số dư ---
async function updateBalances() {
    safeLog('log', '[BOT] Cập nhật số dư...');
    await Promise.all(activeExchangeIds.map(async (id) => {
        if (!exchanges[id]) return; 
        try {
            const balance = await exchanges[id].fetchBalance({ 'type': 'future' });
            balances[id] = { available: balance.free?.USDT || 0 };
        } catch (e) {
            if (e.message.includes('400100')) {
                safeLog('error', `[BOT] Lỗi Lấy Số Dư ${id.toUpperCase()}: Lỗi 400100 - API KEY KHÔNG CÓ QUYỀN GIAO DỊCH HỢP ĐỒNG (FUTURES). Vui lòng kiểm tra trang web của KuCoin, vào phần quản lý API và đảm bảo API Key đã được cấp quyền "Giao dịch Hợp đồng".`);
            } else {
                safeLog('error', `[BOT] Lỗi khi lấy số dư ${id.toUpperCase()}: ${e.message}`);
            }
            balances[id] = { available: 0 };
        }
    }));
}

// --- Xử lý Dữ liệu Cơ hội ---
async function getExchangeSpecificSymbol(exchange, rawCoinSymbol) {
    try {
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) {
            await exchange.loadMarkets();
        }
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

const normalizeExchangeId = (id) => {
    if (!id) return null;
    const lowerId = id.toLowerCase();
    if (lowerId.replace('usdm', '') === 'binance') {
        return 'binanceusdm';
    }
    return lowerId;
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
            return exchanges[shortExchange] && exchanges[longExchange];
        })
        .sort((a, b) => {
            if (a.nextFundingTime !== b.nextFundingTime) {
                return a.nextFundingTime - b.nextFundingTime;
            }
            return b.estimatedPnl - a.estimatedPnl;
        });

    bestPotentialOpportunityForDisplay = allCurrentOpportunities.length > 0 ? allCurrentOpportunities[0] : null;
}

// --- Logic Thực thi Giao dịch ---
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
        safeLog('error', `[BOT_TRADE] Không tìm thấy symbol hợp lệ cho ${coin} trên ${shortExchange} hoặc ${longExchange}. Hủy bỏ cơ hội này.`);
        return false; 
    }

    const minBalance = Math.min(shortBalanceBefore, longBalanceBefore);
    const collateral = minBalance * (percentageToUse / 100);
    if (collateral <= 1) { 
        safeLog('error', `[BOT_TRADE] Vốn thế chấp (${collateral.toFixed(2)} USDT) quá nhỏ cho sàn ${shortExchange} hoặc ${longExchange}. Hủy bỏ cơ hội này.`);
        return false;
    }

    try {
        safeLog('log', `[BOT_TRADE] Ưu tiên 1: Thử mở lệnh cho ${coin} với đòn bẩy chung x${commonLeverage}...`);
        if (!(await setLeverage(shortEx, shortOriginalSymbol, commonLeverage)) || !(await setLeverage(longEx, longOriginalSymbol, commonLeverage))) {
            throw new Error(`Không thể đặt đòn bẩy chung x${commonLeverage}.`);
        }
        const shortPrice = (await shortEx.fetchTicker(shortOriginalSymbol)).last;
        const longPrice = (await longEx.fetchTicker(longOriginalSymbol)).last;
        const shortAmount = shortEx.amountToPrecision(shortOriginalSymbol, (collateral * commonLeverage) / shortPrice);
        const longAmount = longEx.amountToPrecision(longOriginalSymbol, (collateral * commonLeverage) / longPrice);
        
        safeLog('info', `[BOT_TRADE] Chuẩn bị Short ${shortAmount} ${coin} trên ${shortExchange} và Long ${longAmount} ${coin} trên ${longExchange}`);
        const shortOrder = await shortEx.createMarketSellOrder(shortOriginalSymbol, shortAmount);
        const longOrder = await longEx.createMarketBuyOrder(longOriginalSymbol, longAmount);
        
        currentTradeDetails = { ...opportunity.details, coin, status: 'OPEN', openTime: Date.now(), shortOrderAmount: shortOrder.amount, longOrderAmount: longOrder.amount, commonLeverageUsed: commonLeverage, shortOriginalSymbol, longOriginalSymbol, shortBalanceBefore, longBalanceBefore };
        safeLog('log', `[BOT_TRADE] Mở lệnh thành công với đòn bẩy chung.`);
        return true;
    } catch (e) {
        safeLog('warn', `[BOT_TRADE] Ưu tiên 1 thất bại: ${e.message}. Chuyển sang Ưu tiên 2.`);
    }

    try {
        safeLog('log', `[BOT_TRADE] Ưu tiên 2: Thử mở lệnh với vốn bằng nhau, đòn bẩy tối đa...`);
        const maxLeverageShort = (await shortEx.fetchLeverageTiers([shortOriginalSymbol]))?.[shortOriginalSymbol]?.[0]?.maxLeverage || 20;
        const maxLeverageLong = (await longEx.fetchLeverageTiers([longOriginalSymbol]))?.[longOriginalSymbol]?.[0]?.maxLeverage || 20;
        await setLeverage(shortEx, shortOriginalSymbol, maxLeverageShort);
        await setLeverage(longEx, longOriginalSymbol, maxLeverageLong);
        
        const shortPrice = (await shortEx.fetchTicker(shortOriginalSymbol)).last;
        const longPrice = (await longEx.fetchTicker(longOriginalSymbol)).last;
        const shortAmount = shortEx.amountToPrecision(shortOriginalSymbol, (collateral * maxLeverageShort) / shortPrice);
        const longAmount = longEx.amountToPrecision(longOriginalSymbol, (collateral * maxLeverageLong) / longPrice);

        safeLog('info', `[BOT_TRADE] Chuẩn bị Short (Max Lev) ${shortAmount} ${coin} trên ${shortExchange} và Long (Max Lev) ${longAmount} ${coin} trên ${longExchange}`);
        const shortOrder = await shortEx.createMarketSellOrder(shortOriginalSymbol, shortAmount);
        const longOrder = await longEx.createMarketBuyOrder(longOriginalSymbol, longAmount);
        
        currentTradeDetails = { ...opportunity.details, coin, status: 'OPEN', openTime: Date.now(), shortOrderAmount: shortOrder.amount, longOrderAmount: longOrder.amount, commonLeverageUsed: `Max(${maxLeverageShort}/${maxLeverageLong})`, shortOriginalSymbol, longOriginalSymbol, shortBalanceBefore, longBalanceBefore };
        safeLog('log', `[BOT_TRADE] Mở lệnh thành công với chiến lược dự phòng.`);
        return true;
    } catch (e) {
        safeLog('error', `[BOT_TRADE] Cả hai ưu tiên đều thất bại: ${e.message}. Không thể mở lệnh cho cơ hội này.`);
        currentTradeDetails = null;
        return false;
    }
}

async function closeTrades() {
    if (!currentTradeDetails || currentTradeDetails.status !== 'OPEN') return;
    safeLog('log', '[BOT_PNL] Đang đóng các vị thế...');
    const { shortExchange, longExchange, shortOriginalSymbol, longOriginalSymbol, shortOrderAmount, longOrderAmount } = currentTradeDetails;
    try {
        await exchanges[shortExchange].createMarketBuyOrder(shortOriginalSymbol, shortOrderAmount);
        await exchanges[longExchange].createMarketSellOrder(longOriginalSymbol, longOrderAmount);
        safeLog('log', '[BOT_PNL] Gửi lệnh đóng thành công. Chờ 1 phút để tính PNL.');
        currentTradeDetails.status = 'PENDING_PNL_CALC';
        currentTradeDetails.closeTime = Date.now();
        tradeAwaitingPnl = currentTradeDetails;
        currentTradeDetails = null;
    } catch (e) {
        safeLog('error', `[BOT_PNL] Lỗi khi đóng vị thế: ${e.message}`);
    }
}

async function calculatePnlAfterDelay(closedTrade) {
    safeLog('log', `[BOT_PNL] Bắt đầu tính PNL cho giao dịch ${closedTrade.coin}...`);
    await updateBalances();
    const shortBalanceAfter = balances[closedTrade.shortExchange].available;
    const longBalanceAfter = balances[closedTrade.longExchange].available;

    const shortPnl = shortBalanceAfter - closedTrade.shortBalanceBefore;
    const longPnl = longBalanceAfter - closedTrade.longBalanceBefore;
    const totalPnl = shortPnl + longPnl;

    safeLog('log', `[BOT_PNL] PNL Sàn Short (${closedTrade.shortExchange}): ${shortPnl.toFixed(4)} USDT (Trước: ${closedTrade.shortBalanceBefore.toFixed(4)}, Sau: ${shortBalanceAfter.toFixed(4)})`);
    safeLog('log', `[BOT_PNL] PNL Sàn Long (${closedTrade.longExchange}): ${longPnl.toFixed(4)} USDT (Trước: ${closedTrade.longBalanceBefore.toFixed(4)}, Sau: ${longBalanceAfter.toFixed(4)})`);
    safeLog('log', `[BOT_PNL] TỔNG PNL PHIÊN: ${totalPnl.toFixed(4)} USDT`);
    
    tradeHistory.unshift({ ...closedTrade, status: 'CLOSED', actualPnl: totalPnl });
    if (tradeHistory.length > 50) tradeHistory.pop();
    tradeAwaitingPnl = null;
}

// --- Vòng lặp Chính của Bot ---
async function mainBotLoop() {
    if (botState !== 'RUNNING') return;
    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentSecond = now.getUTCSeconds();

    if (tradeAwaitingPnl && (Date.now() - tradeAwaitingPnl.closeTime >= 60000)) {
        await calculatePnlAfterDelay(tradeAwaitingPnl);
    }
    
    const serverData = await fetchDataFromServer();
    await processServerData(serverData); 

    if (currentMinute === 59 && currentSecond >= 30 && currentSecond < 35 && !currentTradeDetails) {
        safeLog('log', `[BOT_LOOP] Cửa sổ thời gian thực thi mở. Bắt đầu duyệt ${allCurrentOpportunities.length} cơ hội tiềm năng...`);
        
        for (const opportunity of allCurrentOpportunities) {
            const minutesToFunding = (opportunity.nextFundingTime - Date.now()) / 60000;
            if (minutesToFunding < MIN_MINUTES_FOR_EXECUTION) {
                safeLog('log', `[BOT_LOOP] Đang thử cơ hội #${allCurrentOpportunities.indexOf(opportunity) + 1}: ${opportunity.coin} (${opportunity.details.shortExchange}/${opportunity.details.longExchange})`);

                const tradeSuccess = await executeTrades(opportunity, currentPercentageToUse);

                if (tradeSuccess) {
                    safeLog('log', `[BOT_LOOP] Mở lệnh THÀNH CÔNG cho ${opportunity.coin}. Dừng tìm kiếm trong phiên này.`);
                    break; 
                } else {
                    safeLog('warn', `[BOT_LOOP] Mở lệnh cho ${opportunity.coin} THẤT BẠI. Thử cơ hội tiếp theo (nếu có)...`);
                }
            } else {
                safeLog('info', `[BOT_LOOP] Bỏ qua cơ hội ${opportunity.coin} do thời gian funding còn ${minutesToFunding.toFixed(1)} phút (yêu cầu < ${MIN_MINUTES_FOR_EXECUTION} phút).`);
            }
        }
    }
    
    if (currentMinute === 0 && currentSecond >= 5 && currentSecond < 10 && currentTradeDetails?.status === 'OPEN') {
        safeLog('log', '[BOT_LOOP] Cửa sổ thời gian đóng lệnh kích hoạt.');
        await closeTrades();
    }

    botLoopIntervalId = setTimeout(mainBotLoop, DATA_FETCH_INTERVAL_SECONDS * 1000);
}

// --- Các hàm điều khiển Bot ---
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

// --- Server HTTP cho Giao diện người dùng (UI) ---
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
            res.end(err ? 'Lỗi đọc file index.html' : content);
        });
    } else if (req.url === '/bot-api/status' && req.method === 'GET') {
        const statusData = { botState, balances, tradeHistory, bestPotentialOpportunityForDisplay, currentTradeDetails, activeExchangeIds };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(statusData));
    } else if (req.url === '/bot-api/start' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                currentPercentageToUse = parseFloat(JSON.parse(body).percentageToUse) || 50;
            } catch {
                currentPercentageToUse = 50;
            }
            const started = startBot();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: started, message: 'Bot đã khởi động.' }));
        });
    } else if (req.url === '/bot-api/stop' && req.method === 'POST') {
        const stopped = stopBot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: stopped, message: 'Bot đã dừng.' }));
    } else if (req.url === '/bot-api/test-trade' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const percentageToUse = parseFloat(data.percentageToUse) || 50;
                
                if (!bestPotentialOpportunityForDisplay) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, message: 'Không có cơ hội khả dụng để test.' }));
                }
                if (currentTradeDetails) {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, message: 'Đã có lệnh đang mở, không thể test.' }));
                }

                const testOpportunity = { ...bestPotentialOpportunityForDisplay };
                if (data.shortExchange && data.longExchange) {
                     testOpportunity.details = { ...bestPotentialOpportunityForDisplay.details, shortExchange: data.shortExchange, longExchange: data.longExchange };
                }

                safeLog('log', `[TEST_TRADE] Bắt đầu thực hiện test trade cho ${testOpportunity.coin}`);
                const tradeSuccess = await executeTrades(testOpportunity, percentageToUse);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: tradeSuccess, message: tradeSuccess ? 'Lệnh test đã gửi.' : 'Lỗi gửi lệnh test.' }));
            } catch (e) {
                safeLog('error', `[TEST_TRADE] Lỗi nghiêm trọng: ${e.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Lỗi server khi thực hiện test trade.' }));
            }
        });
    } else if (req.url === '/bot-api/stop-test-trade' && req.method === 'POST') {
        // *** SỬA LỖI SYNTAXERROR TẠI ĐÂY ***
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
