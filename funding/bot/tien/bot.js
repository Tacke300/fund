const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

// --- CẤU HÌNH CHÍNH ---
const { usdtDepositAddressesByNetwork } = require('./balance.js');
const {
    binanceApiKey, binanceApiSecret,
    okxApiKey, okxApiSecret, okxPassword,
    bitgetApiKey, bitgetApiSecret, bitgetApiPassword,
    kucoinApiKey, kucoinApiSecret, kucoinApiPassword
} = require('./config.js');

const BOT_PORT = 5006;
const SERVER_DATA_URL = 'http://localhost:5005/api/data';
const HUB_EXCHANGE_ID = 'binanceusdm'; // Sàn chính để lưu trữ vốn

// --- CẤU HÌNH GIAO DỊCH ---
const MIN_PNL_PERCENTAGE = 1;
const MIN_MINUTES_FOR_EXECUTION = 15;
const DATA_FETCH_INTERVAL_SECONDS = 1;
const MAX_CONSECUTIVE_FAILS = 3;
const MIN_COLLATERAL_FOR_TRADE = 0.1;
const TP_SL_PNL_PERCENTAGE = 150;

// --- CẤU HÌNH CHUYỂN TIỀN ---
const FUND_TRANSFER_MIN_AMOUNT_BINANCE = 10;
const FUND_TRANSFER_MIN_AMOUNT_KUCOIN = 5;
const FUND_TRANSFER_MIN_AMOUNT_BITGET = 5;

// --- TRẠNG THÁI TOÀN CỤC CỦA BOT ---
const ALL_POSSIBLE_EXCHANGE_IDS = ['binanceusdm', 'bitget', 'okx', 'kucoinfutures'];
const DISABLED_EXCHANGES = [];
const activeExchangeIds = ALL_POSSIBLE_EXCHANGE_IDS.filter(id => !DISABLED_EXCHANGES.includes(id));

let botState = 'STOPPED';
let capitalManagementState = 'IDLE'; // IDLE, PREPARING_FUNDS, FUNDS_READY, TRADE_OPEN, CLEANING_UP
let botLoopIntervalId = null;
let balances = {};
let tradeHistory = [];
let bestPotentialOpportunityForDisplay = null;
let currentTradeDetails = null;
let tradeAwaitingPnl = null;
let currentPercentageToUse = 50;
let exchangeHealth = {};
let transferStatus = { inProgress: false, message: null };
let selectedOpportunityForNextTrade = null;

// --- KHỞI TẠO ---
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
        let exchangeClass, config = { 'enableRateLimit': true, 'verbose': false, 'options': { 'defaultType': 'swap' } };
        if (id === 'binanceusdm') { exchangeClass = ccxt.binanceusdm; config.apiKey = binanceApiKey; config.secret = binanceApiSecret; }
        else if (id === 'okx') { exchangeClass = ccxt.okx; config.apiKey = okxApiKey; config.secret = okxApiSecret; config.password = okxPassword; }
        else if (id === 'bitget') { exchangeClass = ccxt.bitget; config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret; config.password = bitgetApiPassword; }
        else if (id === 'kucoinfutures') { exchangeClass = ccxt.kucoinfutures; config.apiKey = kucoinApiKey; config.secret = kucoinApiSecret; config.password = kucoinApiPassword; delete config.options; }
        
        if (config.apiKey && config.secret) { exchanges[id] = new exchangeClass(config); safeLog('log', `[INIT] Khởi tạo sàn ${id.toUpperCase()} thành công.`); }
        else { safeLog('warn', `[INIT] Bỏ qua ${id.toUpperCase()} do thiếu API Key/Secret.`); }
    } catch (e) { safeLog('error', `[INIT] Lỗi khi khởi tạo sàn ${id.toUpperCase()}: ${e}`); }
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// --- CÁC HÀM TIỆN ÍCH VÀ LOGIC CỐT LÕI (ĐÃ NÂNG CẤP) ---

function getMinTransferAmount(exchangeId) {
    if (exchangeId === 'binanceusdm') return FUND_TRANSFER_MIN_AMOUNT_BINANCE;
    if (exchangeId === 'kucoinfutures') return FUND_TRANSFER_MIN_AMOUNT_KUCOIN;
    if (exchangeId === 'bitget') return FUND_TRANSFER_MIN_AMOUNT_BITGET;
    return 5; // Mặc định
}

function getTargetDepositInfo(fromExchangeId, toExchangeId) {
    // Logic này có thể cần tùy chỉnh chi tiết hơn nếu có nhiều mạng lưới
    const network = 'BEP20'; // Giả định BEP20 là mạng lưới chính
    const depositAddress = usdtDepositAddressesByNetwork[toExchangeId]?.[network];
    if (!depositAddress || depositAddress.startsWith('ĐIỀN ĐỊA CHỈ')) {
        safeLog('error', `[HELPER] Lỗi: Địa chỉ nạp tiền cho ${toExchangeId.toUpperCase()} qua mạng ${network} chưa được cấu hình.`);
        return null;
    }
    return { network, address: depositAddress };
}

async function fetchAllBalances(type = 'future') {
    const allBalances = {};
    await Promise.all(activeExchangeIds.map(async (id) => {
        if (!exchanges[id] || exchangeHealth[id].isDisabled) {
            allBalances[id] = 0;
            return;
        }
        try {
            const balanceData = (id === 'kucoinfutures')
                ? await exchanges[id].fetchBalance()
                : await exchanges[id].fetchBalance({ 'type': type });
            allBalances[id] = balanceData?.free?.USDT || 0;
            if(type === 'future') balances[id] = { available: allBalances[id], total: balanceData?.total?.USDT || 0 };
        } catch (e) {
            safeLog('warn', `[BALANCE] Không thể lấy số dư ${type} từ ${id}: ${e.message}`);
            allBalances[id] = 0;
             if(type === 'future') balances[id] = { available: 0, total: 0 };
        }
    }));
    return allBalances;
}
const updateBalances = () => fetchAllBalances('future');


/**
 * [BUG FIX] Hàm theo dõi số dư mới, đáng tin cậy hơn.
 * Sẽ kiểm tra xem số dư có thực sự tăng lên sau khi chuyển hay không.
 */
async function pollForBalanceArrival(exchangeId, amountToReceive, maxPollAttempts = 90, pollIntervalMs = 10000) {
    const exchange = exchanges[exchangeId];
    const targetWalletType = (exchangeId === 'kucoinfutures') ? 'main' : 'spot';
    
    try {
        const initialBalanceData = await exchange.fetchBalance();
        const initialBalance = initialBalanceData[targetWalletType]?.free?.USDT || 0;
        safeLog('log', `[POLL] Số dư ban đầu tại ví ${targetWalletType} của ${exchangeId.toUpperCase()}: ${initialBalance.toFixed(4)} USDT.`);

        for (let i = 0; i < maxPollAttempts; i++) {
            await sleep(pollIntervalMs);
            try {
                const currentBalanceData = await exchange.fetchBalance();
                const currentBalance = currentBalanceData[targetWalletType]?.free?.USDT || 0;
                
                // Điều kiện thành công: số dư mới phải lớn hơn số dư cũ cộng với 90% số tiền dự kiến nhận (trừ hao phí rút)
                if (currentBalance > initialBalance && currentBalance >= initialBalance + (amountToReceive * 0.90)) {
                    safeLog('info', `[POLL] ✅ TIỀN ĐÃ VỀ! Số dư mới trên ${exchangeId.toUpperCase()}: ${currentBalance.toFixed(4)} USDT.`);
                    return { success: true, receivedAmount: currentBalance - initialBalance };
                }
            } catch (pollError) {
                safeLog('warn', `[POLL] Lỗi nhỏ trong lúc chờ tiền về ${exchangeId.toUpperCase()}: ${pollError.message}`);
            }
        }
        safeLog('error', `[POLL] ❌ HẾT THỜI GIAN! Không nhận được ${amountToReceive} USDT trên ${exchangeId.toUpperCase()} sau khi chờ.`);
        return { success: false };
    } catch (e) {
        safeLog('error', `[POLL] Lỗi nghiêm trọng khi lấy số dư ban đầu của ${exchangeId.toUpperCase()}: ${e.message}`);
        return { success: false };
    }
}


/**
 * Hàm chuyển tiền được tái cấu trúc để trả về trạng thái thành công/thất bại.
 */
async function executeSingleFundTransfer(fromExchangeId, toExchangeId, amount) {
    transferStatus = { inProgress: true, message: `Bắt đầu chuyển ${amount.toFixed(2)} USDT từ ${fromExchangeId} -> ${toExchangeId}.` };
    safeLog('log', `[TRANSFER] ${transferStatus.message}`);
    const sourceExchange = exchanges[fromExchangeId];
    const targetExchange = exchanges[toExchangeId];

    try {
        // 1. Chuyển từ Future -> Spot/Main trên sàn nguồn
        let fromWallet = 'future', toWallet = 'spot';
        if (fromExchangeId === 'bitget') { fromWallet = 'swap'; }
        if (fromExchangeId === 'kucoinfutures') { toWallet = 'main'; }
        
        transferStatus.message = `1/4: Chuyển ${amount.toFixed(2)} USDT sang ví ${toWallet} trên ${fromExchangeId}...`;
        safeLog('log', `[TRANSFER] ${transferStatus.message}`);
        await sourceExchange.transfer('USDT', amount, fromWallet, toWallet);
        await sleep(5000);

        // 2. Rút tiền từ sàn nguồn đến sàn đích
        const targetDepositInfo = getTargetDepositInfo(fromExchangeId, toExchangeId);
        if(!targetDepositInfo) throw new Error("Không tìm thấy thông tin địa chỉ nạp tiền.");
        
        transferStatus.message = `2/4: Gửi lệnh rút ${amount.toFixed(2)} USDT đến ${toExchangeId}...`;
        safeLog('log', `[TRANSFER] ${transferStatus.message}`);
        const params = (fromExchangeId === 'bitget') ? { chain: targetDepositInfo.network } : { network: targetDepositInfo.network };
        await sourceExchange.withdraw('USDT', amount, targetDepositInfo.address, undefined, params);
        
        // 3. Chờ tiền về ở sàn đích (sử dụng hàm mới)
        transferStatus.message = `3/4: Đang chờ blockchain xác nhận và tiền về ${toExchangeId}...`;
        safeLog('log', `[TRANSFER] ${transferStatus.message}`);
        const pollResult = await pollForBalanceArrival(toExchangeId, amount);
        if (!pollResult.success) throw new Error(`Bot không xác nhận được tiền về trên ${toExchangeId}.`);

        // 4. Chuyển tiền từ Spot/Main -> Future trên sàn đích
        const receivedAmount = pollResult.receivedAmount;
        transferStatus.message = `4/4: Đã nhận ${receivedAmount.toFixed(2)} USDT! Chuyển vào ví future trên ${toExchangeId}...`;
        safeLog('log', `[TRANSFER] ${transferStatus.message}`);
        await sleep(5000); 
        
        let targetFromWallet = 'spot', targetToWallet = 'future';
        if (toExchangeId === 'kucoinfutures') { targetFromWallet = 'main'; }
        if (toExchangeId === 'bitget') { targetToWallet = 'swap'; }
        
        await targetExchange.transfer('USDT', receivedAmount, targetFromWallet, targetToWallet);
        
        transferStatus = { inProgress: false, message: `✅ Hoàn tất chuyển tiền tới ${toExchangeId}!` };
        safeLog('info', `[TRANSFER] ${transferStatus.message}`);
        await updateBalances();
        return true;

    } catch (e) {
        safeLog('error', `[TRANSFER] ❌ LỖI NGHIÊM TRỌNG khi chuyển từ ${fromExchangeId} -> ${toExchangeId}:`, e);
        transferStatus = { inProgress: false, message: `Lỗi: ${e.message}` };
        return false;
    }
}

// --- CÁC HÀM QUẢN LÝ VỐN TỰ ĐỘNG MỚI ---

/**
 * Giai đoạn 1: Gom vốn từ Hub đến 2 sàn được chọn để giao dịch.
 */
async function manageFundDistribution(opportunity) {
    capitalManagementState = 'PREPARING_FUNDS';
    safeLog('info', "[CAPITAL] Bắt đầu Giai đoạn 1: Gom vốn cho cơ hội giao dịch.");
    const { shortExchange, longExchange } = opportunity.details;
    const tradingExchanges = [shortExchange, longExchange];
    
    const allFutBalances = await fetchAllBalances('future');
    const totalCapital = Object.values(allFutBalances).reduce((sum, bal) => sum + bal, 0);
    const targetPerExchange = totalCapital / 2;
    safeLog('log', `[CAPITAL] Tổng vốn: ${totalCapital.toFixed(2)} USDT. Mục tiêu mỗi sàn: ${targetPerExchange.toFixed(2)} USDT.`);

    let success = true;
    for (const targetEx of tradingExchanges) {
        if (targetEx === HUB_EXCHANGE_ID) continue; // Không cần chuyển cho chính nó
        
        const currentBalance = allFutBalances[targetEx] || 0;
        const amountNeeded = targetPerExchange - currentBalance;
        
        if (amountNeeded > getMinTransferAmount(HUB_EXCHANGE_ID)) {
            safeLog('log', `[CAPITAL] Sàn ${targetEx.toUpperCase()} cần ${amountNeeded.toFixed(2)} USDT.`);
            const transferSuccess = await executeSingleFundTransfer(HUB_EXCHANGE_ID, targetEx, amountNeeded);
            if (!transferSuccess) {
                safeLog('error', `[CAPITAL] Chuyển vốn đến ${targetEx.toUpperCase()} thất bại. Hủy phiên giao dịch.`);
                success = false;
                break; 
            }
        } else {
             safeLog('log', `[CAPITAL] Sàn ${targetEx.toUpperCase()} đã có đủ vốn hoặc số tiền cần chuyển quá nhỏ.`);
        }
    }

    if (!success) {
        safeLog('warn', "[CAPITAL] Do có lỗi, sẽ bắt đầu dọn dẹp và trả vốn về Hub.");
        await returnFundsToHub();
        return false;
    }
    
    safeLog('info', "[CAPITAL] ✅ Hoàn tất gom vốn. Chờ đến phút 59 để vào lệnh.");
    capitalManagementState = 'FUNDS_READY';
    return true;
}

/**
 * Giai đoạn 3: Dọn dẹp, chuyển toàn bộ tiền từ các sàn phụ về Hub.
 */
async function returnFundsToHub() {
    capitalManagementState = 'CLEANING_UP';
    safeLog('info', "[CLEANUP] Bắt đầu Giai đoạn 3: Dọn dẹp và chuyển toàn bộ vốn về Hub.");
    await sleep(2 * 60 * 1000); // Chờ 2 phút sau khi đóng lệnh
    
    const nonHubExchanges = activeExchangeIds.filter(id => id !== HUB_EXCHANGE_ID && exchanges[id]);
    
    for (const exId of nonHubExchanges) {
        await sleep(5000); // Chờ 1 chút giữa các lần chuyển
        const balances = await fetchAllBalances('future');
        const amountToReturn = balances[exId] || 0;
        
        if (amountToReturn > getMinTransferAmount(exId)) {
            safeLog('log', `[CLEANUP] Phát hiện ${amountToReturn.toFixed(2)} USDT trên ${exId.toUpperCase()}. Bắt đầu chuyển về Hub...`);
            await executeSingleFundTransfer(exId, HUB_EXCHANGE_ID, amountToReturn);
        } else {
            safeLog('log', `[CLEANUP] Không có đủ tiền trên ${exId.toUpperCase()} để chuyển về Hub.`);
        }
    }
    
    safeLog('info', "[CLEANUP] ✅ Hoàn tất dọn dẹp. Bot quay về trạng thái chờ.");
    capitalManagementState = 'IDLE';
    selectedOpportunityForNextTrade = null;
}

// --- CÁC HÀM GIAO DỊCH (Giữ nguyên phần lớn) ---
// ... (Hàm getExchangeSpecificSymbol, setLeverageSafely, computeOrderDetails, placeTpSlOrders, v.v...)
// ... (Các hàm này không thay đổi, có thể copy từ code cũ)
// --- BẮT ĐẦU CÁC HÀM GIAO DỊCH ---

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

const normalizeExchangeId = (id) => {
    if (!id) return null;
    const lowerId = id.toLowerCase().trim();
    if (lowerId.includes('binance')) return 'binanceusdm';
    if (lowerId.includes('kucoin')) return 'kucoinfutures';
    return lowerId;
};

async function processServerData(serverData) {
    if (!serverData || !serverData.arbitrageData) {
        bestPotentialOpportunityForDisplay = null;
        return;
    }
    const opportunities = serverData.arbitrageData
        .filter(op => {
            if (!op?.exchanges || typeof op.exchanges !== 'string' || op.estimatedPnl < MIN_PNL_PERCENTAGE) return false;
            const [shortExRaw, longExRaw] = op.exchanges.split(' / ');
            if (!shortExRaw || !longExRaw) return false;
            const shortExchange = normalizeExchangeId(shortExRaw);
            const longExchange = normalizeExchangeId(longExRaw);
            return exchanges[shortExchange] && !exchangeHealth[shortExchange]?.isDisabled &&
                   exchanges[longExchange] && !exchangeHealth[longExchange]?.isDisabled;
        })
        .map(op => {
            const [shortExRaw, longExRaw] = op.exchanges.split(' / ');
            op.details = { shortExchange: normalizeExchangeId(shortExRaw), longExchange: normalizeExchangeId(longExRaw) };
            return op;
        });
    const sortedOpportunities = opportunities.sort((a, b) => b.estimatedPnl - a.estimatedPnl);
    bestPotentialOpportunityForDisplay = sortedOpportunities.length > 0 ? sortedOpportunities[0] : null;
    
    if (bestPotentialOpportunityForDisplay) {
        const minutesToFunding = (bestPotentialOpportunityForDisplay.nextFundingTime - Date.now()) / 60000;
        if (minutesToFunding > 0 && minutesToFunding < MIN_MINUTES_FOR_EXECUTION) {
             selectedOpportunityForNextTrade = bestPotentialOpportunityForDisplay;
        } else {
             selectedOpportunityForNextTrade = null;
        }
    } else {
        selectedOpportunityForNextTrade = null;
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
            const tpParams = { 'reduceOnly': true, 'stop': side === 'sell' ? 'down' : 'up', 'stopPrice': exchange.priceToPrecision(symbol, tpPrice), 'stopPriceType': 'MP' };
            tpResult = await exchange.createOrder(symbol, 'market', orderSide, amount, undefined, tpParams);
            const slParams = { 'reduceOnly': true, 'stop': side === 'sell' ? 'up' : 'down', 'stopPrice': exchange.priceToPrecision(symbol, slPrice), 'stopPriceType': 'MP' };
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
        return { tpOrderId: null, slOrderId: null };
    }
}


async function executeTrades(opportunity, percentageToUse) {
    const { coin, commonLeverage: desiredLeverage } = opportunity;
    const { shortExchange, longExchange } = opportunity.details;
    
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

    const shortSymbol = await getExchangeSpecificSymbol(shortEx, coin);
    const longSymbol = await getExchangeSpecificSymbol(longEx, coin);
    if (!shortSymbol || !longSymbol) {
        safeLog('warn', `[TRADE] Không tìm thấy symbol ${coin} trên một trong hai sàn.`);
        return false;
    }

    const [actualShortLeverage, actualLongLeverage] = await Promise.all([
        setLeverageSafely(shortEx, shortSymbol, desiredLeverage),
        setLeverageSafely(longEx, longSymbol, desiredLeverage)
    ]);

    if (!actualShortLeverage || !actualLongLeverage) return false;
    const leverageToUse = Math.min(actualShortLeverage, actualLongLeverage);

    let shortOrderDetails, longOrderDetails;
    try {
        const targetNotional = collateral * leverageToUse;
        [shortOrderDetails, longOrderDetails] = await Promise.all([
            computeOrderDetails(shortEx, shortSymbol, targetNotional, leverageToUse, shortBalance),
            computeOrderDetails(longEx, longSymbol, targetNotional, leverageToUse, longBalance)
        ]);
    } catch (e) {
        safeLog('error', `[PREPARE] Lỗi khi chuẩn bị lệnh:`, e.message);
        return false;
    }

    let shortOrder, longOrder;
    try {
        [shortOrder, longOrder] = await Promise.all([
            shortEx.createMarketSellOrder(shortSymbol, shortOrderDetails.amount, (shortEx.id === 'kucoinfutures' ? {'marginMode':'cross'} : {})),
            longEx.createMarketBuyOrder(longSymbol, longOrderDetails.amount, (longEx.id === 'kucoinfutures' ? {'marginMode':'cross'} : {}))
        ]);
    } catch (e) {
        safeLog('error', `[TRADE] Mở lệnh chính thất bại:`, e);
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
        safeLog('warn', `[TRADE] Không lấy được giá khớp lệnh, sẽ không đặt TP/SL. Vui lòng kiểm tra thủ công.`);
        return true;
    }

    const [shortTpSlIds, longTpSlIds] = await Promise.all([
        placeTpSlOrders(shortEx, shortSymbol, 'sell', shortOrderDetails.amount, shortEntryPrice, collateral, shortOrderDetails.notional),
        placeTpSlOrders(longEx, longSymbol, 'buy', longOrderDetails.amount, longEntryPrice, collateral, longOrderDetails.notional)
    ]);
    currentTradeDetails = {
        ...tradeBaseInfo, status: 'OPEN',
        shortTpOrderId: shortTpSlIds.tpOrderId, shortSlOrderId: shortTpSlIds.slOrderId,
        longTpOrderId: longTpSlIds.tpOrderId, longSlOrderId: longTpSlIds.slOrderId,
    };
    safeLog('info', `[TRADE] ✅ Mở lệnh thành công cho ${coin}.`);
    capitalManagementState = 'TRADE_OPEN';
    return true;
}

async function cancelPendingOrders(tradeDetails) {
    if (!tradeDetails) return;
    const ordersToCancel = [
        { ex: exchanges[tradeDetails.shortExchange], symbol: tradeDetails.shortOriginalSymbol, id: tradeDetails.shortTpOrderId },
        { ex: exchanges[tradeDetails.shortExchange], symbol: tradeDetails.shortOriginalSymbol, id: tradeDetails.shortSlOrderId },
        { ex: exchanges[tradeDetails.longExchange], symbol: tradeDetails.longOriginalSymbol, id: tradeDetails.longTpOrderId },
        { ex: exchanges[tradeDetails.longExchange], symbol: tradeDetails.longOriginalSymbol, id: tradeDetails.longSlOrderId },
    ];
    await Promise.all(ordersToCancel.map(async (order) => {
        if (order.id && order.ex) {
            try {
                await order.ex.cancelOrder(order.id, order.symbol, (order.ex.id === 'kucoinfutures' || order.ex.id === 'bitget') ? { 'stop': true } : {});
            } catch (e) {
                 if (!e.message.includes('order not found')) {
                    safeLog('warn', `[CLEANUP] Không thể hủy lệnh ${order.id}: ${e.message}`);
                 }
            }
        }
    }));
}

async function closeTradeNow() {
    if (!currentTradeDetails) return false;
    const tradeToClose = { ...currentTradeDetails };
    
    if (tradeToClose.status === 'OPEN') {
        safeLog('info', `[CLEANUP] Đang dọn dẹp các lệnh chờ cho ${tradeToClose.coin}...`);
        await cancelPendingOrders(tradeToClose);
        await sleep(1000); 
    }

    try {
        const shortEx = exchanges[tradeToClose.shortExchange];
        const longEx = exchanges[tradeToClose.longExchange];
        const params = { 'reduceOnly': true, ...(shortEx.id === 'kucoinfutures' && {'marginMode': 'cross'}) };
        safeLog('info', `[CLEANUP] Đang đóng vị thế cho ${tradeToClose.coin}...`);
        await Promise.all([
            shortEx.createMarketBuyOrder(tradeToClose.shortOriginalSymbol, tradeToClose.shortOrderAmount, params),
            longEx.createMarketSellOrder(tradeToClose.longOriginalSymbol, tradeToClose.longOrderAmount, params)
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
}

// --- VÒNG LẶP CHÍNH CỦA BOT (ĐÃ VIẾT LẠI HOÀN TOÀN) ---

async function mainBotLoop() {
    if (botState !== 'RUNNING') return;

    try {
        if (tradeAwaitingPnl) await calculatePnlAfterDelay(tradeAwaitingPnl);
        
        const now = new Date();
        const currentMinute = now.getUTCMinutes();
        const currentSecond = now.getUTCSeconds();

        // GIAI ĐOẠN 1: CHUẨN BỊ VỐN (PHÚT 50)
        if (currentMinute === 50 && capitalManagementState === 'IDLE') {
            safeLog('info', "[TIMER] Phút 50: Bắt đầu chu trình giao dịch mới.");
            const serverData = await fetchDataFromServer();
            await processServerData(serverData);
            
            if (selectedOpportunityForNextTrade) {
                safeLog('info', `[TIMER] Đã chọn cơ hội: ${selectedOpportunityForNextTrade.coin} trên ${selectedOpportunityForNextTrade.exchanges}.`);
                await manageFundDistribution(selectedOpportunityForNextTrade);
            } else {
                safeLog('log', "[TIMER] Không tìm thấy cơ hội hợp lệ tại phút 50.");
            }
        }
        
        // GIAI ĐOẠN 2: VÀO LỆNH (PHÚT 59)
        else if (currentMinute === 59 && capitalManagementState === 'FUNDS_READY') {
            safeLog('log', `[TIMER] Phút 59: Thực hiện giao dịch cho ${selectedOpportunityForNextTrade.coin}.`);
            const success = await executeTrades(selectedOpportunityForNextTrade, currentPercentageToUse);
            if (!success) {
                safeLog('error', "[TIMER] Lỗi khi vào lệnh. Bắt đầu dọn dẹp vốn.");
                await returnFundsToHub(); // Nếu vào lệnh lỗi, dọn dẹp ngay
            }
        }
        
        // GIAI ĐOẠN 3: ĐÓNG LỆNH (PHÚT 00)
        else if (currentMinute === 0 && currentSecond >= 5 && currentSecond < 10 && capitalManagementState === 'TRADE_OPEN') {
            if (currentTradeDetails) {
                 safeLog('log', `[TIMER] Đầu giờ mới: Đóng vị thế cho ${currentTradeDetails.coin}.`);
                 await closeTradeNow();
                 // Sau khi đóng, bot sẽ chờ đến phút 02 để bắt đầu dọn dẹp
            }
        }
        
        // GIAI ĐOẠN 4: DỌN DẸP (PHÚT 02)
        else if (currentMinute === 2 && capitalManagementState === 'TRADE_OPEN' && !currentTradeDetails && !tradeAwaitingPnl) {
            await returnFundsToHub();
        }
        
        // Reset trạng thái nếu bị kẹt
        else if (currentMinute > 5 && capitalManagementState !== 'IDLE' && capitalManagementState !== 'TRADE_OPEN') {
            safeLog('warn', `[RESET] Trạng thái ${capitalManagementState} bị kẹt, đang reset về IDLE.`);
            capitalManagementState = 'IDLE';
            selectedOpportunityForNextTrade = null;
        }

    } catch (e) {
        safeLog('error', '[LOOP] Lỗi nghiêm trọng trong vòng lặp chính:', e);
        capitalManagementState = 'IDLE'; // Reset khi có lỗi
    }

    if (botState === 'RUNNING') {
        botLoopIntervalId = setTimeout(mainBotLoop, DATA_FETCH_INTERVAL_SECONDS * 1000);
    }
}


// --- ĐIỀU KHIỂN BOT VÀ SERVER API ---

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
    // ... (Phần server API không thay đổi nhiều, nhưng cần thêm `capitalManagementState` vào response)
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
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                botState, 
                capitalManagementState, // Gửi trạng thái mới cho UI
                balances, 
                tradeHistory, 
                bestPotentialOpportunityForDisplay, 
                currentTradeDetails, 
                exchangeHealth, 
                transferStatus 
            }));
        } else if (url === '/bot-api/start' && method === 'POST') {
             try { currentPercentageToUse = parseFloat(JSON.parse(body).percentageToUse) || 50; } catch { currentPercentageToUse = 50; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: startBot(), message: 'Đã gửi yêu cầu khởi động bot.' }));
        } else if (url === '/bot-api/stop' && method === 'POST') {
             res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: stopBot(), message: 'Đã gửi yêu cầu dừng bot.' }));
        } else if (url === '/bot-api/close-trade-now' && method === 'POST') {
            const success = await closeTradeNow();
            if(success) await returnFundsToHub(); // Nếu đóng tay, cũng dọn dẹp luôn
            res.writeHead(success ? 200 : 400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success, message: success ? 'Đã gửi yêu cầu đóng lệnh và dọn dẹp.' : 'Không có lệnh đang mở hoặc có lỗi.' }));
        } else if (url === '/bot-api/transfer-funds' && method === 'POST') {
            if (capitalManagementState !== 'IDLE') {
                 return res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: 'Bot đang bận, không thể chuyển tiền thủ công.' }));
            }
             const { fromExchangeId, toExchangeId, amountStr } = JSON.parse(body);
            const amount = parseFloat(amountStr);
            // ... (các validation khác)
            executeSingleFundTransfer(fromExchangeId, toExchangeId, amount);
            res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, message: 'Đã nhận yêu cầu chuyển tiền.' }));
        }
        // ... (các endpoint khác như internal-transfer có thể giữ nguyên)
        else {
            res.writeHead(404).end('Not Found');
        }

    } catch (error) {
        safeLog('error', `[SERVER] Lỗi xử lý yêu cầu ${method} ${url}:`, error);
        res.writeHead(500).end('Internal Server Error');
    }
});


botServer.listen(BOT_PORT, () => {
    safeLog('log', `Máy chủ UI của Bot đang chạy tại http://localhost:${BOT_PORT}`);
});
