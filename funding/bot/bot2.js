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

const BOT_PORT = 5008;
const SERVER_DATA_URL = 'http://localhost:5005/api/data';
const MIN_PNL_PERCENTAGE = 1;
const MIN_MINUTES_FOR_EXECUTION = 15;
const DATA_FETCH_INTERVAL_SECONDS = 5;
const MAX_CONSECUTIVE_FAILS = 3;

const ALL_POSSIBLE_EXCHANGE_IDS = ['binanceusdm', 'bitget', 'okx', 'kucoinfutures'];
const DISABLED_EXCHANGES = [];
const activeExchangeIds = ALL_POSSIBLE_EXCHANGE_IDS.filter(id => !DISABLED_EXCHANGES.includes(id));

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
        } else if (id === 'kucoinfutures') {
            exchangeClass = ccxt.kucoinfutures;
            config.apiKey = kucoinApiKey; config.secret = kucoinApiSecret; config.password = kucoinApiPassword;
        }

        if (config.apiKey && config.secret && (id !== 'kucoinfutures' || config.password)) {
            exchanges[id] = new exchangeClass(config);
            safeLog('log', `[INIT] Khởi tạo sàn ${id.toUpperCase()} thành công.`);
        } else {
            safeLog('warn', `[INIT] Bỏ qua ${id.toUpperCase()} do thiếu API Key/Secret/Password.`);
        }
    } catch (e) {
        safeLog('error', `[INIT] Lỗi khi khởi tạo sàn ${id.toUpperCase()}: ${e}`);
    }
});

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
            let balanceData = (id === 'kucoinfutures') ? await exchanges[id].fetchBalance() : await exchanges[id].fetchBalance({ 'type': 'future' });
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

async function getExchangeSpecificSymbol(exchange, rawCoinSymbol) {
    try {
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) await exchange.loadMarkets(true);
    } catch (e) {
        safeLog('error', `[SYMBOL] Lỗi tải markets cho ${exchange.id}: ${e.message}`);
        return null;
    }
    const base = String(rawCoinSymbol).toUpperCase().replace(/USDT$/, '');
    const attempts = [`${base}/USDT:USDT`, `${base}USDT`, `${base}-USDT-SWAP`, `${base}USDTM`, `${base}/USDT`];
    for (const attempt of attempts) {
        const market = exchange.markets[attempt];
        if (market?.active && (market.contract || market.swap || market.future)) {
            return market.id;
        }
    }
    safeLog('warn', `[SYMBOL] ❌ KHÔNG tìm thấy symbol hợp lệ cho ${rawCoinSymbol} trên ${exchange.id}.`);
    return null;
}

async function getMaxLeverage(exchange, symbol) {
    try {
        const markets = await exchange.fetchLeverageTiers([symbol]);
        const tiers = markets[symbol];
        if (tiers && tiers.length > 0) {
            tiers.sort((a, b) => b.maxLeverage - a.maxLeverage);
            return tiers[0].maxLeverage;
        }
    } catch (e) {
        safeLog('debug', `[LEVERAGE] Không thể fetchLeverageTiers. Thử market info.`);
        try {
            const market = exchange.market(symbol);
            if (market.limits?.leverage?.max) {
                return market.limits.leverage.max;
            }
        } catch (e2) {
             safeLog('warn', `[LEVERAGE] Không tìm thấy đòn bẩy tối đa cho ${symbol} trên ${exchange.id}.`);
        }
    }
    return null;
}

async function setLeverageSafely(exchange, symbol, desiredLeverage) {
    const params = {};
    if (exchange.id === 'kucoinfutures') {
        params['marginMode'] = 'cross';
    }

    try {
        await exchange.setLeverage(desiredLeverage, symbol, params);
        safeLog('log', `[LEVERAGE] ✅ Đặt đòn bẩy mong muốn x${desiredLeverage} cho ${symbol} trên ${exchange.id} thành công.`);
        return desiredLeverage;
    } catch (e) {
        safeLog('warn', `[LEVERAGE] ⚠️ Không thể đặt đòn bẩy x${desiredLeverage} (${e.message}). Thử với đòn bẩy tối đa...`);
    }

    const maxLeverage = await getMaxLeverage(exchange, symbol);
    if (maxLeverage) {
        try {
            await exchange.setLeverage(maxLeverage, symbol, params);
            safeLog('log', `[LEVERAGE] ✅ Đặt đòn bẩy TỐI ĐA x${maxLeverage} cho ${symbol} trên ${exchange.id} thành công.`);
            return maxLeverage;
        } catch (e2) {
            safeLog('error', `[LEVERAGE] ❌ Thất bại ngay cả khi đặt đòn bẩy tối đa x${maxLeverage} (${e2.message}).`);
        }
    }

    safeLog('error', `[LEVERAGE] ❌ Không thể đặt bất kỳ đòn bẩy nào cho ${symbol} trên ${exchange.id}.`);
    return null;
}


const normalizeExchangeId = (id) => {
    if (!id) return null;
    const lowerId = id.toLowerCase().trim();
    if (lowerId.includes('binance')) return 'binanceusdm';
    if (lowerId.includes('kucoin')) return 'kucoinfutures';
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

async function executeTrades(opportunity, percentageToUse) {
    const { coin, commonLeverage: desiredLeverage } = opportunity;
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
    
    const shortMarket = shortEx.market(shortOriginalSymbol);
    const longMarket = longEx.market(longOriginalSymbol);
    const minCostShort = shortMarket.limits?.cost?.min || 0.1;
    const minCostLong = longMarket.limits?.cost?.min || 0.1;
    const minRequiredCollateral = Math.max(minCostShort, minCostLong);

    const minBalance = Math.min(shortBalanceBefore, longBalanceBefore);
    const collateral = minBalance * (percentageToUse / 100);

    if (collateral < minRequiredCollateral) {
        safeLog('error', `[TRADE] Vốn thế chấp (${collateral.toFixed(2)} USDT) nhỏ hơn mức tối thiểu yêu cầu (${minRequiredCollateral} USDT). Hủy bỏ.`);
        return false;
    }

    try {
        const actualShortLeverage = await setLeverageSafely(shortEx, shortOriginalSymbol, desiredLeverage);
        const actualLongLeverage = await setLeverageSafely(longEx, longOriginalSymbol, desiredLeverage);

        if (actualShortLeverage === null || actualLongLeverage === null) {
            throw new Error(`Không thể đặt đòn bẩy cho một trong hai sàn.`);
        }
        
        const leverageToUse = Math.min(actualShortLeverage, actualLongLeverage);
        
        const shortPrice = (await shortEx.fetchTicker(shortOriginalSymbol)).last;
        const longPrice = (await longEx.fetchTicker(longOriginalSymbol)).last;
        const shortAmount = shortEx.amountToPrecision(shortOriginalSymbol, (collateral * leverageToUse) / shortPrice);
        const longAmount = longEx.amountToPrecision(longOriginalSymbol, (collateral * leverageToUse) / longPrice);
        safeLog('log', `[TRADE] Khối lượng tính toán dựa trên đòn bẩy thực tế x${leverageToUse}. Short: ${shortAmount}, Long: ${longAmount}`);

        const shortOrder = await shortEx.createMarketSellOrder(shortOriginalSymbol, shortAmount);
        const longOrder = await longEx.createMarketBuyOrder(longOriginalSymbol, longAmount);
        
        currentTradeDetails = {
            ...opportunity.details, coin, status: 'OPEN', openTime: Date.now(),
            shortOrderAmount: shortOrder.amount, longOrderAmount: longOrder.amount,
            commonLeverageUsed: leverageToUse, shortOriginalSymbol, longOriginalSymbol,
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
