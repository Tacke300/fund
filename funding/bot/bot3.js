const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const { URLSearchParams } = require('url');

const safeLog = (type, ...args) => {
    try {
        const now = new Date();
        const hours = now.getHours().toString().padStart(2, '0');
        const minutes = now.getMinutes().toString().padStart(2, '0');
        const timestamp = `${hours}:${minutes}`;
        if (typeof console === 'object' && typeof console[type] === 'function') {
            console[type](`[${timestamp} ${type.toUpperCase()}]`, ...args);
        } else {
            const message = `[${timestamp} ${type.toUpperCase()}] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`;
            if (type === 'error' || type === 'warn') {
                process.stderr.write(message);
            } else {
                process.stdout.write(message);
            }
        }
    } catch (e) {
        process.stderr.write(`FATAL LOG ERROR (safeLog itself failed): ${e.message} - Original log: [${type.toUpperCase()}] ${args.join(' ')}\n`);
    }
};

const {
    binanceApiKey, binanceApiSecret,
    bingxApiKey, bingxApiSecret,
    okxApiKey, okxApiSecret, okxPassword,
    bitgetApiKey, bitgetApiSecret, bitgetApiPassword
} = require('../config.js');

const BOT_PORT = 5008;
const SERVER_DATA_URL = 'http://localhost:5005/api/data';

const MIN_PNL_PERCENTAGE = 1;
const MAX_MINUTES_UNTIL_FUNDING = 30;
const MIN_MINUTES_FOR_EXECUTION = 15;

const DATA_FETCH_INTERVAL_SECONDS = 5;
const HOURLY_FETCH_TIME_MINUTE = 45;

const SL_PERCENT_OF_COLLATERAL = 700;
const TP_PERCENT_OF_COLLATERAL = 700; 

const DISABLED_EXCHANGES = ['bitget'];

const ALL_POSSIBLE_EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];

const activeExchangeIds = ALL_POSSIBLE_EXCHANGE_IDS.filter(id => !DISABLED_EXCHANGES.includes(id));

let botState = 'STOPPED';
let botLoopIntervalId = null;

const exchanges = {};
activeExchangeIds.forEach(id => {
    const exchangeClass = ccxt[id];
    const config = {
        'options': { 'defaultType': 'swap' },
        'enableRateLimit': true,
        'headers': {
            'User-Agent': 'Mozilla/5.0 (compatible; ccxt/1.0;)',
        }
    };

    if (id === 'binanceusdm') { config.apiKey = binanceApiKey; config.secret = binanceApiSecret; }
    else if (id === 'bingx') { config.apiKey = bingxApiKey; config.secret = bingxApiSecret; }
    else if (id === 'okx') { config.apiKey = okxApiKey; config.secret = okxApiSecret; if(okxPassword) config.password = okxPassword; }
    else if (id === 'bitget') { config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret; if(bitgetApiPassword) config.password = bitgetApiPassword; }

    if ((config.apiKey && config.secret) || (id === 'okx' && config.password) || (id === 'bitget' && config.password && config.apiKey && config.secret)) {
        exchanges[id] = new exchangeClass(config);
    } else {
        safeLog('warn', `[INIT] Bỏ qua khởi tạo ${id.toUpperCase()} vì thiếu API Key/Secret/Password hoặc không hợp lệ.`);
    }
});

let balances = {};
activeExchangeIds.forEach(id => {
    balances[id] = { total: 0, available: 0, originalSymbol: {} };
});
balances.totalOverall = 0;

let initialTotalBalance = 0;
let cumulativePnl = 0;
let tradeHistory = [];

let currentSelectedOpportunityForExecution = null;
let bestPotentialOpportunityForDisplay = null;
let allCurrentOpportunities = [];

const LAST_ACTION_TIMESTAMP = {
    dataFetch: 0,
    selectionTime: 0,
    tradeExecution: 0,
    closeTrade: 0,
};

let currentTradeDetails = null;

let currentPercentageToUse = 50;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchDataFromServer() {
    try {
        const response = await fetch(SERVER_DATA_URL);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        return data;
    } catch (error) {
        safeLog('error', `[BOT] ❌ Lỗi khi lấy dữ liệu từ server: ${error.message}`, error);
        return null;
    }
}

async function updateBalances() {
    safeLog('log', '[BOT] 🔄 Cập nhật số dư từ các sàn...');
    let currentTotalOverall = 0;
    for (const id of activeExchangeIds) {
        if (!exchanges[id]) {
            safeLog('warn', `[BOT] ${id.toUpperCase()} không được khởi tạo (có thể do thiếu API Key/Secret). Bỏ qua cập nhật số dư.`);
            continue;
        }
        try {
            const exchange = exchanges[id];
            await exchange.loadMarkets(true);

            const accountBalance = await exchange.fetchBalance({ 'type': 'future' });
            const usdtFreeBalance = accountBalance.free?.USDT || 0;
            const usdtTotalBalance = accountBalance.total?.USDT || 0;

            balances[id].available = usdtFreeBalance;
            balances[id].total = usdtTotalBalance;
            balances[id].originalSymbol = {};
            currentTotalOverall += balances[id].available;

            safeLog('log', `[BOT] ✅ ${id.toUpperCase()} Balance: Total ${usdtTotalBalance.toFixed(2)} USDT, Available ${balances[id].available.toFixed(2)} USDT.`);
        } catch (e) {
            safeLog('error', `[BOT] ❌ Lỗi khi lấy số dư ${id.toUpperCase()}: ${e.message}`, e);
        }
    }
    balances.totalOverall = currentTotalOverall;
    safeLog('log', `[BOT] Tổng số dư khả dụng trên tất cả các sàn (có thể bao gồm âm): ${currentTotalOverall.toFixed(2)} USDT.`);
    if (initialTotalBalance === 0) {
        initialTotalBalance = currentTotalOverall;
    }
}

async function processServerData(serverData) {
    if (!serverData || !serverData.arbitrageData) {
        safeLog('warn', '[BOT] Dữ liệu từ server không hợp lệ hoặc thiếu arbitrageData.');
        bestPotentialOpportunityForDisplay = null;
        allCurrentOpportunities = [];
        return;
    }

    const now = Date.now();
    let bestForDisplay = null;
    const tempAllOpportunities = [];

    serverData.arbitrageData.forEach(op => {
        const minutesUntilFunding = (op.nextFundingTime - now) / (1000 * 60);
        const shortExIdNormalized = op.details.shortExchange.toLowerCase() === 'binance' ? 'binanceusdm' : op.details.shortExchange.toLowerCase();
        const longExIdNormalized = op.details.longExchange.toLowerCase() === 'binance' ? 'binanceusdm' : op.details.longExchange.toLowerCase();

        if (DISABLED_EXCHANGES.includes(shortExIdNormalized) || DISABLED_EXCHANGES.includes(longExIdNormalized) ||
            !exchanges[shortExIdNormalized] || !exchanges[longExIdNormalized]) {
            return;
        }

        if (op.estimatedPnl > 0 && minutesUntilFunding > 0) {
            op.details.minutesUntilFunding = minutesUntilFunding;
            op.details.shortFundingRate = op.details.shortRate !== undefined ? op.details.shortRate : 'N/A';
            op.details.longFundingRate = op.details.longRate !== undefined ? op.details.longRate : 'N/A';
            op.fundingDiff = op.fundingDiff !== undefined ? op.fundingDiff : 'N/A';
            op.commonLeverage = op.commonLeverage !== undefined ? op.commonLeverage : 'N/A';

            let shortExId = op.details.shortExchange;
            let longExId = op.details.longExchange;
            if (typeof op.details.shortFundingRate === 'number' && typeof op.details.longFundingRate === 'number') {
                if (op.details.shortFundingRate < op.details.longFundingRate) {
                    shortExId = op.details.longExchange;
                    longExId = op.details.shortExchange;
                }
            }
            op.details.shortExchange = shortExId;
            op.details.longExchange = longExId;

            tempAllOpportunities.push(op);

            if (!bestForDisplay ||
                op.estimatedPnl > bestForDisplay.estimatedPnl ||
                (op.estimatedPnl === bestForDisplay.estimatedPnl && minutesUntilFunding < bestForDisplay.details.minutesUntilFunding)
            ) {
                bestForDisplay = op;
            }
        }
    });

    allCurrentOpportunities = tempAllOpportunities;

    if (bestForDisplay) {
        bestPotentialOpportunityForDisplay = bestForDisplay;
        const shortExId = bestForDisplay.details.shortExchange.toLowerCase() === 'binance' ? 'binanceusdm' : bestForDisplay.details.shortExchange.toLowerCase();
        const longExId = bestForDisplay.details.longExchange.toLowerCase() === 'binance' ? 'binanceusdm' : bestForDisplay.details.longExchange.toLowerCase();
        const minAvailableBalance = Math.min(balances[shortExId]?.available || 0, balances[longExId]?.available || 0);
        bestPotentialOpportunityForDisplay.estimatedTradeCollateral = (minAvailableBalance * (currentPercentageToUse / 100)).toFixed(2);
    } else {
        bestPotentialOpportunityForDisplay = null;
    }
}


// =================================================================================
// HÀM TRỢ GIÚP MỚI ĐỂ LẤY ĐÒN BẨY TỐI ĐA
// =================================================================================
async function getMaxLeverageForSymbol(exchange, symbol) {
    try {
        const market = exchange.market(symbol);
        if (!market) {
            safeLog('warn', `[HELPER] Không tìm thấy market cho ${symbol} trên sàn ${exchange.id}`);
            return null;
        }

        const exchangeId = exchange.id;
        let maxLeverage = null;

        switch (exchangeId) {
            case 'binanceusdm':
                if (market.info && market.info.leverageFilter && market.info.leverageFilter.maxLeverage) {
                    maxLeverage = parseInt(market.info.leverageFilter.maxLeverage, 10);
                }
                break;
            case 'bingx':
                if (market.info && market.info.leverage_limit && market.info.leverage_limit.max_leverage) {
                    maxLeverage = parseInt(market.info.leverage_limit.max_leverage, 10);
                }
                break;
            case 'okx':
                 if (market.info && market.info.lever) {
                    maxLeverage = parseInt(market.info.lever, 10);
                }
                break;
            default:
                safeLog('warn', `[HELPER] Chưa hỗ trợ lấy max leverage tự động cho sàn ${exchangeId}.`);
                return null;
        }

        return maxLeverage;

    } catch (e) {
        safeLog('error', `[HELPER] Lỗi khi lấy max leverage cho ${symbol} trên ${exchange.id}: ${e.message}`);
        return null;
    }
}


async function executeTrades(opportunity, percentageToUse) {
    if (!opportunity || percentageToUse <= 0) {
        safeLog('warn', '[BOT_TRADE] Không có cơ hội hoặc phần trăm sử dụng không hợp lệ.');
        return false;
    }

    if (!opportunity.details || !opportunity.details.shortExchange || !opportunity.details.longExchange ||
        !opportunity.details.shortOriginalSymbol || !opportunity.details.longOriginalSymbol) {
        safeLog('error', '[BOT_TRADE] Thông tin chi tiết cơ hội thiếu trường cần thiết (exchange ID hoặc original symbol). Hủy bỏ lệnh.');
        return false;
    }

    const shortExchangeId = opportunity.details.shortExchange.toLowerCase() === 'binance' ? 'binanceusdm' : opportunity.details.shortExchange.toLowerCase();
    const longExchangeId = opportunity.details.longExchange.toLowerCase() === 'binance' ? 'binanceusdm' : opportunity.details.longExchange.toLowerCase();

    if (DISABLED_EXCHANGES.includes(shortExchangeId) || DISABLED_EXCHANGES.includes(longExchangeId) ||
        !exchanges[shortExchangeId] || !exchanges[longExchangeId]) {
        safeLog('error', `[BOT_TRADE] Bỏ qua thực hiện lệnh vì sàn ${shortExchangeId} hoặc ${longExchangeId} bị tắt hoặc chưa được khởi tạo.`);
        return false;
    }

    const cleanedCoin = opportunity.coin;
    const shortOriginalSymbol = opportunity.details.shortOriginalSymbol;
    const longOriginalSymbol = opportunity.details.longOriginalSymbol;

    const shortExchange = exchanges[shortExchangeId];
    const longExchange = exchanges[longExchangeId];

    const minAvailableBalanceInPair = Math.min(balances[shortExchangeId]?.available || 0, balances[longExchangeId]?.available || 0);
    const baseCollateralPerSide = minAvailableBalanceInPair * (percentageToUse / 100);

    const shortCollateral = baseCollateralPerSide;
    const longCollateral = baseCollateralPerSide;

    if (shortCollateral <= 0 || longCollateral <= 0) {
        safeLog('error', '[BOT_TRADE] Số tiền mở lệnh (collateral) không hợp lệ (cần dương). Hủy bỏ lệnh.');
        return false;
    }
    if (balances[shortExchangeId]?.available < shortCollateral || balances[longExchangeId]?.available < longCollateral) {
        safeLog('error', `[BOT_TRADE] Số dư khả dụng không đủ để mở lệnh với vốn ${baseCollateralPerSide.toFixed(2)} USDT mỗi bên. ${shortExchangeId}: ${balances[shortExchangeId]?.available.toFixed(2)}, ${longExchangeId}: ${balances[longExchangeId]?.available.toFixed(2)}. Hủy bỏ lệnh.`);
        return false;
    }

    safeLog('log', `[BOT_TRADE] Chuẩn bị mở lệnh cho ${cleanedCoin}:`);
    safeLog('log', `  SHORT ${shortExchangeId} (${shortOriginalSymbol}): ${shortCollateral.toFixed(2)} USDT collateral`);
    safeLog('log', `  LONG ${longExchangeId} (${longOriginalSymbol}): ${longCollateral.toFixed(2)} USDT collateral`);

    let tradeSuccess = true;
    let shortOrder = null, longOrder = null;

    try {
        await shortExchange.loadMarkets(true);
        await longExchange.loadMarkets(true);

        const tickerShort = await shortExchange.fetchTicker(shortOriginalSymbol);
        const tickerLong = await longExchange.fetchTicker(longOriginalSymbol);

        const shortEntryPrice = tickerShort.last;
        const longEntryPrice = tickerLong.last;

        if (!shortEntryPrice || !longEntryPrice) {
            safeLog('error', `[BOT_TRADE] Không lấy được giá thị trường hiện tại cho ${cleanedCoin}.`);
            return false;
        }

        let commonLeverage = opportunity.commonLeverage;
        if (!commonLeverage || commonLeverage < 1) {
            safeLog('warn', `[BOT_TRADE] Đòn bẩy từ server không hợp lệ (${commonLeverage}), sẽ thử đặt max leverage.`);
            commonLeverage = 1; // Default to 1 to try something, but fallback will trigger
        }

        // =================================================================================
        // KHỐI LOGIC ĐẶT ĐÒN BẨY MỚI CHO LỆNH SHORT
        // =================================================================================
        try {
            const symbolToUseShort = typeof shortOriginalSymbol === 'string' ? shortOriginalSymbol : String(shortOriginalSymbol);
            safeLog('debug', `[DEBUG LEV] Thử đặt đòn bẩy SHORT từ server: x${commonLeverage} cho ${symbolToUseShort}`);
            if (shortExchange.has['setLeverage']) {
                if (shortExchangeId === 'bingx') {
                    await shortExchange.setLeverage(symbolToUseShort, commonLeverage, { 'side': 'BOTH' }); 
                } else if (shortExchangeId === 'binanceusdm') {
                    const binanceSymbolId = shortExchange.market(symbolToUseShort).id;
                    await shortExchange.setLeverage(binanceSymbolId, commonLeverage); 
                } else {
                    await shortExchange.setLeverage(symbolToUseShort, commonLeverage);
                }
            }
            safeLog('log', `[BOT_TRADE] ✅ Đặt đòn bẩy x${commonLeverage} cho SHORT ${shortOriginalSymbol} trên ${shortExchangeId}.`);
        } catch (levErr) {
            safeLog('warn', `[BOT_TRADE] ⚠️ Không đặt được đòn bẩy x${commonLeverage} từ server cho SHORT: ${levErr.message}. Thử đặt đòn bẩy TỐI ĐA.`);
            
            const maxLeverage = await getMaxLeverageForSymbol(shortExchange, shortOriginalSymbol);

            if (maxLeverage) {
                try {
                    const symbolToUseShort = typeof shortOriginalSymbol === 'string' ? shortOriginalSymbol : String(shortOriginalSymbol);
                    safeLog('log', `[BOT_TRADE] Thử lại với đòn bẩy TỐI ĐA x${maxLeverage} cho SHORT.`);
                    if (shortExchange.has['setLeverage']) {
                        if (shortExchangeId === 'bingx') {
                            await shortExchange.setLeverage(symbolToUseShort, maxLeverage, { 'side': 'BOTH' }); 
                        } else if (shortExchangeId === 'binanceusdm') {
                            const binanceSymbolId = shortExchange.market(symbolToUseShort).id;
                            await shortExchange.setLeverage(binanceSymbolId, maxLeverage); 
                        } else {
                            await shortExchange.setLeverage(symbolToUseShort, maxLeverage);
                        }
                    }
                    safeLog('log', `[BOT_TRADE] ✅ Đã đặt thành công đòn bẩy TỐI ĐA x${maxLeverage} cho SHORT.`);
                    commonLeverage = maxLeverage;
                } catch (maxLevErr) {
                    safeLog('error', `[BOT_TRADE] ❌ Lỗi ngay cả khi thử đặt đòn bẩy TỐI ĐA x${maxLeverage} cho SHORT: ${maxLevErr.message}. HỦY BỎ LỆNH.`, maxLevErr);
                    return false;
                }
            } else {
                safeLog('error', `[BOT_TRADE] ❌ Không tìm thấy thông tin đòn bẩy tối đa cho SHORT. HỦY BỎ LỆNH.`);
                return false;
            }
        }

        // =================================================================================
        // KHỐI LOGIC ĐẶT ĐÒN BẨY MỚI CHO LỆNH LONG
        // =================================================================================
        try {
            const symbolToUseLong = typeof longOriginalSymbol === 'string' ? longOriginalSymbol : String(longOriginalSymbol);
            safeLog('debug', `[DEBUG LEV] Thử đặt đòn bẩy LONG từ server: x${commonLeverage} cho ${symbolToUseLong}`);
            if (longExchange.has['setLeverage']) {
                if (longExchangeId === 'bingx') {
                    await longExchange.setLeverage(symbolToUseLong, commonLeverage, { 'side': 'BOTH' });
                } else if (longExchangeId === 'binanceusdm') {
                    const binanceSymbolId = longExchange.market(symbolToUseLong).id;
                    await longExchange.setLeverage(binanceSymbolId, commonLeverage);
                } else {
                    await longExchange.setLeverage(symbolToUseLong, commonLeverage);
                }
            }
            safeLog('log', `[BOT_TRADE] ✅ Đặt đòn bẩy x${commonLeverage} cho LONG ${longOriginalSymbol} trên ${longExchangeId}.`);
        } catch (levErr) {
            safeLog('warn', `[BOT_TRADE] ⚠️ Không đặt được đòn bẩy x${commonLeverage} từ server cho LONG: ${levErr.message}. Thử đặt đòn bẩy TỐI ĐA.`);
            
            const maxLeverage = await getMaxLeverageForSymbol(longExchange, longOriginalSymbol);

            if (maxLeverage) {
                try {
                    const symbolToUseLong = typeof longOriginalSymbol === 'string' ? longOriginalSymbol : String(longOriginalSymbol);
                    safeLog('log', `[BOT_TRADE] Thử lại với đòn bẩy TỐI ĐA x${maxLeverage} cho LONG.`);
                     if (longExchange.has['setLeverage']) {
                        if (longExchangeId === 'bingx') {
                            await longExchange.setLeverage(symbolToUseLong, maxLeverage, { 'side': 'BOTH' });
                        } else if (longExchangeId === 'binanceusdm') {
                            const binanceSymbolId = longExchange.market(symbolToUseLong).id;
                            await longExchange.setLeverage(binanceSymbolId, maxLeverage);
                        } else {
                            await longExchange.setLeverage(symbolToUseLong, maxLeverage);
                        }
                    }
                    safeLog('log', `[BOT_TRADE] ✅ Đã đặt thành công đòn bẩy TỐI ĐA x${maxLeverage} cho LONG.`);
                    commonLeverage = maxLeverage;
                } catch (maxLevErr) {
                    safeLog('error', `[BOT_TRADE] ❌ Lỗi ngay cả khi thử đặt đòn bẩy TỐI ĐA x${maxLeverage} cho LONG: ${maxLevErr.message}. HỦY BỎ LỆNH.`, maxLevErr);
                    return false;
                }
            } else {
                safeLog('error', `[BOT_TRADE] ❌ Không tìm thấy thông tin đòn bẩy tối đa cho LONG. HỦY BỎ LỆNH.`);
                return false;
            }
        }

        const shortAmount = (shortCollateral * commonLeverage) / shortEntryPrice;
        const longAmount = (longCollateral * commonLeverage) / longEntryPrice;

        if (shortAmount <= 0 || longAmount <= 0) {
            safeLog('error', '[BOT_TRADE] Lượng hợp đồng tính toán không hợp lệ (cần dương). Hủy bỏ lệnh.');
            return false;
        }
        
        const shortAmountToOrder = shortExchange.amountToPrecision(shortOriginalSymbol, shortAmount);
        const longAmountToOrder = longExchange.amountToPrecision(longOriginalSymbol, longAmount);

        const shortParams = { 'positionSide': 'SHORT' };
        const longParams = { 'positionSide': 'LONG' };

        safeLog('log', `[BOT_TRADE] Mở SHORT ${shortAmountToOrder} ${shortOriginalSymbol} trên ${shortExchangeId}...`);
        shortOrder = await shortExchange.createMarketSellOrder(shortOriginalSymbol, parseFloat(shortAmountToOrder), shortParams);
        safeLog('log', `[BOT_TRADE] ✅ Lệnh SHORT ${shortExchangeId} khớp: ID ${shortOrder.id}`);

        safeLog('log', `[BOT_TRADE] Mở LONG ${longAmountToOrder} ${longOriginalSymbol} trên ${longExchangeId}...`);
        longOrder = await longExchange.createMarketBuyOrder(longOriginalSymbol, parseFloat(longAmountToOrder), longParams);
        safeLog('log', `[BOT_TRADE] ✅ Lệnh LONG ${longExchangeId} khớp: ID ${longOrder.id}`);

        currentTradeDetails = {
            coin: cleanedCoin, shortExchange: shortExchangeId, longExchange: longExchangeId,
            shortOriginalSymbol: shortOriginalSymbol, longOriginalSymbol: longOriginalSymbol,
            shortOrderId: shortOrder.id, longOrderId: longOrder.id,
            shortOrderAmount: shortOrder.amount, longOrderAmount: longOrder.amount,
            shortEntryPrice: shortEntryPrice, longEntryPrice: longEntryPrice,
            shortCollateral: shortCollateral, longCollateral: longCollateral,
            commonLeverage: commonLeverage, status: 'OPEN', openTime: Date.now()
        };

        await sleep(2000);

        const shortTpPrice = shortEntryPrice * (1 - (TP_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));
        const shortSlPrice = shortEntryPrice * (1 + (SL_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));
        const longTpPrice = longEntryPrice * (1 + (TP_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));
        const longSlPrice = longEntryPrice * (1 - (SL_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));
        
        const shortTpPriceToOrder = shortExchange.priceToPrecision(shortOriginalSymbol, shortTpPrice);
        const shortSlPriceToOrder = shortExchange.priceToPrecision(shortOriginalSymbol, shortSlPrice);
        const longTpPriceToOrder = longExchange.priceToPrecision(longOriginalSymbol, longTpPrice);
        const longSlPriceToOrder = longExchange.priceToPrecision(longOriginalSymbol, longSlPrice);

        currentTradeDetails.shortSlPrice = parseFloat(shortSlPriceToOrder);
        currentTradeDetails.shortTpPrice = parseFloat(shortTpPriceToOrder);
        currentTradeDetails.longSlPrice = parseFloat(longSlPriceToOrder);
        currentTradeDetails.longTpPrice = parseFloat(longTpPriceToOrder);

        // Đặt TP/SL
        try {
            if (parseFloat(shortSlPriceToOrder) > 0) {
                await shortExchange.createOrder(shortOriginalSymbol, 'STOP_MARKET', 'buy', shortOrder.amount, undefined, { 'stopPrice': parseFloat(shortSlPriceToOrder), ...shortParams });
                safeLog('log', `[BOT_TRADE] ✅ Đặt SL cho SHORT ${shortExchangeId}.`);
            }
        } catch (e) { safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt SL cho SHORT: ${e.message}`); }
        try {
            if (parseFloat(shortTpPriceToOrder) > 0) {
                await shortExchange.createOrder(shortOriginalSymbol, 'TAKE_PROFIT_MARKET', 'buy', shortOrder.amount, undefined, { 'stopPrice': parseFloat(shortTpPriceToOrder), ...shortParams });
                safeLog('log', `[BOT_TRADE] ✅ Đặt TP cho SHORT ${shortExchangeId}.`);
            }
        } catch (e) { safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt TP cho SHORT: ${e.message}`); }
        try {
            if (parseFloat(longSlPriceToOrder) > 0) {
                await longExchange.createOrder(longOriginalSymbol, 'STOP_MARKET', 'sell', longOrder.amount, undefined, { 'stopPrice': parseFloat(longSlPriceToOrder), ...longParams });
                safeLog('log', `[BOT_TRADE] ✅ Đặt SL cho LONG ${longExchangeId}.`);
            }
        } catch (e) { safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt SL cho LONG: ${e.message}`); }
        try {
            if (parseFloat(longTpPriceToOrder) > 0) {
                await longExchange.createOrder(longOriginalSymbol, 'TAKE_PROFIT_MARKET', 'sell', longOrder.amount, undefined, { 'stopPrice': parseFloat(longTpPriceToOrder), ...longParams });
                safeLog('log', `[BOT_TRADE] ✅ Đặt TP cho LONG ${longExchangeId}.`);
            }
        } catch (e) { safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt TP cho LONG: ${e.message}`); }

    } catch (e) {
        safeLog('error', `[BOT_TRADE] ❌ Lỗi nghiêm trọng khi thực hiện giao dịch: ${e.message}`, e);
        tradeSuccess = false;
        if (shortOrder?.id) { try { await exchanges[shortExchangeId].cancelOrder(shortOrder.id, shortOriginalSymbol); } catch (ce) {} }
        if (longOrder?.id) { try { await exchanges[longExchangeId].cancelOrder(longOrder.id, longOriginalSymbol); } catch (ce) {} }
        currentTradeDetails = null;
    }
    return tradeSuccess;
}

async function closeTradesAndCalculatePnL() {
    if (!currentTradeDetails || currentTradeDetails.status !== 'OPEN') {
        safeLog('log', '[BOT_PNL] Không có giao dịch nào đang mở để đóng.');
        return;
    }

    safeLog('log', '[BOT_PNL] 🔄 Đang đóng các vị thế và tính toán PnL...');
    const { coin, shortExchange, longExchange, shortOriginalSymbol, longOriginalSymbol, shortOrderAmount, longOrderAmount, shortCollateral, longCollateral } = currentTradeDetails;

    try {
        // Hủy các lệnh chờ
        try {
            const shortOpenOrders = await exchanges[shortExchange].fetchOpenOrders(shortOriginalSymbol);
            for (const order of shortOpenOrders) {
                if (order.status === 'open') await exchanges[shortExchange].cancelOrder(order.id, shortOriginalSymbol);
            }
        } catch (e) { safeLog('warn', `[BOT_PNL] Lỗi khi hủy lệnh chờ SHORT: ${e.message}`); }
        try {
            const longOpenOrders = await exchanges[longExchange].fetchOpenOrders(longOriginalSymbol);
            for (const order of longOpenOrders) {
                if (order.status === 'open') await exchanges[longExchange].cancelOrder(order.id, longOriginalSymbol);
            }
        } catch (e) { safeLog('warn', `[BOT_PNL] Lỗi khi hủy lệnh chờ LONG: ${e.message}`); }

        const closeShortParams = { 'positionSide': 'SHORT' };
        const closeLongParams = { 'positionSide': 'LONG' };

        const closeShortOrder = await exchanges[shortExchange].createMarketBuyOrder(shortOriginalSymbol, shortOrderAmount, closeShortParams);
        const closeLongOrder = await exchanges[longExchange].createMarketSellOrder(longOriginalSymbol, longOrderAmount, closeLongParams);

        safeLog('log', '[BOT_PNL] Đợi 30 giây để sàn xử lý dữ liệu PnL...');
        await sleep(30000); 

        let shortSidePnl = 0, longSidePnl = 0;
        
        // Lấy PnL
        try {
            const shortTrades = await exchanges[shortExchange].fetchMyTrades(shortOriginalSymbol, undefined, 1, { orderId: closeShortOrder.id });
            if (shortTrades.length > 0 && shortTrades[0].info?.realizedPnl) {
                shortSidePnl = parseFloat(shortTrades[0].info.realizedPnl);
            }
        } catch (e) { safeLog('error', `[BOT_PNL] ❌ Lỗi lấy PnL SHORT: ${e.message}`); }
        try {
            const longTrades = await exchanges[longExchange].fetchMyTrades(longOriginalSymbol, undefined, 1, { orderId: closeLongOrder.id });
            if (longTrades.length > 0 && longTrades[0].info?.realizedPnl) {
                longSidePnl = parseFloat(longTrades[0].info.realizedPnl);
            }
        } catch (e) { safeLog('error', `[BOT_PNL] ❌ Lỗi lấy PnL LONG: ${e.message}`); }

        const cyclePnl = shortSidePnl + longSidePnl;
        cumulativePnl += cyclePnl;

        tradeHistory.unshift({
            id: Date.now(), coin, exchanges: `${shortExchange}/${longExchange}`,
            fundingDiff: currentSelectedOpportunityForExecution?.fundingDiff,
            estimatedPnl: currentSelectedOpportunityForExecution?.estimatedPnl,
            actualPnl: parseFloat(cyclePnl.toFixed(2)),
            timestamp: new Date().toISOString()
        });
        if (tradeHistory.length > 50) tradeHistory.pop();

        safeLog('log', `[BOT_PNL] ✅ Chu kỳ ${coin} hoàn tất. PnL: ${cyclePnl.toFixed(2)} USDT. Tổng PnL: ${cumulativePnl.toFixed(2)} USDT.`);
    } catch (e) {
        safeLog('error', `[BOT_PNL] ❌ Lỗi khi đóng vị thế: ${e.message}`, e);
    } finally {
        currentSelectedOpportunityForExecution = null;
        currentTradeDetails = null;
    }
}

let serverDataGlobal = null;

async function mainBotLoop() {
    if (botLoopIntervalId) clearTimeout(botLoopIntervalId);
    if (botState !== 'RUNNING') return;

    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentSecond = now.getUTCSeconds();
    const minuteAligned = Math.floor(now.getTime() / 60000);

    if (currentSecond % DATA_FETCH_INTERVAL_SECONDS === 0 && LAST_ACTION_TIMESTAMP.dataFetch !== currentSecond) {
        LAST_ACTION_TIMESTAMP.dataFetch = currentSecond;
        const fetchedData = await fetchDataFromServer();
        if (fetchedData) {
            serverDataGlobal = fetchedData;
            await processServerData(serverDataGlobal);
        }
    }

    if (currentMinute === 50 && currentSecond < 5 && !currentTradeDetails && !currentSelectedOpportunityForExecution) {
        if (LAST_ACTION_TIMESTAMP.selectionTime !== minuteAligned) {
            LAST_ACTION_TIMESTAMP.selectionTime = minuteAligned;
            let bestOpportunityFoundForExecution = null;
            for (const op of allCurrentOpportunities) {
                const minutesUntilFunding = (op.nextFundingTime - now.getTime()) / 60000;
                if (op.estimatedPnl >= MIN_PNL_PERCENTAGE && minutesUntilFunding > 0 && minutesUntilFunding < MIN_MINUTES_FOR_EXECUTION) {
                    if (!bestOpportunityFoundForExecution || minutesUntilFunding < bestOpportunityFoundForExecution.details.minutesUntilFunding) {
                        bestOpportunityFoundForExecution = op;
                    }
                }
            }

            if (bestOpportunityFoundForExecution) {
                currentSelectedOpportunityForExecution = bestOpportunityFoundForExecution;
                safeLog('log', `[BOT_LOOP] ✅ Bot đã chọn cơ hội: ${currentSelectedOpportunityForExecution.coin} trên ${currentSelectedOpportunityForExecution.exchanges}.`);
            }
        }
    }

    if (currentMinute === 59 && currentSecond >= 55 && currentSecond < 59 && currentSelectedOpportunityForExecution && !currentTradeDetails) {
        if (LAST_ACTION_TIMESTAMP.tradeExecution !== minuteAligned) {
            LAST_ACTION_TIMESTAMP.tradeExecution = minuteAligned;
            safeLog('log', `[BOT_LOOP] ⚡ Kích hoạt mở lệnh cho ${currentSelectedOpportunityForExecution.coin}.`);
            botState = 'EXECUTING_TRADES';
            const tradeSuccess = await executeTrades(currentSelectedOpportunityForExecution, currentPercentageToUse);
            if (!tradeSuccess) {
                currentSelectedOpportunityForExecution = null;
                currentTradeDetails = null;
            }
            botState = 'RUNNING';
        }
    }

    if (currentMinute === 0 && currentSecond >= 5 && currentSecond < 10 && currentTradeDetails?.status === 'OPEN') {
        if (LAST_ACTION_TIMESTAMP.closeTrade !== minuteAligned) {
            LAST_ACTION_TIMESTAMP.closeTrade = minuteAligned;
            safeLog('log', '[BOT_LOOP] 🛑 Kích hoạt đóng lệnh.');
            botState = 'CLOSING_TRADES';
            await closeTradesAndCalculatePnL();
            botState = 'RUNNING';
        }
    }

    botLoopIntervalId = setTimeout(mainBotLoop, 1000);
}

function startBot() {
    if (botState === 'STOPPED') {
        safeLog('log', '[BOT] ▶️ Khởi động Bot...');
        botState = 'RUNNING';
        updateBalances().then(() => mainBotLoop());
        return true;
    }
    return false;
}

function stopBot() {
    if (botState !== 'STOPPED') {
        safeLog('log', '[BOT] ⏸️ Dừng Bot...');
        if (botLoopIntervalId) clearTimeout(botLoopIntervalId);
        botLoopIntervalId = null;
        botState = 'STOPPED';
        return true;
    }
    return false;
}

// ... Phần server giữ nguyên ...
const botServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            if (err) { res.writeHead(500); res.end('Error reading index.html'); return; }
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
            res.end(content);
        });
    } else if (req.url === '/bot-api/status' && req.method === 'GET') {
        const statusData = {
            botState, balances: Object.fromEntries(Object.entries(balances).filter(([id]) => activeExchangeIds.includes(id) || id === 'totalOverall')),
            initialTotalBalance, cumulativePnl, tradeHistory,
            currentSelectedOpportunity: bestPotentialOpportunityForDisplay,
            currentTradeDetails: currentTradeDetails && currentTradeDetails.status === 'OPEN' ? currentTradeDetails : null
        };
        res.writeHead(200); res.end(JSON.stringify(statusData));
    } else if (req.url === '/bot-api/start' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = body ? JSON.parse(body) : {};
                currentPercentageToUse = parseFloat(data.percentageToUse);
                if (isNaN(currentPercentageToUse) || currentPercentageToUse < 1 || currentPercentageToUse > 100) currentPercentageToUse = 50;
                const started = startBot();
                res.writeHead(200); res.end(JSON.stringify({ success: started, message: started ? 'Bot đã khởi động.' : 'Bot đã chạy.' }));
            } catch (e) { res.writeHead(400); res.end(JSON.stringify({ success: false, message: 'Lỗi.' })); }
        });
    } else if (req.url === '/bot-api/stop' && req.method === 'POST') {
        const stopped = stopBot();
        res.writeHead(200); res.end(JSON.stringify({ success: stopped, message: stopped ? 'Bot đã dừng.' : 'Bot không hoạt động.' }));
    } else if (req.url === '/bot-api/test-trade' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            if (!bestPotentialOpportunityForDisplay) { res.writeHead(400); res.end(JSON.stringify({ success: false, message: 'Không có cơ hội nào để test.' })); return; }
            if (currentTradeDetails?.status === 'OPEN') { res.writeHead(409); res.end(JSON.stringify({ success: false, message: 'Đã có lệnh đang mở.' })); return; }
            const testOpportunity = bestPotentialOpportunityForDisplay;
            const originalSelected = currentSelectedOpportunityForExecution;
            currentSelectedOpportunityForExecution = testOpportunity;
            const tradeSuccess = await executeTrades(testOpportunity, 1); // Test with 1%
            currentSelectedOpportunityForExecution = originalSelected;
            if (tradeSuccess) { res.writeHead(200); res.end(JSON.stringify({ success: true, message: 'Lệnh TEST đã được gửi.' })); } 
            else { res.writeHead(500); res.end(JSON.stringify({ success: false, message: 'Lỗi khi gửi lệnh TEST.' })); }
        });
    } else if (req.url === '/bot-api/stop-test-trade' && req.method === 'POST') {
        if (!currentTradeDetails) { res.writeHead(200); res.end(JSON.stringify({ success: false, message: 'Không có lệnh nào đang mở.' })); return; }
        await closeTradesAndCalculatePnL();
        res.writeHead(200); res.end(JSON.stringify({ success: true, message: 'Đã gửi lệnh đóng vị thế.' }));
    } else {
        res.writeHead(404); res.end('Not Found');
    }
});

botServer.listen(BOT_PORT, () => {
    safeLog('log', `✅ Máy chủ UI của Bot đang chạy tại http://localhost:${BOT_PORT}`);
});
