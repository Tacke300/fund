import https from 'https';
import crypto from 'crypto';
import express from 'express';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_HOST = 'fapi.binance.com';
const WS_BASE_URL = 'wss://fstream.binance.com';
const WS_USER_DATA_ENDPOINT = '/ws';

let serverTimeOffset = 0;
let exchangeInfoCache = null;
let isClosingPosition = false; // Cờ này để tránh các lệnh đóng/mở chồng chéo
let botRunning = false;
let botStartTime = null;

let currentLongPosition = null;
let currentShortPosition = null;

let positionCheckInterval = null;
let nextScheduledCycleTimeout = null;
let retryBotTimeout = null;

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

let INITIAL_INVESTMENT_AMOUNT = 0.12;
let TARGET_COIN_SYMBOL = 'HOMEUSDT';

let totalProfit = 0;
let totalLoss = 0;
let netPNL = 0;

let marketWs = null;
let userDataWs = null;
let listenKey = null;
let listenKeyRefreshInterval = null;
let currentMarketPrice = null;

const WEB_SERVER_PORT = 1111;
const THIS_BOT_PM2_NAME = 'test';
const BOT_LOG_FILE = `/home/tacke300/.pm2/logs/${THIS_BOT_PM2_NAME}-out.log`; // Đường dẫn đến log của PM2
const CUSTOM_LOG_FILE = path.join(__dirname, 'pm2.log'); // Tên file log tùy chỉnh
const LOG_TO_CUSTOM_FILE = true; // Bật/tắt ghi log vào file tùy chỉnh

function addLog(message) {
    const now = new Date();
    const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    let logEntry = `[${time}] ${message}`;
    const messageHash = crypto.createHash('md5').update(message).digest('hex');

    if (logCounts[messageHash] && (now.getTime() - logCounts[messageHash].lastLoggedTime.getTime()) >= LOG_COOLDOWN_MS) {
        logCounts[messageHash] = { count: 0, lastLoggedTime: now };
    }

    if (logCounts[messageHash]) {
        logCounts[messageHash].count++;
        if (logCounts[messageHash].count > 1) {
            console.log(`[${time}] (Lặp lại x${logCounts[messageHash].count}) ${message}`);
            if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, `[${time}] (Lặp lại x${logCounts[messageHash].count}) ${message}\n`, () => {});
        } else {
            console.log(logEntry);
            if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', () => {});
        }
        logCounts[messageHash].lastLoggedTime = now;
    } else {
        console.log(logEntry);
        if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', () => {});
        logCounts[messageHash] = { count: 1, lastLoggedTime: now };
    }
}

function formatTimeUTC7(dateObject) {
    const formatter = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
    return formatter.format(dateObject);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

async function makeHttpRequest(method, hostname, path, headers, postData = '') {
    return new Promise((resolve, reject) => {
        const options = { hostname, path, method, headers };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
                } else {
                    const errorMsg = `HTTP Error: ${res.statusCode} ${res.statusMessage}`;
                    let errorDetails = { code: res.statusCode, msg: errorMsg };
                    try { errorDetails = { ...errorDetails, ...JSON.parse(data) }; }
                    catch (e) { errorDetails.msg += ` - Raw: ${data.substring(0, 200)}`; }
                    addLog(`HTTP Request lỗi: ${errorDetails.msg}`);
                    reject(errorDetails);
                }
            });
        });
        req.on('error', (e) => {
            addLog(`Network lỗi: ${e.message}`);
            reject({ code: 'NETWORK_ERROR', msg: e.message });
        });
        if (postData) req.write(postData);
        req.end();
    });
}

async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!API_KEY || !SECRET_KEY) throw new CriticalApiError("Thiếu API_KEY hoặc SECRET_KEY. Vui lòng kiểm tra config.js.");

    const timestamp = Date.now() + serverTimeOffset;
    const recvWindow = 5000;

    let queryString = Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = createSignature(queryString, SECRET_KEY);

    let requestPath;
    let requestBody = '';
    const headers = { 'X-MBX-APIKEY': API_KEY };

    if (method === 'GET' || method === 'DELETE') {
        requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
    } else if (method === 'POST' || method === 'PUT') {
        requestPath = fullEndpointPath;
        requestBody = `${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
        throw new Error(`Phương thức không hỗ trợ: ${method}`);
    }

    try {
        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody);
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        addLog(`Lỗi API Binance (${method} ${fullEndpointPath}): ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            throw new CriticalApiError("Quá nhiều lỗi API liên tiếp, bot dừng.");
        }
        throw error;
    }
}

async function callPublicAPI(fullEndpointPath, params = {}) {
    const queryString = new URLSearchParams(params).toString();
    const fullPathWithQuery = `${fullEndpointPath}?${queryString}`;
    try {
        const rawData = await makeHttpRequest('GET', BASE_HOST, fullPathWithQuery, {});
        return JSON.parse(rawData);
    } catch (error) {
        addLog(`Lỗi API công khai: ${error.msg || error.message}`);
        throw error;
    }
}

async function syncServerTime() { try { const d = await callPublicAPI('/fapi/v1/time'); serverTimeOffset = d.serverTime - Date.now(); addLog(`Đồng bộ thời gian. Lệch: ${serverTimeOffset} ms.`); } catch (e) { addLog(`Lỗi đồng bộ thời gian: ${e.message}`); throw e; } }
async function getLeverageBracketForSymbol(symbol) { try { const r = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol }); return parseInt(r.find(i => i.symbol === symbol)?.brackets[0]?.initialLeverage); } catch (e) { addLog(`Lỗi lấy đòn bẩy: ${e.msg}`); return null; } }
async function setLeverage(symbol, leverage) { try { await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage }); return true; } catch (e) { addLog(`Lỗi đặt đòn bẩy: ${e.msg}`); return false; } }
async function getExchangeInfo() { if (exchangeInfoCache) return exchangeInfoCache; try { const d = await callPublicAPI('/fapi/v1/exchangeInfo'); exchangeInfoCache = {}; d.symbols.forEach(s => { const p = s.filters.find(f => f.filterType === 'PRICE_FILTER'); const l = s.filters.find(f => f.filterType === 'LOT_SIZE'); const m = s.filters.find(f => f.filterType === 'MIN_NOTIONAL'); exchangeInfoCache[s.symbol] = { pricePrecision: s.pricePrecision, quantityPrecision: s.quantityPrecision, tickSize: parseFloat(p?.tickSize || 0.001), stepSize: parseFloat(l?.stepSize || 0.001), minNotional: parseFloat(m?.notional || 0) }; }); addLog('Đã tải thông tin sàn.'); return exchangeInfoCache; } catch (e) { throw e; } }
async function getSymbolDetails(symbol) { const f = await getExchangeInfo(); return f?.[symbol] || null; }
async function getCurrentPrice(symbol) { try { const d = await callPublicAPI('/fapi/v1/ticker/price', { symbol }); return parseFloat(d.price); } catch (e) { addLog(`Lỗi lấy giá: ${e.message}`); return null; } }

async function cancelOpenOrdersForSymbol(symbol, positionSide = null) {
    addLog(`Đang hủy lệnh chờ cho ${symbol} (Side: ${positionSide || 'Tất cả'})...`);
    try {
        const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol });
        if (!openOrders || openOrders.length === 0) {
            addLog("Không có lệnh chờ nào để hủy.");
            return;
        }

        let ordersToCancel = openOrders;
        if (positionSide && (positionSide === 'LONG' || positionSide === 'SHORT')) {
            ordersToCancel = openOrders.filter(o => o.positionSide === positionSide);
        }

        if (ordersToCancel.length === 0) {
            addLog(`Không có lệnh chờ nào khớp với side: ${positionSide}.`);
            return;
        }

        addLog(`Tìm thấy ${ordersToCancel.length} lệnh để hủy. Bắt đầu hủy...`);
        for (const order of ordersToCancel) {
            try {
                await callSignedAPI('/fapi/v1/order', 'DELETE', {
                    symbol: symbol,
                    orderId: order.orderId,
                });
                addLog(` -> Đã hủy lệnh ${order.orderId}`);
            } catch (innerError) {
                 if (innerError.code !== -2011) { // -2011 là lỗi Order does not exist
                    addLog(`Lỗi khi hủy lệnh ${order.orderId}: ${innerError.msg || innerError.message}`);
                 }
            }
            await sleep(100); // Đợi giữa các lệnh hủy để tránh rate limit
        }
        addLog("Hoàn tất việc hủy lệnh chờ.");

    } catch (error) {
        if (error.code !== -2011) { // Lỗi -2011 có thể xảy ra nếu không có openOrders nào
            addLog(`Lỗi khi lấy danh sách lệnh chờ: ${error.msg || error.message}`);
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

    await cancelOpenOrdersForSymbol(symbol); // Hủy tất cả lệnh chờ
    await checkAndHandleRemainingPosition(symbol); // Đảm bảo không còn vị thế

    if (botRunning) {
        scheduleNextMainCycle(); // Bắt đầu chu kỳ mới nếu bot vẫn đang chạy
    }
}

async function processTradeResult(orderInfo) {
    const { s: symbol, rp: realizedPnlStr, X: orderStatus, i: orderId, ps: positionSide, p: lastPrice, q: quantity } = orderInfo;
    const realizedPnl = parseFloat(realizedPnlStr);

    if (symbol !== TARGET_COIN_SYMBOL || orderStatus !== 'FILLED') { // Chỉ xử lý lệnh đã khớp cho coin mục tiêu
        return;
    }

    addLog(`[Trade Result] Lệnh ${orderId} (${positionSide}) đã khớp. PNL: ${realizedPnl.toFixed(4)} USDT.`);

    // Cập nhật PNL ròng chỉ khi lệnh khớp là lệnh đóng vị thế
    // Lệnh mở vị thế hoặc lệnh đóng từng phần đã được xử lý PNL trong manageOpenPosition hoặc closePartialPosition
    // Đây là cách đơn giản hơn để theo dõi PNL đã *thực hiện* trên sàn
    // Lấy PNL từ API có thể chính xác hơn sau mỗi lệnh khớp.
    // Tuy nhiên, dựa vào cấu trúc hiện tại, ta sẽ cộng dồn PNL đã khớp
    // (Lưu ý: có thể có sự sai lệch nhỏ với PNL trên sàn do phí và các yếu tố khác)
    if (realizedPnl > 0) totalProfit += realizedPnl; else totalLoss += Math.abs(realizedPnl);
    netPNL = totalProfit - totalLoss;
    addLog(`PNL Ròng: ${netPNL.toFixed(2)} USDT (Lời: ${totalProfit.toFixed(2)}, Lỗ: ${totalLoss.toFixed(2)})`);


    // Logic xác định lệnh đóng chính bởi TP/SL của bot
    // Cần kiểm tra orderId có trùng với currentTPId hoặc currentSLId được bot đặt cho vị thế đó không
    const isLongClosureByBotTarget = currentLongPosition && (orderId == currentLongPosition.currentTPId || orderId == currentLongPosition.currentSLId);
    const isShortClosureByBotTarget = currentShortPosition && (orderId == currentShortPosition.currentTPId || orderId == currentShortPosition.currentSLId);

    if (isLongClosureByBotTarget || isShortClosureByBotTarget) {
        // Lệnh TP/SL chính của bot đã khớp
        addLog(`Lệnh ${orderId} là lệnh đóng chính (${positionSide}). PNL thực hiện: ${realizedPnl.toFixed(2)} USDT.`);

        const closedPositionSide = positionSide;
        const remainingPosition = (closedPositionSide === 'LONG') ? currentShortPosition : currentLongPosition;

        // Dọn dẹp vị thế vừa đóng
        if (closedPositionSide === 'LONG') {
            currentLongPosition = null;
        } else {
            currentShortPosition = null;
        }

        // Nếu lệnh lãi đã đóng bởi TP/SL chính (PNL >= 0 cho lệnh đóng đó)
        if (realizedPnl >= 0) {
             addLog(`Vị thế LÃI (${closedPositionSide}) đã đóng bởi TP/SL chính. Đang kiểm tra vị thế LỖ còn lại.`);
             if (remainingPosition) {
                 const currentLosingQtyOnExchange = Math.abs(parseFloat((await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: remainingPosition.symbol })).find(p => p.symbol === remainingPosition.symbol && p.positionSide === remainingPosition.side)?.positionAmt || 0));
                 if (currentLosingQtyOnExchange > 0) {
                      addLog(`Phát hiện vị thế LỖ ${remainingPosition.side} còn sót (${currentLosingQtyOnExchange} ${remainingPosition.symbol}). Đang đóng hoàn toàn.`);
                      await closePosition(remainingPosition.symbol, 0, `Đóng do lệnh LÃI đối ứng đã chốt`, remainingPosition.side); // Đóng toàn bộ lượng còn lại
                 } else {
                      addLog(`Vị thế LỖ ${remainingPosition.side} đã đóng hết hoặc không tồn tại trên sàn.`);
                 }
             } else {
                  addLog(`Không tìm thấy vị thế LỖ còn lại để xử lý.`);
             }
             // Sau khi lệnh lãi đóng và lệnh lỗ được xử lý (đóng nốt hoặc đã đóng), kết thúc chu kỳ.
             await cleanupAndResetCycle(symbol);

        } else { // Nếu lệnh lỗ đã đóng bởi TP/SL chính (SL bị kích hoạt)
             addLog(`Vị thế LỖ (${closedPositionSide}) đã đóng bởi TP/SL chính. Vị thế còn lại sẽ tiếp tục chạy.`);
             // Không cleanupAndResetCycle ở đây, vì lệnh còn lại (hy vọng là lệnh lãi) vẫn đang chạy.
             // manageOpenPosition sẽ tiếp tục theo dõi lệnh còn lại.
        }

    } else {
         addLog(`Lệnh ${orderId} không phải là TP/SL chính của bot. Có thể là lệnh đóng từng phần hoặc lệnh thủ công.`);
         // Logic đóng từng phần được xử lý trong manageOpenPosition và cập nhật losingPos.closedLossAmount
         // Không cần hành động đặc biệt ở đây cho lệnh đóng từng phần, chỉ cần ghi log.
    }
}


async function closePosition(symbol, quantity, reason, positionSide) {
    if (symbol !== TARGET_COIN_SYMBOL || !positionSide) return;
    // Kiểm tra isClosingPosition để tránh chạy trùng
    if (isClosingPosition) {
        //addLog(`Đang trong quá trình đóng lệnh khác, bỏ qua yêu cầu đóng ${positionSide}.`);
        return false; // Trả về false để biết yêu cầu không được thực hiện ngay
    }
    isClosingPosition = true;

    addLog(`Đang chuẩn bị đóng lệnh ${positionSide} ${symbol} (Lý do: ${reason}).`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const posOnBinance = positions.find(p => p.symbol === symbol && p.positionSide === positionSide && parseFloat(p.positionAmt) !== 0);

        if (posOnBinance) {
            // Hủy tất cả lệnh chờ liên quan đến vị thế này trước khi đóng
            await cancelOpenOrdersForSymbol(symbol, positionSide);
            await sleep(500); // Đợi lệnh hủy hoàn tất

            const qtyToClose = Math.abs(parseFloat(posOnBinance.positionAmt));
            if (qtyToClose === 0) {
                 addLog(`Vị thế ${positionSide} đã đóng hết hoặc có số lượng 0 sau khi hủy lệnh chờ.`);
                 return false;
            }
            const closeSide = (positionSide === 'LONG') ? 'SELL' : 'BUY';
            addLog(`Gửi lệnh đóng MARKET cho ${positionSide} với qty: ${qtyToClose}`);
            await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide, type: 'MARKET', quantity: qtyToClose });
            addLog(`Đã gửi lệnh đóng ${positionSide}.`);
            return true;
        } else {
            addLog(`Vị thế ${positionSide} đã được đóng hoặc không tồn tại.`);
            return false;
        }
    } catch (error) {
        addLog(`Lỗi đóng vị thế ${positionSide}: ${error.msg || error.message}`);
        return false;
    } finally {
        isClosingPosition = false;
    }
}

async function openMarketPosition(symbol, tradeDirection, usdtBalance, maxLeverage) {
    addLog(`Đang chuẩn bị mở ${tradeDirection} ${symbol} với vốn ${INITIAL_INVESTMENT_AMOUNT} USDT.`);
    try {
        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) throw new Error("Lỗi lấy chi tiết symbol.");
        if (!await setLeverage(symbol, maxLeverage)) throw new Error("Lỗi đặt đòn bẩy.");

        await sleep(200);

        const currentPrice = await getCurrentPrice(symbol); // Lấy giá hiện tại để dùng làm pairEntryPrice
        if (!currentPrice) throw new Error("Lỗi lấy giá hiện tại.");

        let quantity = (INITIAL_INVESTMENT_AMOUNT * maxLeverage) / currentPrice;
        quantity = parseFloat((Math.floor(quantity / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));
        if (quantity * currentPrice < symbolDetails.minNotional) {
             addLog(`Giá trị lệnh quá nhỏ: ${quantity * currentPrice}. Tối thiểu: ${symbolDetails.minNotional}`);
             throw new Error("Giá trị lệnh quá nhỏ.");
        }

        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: tradeDirection,
            type: 'MARKET', quantity,
        });

        await sleep(1500); // Đợi một chút để lệnh khớp và vị thế hiển thị trên sàn

        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const openPos = positions.find(p => p.symbol === symbol && p.positionSide === tradeDirection && parseFloat(p.positionAmt) !== 0);
        if (!openPos) {
             // Nếu không tìm thấy vị thế ngay lập tức, thử lại một vài lần
             addLog("Không tìm thấy vị thế sau khi gửi lệnh MARKET. Thử lại kiểm tra...");
             await sleep(1000); // Đợi thêm
             const positionsRetry = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
             const openPosRetry = positionsRetry.find(p => p.symbol === symbol && p.positionSide === tradeDirection && parseFloat(p.positionAmt) !== 0);
             if (!openPosRetry) {
                 throw new Error("Không tìm thấy vị thế sau khi thử lại kiểm tra.");
             }
             openPos = openPosRetry; // Dùng kết quả retry
        }


        const entryPrice = parseFloat(openPos.entryPrice);
        const actualQuantity = Math.abs(parseFloat(openPos.positionAmt));
        addLog(`Đã mở ${tradeDirection} | Qty: ${actualQuantity} | Giá vào: ${entryPrice.toFixed(symbolDetails.pricePrecision)}`);

        return {
            symbol, quantity: actualQuantity, initialQuantity: actualQuantity, entryPrice, // initialQuantity: dùng để tính toán các mốc đóng từng phần
            initialMargin: INITIAL_INVESTMENT_AMOUNT, side: tradeDirection, maxLeverageUsed: maxLeverage,
            pricePrecision: symbolDetails.pricePrecision, openTime: new Date(openPos.updateTime),
            closedLossAmount: 0, // Tổng khối lượng đã đóng của lệnh lỗ
            nextPartialCloseLossIndex: 0, // Chỉ số mốc đóng lỗ tiếp theo
            hasAdjustedSLToSpecificLevel: {}, // Object để lưu trạng thái điều chỉnh SL/TP cho các mốc cụ thể
            hasClosedAllLossPositionAtLastLevel: false, // Cờ hiệu để biết đã đóng hoàn toàn lệnh lỗ ở mốc cuối cùng chưa
            pairEntryPrice: currentPrice // Dùng giá thị trường tại thời điểm mở lệnh đầu tiên của cặp làm giá vào của cặp
        };
    } catch (error) {
        addLog(`Lỗi khi mở lệnh MARKET ${tradeDirection}: ${error.msg || error.message}`);
        return null;
    }
}

async function setInitialTPAndSL(position) {
    if (!position) return false;
    const { symbol, side, quantity, entryPrice, initialMargin, maxLeverageUsed, pricePrecision, initialQuantity } = position; // initialQuantity cần để đặt lệnh TP/SL ban đầu
    addLog(`Đang đặt TP/SL ban đầu cho vị thế ${side}...`);
    try {
        await cancelOpenOrdersForSymbol(symbol, side); // Hủy bất kỳ lệnh chờ nào của vị thế này

        let TAKE_PROFIT_MULTIPLIER, STOP_LOSS_MULTIPLIER, partialCloseLossSteps = [];
        if (maxLeverageUsed >= 75) {
            TAKE_PROFIT_MULTIPLIER = 10;
            STOP_LOSS_MULTIPLIER = 6;
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 100); // Mốc 100%, 200%, ..., 800%
        }
        else if (maxLeverageUsed >= 50) {
            TAKE_PROFIT_MULTIPLIER = 5;
            STOP_LOSS_MULTIPLIER = 3;
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 50); // Mốc 50%, 100%, ..., 400%
        }
        else {
            TAKE_PROFIT_MULTIPLIER = 3.5;
            STOP_LOSS_MULTIPLIER = 2;
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 35); // Mốc 35%, 70%, ..., 280%
        }

        const priceChangeForTP = (initialMargin * TAKE_PROFIT_MULTIPLIER) / initialQuantity; // Tính toán dựa trên initialQuantity
        const priceChangeForSL = (initialMargin * STOP_LOSS_MULTIPLIER) / initialQuantity; // Tính toán dựa trên initialQuantity

        const slPrice = parseFloat((side === 'LONG' ? entryPrice - priceChangeForSL : entryPrice + priceChangeForSL).toFixed(pricePrecision));
        const tpPrice = parseFloat((side === 'LONG' ? entryPrice + priceChangeForTP : entryPrice - priceChangeForTP).toFixed(pricePrecision));

        const orderSide = (side === 'LONG') ? 'SELL' : 'BUY';

        // Đặt lệnh SL và TP với số lượng ban đầu của vị thế (initialQuantity)
        const slOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: side, type: 'STOP_MARKET',
            stopPrice: slPrice, quantity: initialQuantity, // Sử dụng initialQuantity
            timeInForce: 'GTC' // Good Till Cancelled
        });
        const tpOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: side, type: 'TAKE_PROFIT_MARKET',
            stopPrice: tpPrice, quantity: initialQuantity, // Sử dụng initialQuantity
            timeInForce: 'GTC'
        });

        addLog(`Đã đặt TP/SL ban đầu cho ${side}: TP=${tpPrice.toFixed(pricePrecision)}, SL=${slPrice.toFixed(pricePrecision)}`);

        position.initialTPPrice = tpPrice;
        position.initialSLPrice = slPrice;
        position.currentTPId = tpOrder.orderId;
        position.currentSLId = slOrder.orderId;
        position.partialCloseLossLevels = partialCloseLossSteps; // Gán mảng các mốc % lãi
        // Reset các cờ và index nếu đây là thiết lập lại
        position.closedLossAmount = 0;
        position.nextPartialCloseLossIndex = 0;
        position.hasAdjustedSLToSpecificLevel = {}; // Reset cờ điều chỉnh SL/TP
        position.hasClosedAllLossPositionAtLastLevel = false; // Reset cờ đóng hoàn toàn

        return true;
    } catch (error) {
        addLog(`Lỗi nghiêm trọng khi đặt TP/SL ban đầu cho ${side}: ${error.msg || error.message}.`);
        return false;
    }
}

// Hàm này sẽ hủy lệnh SL/TP cũ và đặt lệnh mới cho số lượng *còn lại* của vị thế
async function updateStopLimitOrder(position, newPrice, type) {
    // type có thể là 'STOP' (cho STOP_MARKET) hoặc 'TAKE_PROFIT' (cho TAKE_PROFIT_MARKET)
    const { symbol, side, currentSLId, currentTPId, pricePrecision } = position;
    const orderIdToCancel = (type === 'STOP') ? currentSLId : currentTPId;
    const orderSide = (side === 'LONG') ? 'SELL' : 'BUY';

    // Không cập nhật TP nếu yêu cầu là TP (theo yêu cầu người dùng)
    if (type === 'TAKE_PROFIT') {
        // addLog(`Yêu cầu cập nhật TP cho ${side} bị bỏ qua theo cấu hình.`);
        return position.currentTPId; // Trả về ID cũ, coi như không thay đổi
    }

    try {
        if (orderIdToCancel) {
            try {
                await callSignedAPI('/fapi/v1/order', 'DELETE', {
                    symbol: symbol,
                    orderId: orderIdToCancel,
                });
                addLog(`Đã hủy lệnh ${type} cũ ${orderIdToCancel} cho ${side}.`);
            } catch (innerError) {
                if (innerError.code === -2011) { // Lỗi "Order does not exist" là bình thường nếu lệnh đã khớp/hủy rồi
                    //addLog(`Lệnh ${type} cũ ${orderIdToCancel} cho ${side} đã không tồn tại hoặc đã bị hủy.`);
                } else {
                    addLog(`Lỗi khi hủy lệnh ${type} cũ ${orderIdToCancel} cho ${side}: ${innerError.msg || innerError.message}`);
                    // throw innerError; // Có thể ném lỗi để xử lý ở trên nếu cần
                }
            }
        }

        const symbolDetails = await getSymbolDetails(symbol);
        // Lấy số lượng vị thế hiện tại từ sàn để đặt lệnh đóng hoàn toàn phần còn lại
        const currentPositionOnExchange = (await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: symbol }))
            .find(p => p.symbol === symbol && p.positionSide === side);
        const actualQuantity = Math.abs(parseFloat(currentPositionOnExchange?.positionAmt || 0));

        if (actualQuantity === 0) {
             addLog(`Vị thế ${side} đã đóng hết, không thể đặt lệnh ${type} mới.`);
             if (type === 'STOP') position.currentSLId = null;
             // if (type === 'TAKE_PROFIT') position.currentTPId = null; // Không cần vì TP không update
             return null; // Trả về null để biết lệnh không được đặt
        }

        // Đảm bảo quantity được làm tròn theo stepSize
        const quantityToUse = parseFloat((Math.floor(actualQuantity / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));

        if (quantityToUse <= 0) {
            addLog(`Số lượng để đặt lệnh ${type} mới quá nhỏ hoặc không hợp lệ (${quantityToUse}).`);
             if (type === 'STOP') position.currentSLId = null;
             // if (type === 'TAKE_PROFIT') position.currentTPId = null; // Không cần vì TP không update
            return null; // Trả về null để biết lệnh không được đặt
        }
        
        const stopPriceFormatted = parseFloat(newPrice.toFixed(pricePrecision));

        const newOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: side,
            type: `${type}_MARKET`, // STOP_MARKET hoặc TAKE_PROFIT_MARKET
            stopPrice: stopPriceFormatted,
            quantity: quantityToUse, // Sử dụng số lượng thực tế hiện có của vị thế
            timeInForce: 'GTC',
            newClientOrderId: `${type.toUpperCase()}-${side}-${Date.now()}` // Client ID duy nhất
        });
        addLog(`Đã đặt lệnh ${type} mới cho ${side} ở giá ${stopPriceFormatted}. Order ID: ${newOrder.orderId}`);

        // Cập nhật ID lệnh mới vào trạng thái bot
        if (type === 'STOP') position.currentSLId = newOrder.orderId;
        // if (type === 'TAKE_PROFIT') position.currentTPId = newOrder.orderId; // Không cần vì TP không update

        return newOrder.orderId; // Trả về ID của lệnh mới
    } catch (error) {
        addLog(`Lỗi khi cập nhật lệnh ${type} cho ${side}: ${error.msg || error.message}`);
        // Nếu có lỗi khi đặt lệnh mới, cần hủy ID lệnh cũ (nếu đã hủy thành công ở trên)
        // và set ID hiện tại thành null để biết không có lệnh chờ nào đang được bot quản lý
        if (type === 'STOP') position.currentSLId = null;
        // if (type === 'TAKE_PROFIT') position.currentTPId = null; // Không cần vì TP không update
        return null;
    }
}

// Hàm đóng một phần vị thế
async function closePartialPosition(position, percentageToClose) {
    if (!position || isClosingPosition) {
         // addLog(`Không đóng từng phần ${position?.side} do không tồn tại hoặc đang đóng lệnh khác.`);
        return false;
    }
    isClosingPosition = true;

    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) throw new Error("Không lấy được chi tiết symbol khi đóng từng phần.");

        const currentPositionsOnExchange = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: position.symbol });
        const posOnBinance = currentPositionsOnExchange.find(p => p.symbol === position.symbol && p.positionSide === position.side);
        const currentQty = Math.abs(parseFloat(posOnBinance?.positionAmt || 0));

        if (currentQty === 0) {
            addLog(`Vị thế ${position.side} đã đóng hết trên sàn, không cần đóng từng phần.`);
            position.closedLossAmount = position.initialQuantity; // Cập nhật trạng thái bot coi như đã đóng hết lượng ban đầu
            position.hasClosedAllLossPositionAtLastLevel = true; // Đánh dấu đã đóng hết
            return false;
        }

        // Tính toán số lượng cần đóng dựa trên phần trăm của initialQuantity
        let quantityToClose = position.initialQuantity * percentageToClose;

        // Đảm bảo không đóng nhiều hơn lượng còn lại trên sàn
        quantityToClose = Math.min(quantityToClose, currentQty);

        // Đảm bảo số lượng cần đóng lớn hơn 0 và đủ minQty (nếu có)
        // MinQty cho lệnh MARKET thường rất nhỏ, chủ yếu theo stepSize
        if (quantityToClose <= 0) {
            addLog(`Số lượng đóng từng phần quá nhỏ hoặc không hợp lệ: ${quantityToClose}. Hoặc không có gì để đóng.`);
            return false;
        }

        // Làm tròn số lượng theo stepSize của sàn
        quantityToClose = parseFloat((Math.floor(quantityToClose / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));

        if (quantityToClose <= 0) { // Kiểm tra lại sau khi làm tròn
             addLog(`Số lượng đóng từng phần sau làm tròn quá nhỏ (${quantityToClose}).`);
            return false;
        }


        const orderSide = (position.side === 'LONG') ? 'SELL' : 'BUY';

        addLog(`Đang đóng ${percentageToClose * 100}% (${quantityToClose.toFixed(symbolDetails.quantityPrecision)} ${position.symbol}) của lệnh ${position.side} lỗ.`);

        // Hủy lệnh SL/TP hiện tại của lệnh lỗ trước khi đóng từng phần để tránh lỗi
        // Lệnh mới sẽ được đặt lại bởi manageOpenPosition hoặc setInitialTPAndSL sau này
        await cancelOpenOrdersForSymbol(position.symbol, position.side);
        position.currentSLId = null; // Xóa ID SL hiện tại
        position.currentTPId = null; // Xóa ID TP hiện tại (mặc dù TP không update, hủy để đảm bảo không có lệnh chờ nào)
        await sleep(500); // Đợi một chút sau khi hủy

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: orderSide,
            positionSide: position.side,
            type: 'MARKET',
            quantity: quantityToClose,
        });

        position.closedLossAmount += quantityToClose; // Cập nhật tổng khối lượng đã đóng của lệnh lỗ
        addLog(`Đã gửi lệnh đóng ${quantityToClose.toFixed(symbolDetails.quantityPrecision)} ${position.symbol}. Tổng đã đóng: ${position.closedLossAmount.toFixed(symbolDetails.quantityPrecision)}`);

        // Sau khi đóng 1 phần, SL/TP cần được đặt lại cho số lượng còn lại
        // Việc này sẽ được xử lý trong manageOpenPosition ở chu kỳ tiếp theo
        // Tuy nhiên, để đảm bảo, ta có thể đặt lại SL/TP ban đầu ở đây nếu cần thiết
        // Nhưng logic trong manageOpenPosition check và update SL/TP liên tục nên có thể bỏ qua bước này.
        // Để an toàn, ta sẽ đảm bảo manageOpenPosition luôn được gọi sau mỗi lệnh đóng từng phần.

        return true;
    } catch (error) {
        addLog(`Lỗi khi đóng một phần vị thế ${position.side}: ${error.msg || error.message}`);
        return false;
    } finally {
        isClosingPosition = false;
    }
}

// Hàm tăng khối lượng vị thế (mở lại phần đã đóng)
async function addPosition(position, quantityToAdd) {
    if (!position || quantityToAdd <= 0 || isClosingPosition) {
        // addLog(`Không mở lại lệnh ${position?.side} do không tồn tại, số lượng <= 0, hoặc đang đóng lệnh khác.`);
        return false;
    }
    isClosingPosition = true; // Đặt cờ đang xử lý

    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) throw new Error("Không lấy được chi tiết symbol khi mở lại lệnh.");

        const currentPositionsOnExchange = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: position.symbol });
        const posOnBinance = currentPositionsOnExchange.find(p => p.symbol === position.symbol && p.positionSide === position.side);
        const currentQty = Math.abs(parseFloat(posOnBinance?.positionAmt || 0));

        // Tính toán số lượng cần mở lại, đảm bảo không vượt quá lượng ban đầu
        // Lượng cần mở lại là lượng đã đóng (quantityToAdd)
        let effectiveQuantityToAdd = quantityToAdd;

        // Tính toán số lượng tối đa có thể mở thêm để không vượt quá initialQuantity
        const maxQtyAllowedToAdd = position.initialQuantity - currentQty;
        effectiveQuantityToAdd = Math.min(effectiveQuantityToAdd, maxQtyAllowedToAdd);


        if (effectiveQuantityToAdd <= 0) {
            addLog(`Số lượng cần mở lại quá nhỏ (${effectiveQuantityToAdd}) hoặc khối lượng hiện tại đã đạt/vượt quá ban đầu.`);
            isClosingPosition = false; // Reset cờ
            return false;
        }
        
        // Làm tròn số lượng theo stepSize của sàn
        effectiveQuantityToAdd = parseFloat((Math.floor(effectiveQuantityToAdd / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));

         if (effectiveQuantityToAdd <= 0) { // Kiểm tra lại sau làm tròn
             addLog(`Số lượng cần mở lại sau làm tròn quá nhỏ (${effectiveQuantityToAdd}).`);
             isClosingPosition = false; // Reset cờ
             return false;
         }


        const orderSide = (position.side === 'LONG') ? 'BUY' : 'SELL'; // Side để tăng vị thế (ngược với side của vị thế khi đóng)

        addLog(`Đang mở lại ${effectiveQuantityToAdd.toFixed(symbolDetails.quantityPrecision)} ${position.symbol} cho lệnh ${position.side} (phần đã cắt lỗ).`);

        // Hủy lệnh SL/TP hiện tại của lệnh lỗ trước khi mở thêm để tránh lỗi
        // Lệnh mới sẽ được đặt lại bởi setInitialTPAndSL sau khi mở thành công
        await cancelOpenOrdersForSymbol(position.symbol, position.side);
        position.currentSLId = null; // Xóa ID SL hiện tại
        position.currentTPId = null; // Xóa ID TP hiện tại
         await sleep(500); // Đợi một chút sau khi hủy

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: orderSide,
            positionSide: position.side, // PositionSide vẫn là side của vị thế (LONG/SHORT)
            type: 'MARKET',
            quantity: effectiveQuantityToAdd,
        });

        // Sau khi lệnh mở lại khớp (xử lý trong processTradeResult), closedLossAmount sẽ được giảm.
        // Tạm thời ghi log, chờ processTradeResult xác nhận lệnh khớp
        addLog(`Đã gửi lệnh mở lại ${effectiveQuantityToAdd.toFixed(symbolDetails.quantityPrecision)} ${position.symbol}. Chờ lệnh khớp để cập nhật trạng thái.`);

        // Không cập nhật position.closedLossAmount ngay ở đây, chờ lệnh khớp.
        // Tuy nhiên, logic reset cờ và đặt lại TP/SL cần được thực hiện SAU KHI lệnh mở lại khớp và
        // processTradeResult đã chạy HOẶC SAU MỘT KHOẢNG THỜI GIAN CHẮC CHẮN LỆNH ĐÃ KHỚP.
        // Cách đơn giản nhất là reset và đặt lại SL/TP ngay sau khi gửi lệnh,
        // giả định lệnh MARKET sẽ khớp gần như ngay lập tức.
        // Reset trạng thái để bắt đầu chu trình mới cho cặp lệnh
        position.closedLossAmount -= effectiveQuantityToAdd; // Giảm khối lượng đã đóng ngay sau khi gửi lệnh
        if (position.closedLossAmount < 0) position.closedLossAmount = 0; // Đảm bảo không âm
        addLog(`Tổng khối lượng lệnh lỗ ${position.side} đã đóng còn lại: ${position.closedLossAmount.toFixed(symbolDetails.quantityPrecision)}`);


        // !!! QUAN TRỌNG: Sau khi mở lại thành công một phần lệnh lỗ, cần reset toàn bộ trạng thái
        // đóng từng phần và điều chỉnh SL/TP để chu trình bắt đầu lại từ đầu.
        // Đây là nơi reset index và cờ, VÀ đặt lại SL/TP ban đầu cho CẢ HAI vị thế.
        // Tìm vị thế đối ứng
        const winningPos = (position.side === 'LONG' && currentShortPosition) ? currentShortPosition :
                           (position.side === 'SHORT' && currentLongPosition) ? currentLongPosition : null;

        if (winningPos) {
             addLog("Mở lại lệnh lỗ thành công. Đang reset trạng thái và đặt lại TP/SL ban đầu cho cặp lệnh...");
             winningPos.nextPartialCloseLossIndex = 0;
             winningPos.hasAdjustedSLToSpecificLevel = {}; // Reset tất cả cờ điều chỉnh SL/TP
             // losingPos.hasClosedAllLossPositionAtLastLevel không cần reset nếu nó chưa từng là true
             position.hasClosedAllLossPositionAtLastLevel = false; // Đảm bảo cờ này sai khi mở lại

             // Đặt lại SL/TP ban đầu cho cả 2 lệnh
             await sleep(1000); // Đợi một chút trước khi đặt lại lệnh
             await setInitialTPAndSL(winningPos);
             await sleep(500);
             await setInitialTPAndSL(position); // position ở đây là losingPos
             addLog("Đã hoàn tất reset trạng thái và đặt lại TP/SL ban đầu.");
        } else {
             addLog("Mở lại lệnh lỗ thành công, nhưng không tìm thấy lệnh đối ứng để reset trạng thái cặp.");
             // Trong trường hợp này, chỉ reset trạng thái của lệnh lỗ được mở lại?
             // Hoặc đây là trạng thái lỗi mà bot cần xử lý khác?
             // Giả định luôn có cặp lệnh khi bot chạy.
        }

        return true;
    } catch (error) {
        addLog(`Lỗi khi mở lại một phần vị thế ${position.side}: ${error.msg || error.message}`);
        return false;
    } finally {
        isClosingPosition = false; // Reset cờ bất kể thành công hay thất bại
    }
}


async function runTradingLogic() {
    if (!botRunning || currentLongPosition || currentShortPosition) {
        // addLog("Không chạy chu kỳ mới: Bot không running HOẶC đã có vị thế mở.");
        return; // Không chạy nếu bot không active hoặc đã có vị thế mở
    }

    addLog('Bắt đầu chu kỳ giao dịch mới...');
    try {
        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = parseFloat(account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);

        // Kiểm tra đủ tiền cho 1 lệnh (lệnh thứ 2 mở ngay sau đó)
        const requiredAmount = INITIAL_INVESTMENT_AMOUNT;
        if (usdtAsset < requiredAmount) {
            addLog(`Số dư USDT (${usdtAsset.toFixed(2)}) không đủ cho lệnh (cần ${requiredAmount.toFixed(2)}). Đợi chu kỳ sau.`);
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        const maxLeverage = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
        if (!maxLeverage) {
            addLog("Không thể lấy đòn bẩy. Hủy chu kỳ.");
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        // Lấy giá thị trường trước khi mở lệnh để làm giá vào của cặp
        const initialPairPrice = await getCurrentPrice(TARGET_COIN_SYMBOL);
        if (!initialPairPrice) {
            addLog("Không thể lấy giá thị trường ban đầu. Hủy chu kỳ.");
            if (botRunning) scheduleNextMainCycle();
            return;
        }


        // Mở lệnh LONG trước
        const longPositionData = await openMarketPosition(TARGET_COIN_SYMBOL, 'LONG', usdtAsset, maxLeverage);
        if (!longPositionData) {
            addLog("Mở lệnh LONG thất bại, hủy chu kỳ.");
            if (botRunning) scheduleNextMainCycle();
            return;
        }
        currentLongPosition = longPositionData;
        // Lưu giá ban đầu của cặp vào cả hai vị thế
        currentLongPosition.pairEntryPrice = initialPairPrice;


        // Đợi một chút trước khi mở lệnh thứ 2 để tránh rate limit
        await sleep(1000);

        // Mở lệnh SHORT
        const shortPositionData = await openMarketPosition(TARGET_COIN_SYMBOL, 'SHORT', usdtAsset, maxLeverage);
        if (!shortPositionData) {
            addLog('Mở lệnh SHORT thất bại. Đóng lệnh LONG đã mở.');
            // Sử dụng closePosition để đóng toàn bộ lệnh LONG
            await closePosition(currentLongPosition.symbol, 0, 'Lỗi mở lệnh SHORT', 'LONG');
            currentLongPosition = null; // Đảm bảo trạng thái bot được cập nhật
            if (botRunning) scheduleNextMainCycle();
            return;
        }
        currentShortPosition = shortPositionData;
        // Lưu giá ban đầu của cặp vào cả hai vị thế
        currentShortPosition.pairEntryPrice = initialPairPrice;


        addLog("Đã mở thành công cả hai vị thế. Đợi 3 giây để đặt TP/SL...");
        await sleep(3000);

        // Đặt TP/SL ban đầu cho lệnh LONG
        const isLongTPSLSet = await setInitialTPAndSL(currentLongPosition);
        if (!isLongTPSLSet) {
             addLog("Đặt TP/SL cho LONG thất bại. Đóng cả hai vị thế.");
             await closePosition(currentLongPosition.symbol, 0, 'Lỗi đặt TP/SL', 'LONG');
             await closePosition(currentShortPosition.symbol, 0, 'Lỗi đặt TP/SL', 'SHORT');
             await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
             return;
        }

        // Đợi một chút trước khi đặt SL/TP lệnh thứ 2
        await sleep(1000);

        // Đặt TP/SL ban đầu cho lệnh SHORT
        const isShortTPSLSet = await setInitialTPAndSL(currentShortPosition);
         if (!isShortTPSLSet) {
             addLog("Đặt TP/SL cho SHORT thất bại. Đóng cả hai vị thế.");
             await closePosition(currentLongPosition.symbol, 0, 'Lỗi đặt TP/SL', 'LONG');
             await closePosition(currentShortPosition.symbol, 0, 'Lỗi đặt TP/SL', 'SHORT');
             await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
             return;
        }

        addLog("Đã đặt TP/SL cho cả hai vị thế. Bắt đầu theo dõi.");
        // Bắt đầu interval kiểm tra vị thế và điều chỉnh SL/TP
        if (!positionCheckInterval) {
            positionCheckInterval = setInterval(manageOpenPosition, 3000); // Kiểm tra mỗi 3 giây
        }
    } catch (error) {
        addLog(`Lỗi trong chu kỳ chính: ${error.msg || error.message}`);
        if(botRunning) scheduleNextMainCycle(); // Thử lại ở chu kỳ tiếp theo
    }
}

const manageOpenPosition = async () => {
    // Nếu cả hai vị thế đã null, tức là không có lệnh nào đang mở từ bot, dừng interval
    if (!currentLongPosition && !currentShortPosition) {
        if (positionCheckInterval) clearInterval(positionCheckInterval);
        positionCheckInterval = null;
        addLog("Không còn vị thế mở để theo dõi. Dừng kiểm tra vị thế.");
        // Nếu bot vẫn đang chạy, lên lịch chu kỳ mới
        if(botRunning) scheduleNextMainCycle();
        return;
    }
    // Ngăn chặn chạy nhiều lần nếu đang có lệnh đóng/mở khác đang được xử lý
    if (isClosingPosition) {
         //addLog("Đang xử lý lệnh khác, bỏ qua manageOpenPosition.");
        return;
    }

    try {
        // Lấy thông tin vị thế hiện tại từ sàn
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });

        let longPosOnExchange = positions.find(p => p.positionSide === 'LONG' && parseFloat(p.positionAmt) > 0);
        let shortPosOnExchange = positions.find(p => p.positionSide === 'SHORT' && parseFloat(p.positionAmt) < 0);

        // Cập nhật trạng thái PNL và giá hiện tại cho các vị thế đang được bot theo dõi
        if (currentLongPosition) {
             if(longPosOnExchange){
                currentLongPosition.unrealizedPnl = parseFloat(longPosOnExchange.unRealizedProfit);
                currentLongPosition.currentPrice = parseFloat(longPosOnExchange.markPrice);
             } else {
                 // Vị thế LONG không còn trên sàn nhưng trạng thái bot vẫn còn -> cập nhật
                 addLog(`Vị thế LONG không còn trên sàn. Cập nhật trạng thái bot.`);
                 currentLongPosition = null;
             }
        }
         if (currentShortPosition) {
             if(shortPosOnExchange){
                currentShortPosition.unrealizedPnl = parseFloat(shortPosOnExchange.unRealizedProfit);
                currentShortPosition.currentPrice = parseFloat(shortPosOnExchange.markPrice);
            } else {
                 // Vị thế SHORT không còn trên sàn nhưng trạng thái bot vẫn còn -> cập nhật
                 addLog(`Vị thế SHORT không còn trên sàn. Cập nhật trạng thái bot.`);
                 currentShortPosition = null;
             }
         }


        // Nếu cả hai vị thế đều đã đóng (sau khi cập nhật), reset và bắt đầu chu kỳ mới
        if (!currentLongPosition && !currentShortPosition) {
            addLog("Cả hai vị thế đã đóng. Kết thúc chu kỳ.");
            // cleanupAndResetCycle đã được gọi bởi processTradeResult khi lệnh thắng đóng
            // Hoặc sẽ được gọi ở đây nếu cả hai lệnh đóng do SL
            // Để an toàn, ta sẽ gọi cleanup ở đây nếu cả hai đều null
            if (botRunning) cleanupAndResetCycle(TARGET_COIN_SYMBOL);
            return; // Dừng thực thi manageOpenPosition hiện tại
        }

        let winningPos = null;
        let losingPos = null;

        // Xác định lệnh lãi và lệnh lỗ (nếu có cả hai)
        if (currentLongPosition?.unrealizedPnl > 0 && currentShortPosition?.unrealizedPnl <= 0) {
            winningPos = currentLongPosition;
            losingPos = currentShortPosition;
        } else if (currentShortPosition?.unrealizedPnl > 0 && currentLongPosition?.unrealizedPnl <= 0) {
            winningPos = currentShortPosition;
            losingPos = currentLongPosition;
        } else if (currentLongPosition?.unrealizedPnl > 0 && currentShortPosition?.unrealizedPnl > 0) {
             // Cả hai cùng lãi (hiếm gặp với initial entry gần nhau)
             // Xác định lệnh "lãi hơn" là winning, lệnh "lãi ít hơn" là losing tạm thời?
             // Hoặc coi lệnh lãi nhiều hơn là winningPos và lệnh lãi ít hơn là losingPos để áp dụng logic?
             // Giả sử chiến lược chỉ áp dụng khi có 1 lãi 1 lỗ rõ ràng. Bỏ qua trường hợp cả 2 cùng lãi/cùng lỗ.
             //addLog("Cả hai vị thế đều lãi/lỗ. Bỏ qua logic điều chỉnh SL/TP/đóng từng phần.");
             // Nếu cả hai cùng lãi, không có "losingPos" để cắt, và không có "winningPos" để dựa vào mốc lãi cho lệnh lỗ.
             // Giữ nguyên TP/SL ban đầu.
             return; // Thoát khỏi hàm nếu không có cặp lãi/lỗ rõ ràng
        }


        // Chỉ xử lý khi CÓ CẢ LỆNH LÃI VÀ LỆNH LỖ
        if (winningPos && losingPos && winningPos.partialCloseLossLevels) {
            const currentProfitPercentage = (winningPos.unrealizedPnl / winningPos.initialMargin) * 100;

            // Xác định các mốc đóng từng phần cần thiết (ví dụ Mốc 5, Mốc 8)
            // Đảm bảo các chỉ số này hợp lệ (>= 0 và < chiều dài mảng)
            const PARTIAL_CLOSE_INDEX_5 = 4; // Index của Mốc 5
            const PARTIAL_CLOSE_INDEX_8 = 7; // Index của Mốc 8

            const PARTIAL_CLOSE_LEVEL_5 = winningPos.partialCloseLossLevels[PARTIAL_CLOSE_INDEX_5];
            const PARTIAL_CLOSE_LEVEL_8 = winningPos.partialCloseLossLevels[PARTIAL_CLOSE_INDEX_8];

            // --- Logic đóng từng phần lệnh lỗ dựa trên Mốc lãi của lệnh lãi ---
            const nextCloseLevel = winningPos.partialCloseLossLevels[winningPos.nextPartialCloseLossIndex];
            if (nextCloseLevel !== undefined && currentProfitPercentage >= nextCloseLevel) {
                // Chỉ đóng nếu lệnh lỗ chưa đóng hoàn toàn ở mốc cuối cùng (Mốc 8)
                if (!losingPos.hasClosedAllLossPositionAtLastLevel) {
                    let percentageToClose = 0.10; // Mặc định đóng 10% của initialQuantity

                    if (winningPos.nextPartialCloseLossIndex === PARTIAL_CLOSE_INDEX_5) {
                        // Ở Mốc 5, đóng 20% của initialQuantity
                        percentageToClose = 0.20;
                        addLog(`Lệnh ${winningPos.side} đạt Mốc ${nextCloseLevel}%. Đang đóng 20% khối lượng ban đầu của lệnh ${losingPos.side} (lệnh lỗ).`);
                    } else if (winningPos.nextPartialCloseLossIndex === PARTIAL_CLOSE_INDEX_8) {
                         // Ở Mốc 8, đóng 100% phần còn lại của initialQuantity
                         percentageToClose = 1.00; // Tín hiệu đóng hết phần còn lại
                         addLog(`Lệnh ${winningPos.side} đạt Mốc ${nextCloseLevel}%. Đang đóng 100% phần còn lại của lệnh ${losingPos.side} (lệnh lỗ).`);
                    } else if (winningPos.nextPartialCloseLossIndex < winningPos.partialCloseLossLevels.length) {
                         // Các mốc khác (1-4, 6-7), đóng 10% của initialQuantity
                        percentageToClose = 0.10;
                         addLog(`Lệnh ${winningPos.side} đạt Mốc ${nextCloseLevel}%. Đang đóng 10% khối lượng ban đầu của lệnh ${losingPos.side} (lệnh lỗ).`);
                    } else {
                        // Đã qua tất cả các mốc đóng từng phần đã định nghĩa
                        // addLog(`Đã qua tất cả các mốc đóng từng phần cho lệnh lãi ${winningPos.side}.`);
                         winningPos.nextPartialCloseLossIndex++; // Đảm bảo index không bị kẹt
                        return; // Không làm gì thêm về đóng từng phần ở đây
                    }


                    // Kiểm tra xem vị thế lỗ còn tồn tại trên sàn không trước khi cố gắng đóng
                    const currentLosingQtyOnExchange = Math.abs(parseFloat((await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: losingPos.symbol })).find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || 0));

                    if (currentLosingQtyOnExchange > 0) {
                        // Nếu percentageToClose là 1.00, tính toán số lượng cần đóng là số lượng CÒN LẠI trên sàn
                        const qtyToCloseNow = (percentageToClose === 1.00) ? currentLosingQtyOnExchange : losingPos.initialQuantity * percentageToClose;
                        // Làm tròn số lượng theo stepSize
                        const symbolDetails = await getSymbolDetails(losingPos.symbol);
                        const roundedQtyToClose = parseFloat((Math.floor(qtyToCloseNow / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));

                        if (roundedQtyToClose > 0) {
                             addLog(`Thực hiện đóng ${roundedQtyToClose} ${losingPos.symbol} của lệnh ${losingPos.side} (lỗ).`);
                            const success = await closePartialPosition(losingPos, roundedQtyToClose / losingPos.initialQuantity); // Truyền percentage thực tế
                            if (success) {
                                // Nếu đóng thành công, chuyển sang mốc tiếp theo
                                winningPos.nextPartialCloseLossIndex++;

                                // Đánh dấu đã đóng hoàn toàn lệnh lỗ nếu đạt Mốc 8 hoặc đóng hết lượng còn lại
                                const remainingQtyAfterClose = Math.abs(parseFloat((await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: losingPos.symbol })).find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || 0));
                                if (remainingQtyAfterClose <= 0 || winningPos.nextPartialCloseLossIndex > winningPos.partialCloseLossLevels.length) {
                                    losingPos.hasClosedAllLossPositionAtLastLevel = true;
                                    addLog(`Đã đóng hoàn toàn lệnh lỗ ${losingPos.side}.`);
                                } else {
                                    // Nếu chưa đóng hết, đặt lại TP/SL cho lượng còn lại của lệnh lỗ
                                    await sleep(1000); // Đợi trước khi đặt lại lệnh
                                    // Chúng ta không đặt lại TP vì TP không sửa đổi theo yêu cầu
                                    // Chỉ cần đặt lại SL cho lượng còn lại?
                                    // Hoặc để logic SL điều chỉnh ở dưới handle luôn?
                                    // Tạm thời bỏ qua việc đặt lại SL ở đây, để logic điều chỉnh SL chung xử lý.
                                }
                            }
                        } else {
                             addLog(`Số lượng cần đóng từng phần sau làm tròn (${roundedQtyToClose}) quá nhỏ hoặc không hợp lệ. Bỏ qua.`);
                             // Vẫn chuyển sang mốc tiếp theo để không lặp lại việc kiểm tra mốc này nếu số lượng quá nhỏ để đóng
                             winningPos.nextPartialCloseLossIndex++;
                        }

                    } else {
                        addLog(`Vị thế lỗ ${losingPos.side} đã đóng hết trên sàn, không cần đóng từng phần nữa.`);
                         losingPos.hasClosedAllLossPositionAtLastLevel = true; // Đánh dấu đã đóng hết
                        winningPos.nextPartialCloseLossIndex++; // Vẫn chuyển index để không lặp lại kiểm tra mốc này
                    }
                } else {
                    // addLog(`Lệnh lỗ đã đóng hoàn toàn ở Mốc cuối cùng hoặc trước đó.`);
                     winningPos.nextPartialCloseLossIndex++; // Vẫn chuyển index để không lặp lại
                }
            }

            // --- Logic điều chỉnh SL lệnh LỖ theo Mốc lãi của lệnh LÃI ---

            // Khi lệnh lãi đạt Mốc 5 (PARTIAL_CLOSE_LEVEL_5)
            // Điều chỉnh SL lệnh LỖ về mức giá tương ứng với Mốc 8 LỖ của nó
            if (PARTIAL_CLOSE_LEVEL_5 !== undefined && currentProfitPercentage >= PARTIAL_CLOSE_LEVEL_5 && !winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_5]) {
                addLog(`Lệnh lãi ${winningPos.side} đạt Mốc ${PARTIAL_CLOSE_LEVEL_5}%. Đang điều chỉnh SL lệnh lỗ ${losingPos.side}.`);

                // Chỉ điều chỉnh nếu lệnh lỗ còn tồn tại trên sàn và chưa đóng hoàn toàn ở mốc 8
                 const currentLosingQtyOnExchange = Math.abs(parseFloat((await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: losingPos.symbol })).find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || 0));

                if (losingPos && currentLosingQtyOnExchange > 0 && PARTIAL_CLOSE_LEVEL_8 !== undefined) {
                    // Tính toán giá SL cho lệnh lỗ để nó lỗ ở Mốc 8 (ví dụ 800%) so với entryPrice CỦA NÓ
                    // Công thức: entryPrice * (1 - (mốc % lỗ) / 10000) cho LONG
                    //           entryPrice * (1 + (mốc % lỗ) / 10000) cho SHORT
                    // Với Mốc 8 thường là 800 (cho >=75x leverage), tương đương lỗ 800% trên vốn ban đầu của lệnh lỗ
                    // Giá SL = entryPrice ± (entryPrice * 800 / 10000)
                    const lossPercentageAtLevel8 = PARTIAL_CLOSE_LEVEL_8 / 100; // Chuyển đổi 800 thành 800%
                    const priceChangeFor800PercentLoss = (losingPos.initialMargin * (lossPercentageAtLevel8 / 100)) / losingPos.initialQuantity; // Giá thay đổi để lỗ 800%
                    // Lưu ý: công thức trên (initialMargin * percentage / initialQuantity) tính price change dựa trên vốn ban đầu và số lượng ban đầu
                    // Cách khác: tính giá trực tiếp dựa trên % thay đổi so với entryPrice
                    // Ví dụ: lỗ 800% = entryPrice * (1 - 8) -> Sai, % lỗ tính trên vốn/margin ban đầu
                    // Công thức đúng để tính giá lỗ X% margin ban đầu: entryPrice ± (initialMargin * X% / initialQuantity)
                    // Công thức đúng để tính giá lỗ X% của PNL unrealized (dựa trên giá vào hiện tại): entryPrice ± (entryPrice * X% / leverage)
                    // Dựa vào code cũ, dường như logic là tính price change dựa trên initial margin.
                    // Let's stick to the current code's apparent logic: priceChangeForSL calculated based on initialMargin and initialQuantity.
                    // Mốc 800% lỗ so với vốn ban đầu (0.9 USDT) nghĩa là lỗ 0.9 * 8 = 7.2 USDT.
                    // Để lỗ 7.2 USDT với initialQuantity 1991: giá phải thay đổi 7.2 / 1991.
                    // Giá SL_lỗ = entryPrice_lỗ ± (7.2 / 1991)
                    // Đây chính xác là công thức (initialMargin * STOP_LOSS_MULTIPLIER) / initialQuantity nếu STOP_LOSS_MULTIPLIER = 8 (tức Mốc 8).
                    // Lấy giá SL tương ứng với mức LỖ 800% (hoặc giá trị của PARTIAL_CLOSE_LEVEL_8) trên vốn ban đầu của lệnh LỖ.
                    const priceChangeForLosingSL = (losingPos.initialMargin * (PARTIAL_CLOSE_LEVEL_8 / 100)) / losingPos.initialQuantity; // PARTIAL_CLOSE_LEVEL_8 thường là 800
                    const slPriceLosing = parseFloat((losingPos.side === 'LONG' ? losingPos.entryPrice - priceChangeForLosingSL : losingPos.entryPrice + priceChangeForLosingSL).toFixed(losingPos.pricePrecision));


                    losingPos.currentSLId = await updateStopLimitOrder(losingPos, slPriceLosing, 'STOP');
                    if (losingPos.currentSLId) { // Chỉ đánh dấu đã điều chỉnh nếu đặt lệnh SL thành công
                        addLog(`SL lệnh lỗ ${losingPos.side} rời về giá PNL ${PARTIAL_CLOSE_LEVEL_8}% (${slPriceLosing.toFixed(losingPos.pricePrecision)}).`);
                        winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_5] = true; // Đánh dấu đã điều chỉnh SL khi lệnh lãi đạt Mốc 5
                    } else {
                        addLog(`Không thể đặt lại SL lệnh lỗ ${losingPos.side} ở Mốc ${PARTIAL_CLOSE_LEVEL_5} lãi lệnh thắng.`);
                         // Không đánh dấu đã điều chỉnh để thử lại ở chu kỳ sau
                    }
                } else {
                    addLog(`Không thể điều chỉnh SL lệnh lỗ ${losingPos.side} ở Mốc ${PARTIAL_CLOSE_LEVEL_5} lãi lệnh thắng vì vị thế đã đóng hết hoặc không tồn tại.`);
                     winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_5] = true; // Đánh dấu để không lặp lại việc kiểm tra mốc này
                }
            }

            // Khi lệnh lãi đạt Mốc 8 (PARTIAL_CLOSE_LEVEL_8)
            // Logic đóng 100% lệnh lỗ đã được xử lý ở trên.
            // Theo yêu cầu, không cần làm gì thêm với SL/TP ở đây.
            // Chỉ đánh dấu là đã xử lý mốc này nếu chưa
            if (PARTIAL_CLOSE_LEVEL_8 !== undefined && currentProfitPercentage >= PARTIAL_CLOSE_LEVEL_8 && !winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_8]) {
                 addLog(`Lệnh lãi ${winningPos.side} đạt Mốc ${PARTIAL_CLOSE_LEVEL_8}%. Đã xử lý đóng 100% lệnh lỗ.`);
                 winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_8] = true; // Đánh dấu đã xử lý mốc này
            }
        }

        // --- Logic mở lại lệnh lỗ nếu giá quay về giá vào ban đầu của cặp lệnh ---
        // Điều kiện:
        // 1. Có lệnh lỗ (losingPos) và nó đã từng đóng một phần (closedLossAmount > 0)
        // 2. Lệnh lỗ CHƯA đóng hoàn toàn ở mốc cuối cùng (Mốc 8)
        // 3. Có lệnh lãi (winningPos) để lấy giá vào cặp ban đầu (pairEntryPrice)
        // 4. Giá hiện tại (currentMarketPrice) quay về gần giá vào ban đầu của cặp lệnh (pairEntryPrice)
        // 5. Bot đang ở trạng thái có 1 lệnh lãi và 1 lệnh lỗ (để logic này có ý nghĩa)
        if (losingPos && losingPos.closedLossAmount > 0 && !losingPos.hasClosedAllLossPositionAtLastLevel && winningPos) {
            // Sử dụng giá vào của lệnh thắng làm đại diện cho giá vào của cặp
            const pairEntryPrice = winningPos.pairEntryPrice;
            if (currentMarketPrice !== null && pairEntryPrice !== null) {
                // Tính toán khoảng dung sai (ví dụ 0.05% so với giá vào cặp)
                const tolerance = pairEntryPrice * 0.0005; // Có thể điều chỉnh dung sai này

                const isPriceNearPairEntry = Math.abs(currentMarketPrice - pairEntryPrice) <= tolerance;

                if (isPriceNearPairEntry) {
                    addLog(`Giá ${currentMarketPrice.toFixed(winningPos.pricePrecision)} đang gần giá vào ban đầu của cặp (${pairEntryPrice.toFixed(winningPos.pricePrecision)}). Đang thử mở lại phần đã cắt lỗ của lệnh ${losingPos.side}.`);
                    // Gọi hàm addPosition để mở lại lượng đã đóng
                    await addPosition(losingPos, losingPos.closedLossAmount);
                    // Hàm addPosition sẽ tự reset trạng thái và đặt lại TP/SL nếu mở lại thành công
                }
            } else {
                 // addLog("Không có giá thị trường hiện tại hoặc giá vào cặp để kiểm tra mở lại lệnh lỗ.");
            }
        } else {
             // addLog("Không đủ điều kiện để kiểm tra mở lại lệnh lỗ: Không có lệnh lỗ đang theo dõi, hoặc lệnh lỗ chưa bị đóng phần nào, hoặc lệnh lỗ đã đóng hoàn toàn, hoặc không tìm thấy lệnh lãi.");
        }


    } catch (error) {
        addLog(`Lỗi quản lý vị thế: ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) stopBotLogicInternal(); // Dừng bot nếu lỗi API nghiêm trọng
    }
};

async function scheduleNextMainCycle() {
    if (!botRunning || currentLongPosition || currentShortPosition) {
         // addLog("Không lên lịch chu kỳ mới: Bot không running HOẶC đã có vị thế mở.");
         return;
    }
    clearTimeout(nextScheduledCycleTimeout);
    addLog(`Lên lịch chu kỳ giao dịch tiếp theo sau 2 giây...`);
    nextScheduledCycleTimeout = setTimeout(runTradingLogic, 2000);
}

// WebSocket ListenKey Management
async function getListenKey() { if (!API_KEY || !SECRET_KEY) { addLog("API Key chưa được cấu hình."); return null; } try { const data = await callSignedAPI('/fapi/v1/listenKey', 'POST'); addLog(`Đã lấy listenKey mới.`); return data.listenKey; } catch (e) { addLog(`Lỗi lấy listenKey: ${e.message}`); return null; } }
async function keepAliveListenKey() { if (listenKey) { try { await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey }); } catch (e) { addLog(`Lỗi làm mới listenKey. Lấy key mới...`); listenKey = await getListenKey(); if (listenKey) setupUserDataStream(listenKey); } } }

// WebSocket Streams
function setupMarketDataStream(symbol) {
    if (marketWs) marketWs.close();
    const streamUrl = `${WS_BASE_URL}/ws/${symbol.toLowerCase()}@markPrice`; // Stream markPrice không cần @1s
    marketWs = new WebSocket(streamUrl);

    marketWs.onopen = () => addLog(`Market WebSocket cho ${symbol} đã kết nối.`);
    marketWs.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            // 'e' là event type. 'markPriceUpdate' là loại chúng ta cần.
            if (data.e === 'markPriceUpdate' && data.s === symbol) { // Kiểm tra đúng symbol
                currentMarketPrice = parseFloat(data.p);
                // Các biến currentLongPosition và currentShortPosition được cập nhật
                // unrealizedPnl và currentPrice trong manageOpenPosition dựa vào API.
                // Việc cập nhật currentMarketPrice ở đây chỉ để dùng cho logic kiểm tra giá
                // quay về entryPrice của cặp.
            }
        } catch (e) {
            // Không log lỗi quá nhiều cho các tin nhắn không liên quan hoặc lỗi parsing nhỏ
        }
    };
    marketWs.onclose = () => {
        addLog(`Market WebSocket cho ${symbol} đã đóng. Đang thử kết nối lại sau 5 giây...`);
        if (botRunning) setTimeout(() => setupMarketDataStream(symbol), 5000);
    };
    marketWs.onerror = (error) => {
        addLog(`Lỗi Market WebSocket cho ${symbol}: ${error.message}`);
        // Tự động thử kết nối lại sau lỗi
         if (botRunning) setTimeout(() => setupMarketDataStream(symbol), 5000);
    };
}

function setupUserDataStream(key) {
    if (userDataWs) userDataWs.close();
    const streamUrl = `${WS_BASE_URL}/ws/${key}`;
    userDataWs = new WebSocket(streamUrl);

    userDataWs.onopen = () => {
        addLog('User Data WebSocket đã kết nối.');
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
        listenKeyRefreshInterval = setInterval(keepAliveListenKey, 30 * 60 * 1000); // Làm mới listenKey mỗi 30 phút
    };
    userDataWs.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            // Add basic logging for received events to help debugging if needed
            // addLog(`Received User Data Event: ${data.e}`);
            if (data.e === 'ORDER_TRADE_UPDATE') {
                await processTradeResult(data.o);
            } else if (data.e === 'ACCOUNT_UPDATE') {
                 // Event này chứa thông tin position và balance update
                 // Có thể dùng nó để cập nhật trạng thái position thay vì polling API?
                 // Tuy nhiên, code hiện tại dựa vào polling API trong manageOpenPosition, giữ nguyên.
            }
        } catch (e) {
            // Không log lỗi quá nhiều cho các tin nhắn không liên quan hoặc lỗi parsing nhỏ
            // addLog(`Error processing user data event: ${e.message}`);
        }
    };
    userDataWs.onclose = async () => {
        addLog('User Data WebSocket đã đóng. Đang thử kết nối lại sau 5 giây...');
        if (botRunning) {
            setTimeout(async () => {
                listenKey = await getListenKey();
                if (listenKey) setupUserDataStream(listenKey);
                 else addLog("Không lấy được listenKey mới để kết nối lại User Data Stream.");
            }, 5000); // Thử kết nối lại sau 5 giây
        }
    };
    userDataWs.onerror = (error) => {
        addLog(`Lỗi User Data WebSocket: ${error.message}`);
         // Tự động thử kết nối lại sau lỗi
        if (botRunning) {
            setTimeout(async () => {
                listenKey = await getListenKey();
                if (listenKey) setupUserDataStream(listenKey);
                 else addLog("Không lấy được listenKey mới để kết nối lại User Data Stream sau lỗi.");
            }, 5000);
        }
    };
}


async function startBotLogicInternal() {
    if (botRunning) return 'Bot đang chạy.';
    if (!API_KEY || !SECRET_KEY) return 'Lỗi: API Key/Secret Key chưa được cấu hình.';

    addLog('--- Khởi động Bot ---');
    try {
        await syncServerTime(); // Đồng bộ thời gian với server Binance
        await getExchangeInfo(); // Lấy thông tin sàn

        // Kiểm tra và đóng các vị thế còn sót từ lần chạy trước (nếu có)
        await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL);

        // Thiết lập User Data Stream để nhận thông báo trade
        listenKey = await getListenKey();
        if (listenKey) setupUserDataStream(listenKey);
         else {
            addLog("Không lấy được listenKey khi khởi động. Không thể kết nối User Data Stream.");
            // Decide if this is critical or if bot can run without user data stream (less reliable)
            // For this strategy, getting trade updates is crucial. Throw error.
            throw new Error("Không thể thiết lập User Data Stream.");
         }

        // Thiết lập Market Data Stream để nhận giá thị trường
        setupMarketDataStream(TARGET_COIN_SYMBOL);

        botRunning = true;
        botStartTime = new Date();
        addLog(`--- Bot đã chạy lúc ${formatTimeUTC7(botStartTime)} ---`);
        addLog(`Coin: ${TARGET_COIN_SYMBOL} | Vốn/lệnh: ${INITIAL_INVESTMENT_AMOUNT} USDT`);

        scheduleNextMainCycle(); // Bắt đầu chu kỳ giao dịch đầu tiên
        // Bắt đầu interval kiểm tra vị thế sau khi khởi động thành công
        // Interval này sẽ tự dừng nếu không có vị thế nào và được bắt đầu lại trong runTradingLogic
        if (!positionCheckInterval) {
            positionCheckInterval = setInterval(manageOpenPosition, 3000); // Kiểm tra mỗi 3 giây
        }
        return 'Bot khởi động thành công.';
    } catch (error) {
        const errorMsg = error.msg || error.message;
        addLog(`[Lỗi khởi động bot] ${errorMsg}`);
        stopBotLogicInternal(); // Dừng bot nếu có lỗi nghiêm trọng khi khởi động
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
    // Reset tất cả các biến trạng thái
    positionCheckInterval = null;
    listenKeyRefreshInterval = null;
    marketWs = null;
    userDataWs = null;
    listenKey = null;
    currentLongPosition = null;
    currentShortPosition = null;
    totalProfit = 0;
    totalLoss = 0;
    netPNL = 0;
    isClosingPosition = false; // Đảm bảo cờ này reset
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
                // Sử dụng closePosition để đóng
                const success = await closePosition(pos.symbol, 0, `Vị thế sót khi khởi động/reset`, sideToClose);
                if(success) await sleep(1000); // Đợi chút giữa các lệnh đóng thành công
            }
        } else {
            addLog(`Không có vị thế ${symbol} nào còn sót lại.`);
        }
    } catch (error) {
        addLog(`Lỗi kiểm tra vị thế sót: ${error.msg || error.message}`);
        // Nếu không kiểm tra được vị thế sót, có thể là lỗi nghiêm trọng.
        // Quyết định có dừng bot hay không tùy thuộc vào mức độ nghiêm trọng.
        // Tạm thời không dừng bot hoàn toàn, chỉ ghi log.
    }
}


// Web Server để giao tiếp với người dùng
const app = express();
app.use(express.json()); // Để đọc JSON từ request body
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html'))); // Phục vụ file HTML giao diện
app.get('/api/logs', (req, res) => {
    // Đọc log từ file tùy chỉnh
    fs.readFile(CUSTOM_LOG_FILE, 'utf8', (err, data) => {
        if (err) {
            return res.status(500).send('Lỗi đọc log file');
        }
        // Xóa các ký tự mã màu ANSI để log hiển thị sạch trên web
        const cleanData = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
        // Gửi 500 dòng log cuối cùng
        res.send(cleanData.split('\n').slice(-500).join('\n'));
    });
});
app.get('/api/status', async (req, res) => {
    try {
        const pm2List = await new Promise((resolve, reject) => {
            exec('pm2 jlist', (error, stdout) => {
                if (error) reject(error);
                resolve(stdout);
            });
        });
        const botProcess = JSON.parse(pm2List).find(p => p.name === THIS_BOT_PM2_NAME);
        let statusMessage = 'MAY CHU: DA TAT (PM2)';
        if (botProcess) {
            statusMessage = `MAY CHU: ${botProcess.pm2_env.status.toUpperCase()}`;
            if (botProcess.pm2_env.status === 'online') {
                statusMessage += ` | TRANG THAI BOT: ${botRunning ? 'DANG CHAY' : 'DA DUNG'}`;
                if (botStartTime) {
                    const uptimeMinutes = Math.floor((Date.now() - botStartTime.getTime()) / 60000);
                    statusMessage += ` | DA CHAY: ${uptimeMinutes} phút`;
                }
                statusMessage += ` | Coin: ${TARGET_COIN_SYMBOL} | Vốn lệnh: ${INITIAL_INVESTMENT_AMOUNT} USDT`;
                // Thêm trạng thái vị thế
                 let openPositionsText = " | Vị thế: KHONG CO";
                 if(currentLongPosition || currentShortPosition) {
                    openPositionsText = " | Vị thế: ";
                    if(currentLongPosition) openPositionsText += `LONG (${currentLongPosition.unrealizedPnl.toFixed(2)} PNL) `;
                    if(currentShortPosition) openPositionsText += `SHORT (${currentShortPosition.unrealizedPnl.toFixed(2)} PNL)`;
                 }
                 statusMessage += openPositionsText;
            }
        }
        res.send(statusMessage);
    } catch (error) {
        res.status(500).send(`Lỗi lấy trạng thái PM2.`);
    }
});
app.get('/api/bot_stats', (req, res) => {
    let openPositionsData = [];
    if (currentLongPosition) openPositionsData.push({
        side: currentLongPosition.side,
        entryPrice: currentLongPosition.entryPrice,
        quantity: Math.abs(parseFloat(currentLongPosition.quantity)).toFixed(currentLongPosition.pricePrecision), // Hiện số lượng thực tế
        unrealizedPnl: currentLongPosition.unrealizedPnl.toFixed(2), // Format PNL
        currentPrice: currentLongPosition.currentPrice?.toFixed(currentLongPosition.pricePrecision) || 'N/A', // Format giá hiện tại
        initialQuantity: currentLongPosition.initialQuantity?.toFixed(currentLongPosition.pricePrecision), // Số lượng ban đầu
        closedLossAmount: currentLongPosition.closedLossAmount?.toFixed(currentLongPosition.pricePrecision), // Lượng đã đóng
        pairEntryPrice: currentLongPosition.pairEntryPrice?.toFixed(currentLongPosition.pricePrecision), // Giá vào cặp
    });
    if (currentShortPosition) openPositionsData.push({
        side: currentShortPosition.side,
        entryPrice: currentShortPosition.entryPrice,
         quantity: Math.abs(parseFloat(currentShortPosition.quantity)).toFixed(currentShortPosition.pricePrecision),
        unrealizedPnl: currentShortPosition.unrealizedPnl.toFixed(2),
        currentPrice: currentShortPosition.currentPrice?.toFixed(currentShortPosition.pricePrecision) || 'N/A',
        initialQuantity: currentShortPosition.initialQuantity?.toFixed(currentShortPosition.pricePrecision),
        closedLossAmount: currentShortPosition.closedLossAmount?.toFixed(currentShortPosition.pricePrecision),
        pairEntryPrice: currentShortPosition.pairEntryPrice?.toFixed(currentShortPosition.pricePrecision),
    });
    res.json({ success: true, data: { totalProfit: totalProfit.toFixed(2), totalLoss: totalLoss.toFixed(2), netPNL: netPNL.toFixed(2), currentOpenPositions: openPositionsData, currentInvestmentAmount: INITIAL_INVESTMENT_AMOUNT } });
});
app.post('/api/configure', (req, res) => {
    const config = req.body.coinConfigs?.[0]; // Lấy cấu hình từ body
    if (config) {
        const oldSymbol = TARGET_COIN_SYMBOL;
        TARGET_COIN_SYMBOL = config.symbol.trim().toUpperCase();
        INITIAL_INVESTMENT_AMOUNT = parseFloat(config.initialAmount);

        addLog(`Đã cập nhật cấu hình: Coin: ${TARGET_COIN_SYMBOL}, Vốn: ${INITIAL_INVESTMENT_AMOUNT} USDT`);

        // Nếu symbol thay đổi, reset trạng thái bot, đóng vị thế cũ (nếu có), và khởi tạo lại streams
        if (oldSymbol !== TARGET_COIN_SYMBOL) {
            addLog(`Coin đã thay đổi từ ${oldSymbol} sang ${TARGET_COIN_SYMBOL}. Reset trạng thái.`);
            // Dừng logic bot hiện tại
            stopBotLogicInternal();
            // Bắt đầu lại logic bot với cấu hình mới
            // Sử dụng setTimeout để cho phép stopBotLogicInternal hoàn tất
            setTimeout(() => startBotLogicInternal(), 2000); // Đợi 2 giây trước khi khởi động lại
        }
        // Nếu symbol không đổi, chỉ cập nhật vốn và ghi log
        res.json({ success: true, message: 'Cấu hình đã được cập nhật.' });
    } else {
        res.status(400).send('Dữ liệu cấu hình không hợp lệ.');
    }
});

// Các endpoint để điều khiển bot
app.get('/start_bot_logic', async (req, res) => res.send(await startBotLogicInternal()));
app.get('/stop_bot_logic', (req, res) => res.send(stopBotLogicInternal()));

app.listen(WEB_SERVER_PORT, () => {
    addLog(`Web server trên cổng ${WEB_SERVER_PORT}`);
    addLog(`Truy cập giao diện quản lý tại: http://localhost:${WEB_SERVER_PORT}`);
});

// Tự động khởi động bot khi script chạy (chỉ cần thiết nếu không dùng PM2 start/stop)
// Nếu dùng PM2, PM2 sẽ quản lý việc khởi động.
// Tuy nhiên, nếu bạn chạy script trực tiếp bằng node, bỏ comment dòng dưới:
// startBotLogicInternal();
