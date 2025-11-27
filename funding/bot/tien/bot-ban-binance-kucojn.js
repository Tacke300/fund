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

const BOT_PORT = 2404;
const SERVER_DATA_URL = 'http://localhost:5005/api/data';

// [CONFIG] Cấu hình
const MIN_PNL_PERCENTAGE = 1;
const MIN_MINUTES_FOR_EXECUTION = 15; 
const DATA_FETCH_INTERVAL_SECONDS = 1; 

// [CHANGE] Sửa vốn tối thiểu xuống 0.05
const MIN_COLLATERAL_FOR_TRADE = 0.05; 

// [CONFIG] Danh sách đen
const BLACKLISTED_COINS = ['GAIBUSDT', 'AIAUSDT', '42USDT'];

// [CONFIG] TP / SL
const SL_PERCENTAGE = 75;  
const TP_PERCENTAGE = 125; 

const FUND_TRANSFER_MIN_AMOUNT_BINANCE = 10;
const FUND_TRANSFER_MIN_AMOUNT_KUCOIN = 1;
const FUND_TRANSFER_MIN_AMOUNT_BITGET = 10;
const FUND_ARRIVAL_TOLERANCE = 2; 

const ALL_POSSIBLE_EXCHANGE_IDS = ['binanceusdm', 'bitget', 'okx', 'kucoinfutures', 'kucoin', 'binance'];
const DISABLED_EXCHANGES = [];
const activeExchangeIds = ALL_POSSIBLE_EXCHANGE_IDS.filter(id => !DISABLED_EXCHANGES.includes(id));

// STATE VARIABLES
let botState = 'STOPPED';
let capitalManagementState = 'IDLE';
let botLoopIntervalId = null;
let lastSelectionScanTime = 0; 
let balances = {};
let tradeHistory = [];
let bestPotentialOpportunityForDisplay = null;
let allCurrentOpportunities = [];
let activeTrades = []; 
let selectedOpportunityForNextTrade = null;
let currentTradeConfig = { mode: 'percent', value: 50 };
let exchangeHealth = {};
let transferStatus = { inProgress: false, message: null };
let hasLoggedNotFoundThisHour = false;
let failedCoinsInSession = new Set();

// ------------------------------------------------------------------
// SAFE LOG
// ------------------------------------------------------------------
const safeLog = (type, ...args) => {
    try {
        const timestamp = new Date().toLocaleTimeString('vi-VN');
        let message = args.map(arg => (arg instanceof Error) ? (arg.stack || arg.message) : (typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg)).join(' ');
        
        if (message.includes('<!DOCTYPE html>') || message.includes('<html>') || message.includes('<head>')) {
            if (type === 'error') {
                console.warn(`[${timestamp} WARN] ⚠️ Sàn trả về lỗi 404/HTML (Coin rác hoặc không tồn tại). Đã ẩn log chi tiết.`);
            }
            return;
        }

        console[type](`[${timestamp} ${type.toUpperCase()}]`, message);
    } catch (e) { process.stderr.write(`FATAL LOG ERROR: ${e.message}\n`); }
};

// ------------------------------------------------------------------
// KHỞI TẠO SÀN (Đã thêm KuCoin Hedge & Fix Binance Log)
// ------------------------------------------------------------------
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
            
            // --- [FIX] BINANCE HEDGE MODE LOGIC ---
            if (id === 'binanceusdm') {
                setTimeout(async () => {
                    try {
                        await exchanges[id].fapiPrivatePostPositionSideDual({ 'dualSidePosition': 'true' });
                        safeLog('info', `[INIT] ✅ Đã chuyển Binance sang HEDGE MODE.`);
                    } catch (e) {
                        // Nếu lỗi báo là "No need to change" (code -4046) thì coi như thành công
                        if (e.message.includes("-4046") || e.message.includes("No need to change")) {
                             safeLog('info', `[INIT] ✅ Binance đã ở chế độ HEDGE MODE (Không cần đổi).`);
                        } else {
                            // Các lỗi khác thì log bình thường
                            safeLog('warn', `[INIT] Check Binance Hedge Mode: ${e.message}`);
                        }
                    }
                }, 2000);
            }

            // --- [NEW] KUCOIN HEDGE MODE LOGIC ---
            if (id === 'kucoinfutures') {
                setTimeout(async () => {
                    try {
                        // Gọi API riêng của KuCoin để bật Dual Side (Hedge Mode)
                        // true = Hedge Mode, false = One-way Mode
                        await exchanges[id].privatePostPositionSideDual({ 'dualSidePosition': 'true' });
                        safeLog('info', `[INIT] ✅ Đã chuyển KuCoin Futures sang HEDGE MODE.`);
                    } catch (e) {
                        // KuCoin không trả về mã lỗi rõ ràng như Binance, nhưng nếu bật rồi nó có thể báo lỗi
                        // Ta log info nhẹ nhàng
                        if(e.message.includes('already') || e.message.includes('No need')) {
                            safeLog('info', `[INIT] ✅ KuCoin đã ở chế độ HEDGE MODE.`);
                        } else {
                            safeLog('warn', `[INIT] KuCoin Hedge Mode: ${e.message}`);
                        }
                    }
                }, 2500);
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
        transfererId = 'kucoin'; 
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

async function returnFundsToHub() {
    safeLog('info', "[CLEANUP] Dọn dẹp trạng thái. Không chuyển tiền.");
    capitalManagementState = 'IDLE';
    selectedOpportunityForNextTrade = null;
    failedCoinsInSession.clear(); 
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
        
        if (BLACKLISTED_COINS.includes(op.coin)) return false;

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
        
        if (op.fundingDiff !== undefined) {
        } 
        else if (op.fundingDifference !== undefined) {
            op.fundingDiff = op.fundingDifference;
        }
        else if (op.shortFundingRate !== undefined && op.longFundingRate !== undefined) {
            op.fundingDiff = Math.abs(op.shortFundingRate - op.longFundingRate);
        } 
        else {
            op.fundingDiff = 0;
        }

        return op;
    });
    
    allCurrentOpportunities = opportunities.sort((a, b) => b.estimatedPnl - a.estimatedPnl);
    bestPotentialOpportunityForDisplay = allCurrentOpportunities.length > 0 ? allCurrentOpportunities[0] : null;
}

// ------------------------------------------------------------------
// CHECK SYMBOL
// ------------------------------------------------------------------
async function getExchangeSpecificSymbol(exchange, rawCoinSymbol) {
    try {
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) await exchange.loadMarkets(true);
    } catch (e) { return null; }
    
    const base = String(rawCoinSymbol).toUpperCase();

    // Binance Check
    if (exchange.id === 'binanceusdm') {
        const simpleCheck = Object.keys(exchange.markets).some(k => k.replace('/','').replace(':USDT','') === base.replace('USDT',''));
        if (!simpleCheck) return null;
    }

    const cleanBase = base.replace(/USDT$/, '');
    const attempts = [`${cleanBase}/USDT:USDT`, `${cleanBase}USDT`, `${cleanBase}-USDT-SWAP`, `${cleanBase}USDTM`, `${cleanBase}/USDT`];
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

// ------------------------------------------------------------------
// PNL CALCULATION
// ------------------------------------------------------------------
async function getPreciseTradeResult(exchange, symbol, openOrderId, closeOrderId, startTime, endTime, side) {
    let totalPnl = 0;
    let totalFee = 0;
    let funding = 0;

    try {
        const openTrades = await exchange.fetchMyTrades(symbol, undefined, undefined, { 'orderId': openOrderId });
        for (const t of openTrades) {
            if (t.fee) totalFee += t.fee.cost;
        }

        const closeTrades = await exchange.fetchMyTrades(symbol, undefined, undefined, { 'orderId': closeOrderId });
        let realized = 0;
        for (const t of closeTrades) {
            if (t.fee) totalFee += t.fee.cost;
            if (t.info && t.info.realizedPnl) {
                realized += parseFloat(t.info.realizedPnl);
            }
        }
        
        if (realized === 0 && closeTrades.length > 0) {
            const closePrice = closeTrades[0].price;
            const openPrice = openTrades.length > 0 ? openTrades[0].price : 0;
            const amount = closeTrades[0].amount;
            if (openPrice > 0) {
                const direction = side === 'sell' ? -1 : 1; 
                realized = (closePrice - openPrice) * amount * direction; 
                if (side === 'sell') realized = (openPrice - closePrice) * amount; 
            }
        }
        totalPnl += realized;

        if (exchange.id === 'binanceusdm') {
            try {
                // Quét Income theo thời gian để bắt được Funding Fee
                const income = await exchange.fapiPrivateGetIncome({
                    'symbol': symbol.replace('/', ''),
                    'incomeType': 'FUNDING_FEE',
                    'startTime': startTime,
                    'endTime': endTime + 60000 
                });
                for (const inc of income) {
                    funding += parseFloat(inc.income); 
                }
            } catch (e) {}
        }

    } catch (e) {
        safeLog('warn', `[PNL-CALC] Lỗi tính chi tiết cho ${exchange.id}: ${e.message}`);
    }

    return { pnl: totalPnl, fee: totalFee, funding: funding, net: totalPnl + funding - totalFee };
}

// -------------------------------------------------------------------
// CHỌN COIN
// -------------------------------------------------------------------
async function runSelectionSequence(candidates) {
    if (!candidates || candidates.length === 0) return;

    for (const op of candidates) {
        const isAlreadyActive = activeTrades.some(trade => trade.coin === op.coin);
        if (isAlreadyActive) continue; 

        const shortEx = exchanges[op.details.shortExchange];
        const longEx = exchanges[op.details.longExchange];
        
        const shortSym = await getExchangeSpecificSymbol(shortEx, op.coin);
        const longSym = await getExchangeSpecificSymbol(longEx, op.coin);

        if (shortSym && longSym) {
            const shortBal = balances[op.details.shortExchange]?.available || 0;
            const longBal = balances[op.details.longExchange]?.available || 0;

            if (shortBal > 0 && longBal > 0) {
                selectedOpportunityForNextTrade = op;
                capitalManagementState = 'FUNDS_READY';
                safeLog('info', `[SELECTION] 🎯 ĐÃ CHỐT KÈO: ${op.coin}. Short: ${shortBal.toFixed(2)}$, Long: ${longBal.toFixed(2)}$. Chờ 59:50.`);
                return; 
            }
        }
    }
    safeLog('log', `[SCAN] ⏳ Đã quét ${candidates.length} coin nhưng chưa chọn được (Đang chờ 25s sau quét lại)...`);
}

async function executeTrades(opportunity) {
    const { coin, commonLeverage: desiredLeverage } = opportunity;
    const { shortExchange, longExchange } = opportunity.details;
    
    safeLog('info', `[EXECUTE] 🚀 Bắt đầu vào lệnh cho ${coin}...`);

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
        
        let collateral = 0;
        if (currentTradeConfig.mode === 'fixed') {
            collateral = currentTradeConfig.value;
            if (collateral > minBalance) {
                safeLog('warn', `[EXECUTE] Vốn cố định ${collateral} > Số dư ${minBalance}. Dùng max số dư.`);
                collateral = minBalance;
            }
        } else {
            collateral = minBalance * (currentTradeConfig.value / 100);
        }

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
        
        const trade = {
            id: Date.now(),
            coin,
            shortExchange,
            longExchange,
            shortSymbol,
            longSymbol,
            shortOrderId: shortOrder.id,
            longOrderId: longOrder.id,
            entryTime: Date.now(),
            shortEntryPrice,
            longEntryPrice,
            shortAmount: shortOrderDetails.amount,
            longAmount: longOrderDetails.amount,
            collateralUsed: collateral,
            leverage: leverageToUse,
            status: 'OPEN',
            estimatedPnlFromOpportunity: opportunity.estimatedPnl,
            isManual: false 
        };

        activeTrades.push(trade);
        
        capitalManagementState = 'IDLE';
        selectedOpportunityForNextTrade = null;

        if (!shortEntryPrice || !longEntryPrice) {
            trade.status = 'MANUAL_CHECK_NO_SL';
            safeLog('warn', `[EXECUTE] Không lấy được giá khớp lệnh. Check Manual.`);
            return true;
        }

        try {
            const [shortTpSlIds, longTpSlIds] = await Promise.all([
                placeTpSlOrders(shortEx, shortSymbol, 'sell', shortOrderDetails.amount, shortEntryPrice, collateral, shortOrderDetails.notional),
                placeTpSlOrders(longEx, longSymbol, 'buy', longOrderDetails.amount, longEntryPrice, collateral, longOrderDetails.notional)
            ]);
            
            trade.shortTpId = shortTpSlIds.tpOrderId;
            trade.shortSlId = shortTpSlIds.slOrderId;
            trade.longTpId = longTpSlIds.tpOrderId;
            trade.longSlId = longTpSlIds.slOrderId;

        } catch (e) {
            safeLog('error', `[EXECUTE] Lỗi TP/SL. Trade vẫn được lưu vào danh sách nhưng cần check tay.`, e);
        }

        safeLog('info', `[EXECUTE] ✅ Vào lệnh thành công! Đã thêm vào danh sách theo dõi (Active Trades: ${activeTrades.length}).`);
        return true;

    } catch (e) {
        safeLog('error', `[EXECUTE] Lỗi không xác định: ${e.message}`);
        return false;
    }
}

// -------------------------------------------------------------------
// MONITOR
// -------------------------------------------------------------------
async function monitorActiveTrades() {
    if (activeTrades.length === 0) return;

    for (let i = activeTrades.length - 1; i >= 0; i--) {
        const trade = activeTrades[i];
        const shortEx = exchanges[trade.shortExchange];
        const longEx = exchanges[trade.longExchange];

        if (typeof trade.isShortFinished === 'undefined') trade.isShortFinished = false;
        if (typeof trade.isLongFinished === 'undefined') trade.isLongFinished = false;

        try {
            // CHECK SHORT
            if (!trade.isShortFinished) {
                try {
                    const slOrder = await shortEx.fetchOrder(trade.shortSlId, trade.shortSymbol);
                    const tpOrder = await shortEx.fetchOrder(trade.shortTpId, trade.shortSymbol);
                    
                    if ((slOrder && (slOrder.status === 'closed' || slOrder.status === 'filled')) || 
                        (tpOrder && (tpOrder.status === 'closed' || tpOrder.status === 'filled'))) {
                        
                        trade.isShortFinished = true;
                        trade.shortFinishedTime = Date.now();
                        safeLog('info', `[MONITOR] 📉 Chân SHORT (${trade.shortExchange}) đã đóng! Chờ chân Long...`);
                        try { await shortEx.cancelAllOrders(trade.shortSymbol); } catch {}
                    }
                } catch (e) { }
            }

            // CHECK LONG
            if (!trade.isLongFinished) {
                try {
                    const slOrder = await longEx.fetchOrder(trade.longSlId, trade.longSymbol);
                    const tpOrder = await longEx.fetchOrder(trade.longTpId, trade.longSymbol);

                    if ((slOrder && (slOrder.status === 'closed' || slOrder.status === 'filled')) || 
                        (tpOrder && (tpOrder.status === 'closed' || tpOrder.status === 'filled'))) {
                        
                        trade.isLongFinished = true;
                        trade.longFinishedTime = Date.now();
                        safeLog('info', `[MONITOR] 📈 Chân LONG (${trade.longExchange}) đã đóng! Chờ chân Short...`);
                        try { await longEx.cancelAllOrders(trade.longSymbol); } catch {}
                    }
                } catch (e) { }
            }

            // CHECK CẢ 2
            if (trade.isShortFinished && trade.isLongFinished && trade.status !== 'WAITING_FINAL_CALC') {
                safeLog('info', `[MONITOR] ✅ CẢ 2 CHÂN ĐỀU ĐÃ ĐÓNG. Chờ 30s để sàn cập nhật lịch sử PNL...`);
                trade.status = 'WAITING_FINAL_CALC';
                trade.allClosedTime = Date.now(); 
            }

            // TÍNH PNL
            if (trade.status === 'WAITING_FINAL_CALC') {
                if (Date.now() - trade.allClosedTime > 30000) {
                    
                    const shortEndTime = trade.shortFinishedTime || Date.now();
                    const longEndTime = trade.longFinishedTime || Date.now();

                    const [shortRes, longRes] = await Promise.all([
                        getPreciseTradeResult(shortEx, trade.shortSymbol, trade.shortOrderId, trade.shortSlId, trade.entryTime, shortEndTime + 5000, 'sell'),
                        getPreciseTradeResult(longEx, trade.longSymbol, trade.longOrderId, trade.longSlId, trade.entryTime, longEndTime + 5000, 'buy')
                    ]);

                    const totalNetPnl = shortRes.net + longRes.net;
                    trade.actualPnl = totalNetPnl;
                    trade.status = 'CLOSED';
                    
                    if (!trade.isManual) {
                        tradeHistory.unshift(trade);
                        if (tradeHistory.length > 50) tradeHistory.pop();
                    }

                    activeTrades.splice(i, 1); 
                    safeLog('info', `[DONE] 🎉 TỔNG KẾT LỆNH ${trade.coin}: Net PNL = ${totalNetPnl.toFixed(4)} USDT. (Short: ${shortRes.net.toFixed(4)}, Long: ${longRes.net.toFixed(4)})`);
                }
            }
        } catch (e) {
            // Lỗi loop, bỏ qua
        }
    }
}

// -------------------------------------------------------------------
// MANUAL CLOSE
// -------------------------------------------------------------------
async function closeTradeNow() {
    if (activeTrades.length === 0) {
        safeLog('warn', '[CLEANUP] Không có lệnh nào đang mở để đóng.');
        return false;
    }

    safeLog('info', `[CLEANUP] 🛑 Đang đóng khẩn cấp ${activeTrades.length} lệnh...`);

    for (const trade of activeTrades) {
        const shortEx = exchanges[trade.shortExchange];
        const longEx = exchanges[trade.longExchange];
        
        try { await shortEx.cancelAllOrders(trade.shortSymbol); } catch {}
        try { await longEx.cancelAllOrders(trade.longSymbol); } catch {}

        const closeShortParams = (shortEx.id === 'binanceusdm') ? { 'positionSide': 'SHORT' } : {'reduceOnly': true, ...(shortEx.id === 'kucoinfutures' && {'marginMode': 'cross'})};
        const closeLongParams = (longEx.id === 'binanceusdm') ? { 'positionSide': 'LONG' } : {'reduceOnly': true, ...(longEx.id === 'kucoinfutures' && {'marginMode': 'cross'})};

        if (!trade.isShortFinished) {
            try {
                const closeShort = await shortEx.createMarketBuyOrder(trade.shortSymbol, trade.shortAmount, closeShortParams);
                trade.closeShortOrderId = closeShort.id;
                trade.isShortFinished = true;
                safeLog('info', `[CLEANUP] ✅ Đã đóng chân Short ${trade.coin}.`);
            } catch (e) {
                if (e.message.includes('No open positions') || e.message.includes('300009') || e.message.includes('-2011')) {
                    trade.isShortFinished = true;
                    safeLog('warn', `[CLEANUP] ⚠️ Chân Short ${trade.coin} đã đóng từ trước. Bỏ qua.`);
                } else {
                    safeLog('error', `[CLEANUP] Lỗi đóng Short ${trade.coin}: ${e.message}`);
                }
            }
        }

        if (!trade.isLongFinished) {
            try {
                const closeLong = await longEx.createMarketSellOrder(trade.longSymbol, trade.longAmount, closeLongParams);
                trade.closeLongOrderId = closeLong.id;
                trade.isLongFinished = true;
                safeLog('info', `[CLEANUP] ✅ Đã đóng chân Long ${trade.coin}.`);
            } catch (e) {
                if (e.message.includes('No open positions') || e.message.includes('300009') || e.message.includes('-2011')) {
                    trade.isLongFinished = true;
                    safeLog('warn', `[CLEANUP] ⚠️ Chân Long ${trade.coin} đã đóng từ trước. Bỏ qua.`);
                } else {
                    safeLog('error', `[CLEANUP] Lỗi đóng Long ${trade.coin}: ${e.message}`);
                }
            }
        }

        trade.status = 'WAITING_FINAL_CALC';
        trade.allClosedTime = Date.now();
    }
    return true;
}

// -------------------------------------------------------------------
// LOOP: QUÉT 25s/LẦN
// -------------------------------------------------------------------
async function mainBotLoop() {
    if (botState !== 'RUNNING') return;

    try {
        await monitorActiveTrades();
        
        const serverData = await fetchDataFromServer();
        await processServerData(serverData);

        const nowTime = Date.now();
        const now = new Date();
        const currentMinute = now.getUTCMinutes();
        const currentSecond = now.getUTCSeconds();
        
        if (currentMinute !== new Date(now.getTime() - 1000).getUTCMinutes()) {
            hasLoggedNotFoundThisHour = false;
        }
        if (currentMinute === 49) failedCoinsInSession.clear();

        // 1. QUÉT COIN (50-59, 25s/lần)
        if (capitalManagementState === 'IDLE' && currentMinute >= 50 && currentMinute <= 59) {
            
            const isTooLateToSelect = (currentMinute === 59 && currentSecond >= 50);

            // [FIX] Sửa 30000 -> 25000 (25 giây)
            if (!isTooLateToSelect && (nowTime - lastSelectionScanTime >= 25000)) {
                
                const fundingCandidates = allCurrentOpportunities.filter(op => {
                    if (BLACKLISTED_COINS.includes(op.coin)) return false;
                    const msToFunding = op.nextFundingTime - nowTime;
                    const minutesToFunding = msToFunding / 60000;
                    return minutesToFunding > 0 && minutesToFunding <= MIN_MINUTES_FOR_EXECUTION;
                });

                if (fundingCandidates.length > 0) {
                     lastSelectionScanTime = nowTime; 
                     await runSelectionSequence(fundingCandidates); 
                } else {
                    lastSelectionScanTime = nowTime;
                }
            }
        }
        
        // 2. VÀO LỆNH (59:50)
        else if (capitalManagementState === 'FUNDS_READY') {
            if (currentMinute === 59 && currentSecond >= 50) {
                if (selectedOpportunityForNextTrade) {
                    safeLog('log', `[TIMER] ⏰ 59:50 -> EXECUTE lệnh thật cho ${selectedOpportunityForNextTrade.coin}.`);
                    const success = await executeTrades(selectedOpportunityForNextTrade);
                    if (!success) {
                        safeLog('error', "[TIMER] Vào lệnh thất bại. Reset.");
                        capitalManagementState = 'IDLE';
                        selectedOpportunityForNextTrade = null;
                    }
                }
            } else if (currentSecond === 0) {
                safeLog('info', `[WAITING] ✅ Đã chọn ${selectedOpportunityForNextTrade?.coin}. Đang chờ đến 59:50...`);
            }
        }

        else if (capitalManagementState !== 'IDLE' && capitalManagementState !== 'FUNDS_READY' && currentMinute > 5 && currentMinute < 50) {
            safeLog('warn', `[RESET] Trạng thái ${capitalManagementState} bị kẹt, đang reset về IDLE.`);
            await returnFundsToHub();
        }

    } catch (e) {
        safeLog('error', '[LOOP] Lỗi nghiêm trọng trong vòng lặp chính:', e);
    }

    if (botState === 'RUNNING') {
        botLoopIntervalId = setTimeout(mainBotLoop, DATA_FETCH_INTERVAL_SECONDS * 1000);
    }
}

function startBot() {
    if (botState === 'RUNNING') return false;
    botState = 'RUNNING';
    capitalManagementState = 'IDLE';
    selectedOpportunityForNextTrade = null;
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
                bestPotentialOpportunityForDisplay, currentTradeDetails: activeTrades[0] || null, 
                activeTrades, 
                exchangeHealth, transferStatus, transferExchanges, internalTransferExchanges,
                activeExchangeIds: internalTransferExchanges
            }));
        } else if (url === '/bot-api/start' && method === 'POST') {
             try {
                 const payload = JSON.parse(body);
                 if (payload.tradeConfig) {
                     currentTradeConfig = payload.tradeConfig;
                 } else if (payload.percentageToUse) {
                     currentTradeConfig = { mode: 'percent', value: parseFloat(payload.percentageToUse) };
                 }
             } catch { 
                 currentTradeConfig = { mode: 'percent', value: 50 };
             }
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: startBot(), message: 'Đã gửi yêu cầu khởi động bot.' }));
        } else if (url === '/bot-api/stop' && method === 'POST') {
             res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: stopBot(), message: 'Đã gửi yêu cầu dừng bot.' }));
        } else if (url === '/bot-api/custom-test-trade' && method === 'POST') {
            const data = JSON.parse(body);
            const testOpportunity = {
                coin: bestPotentialOpportunityForDisplay?.coin,
                commonLeverage: parseInt(data.leverage, 10) || 20,
                details: { shortExchange: data.shortExchange, longExchange: data.longExchange }
            };
            try {
                const oldConfig = currentTradeConfig;
                currentTradeConfig = { mode: 'percent', value: parseFloat(data.percentage) }; 
                const tradeSuccess = await executeTrades(testOpportunity);
                if (tradeSuccess && activeTrades.length > 0) {
                    activeTrades[activeTrades.length - 1].isManual = true;
                }
                currentTradeConfig = oldConfig;
                res.writeHead(tradeSuccess ? 200 : 500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: tradeSuccess, message: tradeSuccess ? 'Lệnh Test đã được gửi.' : 'Lỗi khi gửi lệnh Test (Xem log).' }));
            } catch (err) {
                safeLog('error', '[MANUAL] Lỗi:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: `Lỗi: ${err.message}` }));
            }

        }
        else if (url === '/bot-api/close-trade-now' && method === 'POST') {
            const success = await closeTradeNow();
            res.writeHead(success ? 200 : 400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success, message: success ? 'Đã đóng tất cả lệnh.' : 'Không có lệnh nào.' }));
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
                if (from === 'spot') from = 'main';
                if (to === 'spot') to = 'main';
                if (from === 'main' && to === 'future') transferer = exchanges['kucoin']; 
                else if (from === 'future' && to === 'main') transferer = exchanges['kucoinfutures']; 
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
