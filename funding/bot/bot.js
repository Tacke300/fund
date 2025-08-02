// bot.js - Phiên bản hoàn chỉnh

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
        process.stderr.write(`FATAL LOG ERROR (safeLog itself failed): ${e.message} - Original log: [${type.toUpperCase()}] ${args.join(' ')}\n`);
    }
};

// Import các API Key và Secret từ file config.js
const {
    binanceApiKey, binanceApiSecret,
    bingxApiKey, bingxApiSecret,
    okxApiKey, okxApiSecret, okxPassword,
    bitgetApiKey, bitgetApiSecret, bitgetApiPassword
} = require('../config.js'); 

// THAY ĐỔI: Import cấu hình địa chỉ nạp tiền và mạng rút tiền ưu tiên
const { usdtDepositAddressesByNetwork, preferredWithdrawalNetworks } = require('./balance.js'); 

const BOT_PORT = 5006; // Cổng cho Bot UI (khác với cổng của Server chính)
const SERVER_DATA_URL = 'http://localhost:5005/api/data'; // Địa chỉ Server chính

// ----- CẤU HÌNH BOT -----
const MIN_PNL_PERCENTAGE = 7; // %PnL tối thiểu để bot xem xét
const MAX_MINUTES_UNTIL_FUNDING = 30; // Trong vòng 30 phút tới sẽ tới giờ funding (để bot tìm cơ hội)
const MIN_MINUTES_FOR_EXECUTION = 15; // Phải còn ít nhất 15 phút tới funding để bot xem xét thực hiện
const FUND_TRANSFER_MIN_AMOUNT = 10; // Số tiền tối thiểu cho mỗi lần chuyển tiền qua BEP20 (Giá trị này giờ mang tính tổng quát)

const DATA_FETCH_INTERVAL_SECONDS = 5; // Cập nhật dữ liệu mỗi 5 giây
const HOURLY_FETCH_TIME_MINUTE = 45; // Mỗi giờ vào phút thứ 45, bot lấy dữ liệu chính

// CẤU HÌNH TP/SL (Tính theo % vốn bỏ ra - collateral)
const SL_PERCENT_OF_COLLATERAL = 700; // 700% mất vốn ban đầu (collateral)
const TP_PERCENT_OF_COLLATERAL = 8386; // 8386% lợi nhuận trên vốn ban đầu (collateral)


// ----- BIẾN TOÀN CỤC CHO BOT -----
let botState = 'STOPPED'; 
let botLoopIntervalId = null;

let balances = {
    binanceusdm: { total: 0, available: 0, originalSymbol: {} },
    bingx: { total: 0, available: 0, originalSymbol: {} },
    okx: { total: 0, available: 0, originalSymbol: {} },
    bitget: { total: 0, available: 0, originalSymbol: {} },
    totalOverall: 0 // Tổng số dư khả dụng (free) trên tất cả các sàn (có thể bao gồm số âm)
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
    dataFetch: 0, 
    selectionTime: 0, 
    tradeExecution: 0, 
    closeTrade: 0, 
};

// Khai báo currentTradeDetails để đảm bảo nó luôn tồn tại với giá trị ban đầu là null.
let currentTradeDetails = null; 

// LƯU TRỮ % VỐN MỞ LỆNH TỪ UI
let currentPercentageToUse = 50; // Mặc định 50% nếu UI không gửi

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

// SỬA ĐỔI: Hàm hỗ trợ để lấy địa chỉ nạp tiền và mạng lưới phù hợp
// Hàm này giờ nhận vào `fromExchangeId` (để xác định mạng rút) và `toExchangeId` (để lấy địa chỉ nạp)
function getTargetDepositInfo(fromExchangeId, toExchangeId) {
    // Lấy mạng rút tiền mà sàn GỬI ưu tiên sử dụng
    const withdrawalNetwork = preferredWithdrawalNetworks[fromExchangeId];
    if (!withdrawalNetwork) {
        safeLog('error', `[HELPER] Không tìm thấy mạng rút tiền ưu tiên cho sàn gửi ${fromExchangeId.toUpperCase()}. Vui lòng kiểm tra preferredWithdrawalNetworks trong balance.js`);
        return null;
    }

    // Dựa trên mạng rút tiền của sàn gửi, tìm địa chỉ nạp tương ứng trên sàn nhận
    const depositAddress = usdtDepositAddressesByNetwork[toExchangeId]?.[withdrawalNetwork];
    
    // THAY ĐỔI: Kiểm tra chặt chẽ hơn nếu địa chỉ nạp không tồn tại cho mạng đó
    if (!depositAddress || depositAddress.startsWith('0xYOUR_')) {
        safeLog('error', `[HELPER] Thiếu hoặc chưa điền địa chỉ nạp tiền USDT cho mạng "${withdrawalNetwork}" của sàn nhận ${toExchangeId.toUpperCase()} trong balance.js. HOẶC sàn nhận không hỗ trợ mạng mà sàn gửi ưu tiên.`);
        return null;
    }
    return { network: withdrawalNetwork, address: depositAddress };
}


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
            const usdtFreeBalance = accountBalance.free?.USDT || 0; 
            const usdtTotalBalance = accountBalance.total?.USDT || 0; 

            // Sử dụng usdtFreeBalance để tính available, cho phép nó âm
            balances[id].available = usdtFreeBalance; 
            balances[id].total = usdtTotalBalance; 

            // originalSymbol ở đây không được sử dụng nhưng giữ nguyên nếu bạn có kế hoạch dùng
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

    safeLog('log', '[BOT] --- Bắt đầu tìm kiếm cơ hội arbitrage ---');
    
    serverData.arbitrageData.forEach(op => {
        const minutesUntilFunding = (op.nextFundingTime - now) / (1000 * 60);

        // Lọc cơ bản cho tất cả các cơ hội: PnL phải dương và funding time trong tương lai
        if (op.estimatedPnl > 0 && minutesUntilFunding > 0) { 
            op.details.minutesUntilFunding = minutesUntilFunding; // Gắn thêm minutesUntilFunding vào op.details

            // SỬA LỖI TÊN BIẾN FUNDING RATE TỪ SERVER: shortRate -> shortFundingRate, longRate -> longFundingRate
            op.details.shortFundingRate = op.details.shortRate !== undefined ? op.details.shortRate : 'N/A';
            op.details.longFundingRate = op.details.longRate !== undefined ? op.details.longRate : 'N/A';
            op.fundingDiff = op.fundingDiff !== undefined ? op.fundingDiff : 'N/A'; 
            op.commonLeverage = op.commonLeverage !== undefined ? op.commonLeverage : 'N/A';
            // BỎ DÒNG NÀY: op.details.volume = op.details.volume !== undefined ? op.details.volume : 'N/A'; 
            // -> Volume ước tính sẽ được bot tính và hiển thị là "Vốn dự kiến"

            // XÁC ĐỊNH LONG/SHORT EXCHANGE DỰA TRÊN FUNDING RATES (CAO = SHORT, THẤP = LONG)
            let shortExId = op.details.shortExchange; // Tên sàn Short mặc định từ server
            let longExId = op.details.longExchange;   // Tên sàn Long mặc định từ server

            // Chỉ thực hiện logic đảo nếu cả hai funding rate đều là số hợp lệ
            if (typeof op.details.shortFundingRate === 'number' && typeof op.details.longFundingRate === 'number') {
                if (op.details.shortFundingRate < op.details.longFundingRate) { // Nếu Short FR < Long FR, đảo vai trò
                    safeLog('log', `[BOT] Đảo sàn Long/Short cho ${op.coin}: Short FR (${op.details.shortFundingRate}) < Long FR (${op.details.longFundingRate}).`);
                    shortExId = op.details.longExchange; // Sàn có FR cao hơn (là Long ban đầu) giờ thành Short
                    longExId = op.details.shortExchange; // Sàn có FR thấp hơn (là Short ban đầu) giờ thành Long
                }
            }
            op.details.shortExchange = shortExId;
            op.details.longExchange = longExId;

            tempAllOpportunities.push(op); 

            // Logic cho bestForDisplay: funding gần nhất, nếu bằng thì PnL cao nhất
            if (!bestForDisplay ||
                minutesUntilFunding < bestForDisplay.details.minutesUntilFunding || 
                (minutesUntilFunding === bestForDisplay.details.minutesUntilFunding && op.estimatedPnl > bestForDisplay.estimatedPnl) 
            ) {
                bestForDisplay = op;
            }
        }
    });

    allCurrentOpportunities = tempAllOpportunities; // Cập nhật danh sách cơ hội toàn cục cho logic thực thi

    if (bestForDisplay) {
        bestPotentialOpportunityForDisplay = bestForDisplay;
        // Thêm estimatedTradeCollateral vào bestPotentialOpportunityForDisplay
        // Đây là tổng số vốn sẽ được dùng cho cả 2 lệnh (Short và Long)
        // Cần đảm bảo balances.totalOverall đã được cập nhật trước đó
        bestPotentialOpportunityForDisplay.estimatedTradeCollateral = (balances.totalOverall * (currentPercentageToUse / 100)).toFixed(2);

        // Chỉ log duy nhất cơ hội tốt nhất để hiển thị (tinh gọn log)
        safeLog('log', `[BOT] ✨ Cơ hội tốt nhất ĐỂ HIỂN THỊ (Gần funding nhất & PnL cao nhất):`);
        safeLog('log', `  Coin: ${bestForDisplay.coin}, Sàn: ${bestForDisplay.exchanges}, PnL ước tính: ${bestForDisplay.estimatedPnl.toFixed(2)}%, Funding trong: ${bestForDisplay.details.minutesUntilFunding.toFixed(1)} phút.`);
        safeLog('log', `  Dự kiến: Short: ${bestForDisplay.details.shortExchange}, Long: ${bestForDisplay.details.longExchange}, Vốn dự kiến: ${bestPotentialOpportunityForDisplay.estimatedTradeCollateral} USDT`); // Đổi từ Volume ước tính sang Vốn dự kiến
        safeLog('log', `  Max Lev: ${bestForDisplay.commonLeverage}x, Short FR: ${bestForDisplay.details.shortFundingRate}, Long FR: ${bestForDisplay.details.longFundingRate}, Chênh lệch Funding: ${bestForDisplay.fundingDiff}`);
        safeLog('log', `  Tới giờ Funding: ${new Date(bestForDisplay.nextFundingTime).toLocaleTimeString('vi-VN')} ngày ${new Date(bestForDisplay.nextFundingTime).toLocaleDateString('vi-VN')}`);
        safeLog('log', `  TP/SL: (Sẽ được đặt sau 2s khi mở lệnh với % vốn: TP ${TP_PERCENT_OF_COLLATERAL}%, SL ${SL_PERCENT_OF_COLLATERAL}%)`); // Cập nhật thông báo

    } else {
        bestPotentialOpportunityForDisplay = null;
        safeLog('log', '[BOT] 🔍 Không có cơ hội nào khả dụng để hiển thị (PnL dương, Funding trong tương lai).');
    }

    // currentSelectedOpportunityForExecution KHÔNG được set ở đây. Nó sẽ được set vào phút 50.
}

// Hàm quản lý và chuyển tiền giữa các sàn (Tùy chỉnh theo logic COLLATERAL MỚI)
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

    // Tính toán số vốn CỐ ĐỊNH sẽ dùng cho mỗi bên (collateral per side)
    const baseCollateralPerSide = (balances.totalOverall / 2) * (currentPercentageToUse / 100);
    safeLog('log', `[BOT_TRANSFER] Vốn mục tiêu cho mỗi bên (collateral) là: ${baseCollateralPerSide.toFixed(2)} USDT.`);

    const involvedExchanges = [shortExchangeId, longExchangeId];
    const otherExchanges = Object.keys(exchanges).filter(id => !involvedExchanges.includes(id));

    let fundsTransferredSuccessfully = true;

    // Logic chuyển tiền từ các sàn khác sang sàn mục tiêu nếu thiếu
    for (const sourceExchangeId of otherExchanges) {
        const sourceBalance = balances[sourceExchangeId].available;
        if (sourceBalance > 0 && sourceBalance >= FUND_TRANSFER_MIN_AMOUNT) { 
            let targetExchangeToFund = null;
            // Ưu tiên chuyển cho sàn thiếu nhiều hơn trong 2 sàn mục tiêu (để đạt được baseCollateralPerSide)
            if (balances[shortExchangeId].available < baseCollateralPerSide && balances[longExchangeId].available < baseCollateralPerSide) {
                targetExchangeToFund = balances[shortExchangeId].available < balances[longExchangeId].available ? shortExchangeId : longExchangeId;
            } else if (balances[shortExchangeId].available < baseCollateralPerSide) {
                targetExchangeToFund = shortExchangeId;
            } else if (balances[longExchangeId].available < baseCollateralPerSide) {
                targetExchangeToFund = longExchangeId;
            }

            if (targetExchangeToFund) {
                const amountNeededByTarget = baseCollateralPerSide - balances[targetExchangeToFund].available;
                const amountToTransfer = Math.max(0, Math.min(sourceBalance, amountNeededByTarget)); 
                
                if (amountToTransfer >= FUND_TRANSFER_MIN_AMOUNT) {
                    // THAY ĐỔI: Sử dụng hàm getTargetDepositInfo để lấy địa chỉ và mạng
                    const targetDepositInfo = getTargetDepositInfo(sourceExchangeId, targetExchangeToFund);
                    if (!targetDepositInfo) {
                        // getTargetDepositInfo đã log lỗi, chỉ cần dừng quá trình chuyển
                        fundsTransferredSuccessfully = false;
                        break; 
                    }
                    const { network: withdrawalNetwork, address: depositAddress } = targetDepositInfo;

                    safeLog('log', `[BOT_TRANSFER] Đang cố gắng chuyển ${amountToTransfer.toFixed(2)} USDT từ ${sourceExchangeId} sang ${targetExchangeToFund} (${depositAddress}) qua mạng ${withdrawalNetwork}...`);
                    try {
                        const withdrawResult = await exchanges[sourceExchangeId].withdraw(
                            'USDT', amountToTransfer, depositAddress, undefined, { network: withdrawalNetwork } 
                        );
                        safeLog('log', `[BOT_TRANSFER] ✅ Yêu cầu rút tiền hoàn tất từ ${sourceExchangeId} sang ${targetExchangeToFund}. ID giao dịch: ${withdrawResult.id}`);
                        
                        // THÊM MỚI: Đợi tiền về ví Spot và chuyển vào Futures
                        safeLog('log', `[BOT_TRANSFER] Đợi 90 giây để tiền về ví Spot trên ${targetExchangeToFund} trước khi chuyển vào Futures...`);
                        await sleep(90000); // Đợi 90 giây (1.5 phút) để giao dịch blockchain có thể được xác nhận và về ví Spot

                        // THÊM MỚI: Thực hiện chuyển từ Spot sang Futures
                        try {
                            // Cần kiểm tra lại số dư Spot trên sàn nhận trước khi chuyển
                            const targetExchangeBalance = await exchanges[targetExchangeToFund].fetchBalance();
                            const usdtSpotBalance = targetExchangeBalance.spot?.free?.USDT || 0;

                            if (usdtSpotBalance >= amountToTransfer) { // Chỉ chuyển nếu tiền đã về đủ Spot
                                safeLog('log', `[BOT_TRANSFER] Đang chuyển ${amountToTransfer.toFixed(2)} USDT từ ví Spot sang ví Futures trên ${targetExchangeToFund}...`);
                                await exchanges[targetExchangeToFund].transfer(
                                    'USDT', amountToTransfer, 'spot', 'future'
                                );
                                safeLog('log', `[BOT_TRANSFER] ✅ Đã chuyển ${amountToTransfer.toFixed(2)} USDT từ Spot sang Futures trên ${targetExchangeToFund}.`);
                            } else {
                                safeLog('warn', `[BOT_TRANSFER] Cảnh báo: Số dư Spot trên ${targetExchangeToFund} (${usdtSpotBalance.toFixed(2)} USDT) chưa đủ để chuyển ${amountToTransfer.toFixed(2)} USDT vào Futures. Tiền có thể chưa về kịp. Đánh dấu chuyển tiền thành công một phần.`);
                                // fundsTransferredSuccessfully vẫn là true nếu rút tiền thành công,
                                // nhưng sẽ cảnh báo rằng internal transfer có thể chưa hoàn tất.
                            }
                        } catch (internalTransferError) {
                            safeLog('error', `[BOT_TRANSFER] ❌ Lỗi khi chuyển tiền từ Spot sang Futures trên ${targetExchangeToFund}: ${internalTransferError.message}. Tiền có thể vẫn nằm ở ví Spot.`);
                            fundsTransferredSuccessfully = false; // Đánh dấu thất bại nếu internal transfer thất bại
                            break; 
                        }

                    } catch (transferError) {
                        safeLog('error', `[BOT_TRANSFER] ❌ Lỗi khi rút tiền từ ${sourceExchangeId} sang ${targetExchangeToFund}: ${transferError.message}`);
                        fundsTransferredSuccessfully = false;
                        break; 
                    }
                    await updateBalances(); // Cập nhật số dư sau mỗi lần chuyển (bao gồm internal transfer)
                }
            }
        }
    }

    if (!fundsTransferredSuccessfully) {
        safeLog('error', '[BOT_TRANSFER] Quá trình chuyển tiền không hoàn tất do lỗi. Hủy bỏ giao dịch.');
        return false;
    }

    // Kiểm tra lại số dư sau khi chuyển tiền.
    // Đảm bảo số dư trên sàn mục tiêu đủ để mở lệnh với baseCollateralPerSide
    if (balances[shortExchangeId].available < baseCollateralPerSide || balances[longExchangeId].available < baseCollateralPerSide) {
        safeLog('warn', `[BOT_TRANSFER] Cảnh báo: Số dư trên sàn mục tiêu (${shortExchangeId}: ${balances[shortExchangeId].available.toFixed(2)}, ${longExchangeId}: ${balances[longExchangeId].available.toFixed(2)}) có thể không đủ để mở lệnh với vốn ${baseCollateralPerSide.toFixed(2)} USDT mỗi bên. Có thể chưa được cập nhật kịp thời hoặc thiếu vốn tổng. Tiếp tục với rủi ro.`);
    }
    
    safeLog('log', `[BOT_TRANSFER] ✅ Quản lý tiền hoàn tất. ${shortExchangeId}: ${balances[shortExchangeId].available.toFixed(2)} USDT, ${longExchangeId}: ${balances[longExchangeId].available.toFixed(2)} USDT.`);
    return true;
}

// Hàm thực hiện mở lệnh và đặt TP/SL
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

    // Lấy originalSymbol từ rawRatesData được gửi từ server
    if (rawRatesData[shortExchangeId] && rawRatesData[shortExchangeId].rates && rawRatesData[shortExchangeId].rates[cleanedCoin]) {
        shortOriginalSymbol = rawRatesData[shortExchangeId].rates[cleanedCoin].originalSymbol;
    } else {
        safeLog('error', `[BOT_TRADE] Không tìm thấy originalSymbol cho ${cleanedCoin} trên ${shortExchangeId}.`);
        return false;
    }

    if (rawRatesData[longExchangeId] && rawRatesData[longExchangeId].rates && rawRatesData[longExchangeId].rates[cleanedCoin]) {
        longOriginalSymbol = rawRatesData[longExchangeId].rates[cleanedCoin].originalSymbol;
    } else {
        safeLog('error', `[BOT_TRADE] Không tìm thấy originalSymbol cho ${cleanedCoin} trên ${longExchangeId}.`);
        return false;
    }

    const shortExchange = exchanges[shortExchangeId];
    const longExchange = exchanges[longExchangeId];

    // TÍNH TOÁN VỐN MỞ LỆNH (COLLATERAL) THEO YÊU CẦU MỚI: TỔNG BALANCE / 2 * %
    // Đảm bảo balances.totalOverall đã được cập nhật trước khi gọi hàm này
    const baseCollateralPerSide = (balances.totalOverall / 2) * (currentPercentageToUse / 100);

    const shortCollateral = baseCollateralPerSide;
    const longCollateral = baseCollateralPerSide;

    // Kiểm tra số tiền mở lệnh phải dương và đủ so với số dư khả dụng
    if (shortCollateral <= 0 || longCollateral <= 0) {
        safeLog('error', '[BOT_TRADE] Số tiền mở lệnh (collateral) không hợp lệ (cần dương). Hủy bỏ lệnh.');
        return false;
    }
    if (balances[shortExchangeId].available < shortCollateral || balances[longExchangeId].available < longCollateral) {
        safeLog('error', `[BOT_TRADE] Số dư khả dụng không đủ để mở lệnh với vốn ${baseCollateralPerSide.toFixed(2)} USDT mỗi bên. ${shortExchangeId}: ${balances[shortExchangeId].available.toFixed(2)}, ${longExchangeId}: ${balances[longExchangeId].available.toFixed(2)}. Hủy bỏ lệnh.`);
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

        const commonLeverage = opportunity.commonLeverage || 1; // Mặc định leverage là 1 nếu server không trả về
        
        // Tính toán lượng hợp đồng (amount) dựa trên collateral, leverage và entry price
        // (collateral * commonLeverage) là Notional Value của vị thế
        const shortAmount = (shortCollateral * commonLeverage) / shortEntryPrice;
        const longAmount = (longCollateral * commonLeverage) / longEntryPrice;

        // Kiểm tra khối lượng hợp đồng phải dương
        if (shortAmount <= 0 || longAmount <= 0) {
            safeLog('error', '[BOT_TRADE] Lượng hợp đồng tính toán không hợp lệ (cần dương). Hủy bỏ lệnh.');
            return false;
        }

        // --- Mở lệnh Short ---
        // Làm tròn amount cho Bitget và OKX có thể khác các sàn khác
        const shortAmountFormatted = shortExchangeId === 'okx' || shortExchangeId === 'bitget' ? shortAmount.toFixed(0) : shortAmount.toFixed(3);
        safeLog('log', `[BOT_TRADE] Mở SHORT ${shortAmountFormatted} ${cleanedCoin} trên ${shortExchangeId} với giá ${shortEntryPrice.toFixed(4)}...`);
        shortOrder = await shortExchange.createMarketSellOrder(shortOriginalSymbol, parseFloat(shortAmountFormatted));
        safeLog('log', `[BOT_TRADE] ✅ Lệnh SHORT ${shortExchangeId} khớp: ID ${shortOrder.id}, Amount ${shortOrder.amount}, Price ${shortOrder.price}`);

        // --- Mở lệnh Long ---
        const longAmountFormatted = longExchangeId === 'okx' || longExchangeId === 'bitget' ? longAmount.toFixed(0) : longAmount.toFixed(3);
        safeLog('log', `[BOT_TRADE] Mở LONG ${longAmountFormatted} ${cleanedCoin} trên ${longExchangeId} với giá ${longEntryPrice.toFixed(4)}...`);
        longOrder = await longExchange.createMarketBuyOrder(longOriginalSymbol, parseFloat(longAmountFormatted));
        safeLog('log', `[BOT_TRADE] ✅ Lệnh LONG ${longExchangeId} khớp: ID ${longOrder.id}, Amount ${longOrder.amount}, Price ${longOrder.price}`);
        
        // Cập nhật currentTradeDetails ngay sau khi mở lệnh chính
        safeLog('log', `[BOT_TRADE] Setting currentTradeDetails for ${cleanedCoin} on ${shortExchangeId}/${longExchangeId}`);
        currentTradeDetails = {
            coin: cleanedCoin,
            shortExchange: shortExchangeId,
            longExchange: longExchangeId,
            shortOriginalSymbol: shortOriginalSymbol, 
            longOriginalSymbol: longOriginalSymbol,   
            shortOrderId: shortOrder.id,
            longOrderId: longOrder.id,
            shortOrderAmount: shortOrder.amount, // Lượng đã khớp
            longOrderAmount: longOrder.amount,   // Lượng đã khớp
            shortEntryPrice: shortEntryPrice,
            longEntryPrice: longEntryPrice,
            shortCollateral: shortCollateral, // Vốn thực tế sử dụng
            longCollateral: longCollateral,   // Vốn thực tế sử dụng
            commonLeverage: commonLeverage, // Lưu leverage đã dùng để tính TP/SL
            status: 'OPEN',
            openTime: Date.now()
        };
        safeLog('log', `[BOT_TRADE] currentTradeDetails set successfully.`);

        // ĐẶT LỆNH TP/SL SAU 2 GIÂY
        safeLog('log', '[BOT_TRADE] Đợi 2 giây để gửi lệnh TP/SL...');
        await sleep(2000); // Đợi 2 giây

        // TÍNH TOÁN VÀ GỬI LỆNH TP/SL LÊN SÀN
        // PnL_USD = collateral * (Percentage / 100)
        // Giá TP/SL = EntryPrice * (1 +/- (TargetPnL_USD / (Amount * EntryPrice))) = EntryPrice * (1 +/- (TargetPnL_USD / NotionalValue))
        // Hoặc đơn giản hơn: Giá TP/SL = EntryPrice * (1 +/- (Percentage / (Leverage * 100)))
        const shortTpPrice = shortEntryPrice * (1 - (TP_PERCENT_OF_COLLATERAL / (commonLeverage * 100))); // Short TP khi giá giảm
        const shortSlPrice = shortEntryPrice * (1 + (SL_PERCENT_OF_COLLATERAL / (commonLeverage * 100))); // Short SL khi giá tăng

        const longTpPrice = longEntryPrice * (1 + (TP_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));   // Long TP khi giá tăng
        const longSlPrice = longEntryPrice * (1 - (SL_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));   // Long SL khi giá giảm

        safeLog('log', `[BOT_TRADE] Tính toán TP/SL cho ${cleanedCoin}:`);
        safeLog('log', `  Short Entry: ${shortEntryPrice.toFixed(4)}, SL: ${shortSlPrice.toFixed(4)}, TP: ${shortTpPrice.toFixed(4)}`);
        safeLog('log', `  Long Entry: ${longEntryPrice.toFixed(4)}, SL: ${longSlPrice.toFixed(4)}, TP: ${longTpPrice.toFixed(4)}`);

        // Lưu TP/SL đã tính vào currentTradeDetails (chỉ để tham chiếu)
        currentTradeDetails.shortSlPrice = shortSlPrice; 
        currentTradeDetails.shortTpPrice = shortTpPrice;
        currentTradeDetails.longSlPrice = longSlPrice;
        currentTradeDetails.longTpPrice = longTpPrice;

        // Gửi lệnh TP/SL lên sàn
        // LƯU Ý: Mỗi sàn có thể có cách triển khai TP/SL hơi khác nhau về tham số.
        // Đây là ví dụ chung, bạn cần kiểm tra lại tài liệu CCXT cho từng sàn cụ thể hoặc API của sàn.
        // Binance, OKX, Bitget thường dùng 'STOP_MARKET' hoặc 'TAKE_PROFIT_MARKET' với 'stopPrice'
        
        try {
            // Lệnh Stop Loss cho vị thế SHORT (mua lại khi giá tăng)
            await shortExchange.createOrder(
                shortOriginalSymbol,
                'STOP_MARKET', // hoặc 'STOP_LOSS_MARKET' tùy sàn
                'buy',         // Đóng vị thế Short bằng lệnh Buy
                shortOrder.amount,
                undefined,
                { 'stopPrice': shortSlPrice }
            );
            safeLog('log', `[BOT_TRADE] ✅ Đặt SL cho SHORT ${shortExchangeId} thành công.`);
        } catch (slShortError) {
            safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt SL cho SHORT ${shortExchangeId}: ${slShortError.message}`);
        }

        try {
            // Lệnh Take Profit cho vị thế SHORT (mua lại khi giá giảm)
            await shortExchange.createOrder(
                shortOriginalSymbol,
                'TAKE_PROFIT_MARKET', // hoặc 'TAKE_PROFIT_LIMIT' nếu muốn limit order
                'buy',                // Đóng vị thế Short bằng lệnh Buy
                shortOrder.amount,
                undefined,
                { 'stopPrice': shortTpPrice } // Đối với TAKE_PROFIT_MARKET, thường dùng stopPrice
            );
            safeLog('log', `[BOT_TRADE] ✅ Đặt TP cho SHORT ${shortExchangeId} thành công.`);
        } catch (tpShortError) {
            safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt TP cho SHORT ${shortExchangeId}: ${tpShortError.message}`);
        }

        try {
            // Lệnh Stop Loss cho vị thế LONG (bán ra khi giá giảm)
            await longExchange.createOrder(
                longOriginalSymbol,
                'STOP_MARKET', // hoặc 'STOP_LOSS_MARKET'
                'sell',        // Đóng vị thế Long bằng lệnh Sell
                longOrder.amount,
                undefined,
                { 'stopPrice': longSlPrice }
            );
            safeLog('log', `[BOT_TRADE] ✅ Đặt SL cho LONG ${longExchangeId} thành công.`);
        } catch (slLongError) {
            safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt SL cho LONG ${longExchangeId}: ${slLongError.message}`);
        }

        try {
            // Lệnh Take Profit cho vị thế LONG (bán ra khi giá tăng)
            await longExchange.createOrder(
                longOriginalSymbol,
                'TAKE_PROFIT_MARKET', // hoặc 'TAKE_PROFIT_LIMIT'
                'sell',               // Đóng vị thế Long bằng lệnh Sell
                longOrder.amount,
                undefined,
                { 'stopPrice': longTpPrice }
            );
            safeLog('log', `[BOT_TRADE] ✅ Đặt TP cho LONG ${longExchangeId} thành công.`);
        } catch (tpLongError) {
            safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt TP cho LONG ${longExchangeId}: ${tpLongError.message}`);
        }

    } catch (e) {
        safeLog('error', `[BOT_TRADE] ❌ Lỗi khi thực hiện giao dịch (hoặc đặt TP/SL): ${e.message}`);
        tradeSuccess = false;
        // Cố gắng hủy lệnh đã khớp một phần nếu có lỗi
        if (shortOrder?.id) {
            try { await exchanges[shortExchangeId].cancelOrder(shortOrder.id, shortOriginalSymbol); safeLog('log', `[BOT_TRADE] Đã hủy lệnh SHORT ${shortExchangeId}: ${shortOrder.id}`); } catch (ce) { safeLog('error', `[BOT_TRADE] Lỗi hủy lệnh SHORT: ${ce.message}`); }
        }
        if (longOrder?.id) {
            try { await exchanges[longExchangeId].cancelOrder(longOrder.id, longOriginalSymbol); safeLog('log', `[BOT_TRADE] Đã hủy lệnh LONG ${longExchangeId}: ${longOrder.id}`); } catch (ce) { safeLog('error', `[BOT_TRADE] Lỗi hủy lệnh LONG: ${ce.message}`); }
        }
        // Reset currentTradeDetails nếu trade thất bại hoàn toàn
        safeLog('log', `[BOT] currentTradeDetails being reset to null due to trade failure.`);
        currentTradeDetails = null;
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
        // Hủy bỏ các lệnh TP/SL còn treo nếu có (ví dụ: nếu bạn muốn đóng thủ công hoặc không muốn chờ TP/SL tự khớp)
        // CCXT không có hàm chung để hủy tất cả lệnh chờ của một symbol. Cần fetchOpenOrders và hủy từng cái.
        safeLog('log', '[BOT_PNL] Hủy các lệnh TP/SL còn chờ (nếu có)...');
        // Đối với Binance, OKX, Bitget, hủy lệnh chờ:
        try {
            const shortOpenOrders = await exchanges[shortExchange].fetchOpenOrders(shortOriginalSymbol);
            for (const order of shortOpenOrders) {
                // Chỉ hủy lệnh STOP_MARKET hoặc TAKE_PROFIT_MARKET
                if (order.type === 'stop' || order.type === 'take_profit' || order.type === 'stop_market' || order.type === 'take_profit_market') { 
                    await exchanges[shortExchange].cancelOrder(order.id, shortOriginalSymbol);
                    safeLog('log', `[BOT_PNL] Đã hủy lệnh chờ ${order.type} ${order.id} trên ${shortExchange}.`);
                }
            }
        } catch (e) { safeLog('warn', `[BOT_PNL] Lỗi khi hủy lệnh chờ trên ${shortExchange}: ${e.message}`); }
        try {
            const longOpenOrders = await exchanges[longExchange].fetchOpenOrders(longOriginalSymbol);
            for (const order of longOpenOrders) {
                if (order.type === 'stop' || order.type === 'take_profit' || order.type === 'stop_market' || order.type === 'take_profit_market') {
                    await exchanges[longExchange].cancelOrder(order.id, longOriginalSymbol);
                    safeLog('log', `[BOT_PNL] Đã hủy lệnh chờ ${order.type} ${order.id} trên ${longExchange}.`);
                }
            }
        } catch (e) { safeLog('warn', `[BOT_PNL] Lỗi khi hủy lệnh chờ trên ${longExchange}: ${e.message}`); }


        safeLog('log', `[BOT_PNL] Đóng vị thế SHORT ${coin} trên ${shortExchange} (amount: ${shortOrderAmount})...`);
        const closeShortOrder = await exchanges[shortExchange].createMarketBuyOrder(shortOriginalSymbol, shortOrderAmount);
        safeLog('log', `[BOT_PNL] ✅ Vị thế SHORT trên ${shortExchange} đã đóng. Order ID: ${closeShortOrder.id}`);

        safeLog('log', `[BOT_PNL] Đóng vị thế LONG ${coin} trên ${longExchange} (amount: ${longOrderAmount})...`);
        const closeLongOrder = await exchanges[longExchange].createMarketSellOrder(longOriginalSymbol, longOrderAmount);
        safeLog('log', `[BOT_PNL] ✅ Vị thế LONG trên ${longExchange} đã đóng. Order ID: ${closeLongOrder.id}`);

        await sleep(15000); // Đợi 15 giây để số dư được cập nhật sau khi đóng lệnh

        await updateBalances(); // Cập nhật số dư cuối cùng

        // Cần lấy lại vị thế hiện tại để đảm bảo đã đóng (để tránh lỗi nếu lệnh đóng không khớp hoàn toàn)
        // Tuy nhiên, cách đơn giản hơn là giả định rằng chúng ta muốn tính PnL từ vốn ban đầu
        // và sự thay đổi của 'available' balance là cách tốt nhất để đo PnL thực tế của một chu kỳ.
        // PnL của một chu kỳ giao dịch là (tổng số dư mới trên 2 sàn liên quan) - (tổng số vốn ban đầu đã bỏ ra trên 2 sàn đó)

        // Cách tính PnL cho chu kỳ giao dịch hiện tại:
        // PnL = (tổng số dư mới trên 2 sàn liên quan) - (tổng số vốn ban đầu đã bỏ ra trên 2 sàn đó)
        const currentShortAvailable = balances[shortExchange].available;
        const currentLongAvailable = balances[longExchange].available;

        // PnL thực tế của chu kỳ được tính bằng cách so sánh số dư khả dụng sau khi đóng lệnh
        // với số vốn ban đầu (collateral) đã sử dụng cho chu kỳ đó.
        // Đây là cách đơn giản nhất để ghi nhận PnL của từng chu kỳ vào lịch sử.
        // Nó giả định rằng balance.available phản ánh chính xác PnL đã hiện thực.
        const actualPnLShortSide = currentShortAvailable - currentTradeDetails.shortCollateral;
        const actualPnLLongSide = currentLongAvailable - currentTradeDetails.longCollateral;
        const cyclePnl = actualPnLShortSide + actualPnLLongSide;


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

        safeLog('log', `[BOT_PNL] ✅ Chu kỳ giao dịch cho ${coin} hoàn tất. PnL chu kỳ: ${cyclePnl.toFixed(2)} USDT. Tổng PnL: ${cumulativePnl.toFixed(2)} USDT.`);

    } catch (e) {
        safeLog('error', `[BOT_PNL] ❌ Lỗi khi đóng vị thế hoặc tính toán PnL: ${e.message}`);
    } finally {
        currentSelectedOpportunityForExecution = null; 
        safeLog('log', `[BOT] currentTradeDetails being reset to null.`);
        currentTradeDetails = null; 
        safeLog('log', '[BOT_PNL] Dọn dẹp lệnh chờ và vị thế đã đóng (nếu có).');
        // Kể từ giờ, không cần hủy lệnh chờ (pending orders) vì TP/SL đã được gửi lên sàn và sẽ tự động xử lý.
        // Tuy nhiên, nếu bạn muốn hủy các lệnh chờ KHÁC TP/SL nếu có, bạn cần thêm logic riêng.
    }
}


let serverDataGlobal = null; 

// Vòng lặp chính của Bot
async function mainBotLoop() {
    // Luôn clearTimeout để tránh tạo nhiều vòng lặp nếu mainBotLoop được gọi nhiều lần
    if (botLoopIntervalId) clearTimeout(botLoopIntervalId); 

    if (botState !== 'RUNNING' && botState !== 'EXECUTING_TRADES' && botState !== 'TRANSFERRING_FUNDS' && botState !== 'CLOSING_TRADES') {
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
                safeLog('log', `  Vốn dự kiến: ${bestPotentialOpportunityForDisplay.estimatedTradeCollateral} USDT`); // Sử dụng vốn dự kiến đã tính toán
                // Cập nhật trạng thái bot TRƯỚC khi gọi hàm tốn thời gian
                botState = 'TRANSFERRING_FUNDS'; 
                const transferSuccess = await manageFundsAndTransfer(currentSelectedOpportunityForExecution, currentPercentageToUse); // Sử dụng percentageToUse từ UI
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
            const tradeSuccess = await executeTrades(currentSelectedOpportunityForExecution, currentPercentageToUse); // Sử dụng percentageToUse từ UI
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
        let displayCurrentTradeDetails = null;
        try {
            // Chỉ gửi currentTradeDetails nếu nó đang ở trạng thái OPEN
            if (currentTradeDetails && typeof currentTradeDetails === 'object' && currentTradeDetails.status === 'OPEN') {
                displayCurrentTradeDetails = currentTradeDetails;
            } else {
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
                // Lấy percentageToUse từ body của request
                const data = body ? JSON.parse(body) : {}; 
                // Cập nhật biến toàn cục currentPercentageToUse
                currentPercentageToUse = parseFloat(data.percentageToUse); 
                if (isNaN(currentPercentageToUse) || currentPercentageToUse < 1 || currentPercentageToUse > 100) {
                    currentPercentageToUse = 50; // Mặc định nếu UI gửi không hợp lệ
                    safeLog('warn', `Giá trị phần trăm vốn không hợp lệ từ UI, sử dụng mặc định: ${currentPercentageToUse}%`);
                }

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
    }
    // ------ ĐIỂM MỚI: API ENDPOINT CHUYỂN TIỀN THỦ CÔNG ------
    else if (req.url === '/bot-api/transfer-funds' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { fromExchangeId, toExchangeId, amount } = data;

                if (!fromExchangeId || !toExchangeId || !amount || isNaN(amount) || amount < FUND_TRANSFER_MIN_AMOUNT) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: `Dữ liệu chuyển tiền không hợp lệ. Số tiền tối thiểu là ${FUND_TRANSFER_MIN_AMOUNT} USDT.` }));
                    return;
                }
                if (fromExchangeId === toExchangeId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Không thể chuyển tiền đến cùng một sàn.' }));
                    return;
                }

                // Ensure exchanges exist and are initialized
                if (!exchanges[fromExchangeId] || !exchanges[toExchangeId]) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: `Sàn ${fromExchangeId.toUpperCase()} hoặc ${toExchangeId.toUpperCase()} không hợp lệ hoặc chưa được cấu hình.` }));
                    return;
                }

                // THAY ĐỔI: Sử dụng hàm getTargetDepositInfo mới
                const targetDepositInfo = getTargetDepositInfo(fromExchangeId, toExchangeId);
                if (!targetDepositInfo) {
                    // getTargetDepositInfo đã log lỗi chi tiết, chỉ cần trả về lỗi chung cho người dùng
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: `Không thể thực hiện chuyển tiền do cấu hình địa chỉ/mạng không hợp lệ. Vui lòng kiểm tra console log và balance.js.` }));
                    return;
                }
                const { network: withdrawalNetwork, address: depositAddress } = targetDepositInfo;


                safeLog('log', `[BOT_SERVER_TRANSFER] Yêu cầu chuyển thủ công: ${amount} USDT từ ${fromExchangeId.toUpperCase()} sang ${toExchangeId.toUpperCase()} (${depositAddress}) qua mạng ${withdrawalNetwork}...`);

                try {
                    // Update balances before attempting transfer to check source balance
                    await updateBalances(); 
                    if (balances[fromExchangeId].available < amount) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, message: `Số dư khả dụng trên ${fromExchangeId.toUpperCase()} không đủ (${balances[fromExchangeId].available.toFixed(2)} USDT) để chuyển ${amount} USDT.` }));
                        return;
                    }

                    const withdrawResult = await exchanges[fromExchangeId].withdraw(
                        'USDT',
                        amount,
                        depositAddress,
                        undefined,
                        { network: withdrawalNetwork }
                    );
                    safeLog('log', `[BOT_SERVER_TRANSFER] ✅ Yêu cầu rút tiền hoàn tất từ ${fromExchangeId.toUpperCase()} sang ${toExchangeId.toUpperCase()}. ID giao dịch: ${withdrawResult.id}`);
                    
                    // THÊM MỚI: Đợi tiền về ví Spot và chuyển vào Futures (cho chuyển thủ công)
                    // Thời gian chờ có thể cần điều chỉnh cho mạng APTOS (thường nhanh hơn BEP20)
                    const waitTimeMs = (withdrawalNetwork === 'APTOS') ? 30000 : 90000; // 30s cho Aptos, 90s cho BEP20
                    safeLog('log', `[BOT_SERVER_TRANSFER] Đợi ${waitTimeMs / 1000} giây để tiền về ví Spot trên ${toExchangeId.toUpperCase()} trước khi chuyển vào Futures...`);
                    await sleep(waitTimeMs); 

                    // THÊM MỚI: Thực hiện chuyển từ Spot sang Futures
                    try {
                        const targetExchange = exchanges[toExchangeId];
                        // Cập nhật lại số dư để lấy số dư Spot mới nhất sau khi tiền về
                        await targetExchange.loadMarkets(); // Đảm bảo đã load markets
                        const targetBalanceAfterDeposit = await targetExchange.fetchBalance();
                        const usdtSpotBalance = targetBalanceAfterDeposit.spot?.free?.USDT || 0;

                        if (usdtSpotBalance >= amount) { // Chỉ chuyển nếu tiền đã về đủ Spot
                            safeLog('log', `[BOT_SERVER_TRANSFER] Đang chuyển ${amount} USDT từ ví Spot sang ví Futures trên ${toExchangeId.toUpperCase()}...`);
                            await targetExchange.transfer(
                                'USDT', amount, 'spot', 'future'
                            );
                            safeLog('log', `[BOT_SERVER_TRANSFER] ✅ Đã chuyển ${amount} USDT từ Spot sang Futures trên ${toExchangeId.toUpperCase()}.`);
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: true, message: `Yêu cầu chuyển ${amount} USDT từ ${fromExchangeId.toUpperCase()} sang ${toExchangeId.toUpperCase()} đã được gửi và chuyển vào ví Futures. ID: ${withdrawResult.id}.` }));
                        } else {
                            safeLog('warn', `[BOT_SERVER_TRANSFER] Cảnh báo: Số dư Spot trên ${toExchangeId.toUpperCase()} (${usdtSpotBalance.toFixed(2)} USDT) chưa đủ để chuyển ${amount} USDT vào Futures sau ${waitTimeMs / 1000}s. Tiền có thể chưa về kịp. Vui lòng kiểm tra lại thủ công hoặc đợi thêm.`);
                            res.writeHead(200, { 'Content-Type': 'application/json' }); // Vẫn trả về thành công vì lệnh rút đã được gửi
                            res.end(JSON.stringify({ success: true, message: `Yêu cầu chuyển ${amount} USDT từ ${fromExchangeId.toUpperCase()} sang ${toExchangeId.toUpperCase()} đã được gửi. ID: ${withdrawResult.id}. Cảnh báo: Tiền chưa về đủ Spot để tự động chuyển vào Futures. Vui lòng kiểm tra và chuyển thủ công.` }));
                        }
                    } catch (internalTransferError) {
                        safeLog('error', `[BOT_SERVER_TRANSFER] ❌ Lỗi khi chuyển tiền từ Spot sang Futures trên ${toExchangeId.toUpperCase()}: ${internalTransferError.message}. Tiền có thể vẫn nằm ở ví Spot.`);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, message: `Lỗi khi chuyển tiền từ Spot sang Futures trên ${toExchangeId.toUpperCase()}: ${internalTransferError.message}. Tiền có thể vẫn nằm ở ví Spot.` }));
                    }

                    // Trigger a balance update shortly after for UI reflection
                    setTimeout(updateBalances, 15000); // Cập nhật lại UI sau 15 giây

                } catch (transferError) {
                    safeLog('error', `[BOT_SERVER_TRANSFER] ❌ Lỗi khi thực hiện rút tiền thủ công từ ${fromExchangeId.toUpperCase()}: ${transferError.message}`);
                    let userMessage = `Lỗi khi chuyển tiền: ${transferError.message}`;
                    if (transferError.message.includes('Insufficient funds')) {
                        userMessage = `Số dư khả dụng trên ${fromExchangeId.toUpperCase()} không đủ. Vui lòng kiểm tra lại số dư tài khoản futures.`;
                    } else if (transferError.message.includes('API key permission')) {
                        userMessage = `Lỗi quyền API: Kiểm tra quyền RÚT TIỀN (Withdrawal permission) của API Key trên ${fromExchangeId.toUpperCase()}.`;
                    } else if (transferError.message.includes('Invalid network') || transferError.message.includes('Invalid address')) {
                        userMessage = `Lỗi mạng hoặc địa chỉ: Đảm bảo sàn ${toExchangeId.toUpperCase()} hỗ trợ mạng ${withdrawalNetwork} và địa chỉ nạp tiền trong balance.js là HỢP LỆ.`;
                    }
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: userMessage }));
                }
            } catch (error) {
                safeLog('error', '[BOT_SERVER] ❌ Lỗi xử lý POST /bot-api/transfer-funds:', error.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Dữ liệu yêu cầu không hợp lệ hoặc lỗi server.' }));
            }
        });
    }
    // ---------------------------------------------
    else {
        res.writeHead(404); res.end('Not Found');
    }
});

botServer.listen(BOT_PORT, () => {
    safeLog('log', `✅ Máy chủ UI của Bot đang chạy tại http://localhost:${BOT_PORT}`);
    safeLog('log', 'Bot đang chờ lệnh "Start" từ giao diện HTML.');
});
