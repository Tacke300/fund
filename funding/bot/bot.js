// Version 3 (Khắc phục ReferenceError: currentTradeDetails, tính số dư âm, HTML display, Log tinh gọn)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const { URLSearchParams } = require('url');

// Tạo một hàm log an toàn để tránh TypeError: console is not a function
const safeLog = (type, ...args) => {
    try {
        if (typeof console === 'object' && typeof console[type] === 'function') {
            console[type](`[${type.toUpperCase()}]`, ...args);
        } else {
            const message = `[${type.toUpperCase()}] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`;
            if (type === 'error' || type === 'warn') {
                process.stderr.write(message);
            } else {
                process.stdout.write(message);
            }
        }
    } catch (e) {
        process.stderr.write(`FATAL LOG ERROR: ${e.message} - Original log: [${type.toUpperCase()}] ${args.join(' ')}\n`);
    }
};

// Import các API Key và Secret từ file config.js
const {
    binanceApiKey, binanceApiSecret,
    bingxApiKey, bingxApiSecret,
    okxApiKey, okxApiSecret, okxPassword,
    bitgetApiKey, bitgetApiSecret, bitgetApiPassword
} = require('../config.js'); 

// Import địa chỉ ví nạp tiền từ file balance.js
const { usdtBep20DepositAddresses } = require('./balance.js'); 

const BOT_PORT = 5006; // Cổng cho Bot UI (khác với cổng của Server chính)
const SERVER_DATA_URL = 'http://localhost:5005/api/data'; // Địa chỉ Server chính

// ----- CẤU HÌNH BOT -----
const MIN_PNL_PERCENTAGE = 7; // %PnL tối thiểu để bot xem xét
const MAX_MINUTES_UNTIL_FUNDING = 30; // Trong vòng 30 phút tới sẽ tới giờ funding (để bot tìm cơ hội)
const MIN_MINUTES_FOR_EXECUTION = 15; // Phải còn ít nhất 15 phút tới funding để bot xem xét thực hiện (ví dụ của bạn là >=15)
const FUND_TRANSFER_MIN_AMOUNT = 10; // Số tiền tối thiểu cho mỗi lần chuyển tiền qua BEP20
const BEP20_NETWORK_ID = 'BEP20'; // ID mạng cho BEP20 (Binance Smart Chain)

const DATA_FETCH_INTERVAL_SECONDS = 5; // Cập nhật dữ liệu mỗi 5 giây
const HOURLY_FETCH_TIME_MINUTE = 45; // Mỗi giờ vào phút thứ 45, bot lấy dữ liệu chính

// ----- BIẾN TOÀN CỤC CHO BOT -----
let botState = 'STOPPED'; // 'STOPPED', 'RUNNING', 'FETCHING_DATA', 'PROCESSING_DATA', 'TRANSFERRING_FUNDS', 'EXECUTING_TRADES', 'CLOSING_TRADES'
let botLoopIntervalId = null;

// Khai báo biến toàn cục rất sớm để tránh ReferenceError
let balances = {
    binanceusdm: { total: 0, available: 0, originalSymbol: {} },
    bingx: { total: 0, available: 0, originalSymbol: {} },
    okx: { total: 0, available: 0, originalSymbol: {} },
    bitget: { total: 0, available: 0, originalSymbol: {} },
    totalOverall: 0 
};
let initialTotalBalance = 0;
let cumulativePnl = 0; 
let tradeHistory = []; 

// Biến cho logic lựa chọn cơ hội
let currentSelectedOpportunityForExecution = null; // Cơ hội được chọn ĐỂ THỰC THI (chỉ được set vào phút 50)
let bestPotentialOpportunityForDisplay = null; // Cơ hội tốt nhất CHỈ ĐỂ HIỂN THỊ trên UI/log
let allCurrentOpportunities = []; // Danh sách tất cả cơ hội từ server, đã lọc cơ bản (PnL dương, Funding >0)

// Biến cờ để đảm bảo các hành động theo thời gian chỉ chạy 1 lần mỗi phút/giây
const LAST_ACTION_TIMESTAMP = {
    dataFetch: 0, // Lưu giây cuối cùng của fetch dữ liệu
    selectionTime: 0, // Lưu phút cuối cùng của việc chọn cơ hội thực thi
    tradeExecution: 0, // Lưu phút cuối cùng của việc mở lệnh
    closeTrade: 0, // Lưu phút cuối cùng của việc đóng lệnh
};

// Vấn đề ReferenceError: currentTradeDetails is not defined
// Nó phải được khai báo ở phạm vi toàn cục và trước khi được truy cập ở bất kỳ đâu.
// Lỗi này xảy ra khi trình duyệt yêu cầu /bot-api/status trước khi biến được gán giá trị
// HOẶC nếu nó bị reset về undefined do một lỗi khác.
// Khai báo ở đây sẽ đảm bảo nó luôn tồn tại với giá trị ban đầu là null.
let currentTradeDetails = null; 

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
    else { safeLog('warn', `Thiếu API Key/Secret hoặc cấu hình cho ${id.toUpperCase()}.`); }

    exchanges[id] = new exchangeClass(config);
});

// Hàm hỗ trợ
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Hàm để lấy dữ liệu từ server chính
async function fetchDataFromServer() {
    safeLog('log', `[BOT] 🔄 Đang lấy dữ liệu từ server chính: ${SERVER_DATA_URL}`);
    try {
        const response = await fetch(SERVER_DATA_URL);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        safeLog('log', `[BOT] ✅ Đã nhận dữ liệu từ server. Tổng số cơ hội arbitrage: ${data.arbitrageData.length}`);
        return data;
    } catch (error) {
        safeLog('error', `[BOT] ❌ Lỗi khi lấy dữ liệu từ server: ${error.message}`);
        return null;
    }
}

// Hàm cập nhật số dư từ các sàn
async function updateBalances() {
    safeLog('log', '[BOT] 🔄 Cập nhật số dư từ các sàn...');
    let currentTotalOverall = 0; 
    for (const id of Object.keys(exchanges)) {
        try {
            const exchange = exchanges[id];
            await exchange.loadMarkets(true);
            
            const accountBalance = await exchange.fetchBalance({ 'type': 'future' }); 
            // CCXT thường trả về balance âm dưới dạng số dư có thể do PnL chưa thực hiện bị lỗ hoặc tài sản vay
            // Để tính tổng tài sản hiện có (bao gồm cả số âm/lỗ), chúng ta sẽ dùng 'total' balance nếu có,
            // hoặc 'free' balance nếu 'total' không phản ánh đúng PnL.
            // Dựa trên yêu cầu, chúng ta sẽ sử dụng 'free' balance để tính tổng khả dụng
            // vì 'total' có thể bao gồm các khoản bị khóa hoặc PnL chưa thực hiện rất lớn.
            // Chúng ta muốn tổng khả dụng có thể âm để tính bù trừ.
            const usdtFreeBalance = accountBalance.free?.USDT || 0; 
            const usdtTotalBalance = accountBalance.total?.USDT || 0; 

            // Sử dụng usdtFreeBalance để tính available, cho phép nó âm
            balances[id].available = usdtFreeBalance; 
            balances[id].total = usdtTotalBalance; // Total vẫn có thể âm nếu PnL lỗ nặng

            balances[id].originalSymbol = {}; 

            currentTotalOverall += balances[id].available; // Cộng dồn tất cả available (bao gồm âm)

            safeLog('log', `[BOT] ✅ ${id.toUpperCase()} Balance: Total ${usdtTotalBalance.toFixed(2)} USDT, Available ${balances[id].available.toFixed(2)} USDT.`);
        } catch (e) {
            safeLog('error', `[BOT] ❌ Lỗi khi lấy số dư ${id.toUpperCase()}: ${e.message}`);
        }
    }
    balances.totalOverall = currentTotalOverall; // Cập nhật tổng khả dụng (có thể bao gồm âm)
    safeLog('log', `[BOT] Tổng số dư khả dụng trên tất cả các sàn (có thể bao gồm âm): ${currentTotalOverall.toFixed(2)} USDT.`);
    if (initialTotalBalance === 0) { 
        initialTotalBalance = currentTotalOverall;
    }
}


// Hàm chính để xử lý dữ liệu từ server và tìm cơ hội
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

    safeLog('log', '[BOT] --- Các cơ hội arbitrage hiện có (từ server) ---');
    // Log chỉ cơ hội hiển thị, không log hết tất cả các cơ hội ở đây để tránh spam log
    // Thay vào đó, chúng ta sẽ lưu tất cả vào `tempAllOpportunities` và sau đó hiển thị `bestForDisplay`
    
    serverData.arbitrageData.forEach(op => {
        const minutesUntilFunding = (op.nextFundingTime - now) / (1000 * 60);

        // Lọc cơ bản cho tất cả các cơ hội: PnL phải dương và funding time trong tương lai (không giới hạn 0-30 phút ở đây)
        if (op.estimatedPnl > 0 && minutesUntilFunding > 0) { 
            op.details.minutesUntilFunding = minutesUntilFunding; // Gắn thêm minutesUntilFunding vào op.details

            // Gán giá trị mặc định 'N/A' nếu các trường không tồn tại từ server
            op.details.shortFundingRate = op.details.shortFundingRate !== undefined ? op.details.shortFundingRate : 'N/A';
            op.details.longFundingRate = op.details.longFundingRate !== undefined ? op.details.longFundingRate : 'N/A';
            op.fundingDiff = op.fundingDiff !== undefined ? op.fundingDiff : 'N/A'; // fundingDiff có thể từ server
            op.commonLeverage = op.commonLeverage !== undefined ? op.commonLeverage : 'N/A';
            op.details.volume = op.details.volume !== undefined ? op.details.volume : 'N/A';
            
            tempAllOpportunities.push(op); 

            // Logic cho bestForDisplay: funding gần nhất, nếu bằng thì PnL cao nhất
            // Điều kiện này áp dụng cho BẢNG DỰ KIẾN (DISPLAY ONLY)
            if (!bestForDisplay ||
                minutesUntilFunding < bestForDisplay.details.minutesUntilFunding || // Closer funding takes precedence
                (minutesUntilFunding === bestForDisplay.details.minutesUntilFunding && op.estimatedPnl > bestForDisplay.estimatedPnl) 
            ) {
                bestForDisplay = op;
            }
        }
    });

    allCurrentOpportunities = tempAllOpportunities; // Cập nhật danh sách cơ hội toàn cục cho logic thực thi

    if (bestForDisplay) {
        bestPotentialOpportunityForDisplay = bestForDisplay;
        // Chỉ log duy nhất cơ hội tốt nhất để hiển thị
        safeLog('log', `[BOT] ✨ Cơ hội tốt nhất ĐỂ HIỂN THỊ (Gần funding nhất & PnL cao nhất):`);
        safeLog('log', `  Coin: ${bestForDisplay.coin}, Sàn: ${bestForDisplay.exchanges}, PnL ước tính: ${bestForDisplay.estimatedPnl.toFixed(2)}%, Funding trong: ${bestForDisplay.details.minutesUntilFunding.toFixed(1)} phút.`);
        safeLog('log', `  Dự kiến: Short: ${bestForDisplay.details.shortExchange}, Long: ${bestForDisplay.details.longExchange}, Volume ước tính: ${bestForDisplay.details.volume} USDT`);
        safeLog('log', `  Max Lev: ${bestForDisplay.commonLeverage}x, Short FR: ${bestForDisplay.details.shortFundingRate}, Long FR: ${bestForDisplay.details.longFundingRate}, Funding Diff: ${bestForDisplay.fundingDiff}`);
        safeLog('log', `  Tới giờ Funding: ${new Date(bestForDisplay.nextFundingTime).toLocaleTimeString('vi-VN')} ngày ${new Date(bestForDisplay.nextFundingTime).toLocaleDateString('vi-VN')}`);
        safeLog('log', `  TP/SL: (Cần cài đặt logic TP/SL của bạn)`);

    } else {
        bestPotentialOpportunityForDisplay = null;
        safeLog('log', '[BOT] 🔍 Không có cơ hội nào khả dụng để hiển thị (PnL dương, Funding trong tương lai).');
    }

    // currentSelectedOpportunityForExecution KHÔNG được set ở đây. Nó sẽ được set vào phút 50.
}

// Hàm quản lý và chuyển tiền giữa các sàn
// CẢNH BÁO QUAN TRỌNG: CHỨC NĂNG NÀY RẤT RỦI RO KHI DÙNG VỚI TIỀN THẬT. HÃY THỬ NGHIỆM CỰC KỲ KỸ LƯỠNG TRÊN TESTNET TRƯỚC!
async function manageFundsAndTransfer(opportunity, percentageToUse) {
    if (!opportunity || percentageToUse <= 0) {
        safeLog('warn', '[BOT_TRANSFER] Không có cơ hội hoặc phần trăm sử dụng không hợp lệ.');
        return false;
    }

    const [shortExchangeId, longExchangeId] = opportunity.exchanges.split(' / ').map(id => {
        return id.toLowerCase() === 'binance' ? 'binanceusdm' : id.toLowerCase(); 
    });

    safeLog('log', `[BOT_TRANSFER] Bắt đầu quản lý và chuyển tiền cho ${opportunity.coin} giữa ${shortExchangeId} và ${longExchangeId}.`);
    
    await updateBalances(); 

    // Chia đôi tổng số dư khả dụng (có thể bao gồm âm)
    const targetBalancePerExchange = balances.totalOverall / 2; 

    const involvedExchanges = [shortExchangeId, longExchangeId];
    const otherExchanges = Object.keys(exchanges).filter(id => !involvedExchanges.includes(id));

    let fundsTransferredSuccessfully = true;

    for (const sourceExchangeId of otherExchanges) {
        const sourceBalance = balances[sourceExchangeId].available;
        // Chỉ chuyển nếu số dư nguồn dương và đủ mức tối thiểu
        if (sourceBalance > 0 && sourceBalance >= FUND_TRANSFER_MIN_AMOUNT) { 
            let targetExchangeToFund = null;
            // Ưu tiên chuyển cho sàn thiếu nhiều hơn trong 2 sàn mục tiêu
            if (balances[shortExchangeId].available < targetBalancePerExchange && balances[longExchangeId].available < targetBalancePerExchange) {
                targetExchangeToFund = balances[shortExchangeId].available < balances[longExchangeId].available ? shortExchangeId : longExchangeId;
            } else if (balances[shortExchangeId].available < targetBalancePerExchange) {
                targetExchangeToFund = shortExchangeId;
            } else if (balances[longExchangeId].available < targetBalancePerExchange) {
                targetExchangeToFund = longExchangeId;
            }

            if (targetExchangeToFund) {
                // Số tiền cần chuyển để đạt mục tiêu (hoặc chuyển hết số dư nếu ít hơn)
                const amountNeededByTarget = targetBalancePerExchange - balances[targetExchangeToFund].available;
                const amountToTransfer = Math.max(0, Math.min(sourceBalance, amountNeededByTarget)); // Đảm bảo số tiền chuyển đi là dương
                
                if (amountToTransfer >= FUND_TRANSFER_MIN_AMOUNT) {
                    const depositAddress = usdtBep20DepositAddresses[targetExchangeToFund];

                    if (!depositAddress || depositAddress.startsWith('0xYOUR_')) { 
                        safeLog('error', `[BOT_TRANSFER] ❌ Thiếu hoặc chưa điền địa chỉ nạp tiền BEP20 THẬT SỰ cho ${targetExchangeToFund}. Vui lòng cập nhật balance.js`); 
                        fundsTransferredSuccessfully = false;
                        break; 
                    }

                    safeLog('log', `[BOT_TRANSFER] Đang cố gắng chuyển ${amountToTransfer.toFixed(2)} USDT từ ${sourceExchangeId} sang ${targetExchangeToFund} (${depositAddress}) qua BEP20...`);
                    try {
                        const withdrawResult = await exchanges[sourceExchangeId].withdraw(
                            'USDT',            
                            amountToTransfer,  
                            depositAddress,    
                            undefined,         
                            { network: BEP20_NETWORK_ID } 
                        );
                        safeLog('log', `[BOT_TRANSFER] ✅ Yêu cầu rút tiền hoàn tất từ ${sourceExchangeId} sang ${targetExchangeToFund}. ID giao dịch: ${withdrawResult.id}`);
                        
                        await sleep(60000); // Đợi 60 giây (1 phút) để giao dịch blockchain có thể được xác nhận
                    } catch (transferError) {
                        safeLog('error', `[BOT_TRANSFER] ❌ Lỗi khi chuyển tiền từ ${sourceExchangeId} sang ${targetExchangeToFund}: ${transferError.message}`);
                        fundsTransferredSuccessfully = false;
                        break; 
                    }
                    await updateBalances(); 
                }
            }
        }
    }

    if (!fundsTransferredSuccessfully) {
        safeLog('error', '[BOT_TRANSFER] Quá trình chuyển tiền không hoàn tất do lỗi. Hủy bỏ giao dịch.');
        return false;
    }

    // Kiểm tra lại số dư sau khi chuyển tiền (có thể chưa cập nhật kịp thời)
    // Nếu balance[id].available bị âm sau khi chuyển, điều này có thể do lỗi API hoặc sàn tự động điều chỉnh
    // Chúng ta vẫn sẽ cho phép nó đi tiếp nếu bot đã cố gắng cân bằng
    if (balances[shortExchangeId].available < targetBalancePerExchange * (percentageToUse / 100) ||
        balances[longExchangeId].available < targetBalancePerExchange * (percentageToUse / 100)) {
        safeLog('warn', '[BOT_TRANSFER] Cảnh báo: Số dư trên sàn mục tiêu có thể không đủ sau khi chuyển tiền hoặc chưa được cập nhật kịp thời. Tiếp tục với rủi ro.');
    }
    
    safeLog('log', `[BOT_TRANSFER] ✅ Quản lý tiền hoàn tất. ${shortExchangeId}: ${balances[shortExchangeId].available.toFixed(2)} USDT, ${longExchangeId}: ${balances[longExchangeId].available.toFixed(2)} USDT.`);
    return true;
}

// Hàm thực hiện mở lệnh
async function executeTrades(opportunity, percentageToUse) {
    if (!opportunity || percentageToUse <= 0) {
        safeLog('warn', '[BOT_TRADE] Không có cơ hội hoặc phần trăm sử dụng không hợp lệ.');
        return false;
    }

    const rawRatesData = serverDataGlobal?.rawRates; 
    if (!rawRatesData) {
        safeLog('error', '[BOT_TRADE] Dữ liệu giá thô từ server không có sẵn. Không thể mở lệnh.');
        return false;
    }

    const shortExchangeId = opportunity.details.shortExchange;
    const longExchangeId = opportunity.details.longExchange;
    const cleanedCoin = opportunity.coin;

    let shortOriginalSymbol, longOriginalSymbol;

    if (rawRatesData[shortExchangeId] && rawRatesData[shortExchangeId][cleanedCoin]) {
        shortOriginalSymbol = rawRatesData[shortExchangeId][cleanedCoin].symbol;
    } else {
        safeLog('error', `[BOT_TRADE] Không tìm thấy symbol gốc cho ${cleanedCoin} trên ${shortExchangeId}.`);
        return false;
    }

    if (rawRatesData[longExchangeId] && rawRatesData[longExchangeId][cleanedCoin]) {
        longOriginalSymbol = rawRatesData[longExchangeId][cleanedCoin].symbol;
    } else {
        safeLog('error', `[BOT_TRADE] Không tìm thấy symbol gốc cho ${cleanedCoin} trên ${longExchangeId}.`);
        return false;
    }

    const shortExchange = exchanges[shortExchangeId];
    const longExchange = exchanges[longExchangeId];

    const shortCollateral = balances[shortExchangeId].available * (percentageToUse / 100);
    const longCollateral = balances[longExchangeId].available * (percentageToUse / 100);

    // Kiểm tra số tiền mở lệnh phải dương
    if (shortCollateral <= 0 || longCollateral <= 0) {
        safeLog('error', '[BOT_TRADE] Số tiền mở lệnh (collateral) không hợp lệ (cần dương). Hủy bỏ lệnh.');
        return false;
    }

    safeLog('log', `[BOT_TRADE] Chuẩn bị mở lệnh cho ${cleanedCoin}:`);
    safeLog('log', `  SHORT ${shortExchangeId} (${shortOriginalSymbol}): ${shortCollateral.toFixed(2)} USDT collateral`);
    safeLog('log', `  LONG ${longExchangeId} (${longOriginalSymbol}): ${longCollateral.toFixed(2)} USDT collateral`);

    let tradeSuccess = true;
    let shortOrder = null, longOrder = null; 

    try {
        const tickerShort = await shortExchange.fetchTicker(shortOriginalSymbol);
        const tickerLong = await longExchange.fetchTicker(longOriginalSymbol);

        const shortEntryPrice = tickerShort.last; 
        const longEntryPrice = tickerLong.last; 

        if (!shortEntryPrice || !longEntryPrice) {
            safeLog('error', `[BOT_TRADE] Không lấy được giá thị trường hiện tại cho ${cleanedCoin}.`);
            return false;
        }

        const shortAmount = (shortCollateral * opportunity.commonLeverage) / shortEntryPrice;
        const longAmount = (longCollateral * opportunity.commonLeverage) / longEntryPrice;

        // Kiểm tra khối lượng hợp đồng phải dương
        if (shortAmount <= 0 || longAmount <= 0) {
            safeLog('error', '[BOT_TRADE] Lượng hợp đồng tính toán không hợp lệ (cần dương). Hủy bỏ lệnh.');
            return false;
        }

        // --- Mở lệnh Short ---
        safeLog('log', `[BOT_TRADE] Mở SHORT ${shortAmount.toFixed(opportunity.details.shortExchange === 'okx' ? 0 : 3)} ${cleanedCoin} trên ${shortExchangeId} với giá ${shortEntryPrice.toFixed(4)}...`);
        shortOrder = await shortExchange.createMarketSellOrder(shortOriginalSymbol, shortAmount);
        safeLog('log', `[BOT_TRADE] ✅ Lệnh SHORT ${shortExchangeId} khớp: ID ${shortOrder.id}, Amount ${shortOrder.amount}, Price ${shortOrder.price}`);

        // --- Mở lệnh Long ---
        safeLog('log', `[BOT_TRADE] Mở LONG ${longAmount.toFixed(opportunity.details.longExchange === 'okx' ? 0 : 3)} ${cleanedCoin} trên ${longExchangeId} với giá ${longEntryPrice.toFixed(4)}...`);
        longOrder = await longExchange.createMarketBuyOrder(longOriginalSymbol, longAmount);
        safeLog('log', `[BOT_TRADE] ✅ Lệnh LONG ${longExchangeId} khớp: ID ${longOrder.id}, Amount ${longOrder.amount}, Price ${longOrder.price}`);

        // Ghi log chi tiết khi gán currentTradeDetails
        safeLog('log', `[BOT_TRADE] Setting currentTradeDetails for ${cleanedCoin} on ${shortExchangeId}/${longExchangeId}`);
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
        safeLog('log', `[BOT_TRADE] currentTradeDetails set successfully.`);

    } catch (e) {
        safeLog('error', `[BOT_TRADE] ❌ Lỗi khi thực hiện giao dịch: ${e.message}`);
        tradeSuccess = false;
        if (shortOrder?.id) {
            try { await exchanges[shortExchangeId].cancelOrder(shortOrder.id, shortOriginalSymbol); } catch (ce) { safeLog('error', `[BOT_TRADE] Lỗi hủy lệnh SHORT: ${ce.message}`); }
        }
        if (longOrder?.id) {
            try { await exchanges[longExchangeId].cancelOrder(longOrder.id, longOriginalSymbol); } catch (ce) { safeLog('error', `[BOT_TRADE] Lỗi hủy lệnh LONG: ${ce.message}`); }
        }
    }
    return tradeSuccess;
}

// Hàm đóng lệnh và tính toán PnL
async function closeTradesAndCalculatePnL() {
    if (!currentTradeDetails || currentTradeDetails.status !== 'OPEN') {
        safeLog('log', '[BOT_PNL] Không có giao dịch nào đang mở để đóng.');
        return;
    }

    safeLog('log', '[BOT_PNL] 🔄 Đang đóng các vị thế và tính toán PnL...');
    const { coin, shortExchange, longExchange, shortOriginalSymbol, longOriginalSymbol, shortOrderAmount, longOrderAmount, shortCollateral, longCollateral } = currentTradeDetails;

    try {
        safeLog('log', `[BOT_PNL] Đóng vị thế SHORT ${coin} trên ${shortExchange} (amount: ${shortOrderAmount})...`);
        const closeShortOrder = await exchanges[shortExchange].createMarketBuyOrder(shortOriginalSymbol, shortOrderAmount);
        safeLog('log', `[BOT_PNL] ✅ Vị thế SHORT trên ${shortExchange} đã đóng. Order ID: ${closeShortOrder.id}`);

        safeLog('log', `[BOT_PNL] Đóng vị thế LONG ${coin} trên ${longExchange} (amount: ${longOrderAmount})...`);
        const closeLongOrder = await exchanges[longExchange].createMarketSellOrder(longOriginalSymbol, longOrderAmount);
        safeLog('log', `[BOT_PNL] ✅ Vị thế LONG trên ${longExchange} đã đóng. Order ID: ${closeLongOrder.id}`);

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
            fundingDiff: currentSelectedOpportunityForExecution?.fundingDiff, // Dùng currentSelectedOpportunityForExecution
            estimatedPnl: currentSelectedOpportunityForExecution?.estimatedPnl,
            actualPnl: parseFloat(cyclePnl.toFixed(2)), 
            timestamp: new Date().toISOString()
        });

        if (tradeHistory.length > 50) {
            tradeHistory.pop(); 
        }

        safeLog('log', `[BOT_PNL] ✅ Chu kỳ giao dịch cho ${coin} hoàn tất. PnL chu kỳ: ${cyclePnl.toFixed(2)} USD. Tổng PnL: ${cumulativePnl.toFixed(2)} USD.`);

    } catch (e) {
        safeLog('error', `[BOT_PNL] ❌ Lỗi khi đóng vị thế hoặc tính toán PnL: ${e.message}`);
    } finally {
        currentSelectedOpportunityForExecution = null; 
        safeLog('log', `[BOT] currentTradeDetails being reset to null.`);
        currentTradeDetails = null; 
        safeLog('log', '[BOT_PNL] Dọn dẹp lệnh chờ và vị thế đã đóng (nếu có).');
    }
}


let serverDataGlobal = null; 

// Vòng lặp chính của Bot
async function mainBotLoop() {
    // Luôn clearTimeout để tránh tạo nhiều vòng lặp nếu mainBotLoop được gọi nhiều lần
    if (botLoopIntervalId) clearTimeout(botLoopIntervalId); 

    if (botState !== 'RUNNING') {
        safeLog('log', '[BOT_LOOP] Bot không ở trạng thái RUNNING. Dừng vòng lặp.');
        return;
    }

    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentSecond = now.getUTCSeconds();
    
    const minuteAligned = Math.floor(now.getTime() / (60 * 1000)); 

    // Logic cập nhật dữ liệu từ server chính
    // Fetch dữ liệu mỗi DATA_FETCH_INTERVAL_SECONDS (5 giây) một lần.
    if (currentSecond % DATA_FETCH_INTERVAL_SECONDS === 0 && LAST_ACTION_TIMESTAMP.dataFetch !== currentSecond) {
        LAST_ACTION_TIMESTAMP.dataFetch = currentSecond; // Cập nhật thời gian fetch

        // Log rõ ràng hơn việc fetch dữ liệu
        if (currentMinute === HOURLY_FETCH_TIME_MINUTE && currentSecond < 5) {
            safeLog('log', `[BOT_LOOP] Kích hoạt cập nhật dữ liệu chính từ server (giờ funding HOURLY_FETCH_TIME_MINUTE).`);
        } else {
            safeLog('log', `[BOT_LOOP] Cập nhật dữ liệu từ server (mỗi ${DATA_FETCH_INTERVAL_SECONDS} giây).`);
        }
        
        const fetchedData = await fetchDataFromServer();
        if (fetchedData) {
            serverDataGlobal = fetchedData; 
            await processServerData(serverDataGlobal); 
        }
    }

    // Logic LỰA CHỌN CƠ HỘI ĐỂ THỰC THI (chỉ vào phút 50:00-50:04)
    // Đảm bảo chỉ chọn nếu bot đang chạy, chưa có giao dịch mở và chưa có cơ hội nào được chọn để thực thi
    if (currentMinute === 50 && currentSecond >= 0 && currentSecond < 5 && botState === 'RUNNING' && !currentTradeDetails && !currentSelectedOpportunityForExecution) {
        // Biến cờ để đảm bảo logic chọn và kích hoạt chỉ chạy 1 lần duy nhất tại giây 0-4 của phút 50
        if (LAST_ACTION_TIMESTAMP.selectionTime !== minuteAligned) {
            LAST_ACTION_TIMESTAMP.selectionTime = minuteAligned;

            safeLog('log', `[BOT_LOOP] 🌟 Kích hoạt lựa chọn cơ hội để THỰC HIỆN tại phút ${currentMinute}:${currentSecond} giây.`);
            
            let bestOpportunityFoundForExecution = null;
            // Duyệt qua tất cả các cơ hội đã fetch để tìm cái tốt nhất đủ điều kiện thực thi
            for (const op of allCurrentOpportunities) {
                const minutesUntilFunding = op.details.minutesUntilFunding; 

                // Kiểm tra TẤT CẢ các điều kiện thực thi
                if (op.estimatedPnl >= MIN_PNL_PERCENTAGE && 
                    minutesUntilFunding >= MIN_MINUTES_FOR_EXECUTION && 
                    minutesUntilFunding <= MAX_MINUTES_UNTIL_FUNDING) {
                    
                    if (!bestOpportunityFoundForExecution || op.estimatedPnl > bestOpportunityFoundForExecution.estimatedPnl) {
                        bestOpportunityFoundForExecution = op;
                    }
                }
            }

            if (bestOpportunityFoundForExecution) {
                currentSelectedOpportunityForExecution = bestOpportunityFoundForExecution; // Set biến toàn cục cho thực thi
                safeLog('log', `[BOT_LOOP] ✅ Bot đã chọn cơ hội: ${currentSelectedOpportunityForExecution.coin} trên ${currentSelectedOpportunityForExecution.exchanges} để THỰC HIỆN.`);
                safeLog('log', `  Thông tin chi tiết: PnL ước tính: ${currentSelectedOpportunityForExecution.estimatedPnl.toFixed(2)}%, Funding trong: ${currentSelectedOpportunityForExecution.details.minutesUntilFunding.toFixed(1)} phút.`);
                safeLog('log', `  Sàn Short: ${currentSelectedOpportunityForExecution.details.shortExchange}, Sàn Long: ${currentSelectedOpportunityForExecution.details.longExchange}`);
                safeLog('log', `  Volume ước tính: ${currentSelectedOpportunityForExecution.details.volume?.toFixed(2) || 'N/A'} USDT`);

                // Sau khi chọn, tiến hành chuyển tiền ngay lập tức
                botState = 'TRANSFERRING_FUNDS'; // Cập nhật trạng thái bot
                const transferSuccess = await manageFundsAndTransfer(currentSelectedOpportunityForExecution, 50); 
                if (transferSuccess) {
                    safeLog('log', '[BOT_LOOP] ✅ Chuyển tiền hoàn tất cho cơ hội đã chọn. Chờ mở lệnh.');
                } else {
                    safeLog('error', '[BOT_LOOP] ❌ Lỗi chuyển tiền hoặc không đủ số dư cho cơ hội đã chọn. Hủy chu kỳ này.');
                    currentSelectedOpportunityForExecution = null; // Hủy cơ hội nếu chuyển tiền thất bại
                }
                botState = 'RUNNING'; // Trở lại trạng thái chạy
            } else {
                safeLog('log', `[BOT_LOOP] 🔍 Không tìm thấy cơ hội nào đủ điều kiện để THỰC HIỆN tại phút ${currentMinute}.`);
                currentSelectedOpportunityForExecution = null; // Đảm bảo reset nếu không tìm thấy
            }
        }
    }


    // Thực hiện mở lệnh vào phút 59:55 (sử dụng currentSelectedOpportunityForExecution đã chọn từ phút 50)
    // Đảm bảo chỉ mở lệnh nếu đã có currentSelectedOpportunityForExecution VÀ chưa có trade nào đang mở
    if (currentMinute === 59 && currentSecond >= 55 && currentSecond < 59 && botState === 'RUNNING' && currentSelectedOpportunityForExecution && !currentTradeDetails) {
        // Biến cờ để đảm bảo logic mở lệnh chỉ chạy 1 lần duy nhất
        if (LAST_ACTION_TIMESTAMP.tradeExecution !== minuteAligned) {
            LAST_ACTION_TIMESTAMP.tradeExecution = minuteAligned;

            safeLog('log', `[BOT_LOOP] ⚡ Kích hoạt mở lệnh cho cơ hội ${currentSelectedOpportunityForExecution.coin} vào phút 59:55.`);
            botState = 'EXECUTING_TRADES';
            const tradeSuccess = await executeTrades(currentSelectedOpportunityForExecution, 50); 
            if (tradeSuccess) {
                safeLog('log', '[BOT_LOOP] ✅ Mở lệnh hoàn tất.');
            } else {
                safeLog('error', '[BOT_LOOP] ❌ Lỗi mở lệnh. Hủy chu kỳ này.');
                // Hủy cơ hội và reset trade details nếu mở lệnh thất bại
                currentSelectedOpportunityForExecution = null; 
                currentTradeDetails = null; 
            }
            botState = 'RUNNING'; 
        }
    }
    
    // Đóng lệnh và tính PnL sau giờ funding (phút 00:05 của giờ tiếp theo)
    if (currentMinute === 0 && currentSecond >= 5 && currentSecond < 10 && botState === 'RUNNING' && currentTradeDetails?.status === 'OPEN') {
        // Biến cờ để đảm bảo logic đóng lệnh chỉ chạy 1 lần duy nhất
        if (LAST_ACTION_TIMESTAMP.closeTrade !== minuteAligned) {
            LAST_ACTION_TIMESTAMP.closeTrade = minuteAligned;

            safeLog('log', '[BOT_LOOP] 🛑 Kích hoạt đóng lệnh và tính PnL vào phút 00:05.');
            botState = 'CLOSING_TRADES';
            await closeTradesAndCalculatePnL();
            botState = 'RUNNING'; 
        }
    }

    // Lặp lại sau 1 giây để kiểm tra thời gian chính xác
    botLoopIntervalId = setTimeout(mainBotLoop, 1000); 
}

// ----- CÁC HÀM ĐIỀU KHIỂN BOT TỪ UI -----
function startBot() {
    if (botState === 'STOPPED') {
        safeLog('log', '[BOT] ▶️ Khởi động Bot...');
        botState = 'RUNNING';
        // Khởi tạo số dư ban đầu và sau đó bắt đầu vòng lặp chính
        updateBalances().then(() => {
            safeLog('log', '[BOT] Đã cập nhật số dư ban đầu. Bắt đầu vòng lặp bot.');
            mainBotLoop(); 
        }).catch(err => {
            safeLog('error', `[BOT] Lỗi khi khởi tạo số dư ban đầu: ${err.message}`);
            botState = 'STOPPED'; // Dừng bot nếu lỗi khởi tạo
        });
        return true;
    }
    safeLog('warn', '[BOT] Bot đã chạy hoặc đang trong quá trình chuyển trạng thái.');
    return false;
}

function stopBot() {
    if (botState === 'RUNNING' || botState === 'FETCHING_DATA' || botState === 'PROCESSING_DATA' || botState === 'TRANSFERRING_FUNDS' || botState === 'EXECUTING_TRADES' || botState === 'CLOSING_TRADES') {
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

// ----- KHỞI TẠO SERVER HTTP CHO BOT UI -----
const botServer = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            if (err) {
                safeLog('error', '[BOT_SERVER] ❌ Lỗi khi đọc index.html:', err.message);
                res.writeHead(500);
                res.end('Lỗi khi đọc index.html');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
            res.end(content);
        });
    } else if (req.url === '/bot-api/status' && req.method === 'GET') {
        // Đây là điểm lỗi ReferenceError trong log của bạn.
        // Tôi đã thêm một kiểm tra cực kỳ mạnh mẽ để đảm bảo currentTradeDetails được truy cập an toàn.
        let displayCurrentTradeDetails = null;
        try {
            // Kiểm tra typeof trước để tránh lỗi khi biến không được định nghĩa (mặc dù nó phải được)
            if (typeof currentTradeDetails !== 'undefined' && currentTradeDetails !== null && typeof currentTradeDetails === 'object') {
                displayCurrentTradeDetails = currentTradeDetails;
            } else {
                // Log cảnh báo nếu biến không ở trạng thái mong muốn, nhưng vẫn cho phép hoạt động
                safeLog('warn', `[BOT_SERVER] currentTradeDetails is not a valid object or is null (${typeof currentTradeDetails}). Sending as null.`);
                displayCurrentTradeDetails = null;
            }
        } catch (e) {
            // Trường hợp cực đoan nếu truy cập biến gây lỗi (rất hiếm khi xảy ra với 'let')
            safeLog('error', `[BOT_SERVER] CRITICAL EXCEPTION accessing currentTradeDetails for status API: ${e.message}. Setting to null.`);
            displayCurrentTradeDetails = null;
        }

        const statusData = {
            botState: botState,
            balances: balances,
            initialTotalBalance: initialTotalBalance,
            cumulativePnl: cumulativePnl,
            tradeHistory: tradeHistory,
            currentSelectedOpportunity: bestPotentialOpportunityForDisplay, // Dành cho UI hiển thị
            currentTradeDetails: displayCurrentTradeDetails // Trade đang mở (đã có kiểm tra an toàn)
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
                safeLog('error', '[BOT_SERVER] ❌ Lỗi xử lý POST /bot-api/start:', error.message);
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
    safeLog('log', `✅ Máy chủ UI của Bot đang chạy tại http://localhost:${BOT_PORT}`);
    safeLog('log', 'Bot đang chờ lệnh "Start" từ giao diện HTML.');
});
