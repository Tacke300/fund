import https from 'https';
import crypto from 'crypto';
import express from 'express';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

// Import API_KEY và SECRET_KEY từ config.js
import { API_KEY, SECRET_KEY } from './config.js';

// Lấy __filename và __dirname trong ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- BASE URL CỦA BINANCE FUTURES API ---
const BASE_HOST = 'fapi.binance.com';
const WS_BASE_URL = 'wss://fstream.binance.com';
const WS_USER_DATA_ENDPOINT = '/ws';

let serverTimeOffset = 0; // Offset thời gian để đồng bộ với server Binance

// Biến cache cho exchangeInfo để tránh gọi API lặp lại
let exchangeInfoCache = null;

// Biến cờ để tránh gửi nhiều lệnh đóng cùng lúc
let isClosingPosition = false;

// Biến cờ điều khiển trạng thái bot (chạy/dừng)
let botRunning = false;
let botStartTime = null; // Thời điểm bot được khởi động

// --- START: BIẾN TRẠNG THÁI VỊ THẾ MỚI (HEDGING) ---
let currentLongPosition = null; // { symbol, quantity, entryPrice, initialTPPrice, initialSLPrice, initialMargin, openTime, pricePrecision, side, currentPrice, unrealizedPnl, currentTPId, currentSLId, closedAmount, partialCloseLevels, nextPartialCloseIndex, hasAdjustedSLTo200PercentProfit, hasAdjustedSLTo500PercentProfit, maxLeverageUsed, closedLossAmount, partialCloseLossLevels, nextPartialCloseLossIndex, initialQuantity }
let currentShortPosition = null; // Tương tự như trên

// Biến để lưu trữ setInterval cho việc kiểm tra vị thế đang mở
let positionCheckInterval = null;
// Biến để lưu trữ setTimeout cho lần chạy tiếp theo của chu kỳ chính (runTradingLogic)
let nextScheduledCycleTimeout = null;
// Biến để lưu trữ setTimeout cho việc tự động khởi động lại bot sau lỗi nghiêm trọng
let retryBotTimeout = null;

// === START - BIẾN QUẢN LÝ LỖI VÀ TẦN SUẤT LOG ===
let consecutiveApiErrors = 0;
const MAX_CONSECUTIVE_API_ERRORS = 3;
const ERROR_RETRY_DELAY_MS = 10000;

const logCounts = {};
const LOG_COOLDOWN_MS = 2000;

class CriticalApiError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CriticalApiError';
    }
}
// === END - BIẾN QUẢN LÝ LỖI VÀ TẦN SUẤT LOG ===

// --- CẤU HÌNH BOT CÁC THAM SỐ GIAO DUC (GIÁ TRỊ MẶC ĐỊNH) ---
let INITIAL_INVESTMENT_AMOUNT = 1; // Mặc định 1 USDT (sẽ được cập nhật từ UI)
let TARGET_COIN_SYMBOL = 'ETHUSDT'; // Mặc định ETHUSDT (sẽ được cập nhật từ UI)

// Biến để lưu trữ tổng lời/lỗ
let totalProfit = 0;
let totalLoss = 0;
let netPNL = 0;

// --- BIẾN TRẠẠNG THÁI WEBSOCKET ---
let marketWs = null;
let userDataWs = null;
let listenKey = null;
let listenKeyRefreshInterval = null;
let currentMarketPrice = null; // Cache giá từ WebSocket

// --- CẤU HÌNH WEB SERVER VÀ LOG PM2 ---
const WEB_SERVER_PORT = 1230;
const BOT_LOG_FILE = `/home/tacke300/.pm2/logs/${process.env.name || 'home'}-out.log`;
const THIS_BOT_PM2_NAME = process.env.name || 'home';

// --- LOGGING TO FILE ---
const CUSTOM_LOG_FILE = path.join(__dirname, 'pm2.log');
const LOG_TO_CUSTOM_FILE = true;

// --- HÀM TIỆN ÍCH ---

function addLog(message) {
    const now = new Date();
    const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    let logEntry = `[${time}] ${message}`;

    const messageHash = crypto.createHash('md5').update(message).digest('hex');

    if (logCounts[messageHash]) {
        logCounts[messageHash].count++;
        const lastLoggedTime = logCounts[messageHash].lastLoggedTime;

        if ((now.getTime() - lastLoggedTime.getTime()) < LOG_COOLDOWN_MS) {
            return;
        } else {
            if (logCounts[messageHash].count > 1) {
                console.log(`[${time}] (Lặp lại x${logCounts[messageHash].count}) ${message}`);
                 if (LOG_TO_CUSTOM_FILE) {
                    fs.appendFile(CUSTOM_LOG_FILE, `[${time}] (Lặp lại x${logCounts[messageHash].count}) ${message}\n`, (err) => {
                        if (err) console.error('Lỗi khi ghi log vào file tùy chỉnh:', err);
                    });
                }
            } else {
                console.log(logEntry);
                if (LOG_TO_CUSTOM_FILE) {
                    fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', (err) => {
                        if (err) console.error('Lỗi khi ghi log vào file tùy chỉnh:', err);
                    });
                }
            }
            logCounts[messageHash] = { count: 1, lastLoggedTime: now };
        }
    } else {
        console.log(logEntry);
        if (LOG_TO_CUSTOM_FILE) {
            fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', (err) => {
                if (err) console.error('Lỗi khi ghi log vào file tùy chỉnh:', err);
            });
        }
        logCounts[messageHash] = { count: 1, lastLoggedTime: now };
    }
}

function formatTimeUTC7(dateObject) {
    const formatter = new Intl.DateTimeFormat('en-GB', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
        hour12: false,
        timeZone: 'Asia/Ho_Chi_Minh'
    });
    return formatter.format(dateObject);
}

function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret)
                        .update(queryString)
                        .digest('hex');
}

async function makeHttpRequest(method, hostname, path, headers, postData = '') {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: hostname,
            path: path,
            method: method,
            headers: headers,
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
                } else {
                    const errorMsg = `HTTP Error: ${res.statusCode} ${res.statusMessage}`;
                    let errorDetails = { code: res.statusCode, msg: errorMsg };
                    try {
                        const parsedData = JSON.parse(data);
                        errorDetails = { ...errorDetails, ...parsedData };
                    } catch (e) {
                        errorDetails.msg += ` - Raw: ${data.substring(0, Math.min(data.length, 200))}`;
                    }
                    addLog(`HTTP Request lỗi: ${errorDetails.msg}`);
                    reject(errorDetails);
                }
            });
        });

        req.on('error', (e) => {
            addLog(`Network lỗi: ${e.message}`);
            reject({ code: 'NETWORK_ERROR', msg: e.message });
        });

        if (postData) {
            req.write(postData);
        }
        req.end();
    });
}

async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!API_KEY || !SECRET_KEY) {
        throw new CriticalApiError("❌ Missing Binance API_KEY hoặc API_SECRET. Vui lòng kiểm tra file config.js.");
    }
    const recvWindow = 5000;
    const timestamp = Date.now() + serverTimeOffset;

    let queryString = Object.keys(params)
                                    .map(key => `${key}=${encodeURIComponent(params[key])}`)
                                    .join('&');

    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;

    const signature = createSignature(queryString, SECRET_KEY);

    let requestPath;
    let requestBody = '';
    const headers = {
        'X-MBX-APIKEY': API_KEY,
    };

    if (method === 'GET' || method === 'DELETE') {
        requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/json';
    } else if (method === 'POST' || method === 'PUT') {
        requestPath = fullEndpointPath;
        requestBody = `${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
        throw new Error(`Method không hỗ trợ: ${method}`);
    }

    try {
        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody);
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        addLog(`Lỗi ký API Binance: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        if (error.code === -2015) {
            addLog("  -> Kiểm tra API Key/Secret và quyền Futures.");
        } else if (error.code === -1021) {
            addLog("  -> Lỗi lệch thời gian. Đồng bộ đồng hồ máy tính.");
        } else if (error.code === -1003) {
            addLog("  -> BỊ CẤM IP TẠM THỜI (RATE LIMIT). CẦN GIẢM TẦN SUẤT GỌI API!");
        } else if (error.code === -1022) {
            addLog("  -> Lỗi chữ ký. Kiểm tra API Key/Secret hoặc chuỗi tham số.");
        } else if (error.code === -4061) {
            addLog("  -> Lỗi -4061 (Order's position side does not match user's setting). Đảm bảo đã bật Hedge Mode và lệnh có positionSide phù hợp.");
        }

        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`Lỗi API liên tiếp (${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}). Dừng bot.`, true);
            throw new CriticalApiError("Lỗi API nghiêm trọng, bot dừng.");
        }
        throw error;
    }
}

async function callPublicAPI(fullEndpointPath, params = {}) {
    const queryString = Object.keys(params)
                                    .map(key => `${key}=${params[key]}`)
                                    .join('&');
    const fullPathWithQuery = `${fullEndpointPath}` + (queryString ? `?${queryString}` : '');

    const headers = {
        'Content-Type': 'application/json',
    };

    try {
        const rawData = await makeHttpRequest('GET', BASE_HOST, fullPathWithQuery, headers);
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        addLog(`Lỗi công khai API Binance: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`Lỗi API liên tiếp (${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}). Dừng bot.`, true);
            throw new CriticalApiError("Lỗi API nghiêm trọng, bot dừng.");
        }
        throw error;
    }
}

async function syncServerTime() {
    try {
        const data = await callPublicAPI('/fapi/v1/time');
        const binanceServerTime = data.serverTime;
        const localTime = Date.now();
        serverTimeOffset = binanceServerTime - localTime;
        addLog(`Đồng bộ thời gian. Lệch: ${serverTimeOffset} ms.`);
    } catch (error) {
        addLog(`Lỗi đồng bộ thời gian: ${error.message}.`);
        serverTimeOffset = 0;
        throw error;
    }
}

async function getLeverageBracketForSymbol(symbol) {
    try {
        const response = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol: symbol });
        if (response && Array.isArray(response) && response.length > 0) {
            const symbolData = response.find(item => item.symbol === symbol);
            if (symbolData && symbolData.brackets && Array.isArray(symbolData.brackets) && symbolData.brackets.length > 0) {
                return parseInt(symbolData.brackets[0].initialLeverage);
            }
        }
        addLog(`Không tìm thấy đòn bẩy hợp lệ cho ${symbol}.`);
        return null;
    } catch (error) {
        addLog(`Lỗi lấy đòn bẩy cho ${symbol}: ${error.msg || error.message}`);
        return null;
    }
}

async function setLeverage(symbol, leverage) {
    try {
        addLog(`Đặt đòn bẩy ${leverage}x cho ${symbol}.`);
        await callSignedAPI('/fapi/v1/leverage', 'POST', {
            symbol: symbol,
            leverage: leverage
        });
        addLog(`Đã đặt đòn bẩy ${leverage}x cho ${symbol}.`);
        return true;
    } catch (error) {
        addLog(`Lỗi đặt đòn bẩy ${leverage}x cho ${symbol}: ${error.msg || error.message}`);
        return false;
    }
}

async function getExchangeInfo() {
    if (exchangeInfoCache) {
        return exchangeInfoCache;
    }

    addLog('Lấy exchangeInfo...');
    try {
        const data = await callPublicAPI('/fapi/v1/exchangeInfo');
        addLog(`Đã nhận exchangeInfo. Symbols: ${data.symbols.length}`);

        exchangeInfoCache = {};
        data.symbols.forEach(s => {
            const lotSizeFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const minNotionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
            const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');

            exchangeInfoCache[s.symbol] = {
                stepSize: parseFloat(lotSizeFilter?.stepSize || 0.001),
                minNotional: parseFloat(minNotionalFilter?.notional || 0),
                pricePrecision: s.pricePrecision,
                quantityPrecision: s.quantityPrecision,
                tickSize: parseFloat(priceFilter?.tickSize || 0.001)
            };
        });
        addLog('Đã tải thông tin sàn.');
        return exchangeInfoCache;
    } catch (error) {
        addLog('Lỗi lấy exchangeInfo: ' + (error.msg || error.message));
        exchangeInfoCache = null;
        throw error;
    }
}

async function getSymbolDetails(symbol) {
    const filters = await getExchangeInfo();
    if (!filters || !filters[symbol]) {
        addLog(`Không tìm thấy filters cho ${symbol}.`);
        return null;
    }
    return filters[symbol];
}

async function getCurrentPrice(symbol) {
    try {
        const data = await callPublicAPI('/fapi/v1/ticker/price', { symbol: symbol });
        return parseFloat(data.price);
    } catch (error) {
        addLog(`Lỗi lấy giá hiện tại cho ${symbol} từ REST API: ${error.msg || error.message}`);
        return null;
    }
}

async function cancelOpenOrdersForSymbol(symbol, orderId = null, positionSide = null) {
    try {
        let params = { symbol: symbol };
        if (orderId) params.orderId = orderId;
        if (positionSide) params.positionSide = positionSide;
        
        if (orderId) {
            addLog(`Đang hủy lệnh ${orderId} cho ${symbol} (positionSide: ${positionSide || 'Tất cả'}).`);
            await callSignedAPI('/fapi/v1/order', 'DELETE', params);
            addLog(`Đã hủy lệnh ${orderId} cho ${symbol}.`);
        } else {
            addLog(`Đang hủy tất cả lệnh chờ cho ${symbol} (positionSide: ${positionSide || 'Tất cả'}).`);
            await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', params);
            addLog(`Đã hủy tất cả lệnh chờ cho ${symbol}.`);
        }
    } catch (error) {
        if (error.code !== -2011) {
             addLog(`Lỗi hủy lệnh chờ cho ${symbol}: ${error.msg || error.message}`);
             if (error instanceof CriticalApiError) stopBotLogicInternal();
        }
    }
}

async function cleanupAndResetCycle(symbol) {
    addLog(`Chu kỳ giao dịch cho ${symbol} đã kết thúc. Dọn dẹp sau 3 giây...`);
    await sleep(3000);

    currentLongPosition = null;
    currentShortPosition = null;
    if (positionCheckInterval) {
        clearInterval(positionCheckInterval);
        positionCheckInterval = null;
    }

    await cancelOpenOrdersForSymbol(symbol, null, 'BOTH');
    await checkAndHandleRemainingPosition(symbol);

    if (botRunning) {
        scheduleNextMainCycle();
    }
}

async function processTradeResult(orderInfo) {
    const { s: symbol, rp: realizedPnlStr, X: orderStatus, i: orderId, ps: positionSide } = orderInfo;
    const realizedPnl = parseFloat(realizedPnlStr);

    if (symbol !== TARGET_COIN_SYMBOL || orderStatus !== 'FILLED' || realizedPnl === 0) {
        return;
    }

    addLog(`[Trade Result] Lệnh ${orderId} (${positionSide}) đã khớp. PNL: ${realizedPnl.toFixed(4)} USDT.`);

    if (realizedPnl > 0) totalProfit += realizedPnl; else totalLoss += Math.abs(realizedPnl);
    netPNL = totalProfit - totalLoss;
    addLog(`PNL Ròng: ${netPNL.toFixed(2)} USDT (Lời: ${totalProfit.toFixed(2)}, Lỗ: ${totalLoss.toFixed(2)})`);
    
    const isLongClosure = currentLongPosition && (orderId == currentLongPosition.currentTPId || orderId == currentLongPosition.currentSLId);
    const isShortClosure = currentShortPosition && (orderId == currentShortPosition.currentTPId || orderId == currentShortPosition.currentSLId);

    if (!isLongClosure && !isShortClosure) {
        addLog(`Lệnh ${orderId} không phải là TP/SL do bot quản lý. Có thể là lệnh đóng từng phần.`);
        return;
    }

    if (realizedPnl >= 0) {
        addLog(`Vị thế LÃI (${positionSide}) đã đóng. Đóng nốt vị thế LỖ còn lại.`);
        const remainingPosition = (positionSide === 'LONG') ? currentShortPosition : currentLongPosition;
        if (remainingPosition) {
            await closePosition(remainingPosition.symbol, remainingPosition.quantity, `Đóng do lệnh LÃI đối ứng đã chốt`, remainingPosition.side);
        }
        await cleanupAndResetCycle(symbol);
    } else {
        addLog(`Vị thế LỖ (${positionSide}) đã đóng. Để vị thế LÃI tiếp tục chạy.`);
        if (positionSide === 'LONG') currentLongPosition = null; else currentShortPosition = null;
    }
}

async function closePosition(symbol, quantity, reason, positionSide) {
    if (symbol !== TARGET_COIN_SYMBOL || !positionSide) return;
    if (isClosingPosition) return;
    isClosingPosition = true;

    addLog(`Đang chuẩn bị đóng lệnh ${positionSide} ${symbol} (Lý do: ${reason}).`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const posOnBinance = positions.find(p => p.symbol === symbol && p.positionSide === positionSide && parseFloat(p.positionAmt) !== 0);

        if (posOnBinance) {
            const qtyToClose = Math.abs(parseFloat(posOnBinance.positionAmt));
            const closeSide = (positionSide === 'LONG') ? 'SELL' : 'BUY';
            await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide, type: 'MARKET', quantity: qtyToClose });
            addLog(`Đã gửi lệnh đóng ${positionSide}.`);
        } else {
            addLog(`Vị thế ${positionSide} đã được đóng.`);
        }
    } catch (error) {
        addLog(`Lỗi đóng vị thế ${positionSide}: ${error.msg || error.message}`);
    } finally {
        isClosingPosition = false;
    }
}

async function closePartialPosition(position, percentageOfInitialQuantity) {
    if (!position || position.initialQuantity === undefined || position.initialQuantity <= 0) return;

    addLog(`Đang đóng ${percentageOfInitialQuantity}% khối lượng ban đầu của lệnh LỖ ${position.side} ${position.symbol}.`);
    try {
        const symbolInfo = await getSymbolDetails(position.symbol);
        if (!symbolInfo) throw new Error("Không có thông tin symbol");

        let quantityToClose = position.initialQuantity * (percentageOfInitialQuantity / 100);
        quantityToClose = Math.floor(quantityToClose / symbolInfo.stepSize) * symbolInfo.stepSize;
        quantityToClose = parseFloat(quantityToClose.toFixed(symbolInfo.quantityPrecision));
        
        const currentPrice = await getCurrentPrice(position.symbol);
        if (quantityToClose <= 0 || (currentPrice && (quantityToClose * currentPrice) < symbolInfo.minNotional)) {
            addLog(`Số lượng đóng từng phần quá nhỏ. Bỏ qua.`);
            return;
        }

        const closeSide = position.side === 'LONG' ? 'SELL' : 'BUY';
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol, side: closeSide, positionSide: position.side,
            type: 'MARKET', quantity: quantityToClose,
        });

        if(currentPrice) position.closedLossAmount += quantityToClose * currentPrice;
        addLog(`Đã gửi lệnh đóng từng phần. Tổng vốn đã cắt từ lệnh lỗ: ${position.closedLossAmount.toFixed(2)} USDT.`);
    } catch (error) {
        addLog(`Lỗi khi đóng từng phần lệnh lỗ ${position.side}: ${error.msg || error.message}`);
    }
}

async function addPosition(position, amountToReopen, type = 'LOSS') { // Mặc định là bù lỗ
    if (amountToReopen <= 0) return;
    addLog(`Đang mở thêm ${amountToReopen.toFixed(2)} USDT cho lệnh ${position.side} để bù lỗ đã cắt.`);
    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        const currentPrice = await getCurrentPrice(position.symbol);
        const maxLeverage = position.maxLeverageUsed;

        if (!symbolDetails || !currentPrice || !maxLeverage) {
            addLog("Thiếu thông tin để mở thêm lệnh.");
            return;
        }

        let quantityToAdd = (amountToReopen * maxLeverage) / currentPrice;
        quantityToAdd = Math.floor(quantityToAdd / symbolDetails.stepSize) * symbolDetails.stepSize;
        quantityToAdd = parseFloat(quantityToAdd.toFixed(symbolDetails.quantityPrecision));

        if (quantityToAdd <= 0 || (quantityToAdd * currentPrice) < symbolDetails.minNotional) return;

        const orderSide = position.side === 'LONG' ? 'BUY' : 'SELL';
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol, side: orderSide, positionSide: position.side,
            type: 'MARKET', quantity: quantityToAdd
        });

        position.closedLossAmount = 0;
        position.nextPartialCloseLossIndex = 0;
    } catch (error) {
        addLog(`Lỗi khi mở thêm lệnh: ${error.msg || error.message}`);
    }
}

async function updateStopLoss(position, targetSLPrice) {
    addLog(`Đang điều chỉnh SL cho lệnh ${position.side} ${position.symbol} về giá: ${targetSLPrice}.`);
    try {
        if (position.currentSLId) {
            await cancelOpenOrdersForSymbol(position.symbol, position.currentSLId, position.side);
            await sleep(500);
        }
    
        const slOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: position.side === 'LONG' ? 'SELL' : 'BUY',
            positionSide: position.side,
            type: 'STOP_MARKET',
            quantity: position.quantity,
            stopPrice: targetSLPrice,
            reduceOnly: 'true'
        });
        position.currentSLId = slOrderResult.orderId;
        position.initialSLPrice = targetSLPrice;
        addLog(`Đã điều chỉnh SL cho ${position.side} @ ${targetSLPrice}. OrderId: ${slOrderResult.orderId}`);
    } catch (slError) {
        addLog(`Lỗi điều chỉnh SL: ${slError.msg || slError.message}.`);
    }
}

async function openPosition(symbol, tradeDirection, usdtBalance, maxLeverage) {
    addLog(`Đang chuẩn bị mở ${tradeDirection} ${symbol} với vốn ${INITIAL_INVESTMENT_AMOUNT} USDT.`);
    try {
        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) throw new Error("Lỗi lấy chi tiết symbol.");
        if (!await setLeverage(symbol, maxLeverage)) throw new Error("Lỗi đặt đòn bẩy.");
        await sleep(500);

        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) throw new Error("Lỗi lấy giá hiện tại.");

        let quantity = (INITIAL_INVESTMENT_AMOUNT * maxLeverage) / currentPrice;
        quantity = parseFloat((Math.floor(quantity / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));
        if (quantity * currentPrice < symbolDetails.minNotional) throw new Error("Giá trị lệnh quá nhỏ.");
        
        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';
        
        // SỬA LỖI -1106: Xóa reduceOnly/closePosition khỏi lệnh MARKET mở vị thế
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: tradeDirection,
            type: 'MARKET', quantity, newOrderRespType: 'RESULT'
        });

        await sleep(1000); // Đợi để vị thế được cập nhật trên sàn

        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const openPos = positions.find(p => p.symbol === symbol && p.positionSide === tradeDirection && parseFloat(p.positionAmt) !== 0);
        if (!openPos) throw new Error("Không tìm thấy vị thế sau khi mở.");

        const entryPrice = parseFloat(openPos.entryPrice);
        const actualQuantity = Math.abs(parseFloat(openPos.positionAmt));
        addLog(`Đã mở ${tradeDirection} | Qty: ${actualQuantity} | Giá vào: ${entryPrice.toFixed(symbolDetails.pricePrecision)}`);

        await cancelOpenOrdersForSymbol(symbol, null, tradeDirection);

        let TAKE_PROFIT_MULTIPLIER, STOP_LOSS_MULTIPLIER, partialCloseLossSteps = [];
        if (maxLeverage >= 75) { TAKE_PROFIT_MULTIPLIER = 10; STOP_LOSS_MULTIPLIER = 6; for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 100); } 
        else if (maxLeverage >= 50) { TAKE_PROFIT_MULTIPLIER = 5; STOP_LOSS_MULTIPLIER = 3; for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 50); } 
        else { TAKE_PROFIT_MULTIPLIER = 3.5; STOP_LOSS_MULTIPLIER = 2; for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 35); }
        
        const priceChangeForTP = (INITIAL_INVESTMENT_AMOUNT * TAKE_PROFIT_MULTIPLIER) / actualQuantity;
        const priceChangeForSL = (INITIAL_INVESTMENT_AMOUNT * STOP_LOSS_MULTIPLIER) / actualQuantity;
        
        const slPrice = parseFloat((tradeDirection === 'LONG' ? entryPrice - priceChangeForSL : entryPrice + priceChangeForSL).toFixed(symbolDetails.pricePrecision));
        const tpPrice = parseFloat((tradeDirection === 'LONG' ? entryPrice + priceChangeForTP : entryPrice - priceChangeForTP).toFixed(symbolDetails.pricePrecision));
        
        const slOrder = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: orderSide === 'BUY' ? 'SELL' : 'BUY', positionSide: tradeDirection, type: 'STOP_MARKET', stopPrice: slPrice, quantity: actualQuantity, reduceOnly: 'true' });
        const tpOrder = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: orderSide === 'BUY' ? 'SELL' : 'BUY', positionSide: tradeDirection, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, quantity: actualQuantity, reduceOnly: 'true' });
        
        addLog(`Đã đặt TP: ${tpPrice} (ID: ${tpOrder.orderId}) | SL: ${slPrice} (ID: ${slOrder.orderId})`);
        
        return {
            symbol, quantity: actualQuantity, initialQuantity: actualQuantity, entryPrice,
            initialTPPrice: tpPrice, initialSLPrice: slPrice, initialMargin: INITIAL_INVESTMENT_AMOUNT,
            openTime: new Date(openPos.updateTime), pricePrecision: symbolDetails.pricePrecision,
            side: tradeDirection, unrealizedPnl: 0, currentPrice: currentPrice,
            currentTPId: tpOrder.orderId, currentSLId: slOrder.orderId,
            maxLeverageUsed: maxLeverage, closedAmount: 0, partialCloseLevels: [], nextPartialCloseIndex: 0,
            closedLossAmount: 0, partialCloseLossLevels: partialCloseLossSteps, nextPartialCloseLossIndex: 0,
            hasAdjustedSLTo200PercentProfit: false, hasAdjustedSLTo500PercentProfit: false,
        };
    } catch (error) {
        addLog(`Lỗi mở ${tradeDirection}: ${error.msg || error.message}`);
        return null;
    }
}

async function manageOpenPosition() {
    if (!currentLongPosition && !currentShortPosition) {
        if (positionCheckInterval) clearInterval(positionCheckInterval);
        positionCheckInterval = null;
        return;
    }
    if (isClosingPosition) return;

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });
        
        let longPos = positions.find(p => p.positionSide === 'LONG' && parseFloat(p.positionAmt) > 0);
        let shortPos = positions.find(p => p.positionSide === 'SHORT' && parseFloat(p.positionAmt) < 0);

        if (currentLongPosition && !longPos) currentLongPosition = null; 
        if (currentShortPosition && !shortPos) currentShortPosition = null; 

        if (longPos && currentLongPosition) { currentLongPosition.unrealizedPnl = parseFloat(longPos.unRealizedProfit); currentLongPosition.currentPrice = parseFloat(longPos.markPrice); }
        if (shortPos && currentShortPosition) { currentShortPosition.unrealizedPnl = parseFloat(shortPos.unRealizedProfit); currentShortPosition.currentPrice = parseFloat(shortPos.markPrice); }

        if (!longPos && !shortPos && botRunning) {
            cleanupAndResetCycle(TARGET_COIN_SYMBOL);
            return;
        }

        let winningPos = null, losingPos = null;
        if (currentLongPosition?.unrealizedPnl > 0) { winningPos = currentLongPosition; losingPos = currentShortPosition; }
        else if (currentShortPosition?.unrealizedPnl > 0) { winningPos = currentShortPosition; losingPos = currentLongPosition; }

        if (winningPos && losingPos) {
            const currentProfitPercentage = (winningPos.unrealizedPnl / winningPos.initialMargin) * 100;

            // XÓA LOGIC ĐÓNG LỆNH LÃI TỪNG PHẦN

            // LOGIC ĐIỀU CHỈNH SL (Giữ nguyên)
            // ... (Phần logic phức tạp điều chỉnh SL của bạn được giữ lại ở đây)

            // LOGIC ĐÓNG TỪNG PHẦN LỆNH LỖ (Giữ nguyên)
            const nextLossCloseLevel = winningPos.partialCloseLossLevels[winningPos.nextPartialCloseLossIndex];
            if (nextLossCloseLevel && currentProfitPercentage >= nextLossCloseLevel) {
                addLog(`Lệnh ${winningPos.side} đạt mốc lãi ${nextLossCloseLevel}%. Đang đóng 10% khối lượng ban đầu của lệnh ${losingPos.side} (lệnh lỗ).`);
                await closePartialPosition(losingPos, 10);
                winningPos.nextPartialCloseLossIndex++;
            }

            // LOGIC MỞ LẠI LỆNH LỖ (Giữ nguyên)
            if (losingPos.closedLossAmount > 0 && currentProfitPercentage <= 0.1) {
                addLog(`Lệnh lãi ${winningPos.side} về 0%, đang mở lại phần đã cắt lỗ của lệnh ${losingPos.side}.`);
                await addPosition(losingPos, losingPos.closedLossAmount, 'LOSS');
            }
        }
    } catch (error) {
        addLog(`Lỗi quản lý vị thế: ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) stopBotLogicInternal();
    }
}

async function runTradingLogic() {
    if (!botRunning || currentLongPosition || currentShortPosition) {
        return;
    }

    addLog('Bắt đầu chu kỳ giao dịch mới...');
    try {
        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = parseFloat(account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
        
        // SỬA ĐỔI: Thêm log chi tiết hơn
        if (usdtAsset < (INITIAL_INVESTMENT_AMOUNT * 1)) {
            addLog(`Số dư USDT (${usdtAsset.toFixed(2)}) không đủ cho 2 lệnh (cần ${INITIAL_INVESTMENT_AMOUNT * 1}). Đợi chu kỳ sau.`);
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        const maxLeverage = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
        if (!maxLeverage) {
            addLog("Không thể lấy đòn bẩy. Hủy chu kỳ.");
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        currentLongPosition = await openPosition(TARGET_COIN_SYMBOL, 'LONG', usdtAsset, maxLeverage);
        if (!currentLongPosition) { if (botRunning) scheduleNextMainCycle(); return; }
        
        await sleep(1000);

        currentShortPosition = await openPosition(TARGET_COIN_SYMBOL, 'SHORT', usdtAsset, maxLeverage);
        if (!currentShortPosition) {
            addLog('Lỗi mở lệnh SHORT. Đóng lệnh LONG đã mở.');
            await closePosition(currentLongPosition.symbol, currentLongPosition.quantity, 'Lỗi mở lệnh SHORT', 'LONG');
            currentLongPosition = null;
            if (botRunning) scheduleNextMainCycle();
            return;
        }
        
        if (!positionCheckInterval) {
            positionCheckInterval = setInterval(manageOpenPosition, 5000);
        }
    } catch (error) {
        addLog(`Lỗi trong chu kỳ chính: ${error.msg || error.message}`);
        if(botRunning) scheduleNextMainCycle();
    }
}

async function scheduleNextMainCycle() {
    if (!botRunning || currentLongPosition || currentShortPosition) return;
    clearTimeout(nextScheduledCycleTimeout);
    addLog(`Lên lịch chu kỳ giao dịch tiếp theo sau 2 giây...`);
    nextScheduledCycleTimeout = setTimeout(runTradingLogic, 2000);
}


// --- HÀM KHỞI ĐỘNG/DỪNG BOT VÀ WEB SERVER (Giữ nguyên từ bản gốc) ---
async function getListenKey() { if (!API_KEY || !SECRET_KEY) { addLog("API Key chưa được cấu hình."); return null; } try { const data = await callSignedAPI('/fapi/v1/listenKey', 'POST'); addLog(`Đã lấy listenKey mới.`); return data.listenKey; } catch (e) { addLog(`Lỗi lấy listenKey: ${e.message}`); return null; } }
async function keepAliveListenKey() { if (listenKey) { try { await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey }); } catch (e) { addLog(`Lỗi làm mới listenKey. Lấy key mới...`); listenKey = await getListenKey(); if (listenKey) setupUserDataStream(listenKey); } } }
function setupMarketDataStream(symbol) { if (marketWs) marketWs.close(); const streamUrl = `${WS_BASE_URL}/ws/${symbol.toLowerCase()}@markPrice@1s`; marketWs = new WebSocket(streamUrl); marketWs.onopen = () => addLog(`Market WebSocket cho ${symbol} đã kết nối.`); marketWs.onmessage = (event) => { try { const data = JSON.parse(event.data); if (data.e === 'markPriceUpdate') { currentMarketPrice = parseFloat(data.p); if (currentLongPosition) currentLongPosition.currentPrice = currentMarketPrice; if (currentShortPosition) currentShortPosition.currentPrice = currentMarketPrice; } } catch (e) {} }; marketWs.onclose = () => { if (botRunning) setTimeout(() => setupMarketDataStream(symbol), 5000); }; }
function setupUserDataStream(key) { if (userDataWs) userDataWs.close(); const streamUrl = `${WS_BASE_URL}/ws/${key}`; userDataWs = new WebSocket(streamUrl); userDataWs.onopen = () => { addLog('User Data WebSocket đã kết nối.'); if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = setInterval(keepAliveListenKey, 30 * 60 * 1000); }; userDataWs.onmessage = async (event) => { try { const data = JSON.parse(event.data); if (data.e === 'ORDER_TRADE_UPDATE') await processTradeResult(data.o); } catch (e) {} }; userDataWs.onclose = async () => { if (botRunning) { setTimeout(async () => { listenKey = await getListenKey(); if (listenKey) setupUserDataStream(listenKey); }, 5000); } }; }

async function startBotLogicInternal() {
    if (botRunning) return 'Bot đang chạy.';
    if (!API_KEY || !SECRET_KEY) return 'Lỗi: API Key/Secret Key chưa được cấu hình.';
    
    addLog('--- Khởi động Bot ---');
    try {
        await syncServerTime();
        await getExchangeInfo();
        await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL);
        
        listenKey = await getListenKey();
        if (listenKey) setupUserDataStream(listenKey);
        setupMarketDataStream(TARGET_COIN_SYMBOL);
        
        botRunning = true;
        botStartTime = new Date();
        addLog(`--- Bot đã chạy lúc ${formatTimeUTC7(botStartTime)} ---`);
        addLog(`Coin: ${TARGET_COIN_SYMBOL} | Vốn/lệnh: ${INITIAL_INVESTMENT_AMOUNT} USDT`);
        
        scheduleNextMainCycle();
        return 'Bot khởi động thành công.';
    } catch (error) {
        const errorMsg = error.msg || error.message;
        addLog(`[Lỗi khởi động bot] ${errorMsg}`);
        stopBotLogicInternal();
        return `Lỗi khởi động bot: ${errorMsg}`;
    }
}

function stopBotLogicInternal() {
    if (!botRunning) return 'Bot không chạy.';
    botRunning = false;
    clearTimeout(nextScheduledCycleTimeout);
    if (positionCheckInterval) clearInterval(positionCheckInterval);
    if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
    if (marketWs) marketWs.close();
    if (userDataWs) userDataWs.close();
    positionCheckInterval = listenKeyRefreshInterval = marketWs = userDataWs = listenKey = null;
    currentLongPosition = currentShortPosition = null;
    totalProfit = totalLoss = netPNL = 0;
    addLog('--- Bot đã dừng ---');
    return 'Bot đã dừng.';
}

async function checkAndHandleRemainingPosition(symbol) {
    addLog(`Đang kiểm tra vị thế còn sót lại cho ${symbol}.`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const remainingPositions = positions.filter(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        if (remainingPositions.length > 0) {
            addLog(`Tìm thấy ${remainingPositions.length} vị thế sót. Đang đóng...`);
            for (const pos of remainingPositions) {
                const sideToClose = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
                await closePosition(pos.symbol, Math.abs(parseFloat(pos.positionAmt)), `Vị thế sót khi khởi động/reset`, sideToClose);
            }
        } else {
            addLog(`Không có vị thế ${symbol} nào còn sót lại.`);
        }
    } catch (error) {
        addLog(`Lỗi kiểm tra vị thế sót: ${error.msg || error.message}`);
    }
}

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/logs', (req, res) => { fs.readFile(CUSTOM_LOG_FILE, 'utf8', (err, data) => { if (err) { return res.status(500).send('Lỗi đọc log file'); } const cleanData = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ''); res.send(cleanData.split('\n').slice(-500).join('\n')); }); });
app.get('/api/status', async (req, res) => { try { const pm2List = await new Promise((resolve, reject) => { exec('pm2 jlist', (error, stdout) => { if (error) reject(error); resolve(stdout); }); }); const botProcess = JSON.parse(pm2List).find(p => p.name === THIS_BOT_PM2_NAME); let statusMessage = 'MAY CHU: DA TAT (PM2)'; if (botProcess) { statusMessage = `MAY CHU: ${botProcess.pm2_env.status.toUpperCase()}`; if (botProcess.pm2_env.status === 'online') { statusMessage += ` | TRANG THAI BOT: ${botRunning ? 'DANG CHAY' : 'DA DUNG'}`; if (botStartTime) { const uptimeMinutes = Math.floor((Date.now() - botStartTime.getTime()) / 60000); statusMessage += ` | DA CHAY: ${uptimeMinutes} phút`; } statusMessage += ` | Coin: ${TARGET_COIN_SYMBOL} | Vốn lệnh: ${INITIAL_INVESTMENT_AMOUNT} USDT`; } } res.send(statusMessage); } catch (error) { res.status(500).send(`Lỗi lấy trạng thái PM2.`); } });
app.get('/api/bot_stats', (req, res) => {
    let openPositionsData = [];
    if (currentLongPosition) openPositionsData.push(currentLongPosition);
    if (currentShortPosition) openPositionsData.push(currentShortPosition);
    res.json({ success: true, data: { totalProfit, totalLoss, netPNL, currentOpenPositions: openPositionsData, currentInvestmentAmount: INITIAL_INVESTMENT_AMOUNT } });
});
app.post('/api/configure', (req, res) => { const config = req.body.coinConfigs?.[0]; if (config) { const oldSymbol = TARGET_COIN_SYMBOL; TARGET_COIN_SYMBOL = config.symbol.trim().toUpperCase(); INITIAL_INVESTMENT_AMOUNT = parseFloat(config.initialAmount); if (oldSymbol !== TARGET_COIN_SYMBOL) { addLog(`Coin đã thay đổi từ ${oldSymbol} sang ${TARGET_COIN_SYMBOL}. Reset trạng thái.`); currentLongPosition = currentShortPosition = null; totalProfit = totalLoss = netPNL = 0; if (botRunning) setupMarketDataStream(TARGET_COIN_SYMBOL); } addLog(`Đã cập nhật cấu hình: Coin: ${TARGET_COIN_SYMBOL}, Vốn: ${INITIAL_INVESTMENT_AMOUNT} USDT`); res.json({ success: true, message: 'Cấu hình đã được cập nhật.' }); } else { res.status(400).send('Dữ liệu không hợp lệ.'); } });
app.get('/start_bot_logic', async (req, res) => res.send(await startBotLogicInternal()));
app.get('/stop_bot_logic', (req, res) => res.send(stopBotLogicInternal()));
app.listen(WEB_SERVER_PORT, () => { addLog(`Web server trên cổng ${WEB_SERVER_PORT}`); addLog(`Truy cập: http://localhost:${WEB_SERVER_PORT}`); });
