const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const { URLSearchParams } = require('url');

// Import các API Key và Secret từ file config.js (ĐÃ CẬP NHẬT ĐƯỜNG DẪN CHÍNH XÁC)
// Đường dẫn: từ funding/bot/bot.js đi lên 2 cấp (funding/) rồi đến config.js
const {
    binanceApiKey, binanceApiSecret,
    bingxApiKey, bingxApiSecret,
    okxApiKey, okxApiSecret, okxPassword,
    bitgetApiKey, bitgetApiSecret, bitgetApiPassword
} = require('../config.js'); // <-- ĐƯỜNG DẪN CHÍNH XÁC CHO CẤU TRÚC CỦA BẠN

// Import địa chỉ ví nạp tiền từ file balance.js (ĐÃ CẬP NHẬT ĐƯỜNG DẪN CHÍNH XÁC)
// Đường dẫn: từ funding/bot/bot.js đến balance.js trong cùng thư mục
const { usdtBep20DepositAddresses } = require('./balance.js'); // <-- ĐƯỜNG DẪN CHÍNH XÁC CHO CẤU TRÚC CỦA BẠN

const BOT_PORT = 5006; // Cổng cho Bot UI (khác với cổng của Server chính)
const SERVER_DATA_URL = 'http://localhost:5005/api/data'; // Địa chỉ Server chính

// ----- CẤU HÌNH BOT -----
const MIN_PNL_PERCENTAGE = 7; // %PnL tối thiểu để bot xem xét
const MAX_MINUTES_UNTIL_FUNDING = 30; // Trong vòng 30 phút tới sẽ tới giờ funding
const FUND_TRANSFER_MIN_AMOUNT = 10; // Số tiền tối thiểu cho mỗi lần chuyển tiền qua BEP20
const BEP20_NETWORK_ID = 'BEP20'; // ID mạng cho BEP20 (Binance Smart Chain)

const DATA_FETCH_INTERVAL_MINUTES = 1; // Mỗi phút cập nhật dữ liệu từ server
const HOURLY_FETCH_TIME_MINUTE = 45; // Mỗi giờ vào phút thứ 45, bot lấy dữ liệu chính

// ----- BIẾN TOÀN CỤC CHO BOT -----
let botState = 'STOPPED'; // 'STOPPED', 'RUNNING', 'FETCHING_DATA', 'PROCESSING_DATA', 'TRANSFERRING_FUNDS', 'EXECUTING_TRADES', 'CLOSING_TRADES'
let botLoopIntervalId = null;

let balances = {
    binanceusdm: { total: 0, available: 0, originalSymbol: {} },
    bingx: { total: 0, available: 0, originalSymbol: {} },
    okx: { total: 0, available: 0, originalSymbol: {} },
    bitget: { total: 0, available: 0, originalSymbol: {} },
    totalOverall: 0
};
let initialTotalBalance = 0;
let cumulativePnl = 0; // PnL từ lúc bot chạy
let tradeHistory = []; // Lịch sử các chu kỳ giao dịch (tối đa 50)
let currentSelectedOpportunity = null; // Cơ hội arbitrage đang được chọn
let currentTradeDetails = null; // Khắc phục ReferenceError

// CCXT Exchange instances
const exchanges = {};
['binanceusdm', 'bingx', 'okx', 'bitget'].forEach(id => {
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
    else { console.warn(`[AUTH] ⚠️ Thiếu API Key/Secret hoặc cấu hình cho ${id.toUpperCase()}.`); }

    exchanges[id] = new exchangeClass(config);
});

// Hàm hỗ trợ
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Hàm để lấy dữ liệu từ server chính
async function fetchDataFromServer() {
    console.log(`[BOT] 🔄 Đang lấy dữ liệu từ server chính: ${SERVER_DATA_URL}`);
    try {
        const response = await fetch(SERVER_DATA_URL);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        console.log(`[BOT] ✅ Đã nhận dữ liệu từ server. Tổng số cơ hội arbitrage: ${data.arbitrageData.length}`);
        return data;
    } catch (error) {
        console.error('[BOT] ❌ Lỗi khi lấy dữ liệu từ server:', error.message);
        return null;
    }
}

// Hàm cập nhật số dư từ các sàn
async function updateBalances() {
    console('[BOT] 🔄 Cập nhật số dư từ các sàn...');
    let totalOverall = 0;
    for (const id of Object.keys(exchanges)) {
        try {
            const exchange = exchanges[id];
            await exchange.loadMarkets(true);
            
            const accountBalance = await exchange.fetchBalance({ 'type': 'future' }); 
            const usdtBalance = accountBalance.free?.USDT || 0; 
            const usdtTotalBalance = accountBalance.total?.USDT || 0;

            balances[id].total = usdtTotalBalance;
            balances[id].available = usdtBalance;
            
            balances[id].originalSymbol = {}; 

            totalOverall += usdtBalance; 

            console.log(`[BOT] ✅ ${id.toUpperCase()} Balance: Total ${usdtTotalBalance.toFixed(2)} USDT, Available ${usdtBalance.toFixed(2)} USDT.`);
        } catch (e) {
            console.error(`[BOT] ❌ Lỗi khi lấy số dư ${id.toUpperCase()}: ${e.message}`);
        }
    }
    balances.totalOverall = totalOverall;
    console.log(`[BOT] Tổng số dư khả dụng trên tất cả các sàn: ${totalOverall.toFixed(2)} USDT.`);
    if (initialTotalBalance === 0) { 
        initialTotalBalance = totalOverall;
    }
}


// Hàm chính để xử lý dữ liệu từ server và tìm cơ hội
async function processServerData(serverData) {
    if (!serverData || !serverData.arbitrageData) {
        console.warn('[BOT] Dữ liệu từ server không hợp lệ hoặc thiếu arbitrageData.');
        currentSelectedOpportunity = null;
        return;
    }

    const now = Date.now();
    let bestOpportunity = null;

    for (const op of serverData.arbitrageData) {
        const minutesUntilFunding = (op.nextFundingTime - now) / (1000 * 60);

        if (op.estimatedPnl >= MIN_PNL_PERCENTAGE && minutesUntilFunding > 0 && minutesUntilFunding <= MAX_MINUTES_UNTIL_FUNDING) {
            if (!bestOpportunity || op.estimatedPnl > bestOpportunity.estimatedPnl) {
                bestOpportunity = op;
            }
        }
    }

    if (bestOpportunity) {
        console.log(`[BOT] 🎯 Cơ hội tốt nhất được tìm thấy: ${bestOpportunity.coin} trên ${bestOpportunity.exchanges}, PnL ước tính: ${bestOpportunity.estimatedPnl}%, Funding trong ${bestOpportunity.details.minutesUntilFunding.toFixed(1)} phút.`);
        currentSelectedOpportunity = bestOpportunity;
    } else {
        console.log('[BOT] 🔎 Không tìm thấy cơ hội arbitrage nào đủ điều kiện.');
        currentSelectedOpportunity = null;
    }
}

// Hàm quản lý và chuyển tiền giữa các sàn
// CẢNH BÁO QUAN TRỌNG: CHỨC NĂNG NÀY RẤT RỦI RO KHI DÙNG VỚI TIỀN THẬT. HÃY THỬ NGHIỆM CỰC KỲ KỸ LƯỠNG TRÊN TESTNET TRƯỚC!
async function manageFundsAndTransfer(opportunity, percentageToUse) {
    if (!opportunity || percentageToUse <= 0) {
        console.warn('[BOT_TRANSFER] Không có cơ hội hoặc phần trăm sử dụng không hợp lệ.');
        return false;
    }

    const [shortExchangeId, longExchangeId] = opportunity.exchanges.split(' / ').map(id => {
        if (id === 'binance') return 'binanceusdm'; 
        return id;
    });

    console.log(`[BOT_TRANSFER] Bắt đầu quản lý và chuyển tiền cho ${opportunity.coin} giữa ${shortExchangeId} và ${longExchangeId}.`);
    
    await updateBalances(); 

    const targetBalancePerExchange = balances.totalOverall / 2; 

    const involvedExchanges = [shortExchangeId, longExchangeId];
    const otherExchanges = Object.keys(exchanges).filter(id => !involvedExchanges.includes(id));

    let fundsTransferredSuccessfully = true;

    for (const sourceExchangeId of otherExchanges) {
        const sourceBalance = balances[sourceExchangeId].available;
        if (sourceBalance >= FUND_TRANSFER_MIN_AMOUNT) {
            let targetExchangeToFund = null;
            if (balances[shortExchangeId].available < targetBalancePerExchange && balances[longExchangeId].available < targetBalancePerExchange) {
                targetExchangeToFund = balances[shortExchangeId].available < balances[longExchangeId].available ? shortExchangeId : longExchangeId;
            } else if (balances[shortExchangeId].available < targetBalancePerExchange) {
                targetExchangeToFund = shortExchangeId;
            } else if (balances[longExchangeId].available < targetBalancePerExchange) {
                targetExchangeToFund = longExchangeId;
            }

            if (targetExchangeToFund) {
                const amountToTransfer = Math.min(sourceBalance, targetBalancePerExchange - balances[targetExchangeToFund].available);
                
                if (amountToTransfer >= FUND_TRANSFER_MIN_AMOUNT) {
                    const depositAddress = usdtBep20DepositAddresses[targetExchangeToFund];

                    if (!depositAddress || depositAddress.startsWith('0xYOUR_')) { 
                        console.error(`[BOT_TRANSFER] ❌ Thiếu hoặc chưa điền địa chỉ nạp tiền BEP20 THẬT SỰ cho ${targetExchangeToFund}. Vui lòng cập nhật balance.js`); 
                        fundsTransferredSuccessfully = false;
                        break;
                    }

                    console.log(`[BOT_TRANSFER] Đang cố gắng chuyển ${amountToTransfer.toFixed(2)} USDT từ ${sourceExchangeId} sang ${targetExchangeToFund} (${depositAddress}) qua BEP20...`);
                    try {
                        const withdrawResult = await exchanges[sourceExchangeId].withdraw(
                            'USDT',            
                            amountToTransfer,  
                            depositAddress,    
                            undefined,         
                            { network: BEP20_NETWORK_ID } 
                        );
                        console.log(`[BOT_TRANSFER] ✅ Yêu cầu rút tiền hoàn tất từ ${sourceExchangeId} sang ${targetExchangeToFund}. ID giao dịch: ${withdrawResult.id}`);
                        
                        await sleep(60000); // Đợi 60 giây (1 phút)
                    } catch (transferError) {
                        console.error(`[BOT_TRANSFER] ❌ Lỗi khi chuyển tiền từ ${sourceExchangeId} sang ${targetExchangeToFund}: ${transferError.message}`);
                        fundsTransferredSuccessfully = false;
                        break; 
                    }
                    await updateBalances(); 
                }
            }
        }
    }

    if (!fundsTransferredSuccessfully) {
        console.error('[BOT_TRANSFER] Quá trình chuyển tiền không hoàn tất do lỗi. Hủy bỏ giao dịch.');
        return false;
    }

    if (balances[shortExchangeId].available < targetBalancePerExchange * (percentageToUse / 100) ||
        balances[longExchangeId].available < targetBalancePerExchange * (percentageToUse / 100)) {
        console.error('[BOT_TRANSFER] Số dư trên sàn mục tiêu không đủ sau khi chuyển tiền hoặc chưa được cập nhật kịp thời. Hủy bỏ giao dịch.');
        return false;
    }
    
    console.log(`[BOT_TRANSFER] ✅ Quản lý tiền hoàn tất. ${shortExchangeId}: ${balances[shortExchangeId].available.toFixed(2)} USDT, ${longExchangeId}: ${balances[longExchangeId].available.toFixed(2)} USDT.`);
    return true;
}

// Hàm thực hiện mở lệnh
async function executeTrades(opportunity, percentageToUse) {
    if (!opportunity || percentageToUse <= 0) {
        console.warn('[BOT_TRADE] Không có cơ hội hoặc phần trăm sử dụng không hợp lệ.');
        return false;
    }

    const rawRatesData = serverDataGlobal?.rawRates; 
    if (!rawRatesData) {
        console.error('[BOT_TRADE] Dữ liệu giá thô từ server không có sẵn. Không thể mở lệnh.');
        return false;
    }

    const shortExchangeId = opportunity.details.shortExchange;
    const longExchangeId = opportunity.details.longExchange;
    const cleanedCoin = opportunity.coin;

    let shortOriginalSymbol, longOriginalSymbol;

    if (rawRatesData[shortExchangeId] && rawRatesData[shortExchangeId][cleanedCoin]) {
        shortOriginalSymbol = rawRatesData[shortExchangeId][cleanedCoin].symbol;
    } else {
        console.error(`[BOT_TRADE] Không tìm thấy symbol gốc cho ${cleanedCoin} trên ${shortExchangeId}.`);
        return false;
    }

    if (rawRatesData[longExchangeId] && rawRatesData[longExchangeId][cleanedCoin]) {
        longOriginalSymbol = rawRatesData[longExchangeId][cleanedCoin].symbol;
    } else {
        console.error(`[BOT_TRADE] Không tìm thấy symbol gốc cho ${cleanedCoin} trên ${longExchangeId}.`);
        return false;
    }

    const shortExchange = exchanges[shortExchangeId];
    const longExchange = exchanges[longExchangeId];

    const shortCollateral = balances[shortExchangeId].available * (percentageToUse / 100);
    const longCollateral = balances[longExchangeId].available * (percentageToUse / 100);

    if (shortCollateral <= 0 || longCollateral <= 0) {
        console.error('[BOT_TRADE] Số tiền mở lệnh (collateral) không hợp lệ. Hủy bỏ lệnh.');
        return false;
    }

    console.log(`[BOT_TRADE] Chuẩn bị mở lệnh cho ${cleanedCoin}:`);
    console.log(`  SHORT ${shortExchangeId} (${shortOriginalSymbol}): ${shortCollateral.toFixed(2)} USDT collateral`);
    console.log(`  LONG ${longExchangeId} (${longOriginalSymbol}): ${longCollateral.toFixed(2)} USDT collateral`);

    let tradeSuccess = true;
    let shortOrder = null, longOrder = null; 

    try {
        const tickerShort = await shortExchange.fetchTicker(shortOriginalSymbol);
        const tickerLong = await longExchange.fetchTicker(longOriginalSymbol);

        const shortEntryPrice = tickerShort.last; 
        const longEntryPrice = tickerLong.last; 

        if (!shortEntryPrice || !longEntryPrice) {
            console.error(`[BOT_TRADE] Không lấy được giá thị trường hiện tại cho ${cleanedCoin}.`);
            return false;
        }

        const shortAmount = (shortCollateral * opportunity.commonLeverage) / shortEntryPrice;
        const longAmount = (longCollateral * opportunity.commonLeverage) / longEntryPrice;

        if (shortAmount <= 0 || longAmount <= 0) {
            console.error('[BOT_TRADE] Lượng hợp đồng tính toán không hợp lệ. Hủy bỏ lệnh.');
            return false;
        }

        // --- Mở lệnh Short ---
        console.log(`[BOT_TRADE] Mở SHORT ${shortAmount.toFixed(opportunity.details.shortExchange === 'okx' ? 0 : 3)} ${cleanedCoin} trên ${shortExchangeId} với giá ${shortEntryPrice.toFixed(4)}...`);
        shortOrder = await shortExchange.createMarketSellOrder(shortOriginalSymbol, shortAmount);
        console.log(`[BOT_TRADE] ✅ Lệnh SHORT ${shortExchangeId} khớp: ID ${shortOrder.id}, Amount ${shortOrder.amount}, Price ${shortOrder.price}`);

        // --- Mở lệnh Long ---
        console.log(`[BOT_TRADE] Mở LONG ${longAmount.toFixed(opportunity.details.longExchange === 'okx' ? 0 : 3)} ${cleanedCoin} trên ${longExchangeId} với giá ${longEntryPrice.toFixed(4)}...`);
        longOrder = await longExchange.createMarketBuyOrder(longOriginalSymbol, longAmount);
        console.log(`[BOT_TRADE] ✅ Lệnh LONG ${longExchangeId} khớp: ID ${longOrder.id}, Amount ${longOrder.amount}, Price ${longOrder.price}`);

        currentTradeDetails = {
            coin: cleanedCoin,
            shortExchange: shortExchangeId,
            longExchange: longExchangeId,
            shortOriginalSymbol: shortOriginalSymbol, 
            longOriginalSymbol: longOriginalSymbol,   
            shortOrderId: shortOrder.id,
            longOrderId: longOrder.id,
            shortOrderAmount: shortOrder.amount, 
            longOrderAmount: longOrder.amount,   
            shortEntryPrice: shortEntryPrice,
            longEntryPrice: longEntryPrice,
            shortCollateral: shortCollateral, 
            longCollateral: longCollateral,   
            status: 'OPEN',
            openTime: Date.now()
        };

    } catch (e) {
        console.error(`[BOT_TRADE] ❌ Lỗi khi thực hiện giao dịch: ${e.message}`);
        tradeSuccess = false;
        if (shortOrder?.id) {
            try { await shortExchange.cancelOrder(shortOrder.id, shortOriginalSymbol); } catch (ce) { console.error(`[BOT_TRADE] Lỗi hủy lệnh SHORT: ${ce.message}`); }
        }
        if (longOrder?.id) {
            try { await longExchange.cancelOrder(longOrder.id, longOriginalSymbol); } catch (ce) { console.error(`[BOT_TRADE] Lỗi hủy lệnh LONG: ${ce.message}`); }
        }
    }
    return tradeSuccess;
}

// Hàm đóng lệnh và tính toán PnL
async function closeTradesAndCalculatePnL() {
    if (!currentTradeDetails || currentTradeDetails.status !== 'OPEN') {
        console.log('[BOT_PNL] Không có giao dịch nào đang mở để đóng.');
        return;
    }

    console.log('[BOT_PNL] 🔄 Đang đóng các vị thế và tính toán PnL...');
    const { coin, shortExchange, longExchange, shortOriginalSymbol, longOriginalSymbol, shortOrderAmount, longOrderAmount, shortCollateral, longCollateral } = currentTradeDetails;

    try {
        console.log(`[BOT_PNL] Đóng vị thế SHORT ${coin} trên ${shortExchange} (amount: ${shortOrderAmount})...`);
        const closeShortOrder = await exchanges[shortExchange].createMarketBuyOrder(shortOriginalSymbol, shortOrderAmount);
        console.log(`[BOT_PNL] ✅ Vị thế SHORT trên ${shortExchange} đã đóng. Order ID: ${closeShortOrder.id}`);

        console.log(`[BOT_PNL] Đóng vị thế LONG ${coin} trên ${longExchange} (amount: ${longOrderAmount})...`);
        const closeLongOrder = await exchanges[longExchange].createMarketSellOrder(longOriginalSymbol, longOrderAmount);
        console.log(`[BOT_PNL] ✅ Vị thế LONG trên ${longExchange} đã đóng. Order ID: ${closeLongOrder.id}`);

        await sleep(15000); 

        await updateBalances(); 

        const shortBalanceAfter = balances[shortExchange].available;
        const longBalanceAfter = balances[longExchange].available;

        const cyclePnl = (shortBalanceAfter - shortCollateral) + (longBalanceAfter - longCollateral); 
        cumulativePnl += cyclePnl;

        tradeHistory.unshift({ 
            id: Date.now(),
            coin: coin,
            exchanges: `${shortExchange}/${longExchange}`,
            fundingDiff: currentSelectedOpportunity?.fundingDiff,
            estimatedPnl: currentSelectedOpportunity?.estimatedPnl,
            actualPnl: parseFloat(cyclePnl.toFixed(2)), 
            timestamp: new Date().toISOString()
        });

        if (tradeHistory.length > 50) {
            tradeHistory.pop(); 
        }

        console.log(`[BOT_PNL] ✅ Chu kỳ giao dịch cho ${coin} hoàn tất. PnL chu kỳ: ${cyclePnl.toFixed(2)} USD. Tổng PnL: ${cumulativePnl.toFixed(2)} USD.`);

    } catch (e) {
        console.error(`[BOT_PNL] ❌ Lỗi khi đóng vị thế hoặc tính toán PnL: ${e.message}`);
    } finally {
        currentSelectedOpportunity = null; 
        currentTradeDetails = null; 
        console.log('[BOT_PNL] Dọn dẹp lệnh chờ và vị thế đã đóng (nếu có).');
    }
}


let serverDataGlobal = null; 

// Vòng lặp chính của Bot
async function mainBotLoop() {
    if (botLoopIntervalId) clearTimeout(botLoopIntervalId); 

    if (botState !== 'RUNNING') {
        console.log('[BOT_LOOP] Bot không ở trạng thái RUNNING. Dừng vòng lặp.');
        return;
    }

    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentSecond = now.getUTCSeconds();

    console.log(`[BOT_LOOP] Đang chạy vòng lặp bot. Phút: ${currentMinute}, Giây: ${currentSecond}`);

    // Logic cập nhật dữ liệu từ server chính
    if ( (currentMinute === HOURLY_FETCH_TIME_MINUTE && currentSecond >= 0 && currentSecond < 5) || 
         (currentSecond >= 0 && currentSecond < 5 && currentMinute % DATA_FETCH_INTERVAL_MINUTES === 0) ) {
        if (!serverDataGlobal || (currentMinute === HOURLY_FETCH_TIME_MINUTE && currentSecond < 5)) {
             console.log(`[BOT_LOOP] Kích hoạt cập nhật dữ liệu chính từ server.`);
             const fetchedData = await fetchDataFromServer();
             if (fetchedData) {
                 serverDataGlobal = fetchedData; 
                 await processServerData(serverDataGlobal);
             }
         } else if (currentMinute % DATA_FETCH_INTERVAL_MINUTES === 0) { 
             console.log(`[BOT_LOOP] Cập nhật dữ liệu từ server (mỗi phút).`);
             const fetchedData = await fetchDataFromServer();
             if (fetchedData) {
                 serverDataGlobal = fetchedData;
                 await processServerData(serverDataGlobal);
             }
         }
    }


    // Logic giao dịch (chỉ thực hiện vào các phút cụ thể)
    if (currentSelectedOpportunity) {
        // Chuẩn bị chuyển tiền vào phút 50
        if (currentMinute === 50 && currentSecond >= 5 && currentSecond < 10 && botState === 'RUNNING' && !currentTradeDetails) {
            console.log(`[BOT_LOOP] 🚀 Kích hoạt chuyển tiền cho cơ hội ${currentSelectedOpportunity.coin} vào phút 50.`);
            botState = 'TRANSFERRING_FUNDS';
            const transferSuccess = await manageFundsAndTransfer(currentSelectedOpportunity, 50); 
            if (transferSuccess) {
                console.log('[BOT_LOOP] ✅ Chuyển tiền hoàn tất. Chờ mở lệnh.');
            } else {
                console.error('[BOT_LOOP] ❌ Lỗi chuyển tiền hoặc không đủ số dư. Hủy chu kỳ này.');
                currentSelectedOpportunity = null; 
            }
            botState = 'RUNNING'; 
        }

        // Thực hiện mở lệnh vào phút 59:55
        if (currentMinute === 59 && currentSecond >= 55 && currentSecond < 59 && botState === 'RUNNING' && currentSelectedOpportunity && !currentTradeDetails) {
            console.log(`[BOT_LOOP] ⚡ Kích hoạt mở lệnh cho cơ hội ${currentSelectedOpportunity.coin} vào phút 59:55.`);
            botState = 'EXECUTING_TRADES';
            const tradeSuccess = await executeTrades(currentSelectedOpportunity, 50); 
            if (tradeSuccess) {
                console.log('[BOT_LOOP] ✅ Mở lệnh hoàn tất.');
            } else {
                console.error('[BOT_LOOP] ❌ Lỗi mở lệnh. Hủy chu kỳ này.');
                currentSelectedOpportunity = null; 
            }
            botState = 'RUNNING'; 
        }
    }
    
    // Đóng lệnh và tính PnL sau giờ funding (phút 00:05 của giờ tiếp theo)
    if (currentMinute === 0 && currentSecond >= 5 && currentSecond < 10 && botState === 'RUNNING' && currentTradeDetails?.status === 'OPEN') {
        console.log('[BOT_LOOP] 🛑 Kích hoạt đóng lệnh và tính PnL vào phút 00:05.');
        botState = 'CLOSING_TRADES';
        await closeTradesAndCalculatePnL();
        botState = 'RUNNING'; 
    }

    // Lặp lại sau 1 giây để kiểm tra thời gian chính xác
    botLoopIntervalId = setTimeout(mainBotLoop, 1000); 
}

// ----- CÁC HÀM ĐIỀU KHIỂN BOT TỪ UI -----
function startBot() {
    if (botState === 'STOPPED') {
        console.log('[BOT] ▶️ Khởi động Bot...');
        botState = 'RUNNING';
        updateBalances(); 
        mainBotLoop(); 
        return true;
    }
    console.warn('[BOT] Bot đã chạy hoặc đang trong quá trình chuyển trạng thái.');
    return false;
}

function stopBot() {
    if (botState === 'RUNNING' || botState === 'FETCHING_DATA' || botState === 'PROCESSING_DATA' || botState === 'TRANSFERRING_FUNDS' || botState === 'EXECUTING_TRADES' || botState === 'CLOSING_TRADES') {
        console.log('[BOT] ⏸️ Dừng Bot...');
        if (botLoopIntervalId) {
            clearTimeout(botLoopIntervalId);
            botLoopIntervalId = null;
        }
        botState = 'STOPPED';
        return true;
    }
    console.warn('[BOT] Bot không hoạt động hoặc không thể dừng.');
    return false;
}

// ----- KHỞI TẠO SERVER HTTP CHO BOT UI -----
const botServer = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            if (err) {
                console.error('[BOT_SERVER] ❌ Lỗi khi đọc index.html:', err.message);
                res.writeHead(500);
                res.end('Lỗi khi đọc index.html');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
            res.end(content);
        });
    } else if (req.url === '/bot-api/status' && req.method === 'GET') {
        const statusData = {
            botState: botState,
            balances: balances,
            initialTotalBalance: initialTotalBalance,
            cumulativePnl: cumulativePnl,
            tradeHistory: tradeHistory,
            currentSelectedOpportunity: currentSelectedOpportunity,
            currentTradeDetails: currentTradeDetails
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(statusData));
    } else if (req.url === '/bot-api/start' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const data = body ? JSON.parse(body) : {}; 
                const started = startBot();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: started, message: started ? 'Bot đã khởi động.' : 'Bot đã chạy.' }));
            } catch (error) {
                console.error('[BOT_SERVER] ❌ Lỗi xử lý POST /bot-api/start:', error.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Dữ liệu yêu cầu không hợp lệ hoặc lỗi server.' }));
            }
        });
    } else if (req.url === '/bot-api/stop' && req.method === 'POST') {
        const stopped = stopBot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: stopped, message: stopped ? 'Bot đã dừng.' : 'Bot không hoạt động.' }));
    } else {
        res.writeHead(404); res.end('Not Found');
    }
});

botServer.listen(BOT_PORT, () => {
    console.log(`✅ Máy chủ UI của Bot đang chạy tại http://localhost:${BOT_PORT}`);
    console.log('Bot đang chờ lệnh "Start" từ giao diện HTML.');
});
