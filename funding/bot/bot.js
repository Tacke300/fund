const http = require('http');
const https = require('https');
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

const { usdtDepositAddressesByNetwork } = require('./balance.js'); 

const BOT_PORT = 5006;
const SERVER_DATA_URL = 'http://localhost:5005/api/data';

const MIN_PNL_PERCENTAGE = 1; 
const MAX_MINUTES_UNTIL_FUNDING = 30;
const MIN_MINUTES_FOR_EXECUTION = 15;

const FUND_TRANSFER_MIN_AMOUNT_BINANCE = 10;
const FUND_TRANSFER_MIN_AMOUNT_OTHERS = 5;

const DATA_FETCH_INTERVAL_SECONDS = 5;
const HOURLY_FETCH_TIME_MINUTE = 45;

const SL_PERCENT_OF_COLLATERAL = 700;
const TP_PERCENT_OF_COLLATERAL = 8386;

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
    
    if ((config.apiKey && config.secret) || (id === 'okx' && config.password)) {
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

function getMinTransferAmount(fromExchangeId) {
    if (fromExchangeId === 'binanceusdm') {
        return FUND_TRANSFER_MIN_AMOUNT_BINANCE;
    }
    return FUND_TRANSFER_MIN_AMOUNT_OTHERS;
}

function getTargetDepositInfo(fromExchangeId, toExchangeId) {
    let withdrawalNetwork = null;
    let depositNetwork = null;

    const isOKXInvolved = (fromExchangeId === 'okx' || toExchangeId === 'okx');

    if (isOKXInvolved) {
        withdrawalNetwork = 'APTOS';
        depositNetwork = 'APTOS';
    } else {
        withdrawalNetwork = 'BEP20';
        depositNetwork = 'BEP20';
    }

    const depositAddress = usdtDepositAddressesByNetwork[toExchangeId]?.[depositNetwork];
    
    if (!depositAddress || depositAddress.startsWith('0xYOUR_')) {
        safeLog('error', `[HELPER] Không tìm thấy địa chỉ nạp USDT trên mạng "${depositNetwork}" cho sàn ${toExchangeId.toUpperCase()} trong balance.js. ` +
                         `Hoặc địa chỉ chưa được điền chính xác.`);
        return null;
    }
    
    return { network: withdrawalNetwork, address: depositAddress };
}

async function pollForBalance(exchangeId, targetAmount, maxPollAttempts = 60, pollIntervalMs = 5000) {
    safeLog('log', `[POLL] Bắt đầu kiểm tra số dư trên ${exchangeId.toUpperCase()}. Mục tiêu: ~${targetAmount.toFixed(2)} USDT (có tính phí).`);
    const exchange = exchanges[exchangeId];
    const DUST_AMOUNT = 0.001;
    let lastKnownBalance = 0;

    for (let i = 0; i < maxPollAttempts; i++) {
        try {
            await exchange.loadMarkets();
            const fullBalance = await exchange.fetchBalance();
            const usdtFundingFreeBalance = fullBalance.funding?.free?.USDT || 0;
            const usdtSpotFreeBalance = fullBalance.spot?.free?.USDT || 0;

            lastKnownBalance = Math.max(usdtFundingFreeBalance, usdtSpotFreeBalance);

            safeLog('log', `[POLL] Lần ${i + 1}/${maxPollAttempts}: ${exchangeId.toUpperCase()} - Funding: ${usdtFundingFreeBalance.toFixed(8)}, Spot: ${usdtSpotFreeBalance.toFixed(8)}. Tổng: ${lastKnownBalance.toFixed(8)}`);

            if (lastKnownBalance >= DUST_AMOUNT) {
                safeLog('log', `[POLL] ✅ Tiền (~${lastKnownBalance.toFixed(2)} USDT) đã được tìm thấy trên ${exchangeId.toUpperCase()}.`);
                const type = usdtFundingFreeBalance >= DUST_AMOUNT ? 'funding' : 'spot';
                return { found: true, type: type, balance: lastKnownBalance };
            }
            
        } catch (e) {
            safeLog('error', `[POLL] Lỗi khi lấy số dư ${exchangeId.toUpperCase()}: ${e.message}`);
        }
        await sleep(pollIntervalMs);
    }
    safeLog('warn', `[POLL] Tiền (~${targetAmount.toFixed(2)} USDT) không được tìm thấy trên ${exchangeId.toUpperCase()} sau ${maxPollAttempts * pollIntervalMs / 1000} giây.`);
    return { found: false, type: null, balance: 0 };
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
        safeLog('error', `[BOT] ❌ Lỗi khi lấy dữ liệu từ server: ${error.message}`);
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
            await exchange.loadMarkets(true);
            
            const accountBalance = await exchange.fetchBalance({ 'type': 'future' }); 
            const usdtFreeBalance = accountBalance.free?.USDT || 0; 
            const usdtTotalBalance = accountBalance.total?.USDT || 0; 

            balances[id].available = usdtFreeBalance; 
            balances[id].total = usdtTotalBalance; 

            balances[id].originalSymbol = {}; 

            currentTotalOverall += balances[id].available;

            safeLog('log', `[BOT] ✅ ${id.toUpperCase()} Balance: Total ${usdtTotalBalance.toFixed(2)} USDT, Available ${balances[id].available.toFixed(2)} USDT.`);
        } catch (e) {
            safeLog('error', `[BOT] ❌ Lỗi khi lấy số dư ${id.toUpperCase()}: ${e.message}`);
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
    
    serverData.arbitrageData.forEach(op => {
        const minutesUntilFunding = (op.nextFundingTime - now) / (1000 * 60);

        const shortExIdNormalized = op.details.shortExchange.toLowerCase() === 'binance' ? 'binanceusdm' : op.details.shortExchange.toLowerCase();
        const longExIdNormalized = op.details.longExchange.toLowerCase() === 'binance' ? 'binanceusdm' : op.details.longExchange.toLowerCase();

        if (DISABLED_EXCHANGES.includes(shortExIdNormalized) || DISABLED_EXCHANGES.includes(longExIdNormalized) ||
            !exchanges[shortExIdNormalized] || !exchanges[longExIdNormalized]) {
            return;
        }

        if (op.estimatedPnl > 0 && minutesUntilFunding > 0) { 
            op.details.minutesUntilFunding = minutesUntilFunding;

            op.details.shortFundingRate = op.details.shortRate !== undefined ? op.details.shortRate : 'N/A';
            op.details.longFundingRate = op.details.longRate !== undefined ? op.details.longRate : 'N/A';
            op.fundingDiff = op.fundingDiff !== undefined ? op.fundingDiff : 'N/A'; 
            op.commonLeverage = op.commonLeverage !== undefined ? op.commonLeverage : 'N/A';

            let shortExId = op.details.shortExchange;
            let longExId = op.details.longExchange;

            if (typeof op.details.shortFundingRate === 'number' && typeof op.details.longFundingRate === 'number') {
                if (op.details.shortFundingRate < op.details.longFundingRate) {
                    shortExId = op.details.longExchange;
                    longExId = op.details.shortExchange;
                }
            }
            op.details.shortExchange = shortExId;
            op.details.longExchange = longExId;

            tempAllOpportunities.push(op); 

            if (!bestForDisplay ||
                minutesUntilFunding < bestForDisplay.details.minutesUntilFunding || 
                (minutesUntilFunding === bestForDisplay.details.minutesUntilFunding && op.estimatedPnl > bestForDisplay.estimatedPnl) 
            ) {
                bestForDisplay = op;
            }
        }
    });

    allCurrentOpportunities = tempAllOpportunities;

    if (bestForDisplay) {
        bestPotentialOpportunityForDisplay = bestForDisplay;
        bestPotentialOpportunityForDisplay.estimatedTradeCollateral = (balances.totalOverall * (currentPercentageToUse / 100)).toFixed(2);
    } else {
        bestPotentialOpportunityForDisplay = null;
    }
}

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

    const baseCollateralPerSide = (balances.totalOverall / 2) * (currentPercentageToUse / 100);
    safeLog('log', `[BOT_TRANSFER] Vốn mục tiêu cho mỗi bên (collateral) là: ${baseCollateralPerSide.toFixed(2)} USDT.`);

    const involvedExchangesArr = [shortExchangeId, longExchangeId];
    const otherExchanges = activeExchangeIds.filter(id => !involvedExchangesArr.includes(id)); 

    let successStatus = true;

    for (const sourceExchangeId of otherExchanges) {
        if (!successStatus) break;

        const sourceExchange = exchanges[sourceExchangeId];

        if (DISABLED_EXCHANGES.includes(sourceExchangeId)) {
            safeLog('warn', `[BOT_TRANSFER] Bỏ qua sàn nguồn ${sourceExchangeId.toUpperCase()} vì nó đã bị tắt.`);
            continue;
        }

        try {
            await sourceExchange.loadMarkets(true); 
            const sourceAccountBalance = await sourceExchange.fetchBalance({'type': 'future'});
            const usdtFutureFreeBalance = sourceAccountBalance.free?.USDT || 0;

            const sourceBalance = usdtFutureFreeBalance; 
            
            const minTransferAmountForSource = getMinTransferAmount(sourceExchangeId);

            if (sourceBalance > 0 && sourceBalance >= minTransferAmountForSource) { 
                let targetExchangeToFund = null;
                const potentialTargets = involvedExchangesArr.filter(id => activeExchangeIds.includes(id));

                if (potentialTargets.length === 0) {
                     safeLog('error', '[BOT_TRANSFER] Không tìm thấy sàn mục tiêu nào đang hoạt động trong cơ hội này.');
                     successStatus = false;
                     break;
                }

                if (potentialTargets.length === 1) {
                    targetExchangeToFund = potentialTargets[0];
                } else {
                    const balance1 = balances[potentialTargets[0]]?.available || 0;
                    const balance2 = balances[potentialTargets[1]]?.available || 0;

                    if (balance1 < baseCollateralPerSide && balance2 < baseCollateralPerSide) {
                        targetExchangeToFund = balance1 < balance2 ? potentialTargets[0] : potentialTargets[1];
                    } else if (balance1 < baseCollateralPerSide) {
                        targetExchangeToFund = potentialTargets[0];
                    } else if (balance2 < baseCollateralPerSide) {
                        targetExchangeToFund = potentialTargets[1];
                    } else {
                        targetExchangeToFund = potentialTargets[0];
                    }
                }

                if (targetExchangeToFund) {
                    if (DISABLED_EXCHANGES.includes(targetExchangeToFund)) {
                        safeLog('warn', `[BOT_TRANSFER] Bỏ qua sàn mục tiêu ${targetExchangeToFund.toUpperCase()} vì nó đã bị tắt.`);
                        continue;
                    }

                    const amountNeededByTarget = baseCollateralPerSide - balances[targetExchangeToFund].available;
                    const amountToTransfer = Math.max(0, Math.min(sourceBalance, amountNeededByTarget)); 
                    
                    if (amountToTransfer >= minTransferAmountForSource) {
                        if (sourceExchangeId === 'okx') {
                            safeLog('log', `[BOT_TRANSFER][INTERNAL] Bỏ qua chuyển từ Futures sang Spot trên OKX theo yêu cầu (cố gắng rút trực tiếp từ Futures).`);
                        } else {
                            try {
                                safeLog('log', `[BOT_TRANSFER][INTERNAL] Đang chuyển ${amountToTransfer.toFixed(2)} USDT từ ví Futures sang ví Spot trên ${sourceExchangeId.toUpperCase()}...`);
                                await sourceExchange.transfer('USDT', amountToTransfer, 'future', 'spot');
                                safeLog('log', `[BOT_TRANSFER][INTERNAL] ✅ Đã chuyển ${amountToTransfer.toFixed(2)} USDT từ Futures sang Spot trên ${sourceExchangeId.toUpperCase()}.`);
                                await sleep(5000);
                                await updateBalances();
                            } catch (internalTransferError) {
                                safeLog('error', `[BOT_TRANSFER][INTERNAL] ❌ Lỗi khi chuyển tiền từ Futures sang Spot trên ${sourceExchangeId.toUpperCase()}: ${internalTransferError.message}. Tiền có thể không sẵn sàng để rút.`);
                                successStatus = false;
                                break;
                            }
                        }

                        const targetDepositInfo = getTargetDepositInfo(sourceExchangeId, targetExchangeToFund);
                        if (!targetDepositInfo) {
                            successStatus = false;
                            break; 
                        }
                        const { network: withdrawalNetwork, address: depositAddress } = targetDepositInfo;

                        // Loại bỏ tham số 'fee' đặc biệt cho OKX khi rút ra ngoài để CCXT tự tính phí mạng
                        const withdrawParams = {}; // Không thêm phí = '0' nữa

                        safeLog('log', `[BOT_TRANSFER][EXTERNAL] Đang cố gắng rút ${amountToTransfer.toFixed(2)} USDT từ ${sourceExchangeId} sang ${targetExchangeToFund} (${depositAddress}) qua mạng ${withdrawalNetwork} với params: ${JSON.stringify(withdrawParams)}...`);
                        try {
                            const withdrawResult = await exchanges[sourceExchangeId].withdraw(
                                'USDT', amountToTransfer, depositAddress, undefined, { network: withdrawalNetwork, ...withdrawParams }
                            );
                            safeLog('log', `[BOT_TRANSFER][EXTERNAL] ✅ Yêu cầu rút tiền hoàn tất từ ${sourceExchangeId} sang ${targetExchangeToFund}. ID giao dịch: ${withdrawResult.id}`);
                            
                            safeLog('log', `[BOT_TRANSFER][EXTERNAL] Bắt đầu chờ tiền về ví Funding/Spot trên ${targetExchangeToFund.toUpperCase()}...`);
                            const pollResult = await pollForBalance(targetExchangeToFund, amountToTransfer, 60, 5000); 
                            
                            if (!pollResult.found) {
                                safeLog('warn', `[BOT_TRANSFER][INTERNAL] Cảnh báo: Tiền (${amountToTransfer.toFixed(2)} USDT) chưa về đủ ví Funding hoặc Spot trên ${targetExchangeToFund.toUpperCase()} sau khi chờ. Tiền có thể chưa về kịp hoặc nằm ở ví khác. Vui lòng kiểm tra thủ công.`);
                                successStatus = false;
                                break;
                            } else {
                                try {
                                    const targetExchange = exchanges[targetExchangeToFund];
                                    safeLog('log', `[BOT_TRANSFER][INTERNAL] Đang chuyển ${pollResult.balance.toFixed(2)} USDT từ ví ${pollResult.type.toUpperCase()} sang ví Futures trên ${targetExchangeToFund.toUpperCase()}... (Đã nhận ~${pollResult.balance.toFixed(2)} USDT)`);
                                    await targetExchange.transfer(
                                        'USDT', pollResult.balance, pollResult.type, 'future'
                                    );
                                    safeLog('log', `[BOT_TRANSFER][INTERNAL] ✅ Đã chuyển ${pollResult.balance.toFixed(2)} USDT từ ${pollResult.type.toUpperCase()} sang Futures trên ${targetExchangeToFund}.`);
                                } catch (internalTransferError) {
                                    safeLog('error', `[BOT_TRANSFER][INTERNAL] ❌ Lỗi khi chuyển tiền từ Funding/Spot sang Futures trên ${targetExchangeToFund}: ${internalTransferError.message}. Tiền có thể vẫn nằm ở ví Funding/Spot.`);
                                    successStatus = false; 
                                    break;
                                }
                            }

                        } catch (transferError) {
                            safeLog('error', `[BOT_TRANSFER][EXTERNAL] ❌ Lỗi khi rút tiền từ ${sourceExchangeId} sang ${targetExchangeToFund}: ${transferError.message}`);
                            successStatus = false;
                            break;
                        }
                        await updateBalances();
                    }
                }
            }
        } catch (e) {
            safeLog('error', `[BOT_TRANSFER] Lỗi khi xử lý sàn nguồn ${sourceExchangeId.toUpperCase()}: ${e.message}`);
            successStatus = false;
            break;
        }
    }

    await updateBalances();
    if (balances[shortExchangeId]?.available < baseCollateralPerSide || balances[longExchangeId]?.available < baseCollateralPerSide) {
        safeLog('error', `[BOT_TRANSFER] ❌ Số dư cuối cùng trên sàn mục tiêu không đủ để mở lệnh với vốn ${baseCollateralPerSide.toFixed(2)} USDT mỗi bên. ${shortExchangeId}: ${balances[shortExchangeId]?.available.toFixed(2)}, ${longExchangeId}: ${balances[longExchangeId]?.available.toFixed(2)}. Hủy bỏ giao dịch.`);
        successStatus = false;
    }

    if (successStatus) {
        safeLog('log', `[BOT_TRANSFER] ✅ Quản lý tiền hoàn tất. ${shortExchangeId}: ${balances[shortExchangeId]?.available.toFixed(2)} USDT, ${longExchangeId}: ${balances[longExchangeId]?.available.toFixed(2)} USDT.`);
    } else {
        safeLog('error', '[BOT_TRANSFER] Quá trình quản lý/chuyển tiền THẤT BẠI. Hủy bỏ giao dịch.');
    }
    return successStatus;
}

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

    if (DISABLED_EXCHANGES.includes(shortExchangeId) || DISABLED_EXCHANGES.includes(longExchangeId) ||
        !exchanges[shortExchangeId] || !exchanges[longExchangeId]) {
        safeLog('error', `[BOT_TRADE] Bỏ qua thực hiện lệnh vì sàn ${shortExchangeId} hoặc ${longExchangeId} bị tắt hoặc chưa được khởi tạo.`);
        return false;
    }

    let shortOriginalSymbol, longOriginalSymbol;

    if (rawRatesData[shortExchangeId]?.rates?.[cleanedCoin]?.originalSymbol) {
        shortOriginalSymbol = rawRatesData[shortExchangeId].rates[cleanedCoin].originalSymbol;
    } else {
        safeLog('error', `[BOT_TRADE] Không tìm thấy originalSymbol cho ${cleanedCoin} trên ${shortExchangeId}. Dữ liệu từ server có thể thiếu hoặc không khớp.`);
        safeLog('error', `[BOT_TRADE] Dữ liệu chi tiết rate từ server cho ${shortExchangeId} và ${cleanedCoin}:`, rawRatesData[shortExchangeId]?.rates?.[cleanedCoin]);
        safeLog('error', '[BOT_TRADE] Hủy bỏ lệnh.');
        return false;
    }

    if (rawRatesData[longExchangeId]?.rates?.[cleanedCoin]?.originalSymbol) {
        longOriginalSymbol = rawRatesData[longExchangeId].rates[cleanedCoin].originalSymbol;
    } else {
        safeLog('error', `[BOT_TRADE] Không tìm thấy originalSymbol cho ${cleanedCoin} trên ${longExchangeId}. Dữ liệu từ server có thể thiếu hoặc không khớp.`);
        safeLog('error', `[BOT_TRADE] Dữ liệu chi tiết rate từ server cho ${longExchangeId} và ${cleanedCoin}:`, rawRatesData[longExchangeId]?.rates?.[cleanedCoin]);
        safeLog('error', '[BOT_TRADE] Hủy bỏ lệnh.');
        return false;
    }

    const shortExchange = exchanges[shortExchangeId];
    const longExchange = exchanges[longExchangeId];

    const baseCollateralPerSide = (balances.totalOverall / 2) * (currentPercentageToUse / 100);

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

        const commonLeverage = opportunity.commonLeverage || 1;
        
        const shortAmount = (shortCollateral * commonLeverage) / shortEntryPrice;
        const longAmount = (longCollateral * commonLeverage) / longEntryPrice;

        if (shortAmount <= 0 || longAmount <= 0) {
            safeLog('error', '[BOT_TRADE] Lượng hợp đồng tính toán không hợp lệ (cần dương). Hủy bỏ lệnh.');
            return false;
        }

        const shortAmountFormatted = shortExchangeId === 'okx' ? shortAmount.toFixed(0) : shortAmount.toFixed(3);
        safeLog('log', `[BOT_TRADE] Mở SHORT ${shortAmountFormatted} ${cleanedCoin} trên ${shortExchangeId} với giá ${shortEntryPrice.toFixed(4)}...`);
        shortOrder = await shortExchange.createMarketSellOrder(shortOriginalSymbol, parseFloat(shortAmountFormatted));
        safeLog('log', `[BOT_TRADE] ✅ Lệnh SHORT ${shortExchangeId} khớp: ID ${shortOrder.id}, Amount ${shortOrder.amount}, Price ${shortOrder.price}`);

        const longAmountFormatted = longExchangeId === 'okx' ? longAmount.toFixed(0) : longAmount.toFixed(3);
        safeLog('log', `[BOT_TRADE] Mở LONG ${longAmountFormatted} ${cleanedCoin} trên ${longExchangeId} với giá ${longEntryPrice.toFixed(4)}...`);
        longOrder = await longExchange.createMarketBuyOrder(longOriginalSymbol, parseFloat(longAmountFormatted));
        safeLog('log', `[BOT_TRADE] ✅ Lệnh LONG ${longExchangeId} khớp: ID ${longOrder.id}, Amount ${longOrder.amount}, Price ${longOrder.price}`);
        
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
            commonLeverage: commonLeverage,
            status: 'OPEN',
            openTime: Date.now()
        };
        safeLog('log', `[BOT_TRADE] currentTradeDetails set successfully.`);

        safeLog('log', '[BOT_TRADE] Đợi 2 giây để gửi lệnh TP/SL...');
        await sleep(2000);

        const shortTpPrice = shortEntryPrice * (1 - (TP_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));
        const shortSlPrice = shortEntryPrice * (1 + (SL_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));

        const longTpPrice = longEntryPrice * (1 + (TP_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));
        const longSlPrice = longEntryPrice * (1 - (SL_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));

        safeLog('log', `[BOT_TRADE] Tính toán TP/SL cho ${cleanedCoin}:`);
        safeLog('log', `  Short Entry: ${shortEntryPrice.toFixed(4)}, SL: ${shortSlPrice.toFixed(4)}, TP: ${shortTpPrice.toFixed(4)}`);
        safeLog('log', `  Long Entry: ${longEntryPrice.toFixed(4)}, SL: ${longSlPrice.toFixed(4)}, TP: ${longTpPrice.toFixed(4)}`);

        currentTradeDetails.shortSlPrice = shortSlPrice; 
        currentTradeDetails.shortTpPrice = shortTpPrice;
        currentTradeDetails.longSlPrice = longSlPrice;
        currentTradeDetails.longTpPrice = longTpPrice;
        
        try {
            await shortExchange.createOrder(
                shortOriginalSymbol,
                'STOP_MARKET',
                'buy',
                shortOrder.amount,
                undefined,
                { 'stopPrice': shortSlPrice }
            );
            safeLog('log', `[BOT_TRADE] ✅ Đặt SL cho SHORT ${shortExchangeId} thành công.`);
        } catch (slShortError) {
            safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt SL cho SHORT ${shortExchangeId}: ${slShortError.message}`);
        }

        try {
            await shortExchange.createOrder(
                shortOriginalSymbol,
                'TAKE_PROFIT_MARKET',
                'buy',
                shortOrder.amount,
                undefined,
                { 'stopPrice': shortTpPrice }
            );
            safeLog('log', `[BOT_TRADE] ✅ Đặt TP cho SHORT ${shortExchangeId} thành công.`);
        } catch (tpShortError) {
            safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt TP cho SHORT ${shortExchangeId}: ${tpShortError.message}`);
        }

        try {
            await longExchange.createOrder(
                longOriginalSymbol,
                'STOP_MARKET',
                'sell',
                longOrder.amount,
                undefined,
                { 'stopPrice': longSlPrice }
            );
            safeLog('log', `[BOT_TRADE] ✅ Đặt SL cho LONG ${longExchangeId} thành công.`);
        } catch (slLongError) {
            safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt SL cho LONG ${longExchangeId}: ${slLongError.message}`);
        }

        try {
            await longExchange.createOrder(
                longOriginalSymbol,
                'TAKE_PROFIT_MARKET',
                'sell',
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
        if (shortOrder?.id) {
            try { await exchanges[shortExchangeId].cancelOrder(shortOrder.id, shortOriginalSymbol); safeLog('log', `[BOT_TRADE] Đã hủy lệnh SHORT ${shortExchangeId}: ${shortOrder.id}`); } catch (ce) { safeLog('error', `[BOT_TRADE] Lỗi hủy lệnh SHORT: ${ce.message}`); }
        }
        if (longOrder?.id) {
            try { await exchanges[longExchangeId].cancelOrder(longOrder.id, longOriginalSymbol); safeLog('log', `[BOT_TRADE] Đã hủy lệnh LONG ${longExchangeId}: ${longOrder.id}`); } catch (ce) { safeLog('error', `[BOT_TRADE] Lỗi hủy lệnh LONG: ${ce.message}`); }
        }
        safeLog('log', `[BOT] currentTradeDetails being reset to null due to trade failure.`);
        currentTradeDetails = null;
    }
    return tradeSuccess;
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
        try {
            const shortOpenOrders = await exchanges[shortExchange].fetchOpenOrders(shortOriginalSymbol);
            for (const order of shortOpenOrders) {
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

        await sleep(15000);

        await updateBalances();

        const currentShortAvailable = balances[shortExchange]?.available;
        const currentLongAvailable = balances[longExchange]?.available;
        const cyclePnl = (currentShortAvailable - currentTradeDetails.shortCollateral) + (currentLongAvailable - currentTradeDetails.longCollateral);

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
        safeLog('error', `[BOT_PNL] ❌ Lỗi khi đóng vị thế hoặc tính toán PnL: ${e.message}`);
    } finally {
        currentSelectedOpportunityForExecution = null; 
        safeLog('log', `[BOT] currentTradeDetails being reset to null.`);
        currentTradeDetails = null; 
        safeLog('log', '[BOT_PNL] Dọn dẹp lệnh chờ và vị thế đã đóng (nếu có).');
    }
}

let serverDataGlobal = null; 

async function mainBotLoop() {
    if (botLoopIntervalId) clearTimeout(botLoopIntervalId); 

    if (botState !== 'RUNNING' && botState !== 'EXECUTING_TRADES' && botState !== 'TRANSFERRING_FUNDS' && botState !== 'CLOSING_TRADES') {
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
                const minutesUntilFunding = op.details.minutesUntilFunding; 

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
                safeLog('log', `  Sàn Short: ${currentSelectedOpportunityForExecution.details.shortExchange}, Sàn Long: ${currentSelectedOpportunityForExecution.details.longExchange}`);
                safeLog('log', `  Vốn dự kiến: ${bestPotentialOpportunityForDisplay.estimatedTradeCollateral} USDT`);
                botState = 'TRANSFERRING_FUNDS'; 
                const transferSuccess = await manageFundsAndTransfer(currentSelectedOpportunityForExecution, currentPercentageToUse);
                if (transferSuccess) {
                    safeLog('log', '[BOT_LOOP] ✅ Chuyển tiền hoàn tất cho cơ hội đã chọn. Chờ mở lệnh.');
                } else {
                    safeLog('error', '[BOT_LOOP] ❌ Lỗi chuyển tiền hoặc không đủ số dư cho cơ hội đã chọn. Hủy chu kỳ này.');
                    currentSelectedOpportunityForExecution = null;
                }
                botState = 'RUNNING';
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
            await closeTradesAndCalculatePnL();
            botState = 'RUNNING'; 
        }
    }

    botLoopIntervalId = setTimeout(mainBotLoop, 1000); 
}

function startBot() {
    if (botState === 'STOPPED') {
        safeLog('log', '[BOT] ▶️ Khởi động Bot...');
        botState = 'RUNNING';
        
        updateBalances().then(() => {
            safeLog('log', '[BOT] Đã cập nhật số dư ban đầu. Bắt đầu vòng lặp bot.');
            mainBotLoop(); 
        }).catch(err => {
            safeLog('error', `[BOT] Lỗi khi khởi tạo số dư ban đầu: ${err.message}`);
            botState = 'STOPPED';
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
            if (currentTradeDetails && typeof currentTradeDetails === 'object' && currentTradeDetails.status === 'OPEN') {
                displayCurrentTradeDetails = currentTradeDetails;
            } else {
                displayCurrentTradeDetails = null;
            }
        } catch (e) {
            safeLog('error', `[BOT_SERVER] CRITICAL EXCEPTION accessing currentTradeDetails for status API: ${e.message}. Setting to null.`);
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
    else if (req.url === '/bot-api/transfer-funds' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { fromExchangeId, toExchangeId, amount } = data;

                const minTransferAmount = getMinTransferAmount(fromExchangeId);

                if (DISABLED_EXCHANGES.includes(fromExchangeId) || DISABLED_EXCHANGES.includes(toExchangeId)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: `Không thể chuyển tiền. Sàn ${fromExchangeId.toUpperCase()} hoặc ${toExchangeId.toUpperCase()} đã bị tắt hoặc gặp vấn đề API.` }));
                    return;
                }

                if (!fromExchangeId || !toExchangeId || !amount || isNaN(amount) || amount < minTransferAmount) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: `Dữ liệu chuyển tiền không hợp lệ. Số tiền tối thiểu từ ${fromExchangeId.toUpperCase()} là ${minTransferAmount} USDT.` }));
                    return;
                }
                if (fromExchangeId === toExchangeId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Không thể chuyển tiền đến cùng một sàn.' }));
                    return;
                }

                if (!exchanges[fromExchangeId] || !exchanges[toExchangeId]) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: `Sàn ${fromExchangeId.toUpperCase()} hoặc ${toExchangeId.toUpperCase()} không hợp lệ hoặc chưa được cấu hình.` }));
                    return;
                }

                const targetDepositInfo = getTargetDepositInfo(fromExchangeId, toExchangeId);
                if (!targetDepositInfo) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: `Không thể thực hiện chuyển tiền do cấu hình địa chỉ/mạng không hợp lệ. Vui lòng kiểm tra console log và balance.js.` }));
                    return;
                }
                const { network: withdrawalNetwork, address: depositAddress } = targetDepositInfo;

                safeLog('log', `[BOT_SERVER_TRANSFER] Yêu cầu chuyển thủ công: ${amount} USDT từ ${fromExchangeId.toUpperCase()} sang ${toExchangeId.toUpperCase()} (${depositAddress}) qua mạng ${withdrawalNetwork}...`);

                try {
                    const sourceExchange = exchanges[fromExchangeId];

                    if (fromExchangeId === 'okx') {
                        safeLog('log', `[BOT_SERVER_TRANSFER][INTERNAL] Bỏ qua chuyển từ Futures sang Spot trên OKX theo yêu cầu (cố gắng rút trực tiếp từ Futures).`);
                    } else {
                        try {
                            await sourceExchange.loadMarkets(true);
                            const sourceFuturesBalance = await sourceExchange.fetchBalance({'type': 'future'});
                            const usdtFutureFreeBalance = sourceFuturesBalance.free?.USDT || 0;

                            if (usdtFutureFreeBalance < amount) {
                                 res.writeHead(400, { 'Content-Type': 'application/json' });
                                 res.end(JSON.stringify({ success: false, message: `Số dư khả dụng trong ví Futures của ${fromExchangeId.toUpperCase()} (${usdtFutureFreeBalance.toFixed(2)} USDT) không đủ để chuyển ${amount} USDT.` }));
                                 return;
                            }

                            safeLog('log', `[BOT_SERVER_TRANSFER][INTERNAL] Đang chuyển ${amount} USDT từ ví Futures sang ví Spot trên ${fromExchangeId.toUpperCase()}...`);
                            await sourceExchange.transfer('USDT', amount, 'future', 'spot');
                            safeLog('log', `[BOT_SERVER_TRANSFER][INTERNAL] ✅ Đã chuyển ${amount} USDT từ Futures sang Spot trên ${fromExchangeId.toUpperCase()}.`);
                            await sleep(5000);
                        } catch (internalTransferError) {
                            safeLog('error', `[BOT_SERVER_TRANSFER][INTERNAL] ❌ Lỗi khi chuyển tiền từ Futures sang Spot trên ${fromExchangeId.toUpperCase()}: ${internalTransferError.message}. Vui lòng kiểm tra quyền API hoặc thử lại.`);
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: false, message: `Lỗi nội bộ trên ${fromExchangeId.toUpperCase()}: ${internalTransferError.message}` }));
                            return;
                        }
                    }
                    
                    // Loại bỏ tham số 'fee' đặc biệt cho OKX khi rút ra ngoài để CCXT tự tính phí mạng (hoặc nếu là fee-free, CCXT sẽ biết)
                    const withdrawParams = {}; 
                    // Bỏ qua: if (fromExchangeId === 'okx') { withdrawParams.fee = '0'; } // KHÔNG CẦN NỮA, APTOS CÓ PHÍ

                    const withdrawResult = await exchanges[fromExchangeId].withdraw(
                        'USDT',
                        amount,
                        depositAddress,
                        undefined,
                        { network: withdrawalNetwork, ...withdrawParams }
                    );
                    safeLog('log', `[BOT_SERVER_TRANSFER][EXTERNAL] ✅ Yêu cầu rút tiền hoàn tất từ ${fromExchangeId.toUpperCase()} sang ${toExchangeId.toUpperCase()}. ID giao dịch: ${withdrawResult.id}`);
                    
                    safeLog('log', `[BOT_SERVER_TRANSFER][EXTERNAL] Bắt đầu chờ tiền về ví Funding/Spot trên ${toExchangeId.toUpperCase()}...`);
                    const pollResult = await pollForBalance(toExchangeId, amount, 60, 5000); 
                    
                    if (!pollResult.found) {
                        safeLog('warn', `[BOT_SERVER_TRANSFER][INTERNAL] Cảnh báo: Tiền (${amount.toFixed(2)} USDT) chưa về đủ ví Funding hoặc Spot trên ${toExchangeId.toUpperCase()} sau khi chờ. Tiền có thể chưa về kịp hoặc nằm ở ví khác. Vui lòng kiểm tra thủ công.`);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, message: `Yêu cầu chuyển ${amount} USDT từ ${fromExchangeId.toUpperCase()} sang ${toExchangeId.toUpperCase()} đã được gửi. ID: ${withdrawResult.id}. Cảnh báo: Tiền chưa về đủ ví Funding/Spot để tự động chuyển vào Futures. Vui lòng kiểm tra và chuyển thủ công.` }));
                    } else {
                        try {
                            const targetExchange = exchanges[toExchangeId];
                            safeLog('log', `[BOT_SERVER_TRANSFER][INTERNAL] Đang chuyển ${pollResult.balance.toFixed(2)} USDT từ ví ${pollResult.type.toUpperCase()} sang ví Futures trên ${toExchangeId.toUpperCase()}... (Đã nhận ~${pollResult.balance.toFixed(2)} USDT)`);
                            await targetExchange.transfer(
                                'USDT', pollResult.balance, pollResult.type, 'future'
                            );
                            safeLog('log', `[BOT_SERVER_TRANSFER][INTERNAL] ✅ Đã chuyển ${pollResult.balance.toFixed(2)} USDT từ ${pollResult.type.toUpperCase()} sang Futures trên ${toExchangeId.toUpperCase()}.`);
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: true, message: `Yêu cầu chuyển ${amount} USDT từ ${fromExchangeId.toUpperCase()} sang ${toExchangeId.toUpperCase()} đã được gửi và chuyển vào ví Futures. ID: ${withdrawResult.id}.` }));
                        } catch (internalTransferError) {
                            safeLog('error', `[BOT_SERVER_TRANSFER][INTERNAL] ❌ Lỗi khi chuyển tiền từ Funding/Spot sang Futures trên ${toExchangeId.toUpperCase()}: ${internalTransferError.message}. Tiền có thể vẫn nằm ở ví Funding/Spot.`);
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: false, message: `Lỗi khi chuyển tiền từ Funding/Spot sang Futures trên ${toExchangeId.toUpperCase()}: ${internalTransferError.message}. Tiền có thể vẫn nằm ở ví Funding/Spot.` }));
                        }
                    }

                    setTimeout(updateBalances, 15000);

                } catch (transferError) {
                    safeLog('error', `[BOT_SERVER_TRANSFER] ❌ Lỗi khi thực hiện rút tiền thủ công từ ${fromExchangeId.toUpperCase()}: ${transferError.message}`);
                    let userMessage = `Lỗi khi chuyển tiền: ${transferError.message}`;
                    if (transferError.message.includes('Insufficient funds')) {
                        userMessage = `Số dư khả dụng trong ví Futures của ${fromExchangeId.toUpperCase()} không đủ (sau khi chuyển sang Spot). Vui lòng kiểm tra lại số dư hoặc quyền API.`;
                    } else if (transferError.message.includes('API key permission')) {
                        userMessage = `Lỗi quyền API: Kiểm tra quyền RÚT TIỀN (Withdrawal permission) của API Key trên ${fromExchangeId.toUpperCase()}.`;
                    } else if (transferError.message.includes('Invalid network') || transferError.message.includes('Invalid address') || transferError.message.includes('chainName')) { // Thêm kiểm tra lỗi chainName/network
                        userMessage = `Lỗi mạng hoặc địa chỉ: Đảm bảo sàn ${toExchangeId.toUpperCase()} hỗ trợ mạng ${withdrawalNetwork} và địa chỉ nạp tiền trong balance.js là HỢP LỆ. Vui lòng kiểm tra lại.`;
                    } else if (transferError.message.includes('fee')) { // Bắt lỗi liên quan đến phí rút tiền
                         userMessage = `Lỗi phí rút tiền: Sàn ${fromExchangeId.toUpperCase()} yêu cầu tham số phí rút tiền hoặc phí không hợp lệ cho mạng ${withdrawalNetwork}. Vui lòng kiểm tra lại.`;
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
    else {
        res.writeHead(404); res.end('Not Found');
    }
});

botServer.listen(BOT_PORT, () => {
    safeLog('log', `✅ Máy chủ UI của Bot đang chạy tại http://localhost:${BOT_PORT}`);
    safeLog('log', 'Bot đang chờ lệnh "Start" từ giao diện HTML.');
});
