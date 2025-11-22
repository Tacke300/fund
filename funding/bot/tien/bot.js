const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const { usdtDepositAddressesByNetwork } = require('./balance.js');
const {
    binanceApiKey, binanceApiSecret,
    okxApiKey, okxApiSecret, okxPassword,
    bitgetApiKey, bitgetApiSecret, bitgetApiPassword,
    kucoinApiKey, kucoinApiSecret, kucoinApiPassword
} = require('./config.js');

const BOT_PORT = 5004;
const SERVER_DATA_URL = 'http://localhost:5005/api/data';
const HUB_EXCHANGE_ID = 'binanceusdm';

const MIN_PNL_PERCENTAGE = 1;
const MIN_MINUTES_FOR_EXECUTION = 15; // Chỉ trade nếu còn dưới 15 phút tới giờ Funding
const DATA_FETCH_INTERVAL_SECONDS = 1;
const MAX_CONSEC_FAILS = 3;
const MIN_COLLATERAL_FOR_TRADE = 0.1;

// [CONFIG] Cấu hình Phút bắt đầu chạy Test (0-59)
const TEST_START_MINUTE = 50; 

// [CONFIG] Cấu hình TP / SL (Theo % Vốn lệnh)
const SL_PERCENTAGE = 90; 
const TP_PERCENTAGE = 155; 

// [CONFIG] Cấu hình lệnh TEST (0.3$)
const TEST_TRADE_MARGIN = 0.3; 

const FUND_TRANSFER_MIN_AMOUNT_BINANCE = 10;
const FUND_TRANSFER_MIN_AMOUNT_KUCOIN = 1;
const FUND_TRANSFER_MIN_AMOUNT_BITGET = 10;

const MIN_TOTAL_CAPITAL_FOR_DISTRIBUTION = 5;
const FUND_ARRIVAL_TOLERANCE = 2; 

const ALL_POSSIBLE_EXCHANGE_IDS = ['binanceusdm', 'bitget', 'okx', 'kucoinfutures', 'kucoin', 'binance'];
const DISABLED_EXCHANGES = [];
const activeExchangeIds = ALL_POSSIBLE_EXCHANGE_IDS.filter(id => !DISABLED_EXCHANGES.includes(id));

let botState = 'STOPPED';
let capitalManagementState = 'IDLE';
let botLoopIntervalId = null;
let balances = {};
let tradeHistory = [];
let bestPotentialOpportunityForDisplay = null;
let allCurrentOpportunities = [];
let currentTradeDetails = null;
let tradeAwaitingPnl = null;
let currentPercentageToUse = 50;
let exchangeHealth = {};
let transferStatus = { inProgress: false, message: null };
let selectedOpportunityForNextTrade = null;
let hasLoggedNotFoundThisHour = false;
let isRunningTestSequence = false; 
let failedCoinsInSession = new Set();

const safeLog = (type, ...args) => {
    try {
        const timestamp = new Date().toLocaleTimeString('vi-VN');
        const message = args.map(arg => (arg instanceof Error) ? (arg.stack || arg.message) : (typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg)).join(' ');
        console[type](`[${timestamp} ${type.toUpperCase()}]`, message);
    } catch (e) { process.stderr.write(`FATAL LOG ERROR: ${e.message}\n`); }
};

const exchanges = {};
activeExchangeIds.forEach(id => {
    balances[id] = { available: 0, total: 0 };
    exchangeHealth[id] = { consecutiveFails: 0, isDisabled: false };
    try {
        let exchangeClass, config = { 'enableRateLimit': true, 'verbose': false };

        if (id === 'binanceusdm') { 
            exchangeClass = ccxt.binanceusdm; 
            config.apiKey = binanceApiKey; 
            config.secret = binanceApiSecret; 
            config.options = { 'defaultType': 'swap' };
        } else if (id === 'binance') {
            exchangeClass = ccxt.binance; 
            config.apiKey = binanceApiKey; 
            config.secret = binanceApiSecret;
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
        } else if (id === 'kucoinfutures') { 
            exchangeClass = ccxt.kucoinfutures; 
            config.apiKey = kucoinApiKey; 
            config.secret = kucoinApiSecret; 
            config.password = kucoinApiPassword; 
        } else if (id === 'kucoin') {
            exchangeClass = ccxt.kucoin; 
            config.apiKey = kucoinApiKey; 
            config.secret = kucoinApiSecret; 
            config.password = kucoinApiPassword;
        }
        
        if (exchangeClass && config.apiKey && config.secret) { 
            exchanges[id] = new exchangeClass(config); 
            safeLog('log', `[INIT] Khởi tạo sàn ${id.toUpperCase()} thành công.`); 
            
            if (id === 'binanceusdm') {
                setTimeout(async () => {
                    try {
                        await exchanges[id].fapiPrivatePostPositionSideDual({ 'dualSidePosition': 'true' });
                        safeLog('info', `[INIT] ✅ Đã chuyển Binance sang HEDGE MODE.`);
                    } catch (e) {
                        if (!e.message.includes("-4046")) { 
                            safeLog('warn', `[INIT] Không thể chuyển Binance sang Hedge Mode: ${e.message}`);
                        }
                    }
                }, 2000);
            }

        } else if (exchangeClass) { 
            safeLog('warn', `[INIT] Bỏ qua ${id.toUpperCase()} do thiếu API Key/Secret.`); 
        }
    } catch (e) { 
        safeLog('error', `[INIT] Lỗi khi khởi tạo sàn ${id.toUpperCase()}: ${e}`); 
    }
});

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

function getMinTransferAmount(exchangeId) {
    if (exchangeId === 'binanceusdm') return FUND_TRANSFER_MIN_AMOUNT_BINANCE;
    if (exchangeId === 'kucoinfutures') return FUND_TRANSFER_MIN_AMOUNT_KUCOIN;
    if (exchangeId === 'bitget') return FUND_TRANSFER_MIN_AMOUNT_BITGET;
    return 5;
}

function getTargetDepositInfo(toExchangeId, network) {
    const depositAddress = usdtDepositAddressesByNetwork[toExchangeId]?.[network];
    if (!depositAddress || depositAddress.startsWith('ĐIỀN ĐỊA CHỈ')) {
        safeLog('error', `[HELPER] Lỗi: Địa chỉ nạp tiền cho ${toExchangeId.toUpperCase()} qua mạng ${network} chưa được cấu hình.`);
        return null;
    }
    return { network, address: depositAddress };
}

function getWithdrawParams(exchangeId, network) {
    const networkUpper = network.toUpperCase();
    if (exchangeId.includes('binance')) {
        if (networkUpper === 'BEP20') return { network: 'BSC' };
    }
    if (exchangeId.includes('kucoin')) {
        if (networkUpper === 'APTOS') return { network: 'APT' };
    }
    if (exchangeId.includes('bitget')) {
        if (networkUpper === 'BEP20') return { chain: 'BEP20', network: 'BEP20' };
    }
    if (exchangeId.includes('okx')) {
        if (networkUpper === 'BEP20') return { chain: 'BEP20' };
    }
    return { network: networkUpper };
}


async function fetchAllBalances(type = 'future') {
    const allBalances = {};
    const tradingExchanges = activeExchangeIds.filter(id => id !== 'kucoin' && id !== 'binance');
    for (const id of tradingExchanges) {
        if (!exchanges[id] || exchangeHealth[id].isDisabled) { 
            allBalances[id] = 0; 
            continue; 
        }
        try {
            const balanceData = (id === 'kucoinfutures') ? await exchanges[id].fetchBalance() : await exchanges[id].fetchBalance({ 'type': type });
            const freeBalance = balanceData?.free?.USDT || 0;
            allBalances[id] = freeBalance;
            if (type === 'future') balances[id] = { available: freeBalance, total: balanceData?.total?.USDT || 0 };
        } catch (e) {
            safeLog('warn', `[BALANCE] Không thể lấy số dư ${type} từ ${id}: ${e.message}`);
            allBalances[id] = 0;
            if (type === 'future') balances[id] = { available: 0, total: 0 };
        }
    }
    return allBalances;
}
const updateBalances = () => fetchAllBalances('future');

async function attemptInternalTransferOnArrival(toExchangeId, fromExchangeId, amountSent) {
    safeLog('log', `[RETRY-TRANSFER] Bắt đầu vòng lặp thử chuyển tiền nội bộ trên ${toExchangeId.toUpperCase()}.`);
    const maxRetries = 30;
    const retryIntervalMs = 20000;

    let amountRequired = amountSent;
    if (fromExchangeId === 'kucoinfutures') {
        amountRequired = amountSent - 0.5;
    }

    let targetToWallet = 'future';
    if (toExchangeId === 'bitget') targetToWallet = 'swap';

    let checkerId = toExchangeId;
    let transfererId = toExchangeId;

    if (toExchangeId === 'kucoinfutures') {
        checkerId = 'kucoin'; 
        transfererId = 'kucoinfutures'; 
    } else if (toExchangeId === 'binanceusdm') {
        checkerId = 'binance';
        transfererId = 'binanceusdm';
    }
    
    const balanceCheckerExchange = exchanges[checkerId];
    const internalTransfererExchange = exchanges[transfererId];

    if (!balanceCheckerExchange || !internalTransfererExchange) {
        safeLog('error', `[RETRY-TRANSFER] Không tìm thấy instance sàn cần thiết (${checkerId} or ${transfererId}).`);
        transferStatus = { inProgress: false, message: `Lỗi nghiêm trọng: Thiếu instance sàn.` };
        return;
    }

    for (let i = 1; i <= maxRetries; i++) {
        await sleep(retryIntervalMs);
        try {
            const balanceData = await balanceCheckerExchange.fetchBalance();
            
            let arrivalWalletType = null;
            let availableAmount = 0;

            const mainBalance = balanceData?.free?.USDT || 0;
            if (mainBalance >= amountRequired - FUND_ARRIVAL_TOLERANCE) {
                arrivalWalletType = 'main'; 
                if (toExchangeId === 'binanceusdm') arrivalWalletType = 'spot';
                availableAmount = mainBalance;
            }

            if (!arrivalWalletType && toExchangeId === 'kucoinfutures' && balanceData.trade) {
                const tradeBalance = balanceData.trade.free?.USDT || 0;
                if (tradeBalance >= amountRequired - FUND_ARRIVAL_TOLERANCE) {
                    arrivalWalletType = 'trade';
                    availableAmount = tradeBalance;
                }
            }

            if (arrivalWalletType) {
                safeLog('info', `[RETRY-TRANSFER] ✅ Tiền đã về ví '${arrivalWalletType}'! (Có ${availableAmount.toFixed(2)}). Chờ 3s...`);
                await sleep(3000);

                const finalBalanceData = await balanceCheckerExchange.fetchBalance();
                let finalAvailableAmount = 0;

                if (arrivalWalletType === 'trade' && finalBalanceData.trade) {
                    finalAvailableAmount = finalBalanceData.trade.free?.USDT || 0;
                } else {
                    finalAvailableAmount = finalBalanceData.free?.USDT || 0;
                }
                
                if (finalAvailableAmount > 0.1) {
                    finalAvailableAmount = finalAvailableAmount - 0.05; 
                }

                if (finalAvailableAmount > 0) {
                    safeLog('info', `Đang chuyển ${finalAvailableAmount.toFixed(2)} USDT từ ${arrivalWalletType} sang ${targetToWallet} trên ${toExchangeId}.`);
                    await internalTransfererExchange.transfer('USDT', finalAvailableAmount, arrivalWalletType, targetToWallet);
                
                    transferStatus = { inProgress: false, message: `✅ Hoàn tất chuyển tiền và nạp vào ví Future!` };
                    safeLog('info', `[RETRY-TRANSFER] Chuyển nội bộ thành công!`);
                    await updateBalances();
                    return;
                } else {
                     safeLog('warn', `[RETRY-TRANSFER] Số dư khả dụng trong ví '${arrivalWalletType}' là 0 sau khi chờ, không thể chuyển.`);
                }
            } else {
                 const currentBalance = Math.max(balanceData?.free?.USDT || 0, balanceData?.trade?.free?.USDT || 0);
                safeLog('log', `[RETRY-TRANSFER] Lần ${i}/${maxRetries}: Chưa có đủ tiền trên ví đích của ${toExchangeId} (Có ${currentBalance.toFixed(2)} / Cần ${amountRequired.toFixed(2)}). Thử lại...`);
            }
        } catch (e) {
            if (e instanceof ccxt.InsufficientFunds) {
                safeLog('log', `[RETRY-TRANSFER] Lần ${i}/${maxRetries}: Lỗi không đủ tiền (API trễ), thử lại sau 20s.`);
            } else {
                safeLog('error', `[RETRY-TRANSFER] Lỗi nghiêm trọng khi thử chuyển tiền nội bộ lần ${i}:`, e);
                transferStatus = { inProgress: false, message: `Lỗi khi chuyển nội bộ: ${e.message}` };
                return;
            }
        }
    }

    safeLog('error', `[RETRY-TRANSFER] ❌ HẾT SỐ LẦN THỬ! Không thể chuyển tiền nội bộ trên ${toExchangeId} sau ${maxRetries} lần.`);
    transferStatus = { inProgress: false, message: `Lỗi: Hết lần thử chuyển tiền nội bộ trên ${toExchangeId}.` };
}

async function executeSingleFundTransfer(fromExchangeId, toExchangeId, amount) {
    transferStatus = { inProgress: true, message: `Bắt đầu chuyển ${amount.toFixed(2)} USDT từ ${fromExchangeId} -> ${toExchangeId}.` };
    safeLog('log', `[TRANSFER] ${transferStatus.message}`);
    
    const sourceExchange = exchanges[fromExchangeId];

    try {
        let fromWallet = 'future', toWallet = 'spot';
        if (fromExchangeId === 'bitget') fromWallet = 'swap';
        if (fromExchangeId === 'kucoinfutures') toWallet = 'main';
        
        transferStatus.message = `1/2: Chuyển ${amount.toFixed(2)} USDT sang ví ${toWallet} trên ${fromExchangeId}...`;
        await sourceExchange.transfer('USDT', amount, fromWallet, toWallet);
        await sleep(5000);

        let networkLookupKey = 'BEP20';
        let withdrawerExchange = sourceExchange;
        if (fromExchangeId === 'kucoinfutures') {
            networkLookupKey = 'APTOS';
            withdrawerExchange = exchanges['kucoin'];
            if (!withdrawerExchange) throw new Error("Instance KuCoin (Spot) chưa được khởi tạo.");
        }
        
        const targetDepositInfo = getTargetDepositInfo(toExchangeId, networkLookupKey);
        if(!targetDepositInfo) throw new Error("Không tìm thấy thông tin địa chỉ nạp tiền.");
        
        transferStatus.message = `2/2: Gửi lệnh rút ${amount.toFixed(2)} USDT đến ${toExchangeId}. Kích hoạt chế độ theo dõi...`;
        
        const params = getWithdrawParams(fromExchangeId, networkLookupKey);
        
        await withdrawerExchange.withdraw('USDT', amount, targetDepositInfo.address, undefined, params);
        
        attemptInternalTransferOnArrival(toExchangeId, fromExchangeId, amount);
        
        return true;

    } catch (e) {
        safeLog('error', `[TRANSFER] ❌ LỖI NGHIÊM TRỌNG khi chuyển từ ${fromExchangeId} -> ${toExchangeId}:`, e);
        transferStatus = { inProgress: false, message: `Lỗi: ${e.message}` };
        return false;
    }
}

async function manageFundDistribution(opportunity) {
    capitalManagementState = 'FUNDS_READY';
}

async function returnFundsToHub() {
    capitalManagementState = 'CLEANING_UP';
    safeLog('info', "[CLEANUP] Bắt đầu Giai đoạn 3: Dọn dẹp (TÍNH NĂNG GOM TIỀN VỀ ĐANG TẮT).");
    
    safeLog('warn', "[CLEANUP] Tiền sẽ được giữ lại trên ví Future của các sàn.");
    
    // Reset trạng thái về IDLE nhanh chóng
    setTimeout(() => {
        safeLog('info', "[CLEANUP] ✅ Bot reset về trạng thái IDLE.");
        capitalManagementState = 'IDLE';
        selectedOpportunityForNextTrade = null;
        failedCoinsInSession.clear(); 
    }, 2000);
}

const normalizeExchangeId = (id) => {
    if (!id) return null;
    const lowerId = id.toLowerCase().trim();
    if (lowerId.includes('binance')) return 'binanceusdm';
    if (lowerId.includes('kucoin') && lowerId.includes('futures')) return 'kucoinfutures';
    if (lowerId.includes('kucoin')) return 'kucoinfutures';
    return lowerId;
};

async function processServerData(serverData) {
    if (!serverData || !serverData.arbitrageData) {
        bestPotentialOpportunityForDisplay = null;
        allCurrentOpportunities = [];
        return;
    }
    const opportunities = serverData.arbitrageData.filter(op => {
        if (!op?.exchanges || typeof op.exchanges !== 'string' || op.estimatedPnl < MIN_PNL_PERCENTAGE) return false;
        const [shortExRaw, longExRaw] = op.exchanges.split(' / ');
        if (!shortExRaw || !longExRaw) return false;
        const shortExchange = normalizeExchangeId(shortExRaw);
        const longExchange = normalizeExchangeId(longExRaw);

        const allowed = ['binanceusdm', 'kucoinfutures'];
        if (!allowed.includes(shortExchange) || !allowed.includes(longExchange)) {
            return false; 
        }
        
        return exchanges[shortExchange] && !exchangeHealth[shortExchange]?.isDisabled && exchanges[longExchange] && !exchangeHealth[longExchange]?.isDisabled;
    }).map(op => {
        const [shortExRaw, longExRaw] = op.exchanges.split(' / ');
        op.details = { shortExchange: normalizeExchangeId(shortExRaw), longExchange: normalizeExchangeId(longExRaw) };
        return op;
    });
    
    allCurrentOpportunities = opportunities.sort((a, b) => b.estimatedPnl - a.estimatedPnl);
    bestPotentialOpportunityForDisplay = allCurrentOpportunities.length > 0 ? allCurrentOpportunities[0] : null;
}

async function getExchangeSpecificSymbol(exchange, rawCoinSymbol) {
    try {
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) await exchange.loadMarkets(true);
    } catch (e) { return null; }
    const base = String(rawCoinSymbol).toUpperCase().replace(/USDT$/, '');
    const attempts = [`${base}/USDT:USDT`, `${base}USDT`, `${base}-USDT-SWAP`, `${base}USDTM`, `${base}/USDT`];
    for (const attempt of attempts) {
        const market = exchange.markets[attempt];
        if (market?.active && (market.contract || market.swap || market.future)) { return market.id; }
    }
    return null;
}

async function getMaxLeverage(exchange, symbol) {
    try {
        const market = exchange.market(symbol);
        if (market.limits && market.limits.leverage && market.limits.leverage.max) {
            return market.limits.leverage.max;
        }
        return 20; 
    } catch (e) {
        return 20;
    }
}

async function setLeverageSafely(exchange, symbol, desiredLeverage) {
    const params = (exchange.id === 'kucoinfutures') ? { 'marginMode': 'cross' } : {};
    try {
        await exchange.setLeverage(desiredLeverage, symbol, params);
        return desiredLeverage;
    } catch (e) {
        safeLog('error', `[LEVERAGE] Không thể đặt đòn bẩy x${desiredLeverage} cho ${symbol} trên ${exchange.id}. Lỗi: ${e.message}`);
        return null;
    }
}

async function computeOrderDetails(exchange, symbol, targetNotionalUSDT, leverage, availableBalance) {
    await exchange.loadMarkets();
    const market = exchange.market(symbol);
    const ticker = await exchange.fetchTicker(symbol);
    const price = ticker?.last || ticker?.close;
    if (!price) throw new Error(`Không lấy được giá cho ${symbol} trên ${exchange.id}`);
    const contractSize = market.contractSize ?? 1;
    
    let amount = parseFloat(exchange.amountToPrecision(symbol, targetNotionalUSDT / (price * contractSize)));
    
    if (exchange.id === 'kucoinfutures' && market.precision.amount === 0) amount = Math.round(amount);
    
    if (amount <= (market.limits.amount.min || 0)) {
         throw new Error(`Số lượng tính toán (${amount}) < mức tối thiểu của sàn (${market.limits.amount.min}).`);
    }
    
    let currentNotional = amount * price * contractSize;
    
    if (market.limits?.cost?.min && currentNotional < market.limits.cost.min) {
         throw new Error(`Giá trị lệnh ${currentNotional.toFixed(4)} < mức tối thiểu ${market.limits.cost.min} USDT.`);
    }

    return { amount, price, notional: currentNotional, requiredMargin: currentNotional / leverage };
}

async function placeTpSlOrders(exchange, symbol, side, amount, entryPrice, collateral, notionalValue) {
    if (!entryPrice || typeof entryPrice !== 'number' || entryPrice <= 0) return { tpOrderId: null, slOrderId: null };
    if (!notionalValue || notionalValue <= 0) return { tpOrderId: null, slOrderId: null };
    
    const slPriceChange = entryPrice * (SL_PERCENTAGE / 100 / (notionalValue / collateral));
    const tpPriceChange = entryPrice * (TP_PERCENTAGE / 100 / (notionalValue / collateral));

    let tpPrice, slPrice;
    if (side === 'sell') { 
        tpPrice = entryPrice - tpPriceChange;
        slPrice = entryPrice + slPriceChange;
    } else { 
        tpPrice = entryPrice + tpPriceChange;
        slPrice = entryPrice - slPriceChange;
    }
    
    if (isNaN(tpPrice) || isNaN(slPrice)) return { tpOrderId: null, slOrderId: null };

    const orderSide = (side === 'sell') ? 'buy' : 'sell'; 
    let binanceParams = {};
    if (exchange.id === 'binanceusdm') {
        binanceParams = { 'positionSide': (side === 'sell') ? 'SHORT' : 'LONG' };
    }

    try {
        let tpResult, slResult;
        
        if (exchange.id === 'kucoinfutures') {
            const tpParams = { 'reduceOnly': true, 'stop': side === 'sell' ? 'down' : 'up', 'stopPrice': exchange.priceToPrecision(symbol, tpPrice), 'stopPriceType': 'MP', 'marginMode': 'cross' };
            tpResult = await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, tpParams);
            const slParams = { 'reduceOnly': true, 'stop': side === 'sell' ? 'up' : 'down', 'stopPrice': exchange.priceToPrecision(symbol, slPrice), 'stopPriceType': 'MP', 'marginMode': 'cross' };
            slResult = await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, slParams);
        } else if (exchange.id === 'bitget') {
            const holdSide = side === 'buy' ? 'long' : 'short';
            const tpParams = { 'planType': 'normal_plan', 'triggerPrice': exchange.priceToPrecision(symbol, tpPrice), 'holdSide': holdSide };
            tpResult = await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, tpParams);
            const slParams = { 'planType': 'normal_plan', 'triggerPrice': exchange.priceToPrecision(symbol, slPrice), 'holdSide': holdSide };
            slResult = await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, slParams);
        } else {
            const commonParams = { 'closePosition': 'true', ...binanceParams };
            tpResult = await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', orderSide, amount, undefined, { ...commonParams, 'stopPrice': exchange.priceToPrecision(symbol, tpPrice) });
            slResult = await exchange.createOrder(symbol, 'STOP_MARKET', orderSide, amount, undefined, { ...commonParams, 'stopPrice': exchange.priceToPrecision(symbol, slPrice) });
        }
        return { tpOrderId: tpResult.id, slOrderId: slResult.id };
    } catch (e) {
        safeLog('error', `[TP/SL] Lỗi khi đặt lệnh TP/SL cho ${symbol} trên ${exchange.id}:`, e);
        throw e;
    }
}

async function getReliableFillPrice(exchange, symbol, orderId) {
    for (let i = 0; i < 5; i++) { 
        try {
            const order = await exchange.fetchOrder(orderId, symbol);
            if (order.average) return order.average;
            if (order.price) return order.price;
            if (order.filled > 0 && order.cost > 0) return order.cost / order.filled;
            
            const trades = await exchange.fetchMyTrades(symbol, undefined, 1, { 'orderId': orderId });
            if (trades.length > 0) return trades[0].price;
        } catch (e) { }
        await sleep(1000); 
    }
    return null;
}

async function ensureNoPosition(exchange, symbol, side) {
    try {
        if (exchange.id === 'binanceusdm') {
            const positions = await exchange.fapiPrivateGetPositionRisk({ 'symbol': symbol.replace('/', '') });
            const targetPos = positions.find(p => p.positionSide === (side === 'sell' ? 'SHORT' : 'LONG'));
            const amt = parseFloat(targetPos?.positionAmt || 0);
            if (Math.abs(amt) > 0) {
                safeLog('warn', `[PRE-CLEAN] ${exchange.id} đang có vị thế ${side} volume ${amt}. Đóng ngay...`);
                const closeSide = side === 'sell' ? 'buy' : 'sell';
                const posSide = side === 'sell' ? 'SHORT' : 'LONG';
                await exchange.createMarketOrder(symbol, closeSide, Math.abs(amt), undefined, { 'positionSide': posSide });
            }
        } 
        else {
            const positions = await exchange.fetchPositions([symbol]);
            const pos = positions.find(p => p.symbol === symbol && p.contracts > 0);
            if (pos) {
                safeLog('warn', `[PRE-CLEAN] ${exchange.id} đang có vị thế ${symbol}. Đóng ngay...`);
                const closeSide = pos.side === 'long' ? 'sell' : 'buy';
                const params = (exchange.id === 'kucoinfutures') ? {'reduceOnly': true, 'marginMode': 'cross'} : {'reduceOnly': true};
                await exchange.createMarketOrder(symbol, closeSide, pos.contracts, undefined, params);
            }
        }
        await exchange.cancelAllOrders(symbol);
    } catch (e) {
        safeLog('error', `[PRE-CLEAN] Lỗi khi dọn dẹp vị thế cũ trên ${exchange.id}: ${e.message}`);
    }
}

async function executeTestTrade(opportunity) {
    safeLog('info', `[TEST-TRADE] 🧪 Đang test coin: ${opportunity.coin} (Margin ${TEST_TRADE_MARGIN}$)...`);
    const { coin } = opportunity;
    const { shortExchange, longExchange } = opportunity.details;
    
    const shortEx = exchanges[shortExchange];
    const longEx = exchanges[longExchange];
    
    const shortSymbol = await getExchangeSpecificSymbol(shortEx, coin);
    const longSymbol = await getExchangeSpecificSymbol(longEx, coin);
    
    if (shortSymbol && longSymbol) {
        await Promise.all([
            ensureNoPosition(shortEx, shortSymbol, 'sell'),
            ensureNoPosition(longEx, longSymbol, 'buy')
        ]);
    }

    const shortBal = balances[shortExchange]?.available || 0;
    const longBal = balances[longExchange]?.available || 0;
    if (shortBal < TEST_TRADE_MARGIN || longBal < TEST_TRADE_MARGIN) {
        safeLog('error', `[TEST-TRADE] ❌ Không đủ tiền để test (Cần ${TEST_TRADE_MARGIN}$).`);
        return false;
    }

    if (!shortSymbol || !longSymbol) {
        safeLog('error', `[TEST-TRADE] ❌ Không tìm thấy symbol ${coin}.`);
        return false;
    }

    // Dùng luôn đòn bẩy server
    const leverageToUse = opportunity.commonLeverage;
    safeLog('info', `[TEST-TRADE] Sử dụng đòn bẩy x${leverageToUse} (Server).`);
    
    const [actualShortLeverage, actualLongLeverage] = await Promise.all([ 
        setLeverageSafely(shortEx, shortSymbol, leverageToUse), 
        setLeverageSafely(longEx, longSymbol, leverageToUse) 
    ]);

    if (!actualShortLeverage || !actualLongLeverage) return false;

    let shortOrderDetails, longOrderDetails;
    try {
        const targetNotional = TEST_TRADE_MARGIN * leverageToUse; 
        [shortOrderDetails, longOrderDetails] = await Promise.all([
            computeOrderDetails(shortEx, shortSymbol, targetNotional, leverageToUse, 1000), 
            computeOrderDetails(longEx, longSymbol, targetNotional, leverageToUse, 1000)
        ]);
    } catch (e) {
        safeLog('error', `[TEST-TRADE] ❌ Lỗi tính toán lệnh: ${e.message}`);
        return false;
    }

    const shortParams = (shortEx.id === 'binanceusdm') ? { 'positionSide': 'SHORT' } : (shortEx.id === 'kucoinfutures' ? {'marginMode':'cross'} : {});
    const longParams = (longEx.id === 'binanceusdm') ? { 'positionSide': 'LONG' } : (longEx.id === 'kucoinfutures' ? {'marginMode':'cross'} : {});

    let shortOrder, longOrder;
    try {
        [shortOrder, longOrder] = await Promise.all([
            shortEx.createMarketSellOrder(shortSymbol, shortOrderDetails.amount, shortParams),
            longEx.createMarketBuyOrder(longSymbol, longOrderDetails.amount, longParams)
        ]);
    } catch (e) {
        safeLog('error', `[TEST-TRADE] ❌ Lỗi mở lệnh test: ${shortEx.id} ${e.message}`);
        
        const closeShortParams = (shortEx.id === 'binanceusdm') ? { 'positionSide': 'SHORT' } : {'reduceOnly': true};
        const closeLongParams = (longEx.id === 'binanceusdm') ? { 'positionSide': 'LONG' } : {'reduceOnly': true};

        if (shortOrder) await shortEx.createMarketBuyOrder(shortSymbol, shortOrderDetails.amount, closeShortParams);
        if (longOrder) await longEx.createMarketSellOrder(longSymbol, longOrderDetails.amount, closeLongParams);
        return false;
    }

    const [shortEntry, longEntry] = await Promise.all([ 
        getReliableFillPrice(shortEx, shortSymbol, shortOrder.id), 
        getReliableFillPrice(longEx, longSymbol, longOrder.id) 
    ]);

    const closeShortParams = (shortEx.id === 'binanceusdm') ? { 'positionSide': 'SHORT' } : {'reduceOnly': true, ...(shortEx.id === 'kucoinfutures' && {'marginMode': 'cross'})};
    const closeLongParams = (longEx.id === 'binanceusdm') ? { 'positionSide': 'LONG' } : {'reduceOnly': true, ...(longEx.id === 'kucoinfutures' && {'marginMode': 'cross'})};

    if (!shortEntry || !longEntry) {
         safeLog('error', '[TEST-TRADE] ❌ Không lấy được giá khớp lệnh (sau khi retry).');
         await Promise.all([
            shortEx.createMarketBuyOrder(shortSymbol, shortOrderDetails.amount, closeShortParams),
            longEx.createMarketSellOrder(longSymbol, longOrderDetails.amount, closeLongParams)
         ]);
         return false;
    }

    try {
        await Promise.all([
            placeTpSlOrders(shortEx, shortSymbol, 'sell', shortOrderDetails.amount, shortEntry, TEST_TRADE_MARGIN, shortOrderDetails.notional),
            placeTpSlOrders(longEx, longSymbol, 'buy', longOrderDetails.amount, longEntry, TEST_TRADE_MARGIN, longOrderDetails.notional)
        ]);
    } catch (e) {
         safeLog('error', '[TEST-TRADE] ❌ Lỗi đặt TP/SL.'); 
    }

    safeLog('info', `[TEST-TRADE] ✅ Test thành công! Đang dọn dẹp...`);

    try {
        await shortEx.cancelAllOrders(shortSymbol);
        await longEx.cancelAllOrders(longSymbol);
        await Promise.all([
            shortEx.createMarketBuyOrder(shortSymbol, shortOrderDetails.amount, closeShortParams),
            longEx.createMarketSellOrder(longSymbol, longOrderDetails.amount, closeLongParams)
        ]);
        return true;
    } catch (e) {
        safeLog('error', `[TEST-TRADE] ⚠️ Lỗi dọn dẹp: ${e.message}`);
        return true; 
    }
}

// [MODIFIED] Thêm tham số candidates để nhận list coin đã lọc theo giờ
async function runTestTradeSequence(candidates) {
    if (isRunningTestSequence) return;
    isRunningTestSequence = true;
    
    // Lọc bỏ những coin đã test fail trước đó
    const finalCandidates = candidates.filter(op => !failedCoinsInSession.has(op.coin));

    if (finalCandidates.length === 0) {
        isRunningTestSequence = false;
        return;
    }

    safeLog('info', `[TEST-SEQUENCE] 🔍 Bắt đầu quét danh sách ${finalCandidates.length} coin hợp lệ...`);
    
    for (const op of finalCandidates) {
        safeLog('info', `[TEST-SEQUENCE] 👉 Thử Coin: ${op.coin}`);
        
        const success = await executeTestTrade(op);
        
        if (success) {
            selectedOpportunityForNextTrade = op;
            capitalManagementState = 'FUNDS_READY';
            safeLog('info', `[TEST-SEQUENCE] 🎯 Đã CHỐT coin: ${op.coin}. Chờ đến 59:50.`);
            isRunningTestSequence = false;
            return;
        } else {
            safeLog('warn', `[TEST-SEQUENCE] ⚠️ Coin ${op.coin} lỗi. Dọn dẹp & Nghỉ 5s...`);
            failedCoinsInSession.add(op.coin);
            
            await closeTradeNow(); 
            await sleep(5000); 
        }
    }
    
    isRunningTestSequence = false;
}


async function executeTrades(opportunity, percentageToUse) {
    const { coin, commonLeverage: desiredLeverage } = opportunity;
    const { shortExchange, longExchange } = opportunity.details;
    
    safeLog('info', `[EXECUTE] 🚀 Bắt đầu vào lệnh cho ${coin} (${percentageToUse}% vốn)...`);

    try {
        await updateBalances();
        const shortEx = exchanges[shortExchange], longEx = exchanges[longExchange];
        
        if (!shortEx || !longEx) {
             safeLog('error', `[EXECUTE] Lỗi: Không tìm thấy instance sàn.`);
             return false;
        }

        const shortBalance = balances[shortExchange]?.available || 0;
        const longBalance = balances[longExchange]?.available || 0;
        
        const minBalance = Math.min(shortBalance, longBalance);
        const collateral = minBalance * (percentageToUse / 100);

        if (collateral < MIN_COLLATERAL_FOR_TRADE) {
            safeLog('warn', `[EXECUTE] Vốn không đủ. Yêu cầu > ${MIN_COLLATERAL_FOR_TRADE}, có ${collateral.toFixed(4)}.`);
            return false;
        }

        const shortSymbol = await getExchangeSpecificSymbol(shortEx, coin);
        const longSymbol = await getExchangeSpecificSymbol(longEx, coin);
        if (!shortSymbol || !longSymbol) {
             safeLog('error', `[EXECUTE] Lỗi: Không tìm thấy symbol ${coin}.`);
             return false;
        }

        const [actualShortLeverage, actualLongLeverage] = await Promise.all([ setLeverageSafely(shortEx, shortSymbol, desiredLeverage), setLeverageSafely(longEx, longSymbol, desiredLeverage) ]);
        if (!actualShortLeverage || !actualLongLeverage) {
             safeLog('error', `[EXECUTE] Lỗi: Không đặt được đòn bẩy.`);
             return false;
        }
        const leverageToUse = Math.min(actualShortLeverage, actualLongLeverage);

        let shortOrderDetails, longOrderDetails;
        try {
            const targetNotional = collateral * leverageToUse;
            [shortOrderDetails, longOrderDetails] = await Promise.all([
                computeOrderDetails(shortEx, shortSymbol, targetNotional, leverageToUse, shortBalance),
                computeOrderDetails(longEx, longSymbol, targetNotional, leverageToUse, longBalance)
            ]);
        } catch (e) {
            safeLog('error', `[EXECUTE] Lỗi tính toán lệnh: ${e.message}`);
            return false;
        }

        const shortParams = (shortEx.id === 'binanceusdm') ? { 'positionSide': 'SHORT' } : (shortEx.id === 'kucoinfutures' ? {'marginMode':'cross'} : {});
        const longParams = (longEx.id === 'binanceusdm') ? { 'positionSide': 'LONG' } : (longEx.id === 'kucoinfutures' ? {'marginMode':'cross'} : {});

        let shortOrder, longOrder;
        try {
            [shortOrder, longOrder] = await Promise.all([
                shortEx.createMarketSellOrder(shortSymbol, shortOrderDetails.amount, shortParams),
                longEx.createMarketBuyOrder(longSymbol, longOrderDetails.amount, longParams)
            ]);
        } catch (e) {
            safeLog('error', `[EXECUTE] Lỗi mở lệnh: ${e.message}`);
            return false;
        }

        await sleep(3000);
        const [shortEntryPrice, longEntryPrice] = await Promise.all([ 
            getReliableFillPrice(shortEx, shortSymbol, shortOrder.id), 
            getReliableFillPrice(longEx, longSymbol, longOrder.id) 
        ]);
        
        const tradeBaseInfo = {
            ...opportunity.details, coin,
            openTime: Date.now(),
            shortOrderAmount: shortOrderDetails.amount, longOrderAmount: longOrderDetails.amount,
            commonLeverageUsed: leverageToUse, shortOriginalSymbol: shortSymbol, longOriginalSymbol: longSymbol,
            shortBalanceBefore: shortBalance, longBalanceBefore: longBalance,
            collateralUsed: collateral,
            estimatedPnlFromOpportunity: opportunity.estimatedPnl,
        };

        if (!shortEntryPrice || !longEntryPrice) {
            currentTradeDetails = { ...tradeBaseInfo, status: 'MANUAL_CHECK_NO_SL' };
            safeLog('warn', `[EXECUTE] Không lấy được giá khớp lệnh. Check Manual.`);
            return true;
        }

        try {
            const [shortTpSlIds, longTpSlIds] = await Promise.all([
                placeTpSlOrders(shortEx, shortSymbol, 'sell', shortOrderDetails.amount, shortEntryPrice, collateral, shortOrderDetails.notional),
                placeTpSlOrders(longEx, longSymbol, 'buy', longOrderDetails.amount, longEntryPrice, collateral, longOrderDetails.notional)
            ]);
            currentTradeDetails = {
                ...tradeBaseInfo, status: 'OPEN',
                shortTpOrderId: shortTpSlIds.tpOrderId, shortSlOrderId: shortTpSlIds.slOrderId,
                longTpOrderId: longTpSlIds.tpOrderId, longSlOrderId: longTpSlIds.slOrderId,
            };
        } catch (e) {
            safeLog('error', `[EXECUTE] Lỗi TP/SL. Đóng lệnh ngay.`, e);
            currentTradeDetails = { ...tradeBaseInfo, status: 'CLOSING_DUE_TO_ERROR' };
            await closeTradeNow();
            return false;
        }

        safeLog('info', `[EXECUTE] ✅ Vào lệnh thành công!`);
        capitalManagementState = 'TRADE_OPEN';
        return true;

    } catch (e) {
        safeLog('error', `[EXECUTE] Lỗi không xác định: ${e.message}`);
        return false;
    }
}

async function closeTradeNow() {
    if (!currentTradeDetails) return false;
    const tradeToClose = { ...currentTradeDetails };
    
    const shortEx = exchanges[tradeToClose.shortExchange];
    const longEx = exchanges[tradeToClose.longExchange];

    try {
        safeLog('info', `[CLEANUP] Hủy lệnh chờ...`);
        await shortEx.cancelAllOrders(tradeToClose.shortOriginalSymbol);
        await longEx.cancelAllOrders(tradeToClose.longOriginalSymbol);
        await sleep(1000);

        safeLog('info', `[CLEANUP] Đang đóng vị thế...`);
        
        const closeShortParams = (shortEx.id === 'binanceusdm') ? { 'positionSide': 'SHORT' } : {'reduceOnly': true, ...(shortEx.id === 'kucoinfutures' && {'marginMode': 'cross'})};
        const closeLongParams = (longEx.id === 'binanceusdm') ? { 'positionSide': 'LONG' } : {'reduceOnly': true, ...(longEx.id === 'kucoinfutures' && {'marginMode': 'cross'})};

        await Promise.all([
            shortEx.createMarketBuyOrder(tradeToClose.shortOriginalSymbol, tradeToClose.shortOrderAmount, closeShortParams),
            longEx.createMarketSellOrder(tradeToClose.longOriginalSymbol, tradeToClose.longOrderAmount, closeLongParams)
        ]);
        tradeAwaitingPnl = { ...currentTradeDetails, status: 'PENDING_PNL_CALC', closeTime: Date.now() };
        currentTradeDetails = null;
        return true;
    } catch (e) {
        safeLog('error', `[PNL] Lỗi khi đóng vị thế:`, e);
        currentTradeDetails.status = "CLOSE_FAILED";
        return false;
    }
}

async function calculatePnlAfterDelay(closedTrade) {
    await sleep(5000);
    try {
        await updateBalances();
        const shortBalanceAfter = balances[closedTrade.shortExchange]?.available || 0;
        const longBalanceAfter = balances[closedTrade.longExchange]?.available || 0;
        const pnlShort = shortBalanceAfter - closedTrade.shortBalanceBefore;
        const pnlLong = longBalanceAfter - closedTrade.longBalanceBefore;
        const totalPnl = pnlShort + pnlLong;
        safeLog('log', `[PNL] KẾT QUẢ PHIÊN (${closedTrade.coin}): PNL Tổng: ${totalPnl.toFixed(4)} USDT`);
        tradeHistory.unshift({ ...closedTrade, status: 'CLOSED', actualPnl: totalPnl, pnlShort, pnlLong });
        if (tradeHistory.length > 50) tradeHistory.pop();
        tradeAwaitingPnl = null;

        if (botState === 'RUNNING') {
            safeLog('info', '[STATE] Tính PNL hoàn tất. Bắt đầu dọn dẹp (bỏ qua gom tiền).');
            await returnFundsToHub();
        }

    } catch (e) {
        safeLog('error', '[PNL] Lỗi nghiêm trọng khi đang tính toán PNL:', e);
        tradeAwaitingPnl = null;
        capitalManagementState = 'IDLE';
    }
}

async function mainBotLoop() {
    if (botState !== 'RUNNING') return;

    try {
        if (tradeAwaitingPnl) await calculatePnlAfterDelay(tradeAwaitingPnl);
        
        const serverData = await fetchDataFromServer();
        await processServerData(serverData);

        const now = new Date();
        const currentMinute = now.getUTCMinutes();
        const currentSecond = now.getUTCSeconds();
        
        if (currentMinute !== new Date(now.getTime() - 1000).getUTCMinutes()) {
            hasLoggedNotFoundThisHour = false;
        }
        
        if (currentMinute === 49) {
            failedCoinsInSession.clear();
        }

        // [FIXED] Chỉ test nếu trong khung giờ cho phép (>= 50) VÀ coin sắp đến giờ Funding
        if (capitalManagementState === 'IDLE' && currentMinute >= TEST_START_MINUTE && currentMinute < 59) {
            
            // Lọc ra các coin sắp trả funding trong vòng 15 phút tới
            const fundingCandidates = allCurrentOpportunities.filter(op => {
                const msToFunding = op.nextFundingTime - Date.now();
                const minutesToFunding = msToFunding / 60000;
                return minutesToFunding > 0 && minutesToFunding <= MIN_MINUTES_FOR_EXECUTION;
            });

            if (!selectedOpportunityForNextTrade && !isRunningTestSequence) {
                if (fundingCandidates.length > 0) {
                     await runTestTradeSequence(fundingCandidates); 
                } else if (!hasLoggedNotFoundThisHour) {
                    safeLog('log', "[TIMER] Phút 50: Chưa có coin nào sắp đến giờ Funding (còn > 15p).");
                    hasLoggedNotFoundThisHour = true;
                }
            }
        }
        
        else if (capitalManagementState === 'FUNDS_READY' && currentMinute === 59 && currentSecond >= 50) {
            if (selectedOpportunityForNextTrade) {
                safeLog('log', `[TIMER] ⏰ 59:50 -> EXECUTE lệnh thật cho ${selectedOpportunityForNextTrade.coin}.`);
                const success = await executeTrades(selectedOpportunityForNextTrade, currentPercentageToUse);
                if (!success) {
                    safeLog('error', "[TIMER] Vào lệnh thất bại.");
                    await returnFundsToHub();
                }
            }
        }

        else if (currentMinute > 5 && currentMinute < 59 && capitalManagementState !== 'IDLE' && capitalManagementState !== 'TRADE_OPEN' && capitalManagementState !== 'FUNDS_READY') {
            safeLog('warn', `[RESET] Trạng thái ${capitalManagementState} bị kẹt, đang reset về IDLE.`);
            await returnFundsToHub();
        }

    } catch (e) {
        safeLog('error', '[LOOP] Lỗi nghiêm trọng trong vòng lặp chính:', e);
        await returnFundsToHub();
    }

    if (botState === 'RUNNING') {
        botLoopIntervalId = setTimeout(mainBotLoop, DATA_FETCH_INTERVAL_SECONDS * 1000);
    }
}

function startBot() {
    if (botState === 'RUNNING') return false;
    botState = 'RUNNING';
    capitalManagementState = 'IDLE';
    currentTradeDetails = null;
    tradeAwaitingPnl = null;
    selectedOpportunityForNextTrade = null;
    isRunningTestSequence = false;
    failedCoinsInSession.clear();
    updateBalances().then(mainBotLoop);
    return true;
}

function stopBot() {
    if (botState !== 'RUNNING') return false;
    botState = 'STOPPED';
    if (botLoopIntervalId) clearTimeout(botLoopIntervalId);
    return true;
}

const botServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url;
    const method = req.method;
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    await new Promise(resolve => req.on('end', resolve));

    try {
        if (url === '/' && method === 'GET') {
            fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
                res.writeHead(err ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(err ? 'Lỗi đọc file index.html' : content);
            });
        } else if (url === '/bot-api/status' && method === 'GET') {
             const transferExchanges = ['binanceusdm', 'bitget', 'kucoinfutures'];
            const internalTransferExchanges = activeExchangeIds.filter(id => exchanges[id] && id !== 'kucoin' && id !== 'binance');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                botState, capitalManagementState, balances, tradeHistory, 
                bestPotentialOpportunityForDisplay, currentTradeDetails, 
                exchangeHealth, transferStatus, transferExchanges, internalTransferExchanges,
                activeExchangeIds: internalTransferExchanges
            }));
        } else if (url === '/bot-api/start' && method === 'POST') {
             try { currentPercentageToUse = parseFloat(JSON.parse(body).percentageToUse) || 50; } catch { currentPercentageToUse = 50; }
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: startBot(), message: 'Đã gửi yêu cầu khởi động bot.' }));
        } else if (url === '/bot-api/stop' && method === 'POST') {
             res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: stopBot(), message: 'Đã gửi yêu cầu dừng bot.' }));
        } else if (url === '/bot-api/custom-test-trade' && method === 'POST') {
            safeLog('log', '[MANUAL] 📩 Nhận yêu cầu test thủ công từ UI...');
            
            if (currentTradeDetails) {
                 safeLog('warn', '[MANUAL] Bot đang bận, từ chối lệnh test.');
                 return res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: 'Bot đang bận với một giao dịch.' }));
            }
            if (!bestPotentialOpportunityForDisplay) {
                 safeLog('warn', '[MANUAL] Không có cơ hội nào để test.');
                 return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: 'Chưa có cơ hội nào.' }));
            }
            
            const data = JSON.parse(body);
            const testOpportunity = {
                coin: bestPotentialOpportunityForDisplay?.coin,
                commonLeverage: parseInt(data.leverage, 10) || 20,
                details: { shortExchange: data.shortExchange, longExchange: data.longExchange }
            };
            
            try {
                const tradeSuccess = await executeTrades(testOpportunity, parseFloat(data.percentage));
                res.writeHead(tradeSuccess ? 200 : 500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: tradeSuccess, message: tradeSuccess ? 'Lệnh Test đã được gửi.' : 'Lỗi khi gửi lệnh Test (Xem log).' }));
            } catch (err) {
                safeLog('error', '[MANUAL] Lỗi nghiêm trọng khi gọi executeTrades:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: `Lỗi: ${err.message}` }));
            }

        }
        else if (url === '/bot-api/close-trade-now' && method === 'POST') {
            const success = await closeTradeNow();
            if(success && botState === 'RUNNING') await returnFundsToHub();
            res.writeHead(success ? 200 : 400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success, message: success ? 'Đã gửi yêu cầu đóng lệnh và dọn dẹp.' : 'Không có lệnh đang mở hoặc có lỗi.' }));
        } else if (url === '/bot-api/transfer-funds' && method === 'POST') {
            if (botState === 'RUNNING' && capitalManagementState !== 'IDLE') {
                 return res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: 'Bot đang bận, không thể chuyển tiền thủ công.' }));
            }
            const { fromExchangeId, toExchangeId, amountStr } = JSON.parse(body);
            const amount = parseFloat(amountStr);
            if (!fromExchangeId || !toExchangeId || isNaN(amount) || amount < getMinTransferAmount(fromExchangeId)) {
                 return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: 'Dữ liệu không hợp lệ.' }));
            }
            executeSingleFundTransfer(fromExchangeId, toExchangeId, amount);
            res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, message: 'Đã nhận yêu cầu chuyển tiền.' }));
        } else if (url === '/bot-api/internal-transfer' && method === 'POST') {
            if (botState === 'RUNNING' && capitalManagementState !== 'IDLE') {
                return res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: 'Bot đang bận, không thể chuyển tiền thủ công.' }));
            }
            const { exchangeId, amountStr, fromAccount: genericFrom, toAccount: genericTo } = JSON.parse(body);
            const amount = parseFloat(amountStr);
        
            if(!exchangeId || !amount || isNaN(amount) || amount <= 0 || !genericFrom || !genericTo || genericFrom === genericTo) {
                return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: `Dữ liệu không hợp lệ.` }));
            }
            
            let from = genericFrom;
            let to = genericTo;
            let transferer;

            if (exchangeId.includes('kucoin')) {
                transferer = exchanges['kucoin'];
                if (from === 'spot') from = 'main';
                if (to === 'spot') to = 'main';
            } else if (exchangeId.includes('binance')) {
                transferer = exchanges['binance'];
            } else if (exchangeId === 'bitget') {
                transferer = exchanges['bitget'];
                if (from === 'future') from = 'swap';
                if (to === 'future') to = 'swap';
            } else {
                transferer = exchanges[exchangeId];
            }
        
            if (!transferer) {
                return res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: `Không tìm thấy instance sàn ${exchangeId} phù hợp.` }));
            }

            try {
                await transferer.transfer('USDT', amount, from, to);
                setTimeout(updateBalances, 3000);
                res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, message: 'Chuyển nội bộ thành công.' }));
            } catch (e) {
                safeLog('error', `[INTERNAL_TRANSFER] Lỗi khi chuyển ${amount} USDT từ ${from} -> ${to} trên ${exchangeId}:`, e);
                res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: `Lỗi: ${e.message}` }));
            }
        }
        else {
            res.writeHead(404).end('Not Found');
        }

    } catch (error) {
        safeLog('error', `[SERVER] Lỗi xử lý yêu cầu ${method} ${url}:`, error);
        if (!res.headersSent) {
            res.writeHead(500).end('Internal Server Error');
        }
    }
});

botServer.listen(BOT_PORT, () => {
    safeLog('log', `Máy chủ UI của Bot đang chạy tại http://localhost:${BOT_PORT}`);
});
