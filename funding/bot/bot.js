// bot.js
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const { URLSearchParams } = require('url');

// Import các API Key và Secret từ file config.js
const {
    binanceApiKey, binanceApiSecret,
    bingxApiKey, bingxApiSecret,
    okxApiKey, okxApiSecret, okxPassword,
    bitgetApiKey, bitgetApiSecret, bitgetApiPassword
} = require('../config.js');

const BOT_PORT = 5006; // Cổng cho Bot UI (khác với cổng của Server chính)
const SERVER_DATA_URL = 'http://localhost:5005/api/data'; // Địa chỉ Server chính

// ----- CẤU HÌNH BOT -----
const MIN_PNL_PERCENTAGE = 7; // %PnL tối thiểu để bot xem xét
const MAX_MINUTES_UNTIL_FUNDING = 30; // Trong vòng 30 phút tới sẽ tới giờ funding
const FUND_TRANSFER_MIN_AMOUNT = 10; // Số tiền tối thiểu cho mỗi lần chuyển tiền qua BEP20

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

// Hàm hỗ trợ (sao chép từ server để đảm bảo tính nhất quán nếu cần)
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
            // Load markets để đảm bảo fetchBalance hoạt động chính xác
            await exchange.loadMarkets(true);
            
            // Lấy số dư tổng quát
            const accountBalance = await exchange.fetchBalance({ 'type': 'future' }); 
            const usdtBalance = accountBalance.free?.USDT || 0; // free hoặc total tùy sàn
            const usdtTotalBalance = accountBalance.total?.USDT || 0;

            balances[id].total = usdtTotalBalance;
            balances[id].available = usdtBalance;
            
            // Cập nhật Original Symbol nếu cần (chỉ là placeholder cho ý tưởng của bạn)
            // Trong thực tế, CCXT sẽ trả về symbol chuẩn của nó, cần logic phức tạp hơn
            // để map lại với symbol gốc của sàn nếu nó khác biệt đáng kể (ví dụ: '1000PEPEUSDT')
            // Để đơn giản ở đây, ta giả định CCXT symbol là đủ cho việc tính toán PnL,
            // và server sẽ cung cấp mapping cho việc mở lệnh.
            balances[id].originalSymbol = {}; // Reset hoặc cập nhật theo nhu cầu
            // Để thực sự có mapping Original Symbol, bot cần nhận nó từ server
            // và lưu trữ trong cấu trúc balances này.

            totalOverall += usdtBalance; // Tính tổng số dư khả dụng

            console.log(`[BOT] ✅ ${id.toUpperCase()} Balance: Total ${usdtTotalBalance.toFixed(2)} USDT, Available ${usdtBalance.toFixed(2)} USDT.`);
        } catch (e) {
            console.error(`[BOT] ❌ Lỗi khi lấy số dư ${id.toUpperCase()}: ${e.message}`);
        }
    }
    balances.totalOverall = totalOverall;
    console.log(`[BOT] Tổng số dư khả dụng trên tất cả các sàn: ${totalOverall.toFixed(2)} USDT.`);
    if (initialTotalBalance === 0) { // Set initial balance only once
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

    // Lọc và tìm cơ hội tốt nhất
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
// Đây là phần RẤT PHỨC TẠP và CẦN THỬ NGHIỆM CỰC KỲ KỸ LƯỠNG
async function manageFundsAndTransfer(opportunity, percentageToUse) {
    if (!opportunity || percentageToUse <= 0) {
        console.warn('[BOT_TRANSFER] Không có cơ hội hoặc phần trăm sử dụng không hợp lệ.');
        return false;
    }

    const [shortExchangeId, longExchangeId] = opportunity.exchanges.split(' / ').map(id => {
        if (id === 'binance') return 'binanceusdm'; // Map back to internal ID
        return id;
    });

    // Lấy symbol gốc cho từng sàn để chuyển tiền nếu cần
    // Server phải trả về mapping này
    const shortExchangeOriginalSymbol = opportunity.details.shortExchange === 'binanceusdm' ? 
        (serverDataGlobal.rawRates.binanceusdm[opportunity.coin]?.symbol || opportunity.coin) :
        (serverDataGlobal.rawRates[opportunity.details.shortExchange][opportunity.coin]?.symbol || opportunity.coin);

    const longExchangeOriginalSymbol = opportunity.details.longExchange === 'binanceusdm' ? 
        (serverDataGlobal.rawRates.binanceusdm[opportunity.coin]?.symbol || opportunity.coin) :
        (serverDataGlobal.rawRates[opportunity.details.longExchange][opportunity.coin]?.symbol || opportunity.coin);

    console.log(`[BOT_TRANSFER] Bắt đầu quản lý và chuyển tiền cho ${opportunity.coin} giữa ${shortExchangeId} và ${longExchangeId}.`);
    
    await updateBalances(); // Cập nhật số dư mới nhất

    const targetBalancePerExchange = balances.totalOverall / 2; // Chia đôi tổng số dư

    // Để đơn giản hóa logic chuyển tiền (phần này cực kỳ khó triển khai an toàn tự động):
    // Chúng ta sẽ cố gắng chuyển tiền từ các sàn không tham gia giao dịch sang hai sàn mục tiêu.
    // Nếu các sàn mục tiêu không đủ tiền sau khi chuyển, bot sẽ không tiếp tục.
    // Logic này sẽ KHÔNG bao gồm việc "trao đổi" tiền giữa 2 sàn mục tiêu như ví dụ của bạn (Bitget chuyển BingX rồi BingX trả lại).
    // Đây là một logic cực kỳ phức tạp và rủi ro.

    const involvedExchanges = [shortExchangeId, longExchangeId];
    const otherExchanges = Object.keys(exchanges).filter(id => !involvedExchanges.includes(id));

    let fundsTransferredSuccessfully = true;

    for (const sourceExchangeId of otherExchanges) {
        const sourceBalance = balances[sourceExchangeId].available;
        if (sourceBalance >= FUND_TRANSFER_MIN_AMOUNT) {
            // Ưu tiên chuyển cho sàn thiếu nhiều hơn
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
                    console.log(`[BOT_TRANSFER] Đang cố gắng chuyển ${amountToTransfer.toFixed(2)} USDT từ ${sourceExchangeId} sang ${targetExchangeToFund} qua BEP20...`);
                    // --- ĐÂY LÀ NƠI BẠN CẦN TRIỂN KHAI LOGIC CHUYỂN TIỀN THỰC TẾ ---
                    // CCXT không hỗ trợ chuyển tiền trực tiếp giữa các sàn.
                    // Bạn cần sử dụng API native của từng sàn để:
                    // 1. Lấy địa chỉ nạp tiền BEP20 của sàn đích (`targetExchangeToFund`).
                    // 2. Rút tiền từ sàn nguồn (`sourceExchangeId`) đến địa chỉ đó.
                    try {
                        // Ví dụ (code giả định, cần triển khai thực tế):
                        // const targetDepositAddress = await exchanges[targetExchangeToFund].fetchDepositAddress('USDT', { network: 'BEP20' });
                        // const withdrawResult = await exchanges[sourceExchangeId].withdraw('USDT', amountToTransfer, targetDepositAddress.address, { network: 'BEP20' });
                        // console.log(`[BOT_TRANSFER] ✅ Yêu cầu chuyển tiền hoàn tất từ ${sourceExchangeId} sang ${targetExchangeToFund}. ID giao dịch: ${withdrawResult.id}`);
                        
                        // Để mô phỏng:
                        balances[sourceExchangeId].available -= amountToTransfer;
                        balances[targetExchangeToFund].available += amountToTransfer;
                        console.log(`[BOT_TRANSFER] (Mô phỏng) Đã chuyển ${amountToTransfer.toFixed(2)} USDT từ ${sourceExchangeId} sang ${targetExchangeToFund}.`);
                        await sleep(15000); // Đợi 15 giây cho giao dịch mô phỏng
                    } catch (transferError) {
                        console.error(`[BOT_TRANSFER] ❌ Lỗi khi chuyển tiền từ ${sourceExchangeId} sang ${targetExchangeToFund}: ${transferError.message}`);
                        fundsTransferredSuccessfully = false;
                        break; // Dừng nếu có lỗi chuyển tiền
                    }
                    await updateBalances(); // Cập nhật lại số dư sau khi chuyển
                }
            }
        }
    }

    if (!fundsTransferredSuccessfully) {
        console.error('[BOT_TRANSFER] Quá trình chuyển tiền không hoàn tất do lỗi. Hủy bỏ giao dịch.');
        return false;
    }

    // Kiểm tra lại xem hai sàn mục tiêu có đủ số dư cần thiết không
    if (balances[shortExchangeId].available < targetBalancePerExchange * (percentageToUse / 100) ||
        balances[longExchangeId].available < targetBalancePerExchange * (percentageToUse / 100)) {
        console.error('[BOT_TRANSFER] Số dư trên sàn mục tiêu không đủ sau khi chuyển tiền. Hủy bỏ giao dịch.');
        return false;
    }
    
    console.log(`[BOT_TRANSFER] ✅ Quản lý tiền hoàn tất. ${shortExchangeId}: ${balances[shortExchangeId].available.toFixed(2)} USDT, ${longExchangeId}: ${balances[longExchangeId].available.toFixed(2)} USDT.`);
    return true;
}

// Hàm thực hiện mở lệnh
// Đây cũng là phần RẤT PHỨC TẠP và CẦN THỬ NGHIỆM CỰC KỲ KỸ LƯỠNG
async function executeTrades(opportunity, percentageToUse) {
    if (!opportunity || percentageToUse <= 0) {
        console.warn('[BOT_TRADE] Không có cơ hội hoặc phần trăm sử dụng không hợp lệ.');
        return false;
    }

    // Lấy symbol gốc của sàn để đặt lệnh. serverDataGlobal cần được cập nhật
    // sau mỗi lần fetch từ server chính để đảm bảo mapping symbol là mới nhất.
    const rawRatesData = serverDataGlobal.rawRates;

    const shortExchangeId = opportunity.details.shortExchange;
    const longExchangeId = opportunity.details.longExchange;
    const cleanedCoin = opportunity.coin;

    let shortOriginalSymbol, longOriginalSymbol;

    // Tìm symbol gốc từ rawRates của server
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

    // Tính toán số tiền để mở lệnh dựa trên % tài khoản và đòn bẩy
    // Số tiền mở lệnh = (availableBalance * percentageToUse / 100) * commonLeverage
    // Tuy nhiên, % tài khoản là số tiền *không* đòn bẩy.
    // Số tiền để mở lệnh (collateral) = availableBalance * percentageToUse / 100
    // Lượng hợp đồng (amount) = collateral * commonLeverage / currentPrice (cần lấy giá hiện tại)
    
    // Đơn giản hóa: bot sẽ dùng 10% số dư có sẵn để mở lệnh (tổng collateral)
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
    let shortOrder, longOrder;

    try {
        // Lấy giá thị trường hiện tại để tính lượng hợp đồng và đặt SL/TP
        // CCXT fetchTicker cung cấp giá ask/bid
        const tickerShort = await shortExchange.fetchTicker(shortOriginalSymbol);
        const tickerLong = await longExchange.fetchTicker(longOriginalSymbol);

        const shortEntryPrice = tickerShort.last; // Hoặc ticker.ask
        const longEntryPrice = tickerLong.last; // Hoặc ticker.bid

        if (!shortEntryPrice || !longEntryPrice) {
            console.error(`[BOT_TRADE] Không lấy được giá thị trường hiện tại cho ${cleanedCoin}.`);
            return false;
        }

        // Tính toán lượng hợp đồng (amount)
        // amount = (collateral * leverage) / entryPrice
        // Lưu ý: commonLeverage từ arbitrageOpportunity đã được tính toán
        // Giả định leverage là commonLeverage
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

        // --- Đặt Stop Loss và Take Profit (Cần kiểm tra kỹ con số 800% và 8386%) ---
        // Giả định 800% và 8386% là % của giá Entry.
        // Đây là ví dụ, bạn cần điều chỉnh giá SL/TP theo logic chính xác của mình.
        const SL_FACTOR = 8.00; // 800% loss => 8x giá entry
        const TP_FACTOR = 83.86; // 8386% profit => 83.86x giá entry

        // Short SL (giá tăng 800%) / TP (giá giảm 8386%)
        // Long SL (giá giảm 800%) / TP (giá tăng 8386%)
        
        // Ví dụ đặt SL/TP (cần thay thế bằng logic thực tế của bạn)
        // Đây là những con số SL/TP không khả thi cho giao dịch thực tế
        // const shortSlPrice = shortEntryPrice * (1 + SL_FACTOR);
        // const shortTpPrice = shortEntryPrice * (1 - TP_FACTOR);
        // const longSlPrice = longEntryPrice * (1 - SL_FACTOR);
        // const longTpPrice = longEntryPrice * (1 + TP_FACTOR);

        // console.log(`[BOT_TRADE] Đặt SL/TP cho ${shortExchangeId} SHORT: SL at ${shortSlPrice.toFixed(4)}, TP at ${shortTpPrice.toFixed(4)}`);
        // await shortExchange.createOrder(shortOriginalSymbol, 'stop_market', 'buy', shortAmount, shortSlPrice, { stopLossPrice: shortSlPrice });
        // await shortExchange.createOrder(shortOriginalSymbol, 'take_profit_market', 'buy', shortAmount, shortTpPrice, { takeProfitPrice: shortTpPrice });

        // console.log(`[BOT_TRADE] Đặt SL/TP cho ${longExchangeId} LONG: SL at ${longSlPrice.toFixed(4)}, TP at ${longTpPrice.toFixed(4)}`);
        // await longExchange.createOrder(longOriginalSymbol, 'stop_market', 'sell', longAmount, longSlPrice, { stopLossPrice: longSlPrice });
        // await longExchange.createOrder(longOriginalSymbol, 'take_profit_market', 'sell', longAmount, longTpPrice, { takeProfitPrice: longTpPrice });

        currentTradeDetails = {
            coin: cleanedCoin,
            shortExchange: shortExchangeId,
            longExchange: longExchangeId,
            shortOrder: shortOrder.id,
            longOrder: longOrder.id,
            shortEntryPrice: shortEntryPrice,
            longEntryPrice: longEntryPrice,
            status: 'OPEN'
        };

    } catch (e) {
        console.error(`[BOT_TRADE] ❌ Lỗi khi thực hiện giao dịch: ${e.message}`);
        tradeSuccess = false;
        // Cố gắng hủy lệnh đã khớp một phần nếu có lỗi
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
    const { coin, shortExchange, longExchange, shortOriginalSymbol, longOriginalSymbol } = currentTradeDetails;

    try {
        // Đóng vị thế Short
        console.log(`[BOT_PNL] Đóng vị thế SHORT ${coin} trên ${shortExchange}...`);
        // CCXT closePosition cần amount và market.id, không phải order id
        // Hoặc dùng createMarketBuyOrder để đóng short
        await exchanges[shortExchange].createMarketBuyOrder(shortOriginalSymbol, currentTradeDetails.shortOrderAmount); // Cần lưu trữ amount của lệnh đã mở
        console.log(`[BOT_PNL] ✅ Vị thế SHORT trên ${shortExchange} đã đóng.`);

        // Đóng vị thế Long
        console.log(`[BOT_PNL] Đóng vị thế LONG ${coin} trên ${longExchange}...`);
        await exchanges[longExchange].createMarketSellOrder(longOriginalSymbol, currentTradeDetails.longOrderAmount); // Cần lưu trữ amount của lệnh đã mở
        console.log(`[BOT_PNL] ✅ Vị thế LONG trên ${longExchange} đã đóng.`);

        await sleep(60000); // Đợi 1 phút để sàn cập nhật PnL thực tế

        // Cập nhật PnL thực tế từ sàn
        let shortPnL = 0; // Thay thế bằng cách fetch PnL từ sàn
        let longPnL = 0;  // Thay thế bằng cách fetch PnL từ sàn

        // --- ĐÂY LÀ NƠI BẠN CẦN TRIỂN KHAI LOGIC LẤY PNL THỰC TẾ ---
        // Mỗi sàn có thể có cách lấy PnL khác nhau (ví dụ: fetchPosition, fetchClosedOrders)
        // Rất phức tạp để lấy PnL chính xác cho từng lệnh vừa đóng qua CCXT một cách tổng quát
        // Một cách đơn giản hơn là theo dõi số dư tài khoản trước và sau.
        await updateBalances(); // Cập nhật số dư cuối cùng

        const cyclePnl = (balances[shortExchange].available - currentTradeDetails.shortCollateral) + (balances[longExchange].available - currentTradeDetails.longCollateral); // Ví dụ tính PnL tạm
        cumulativePnl += cyclePnl;

        // Lưu vào lịch sử
        tradeHistory.unshift({ // unshift để thêm vào đầu mảng
            id: Date.now(),
            coin: coin,
            exchanges: `${shortExchange}/${longExchange}`,
            fundingDiff: currentSelectedOpportunity.fundingDiff,
            estimatedPnl: currentSelectedOpportunity.estimatedPnl,
            actualPnl: parseFloat(cyclePnl.toFixed(2)), // PnL thực tế của chu kỳ này
            timestamp: new Date().toISOString()
        });

        if (tradeHistory.length > 50) {
            tradeHistory.pop(); // Giữ tối đa 50 lịch sử
        }

        console.log(`[BOT_PNL] ✅ Chu kỳ giao dịch cho ${coin} hoàn tất. PnL chu kỳ: ${cyclePnl.toFixed(2)} USD. Tổng PnL: ${cumulativePnl.toFixed(2)} USD.`);

    } catch (e) {
        console.error(`[BOT_PNL] ❌ Lỗi khi đóng vị thế hoặc tính toán PnL: ${e.message}`);
    } finally {
        currentSelectedOpportunity = null; // Reset cơ hội
        currentTradeDetails = null; // Reset chi tiết giao dịch
        console.log('[BOT_PNL] Dọn dẹp lệnh chờ và vị thế đã đóng (nếu có).');
        // Cần thêm logic hủy mọi lệnh chờ (SL/TP) còn sót lại
    }
}


let serverDataGlobal = null; // Biến toàn cục để lưu dữ liệu từ server chính

// Vòng lặp chính của Bot
async function mainBotLoop() {
    if (botState !== 'RUNNING') {
        console.log('[BOT_LOOP] Bot không ở trạng thái RUNNING. Dừng vòng lặp.');
        return;
    }

    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentSecond = now.getUTCSeconds();

    console.log(`[BOT_LOOP] Đang chạy vòng lặp bot. Phút: ${currentMinute}, Giây: ${currentSecond}`);

    // Cập nhật dữ liệu từ server chính mỗi phút hoặc vào phút HOURLY_FETCH_TIME_MINUTE
    if (currentMinute === HOURLY_FETCH_TIME_MINUTE && currentSecond < 5) {
        console.log(`[BOT_LOOP] Kích hoạt cập nhật dữ liệu chính từ server vào phút ${HOURLY_FETCH_TIME_MINUTE}.`);
        serverDataGlobal = await fetchDataFromServer();
        if (serverDataGlobal) {
            await processServerData(serverDataGlobal);
        }
    } else if (currentSecond < 5 || currentSecond > 55) { // Cập nhật mỗi phút
        console.log(`[BOT_LOOP] Cập nhật dữ liệu từ server (mỗi phút).`);
        serverDataGlobal = await fetchDataFromServer();
        if (serverDataGlobal) {
            await processServerData(serverDataGlobal);
        }
    }


    // Logic giao dịch (chỉ thực hiện vào các phút cụ thể)
    if (currentSelectedOpportunity) {
        const minutesUntilFunding = (currentSelectedOpportunity.nextFundingTime - now.getTime()) / (1000 * 60);

        // Chuẩn bị chuyển tiền vào phút 50 (hoặc sớm hơn một chút để có thời gian)
        if (currentMinute === 50 && currentSecond < 10 && botState === 'RUNNING' && !currentTradeDetails) {
            console.log(`[BOT_LOOP] 🚀 Kích hoạt chuyển tiền cho cơ hội ${currentSelectedOpportunity.coin} vào phút 50.`);
            botState = 'TRANSFERRING_FUNDS';
            const transferSuccess = await manageFundsAndTransfer(currentSelectedOpportunity, 50); // Giả sử dùng 50% số dư cho mỗi sàn
            if (transferSuccess) {
                console.log('[BOT_LOOP] ✅ Chuyển tiền hoàn tất. Chờ mở lệnh.');
            } else {
                console.error('[BOT_LOOP] ❌ Lỗi chuyển tiền hoặc không đủ số dư. Hủy chu kỳ này.');
                currentSelectedOpportunity = null; // Reset cơ hội
            }
            botState = 'RUNNING'; // Trở lại trạng thái chạy
        }

        // Thực hiện mở lệnh vào phút 59:55
        if (currentMinute === 59 && currentSecond >= 55 && currentSecond < 59 && botState === 'RUNNING' && currentSelectedOpportunity && !currentTradeDetails) {
            console.log(`[BOT_LOOP] ⚡ Kích hoạt mở lệnh cho cơ hội ${currentSelectedOpportunity.coin} vào phút 59:55.`);
            botState = 'EXECUTING_TRADES';
            const tradeSuccess = await executeTrades(currentSelectedOpportunity, 50); // Dùng 50% số dư cho mỗi lệnh
            if (tradeSuccess) {
                console.log('[BOT_LOOP] ✅ Mở lệnh hoàn tất.');
            } else {
                console.error('[BOT_LOOP] ❌ Lỗi mở lệnh. Hủy chu kỳ này.');
                currentSelectedOpportunity = null; // Reset cơ hội
            }
            botState = 'RUNNING'; // Trở lại trạng thái chạy
        }
    }
    
    // Đóng lệnh và tính PnL sau giờ funding (phút 00:05 của giờ tiếp theo)
    if (currentMinute === 0 && currentSecond >= 5 && currentSecond < 10 && botState === 'RUNNING' && currentTradeDetails?.status === 'OPEN') {
        console.log('[BOT_LOOP] 🛑 Kích hoạt đóng lệnh và tính PnL vào phút 00:05.');
        botState = 'CLOSING_TRADES';
        await closeTradesAndCalculatePnL();
        botState = 'RUNNING'; // Trở lại trạng thái chạy
    }

    // Lặp lại sau 1 giây để kiểm tra thời gian chính xác
    botLoopIntervalId = setTimeout(mainBotLoop, 1000); 
}

// ----- CÁC HÀM ĐIỀU KHIỂN BOT TỪ UI -----
function startBot() {
    if (botState === 'STOPPED') {
        console.log('[BOT] ▶️ Khởi động Bot...');
        botState = 'RUNNING';
        updateBalances(); // Lấy số dư ban đầu khi khởi động
        mainBotLoop(); // Bắt đầu vòng lặp chính
        return true;
    }
    console.warn('[BOT] Bot đã chạy hoặc đang trong quá trình chuyển trạng thái.');
    return false;
}

function stopBot() {
    if (botState === 'RUNNING' || botState === 'FETCHING_DATA' || botState === 'PROCESSING_DATA') {
        console.log('[BOT] ⏸️ Dừng Bot...');
        clearTimeout(botLoopIntervalId);
        botState = 'STOPPED';
        // Đảm bảo không có lệnh nào đang chạy hoặc chuyển tiền dở dang
        // Cần thêm logic để hủy mọi lệnh chờ hoặc đóng vị thế nếu bot dừng đột ngột
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
        // Cập nhật số dư trước khi gửi về UI (không cần updateBalances full mỗi lần)
        // Chỉ cần lấy số liệu từ biến balances đã lưu
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
            const data = JSON.parse(body);
            // Bạn có thể dùng data.percentageToUse ở đây nếu muốn UI gửi nó
            const started = startBot();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: started, message: started ? 'Bot đã khởi động.' : 'Bot đã chạy.' }));
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
