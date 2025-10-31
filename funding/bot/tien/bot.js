const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const { usdtDepositAddressesByNetwork } = require('./balance.js');
const {
    binanceApiKey, binanceApiSecret,
    bitgetApiKey, bitgetApiSecret, bitgetApiPassword,
    kucoinApiKey, kucoinApiSecret, kucoinApiPassword
} = require('./config.js');

const BOT_PORT = 5004;
const SERVER_DATA_URL = 'http://localhost:5005/api/data';
const HUB_EXCHANGE_ID = 'binanceusdm';

const MIN_PNL_PERCENTAGE = 1;
const MIN_MINUTES_FOR_EXECUTION = 15;
const DATA_FETCH_INTERVAL_SECONDS = 1;
const MAX_CONSEC_FAILS = 3;
const MIN_COLLATERAL_FOR_TRADE = 0.1;
const TP_SL_PNL_PERCENTAGE = 150;

const FUND_TRANSFER_MIN_AMOUNT_BINANCE = 10;
const FUND_TRANSFER_MIN_AMOUNT_KUCOIN = 1;
const FUND_TRANSFER_MIN_AMOUNT_BITGET = 10;

const MIN_TOTAL_CAPITAL_FOR_DISTRIBUTION = 5;
const FUND_ARRIVAL_TOLERANCE = 2;

const ALL_POSSIBLE_EXCHANGE_IDS = ['binanceusdm', 'bitget', 'kucoinfutures', 'kucoin', 'binance'];
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
        } else if (exchangeClass) {
            safeLog('warn', `[INIT] Bỏ qua ${id.toUpperCase()} do thiếu API Key/Secret.`);
        }
    } catch (e) {
        safeLog('error', `[INIT] Lỗi khi khởi tạo sàn ${id.toUpperCase()}: ${e}`);
    }
});

(async () => {
    safeLog('log', '[INIT] Bắt đầu tải trước (warm-up) dữ liệu markets cho tất cả các sàn...');
    const marketLoadPromises = [];
    for (const id in exchanges) {
        marketLoadPromises.push(exchanges[id].loadMarkets());
    }
    try {
        await Promise.all(marketLoadPromises);
        safeLog('info', '[INIT] ✅ Tải trước toàn bộ markets thành công!');
    } catch (e) {
        safeLog('error', '[INIT] Lỗi khi tải trước markets:', e.message);
    }
})();

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

    let targetFromWallet = 'spot', targetToWallet = 'future';
    if (toExchangeId === 'kucoinfutures') targetFromWallet = 'main';
    if (toExchangeId === 'bitget') targetToWallet = 'swap';

    let checkerId = toExchangeId;
    if (toExchangeId === 'kucoinfutures') checkerId = 'kucoin';
    else if (toExchangeId === 'binanceusdm') checkerId = 'binance';
    
    const balanceCheckerExchange = exchanges[checkerId];
    if (!balanceCheckerExchange) {
        safeLog('error', `[RETRY-TRANSFER] Không tìm thấy instance ${checkerId} để kiểm tra số dư.`);
        transferStatus = { inProgress: false, message: `Lỗi nghiêm trọng: Thiếu instance ${checkerId}` };
        return;
    }

    const internalTransfererExchange = exchanges[toExchangeId];
    if (!internalTransfererExchange) {
        safeLog('error', `[RETRY-TRANSFER] Không tìm thấy instance ${toExchangeId} để chuyển tiền nội bộ.`);
        transferStatus = { inProgress: false, message: `Lỗi nghiêm trọng: Thiếu instance ${toExchangeId}` };
        return;
    }

    for (let i = 1; i <= maxRetries; i++) {
        await sleep(retryIntervalMs);
        try {
            const balanceData = await balanceCheckerExchange.fetchBalance();
            const availableAmount = balanceData?.free?.USDT || 0;

            if (availableAmount >= amountRequired - FUND_ARRIVAL_TOLERANCE) {
                safeLog('info', `[RETRY-TRANSFER] ✅ Tiền đã về! (Có ${availableAmount.toFixed(2)} / Cần >= ${amountRequired - FUND_ARRIVAL_TOLERANCE}). Chờ 3s để sàn ổn định...`);
                await sleep(3000);

                const finalBalanceData = await balanceCheckerExchange.fetchBalance();
                const finalAvailableAmount = finalBalanceData?.free?.USDT || 0;

                if (finalAvailableAmount > 0) {
                    safeLog('info', `Đang chuyển ${finalAvailableAmount.toFixed(2)} USDT từ ${targetFromWallet} sang ${targetToWallet} trên ${toExchangeId}.`);
                    const preciseAmount = balanceCheckerExchange.currencyToPrecision('USDT', finalAvailableAmount);
                    await internalTransfererExchange.transfer('USDT', parseFloat(preciseAmount), targetFromWallet, targetToWallet);
                
                    transferStatus = { inProgress: false, message: `✅ Hoàn tất chuyển tiền và nạp vào ví Future!` };
                    safeLog('info', `[RETRY-TRANSFER] Chuyển nội bộ thành công!`);
                    await updateBalances();
                    return;
                } else {
                     safeLog('warn', `[RETRY-TRANSFER] Số dư khả dụng là 0 sau khi chờ, không thể chuyển nội bộ.`);
                }
            } else {
                safeLog('log', `[RETRY-TRANSFER] Lần ${i}/${maxRetries}: Chưa có đủ tiền trên ví ${targetFromWallet} của ${toExchangeId} (Có ${availableAmount.toFixed(2)} / Cần ${amountRequired.toFixed(2)}). Thử lại sau 20s.`);
            }
        } catch (e) {
            if (e instanceof ccxt.InsufficientFunds) {
                safeLog('log', `[RETRY-TRANSFER] Lần ${i}/${maxRetries}: Lỗi không đủ tiền (có thể do API trễ hoặc sai instance), thử lại sau 20s.`);
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
    capitalManagementState = 'PREPARING_FUNDS';
    safeLog('info', "[CAPITAL] Bắt đầu Giai đoạn 1: Gom vốn cho cơ hội giao dịch.");
    const { shortExchange, longExchange } = opportunity.details;
    const tradingExchanges = [shortExchange, longExchange];
    
    const allFutBalances = await fetchAllBalances('future');
    const totalCapital = Object.values(allFutBalances).reduce((sum, bal) => sum + bal, 0);

    if (totalCapital < MIN_TOTAL_CAPITAL_FOR_DISTRIBUTION) {
        safeLog('warn', `[CAPITAL] Tổng vốn ${totalCapital.toFixed(2)} USDT quá nhỏ, không đủ để phân bổ (cần ít nhất ${MIN_TOTAL_CAPITAL_FOR_DISTRIBUTION} USDT).`);
        capitalManagementState = 'IDLE';
        return false;
    }
    const targetPerExchange = totalCapital / 2;
    safeLog('log', `[CAPITAL] Tổng vốn: ${totalCapital.toFixed(2)} USDT. Mục tiêu mỗi sàn: ${targetPerExchange.toFixed(2)} USDT.`);

    for (const targetEx of tradingExchanges) {
        if (targetEx === HUB_EXCHANGE_ID) continue;
        
        const currentBalance = allFutBalances[targetEx] || 0;
        const amountNeeded = targetPerExchange - currentBalance;
        
        if (amountNeeded > getMinTransferAmount(HUB_EXCHANGE_ID)) {
            safeLog('log', `[CAPITAL] Sàn ${targetEx.toUpperCase()} cần ${amountNeeded.toFixed(2)} USDT.`);
            const transferSuccess = await executeSingleFundTransfer(HUB_EXCHANGE_ID, targetEx, amountNeeded);
            if (!transferSuccess) {
                safeLog('error', `[CAPITAL] Chuyển vốn đến ${targetEx.toUpperCase()} thất bại. Hủy phiên giao dịch.`);
                await returnFundsToHub();
                return;
            }
        } else {
             safeLog('log', `[CAPITAL] Sàn ${targetEx.toUpperCase()} đã có đủ vốn hoặc số tiền cần chuyển quá nhỏ.`);
        }
    }
    
    safeLog('info', "[CAPITAL] ✅ Đã gửi các lệnh gom vốn. Chờ tiền về và chuyển nội bộ tự động.");
    capitalManagementState = 'FUNDS_READY';
}

async function returnFundsToHub() {
    capitalManagementState = 'CLEANING_UP';
    safeLog('info', "[CLEANUP] Bắt đầu Giai đoạn 3: Dọn dẹp và chuyển toàn bộ vốn về Hub.");
    
    const nonHubExchanges = activeExchangeIds.filter(id => id !== HUB_EXCHANGE_ID && exchanges[id] && id !== 'kucoin' && id !== 'binance');
    
    for (const exId of nonHubExchanges) {
        await sleep(2000);
        try {
            const exchange = exchanges[exId];
            const fromWallet = (exId === 'bitget') ? 'swap' : 'future';
            const balanceData = (exId === 'kucoinfutures') ? await exchange.fetchBalance() : await exchange.fetchBalance({ 'type': fromWallet });
            
            const amountToSend = balanceData?.free?.USDT || 0;
            
            if (amountToSend > getMinTransferAmount(exId)) {
                safeLog('log', `[CLEANUP] Phát hiện ${amountToSend.toFixed(4)} USDT trên ${exId.toUpperCase()}. Bắt đầu chuyển toàn bộ về Hub...`);
                executeSingleFundTransfer(exId, HUB_EXCHANGE_ID, amountToSend);
            } else {
                safeLog('log', `[CLEANUP] Không có đủ tiền trên ${exId.toUpperCase()} để chuyển về Hub.`);
            }
        } catch (e) {
            safeLog('error', `[CLEANUP] Lỗi khi xử lý dọn dẹp cho sàn ${exId}: ${e.message}`);
        }
    }
    
    setTimeout(() => {
        safeLog('info', "[CLEANUP] ✅ Đã gửi tất cả các lệnh dọn dẹp. Bot quay về trạng thái chờ.");
        capitalManagementState = 'IDLE';
        selectedOpportunityForNextTrade = null;
    }, 5000);
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

async function prepareForTrade(opportunity) {
    const { coin, commonLeverage: desiredLeverage } = opportunity;
    const { shortExchange, longExchange } = opportunity.details;
    const shortEx = exchanges[shortExchange];
    const longEx = exchanges[longExchange];

    try {
        safeLog('log', `[PREPARE] Bắt đầu chuẩn bị cho giao dịch ${coin} giữa ${shortExchange} và ${longExchange}.`);

        const shortSymbol = await getExchangeSpecificSymbol(shortEx, coin);
        const longSymbol = await getExchangeSpecificSymbol(longEx, coin);
        if (!shortSymbol || !longSymbol) {
            throw new Error(`Không tìm thấy symbol ${coin} trên một trong hai sàn.`);
        }

        const [actualShortLeverage, actualLongLeverage] = await Promise.all([
            setLeverageSafely(shortEx, shortSymbol, desiredLeverage),
            setLeverageSafely(longEx, longSymbol, desiredLeverage)
        ]);
        if (!actualShortLeverage || !actualLongLeverage) {
            throw new Error('Không thể cài đặt đòn bẩy trên một trong hai sàn.');
        }
        
        const leverageToUse = Math.min(actualShortLeverage, actualLongLeverage);

        opportunity.preparedData = {
            shortSymbol,
            longSymbol,
            leverageToUse
        };
        
        safeLog('info', `[PREPARE] ✅ Chuẩn bị thành công cho ${coin}. Đòn bẩy hiệu dụng: x${leverageToUse}.`);
        return true;

    } catch (e) {
        safeLog('error', `[PREPARE] Lỗi nghiêm trọng khi chuẩn bị cho giao dịch ${coin}:`, e.message);
        opportunity.preparedData = null;
        return false;
    }
}

async function computeOrderDetails(exchange, symbol, targetNotionalUSDT, leverage, availableBalance) {
    const market = exchange.market(symbol);
    const ticker = await exchange.fetchTicker(symbol);
    const price = ticker?.last || ticker?.close;
    if (!price) throw new Error(`Không lấy được giá cho ${symbol} trên ${exchange.id}`);
    const contractSize = market.contractSize ?? 1;
    let amount = parseFloat(exchange.amountToPrecision(symbol, targetNotionalUSDT / (price * contractSize)));
    if (exchange.id === 'kucoinfutures' && market.precision.amount === 0) amount = Math.round(amount);
    if (amount <= (market.limits.amount.min || 0)) {
         throw new Error(`Số lượng tính toán (${amount}) phải lớn hơn mức tối thiểu của sàn (${market.limits.amount.min}).`);
    }
    let currentNotional = amount * price * contractSize;
    if (market.limits?.cost?.min && currentNotional < market.limits.cost.min) {
        throw new Error(`Giá trị lệnh ${currentNotional.toFixed(4)} < mức tối thiểu ${market.limits.cost.min} USDT.`);
    }
    const requiredMargin = currentNotional / leverage;
    const safetyBuffer = 0.98;
    if (requiredMargin > availableBalance * safetyBuffer) {
        const maxNotional = availableBalance * leverage * safetyBuffer;
        let newAmount = parseFloat(exchange.amountToPrecision(symbol, maxNotional / (price * contractSize)));
        if (exchange.id === 'kucoinfutures' && market.precision.amount === 0) newAmount = Math.floor(newAmount);
        if (newAmount <= (market.limits.amount.min || 0)) {
             throw new Error(`Không đủ ký quỹ sau khi điều chỉnh. Yêu cầu ${requiredMargin.toFixed(4)}, có sẵn ${availableBalance.toFixed(4)} USDT.`);
        }
        amount = newAmount;
        currentNotional = amount * price * contractSize;
    }
    return { amount, price, notional: currentNotional, requiredMargin: currentNotional / leverage };
}

async function placeTpSlOrders(exchange, symbol, side, amount, entryPrice, collateral, notionalValue) {
    if (!entryPrice || typeof entryPrice !== 'number' || entryPrice <= 0) return { tpOrderId: null, slOrderId: null };
    if (!notionalValue || notionalValue <= 0) return { tpOrderId: null, slOrderId: null };
    const pnlAmount = collateral * (TP_SL_PNL_PERCENTAGE / 100);
    const priceChange = (pnlAmount / notionalValue) * entryPrice;
    let tpPrice, slPrice;
    if (side === 'sell') {
        tpPrice = entryPrice - priceChange;
        slPrice = entryPrice + priceChange;
    } else {
        tpPrice = entryPrice + priceChange;
        slPrice = entryPrice - priceChange;
    }
    if (isNaN(tpPrice) || isNaN(slPrice)) return { tpOrderId: null, slOrderId: null };
    const orderSide = (side === 'sell') ? 'buy' : 'sell';
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
            const params = { 'closePosition': 'true' };
            tpResult = await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', orderSide, amount, undefined, { ...params, 'stopPrice': exchange.priceToPrecision(symbol, tpPrice) });
            slResult = await exchange.createOrder(symbol, 'STOP_MARKET', orderSide, amount, undefined, { ...params, 'stopPrice': exchange.priceToPrecision(symbol, slPrice) });
        }
        return { tpOrderId: tpResult.id, slOrderId: slResult.id };
    } catch (e) {
        safeLog('error', `[TP/SL] Lỗi khi đặt lệnh TP/SL cho ${symbol} trên ${exchange.id}:`, e);
        throw e;
    }
}

async function executeTrades(opportunity, percentageToUse) {
    if (!opportunity.preparedData) {
        safeLog('error', `[TRADE] Hủy bỏ giao dịch do quá trình chuẩn bị trước đó đã thất bại.`);
        return false;
    }

    const { coin } = opportunity;
    const { shortExchange, longExchange } = opportunity.details;
    const { shortSymbol, longSymbol, leverageToUse } = opportunity.preparedData;
    
    await updateBalances();
    const shortEx = exchanges[shortExchange], longEx = exchanges[longExchange];
    const shortBalance = balances[shortExchange]?.available || 0;
    const longBalance = balances[longExchange]?.available || 0;
    
    const minBalance = Math.min(shortBalance, longBalance);
    const collateral = minBalance * (percentageToUse / 100);

    if (collateral < MIN_COLLATERAL_FOR_TRADE) {
        safeLog('warn', `[TRADE] Vốn không đủ để giao dịch. Yêu cầu > ${MIN_COLLATERAL_FOR_TRADE}, đang có ${collateral.toFixed(4)}.`);
        return false;
    }

    let shortOrderDetails, longOrderDetails;
    try {
        const targetNotional = collateral * leverageToUse;
        [shortOrderDetails, longOrderDetails] = await Promise.all([
            computeOrderDetails(shortEx, shortSymbol, targetNotional, leverageToUse, shortBalance),
            computeOrderDetails(longEx, longSymbol, targetNotional, leverageToUse, longBalance)
        ]);
    } catch (e) {
        safeLog('error', `[EXECUTE] Lỗi khi tính toán chi tiết lệnh cuối cùng:`, e.message);
        return false;
    }

    safeLog('info', `[EXECUTE] 🔥 KÍCH HOẠT LỆNH! Short ${shortOrderDetails.amount} ${coin} trên ${shortExchange} | Long ${longOrderDetails.amount} ${coin} trên ${longExchange}.`);

    let shortOrder, longOrder;
    try {
        [shortOrder, longOrder] = await Promise.all([
            shortEx.createMarketSellOrder(shortSymbol, shortOrderDetails.amount, (shortEx.id === 'kucoinfutures' ? {'marginMode':'cross'} : {})),
            longEx.createMarketBuyOrder(longSymbol, longOrderDetails.amount, (longEx.id === 'kucoinfutures' ? {'marginMode':'cross'} : {}))
        ]);
    } catch (e) {
        safeLog('error', `[EXECUTE] Mở lệnh chính thất bại:`, e);
        return false;
    }

    await sleep(3000);
    const getReliableFillPrice = async (exchange, symbol, orderId) => {
        try {
            const order = await exchange.fetchOrder(orderId, symbol);
            if (order?.average > 0) return order.average;
            const trades = await exchange.fetchMyTrades(symbol, undefined, 1, { 'orderId': orderId });
            return trades?.[0]?.price > 0 ? trades[0].price : null;
        } catch (e) {
            safeLog('error', `Lỗi nghiêm trọng khi lấy giá khớp lệnh cho ${exchange.id}. Lỗi: ${e.message}`);
            return null;
        }
    };

    const [shortEntryPrice, longEntryPrice] = await Promise.all([ getReliableFillPrice(shortEx, shortSymbol, shortOrder.id), getReliableFillPrice(longEx, longSymbol, longOrder.id) ]);
    
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
        safeLog('warn', `[TRADE] Không lấy được giá khớp lệnh, sẽ không đặt TP/SL. Vui lòng kiểm tra thủ công.`);
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
        safeLog('error', `[TRADE] Lỗi nghiêm trọng khi đặt TP/SL. Sẽ đóng ngay vị thế vừa mở. Lỗi:`, e);
        currentTradeDetails = { ...tradeBaseInfo, status: 'CLOSING_DUE_TO_ERROR' };
        await closeTradeNow();
        return false;
    }

    safeLog('info', `[TRADE] ✅ Mở lệnh thành công cho ${coin}.`);
    capitalManagementState = 'TRADE_OPEN';
    return true;
}

async function closeTradeNow() {
    if (!currentTradeDetails) return false;
    const tradeToClose = { ...currentTradeDetails };
    
    const shortEx = exchanges[tradeToClose.shortExchange];
    const longEx = exchanges[tradeToClose.longExchange];

    try {
        safeLog('info', `[CLEANUP] Hủy toàn bộ lệnh chờ cho ${tradeToClose.shortOriginalSymbol} trên ${shortEx.id}.`);
        await shortEx.cancelAllOrders(tradeToClose.shortOriginalSymbol);
        safeLog('info', `[CLEANUP] Hủy toàn bộ lệnh chờ cho ${tradeToClose.longOriginalSymbol} trên ${longEx.id}.`);
        await sleep(1000);

        safeLog('info', `[CLEANUP] Đang đóng vị thế cho ${tradeToClose.coin}...`);
        
        const shortParams = { 'reduceOnly': true, ...(shortEx.id === 'kucoinfutures' && {'marginMode': 'cross'}) };
        const longParams = { 'reduceOnly': true, ...(longEx.id === 'kucoinfutures' && {'marginMode': 'cross'}) };

        await Promise.all([
            shortEx.createMarketBuyOrder(tradeToClose.shortOriginalSymbol, tradeToClose.shortOrderAmount, shortParams),
            longEx.createMarketSellOrder(tradeToClose.longOriginalSymbol, tradeToClose.longOrderAmount, longParams)
        ]);
        tradeAwaitingPnl = { ...currentTradeDetails, status: 'PENDING_PNL_CALC', closeTime: Date.now() };
        currentTradeDetails = null;
        return true;
    } catch (e) {
        safeLog('error', `[PNL] Lỗi khi đóng vị thế cho ${tradeToClose.coin}:`, e);
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
            safeLog('info', '[STATE] Tính PNL hoàn tất. Bắt đầu dọn dẹp và chuyển vốn về Hub.');
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
        
        if (currentMinute === 1) {
            hasLoggedNotFoundThisHour = false;
        }

        if (capitalManagementState === 'IDLE' && currentMinute === 50) {
            const opportunityToExecute = allCurrentOpportunities.find(op => {
                const minutesToFunding = (op.nextFundingTime - Date.now()) / 60000;
                return minutesToFunding > 0 && minutesToFunding < MIN_MINUTES_FOR_EXECUTION;
            });

            if (opportunityToExecute) {
                selectedOpportunityForNextTrade = opportunityToExecute;
                safeLog('info', `[TIMER] ✅ Đã chọn cơ hội: ${selectedOpportunityForNextTrade.coin} trên ${selectedOpportunityForNextTrade.exchanges}.`);
                Promise.all([
                    manageFundDistribution(selectedOpportunityForNextTrade),
                    prepareForTrade(selectedOpportunityForNextTrade)
                ]);
            } else if (!hasLoggedNotFoundThisHour) {
                safeLog('log', "[TIMER] Không tìm thấy cơ hội nào hợp lệ tại phút 50.");
                hasLoggedNotFoundThisHour = true;
            }
        }
        else if (capitalManagementState === 'FUNDS_READY' && selectedOpportunityForNextTrade) {
            if (selectedOpportunityForNextTrade.isManualTest) {
                safeLog('info', `[MANUAL-TEST] Vốn đã sẵn sàng. Thực hiện giao dịch test cho ${selectedOpportunityForNextTrade.coin}.`);
                const success = await executeTrades(selectedOpportunityForNextTrade, selectedOpportunityForNextTrade.percentageToUse);
                if (!success) {
                    safeLog('error', "[MANUAL-TEST] Lỗi khi vào lệnh test. Bắt đầu dọn dẹp vốn.");
                    await returnFundsToHub();
                }
            }
            else if (currentMinute === 59) {
                safeLog('log', `[TIMER] Phút 59: Thực hiện giao dịch cho ${selectedOpportunityForNextTrade.coin}.`);
                const success = await executeTrades(selectedOpportunityForNextTrade, currentPercentageToUse);
                if (!success) {
                    safeLog('error', "[TIMER] Lỗi khi vào lệnh. Bắt đầu dọn dẹp vốn.");
                    await returnFundsToHub();
                }
            }
        }
        else if (capitalManagementState === 'TRADE_OPEN' && currentMinute === 0 && currentSecond >= 5 && currentSecond < 15) {
            if (currentTradeDetails) {
                 safeLog('log', `[TIMER] Đầu giờ mới: Đóng vị thế cho ${currentTradeDetails.coin}.`);
                 await closeTradeNow();
            }
        }
        else if (currentMinute > 5 && capitalManagementState !== 'IDLE' && capitalManagementState !== 'TRADE_OPEN') {
            safeLog('warn', `[RESET] Trạng thái ${capitalManagementState} bị kẹt, đang reset về IDLE và dọn dẹp vốn.`);
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
            if (capitalManagementState !== 'IDLE') {
                return res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: `Bot đang bận với tác vụ '${capitalManagementState}'. Không thể test.` }));
            }
            if (!bestPotentialOpportunityForDisplay) {
                return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: 'Chưa có cơ hội nào để test.' }));
            }
            try {
                const data = JSON.parse(body);
                selectedOpportunityForNextTrade = {
                    coin: bestPotentialOpportunityForDisplay.coin,
                    commonLeverage: parseInt(data.leverage, 10) || 20,
                    details: { shortExchange: data.shortExchange, longExchange: data.longExchange },
                    isManualTest: true,
                    percentageToUse: parseFloat(data.percentage) || 50
                };
                safeLog('info', `[MANUAL-TEST] Nhận yêu cầu test thủ công cho ${selectedOpportunityForNextTrade.coin}. Bắt đầu gom vốn và chuẩn bị.`);
                Promise.all([
                    manageFundDistribution(selectedOpportunityForNextTrade),
                    prepareForTrade(selectedOpportunityForNextTrade)
                ]);
                res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, message: 'Đã nhận yêu cầu Test. Bot đang gom vốn và chuẩn bị, sẽ tự động vào lệnh khi sẵn sàng.' }));
            } catch(e) {
                res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: 'Dữ liệu yêu cầu không hợp lệ.' }));
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
            
            let exchange = exchanges[exchangeId];
            if (!exchange) {
                return res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: `Sàn ${exchangeId} chưa được khởi tạo.` }));
            }
            
            let from = genericFrom, to = genericTo;
        
            if (exchangeId === 'bitget') {
                if (from === 'future') from = 'swap';
                if (to === 'future') to = 'swap';
            } else if (exchangeId === 'kucoinfutures' || exchangeId === 'kucoin') {
                if (from === 'spot') from = 'main';
                if (to === 'spot') to = 'main';
                if (from === 'main') exchange = exchanges['kucoin'];
            } else if (exchangeId === 'binanceusdm' || exchangeId === 'binance') {
                if (from === 'spot') exchange = exchanges['binance'];
            }
        
            try {
                await exchange.transfer('USDT', amount, from, to);
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
