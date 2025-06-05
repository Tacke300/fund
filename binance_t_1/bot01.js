const https = require('https');
const crypto = require('crypto');
const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- CẤU HÌNH API KEY VÀ SECRET KEY (BAN ĐẦU RỖNG) ---
let API_KEY = ''; // Thay thế bằng API Key của bạn
let SECRET_KEY = ''; // Thay thế bằng Secret Key của bạn

// --- BASE URL CỦA BINANCE FUTURES API ---
const BASE_HOST = 'fapi.binance.com';
let serverTimeOffset = 0; // Offset thời gian để đồng bộ với server Binance
let exchangeInfoCache = null; // Biến cache cho exchangeInfo

// --- CẤU HÌNH THAM SỐ GIAO DỊCH ---
const INITIAL_INVESTMENT_AMOUNT = 1; // Mặc định 1 USDT
const TARGET_COIN_SYMBOL = 'TRBUSDT'; // Cặp tiền mục tiêu
const APPLY_DOUBLE_STRATEGY = false; // Mặc định không áp dụng chiến lược gấp đôi
const TAKE_PROFIT_PERCENTAGE_MAIN = 0.60; // 60% lãi
const STOP_LOSS_PERCENTAGE_MAIN = 0.175; // 17.5% lỗ
const MAX_CONSECUTIVE_LOSSES = 5; // Số lần thua tối đa trước khi reset
const MIN_ORDER_QUANTITY = 0.1; // Số lượng tối thiểu để mở lệnh

// --- BIẾN QUẢN LÝ TRẠNG THÁI ---
let botRunning = false; // Trạng thái bot
let currentOpenPosition = null; // Vị thế đang mở
let currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT; // Vốn hiện tại cho lệnh
let consecutiveLossCount = 0; // Số lần lỗ liên tiếp

// --- CÁC HÀM TIỆN ÍCH ---
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
                    reject(`HTTP Error: ${res.statusCode} ${res.statusMessage}`);
                }
            });
        });

        req.on('error', (e) => {
            reject(e.message);
        });

        if (method === 'POST' && postData) {
            req.write(postData);
        }
        req.end();
    });
}

async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!API_KEY || !SECRET_KEY) {
        throw new Error("API Key hoặc Secret Key chưa được cấu hình.");
    }

    const recvWindow = 5000;
    const timestamp = Date.now() + serverTimeOffset;

    let queryString = Object.keys(params)
                            .map(key => `${key}=${params[key]}`)
                            .join('&');

    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;

    const signature = createSignature(queryString, SECRET_KEY);

    let requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
    const headers = {
        'X-MBX-APIKEY': API_KEY,
        'Content-Type': 'application/json',
    };

    try {
        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers);
        return JSON.parse(rawData);
    } catch (error) {
        throw error; // Ném lại lỗi để caller xử lý
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
        return JSON.parse(rawData);
    } catch (error) {
        throw error; // Ném lỗi để caller xử lý
    }
}

async function syncServerTime() {
    try {
        const data = await callPublicAPI('/fapi/v1/time');
        const binanceServerTime = data.serverTime;
        const localTime = Date.now();
        serverTimeOffset = binanceServerTime - localTime;
    } catch (error) {
        console.error(`Lỗi đồng bộ thời gian: ${error.message}.`);
        serverTimeOffset = 0; 
    }
}

async function getExchangeInfo() {
    if (exchangeInfoCache) {
        return exchangeInfoCache;
    }

    try {
        const data = await callPublicAPI('/fapi/v1/exchangeInfo');
        exchangeInfoCache = {};
        data.symbols.forEach(s => {
            const lotSizeFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
            exchangeInfoCache[s.symbol] = {
                minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : 0,
                stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : 0.001
            };
        });
        return exchangeInfoCache;
    } catch (error) {
        console.error('Lỗi lấy exchangeInfo: ' + error.message);
        exchangeInfoCache = null;
        throw error;
    }
}

async function getCurrentPrice(symbol) {
    try {
        const data = await callPublicAPI('/fapi/v1/ticker/price', { symbol: symbol });
        return parseFloat(data.price);
    } catch (error) {
        console.error(`Lỗi lấy giá hiện tại cho ${symbol}: ${error.message}`);
        return null;
    }
}

async function openPosition(symbol, tradeDirection) {
    if (currentOpenPosition) {
        console.log(`Đã có vị thế mở (${currentOpenPosition.symbol}). Bỏ qua mở lệnh mới cho ${symbol}.`); 
        return;
    }

    const currentPrice = await getCurrentPrice(symbol);
    if (!currentPrice) {
        console.log(`Lỗi lấy giá hiện tại cho ${symbol}. Không mở lệnh.`);
        return;
    }

    let quantity = (currentInvestmentAmount * 10) / currentPrice; // Tính số lượng theo tài khoản
    if (quantity < MIN_ORDER_QUANTITY) {
        console.log(`Số lượng tính toán (${quantity}) quá nhỏ cho ${symbol}. MinQty là ${MIN_ORDER_QUANTITY}. Không thể mở lệnh.`);
        return; // Không đủ số lượng tối thiểu
    }
    
    const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';

    // Gửi lệnh mở
    try {
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: orderSide,
            type: 'MARKET',
            quantity: quantity
        });
        currentOpenPosition = { symbol: symbol, quantity: quantity, side: tradeDirection };
        console.log(`Đã mở ${tradeDirection} ${symbol} với số lượng ${quantity}.`);
    } catch (error) {
        console.error(`Lỗi khi mở lệnh ${tradeDirection} cho ${symbol}: ${error.message}`);
    }
}

async function manageOpenPosition() {
    if (!currentOpenPosition) {
        console.log(`Không có vị thế để quản lý.`);
        return;
    }

    const symbol = currentOpenPosition.symbol;
    const currentPositionAmount = currentOpenPosition.quantity;
    
    const currentPrice = await getCurrentPrice(symbol);
    if (!currentPrice) return; // Nếu không lấy được giá, thoát

    let profitTarget = (TAKE_PROFIT_PERCENTAGE_MAIN * currentPrice) + currentPrice; // Giá mục tiêu lợi nhuận
    let lossLimit = currentPrice - (STOP_LOSS_PERCENTAGE_MAIN * currentPrice); // Giá ngừng lỗ

    // Kiểm tra lỗ và chốt lời
    if (currentPrice >= profitTarget) {
        console.log(`Chốt lời ${symbol} với giá ${currentPrice}.`);
        await closePosition(symbol, currentPositionAmount, "Chốt lời");
    } else if (currentPrice <= lossLimit) {
        console.log(`Ngừng lỗ ${symbol} với giá ${currentPrice}.`);
        await closePosition(symbol, currentPositionAmount, "Ngừng lỗ");
    }
}

// Đóng vị thế
async function closePosition(symbol, quantity, reason) {
    try {
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: (currentOpenPosition.side === 'SHORT') ? 'BUY' : 'SELL',
            type: 'MARKET',
            quantity: quantity
        });
        console.log(`Đã đóng vị thế ${symbol} ${reason}.`);
        currentOpenPosition = null; // Reset vị thế sau khi đóng
    } catch (error) {
        console.error(`Lỗi khi đóng vị thế ${symbol}: ${error.message}`);
    }
}

// Khởi động bot
async function startBotLogic() {
    if (botRunning) {
        console.log('Bot đã chạy.');
        return;
    }

    try {
        await syncServerTime(); // Đồng bộ thời gian
        await getExchangeInfo(); // Tải thông tin sàn
        botRunning = true;
        console.log('Bot đã khởi động thành công.');
        
        // Vòng lặp để kiểm tra một cách liên tục
        setInterval(async () => {
            await manageOpenPosition();
            await openPosition(TARGET_COIN_SYMBOL, 'LONG'); // Hoặc 'SHORT' dựa vào logic của bạn
        }, 5000); // cứ 5 giây kiểm tra

    } catch (error) {
        console.error(`Lỗi trong quá trình khởi động bot: ${error.message}`);
    }
}

// Khởi động bot
startBotLogic();

