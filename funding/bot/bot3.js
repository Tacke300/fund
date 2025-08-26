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

/**
 * Hàm giúp chuyển đổi symbol từ định dạng BASEQUOTE (ví dụ: BTCUSDT)
 * sang định dạng thống nhất BASE/QUOTE (ví dụ: BTC/USDT) mà CCXT mong đợi.
 * @param {string} baseQuoteSymbol Symbol cần chuyển đổi.
 * @returns {string} Symbol ở định dạng thống nhất.
 */
function convertToUnifiedSymbol(baseQuoteSymbol) {
    if (typeof baseQuoteSymbol === 'string') {
        // Một số sàn có thể sử dụng token khác ngoài USDT, nhưng phổ biến nhất là USDT
        // Cần điều chỉnh regex nếu có nhiều stablecoin khác
        const match = baseQuoteSymbol.match(/^(.+)(USDT|USD)$/i); // Bắt cả USDT và USD
        if (match && match[1] && match[2]) {
            const base = match[1].toUpperCase();
            const quote = match[2].toUpperCase();
            return `${base}/${quote}`;
        }
    }
    // Nếu không khớp hoặc đã ở định dạng thống nhất (ví dụ: BTC/USDT), trả về nguyên trạng
    return baseQuoteSymbol;
}


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
            await exchange.loadMarkets(true); // Tải markets cho sàn

            const accountBalance = await exchange.fetchBalance({ 'type': 'future' });
            const usdtFreeBalance = accountBalance.free?.USDT || 0;
            const usdtTotalBalance = accountBalance.total?.USDT || 0;

            balances[id].available = usdtFreeBalance;
            balances[id].total = usdtTotalBalance;
            // balances[id].originalSymbol = {}; // Dòng này không còn cần thiết ở đây nữa
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

    for (const op of serverData.arbitrageData) {
        const minutesUntilFunding = (op.nextFundingTime - now) / (1000 * 60);
        const shortExIdNormalized = op.details.shortExchange.toLowerCase() === 'binance' ? 'binanceusdm' : op.details.shortExchange.toLowerCase();
        const longExIdNormalized = op.details.longExchange.toLowerCase() === 'binance' ? 'binanceusdm' : op.details.longExchange.toLowerCase();

        if (DISABLED_EXCHANGES.includes(shortExIdNormalized) || DISABLED_EXCHANGES.includes(longExIdNormalized) ||
            !exchanges[shortExIdNormalized] || !exchanges[longExIdNormalized]) {
            safeLog('warn', `[PROCESS_DATA] Bỏ qua cơ hội ${op.coin} vì sàn ${shortExIdNormalized} hoặc ${longExIdNormalized} bị tắt hoặc chưa được khởi tạo.`);
            continue;
        }

        let shortOriginalSymbol = null;
        let longOriginalSymbol = null;

        // --- SỬA ĐỔI TẠI ĐÂY: Chuyển đổi op.coin sang định dạng thống nhất ---
        const unifiedCoinSymbol = convertToUnifiedSymbol(op.coin);

        // Lấy mã hiệu gốc của sàn bằng cách sử dụng markets đã tải
        try {
            const shortMarket = exchanges[shortExIdNormalized].market(unifiedCoinSymbol);
            if (shortMarket && shortMarket.id) {
                shortOriginalSymbol = shortMarket.id;
            } else {
                safeLog('warn', `[PROCESS_DATA] Không tìm thấy market CCXT cho symbol thống nhất "${unifiedCoinSymbol}" trên sàn ${shortExIdNormalized}. Bỏ qua cơ hội này.`);
                continue;
            }
        } catch (e) {
            safeLog('error', `[PROCESS_DATA] Lỗi khi lấy market cho ${unifiedCoinSymbol} trên sàn ${shortExIdNormalized}: ${e.message}. Bỏ qua cơ hội này.`);
            continue;
        }

        try {
            const longMarket = exchanges[longExIdNormalized].market(unifiedCoinSymbol);
            if (longMarket && longMarket.id) {
                longOriginalSymbol = longMarket.id;
            } else {
                safeLog('warn', `[PROCESS_DATA] Không tìm thấy market CCXT cho symbol thống nhất "${unifiedCoinSymbol}" trên sàn ${longExIdNormalized}. Bỏ qua cơ hội này.`);
                continue;
            }
        } catch (e) {
            safeLog('error', `[PROCESS_DATA] Lỗi khi lấy market cho ${unifiedCoinSymbol} trên sàn ${longExIdNormalized}: ${e.message}. Bỏ qua cơ hội này.`);
            continue;
        }

        // Gán các mã hiệu gốc đã lấy được vào đối tượng details
        op.details.shortOriginalSymbol = shortOriginalSymbol;
        op.details.longOriginalSymbol = longOriginalSymbol;

        // Tiếp tục xử lý cơ hội như hiện có nếu các symbol đã được lấy thành công
        if (op.estimatedPnl > 0 && minutesUntilFunding > 0) {
            op.details.minutesUntilFunding = minutesUntilFunding;
            op.details.shortFundingRate = op.details.shortRate !== undefined ? op.details.shortRate : 'N/A';
            op.details.longFundingRate = op.details.longRate !== undefined ? op.details.longRate : 'N/A';
            op.fundingDiff = op.fundingDiff !== undefined ? op.fundingDiff : 'N/A';
            op.commonLeverage = op.commonLeverage !== undefined ? op.commonLeverage : 'N/A';

            let currentShortExId = shortExIdNormalized;
            let currentLongExId = longExIdNormalized;
            let currentShortOriginalSymbol = op.details.shortOriginalSymbol;
            let currentLongOriginalSymbol = op.details.longOriginalSymbol;

            // Logic đảo chiều sàn nếu shortRate < longRate
            if (typeof op.details.shortFundingRate === 'number' && typeof op.details.longFundingRate === 'number') {
                if (op.details.shortFundingRate < op.details.longFundingRate) {
                    // Đảo luôn cả exchange ID và original symbol
                    const tempExId = currentShortExId;
                    currentShortExId = currentLongExId;
                    currentLongExId = tempExId;

                    const tempSymbol = currentShortOriginalSymbol;
                    currentShortOriginalSymbol = currentLongOriginalSymbol;
                    currentLongOriginalSymbol = tempSymbol;
                }
            }
            op.details.shortExchange = currentShortExId;
            op.details.longExchange = currentLongExId;
            op.details.shortOriginalSymbol = currentShortOriginalSymbol;
            op.details.longOriginalSymbol = currentLongOriginalSymbol;

            tempAllOpportunities.push(op);

            if (!bestForDisplay ||
                op.estimatedPnl > bestForDisplay.estimatedPnl ||
                (op.estimatedPnl === bestForDisplay.estimatedPnl && minutesUntilFunding < bestForDisplay.details.minutesUntilFunding)
            ) {
                bestForDisplay = op;
            }
        }
    }

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


async function getMaxLeverageForSymbol(exchange, symbol) {
    try {
        await exchange.loadMarkets(true);
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
                if (market.maxLever) {
                    maxLeverage = parseInt(market.maxLever, 10);
                } else if (market.info && market.info.maxLever) {
                    maxLeverage = parseInt(market.info.maxLever, 10);
                } else {
                    safeLog('warn', `[HELPER] Không tìm thấy maxLever trực tiếp cho ${symbol} trên OKX. Thử lấy từ leverage tiers (nếu có).`);
                    try {
                        const leverageTiers = await exchange.fetchLeverageTiers([symbol]);
                        if (leverageTiers && leverageTiers[symbol] && leverageTiers[symbol].length > 0) {
                            if (leverageTiers[symbol][0] && leverageTiers[symbol][0].maxLeverage) {
                                maxLeverage = parseInt(leverageTiers[symbol][0].maxLeverage, 10);
                            }
                        }
                    } catch (tierErr) {
                        safeLog('warn', `[HELPER] Lỗi khi lấy leverage tiers cho ${symbol} trên OKX: ${tierErr.message}`);
                    }
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

    // --- Bổ sung kiểm tra chi tiết các trường bị thiếu theo yêu cầu của bạn ---
    if (!opportunity.details) {
        safeLog('error', '[BOT_TRADE] Thông tin chi tiết cơ hội thiếu trường "details". Hủy bỏ lệnh.');
        return false;
    }
    if (!opportunity.details.shortExchange) {
        safeLog('error', '[BOT_TRADE] Thông tin chi tiết cơ hội thiếu trường "shortExchange" (ID sàn short). Hủy bỏ lệnh.');
        return false;
    }
    if (!opportunity.details.longExchange) {
        safeLog('error', '[BOT_TRADE] Thông tin chi tiết cơ hội thiếu trường "longExchange" (ID sàn long). Hủy bỏ lệnh.');
        return false;
    }
    if (!opportunity.details.shortOriginalSymbol) {
        safeLog('error', '[BOT_TRADE] Thông tin chi tiết cơ hội thiếu trường "shortOriginalSymbol" (mã coin gốc cho sàn short). Hủy bỏ lệnh.');
        return false;
    }
    if (!opportunity.details.longOriginalSymbol) {
        safeLog('error', '[BOT_TRADE] Thông tin chi tiết cơ hội thiếu trường "longOriginalSymbol" (mã coin gốc cho sàn long). Hủy bỏ lệnh.');
        return false;
    }
    // --- Kết thúc phần bổ sung kiểm tra chi tiết ---

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

    let shortOrder = null, longOrder = null;
    let actualShortLeverage = null;
    let actualLongLeverage = null;

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

        // --- Set Leverage for SHORT side ---
        let desiredLeverageShort = opportunity.commonLeverage;
        if (!desiredLeverageShort || desiredLeverageShort < 1) {
            safeLog('warn', `[BOT_TRADE] Đòn bẩy từ server cho SHORT ${shortOriginalSymbol} không hợp lệ (${desiredLeverageShort}). Thử đặt đòn bẩy TỐI ĐA.`);
            desiredLeverageShort = await getMaxLeverageForSymbol(shortExchange, shortOriginalSymbol);
            if (!desiredLeverageShort) {
                safeLog('error', `[BOT_TRADE] ❌ Không thể xác định đòn bẩy tối đa cho SHORT ${shortOriginalSymbol} trên ${shortExchangeId}. HỦY BỎ LỆNH.`);
                return false;
            }
        }
        actualShortLeverage = desiredLeverageShort;

        try {
            const symbolToUseShort = typeof shortOriginalSymbol === 'string' ? shortOriginalSymbol : String(shortOriginalSymbol);
            if (shortExchange.has['setLeverage']) {
                if (shortExchangeId === 'bingx') {
                    await shortExchange.setLeverage(symbolToUseShort, actualShortLeverage, { 'side': 'BOTH' }); 
                } else if (shortExchangeId === 'binanceusdm') {
                    const binanceSymbolId = shortExchange.market(symbolToUseShort).id;
                    await shortExchange.setLeverage(binanceSymbolId, actualShortLeverage); 
                } else {
                    await shortExchange.setLeverage(symbolToUseShort, actualShortLeverage);
                }
            }
            safeLog('log', `[BOT_TRADE] ✅ Đặt đòn bẩy x${actualShortLeverage} cho SHORT ${shortOriginalSymbol} trên ${shortExchangeId}.`);
        } catch (levErr) {
            safeLog('error', `[BOT_TRADE] ❌ Lỗi khi đặt đòn bẩy x${actualShortLeverage} cho SHORT ${shortOriginalSymbol}: ${levErr.message}. HỦY BỎ LỆNH.`, levErr);
            return false;
        }

        // --- Set Leverage for LONG side ---
        let desiredLeverageLong = opportunity.commonLeverage;
        if (!desiredLeverageLong || desiredLeverageLong < 1) {
            safeLog('warn', `[BOT_TRADE] Đòn bẩy từ server cho LONG ${longOriginalSymbol} không hợp lệ (${desiredLeverageLong}). Thử đặt đòn bẩy TỐI ĐA.`);
            desiredLeverageLong = await getMaxLeverageForSymbol(longExchange, longOriginalSymbol);
            if (!desiredLeverageLong) {
                safeLog('error', `[BOT_TRADE] ❌ Không thể xác định đòn bẩy tối đa cho LONG ${longOriginalSymbol} trên ${longExchangeId}. HỦY BỎ LỆNH.`);
                return false;
            }
        }
        actualLongLeverage = desiredLeverageLong;

        try {
            const symbolToUseLong = typeof longOriginalSymbol === 'string' ? longOriginalSymbol : String(longOriginalSymbol);
            if (longExchange.has['setLeverage']) {
                if (longExchangeId === 'bingx') {
                    await longExchange.setLeverage(symbolToUseLong, actualLongLeverage, { 'side': 'BOTH' });
                } else if (longExchangeId === 'binanceusdm') {
                    const binanceSymbolId = longExchange.market(symbolToUseLong).id;
                    await longExchange.setLeverage(binanceSymbolId, actualLongLeverage);
                } else {
                    await longExchange.setLeverage(symbolToUseLong, actualLongLeverage);
                }
            }
            safeLog('log', `[BOT_TRADE] ✅ Đặt đòn bẩy x${actualLongLeverage} cho LONG ${longOriginalSymbol} trên ${longExchangeId}.`);
        } catch (levErr) {
            safeLog('error', `[BOT_TRADE] ❌ Lỗi khi đặt đòn bẩy x${actualLongLeverage} cho LONG ${longOriginalSymbol}: ${levErr.message}. HỦY BỎ LỆNH.`, levErr);
            return false;
        }
        
        const shortAmount = (shortCollateral * actualShortLeverage) / shortEntryPrice;
        const longAmount = (longCollateral * actualLongLeverage) / longEntryPrice;

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
            shortOriginalSymbol, longOriginalSymbol,
            shortOrderId: shortOrder.id, longOrderId: longOrder.id,
            shortOrderAmount: shortOrder.amount, longOrderAmount: longOrder.amount,
            shortEntryPrice, longEntryPrice,
            shortCollateral, longCollateral,
            commonLeverage: actualShortLeverage,
            status: 'OPEN', openTime: Date.now()
        };

        await sleep(2000);

        const shortTpPrice = shortEntryPrice * (1 - (TP_PERCENT_OF_COLLATERAL / (actualShortLeverage * 100)));
        const shortSlPrice = shortEntryPrice * (1 + (SL_PERCENT_OF_COLLATERAL / (actualShortLeverage * 100)));
        const longTpPrice = longEntryPrice * (1 + (TP_PERCENT_OF_COLLATERAL / (actualLongLeverage * 100)));
        const longSlPrice = longEntryPrice * (1 - (SL_PERCENT_OF_COLLATERAL / (actualLongLeverage * 100)));
        
        const shortTpPriceToOrder = shortExchange.priceToPrecision(shortOriginalSymbol, shortTpPrice);
        const shortSlPriceToOrder = shortExchange.priceToPrecision(shortOriginalSymbol, shortSlPrice);
        const longTpPriceToOrder = longExchange.priceToPrecision(longOriginalSymbol, longTpPrice);
        const longSlPriceToOrder = longExchange.priceToPrecision(longOriginalSymbol, longSlPrice);

        currentTradeDetails.shortSlPrice = parseFloat(shortSlPriceToOrder);
        currentTradeDetails.shortTpPrice = parseFloat(shortTpPriceToOrder);
        currentTradeDetails.longSlPrice = parseFloat(longSlPriceToOrder);
        currentTradeDetails.longTpPrice = parseFloat(longTpPriceToOrder);

        try { if (parseFloat(shortSlPriceToOrder) > 0) await shortExchange.createOrder(shortOriginalSymbol, 'STOP_MARKET', 'buy', shortOrder.amount, undefined, { 'stopPrice': parseFloat(shortSlPriceToOrder), ...shortParams }); } catch (e) { safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt SL SHORT: ${e.message}`); }
        try { if (parseFloat(shortTpPriceToOrder) > 0) await shortExchange.createOrder(shortOriginalSymbol, 'TAKE_PROFIT_MARKET', 'buy', shortOrder.amount, undefined, { 'stopPrice': parseFloat(shortTpPriceToOrder), ...shortParams }); } catch (e) { safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt TP SHORT: ${e.message}`); }
        try { if (parseFloat(longSlPriceToOrder) > 0) await longExchange.createOrder(longOriginalSymbol, 'STOP_MARKET', 'sell', longOrder.amount, undefined, { 'stopPrice': parseFloat(longSlPriceToOrder), ...longParams }); } catch (e) { safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt SL LONG: ${e.message}`); }
        try { if (parseFloat(longTpPriceToOrder) > 0) await longExchange.createOrder(longOriginalSymbol, 'TAKE_PROFIT_MARKET', 'sell', longOrder.amount, undefined, { 'stopPrice': parseFloat(longTpPriceToOrder), ...longParams }); } catch (e) { safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt TP LONG: ${e.message}`); }
        
        return true;
    } catch (e) {
        safeLog('error', `[BOT_TRADE] ❌ Lỗi nghiêm trọng khi thực hiện giao dịch: ${e.message}`, e);
        if (shortOrder?.id) { try { await exchanges[shortExchangeId].cancelOrder(shortOrder.id, shortOriginalSymbol); } catch (ce) { safeLog('error', `[BOT_TRADE] Lỗi hủy lệnh SHORT: ${ce.message}`, ce); } }
        if (longOrder?.id) { try { await exchanges[longExchangeId].cancelOrder(longOrder.id, longOriginalSymbol); } catch (ce) { safeLog('error', `[BOT_TRADE] Lỗi hủy lệnh LONG: ${ce.message}`, ce); } }
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
    const { coin, shortExchange, longExchange, shortOriginalSymbol, longOriginalSymbol, shortOrderAmount, longOrderAmount, shortCollateral, longCollateral } = currentTradeDetails;

    try {
        safeLog('log', '[BOT_PNL] Hủy các lệnh TP/SL còn chờ (nếu có)...');
        // Fetch and cancel specific symbol orders for SHORT side
        try {
            const shortOpenOrders = await exchanges[shortExchange].fetchOpenOrders(shortOriginalSymbol);
            for (const order of shortOpenOrders) {
                if ((order.type === 'stop' || order.type === 'take_profit' || order.type === 'stop_market' || order.type === 'take_profit_market') && order.status === 'open') {
                    await exchanges[shortExchange].cancelOrder(order.id, shortOriginalSymbol);
                    safeLog('log', `[BOT_PNL] Đã hủy lệnh chờ ${order.type} ${order.id} cho ${shortOriginalSymbol} trên ${shortExchange}.`);
                }
            }
        } catch (e) { safeLog('warn', `[BOT_PNL] Lỗi khi hủy lệnh chờ cho ${shortOriginalSymbol} trên ${shortExchange}: ${e.message}`, e); }
        
        // Fetch and cancel specific symbol orders for LONG side
        try {
            const longOpenOrders = await exchanges[longExchange].fetchOpenOrders(longOriginalSymbol);
            for (const order of longOpenOrders) {
                if ((order.type === 'stop' || order.type === 'take_profit' || order.type === 'stop_market' || order.type === 'take_profit_market') && order.status === 'open') {
                    await exchanges[longExchange].cancelOrder(order.id, longOriginalSymbol);
                    safeLog('log', `[BOT_PNL] Đã hủy lệnh chờ ${order.type} ${order.id} cho ${longOriginalSymbol} trên ${longExchange}.`);
                }
            }
        } catch (e) { safeLog('warn', `[BOT_PNL] Lỗi khi hủy lệnh chờ cho ${longOriginalSymbol} trên ${longExchange}: ${e.message}`, e); }

        // Parameters for closing orders on BingX (Hedge Mode) and BinanceUSDM (Hedge Mode)
        const closeShortParams = {};
        if (shortExchange === 'bingx') {
            closeShortParams.positionSide = 'SHORT';
        } else if (shortExchange === 'binanceusdm') {
            closeShortParams.positionSide = 'SHORT';
        }

        const closeLongParams = {};
        if (longExchange === 'bingx') {
            closeLongParams.positionSide = 'LONG';
        } else if (longExchange === 'binanceusdm') {
            closeLongParams.positionSide = 'LONG';
        }

        safeLog('log', `[BOT_PNL] Đóng vị thế SHORT ${coin} trên ${shortExchange} (amount: ${shortOrderAmount})...`);
        const closeShortOrder = await exchanges[shortExchange].createMarketBuyOrder(shortOriginalSymbol, shortOrderAmount, closeShortParams);
        safeLog('log', `[BOT_PNL] ✅ Vị thế SHORT trên ${shortExchange} đã đóng. Order ID: ${closeShortOrder.id}`);

        safeLog('log', `[BOT_PNL] Đóng vị thế LONG ${coin} trên ${longExchange} (amount: ${longOrderAmount})...`);
        const closeLongOrder = await exchanges[longExchange].createMarketSellOrder(longOriginalSymbol, longOrderAmount, closeLongParams);
        safeLog('log', `[BOT_PNL] ✅ Vị thế LONG trên ${longExchange} đã đóng. Order ID: ${closeLongOrder.id}`);

        safeLog('log', '[BOT_PNL] Đợi 30 giây để sàn xử lý dữ liệu PnL...');
        await sleep(30000); 

        let shortSidePnl = 0;
        let longSidePnl = 0;

        // Lấy PnL thực tế cho bên SHORT
        try {
            let pnlFound = false;
            const shortTrades = await exchanges[shortExchange].fetchMyTrades(shortOriginalSymbol, undefined, undefined, { orderId: closeShortOrder.id, limit: 10 }); 
            for (const trade of shortTrades) {
                if (trade.order === closeShortOrder.id && trade.info?.realizedPnl !== undefined) {
                    shortSidePnl = parseFloat(trade.info.realizedPnl);
                    safeLog('log', `[BOT_PNL] PnL SHORT từ trade ${trade.id} (order ${closeShortOrder.id}): ${shortSidePnl.toFixed(2)} USDT.`);
                    pnlFound = true;
                    break;
                }
            }
            if (!pnlFound) {
                safeLog('warn', `[BOT_PNL] Không tìm thấy PnL thực tế cho lệnh SHORT ${closeShortOrder.id} trên ${shortExchange} từ trade history. Cập nhật số dư và tính từ đó.`);
                await updateBalances(); 
                shortSidePnl = (balances[shortExchange]?.available || 0) - currentTradeDetails.shortCollateral;
                safeLog('log', `[BOT_PNL] PnL SHORT tính từ số dư ${shortExchange}: ${shortSidePnl.toFixed(2)} USDT.`);
            }
        } catch (e) {
            safeLog('error', `[BOT_PNL] ❌ Lỗi khi lấy PnL thực tế cho SHORT ${shortExchange}: ${e.message}`, e);
            await updateBalances(); 
            shortSidePnl = (balances[shortExchange]?.available || 0) - currentTradeDetails.shortCollateral;
            safeLog('log', `[BOT_PNL] PnL SHORT tính từ số dư (do lỗi): ${shortSidePnl.toFixed(2)} USDT.`);
        }

        // Lấy PnL thực tế cho bên LONG
        try {
            let pnlFound = false;
            const longTrades = await exchanges[longExchange].fetchMyTrades(longOriginalSymbol, undefined, undefined, { orderId: closeLongOrder.id, limit: 10 });
            for (const trade of longTrades) {
                if (trade.order === closeLongOrder.id && trade.info?.realizedPnl !== undefined) {
                    longSidePnl = parseFloat(trade.info.realizedPnl);
                    safeLog('log', `[BOT_PNL] PnL LONG từ trade ${trade.id} (order ${closeLongOrder.id}): ${longSidePnl.toFixed(2)} USDT.`);
                    pnlFound = true;
                    break;
                }
            }
            if (!pnlFound) {
                safeLog('warn', `[BOT_PNL] Không tìm thấy PnL thực tế cho lệnh LONG ${closeLongOrder.id} trên ${longExchange} từ trade history. Cập nhật số dư và tính từ đó.`);
                await updateBalances(); 
                longSidePnl = (balances[longExchange]?.available || 0) - currentTradeDetails.longCollateral;
                safeLog('log', `[BOT_PNL] PnL LONG tính từ số dư ${longExchange}: ${longSidePnl.toFixed(2)} USDT.`);
            }
        } catch (e) {
            safeLog('error', `[BOT_PNL] ❌ Lỗi khi lấy PnL thực tế cho LONG ${longExchange}: ${e.message}`, e);
            await updateBalances(); 
            longSidePnl = (balances[longExchange]?.available || 0) - currentTradeDetails.longCollateral;
            safeLog('log', `[BOT_PNL] PnL LONG tính từ số dư (do lỗi): ${longSidePnl.toFixed(2)} USDT.`);
        }

        const cyclePnl = shortSidePnl + longSidePnl;
        cumulativePnl += cyclePnl;

        tradeHistory.unshift({
            id: Date.now(),
            coin: coin,
            exchanges: `${shortExchange}/${longExchange}`,
            fundingDiff: currentSelectedOpportunityForExecution?.fundingDiff, 
            estimatedPnl: currentSelectedOpportunityForExecution?.estimatedPnl, 
            actualPnl: parseFloat(cyclePnl.toFixed(2)),
            timestamp: new Date().toISOString()
        });

        if (tradeHistory.length > 50) {
            tradeHistory.pop();
        }

        safeLog('log', `[BOT_PNL] ✅ Chu kỳ giao dịch cho ${coin} hoàn tất. PnL chu kỳ: ${cyclePnl.toFixed(2)} USDT. Tổng PnL: ${cumulativePnl.toFixed(2)} USDT.`);

    } catch (e) {
        safeLog('error', `[BOT_PNL] ❌ Lỗi khi đóng vị thế hoặc tính toán PnL: ${e.message}`, e);
    } finally {
        currentSelectedOpportunityForExecution = null; 
        safeLog('log', `[BOT] currentTradeDetails đang được đặt lại về null.`);
        currentTradeDetails = null; 
        safeLog('log', '[BOT_PNL] Dọn dẹp lệnh chờ và vị thế đã đóng (nếu có).');
    }
}

let serverDataGlobal = null;

async function mainBotLoop() {
    if (botLoopIntervalId) clearTimeout(botLoopIntervalId);

    if (botState !== 'RUNNING') {
        safeLog('log', '[BOT_LOOP] Bot không ở trạng thái RUNNING. Dừng vòng lặp.');
        return;
    }

    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentSecond = now.getUTCSeconds();

    const minuteAligned = Math.floor(now.getTime() / (60 * 1000));

    if (currentSecond % DATA_FETCH_INTERVAL_SECONDS === 0 && LAST_ACTION_TIMESTAMP.dataFetch !== currentSecond) {
        LAST_ACTION_TIMESTAMP.dataFetch = currentSecond;

        const fetchedData = await fetchDataFromServer();
        if (fetchedData) {
            serverDataGlobal = fetchedData;
            await processServerData(serverDataGlobal);
        }
    }

    if (currentMinute === 50 && currentSecond >= 0 && currentSecond < 5 && botState === 'RUNNING' && !currentTradeDetails && !currentSelectedOpportunityForExecution) {
        if (LAST_ACTION_TIMESTAMP.selectionTime !== minuteAligned) {
            LAST_ACTION_TIMESTAMP.selectionTime = minuteAligned;

            safeLog('log', `[BOT_LOOP] 🌟 Kích hoạt lựa chọn cơ hội để THỰC HIỆN tại phút ${currentMinute}:${currentSecond} giây.`);

            let bestOpportunityFoundForExecution = null;
            for (const op of allCurrentOpportunities) {
                const minutesUntilFunding = (op.nextFundingTime - now.getTime()) / (1000 * 60); 
                op.details.minutesUntilFunding = minutesUntilFunding; 

                if (op.estimatedPnl >= MIN_PNL_PERCENTAGE &&
                    minutesUntilFunding > 0 &&
                    minutesUntilFunding < MIN_MINUTES_FOR_EXECUTION && 
                    minutesUntilFunding <= MAX_MINUTES_UNTIL_FUNDING) {

                    if (!bestOpportunityFoundForExecution ||
                        minutesUntilFunding < bestOpportunityFoundForExecution.details.minutesUntilFunding ||
                        (minutesUntilFunding === bestOpportunityFoundForExecution.details.minutesUntilFunding && op.estimatedPnl > bestOpportunityFoundForExecution.estimatedPnl)
                    ) {
                        bestOpportunityFoundForExecution = op;
                    }
                }
            }

            if (bestOpportunityFoundForExecution) {
                currentSelectedOpportunityForExecution = bestOpportunityFoundForExecution;
                safeLog('log', `[BOT_LOOP] ✅ Bot đã chọn cơ hội: ${currentSelectedOpportunityForExecution.coin} trên ${currentSelectedOpportunityForExecution.exchanges} để THỰC HIỆN.`);
                safeLog('log', `  Thông tin chi tiết: PnL ước tính: ${currentSelectedOpportunityForExecution.estimatedPnl.toFixed(2)}%, Funding trong: ${currentSelectedOpportunityForExecution.details.minutesUntilFunding.toFixed(1)} phút.`);
                safeLog('log', `  Sàn Short: ${currentSelectedOpportunityForExecution.details.shortExchange} (${currentSelectedOpportunityForExecution.details.shortOriginalSymbol}), Sàn Long: ${currentSelectedOpportunityForExecution.details.longExchange} (${currentSelectedOpportunityForExecution.details.longOriginalSymbol})`);
                
                const shortExId = currentSelectedOpportunityForExecution.details.shortExchange.toLowerCase() === 'binance' ? 'binanceusdm' : currentSelectedOpportunityForExecution.details.shortExchange.toLowerCase();
                const longExId = currentSelectedOpportunityForExecution.details.longExchange.toLowerCase() === 'binance' ? 'binanceusdm' : currentSelectedOpportunityForExecution.details.longExchange.toLowerCase();
                const minAvailableBalanceForDisplay = Math.min(balances[shortExId]?.available || 0, balances[longExId]?.available || 0);
                bestPotentialOpportunityForDisplay.estimatedTradeCollateral = (minAvailableBalanceForDisplay * (currentPercentageToUse / 100)).toFixed(2);
                safeLog('log', `  Vốn dự kiến: ${bestPotentialOpportunityForDisplay.estimatedTradeCollateral} USDT`);

                safeLog('log', '[BOT_LOOP] Bỏ qua bước chuyển tiền. Tiền phải có sẵn trên các sàn.');

            } else {
                safeLog('log', `[BOT_LOOP] 🔍 Không tìm thấy cơ hội nào đủ điều kiện để THỰC HIỆN tại phút ${currentMinute}.`);
                currentSelectedOpportunityForExecution = null;
            }
        }
    }

    if (currentMinute === 59 && currentSecond >= 55 && currentSecond < 59 && botState === 'RUNNING' && currentSelectedOpportunityForExecution && !currentTradeDetails) {
        if (LAST_ACTION_TIMESTAMP.tradeExecution !== minuteAligned) {
            LAST_ACTION_TIMESTAMP.tradeExecution = minuteAligned;

            safeLog('log', `[BOT_LOOP] ⚡ Kích hoạt mở lệnh cho cơ hội ${currentSelectedOpportunityForExecution.coin} vào phút 59:55.`);
            botState = 'EXECUTING_TRADES';
            const tradeSuccess = await executeTrades(currentSelectedOpportunityForExecution, currentPercentageToUse);
            if (tradeSuccess) {
                safeLog('log', '[BOT_LOOP] ✅ Mở lệnh hoàn tất.');
            } else {
                safeLog('error', '[BOT_LOOP] ❌ Lỗi mở lệnh. Hủy chu kỳ này.');
                currentSelectedOpportunityForExecution = null;
                currentTradeDetails = null;
            }
            botState = 'RUNNING';
        }
    }

    if (currentMinute === 0 && currentSecond >= 5 && currentSecond < 10 && botState === 'RUNNING' && currentTradeDetails?.status === 'OPEN') {
        if (LAST_ACTION_TIMESTAMP.closeTrade !== minuteAligned) {
            LAST_ACTION_TIMESTAMP.closeTrade = minuteAligned;

            safeLog('log', '[BOT_LOOP] 🛑 Kích hoạt đóng lệnh và tính PnL vào phút 00:05.');
            botState = 'CLOSING_TRADES';
            
            closeTradesAndCalculatePnL()
                .then(() => {
                    safeLog('log', '[BOT_LOOP] ✅ Đóng lệnh và tính PnL hoàn tất (qua Promise.then).');
                })
                .catch(errorInClose => {
                    safeLog('error', `[BOT_LOOP] ❌ Lỗi khi đóng lệnh và tính PnL (qua Promise.catch): ${errorInClose.message}`, errorInClose);
                })
                .finally(() => {
                    botState = 'RUNNING';
                });
        }
    }

    botLoopIntervalId = setTimeout(() => { mainBotLoop(); }, 1000);
}

function startBot() {
    if (botState === 'STOPPED') {
        safeLog('log', '[BOT] ▶️ Khởi động Bot...');
        botState = 'RUNNING';
        updateBalances().then(() => {
            safeLog('log', '[BOT] Đã cập nhật số dư ban đầu. Bắt đầu vòng lặp bot.');
            mainBotLoop();
        }).catch(err => {
            safeLog('error', `[BOT] Lỗi khi khởi tạo số dư ban đầu: ${err.message}`, err);
            botState = 'STOPPED';
        });
        return true;
    }
    safeLog('warn', '[BOT] Bot đã chạy hoặc đang trong quá trình chuyển trạng thái.');
    return false;
}

function stopBot() {
    if (botState === 'RUNNING' || botState === 'FETCHING_DATA' || botState === 'PROCESSING_DATA' || botState === 'EXECUTING_TRADES' || botState === 'CLOSING_TRADES') {
        safeLog('log', '[BOT] ⏸️ Dừng Bot...');
        if (botLoopIntervalId) {
            clearTimeout(botLoopIntervalId);
            botLoopIntervalId = null;
        }
        botState = 'STOPPED';
        safeLog('log', '[BOT] Bot đã dừng thành công.');
        return true;
    }
    safeLog('warn', '[BOT] Bot không hoạt động hoặc không thể dừng.');
    return false;
}

const botServer = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            if (err) {
                safeLog('error', '[BOT_SERVER] ❌ Lỗi khi đọc index.html:', err.message, err);
                res.writeHead(500);
                res.end('Lỗi khi đọc index.html');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
            res.end(content);
        });
    } else if (req.url === '/bot-api/status' && req.method === 'GET') {
        let displayCurrentTradeDetails = null;
        try {
            if (currentTradeDetails && typeof currentTradeDetails === 'object' && currentTradeDetails.status === 'OPEN') {
                displayCurrentTradeDetails = currentTradeDetails;
            } else {
                displayCurrentTradeDetails = null;
            }
        } catch (e) {
            safeLog('error', `[BOT_SERVER] CRITICAL EXCEPTION accessing currentTradeDetails for status API: ${e.message}. Setting to null.`, e);
            displayCurrentTradeDetails = null;
        }

        const statusData = {
            botState: botState,
            balances: Object.fromEntries(Object.entries(balances).filter(([id]) => activeExchangeIds.includes(id) || id === 'totalOverall')),
            initialTotalBalance: initialTotalBalance,
            cumulativePnl: cumulativePnl,
            tradeHistory: tradeHistory,
            currentSelectedOpportunity: bestPotentialOpportunityForDisplay,
            currentTradeDetails: displayCurrentTradeDetails
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(statusData));
    } else if (req.url === '/bot-api/start' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const data = body ? JSON.parse(body) : {};
                currentPercentageToUse = parseFloat(data.percentageToUse);
                if (isNaN(currentPercentageToUse) || currentPercentageToUse < 1 || currentPercentageToUse > 100) {
                    currentPercentageToUse = 50;
                    safeLog('warn', `Giá trị phần trăm vốn không hợp lệ từ UI, sử dụng mặc định: ${currentPercentageToUse}%`);
                }

                const started = startBot();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: started, message: started ? 'Bot đã khởi động.' : 'Bot đã chạy.' }));
            } catch (error) {
                safeLog('error', '[BOT_SERVER] ❌ Lỗi xử lý POST /bot-api/start:', error.message, error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Dữ liệu yêu cầu không hợp lệ hoặc lỗi server.' }));
            }
        });
    } else if (req.url === '/bot-api/stop' && req.method === 'POST') {
        const stopped = stopBot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: stopped, message: stopped ? 'Bot đã dừng.' : 'Bot không hoạt động.' }));
    } else if (req.url === '/bot-api/test-trade' && req.method === 'POST') { 
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const data = body ? JSON.parse(body) : {};
                const testPercentageToUse = parseFloat(data.percentageToUse);

                if (isNaN(testPercentageToUse) || testPercentageToUse < 1 || testPercentageToUse > 100) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Phần trăm vốn không hợp lệ (1-100).' }));
                    return;
                }

                if (!bestPotentialOpportunityForDisplay) {
                    safeLog('warn', '[BOT_SERVER] Không tìm thấy cơ hội nào đang được hiển thị trên UI. Không thể thực hiện lệnh test.');
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Không tìm thấy cơ hội arbitrage nào để test. Vui lòng đảm bảo có cơ hội được hiển thị trên UI.' }));
                    return;
                }

                if (currentTradeDetails && currentTradeDetails.status === 'OPEN') {
                    safeLog('warn', '[BOT_SERVER] Đã có lệnh đang mở. Không thể thực hiện lệnh test khi có lệnh đang được theo dõi.');
                    res.writeHead(409, { 'Content-Type': 'application/json' }); 
                    res.end(JSON.stringify({ success: false, message: 'Đã có lệnh đang mở. Vui lòng đóng lệnh hiện tại trước khi thực hiện lệnh test.' }));
                    return;
                }
                
                const testOpportunity = bestPotentialOpportunityForDisplay;

                safeLog('log', `[BOT_SERVER] ⚡ Yêu cầu TEST MỞ LỆNH: ${testOpportunity.coin} trên ${testOpportunity.exchanges} với ${testPercentageToUse}% vốn.`);
                safeLog('log', '[BOT_SERVER] Thông tin cơ hội Test:', testOpportunity);

                const originalCurrentSelectedOpportunityForExecution = currentSelectedOpportunityForExecution;
                currentSelectedOpportunityForExecution = testOpportunity; 

                const tradeSuccess = await executeTrades(testOpportunity, testPercentageToUse);

                currentSelectedOpportunityForExecution = originalCurrentSelectedOpportunityForExecution;

                if (tradeSuccess) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Lệnh TEST đã được gửi thành công!' }));
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Có lỗi xảy ra khi gửi lệnh TEST. Vui lòng kiểm tra log bot.' }));
                }

            } catch (error) {
                safeLog('error', '[BOT_SERVER] ❌ Lỗi xử lý POST /bot-api/test-trade:', error.message, error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Lỗi server khi thực hiện lệnh test.' }));
            }
        });
    } else if (req.url === '/bot-api/stop-test-trade' && req.method === 'POST') { 
        try {
            if (!currentTradeDetails || currentTradeDetails.status !== 'OPEN') {
                safeLog('log', '[BOT_SERVER] Yêu cầu dừng lệnh nhưng không có lệnh nào đang mở để dừng.');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Không có lệnh nào đang mở để dừng.' }));
                return;
            }

            safeLog('log', '[BOT_SERVER] 🛑 Yêu cầu DỪNG LỆNH ĐANG MỞ (có thể là lệnh test hoặc lệnh tự động).');
            closeTradesAndCalculatePnL()
                .then(() => {
                    safeLog('log', '[BOT_SERVER] ✅ Đóng lệnh và tính PnL hoàn tất (qua Promise.then trong API stop-test-trade).');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Đã gửi lệnh đóng vị thế thành công.' }));
                })
                .catch(errorInClose => {
                    safeLog('error', `[BOT_SERVER] ❌ Lỗi khi đóng lệnh và tính PnL (qua Promise.catch trong API stop-test-trade): ${errorInClose.message}`, errorInClose);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Lỗi server khi dừng lệnh.' }));
                });

        } catch (error) {
            safeLog('error', '[BOT_SERVER] ❌ Lỗi xử lý POST /bot-api/stop-test-trade:', error.message, error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Lỗi server khi dừng lệnh.' }));
        }
    }
    else {
        res.writeHead(404); res.end('Not Found');
    }
});

botServer.listen(BOT_PORT, () => {
    safeLog('log', `✅ Máy chủ UI của Bot đang chạy tại http://localhost:${BOT_PORT}`);
    safeLog('log', 'Bot đang chờ lệnh "Start" từ giao diện HTML.');
});
