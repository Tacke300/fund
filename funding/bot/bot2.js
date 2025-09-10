const http = require('http');
const fs =require('fs');
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
const SERVER_DATA_URL = 'http://localhost:5005/api/data'; 

// --- Cài đặt Giao dịch ---
const MIN_PNL_PERCENTAGE = 1; 
const MIN_MINUTES_FOR_EXECUTION = 15; 
const DATA_FETCH_INTERVAL_SECONDS = 5;
const MAX_CONSECUTIVE_FAILS = 3;

// --- Khởi tạo Sàn Giao Dịch ---
const ALL_POSSIBLE_EXCHANGE_IDS = ['binanceusdm', 'bitget', 'okx', 'kucoin'];
const DISABLED_EXCHANGES = [];

const activeExchangeIds = ALL_POSSIBLE_EXCHANGE_IDS.filter(id => !DISABLED_EXCHANGES.includes(id));

const exchanges = {};
activeExchangeIds.forEach(id => {
    try {
        const exchangeClass = ccxt[id];
        // Đặt defaultType là 'swap' cho các sàn futures/swap
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
let exchangeHealth = {};
activeExchangeIds.forEach(id => {
    balances[id] = { available: 0 };
    exchangeHealth[id] = { consecutiveFails: 0, isDisabled: false };
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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

// ======================= SỬA ĐỔI PHẦN updateBalances =======================
async function updateBalances() {
    safeLog('log', '[BOT] Cập nhật số dư...');
    await Promise.all(activeExchangeIds.map(async (id) => {
        if (!exchanges[id]) return; 
        try {
            let balance;
            if (id === 'kucoin') {
                // Với KuCoin, dựa vào 'defaultType': 'swap' đã set khi khởi tạo
                // Thử gọi fetchBalance() mà không truyền type cụ thể
                balance = await exchanges[id].fetchBalance(); 
            } else {
                // Giữ nguyên cho các sàn khác nếu chúng vẫn cần type: 'future'
                balance = await exchanges[id].fetchBalance({ 'type': 'future' });
            }
            
            balances[id] = { available: balance.free?.USDT || 0 }; // Lấy số dư USDT khả dụng
            if (exchangeHealth[id].isDisabled) {
                safeLog('info', `[HEALTH] Sàn ${id.toUpperCase()} đã hoạt động trở lại.`);
                exchangeHealth[id].isDisabled = false;
            }
            exchangeHealth[id].consecutiveFails = 0;
        } catch (e) {
            balances[id] = { available: 0 };
            exchangeHealth[id].consecutiveFails++;
            safeLog('error', `[BOT] Lỗi khi lấy số dư ${id.toUpperCase()} (lần ${exchangeHealth[id].consecutiveFails}): ${e.message}`);
            if (exchangeHealth[id].consecutiveFails >= MAX_CONSECUTIVE_FAILS && !exchangeHealth[id].isDisabled) {
                exchangeHealth[id].isDisabled = true;
                safeLog('warn', `[HEALTH] Sàn ${id.toUpperCase()} đã bị tạm vô hiệu hóa do lỗi liên tục.`);
            }
        }
    }));
}
// ======================= KẾT THÚC SỬA ĐỔI PHẦN updateBalances =======================

// ======================= SỬA ĐỔI PHẦN getExchangeSpecificSymbol =======================
async function getExchangeSpecificSymbol(exchange, rawCoinSymbol) {
    try {
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) {
            safeLog('debug', `[SYMBOL_RESOLVE] Tải lại markets cho ${exchange.id}...`);
            await exchange.loadMarkets();
        }
        
        const base = rawCoinSymbol.substring(0, rawCoinSymbol.length - 4); // VD: "OPEN" từ "OPENUSDT"
        const quote = 'USDT';

        // Các dạng symbol phổ biến trên KuCoin (Futures/Swap)
        const kucoinSpecificAttempts = [
            `${base}-${quote}M`,          // Ví dụ: OPEN-USDTM (thường thấy trên KuCoin Futures)
            `${base}-${quote}-SWAP`,      // Ví dụ: OPEN-USDT-SWAP
            `${base}/${quote}:USDT`,      // Format cho futures/swap của 1 số sàn (vd: FTX cũ)
        ];
        // Các dạng chung khác, áp dụng cho tất cả các sàn (bao gồm KuCoin nếu các dạng trên không khớp)
        const generalAttempts = [
            `${base}/${quote}`,           // Ví dụ: OPEN/USDT
            `${base}/${quote}:${quote}`,  // Ví dụ: OPEN/USDT:USDT (đôi khi cho Binance)
            rawCoinSymbol                 // Giữ nguyên rawCoinSymbol (phòng hờ)
        ];

        // Ưu tiên các định dạng KuCoin nếu sàn là KuCoin, sau đó mới đến các dạng chung
        const allAttempts = (exchange.id === 'kucoin' ? kucoinSpecificAttempts : []).concat(generalAttempts);

        for (const attempt of allAttempts) {
            try {
                const market = exchange.market(attempt);
                if (market && market.active) {
                    safeLog('log', `[SYMBOL_RESOLVE] Tìm thấy symbol ${market.id} cho ${rawCoinSymbol} trên ${exchange.id} với định dạng: ${attempt}`);
                    return market.id;
                }
            } catch (e) {
                // Bỏ qua lỗi khi thử symbol không tồn tại, chỉ log chi tiết nếu cần debug sâu
                // safeLog('debug', `[SYMBOL_RESOLVE_ATTEMPT_FAIL] Sàn ${exchange.id}, Lỗi khi thử ${attempt}: ${e.message}`);
            }
        }
        safeLog('error', `[SYMBOL_RESOLVE] KHÔNG tìm thấy symbol hợp lệ cho ${rawCoinSymbol} trên ${exchange.id} sau khi thử tất cả các phương án.`);
        return null;
    } catch (e) { 
        safeLog('error', `[SYMBOL_RESOLVE_ERROR] Lỗi tổng quát khi lấy symbol trên ${exchange.id} cho ${rawCoinSymbol}: ${e.message}`);
        return null; 
    }
}
// ======================= KẾT THÚC SỬA ĐỔI PHẦN getExchangeSpecificSymbol =======================

const normalizeExchangeId = (id) => {
    if (!id) return null;
    const lowerId = id.toLowerCase().trim(); // Thêm trim() để xóa khoảng trắng thừa
    return lowerId.replace('usdm', '') === 'binance' ? 'binanceusdm' : lowerId;
};

// =========================================================================================
// =================== ĐÂY LÀ PHẦN SỬA ĐỔI QUAN TRỌNG NHẤT ==================================
// =========================================================================================
async function processServerData(serverData) {
    if (!serverData || !serverData.arbitrageData) {
        allCurrentOpportunities = [];
        bestPotentialOpportunityForDisplay = null;
        return;
    }

    allCurrentOpportunities = serverData.arbitrageData
        .map(op => {
            // Bước 1: Kiểm tra dữ liệu thô từ server
            // Nếu không có đối tượng, hoặc không có trường 'exchanges', hoặc PNL quá thấp -> Bỏ qua
            if (!op || !op.exchanges || typeof op.exchanges !== 'string' || op.estimatedPnl < MIN_PNL_PERCENTAGE) {
                return null;
            }

            // Bước 2: "Dịch" dữ liệu từ server sang định dạng bot cần
            // Tách chuỗi "shortEx / longEx" thành một mảng, ví dụ: ["bitget", "binance"]
            const exchangeParts = op.exchanges.split(' / ');
            if (exchangeParts.length !== 2) {
                // Nếu định dạng không phải là "A / B", đây là dữ liệu lỗi -> Bỏ qua
                safeLog('warn', `[PROCESS] Dữ liệu cơ hội không đúng định dạng: ${op.exchanges}`);
                return null; 
            }

            // Bước 3: TỰ TẠO RA TRƯỜNG "details" mà bot cần
            // Gán short/long exchange dựa trên kết quả đã tách
            op.details = {
                shortExchange: normalizeExchangeId(exchangeParts[0]),
                longExchange: normalizeExchangeId(exchangeParts[1])
            };

            // Bước 4: Trả về đối tượng 'op' đã được "dịch" và hoàn thiện
            // Giờ đây, 'op' đã có trường 'op.details' và sẵn sàng cho các bước lọc tiếp theo
            return op;
        })
        .filter(op => {
            // Bước lọc này bây giờ sẽ hoạt động vì 'op' và 'op.details' đã tồn tại
            if (!op) return false;
            const { shortExchange, longExchange } = op.details;
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
// =========================================================================================
// ============================ KẾT THÚC PHẦN SỬA ĐỔI =======================================
// =========================================================================================


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
