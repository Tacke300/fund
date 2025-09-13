const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

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

const ALL_POSSIBLE_EXCHANGE_IDS = ['binanceusdm', 'bitget', 'okx', 'kucoin'];
const DISABLED_EXCHANGES = []; // Ví dụ: ['kucoin'] nếu bạn muốn tạm thời tắt KuCoin

const activeExchangeIds = ALL_POSSIBLE_EXCHANGE_IDS.filter(id => !DISABLED_EXCHANGES.includes(id));

const exchanges = {};
activeExchangeIds.forEach(id => {
    try {
        const exchangeClass = ccxt[id];
        const config = { 
            'options': { 'defaultType': 'swap' }, 
            'enableRateLimit': true,
            'verbose': false,
        };

        if (id === 'binanceusdm') { 
            config.apiKey = binanceApiKey; 
            config.secret = binanceApiSecret; 
        }
        else if (id === 'okx') { 
            config.apiKey = okxApiKey; 
            config.secret = okxApiSecret; 
            config.password = okxPassword; 
        }
        else if (id === 'bitget') { 
            config.apiKey = bitgetApiKey; 
            config.secret = bitgetApiSecret; 
            config.password = bitgetApiPassword; 
        }
        else if (id === 'kucoin') { 
            config.apiKey = kucoinApiKey; 
            config.secret = kucoinApiSecret; 
            config.password = kucoinApiPassword; 
            config.options = { 
                ...config.options,
                'defaultType': 'swap', // Đảm bảo KuCoin được cấu hình cho futures/swap
            };
        }

        if (config.apiKey && config.secret && (id !== 'kucoin' || config.password)) { 
            exchanges[id] = new exchangeClass(config);
            safeLog('log', `[INIT] Khởi tạo sàn ${id.toUpperCase()} thành công.`);
        } else {
            safeLog('warn', `[INIT] Bỏ qua ${id.toUpperCase()} do thiếu API Key/Secret/Password (nếu là KuCoin). Vui lòng kiểm tra config.js`);
        }
    } catch (e) {
        safeLog('error', `[INIT] Lỗi khi khởi tạo sàn ${id.toUpperCase()}: ${e}`);
    }
});

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

async function fetchDataFromServer() {
    try {
        const response = await fetch(SERVER_DATA_URL);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return await response.json();
    } catch (error) {
        safeLog('error', `[BOT] Lỗi khi lấy dữ liệu từ server: ${error}`);
        return null;
    }
}

async function updateBalances() {
    safeLog('log', '[BALANCES] Đang cập nhật số dư cho các sàn...');
    await Promise.all(activeExchangeIds.map(async (id) => {
        if (!exchanges[id]) {
            safeLog('debug', `[BALANCES] Sàn ${id.toUpperCase()} không được khởi tạo, bỏ qua cập nhật số dư.`);
            return; 
        }
        if (exchangeHealth[id].isDisabled) {
            safeLog('warn', `[BALANCES] Bỏ qua ${id.toUpperCase()} do bị vô hiệu hóa tạm thời.`);
            return;
        }

        try {
            let usdtAvailable = 0;
            let usdtTotal = 0;
            
            if (id === 'kucoin') {
                safeLog('debug', '[BALANCES] Lấy số dư KuCoin (sử dụng fetchBalance mặc định cho swap/futures)...');
                try {
                    // Thử fetchBalance() mặc định trước, vì nó đã được cấu hình với defaultType: 'swap'
                    const balanceDataDefault = await exchanges[id].fetchBalance();
                    
                    // KuCoin thường trả về số dư futures dưới 'futures' hoặc 'swap' property trong balanceData.info.balances
                    // Hoặc có thể trực tiếp ở level top nếu CCXT đã xử lý
                    const futuresAccountInfo = balanceDataDefault?.info?.balances?.find(
                        b => b.currency === 'USDT' && (b.type === 'futures' || b.type === 'swap' || b.type === 'contract')
                    );

                    if (futuresAccountInfo) {
                        usdtAvailable = parseFloat(futuresAccountInfo.availableBalance || 0);
                        usdtTotal = parseFloat(futuresAccountInfo.totalBalance || 0);
                        safeLog('debug', `[BALANCES] Lấy số dư KuCoin từ fetchBalance().info (type: ${futuresAccountInfo.type}) thành công.`);
                    } else if (balanceDataDefault.free?.USDT !== undefined || balanceDataDefault.total?.USDT !== undefined) {
                        // Fallback nếu fetchBalance() mặc định có trả về USDT ở cấp top-level
                        usdtAvailable = balanceDataDefault.free?.USDT || 0;
                        usdtTotal = balanceDataDefault.total?.USDT || 0;
                        safeLog('debug', `[BALANCES] Lấy số dư KuCoin thành công với fetchBalance() mặc định (top-level USDT).`);
                    } else {
                        safeLog('warn', '[BALANCES] fetchBalance KuCoin mặc định không trả về số dư USDT futures. Thử fetchAccounts()...');
                        throw new Error('No USDT futures balance found with default fetchBalance');
                    }
                } catch (e) {
                    safeLog('warn', `[BALANCES] Lỗi khi lấy số dư KuCoin với fetchBalance(): ${e.message}. Thử fetchAccounts()...`);
                    // Thử fetchAccounts làm phương án dự phòng
                    try {
                        safeLog('debug', '[BALANCES] Thử fetchAccounts() cho KuCoin...');
                        const accounts = await exchanges[id].fetchAccounts();
                        safeLog('debug', `[BALANCES] KuCoin accounts raw: ${JSON.stringify(accounts.map(acc => ({type: acc.type, currency: acc.currency, free: acc.free, total: acc.total})), null, 2)}`);
                        
                        // CHỈ TÌM TÀI KHOẢN FUTURES/CONTRACT/SWAP CÓ USDT
                        let targetAccount = accounts.find(acc => 
                            (acc.type === 'futures' || acc.type === 'contract' || acc.type === 'swap') && 
                            acc.currency === 'USDT'
                        );
                        
                        if (targetAccount) {
                            usdtAvailable = targetAccount.free || 0;
                            usdtTotal = targetAccount.total || 0;
                            safeLog('debug', `[BALANCES] Lấy số dư KuCoin từ fetchAccounts() thành công (type: ${targetAccount.type}).`);
                        } else {
                            safeLog('warn', '[BALANCES] Không tìm thấy tài khoản USDT FUTURES/CONTRACT/SWAP phù hợp trong fetchAccounts() của KuCoin.');
                            throw new Error('Không thể lấy số dư USDT KuCoin từ fetchAccounts().');
                        }
                    } catch (e2) {
                        safeLog('error', `[BALANCES] Thất bại hoàn toàn khi lấy số dư KuCoin: ${e2.message}`);
                        throw e2;
                    }
                }
            } else {
                // Đối với các sàn khác, sử dụng type 'future'
                const balanceData = await exchanges[id].fetchBalance({ 'type': 'future' });
                usdtAvailable = balanceData?.free?.USDT || 0;
                usdtTotal = balanceData?.total?.USDT || 0;
            }
            
            balances[id] = { available: usdtAvailable, total: usdtTotal };
            safeLog('log', `[BALANCES] Số dư ${id.toUpperCase()} cập nhật: USDT Khả dụng = ${usdtAvailable.toFixed(2)}, Tổng = ${usdtTotal.toFixed(2)}`);

            if (exchangeHealth[id].isDisabled) {
                safeLog('info', `[HEALTH] Sàn ${id.toUpperCase()} đã hoạt động trở lại sau khi cập nhật số dư thành công.`);
                exchangeHealth[id].isDisabled = false;
            }
            exchangeHealth[id].consecutiveFails = 0;

        } catch (e) {
            balances[id] = { available: 0, total: 0 };
            exchangeHealth[id].consecutiveFails++;
            safeLog('error', `[BALANCES] Lỗi khi lấy số dư ${id.toUpperCase()} (lần ${exchangeHealth[id].consecutiveFails}): ${e}`);
            
            if (exchangeHealth[id].consecutiveFails >= MAX_CONSECUTIVE_FAILS && !exchangeHealth[id].isDisabled) {
                exchangeHealth[id].isDisabled = true;
                safeLog('warn', `[HEALTH] Sàn ${id.toUpperCase()} đã bị tạm vô hiệu hóa do lỗi liên tục. Vui lòng kiểm tra API Keys/Permissions/IP Whitelist/Trading Password (nếu là KuCoin).`);
            }
        }
    }));
    safeLog('log', '[BALANCES] Hoàn tất cập nhật số dư.');
}

async function getExchangeSpecificSymbol(exchange, rawCoinSymbol) {
    const base = rawCoinSymbol.replace(/USDT$/, '');
    const quote = 'USDT';
    
    if (!exchange.markets || Object.keys(exchange.markets).length === 0) {
        safeLog('debug', `[SYMBOL_RESOLVE] Tải lại markets cho ${exchange.id}...`);
        try {
            await exchange.loadMarkets(true);
            safeLog('debug', `[SYMBOL_RESOLVE] Markets loaded cho ${exchange.id}. Tổng số markets: ${Object.keys(exchange.markets).length}`);
        } catch (e) {
            safeLog('error', `[SYMBOL_RESOLVE] Lỗi khi tải markets cho ${exchange.id}: ${e}`);
            return null;
        }
    }

    const availableSymbols = Object.keys(exchange.markets);
    safeLog('debug', `[SYMBOL_RESOLVE] Tìm kiếm symbol cho ${rawCoinSymbol} trên ${exchange.id} (Base: ${base}, Quote: ${quote}).`);

    // Các định dạng symbol phổ biến cho KuCoin Futures
    const kucoinSpecificAttempts = [
        `${base}USDTM`,        // Ví dụ: BTCUSDTM (KuCoin Futures format)
        `${base}/${quote}:USDT`, // Ví dụ: BTC/USDT:USDT (cũng có thể dùng cho futures)
        `${base}-${quote}-SWAP`, // Ví dụ: BTC-USDT-SWAP
        `${base}${quote}_SWAP`, // Ví dụ: BTCUSDT_SWAP
    ];

    // Các định dạng symbol chung cho các sàn
    const generalAttempts = [
        `${base}/${quote}`,
        `${base}/${quote}:${quote}`,
        rawCoinSymbol,
        `${base}_${quote}`,
        `${base}${quote}`
    ];

    const allAttempts = (exchange.id === 'kucoin' ? kucoinSpecificAttempts : []).concat(generalAttempts);
    
    for (const attempt of allAttempts) {
        if (!attempt) continue;
        try {
            if (availableSymbols.includes(attempt)) {
                const market = exchange.market(attempt);
                // Kiểm tra thêm để đảm bảo đây là thị trường hợp đồng/swap/futures
                if (market && market.active && (market.contract || market.swap || market.future || market.type === 'swap')) {
                    safeLog('log', `[SYMBOL_RESOLVE] Tìm thấy symbol ${market.id} cho ${rawCoinSymbol} trên ${exchange.id} với định dạng: ${attempt}`);
                    return market.id;
                }
            }
        } catch (e) {
            safeLog('debug', `[SYMBOL_RESOLVE_ATTEMPT_FAIL] Sàn ${exchange.id}, Thử '${attempt}' thất bại: ${e.message}`);
        }
    }
    safeLog('error', `[SYMBOL_RESOLVE] KHÔNG tìm thấy symbol hợp lệ cho ${rawCoinSymbol} trên ${exchange.id} sau khi thử tất cả các phương án.`);
    return null;
}

const normalizeExchangeId = (id) => {
    if (!id) return null;
    const lowerId = id.toLowerCase().trim();
    if (lowerId === 'binance' || lowerId === 'binanceusdm') return 'binanceusdm';
    return lowerId;
};

async function processServerData(serverData) {
    if (!serverData || !serverData.arbitrageData) {
        allCurrentOpportunities = [];
        bestPotentialOpportunityForDisplay = null;
        safeLog('warn', '[PROCESS] Dữ liệu từ server trống hoặc không có arbitrageData.');
        return;
    }

    allCurrentOpportunities = serverData.arbitrageData
        .map(op => {
            if (!op || !op.exchanges || typeof op.exchanges !== 'string' || op.estimatedPnl < MIN_PNL_PERCENTAGE) {
                return null;
            }

            const exchangeParts = op.exchanges.split(' / ');
            if (exchangeParts.length !== 2) {
                safeLog('warn', `[PROCESS] Dữ liệu cơ hội không đúng định dạng 'Ex1 / Ex2': ${op.exchanges}`);
                return null; 
            }

            op.details = {
                shortExchange: normalizeExchangeId(exchangeParts[0]),
                longExchange: normalizeExchangeId(exchangeParts[1])
            };

            return op;
        })
        .filter(op => {
            if (!op) return false;
            const { shortExchange, longExchange } = op.details;
            const isShortHealthy = exchanges[shortExchange] && !exchangeHealth[shortExchange]?.isDisabled;
            const isLongHealthy = exchanges[longExchange] && !exchangeHealth[longExchange]?.isDisabled;

            if (!isShortHealthy) safeLog('debug', `[PROCESS] Bỏ qua cơ hội (${op.coin}) do sàn Short ${shortExchange.toUpperCase()} không khỏe hoặc không được khởi tạo.`);
            if (!isLongHealthy) safeLog('debug', `[PROCESS] Bỏ qua cơ hội (${op.coin}) do sàn Long ${longExchange.toUpperCase()} không khỏe hoặc không được khởi tạo.`);

            return isShortHealthy && isLongHealthy;
        })
        .sort((a, b) => {
            if (a.nextFundingTime !== b.nextFundingTime) return a.nextFundingTime - b.nextFundingTime;
            return b.estimatedPnl - a.estimatedPnl;
        });

    bestPotentialOpportunityForDisplay = allCurrentOpportunities.length > 0 ? allCurrentOpportunities[0] : null;
}

async function setLeverage(exchange, symbol, leverage) {
    try {
        await exchange.setLeverage(leverage, symbol);
        safeLog('log', `[BOT_TRADE] Đặt đòn bẩy x${leverage} cho ${symbol} trên ${exchange.id} thành công.`);
        return true;
    } catch (e) {
        safeLog('error', `[BOT_TRADE] Lỗi đặt đòn bẩy x${leverage} cho ${symbol} trên ${exchange.id}: ${e}`);
        return false;
    }
}

async function executeTrades(opportunity, percentageToUse) {
    const { coin, commonLeverage } = opportunity;
    const { shortExchange, longExchange } = opportunity.details;
    const shortEx = exchanges[shortExchange];
    const longEx = exchanges[longExchange];

    safeLog('log', `[BOT_TRADE] Đang chuẩn bị thực hiện giao dịch cho ${coin} (Short: ${shortExchange.toUpperCase()}, Long: ${longExchange.toUpperCase()})...`);

    await updateBalances(); 
    const shortBalanceBefore = balances[shortExchange].available;
    const longBalanceBefore = balances[longExchange].available;
    safeLog('debug', `[BOT_TRADE] Số dư trước giao dịch: ${shortExchange.toUpperCase()}: ${shortBalanceBefore.toFixed(2)} USDT, ${longExchange.toUpperCase()}: ${longBalanceBefore.toFixed(2)} USDT.`);

    const shortOriginalSymbol = await getExchangeSpecificSymbol(shortEx, coin);
    const longOriginalSymbol = await getExchangeSpecificSymbol(longEx, coin);

    if (!shortOriginalSymbol) {
        safeLog('error', `[BOT_TRADE] Không tìm thấy symbol hợp lệ cho ${coin} trên sàn SHORT ${shortEx.id.toUpperCase()}. Hủy bỏ giao dịch.`);
        return false; 
    }
    if (!longOriginalSymbol) {
        safeLog('error', `[BOT_TRADE] Không tìm thấy symbol hợp lệ cho ${coin} trên sàn LONG ${longEx.id.toUpperCase()}. Hủy bỏ giao dịch.`);
        return false; 
    }

    const minBalance = Math.min(shortBalanceBefore, longBalanceBefore);
    const collateral = minBalance * (percentageToUse / 100);
    if (collateral <= 1) { 
        safeLog('error', `[BOT_TRADE] Vốn thế chấp (${collateral.toFixed(2)} USDT) quá nhỏ hoặc không đủ. Hủy bỏ cơ hội này.`);
        return false;
    }
    safeLog('debug', `[BOT_TRADE] Vốn thế chấp sẽ sử dụng: ${collateral.toFixed(2)} USDT với đòn bẩy x${commonLeverage}.`);

    try {
        if (!(await setLeverage(shortEx, shortOriginalSymbol, commonLeverage))) throw new Error(`Không thể đặt đòn bẩy cho sàn SHORT ${shortEx.id.toUpperCase()}.`);
        if (!(await setLeverage(longEx, longOriginalSymbol, commonLeverage))) throw new Error(`Không thể đặt đòn bẩy cho sàn LONG ${longEx.id.toUpperCase()}.`);
        
        const shortPrice = (await shortEx.fetchTicker(shortOriginalSymbol)).last;
        const longPrice = (await longEx.fetchTicker(longOriginalSymbol)).last;
        safeLog('debug', `[BOT_TRADE] Giá hiện tại: ${shortEx.id.toUpperCase()}: ${shortPrice}, ${longEx.id.toUpperCase()}: ${longPrice}`);

        const shortAmount = shortEx.amountToPrecision(shortOriginalSymbol, (collateral * commonLeverage) / shortPrice);
        const longAmount = longEx.amountToPrecision(longOriginalSymbol, (collateral * commonLeverage) / longPrice);
        safeLog('debug', `[BOT_TRADE] Lượng Short: ${shortAmount} ${shortOriginalSymbol}, Lượng Long: ${longAmount} ${longOriginalSymbol}`);

        safeLog('log', `[BOT_TRADE] Đang mở lệnh SHORT (Market Sell) trên ${shortEx.id.toUpperCase()} cho ${shortAmount} ${shortOriginalSymbol}...`);
        const shortOrder = await shortEx.createMarketSellOrder(shortOriginalSymbol, shortAmount);
        safeLog('log', `[BOT_TRADE] Lệnh SHORT thành công. ID: ${shortOrder.id}`);

        safeLog('log', `[BOT_TRADE] Đang mở lệnh LONG (Market Buy) trên ${longEx.id.toUpperCase()} cho ${longAmount} ${longOriginalSymbol}...`);
        const longOrder = await longEx.createMarketBuyOrder(longOriginalSymbol, longAmount);
        safeLog('log', `[BOT_TRADE] Lệnh LONG thành công. ID: ${longOrder.id}`);
        
        currentTradeDetails = { 
            ...opportunity.details, 
            coin, 
            status: 'OPEN', 
            openTime: Date.now(), 
            shortOrderAmount: shortOrder.amount, 
            longOrderAmount: longOrder.amount, 
            commonLeverageUsed: commonLeverage, 
            shortOriginalSymbol, 
            longOriginalSymbol, 
            shortBalanceBefore, 
            longBalanceBefore,
            shortOrderId: shortOrder.id,
            longOrderId: longOrder.id
        };
        safeLog('log', `[BOT_TRADE] Mở cả hai lệnh thành công cho ${coin}. Chi tiết: ${JSON.stringify(currentTradeDetails, null, 2)}`);
        return true;
    } catch (e) {
        safeLog('error', `[BOT_TRADE] Mở lệnh cho ${coin} thất bại: ${e.message}. Stack: ${e.stack}`);
        return false;
    }
}

async function closeTrades() {
    if (!currentTradeDetails || currentTradeDetails.status !== 'OPEN') {
        safeLog('warn', '[BOT_PNL] Không có giao dịch nào đang mở để đóng.');
        return;
    }
    safeLog('log', `[BOT_PNL] Đang đóng giao dịch cho ${currentTradeDetails.coin}...`);
    const { shortExchange, longExchange, shortOriginalSymbol, longOriginalSymbol, shortOrderAmount, longOrderAmount } = currentTradeDetails;
    try {
        safeLog('log', `[BOT_PNL] Đang gửi lệnh ĐÓNG SHORT (Market Buy) trên ${shortExchange.toUpperCase()} cho ${shortOrderAmount} ${shortOriginalSymbol}...`);
        await exchanges[shortExchange].createMarketBuyOrder(shortOriginalSymbol, shortOrderAmount);
        
        safeLog('log', `[BOT_PNL] Đang gửi lệnh ĐÓNG LONG (Market Sell) trên ${longExchange.toUpperCase()} cho ${longOrderAmount} ${longOriginalSymbol}...`);
        await exchanges[longExchange].createMarketSellOrder(longOriginalSymbol, longOrderAmount);
        
        currentTradeDetails.status = 'PENDING_PNL_CALC';
        currentTradeDetails.closeTime = Date.now();
        tradeAwaitingPnl = currentTradeDetails;
        safeLog('log', `[BOT_PNL] Đã gửi lệnh đóng cho ${currentTradeDetails.coin}. Chờ tính PNL...`);
        currentTradeDetails = null;
    } catch (e) { 
        safeLog('error', `[BOT_PNL] Lỗi khi đóng vị thế cho ${currentTradeDetails.coin}: ${e.message}. Stack: ${e.stack}`); 
    }
}

async function calculatePnlAfterDelay(closedTrade) {
    safeLog('log', `[BOT_PNL] Đang tính PNL cho giao dịch đã đóng (${closedTrade.coin})...`);
    await updateBalances();
    const shortBalanceAfter = balances[closedTrade.shortExchange].available;
    const longBalanceAfter = balances[closedTrade.longExchange].available;

    const pnlShort = shortBalanceAfter - closedTrade.shortBalanceBefore;
    const pnlLong = longBalanceAfter - closedTrade.longBalanceBefore;
    const totalPnl = pnlShort + pnlLong;

    safeLog('log', `[BOT_PNL] KẾT QUẢ PNL PHIÊN (${closedTrade.coin}):`);
    safeLog('log', `  Sàn SHORT ${closedTrade.shortExchange.toUpperCase()}: PNL = ${pnlShort.toFixed(4)} USDT (Trước: ${closedTrade.shortBalanceBefore.toFixed(2)}, Sau: ${shortBalanceAfter.toFixed(2)})`);
    safeLog('log', `  Sàn LONG ${closedTrade.longExchange.toUpperCase()}: PNL = ${pnlLong.toFixed(4)} USDT (Trước: ${closedTrade.longBalanceBefore.toFixed(2)}, Sau: ${longBalanceAfter.toFixed(2)})`);
    safeLog('log', `  TỔNG PNL: ${totalPnl.toFixed(4)} USDT`);

    tradeHistory.unshift({ ...closedTrade, status: 'CLOSED', actualPnl: totalPnl });
    if (tradeHistory.length > 50) tradeHistory.pop();
    tradeAwaitingPnl = null;
}

async function mainBotLoop() {
    if (botState !== 'RUNNING') return;
    
    if (tradeAwaitingPnl && (Date.now() - tradeAwaitingPnl.closeTime >= 60000)) { // Chờ 60 giây trước khi tính PNL
        safeLog('log', `[BOT_LOOP] Đã đủ thời gian để tính PNL cho giao dịch ${tradeAwaitingPnl.coin}.`);
        await calculatePnlAfterDelay(tradeAwaitingPnl);
    }
    
    const serverData = await fetchDataFromServer();
    await processServerData(serverData); 

    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentSecond = now.getUTCSeconds();
    
    // Tắt debug log để giảm spam nếu không cần thiết
    // safeLog('debug', `[BOT_LOOP] Thời gian hiện tại: ${currentMinute} phút, ${currentSecond} giây UTC.`);

    // Logic để mở giao dịch mới (ví dụ: 30-35 giây trước phút 00 của giờ tiếp theo)
    if (currentMinute === 59 && currentSecond >= 30 && currentSecond < 35 && !currentTradeDetails) {
        safeLog('log', '[BOT_LOOP] Đang tìm kiếm cơ hội để mở giao dịch mới...');
        for (const opportunity of allCurrentOpportunities) {
            const minutesToFunding = (opportunity.nextFundingTime - Date.now()) / 60000;
            safeLog('debug', `[BOT_LOOP] Cơ hội: ${opportunity.coin}, PNL: ${opportunity.estimatedPnl.toFixed(2)}%, Còn ${minutesToFunding.toFixed(2)} phút đến Funding.`);
            
            if (minutesToFunding < MIN_MINUTES_FOR_EXECUTION) {
                safeLog('log', `[BOT_LOOP] Phát hiện cơ hội đủ điều kiện để mở: ${opportunity.coin}.`);
                const tradeSuccess = await executeTrades(opportunity, currentPercentageToUse);
                if (tradeSuccess) {
                    safeLog('log', `[BOT_LOOP] Đã mở giao dịch thành công cho ${opportunity.coin}.`);
                    break; // Mở một giao dịch mỗi chu kỳ
                } else {
                    safeLog('warn', `[BOT_LOOP] Mở giao dịch cho ${opportunity.coin} thất bại. Tiếp tục tìm kiếm cơ hội khác.`);
                }
            } else {
                safeLog('debug', `[BOT_LOOP] Cơ hội ${opportunity.coin} còn quá nhiều thời gian đến funding (${minutesToFunding.toFixed(2)} phút). Bỏ qua.`);
            }
        }
    }
    
    // Logic để đóng giao dịch (ví dụ: 5-10 giây sau phút 00 của giờ tiếp theo)
    if (currentMinute === 0 && currentSecond >= 5 && currentSecond < 10 && currentTradeDetails?.status === 'OPEN') {
        safeLog('log', `[BOT_LOOP] Phát hiện thời điểm đóng lệnh cho giao dịch ${currentTradeDetails.coin}.`);
        await closeTrades();
    }

    botLoopIntervalId = setTimeout(mainBotLoop, DATA_FETCH_INTERVAL_SECONDS * 1000);
}

function startBot() {
    if (botState === 'RUNNING') {
        safeLog('warn', '[BOT] Bot đã đang chạy rồi.');
        return false;
    }
    botState = 'RUNNING';
    safeLog('log', '[BOT] Khởi động Bot...');
    updateBalances().then(() => {
        safeLog('log', '[BOT] Đã cập nhật số dư ban đầu. Bắt đầu vòng lặp chính của bot.');
        mainBotLoop();
    }).catch(e => {
        safeLog('error', `[BOT] Lỗi khi cập nhật số dư ban đầu, không thể khởi động bot: ${e}`);
        botState = 'STOPPED';
    });
    return true;
}

function stopBot() {
    if (botState !== 'RUNNING') {
        safeLog('warn', '[BOT] Bot không chạy, không cần dừng.');
        return false;
    }
    botState = 'STOPPED';
    if (botLoopIntervalId) {
        clearTimeout(botLoopIntervalId);
        botLoopIntervalId = null;
    }
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
            try { currentPercentageToUse = parseFloat(JSON.parse(body).percentageToUse) || 50; } catch (e) { safeLog('error', '[HTTP_API] Lỗi parse body start request:', e); currentPercentageToUse = 50; }
            const started = startBot();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: started, message: started ? 'Bot đã khởi động.' : 'Bot đã chạy hoặc không thể khởi động.' }));
        });
    } else if (req.url === '/bot-api/stop' && req.method === 'POST') {
        const stopped = stopBot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: stopped, message: stopped ? 'Bot đã dừng.' : 'Bot không chạy.' }));
    } else if (req.url === '/bot-api/stop-test-trade' && req.method === 'POST') {
        req.on('end', async () => {
            if (currentTradeDetails && currentTradeDetails.status === 'OPEN') {
                safeLog('log', '[HTTP_API] Yêu cầu đóng lệnh thủ công...');
                await closeTrades();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Đã gửi lệnh đóng giao dịch hiện tại.' }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Không có giao dịch nào đang mở để đóng.' }));
            }
        });
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

botServer.listen(BOT_PORT, () => {
    safeLog('log', `Máy chủ UI của Bot đang chạy tại http://localhost:${BOT_PORT}`);
});
