const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

// === Helper Functions (Hàm hỗ trợ) ===

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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// === Configuration (Cấu hình) ===

const {
    binanceApiKey, binanceApiSecret,
    okxApiKey, okxApiSecret, okxPassword,
    bitgetApiKey, bitgetApiSecret, bitgetApiPassword,
    kucoinApiKey, kucoinApiSecret, kucoinApiPassword
} = require('../config.js');

const BOT_PORT = 5008;
const SERVER_DATA_URL = 'http://localhost:5005/api/data';

const MIN_PNL_PERCENTAGE = 1;
const MAX_MINUTES_UNTIL_FUNDING = 30;
const MIN_MINUTES_FOR_EXECUTION = 15;
// *** LỖI 1 ĐÃ SỬA: Thêm lại hằng số bị thiếu ***
const DATA_FETCH_INTERVAL_SECONDS = 5;

const ALL_POSSIBLE_EXCHANGE_IDS = ['binanceusdm', 'bitget', 'okx', 'kucoin'];
const DISABLED_EXCHANGES = [];

const activeExchangeIds = ALL_POSSIBLE_EXCHANGE_IDS.filter(id => !DISABLED_EXCHANGES.includes(id));

// === Global State (Trạng thái toàn cục) ===

let botState = 'STOPPED';
let botLoopIntervalId = null;
let currentPercentageToUse = 50;

let balances = {};
let tradeHistory = [];
let bestPotentialOpportunityForDisplay = null;
let allCurrentOpportunities = [];
let currentTradeDetails = null;
let currentSelectedOpportunityForExecution = null;

const LAST_ACTION_TIMESTAMP = {
    selectionTime: 0,
    tradeExecution: 0,
    closeTrade: 0,
};

// === Exchange Initialization (Khởi tạo Sàn) ===

const exchanges = {};
activeExchangeIds.forEach(id => {
    try {
        let exchangeClass;
        let config = {
            'enableRateLimit': true,
            'verbose': false,
            'headers': { 'User-Agent': 'Mozilla/5.0 (compatible; ccxt/1.0;)' }
        };

        if (id === 'binanceusdm') {
            exchangeClass = ccxt.binanceusdm;
            config.apiKey = binanceApiKey;
            config.secret = binanceApiSecret;
            config.options = { 'defaultType': 'swap' };
        } else if (id === 'okx') {
            exchangeClass = ccxt.okx;
            config.apiKey = okxApiKey;
            config.secret = okxApiSecret;
            config.password = okxPassword;
            config.options = { 'defaultType': 'swap' };
        } else if (id === 'bitget') {
            exchangeClass = ccxt.bitget;
            config.apiKey = bitgetApiKey;
            config.secret = bitgetApiSecret;
            config.password = bitgetApiPassword;
            config.options = { 'defaultType': 'swap' };
        } else if (id === 'kucoin') {
            exchangeClass = ccxt.kucoinfutures;
            config.apiKey = kucoinApiKey;
            config.secret = kucoinApiSecret;
            config.password = kucoinApiPassword;
        }

        const hasCreds = config.apiKey && config.secret;
        const needsPassword = id === 'kucoin';

        if (hasCreds && (!needsPassword || config.password)) {
            exchanges[id] = new exchangeClass(config);
            safeLog('log', `[INIT] Khởi tạo sàn ${id.toUpperCase()} thành công.`);
        } else {
            safeLog('warn', `[INIT] Bỏ qua ${id.toUpperCase()} do thiếu API Key/Secret/Password. Vui lòng kiểm tra config.js`);
        }
    } catch (e) {
        safeLog('error', `[INIT] Lỗi khi khởi tạo sàn ${id.toUpperCase()}: ${e}`);
    }
});

activeExchangeIds.forEach(id => {
    balances[id] = { available: 0, total: 0 };
});

// === Core Bot Logic (Logic chính của Bot) ===

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
        if (!exchanges[id]) return;
        try {
            let balanceData;
            // *** LỖI 2 ĐÃ SỬA: Xử lý riêng cho KuCoin ***
            if (id === 'kucoin') {
                // KuCoin Futures KHÔNG cần/không chấp nhận tham số 'type'
                balanceData = await exchanges[id].fetchBalance();
            } else {
                // Các sàn khác vẫn dùng như cũ
                balanceData = await exchanges[id].fetchBalance({ 'type': 'future' });
            }
            const usdtAvailable = balanceData?.free?.USDT || 0;
            const usdtTotal = balanceData?.total?.USDT || 0;
            balances[id] = { available: usdtAvailable, total: usdtTotal };
            safeLog('log', `[BALANCES] ${id.toUpperCase()}: Khả dụng ${usdtAvailable.toFixed(2)} USDT, Tổng ${usdtTotal.toFixed(2)} USDT.`);
        } catch (e) {
            safeLog('error', `[BALANCES] Lỗi lấy số dư ${id.toUpperCase()}: ${e.message}`);
            balances[id] = { available: 0, total: 0 }; // Reset số dư nếu có lỗi
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
    
    // Các định dạng symbol có thể có để thử
    const attempts = [
        `${base}/${quote}:${quote}`, // VD: BTC/USDT:USDT (Binance)
        `${base}/${quote}`,         // VD: BTC/USDT (Chung)
        rawCoinSymbol,              // VD: BTCUSDT (Chung)
        `${base}USDTM`,             // VD: BTCUSDTM (KuCoin Futures)
        `${base}-${quote}-SWAP`     // VD: BTC-USDT-SWAP (OKX)
    ];

    for (const attempt of attempts) {
        const market = exchange.markets[attempt];
        if (market && market.active && (market.swap || market.future || market.contract)) {
             safeLog('debug', `[HELPER] Tìm thấy symbol: ${market.id} cho ${rawCoinSymbol} trên ${exchange.id}`);
            return market.id;
        }
    }

    safeLog('warn', `[HELPER] Không tìm thấy symbol hợp lệ cho ${rawCoinSymbol} trên ${exchange.id}`);
    return null;
}

async function processServerData(serverData) {
    if (!serverData || !serverData.arbitrageData) {
        allCurrentOpportunities = [];
        bestPotentialOpportunityForDisplay = null;
        return;
    }

    const now = Date.now();
    let bestForDisplay = null;
    const tempAllOpportunities = [];

    for (const op of serverData.arbitrageData) {
        if (!op || !op.details) continue;

        const minutesUntilFunding = (op.nextFundingTime - now) / (1000 * 60);
        const shortExId = op.details.shortExchange.toLowerCase().replace('binance', 'binanceusdm');
        const longExId = op.details.longExchange.toLowerCase().replace('binance', 'binanceusdm');

        if (!activeExchangeIds.includes(shortExId) || !activeExchangeIds.includes(longExId)) continue;
        if (!exchanges[shortExId] || !exchanges[longExId]) continue;
        
        const shortSymbol = await getExchangeSpecificSymbol(exchanges[shortExId], op.coin);
        const longSymbol = await getExchangeSpecificSymbol(exchanges[longExId], op.coin);

        if (!shortSymbol || !longSymbol) continue;

        op.details.shortOriginalSymbol = shortSymbol;
        op.details.longOriginalSymbol = longSymbol;
        op.details.minutesUntilFunding = minutesUntilFunding;
        op.details.shortExchange = shortExId;
        op.details.longExchange = longExId;

        tempAllOpportunities.push(op);

        if (!bestForDisplay || op.estimatedPnl > bestForDisplay.estimatedPnl) {
            bestForDisplay = op;
        }
    }

    allCurrentOpportunities = tempAllOpportunities;
    bestPotentialOpportunityForDisplay = bestForDisplay;
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
    if (!opportunity || percentageToUse <= 0 || !opportunity.details) {
        safeLog('warn', '[BOT_TRADE] Thông tin cơ hội không hợp lệ để thực thi.');
        return false;
    }

    const { shortExchange: shortExchangeId, longExchange: longExchangeId, shortOriginalSymbol, longOriginalSymbol } = opportunity.details;
    const { coin, commonLeverage } = opportunity;

    if (!exchanges[shortExchangeId] || !exchanges[longExchangeId] || !shortOriginalSymbol || !longOriginalSymbol) {
        safeLog('error', `[BOT_TRADE] Sàn hoặc Symbol không hợp lệ. Short: ${shortExchangeId}(${shortOriginalSymbol}), Long: ${longExchangeId}(${longOriginalSymbol})`);
        return false;
    }

    await updateBalances();
    const shortExchange = exchanges[shortExchangeId];
    const longExchange = exchanges[longExchangeId];

    const minAvailableBalance = Math.min(balances[shortExchangeId]?.available || 0, balances[longExchangeId]?.available || 0);
    const collateral = minAvailableBalance * (percentageToUse / 100);

    if (collateral <= 1) {
        safeLog('error', `[BOT_TRADE] Vốn thế chấp (${collateral.toFixed(2)} USDT) không đủ để giao dịch.`);
        return false;
    }
    
    safeLog('log', `[BOT_TRADE] Chuẩn bị mở lệnh cho ${coin}: Short trên ${shortExchangeId}, Long trên ${longExchangeId} với ${collateral.toFixed(2)} USDT mỗi bên.`);
    
    let shortOrder = null, longOrder = null;

    try {
        if (!await setLeverage(shortExchange, shortOriginalSymbol, commonLeverage)) throw new Error(`Không thể đặt đòn bẩy cho sàn SHORT ${shortExchangeId}.`);
        if (!await setLeverage(longExchange, longOriginalSymbol, commonLeverage)) throw new Error(`Không thể đặt đòn bẩy cho sàn LONG ${longExchangeId}.`);

        const shortPrice = (await shortExchange.fetchTicker(shortOriginalSymbol)).last;
        const longPrice = (await longExchange.fetchTicker(longOriginalSymbol)).last;

        if (!shortPrice || !longPrice) throw new Error(`Không lấy được giá thị trường cho ${coin}.`);

        const shortAmount = shortExchange.amountToPrecision(shortOriginalSymbol, (collateral * commonLeverage) / shortPrice);
        const longAmount = longExchange.amountToPrecision(longOriginalSymbol, (collateral * commonLeverage) / longPrice);

        safeLog('log', `[BOT_TRADE] Mở SHORT ${shortAmount} ${shortOriginalSymbol} trên ${shortExchangeId}...`);
        shortOrder = await shortExchange.createMarketSellOrder(shortOriginalSymbol, parseFloat(shortAmount));
        safeLog('log', `[BOT_TRADE] ✅ Lệnh SHORT ${shortExchangeId} khớp: ID ${shortOrder.id}`);

        safeLog('log', `[BOT_TRADE] Mở LONG ${longAmount} ${longOriginalSymbol} trên ${longExchangeId}...`);
        longOrder = await longExchange.createMarketBuyOrder(longOriginalSymbol, parseFloat(longAmount));
        safeLog('log', `[BOT_TRADE] ✅ Lệnh LONG ${longExchangeId} khớp: ID ${longOrder.id}`);

        currentTradeDetails = {
            coin: coin,
            shortExchange: shortExchangeId,
            longExchange: longExchangeId,
            shortOriginalSymbol,
            longOriginalSymbol,
            shortOrderId: shortOrder.id,
            longOrderId: longOrder.id,
            shortOrderAmount: shortOrder.amount,
            longOrderAmount: longOrder.amount,
            shortEntryPrice: shortPrice,
            longEntryPrice: longPrice,
            shortCollateral: collateral,
            longCollateral: collateral,
            commonLeverage: commonLeverage,
            status: 'OPEN',
            openTime: Date.now()
        };
        safeLog('log', `[BOT_TRADE] Giao dịch được mở thành công.`, currentTradeDetails);
        return true;
    } catch (e) {
        safeLog('error', `[BOT_TRADE] ❌ Lỗi nghiêm trọng khi thực hiện giao dịch: ${e.message}`, e);
        // Cố gắng đóng lệnh đã mở nếu có lỗi
        if (shortOrder) {
            safeLog('warn', `[BOT_TRADE] Cố gắng đóng lệnh SHORT đã mở do lỗi...`);
            try { await shortExchange.createMarketBuyOrder(shortOriginalSymbol, shortOrder.amount); } catch (eClose) { safeLog('error', `[BOT_TRADE] Lỗi khi đóng lệnh SHORT cứu vãn: ${eClose.message}`);}
        }
        if (longOrder) {
            safeLog('warn', `[BOT_TRADE] Cố gắng đóng lệnh LONG đã mở do lỗi...`);
            try { await longExchange.createMarketSellOrder(longOriginalSymbol, longOrder.amount); } catch (eClose) { safeLog('error', `[BOT_TRADE] Lỗi khi đóng lệnh LONG cứu vãn: ${eClose.message}`);}
        }
        currentTradeDetails = null;
        return false;
    }
}

async function closeTradesAndCalculatePnL() {
    if (!currentTradeDetails || currentTradeDetails.status !== 'OPEN') {
        safeLog('log', '[BOT_PNL] Không có giao dịch nào đang mở để đóng.');
        return;
    }

    safeLog('log', '[BOT_PNL] 🔄 Đang đóng các vị thế và tính toán PnL...');
    const { coin, shortExchange, longExchange, shortOriginalSymbol, longOriginalSymbol, shortOrderAmount, longOrderAmount } = currentTradeDetails;

    try {
        const shortEx = exchanges[shortExchange];
        const longEx = exchanges[longExchange];

        await updateBalances();
        const shortBalanceBefore = balances[shortExchange].available;
        const longBalanceBefore = balances[longExchange].available;

        safeLog('log', `[BOT_PNL] Đóng vị thế SHORT ${coin} trên ${shortExchange}...`);
        await shortEx.createMarketBuyOrder(shortOriginalSymbol, shortOrderAmount);
        safeLog('log', `[BOT_PNL] ✅ Vị thế SHORT đã đóng.`);

        safeLog('log', `[BOT_PNL] Đóng vị thế LONG ${coin} trên ${longExchange}...`);
        await longEx.createMarketSellOrder(longOriginalSymbol, longOrderAmount);
        safeLog('log', `[BOT_PNL] ✅ Vị thế LONG đã đóng.`);

        safeLog('log', '[BOT_PNL] Đợi 15 giây để sàn cập nhật số dư...');
        await sleep(15000);

        await updateBalances();
        const shortBalanceAfter = balances[shortExchange].available;
        const longBalanceAfter = balances[longExchange].available;
        
        const shortPnl = shortBalanceAfter - shortBalanceBefore;
        const longPnl = longBalanceAfter - longBalanceBefore;
        const cyclePnl = shortPnl + longPnl;

        const historyEntry = {
            id: Date.now(),
            coin: coin,
            exchanges: `${shortExchange}/${longExchange}`,
            estimatedPnl: currentSelectedOpportunityForExecution?.estimatedPnl || bestPotentialOpportunityForDisplay?.estimatedPnl,
            actualPnl: parseFloat(cyclePnl.toFixed(4)),
            timestamp: new Date().toISOString()
        };

        tradeHistory.unshift(historyEntry);
        if (tradeHistory.length > 50) tradeHistory.pop();

        safeLog('log', `[BOT_PNL] TÍNH TOÁN PNL CHO ${coin}:`);
        safeLog('log', `  > ${shortExchange.toUpperCase()} PNL: ${shortPnl.toFixed(4)} USDT (Trước: ${shortBalanceBefore.toFixed(2)}, Sau: ${shortBalanceAfter.toFixed(2)})`);
        safeLog('log', `  > ${longExchange.toUpperCase()} PNL: ${longPnl.toFixed(4)} USDT (Trước: ${longBalanceBefore.toFixed(2)}, Sau: ${longBalanceAfter.toFixed(2)})`);
        safeLog('log', `[BOT_PNL] ✅ Chu kỳ hoàn tất. PNL chu kỳ: ${cyclePnl.toFixed(4)} USDT.`);

    } catch (e) {
        safeLog('error', `[BOT_PNL] ❌ Lỗi khi đóng vị thế hoặc tính PnL: ${e.message}`, e);
    } finally {
        currentTradeDetails = null;
        currentSelectedOpportunityForExecution = null;
    }
}

async function mainBotLoop() {
    if (botState !== 'RUNNING') return;

    const serverData = await fetchDataFromServer();
    if (serverData) {
        await processServerData(serverData);
    }

    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentSecond = now.getUTCSeconds();
    const minuteAligned = Math.floor(now.getTime() / 60000);
    
    // 1. Giai đoạn CHỌN CƠ HỘI (59:00 -> 59:04)
    if (currentMinute === 59 && currentSecond < 5 && !currentTradeDetails && !currentSelectedOpportunityForExecution) {
        if (LAST_ACTION_TIMESTAMP.selectionTime !== minuteAligned) {
            LAST_ACTION_TIMESTAMP.selectionTime = minuteAligned;
            safeLog('log', '[BOT_LOOP] 🌟 Kích hoạt lựa chọn cơ hội để THỰC HIỆN...');
            
            let bestForExecution = null;
            for (const op of allCurrentOpportunities) {
                if (op.details.minutesUntilFunding > 0 && op.details.minutesUntilFunding < MIN_MINUTES_FOR_EXECUTION) {
                    if (!bestForExecution || op.estimatedPnl > bestForExecution.estimatedPnl) {
                        bestForExecution = op;
                    }
                }
            }

            if (bestForExecution) {
                currentSelectedOpportunityForExecution = bestForExecution;
                safeLog('log', `[BOT_LOOP] ✅ Đã chọn cơ hội: ${bestForExecution.coin} (PNL: ${bestForExecution.estimatedPnl.toFixed(2)}%, Funding trong ${bestForExecution.details.minutesUntilFunding.toFixed(1)} phút)`);
            } else {
                 safeLog('log', '[BOT_LOOP] 🔍 Không tìm thấy cơ hội nào đủ điều kiện để thực hiện.');
            }
        }
    }

    // 2. Giai đoạn MỞ LỆNH (59:30 -> 59:34)
    if (currentMinute === 59 && currentSecond >= 30 && currentSecond < 35 && currentSelectedOpportunityForExecution && !currentTradeDetails) {
         if (LAST_ACTION_TIMESTAMP.tradeExecution !== minuteAligned) {
            LAST_ACTION_TIMESTAMP.tradeExecution = minuteAligned;
            safeLog('log', `[BOT_LOOP] ⚡ Kích hoạt mở lệnh cho ${currentSelectedOpportunityForExecution.coin}...`);
            await executeTrades(currentSelectedOpportunityForExecution, currentPercentageToUse);
        }
    }
    
    // 3. Giai đoạn ĐÓNG LỆNH (00:05 -> 00:09)
    if (currentMinute === 0 && currentSecond >= 5 && currentSecond < 10 && currentTradeDetails?.status === 'OPEN') {
        if (LAST_ACTION_TIMESTAMP.closeTrade !== minuteAligned) {
            LAST_ACTION_TIMESTAMP.closeTrade = minuteAligned;
            safeLog('log', `[BOT_LOOP] 🛑 Kích hoạt đóng lệnh cho ${currentTradeDetails.coin}...`);
            await closeTradesAndCalculatePnL();
        }
    }
    
    botLoopIntervalId = setTimeout(mainBotLoop, DATA_FETCH_INTERVAL_SECONDS * 1000);
}

function startBot() {
    if (botState === 'RUNNING') {
        safeLog('warn', '[BOT] Bot đã đang chạy.');
        return false;
    }
    botState = 'RUNNING';
    safeLog('log', '[BOT] ▶️ Khởi động Bot...');
    updateBalances().then(() => {
        mainBotLoop();
    }).catch(e => {
        safeLog('error', `[BOT] Lỗi cập nhật số dư ban đầu, không thể khởi động: ${e.message}`);
        botState = 'STOPPED';
    });
    return true;
}

function stopBot() {
    if (botState !== 'RUNNING') {
        safeLog('warn', '[BOT] Bot không chạy.');
        return false;
    }
    botState = 'STOPPED';
    if (botLoopIntervalId) {
        clearTimeout(botLoopIntervalId);
        botLoopIntervalId = null;
    }
    safeLog('log', '[BOT] ⏸️ Dừng Bot.');
    return true;
}

// === HTTP Server for UI ===

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
        const statusData = { botState, balances, tradeHistory, bestPotentialOpportunityForDisplay, currentTradeDetails, activeExchangeIds };
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
    
    // API Endpoints cho "Test Nhanh"
    else if (req.url === '/bot-api/test-trade' && req.method === 'POST') {
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

                if (currentTradeDetails && currentTradeDetails.status === 'OPEN') {
                    res.writeHead(409, { 'Content-Type': 'application/json' }); 
                    return res.end(JSON.stringify({ success: false, message: 'Đã có lệnh đang mở. Vui lòng đóng lệnh hiện tại trước.' }));
                }
                
                safeLog('log', `[API_TEST] ⚡ Yêu cầu TEST MỞ LỆNH: ${bestPotentialOpportunityForDisplay.coin} với ${testPercentageToUse}% vốn.`);
                
                const tradeSuccess = await executeTrades(bestPotentialOpportunityForDisplay, testPercentageToUse);

                if (tradeSuccess) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Lệnh TEST đã được gửi thành công!' }));
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Lỗi khi gửi lệnh TEST. Kiểm tra log bot.' }));
                }

            } catch (error) {
                safeLog('error', `[API_TEST] Lỗi xử lý POST /bot-api/test-trade: ${error.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Lỗi server khi thực hiện lệnh test.' }));
            }
        });
    } else if (req.url === '/bot-api/stop-test-trade' && req.method === 'POST') {
        if (!currentTradeDetails || currentTradeDetails.status !== 'OPEN') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, message: 'Không có lệnh nào đang mở để dừng.' }));
        }
        
        safeLog('log', '[API_TEST] 🛑 Yêu cầu DỪNG LỆNH ĐANG MỞ...');
        closeTradesAndCalculatePnL()
            .then(() => {
                safeLog('log', '[API_TEST] ✅ Yêu cầu đóng lệnh đã được xử lý.');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Đã gửi lệnh đóng vị thế thành công.' }));
            })
            .catch(error => {
                safeLog('error', `[API_TEST] Lỗi khi xử lý yêu cầu dừng lệnh: ${error.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Lỗi server khi dừng lệnh.' }));
            });
    } 
    
    else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

botServer.listen(BOT_PORT, () => {
    safeLog('log', `✅ Máy chủ UI của Bot đang chạy tại http://localhost:${BOT_PORT}`);
});
