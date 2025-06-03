import https from 'https';
import crypto from 'crypto';
import express from 'express';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url'; // Đã sửa lỗi cú pháp tại đây

// Lấy __filename và __dirname trong ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CẤU HÌNH API KEY VÀ SECRET KEY (NHẬP TRỰC TIẾP) ---
const API_KEY = "cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q";
const SECRET_KEY = "oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc"; 

// --- BASE URL CỦA BINANCE FUTURES API ---
const BASE_HOST = 'fapi.binance.com';

let serverTimeOffset = 0; // Offset thời gian để đồng bộ với server Binance

// Biến cache cho exchangeInfo để tránh gọi API lặp lại
let exchangeInfoCache = null;

// Biến cờ để tránh gửi nhiều lệnh đóng cùng lúc
let isClosingPosition = false;

// Biến cờ điều khiển trạng thái bot (chạy/dừng)
let botRunning = false;
let botStartTime = null; // Thời điểm bot được khởi động

// Biến để theo dõi vị thế đang mở
let currentOpenPosition = null;
// Biến để lưu trữ setInterval cho việc kiểm tra vị thế đang mở
let positionCheckInterval = null;
// Biến để lưu trữ setTimeout cho lần chạy tiếp theo của chu kỳ chính (runTradingLogic)
let nextScheduledTimeout = null;
// Biến để lưu trữ setTimeout cho việc tự động khởi động lại bot sau lỗi nghiêm trọng
let retryBotTimeout = null;

// Biến và interval cho việc hiển thị đếm ngược trên giao diện web
let currentCountdownMessage = "Không có lệnh đang chờ đóng.";
let countdownIntervalFrontend = null;

// === START - BIẾN QUẢN LÝ LỖI VÀ TẦN SUẤT LOG ===
let consecutiveApiErrors = 0; // Đếm số lỗi API liên tiếp
const MAX_CONSECUTIVE_API_ERRORS = 5; // Số lỗi API liên tiếp tối đa cho phép trước khi tạm dừng bot
const ERROR_RETRY_DELAY_MS = 60000; // Độ trễ (ms) khi bot tạm dừng sau nhiều lỗi (ví dụ: 60 giây)

// Cache các thông điệp log để tránh spam quá nhiều dòng giống nhau liên tiếp
const logCounts = {}; // { messageHash: { count: number, lastLoggedTime: Date } }
const LOG_COOLDOWN_MS = 5000; // 5 giây cooldown cho các log không quan trọng lặp lại

// Custom Error class cho lỗi API nghiêm trọng
class CriticalApiError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CriticalApiError';
    }
}
// === END - BIẾN QUẢN LÝ LỖI VÀ TẦN SUẤT LOG ===


// --- CẤU HÌNH BOT CÁC THAM SỐ GIAO DỊCH MỚI ---
const TARGET_SYMBOL = 'NEIROUSDT'; // Đồng coin mục tiêu
const TARGET_LEVERAGE = 75; // Đòn bẩy tối đa
const MIN_USDT_BALANCE_TO_OPEN = 0.01; // Số dư USDT tối thiểu để bot được phép mở lệnh

// Vốn ban đầu cho mỗi lệnh (USD)
const AMOUNT_USDT_PER_TRADE_INITIAL = 0.08; // 0.08 USD

// Cấu hình Take Profit & Stop Loss
const TAKE_PROFIT_PERCENTAGE_INITIAL = 0.30; // 30% lợi nhuận trên vốn ban đầu
const STOP_LOSS_PERCENTAGE_INITIAL = 0.18; // 18% thua lỗ trên vốn ban đầu

// Cấu hình Martingale
const MARTINGALE_MAX_LEVEL = 5; // Số lần gấp lệnh tối đa
const MARTINGALE_MULTIPLIER = 2; // Hệ số gấp lệnh (ví dụ: x2 vốn)
const TAKE_PROFIT_PERCENTAGE_MARTINGALE = 0.005; // 0.5% lợi nhuận trên tổng giá trị vị thế cho mỗi lệnh gấp
const MIN_TICKS_DISTANCE_FOR_SL_TP = 5; // Số lượng tick tối thiểu mà SL/TP phải cách giá vào lệnh.

// Biến trạng thái Martingale
let martingaleLevel = 0; // Level Martingale hiện tại (0 = lệnh ban đầu)
let currentTradeCapital = AMOUNT_USDT_PER_TRADE_INITIAL; // Vốn cho lệnh hiện tại
let currentTradeSide = 'LONG'; // Hướng lệnh hiện tại ('LONG' hoặc 'SHORT')

// Lịch sử PNL của bot
let totalPnlUsdt = 0;
let totalInitialCapitalUsed = 0; // Tổng vốn đã dùng từ lúc bot chạy, để tính % PNL

// Hằng số cho thời gian chờ hủy lệnh sau khi đóng vị thế
const DELAY_BEFORE_CANCEL_ORDERS_MS = 6000; // 6 giây

// Số lần thử lại kiểm tra vị thế sau khi đóng và thời gian delay
const RETRY_CHECK_POSITION_ATTEMPTS = 5; // Tăng số lần thử lại để chắc chắn hơn
const RETRY_CHECK_POSITION_DELAY_MS = 1000; // 1 giây

// --- CẤU HÌNH WEB SERVER VÀ LOG PM2 ---
const WEB_SERVER_PORT = 3333; // Cổng cho giao diện web
// Đường dẫn tới file log của PM2 cho bot này (để web server đọc).
// Đảm bảo đường dẫn này chính xác với cấu hình PM2 của bạn.
const BOT_LOG_FILE = '/home/tacke300/.pm2/logs/futu-out.log';
// Tên của bot trong PM2, phải khớp với tên bạn đã dùng khi start bot bằng PM2.
const THIS_BOT_PM2_NAME = 'futu';

// --- FUNCTIONS ---

// Hàm utility để gửi HTTP request
async function sendRequest(method, path, params = {}, signed = false) {
    let query_string = new URLSearchParams(params).toString();
    const timestamp = Date.now() + serverTimeOffset;

    if (signed) {
        query_string += (query_string ? '&' : '') + `timestamp=${timestamp}`;
        const signature = createSignature(query_string, SECRET_KEY);
        query_string += `&signature=${signature}`;
    } else if (method === 'GET') {
        query_string += (query_string ? '&' : '') + `timestamp=${timestamp}`;
    }

    const options = {
        hostname: BASE_HOST,
        path: `${path}?${query_string}`,
        method: method,
        headers: {
            'X-MBX-APIKEY': API_KEY,
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                let jsonResponse;
                try {
                    jsonResponse = JSON.parse(data);
                } catch (e) {
                    return reject(new Error(`Invalid JSON response: ${data}`));
                }

                if (res.statusCode >= 200 && res.statusCode < 300) {
                    consecutiveApiErrors = 0; // Reset lỗi nếu request thành công
                    resolve(jsonResponse);
                } else {
                    consecutiveApiErrors++; // Tăng số lỗi liên tiếp
                    customLog(`❌ HTTP Request lỗi: ${jsonResponse.msg || data}`, true);
                    if (jsonResponse.code) {
                        customLog(`❌ Lỗi ký API Binance: ${jsonResponse.code} - ${jsonResponse.msg}`, true);
                    }
                    if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
                        customLog(`🔥 Đã có ${MAX_CONSECUTIVE_API_ERRORS} lỗi API liên tiếp. Tạm dừng bot và lên lịch khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000} giây.`, true);
                        stopBot(true); // Tạm dừng bot và lên lịch khởi động lại
                        return reject(new CriticalApiError(jsonResponse.msg || 'Critical API errors, bot stopped.'));
                    }
                    reject(new Error(jsonResponse.msg || `Request failed with status: ${res.statusCode}`));
                }
            });
        });

        req.on('error', (e) => {
            consecutiveApiErrors++; // Tăng số lỗi liên tiếp
            customLog(`❌ Lỗi kết nối HTTP: ${e.message}`, true);
            if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
                customLog(`🔥 Đã có ${MAX_CONSECUTIVE_API_ERRORS} lỗi API liên tiếp. Tạm dừng bot và lên lịch khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000} giây.`, true);
                stopBot(true); // Tạm dừng bot và lên lịch khởi động lại
                return reject(new CriticalApiError('Critical API errors, bot stopped.'));
            }
            reject(e);
        });

        req.end();
    });
}

// Hàm utility để làm tròn số đến số chữ số thập phân nhất định
function toFixed(num, fixed) {
    if (typeof num === 'string') {
        num = parseFloat(num);
    }
    const re = new RegExp('^-?\\d+(?:\\.\\d{0,' + (fixed || -1) + '})?');
    return num.toString().match(re)[0];
}

// Hàm utility để làm tròn theo tickSize/stepSize (hàm này thường làm tròn xuống)
const roundToStep = (num, step) => {
    // Để tránh floating point issues, nhân lên rồi chia xuống
    const precision = Math.max(
        (step.toString().split('.')[1] || '').length,
        (num.toString().split('.')[1] || '').length
    );
    const multiplier = Math.pow(10, precision);

    return Math.floor(num * multiplier / (step * multiplier)) * (step * multiplier) / multiplier;
};

// Hàm utility để làm tròn lên theo tickSize/stepSize
const ceilToStep = (num, step) => {
    const precision = Math.max(
        (step.toString().split('.')[1] || '').length,
        (num.toString().split('.')[1] || '').length
    );
    const multiplier = Math.pow(10, precision);

    return Math.ceil(num * multiplier / (step * multiplier)) * (step * multiplier) / multiplier;
};

// Hàm lấy thông tin exchange (precision, tickSize, stepSize)
async function getExchangeInfo(symbol) {
    if (exchangeInfoCache && exchangeInfoCache[symbol]) {
        return exchangeInfoCache[symbol];
    }

    try {
        const response = await sendRequest('GET', '/fapi/v1/exchangeInfo');
        const symbolInfo = response.symbols.find(s => s.symbol === symbol);

        if (!symbolInfo) {
            throw new Error(`Không tìm thấy thông tin cho symbol: ${symbol}`);
        }

        const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
        const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
        const marketLotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'MARKET_LOT_SIZE'); // Thêm filter này
        const minNotionalFilter = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');

        const exchangeInfo = {
            pricePrecision: priceFilter ? parseInt(priceFilter.tickSize.split('.')[1].length) : 8,
            tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.00000001,
            stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : 0.001,
            minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : 0.001,
            marketStepSize: marketLotSizeFilter ? parseFloat(marketLotSizeFilter.stepSize) : (lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : 0.001),
            marketMinQty: marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : (lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : 0.001),
            minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.notional) : 1 // Ví dụ minNotional = 1 USDT
        };

        exchangeInfoCache = { ...exchangeInfoCache, [symbol]: exchangeInfo };
        return exchangeInfo;
    } catch (error) {
        customLog(`❌ Lỗi khi lấy thông tin exchange cho ${symbol}: ${error.message}`, true);
        throw error;
    }
}

// Hàm lấy số dư tài khoản
async function getAccountBalance() {
    try {
        const balances = await sendRequest('GET', '/fapi/v2/balance', {}, true);
        const usdtBalance = balances.find(b => b.asset === 'USDT');
        if (usdtBalance) {
            return parseFloat(usdtBalance.availableBalance);
        }
        return 0;
    } catch (error) {
        customLog(`❌ Lỗi khi lấy số dư tài khoản: ${error.message}`, true);
        throw error;
    }
}

// Hàm lấy vị thế đang mở
async function getOpenPositions() {
    try {
        const positions = await sendRequest('GET', '/fapi/v2/positionRisk', {}, true);
        return positions.filter(p => parseFloat(p.positionAmt) !== 0 && p.symbol === TARGET_SYMBOL);
    } catch (error) {
        customLog(`❌ Lỗi khi lấy vị thế đang mở: ${error.message}`, true);
        throw error;
    }
}

// Hàm điều chỉnh đòn bẩy
async function setLeverage(symbol, leverage) {
    try {
        const params = { symbol: symbol, leverage: leverage };
        await sendRequest('POST', '/fapi/v1/leverage', params, true);
        customLog(`✅ Đã đặt đòn bẩy ${leverage}x cho ${symbol}.`, true);
    } catch (error) {
        customLog(`❌ Lỗi khi đặt đòn bẩy cho ${symbol}: ${error.message}`, true);
        throw error;
    }
}

// Hàm tạo timestamp và signature (API)
function createSignature(query_string, secretKey) {
    return crypto.createHmac('sha256', secretKey).update(query_string).digest('hex');
}

// Hàm log tùy chỉnh để tránh spam
function customLog(message, isImportant = false) {
    const timestamp = new Date().toLocaleString('vi-VN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
    const logLine = `[${timestamp}] ${isImportant ? '✅' : '[DEBUG]'} ${message}`;

    if (isImportant) {
        console.log(logLine);
        // Reset logCounts cho các tin nhắn quan trọng để chúng luôn được hiển thị
        Object.keys(logCounts).forEach(key => {
            if (logCounts[key].message === message) { // Reset chỉ cho tin nhắn này
                delete logCounts[key];
            }
        });
    } else {
        const messageHash = crypto.createHash('md5').update(message).digest('hex');
        if (!logCounts[messageHash]) {
            logCounts[messageHash] = { message: message, count: 1, lastLoggedTime: Date.now() };
            console.log(logLine);
        } else {
            logCounts[messageHash].count++;
            if (Date.now() - logCounts[messageHash].lastLoggedTime > LOG_COOLDOWN_MS) {
                console.log(logLine + ` (Lặp lại ${logCounts[messageHash].count} lần)`);
                logCounts[messageHash].count = 0; // Reset count sau khi in
                logCounts[messageHash].lastLoggedTime = Date.now();
            }
        }
    }
}

// Hàm lấy giá hiện tại
async function getCurrentPrice(symbol) {
    try {
        const response = await sendRequest('GET', '/fapi/v1/ticker/price', { symbol: symbol });
        const price = parseFloat(response.price);
        customLog(`Giá ${symbol}: ${price}`);
        return price;
    } catch (error) {
        customLog(`❌ Lỗi khi lấy giá ${symbol}: ${error.message}`, true);
        throw error;
    }
}

// Hàm mở vị thế
async function openPosition(symbol, side, capitalUsdt, leverage, entryPrice) {
    isClosingPosition = false; // Đảm bảo cờ đóng vị thế được reset

    try {
        const exchangeInfo = await getExchangeInfo(symbol);
        const { pricePrecision, stepSize, minQty, minNotional, tickSize } = exchangeInfo;

        // Đảm bảo đòn bẩy
        await setLeverage(symbol, leverage);

        // Tính toán số lượng dựa trên vốn và đòn bẩy
        let quantity = (capitalUsdt * leverage) / entryPrice;

        // Làm tròn số lượng theo stepSize và minQty
        quantity = roundToStep(quantity, stepSize);
        if (quantity < minQty) {
            customLog(`⚠️ Số lượng tính toán (${quantity}) nhỏ hơn minQty (${minQty}). Điều chỉnh thành minQty.`, true);
            quantity = minQty;
        }

        // Kiểm tra minNotional
        const notional = quantity * entryPrice;
        if (notional < minNotional) {
            customLog(`⚠️ Giá trị lệnh (${notional.toFixed(2)} USDT) nhỏ hơn minNotional (${minNotional}). Tăng số lượng để đạt minNotional.`, true);
            quantity = ceilToStep(minNotional / entryPrice, stepSize);
            customLog(`Điều chỉnh số lượng thành: ${quantity}. Giá trị lệnh mới: ${(quantity * entryPrice).toFixed(2)} USDT.`, true);
        }

        // Làm tròn số lượng một lần nữa theo pricePrecision nếu cần (đảm bảo độ chính xác khi gửi lệnh)
        quantity = parseFloat(toFixed(quantity, pricePrecision));

        customLog(`✅ Đã mở ${side} ${symbol} lúc ${new Date().toLocaleString('vi-VN')}.`, true);
        customLog(`  + Level: ${martingaleLevel} | Vốn: ${capitalUsdt} USDT | Qty: ${quantity} ${symbol} | Giá vào: ${entryPrice}`, true);
        totalInitialCapitalUsed += capitalUsdt;

        // Gửi lệnh Mua/Bán (MARKET order)
        const orderParams = {
            symbol: symbol,
            side: side,
            type: 'MARKET',
            quantity: quantity,
            newOrderRespType: 'FULL' // Để nhận thông tin chi tiết về lệnh
        };
        const orderResult = await sendRequest('POST', '/fapi/v1/order', orderParams, true);

        // Cập nhật currentOpenPosition
        currentOpenPosition = {
            symbol: symbol,
            side: side,
            entryPrice: entryPrice,
            quantity: quantity,
            leverage: leverage,
            martingaleLevel: martingaleLevel,
            openTime: Date.now()
        };

        customLog(`✅ Đã gửi lệnh mở ${side} ${symbol}.`, true);

        // Đặt TP/SL
        await placeStopLossTakeProfit(symbol, side, quantity, entryPrice, leverage);

        // Đặt timeout để chờ vị thế mở hoàn tất và cập nhật currentOpenPosition
        // Thường thì lệnh MARKET sẽ khớp ngay, nhưng vẫn nên chờ xác nhận.
        setTimeout(async () => {
            try {
                const openPositions = await getOpenPositions();
                const position = openPositions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
                if (position) {
                    currentOpenPosition = {
                        symbol: position.symbol,
                        side: parseFloat(position.positionAmt) > 0 ? 'LONG' : 'SHORT',
                        entryPrice: parseFloat(position.entryPrice),
                        quantity: Math.abs(parseFloat(position.positionAmt)),
                        leverage: parseFloat(position.leverage),
                        martingaleLevel: martingaleLevel,
                        openTime: Date.now()
                    };
                    customLog(`✅ Vị thế ${symbol} đã xác nhận mở hoàn toàn trên sàn.`, true);
                } else {
                    customLog(`⚠️ Không tìm thấy vị thế ${symbol} sau khi mở lệnh.`, true);
                    // Có thể thử lại hoặc xử lý lỗi
                }
            } catch (error) {
                customLog(`❌ Lỗi khi xác nhận vị thế sau khi mở: ${error.message}`, true);
            }
        }, 3000); // Chờ 3 giây để lệnh khớp hoàn toàn
        
    } catch (error) {
        customLog(`❌ Lỗi khi mở vị thế ${symbol}: ${error.message}`, true);
        throw error;
    }
}

// Hàm gửi lệnh TP/SL (đã cải tiến logic tính toán TP/SL)
async function placeStopLossTakeProfit(symbol, side, quantity, entryPrice, leverage) {
    try {
        const exchangeInfo = await getExchangeInfo(symbol);
        const { pricePrecision, tickSize } = exchangeInfo;

        let slPrice, tpPrice;

        // Tính toán khoảng cách giá tối thiểu tuyệt đối dựa trên tickSize
        const minPriceDistanceAbsolute = tickSize * MIN_TICKS_DISTANCE_FOR_SL_TP;

        if (martingaleLevel === 0) { // Lệnh ban đầu
            // Tính toán giá TP/SL dựa trên phần trăm vốn
            const pnlForSl = currentTradeCapital * STOP_LOSS_PERCENTAGE_INITIAL;
            const pnlForTp = currentTradeCapital * TAKE_PROFIT_PERCENTAGE_INITIAL;

            // Tính toán khoảng cách giá tương ứng (dựa trên PNL và đòn bẩy)
            const priceChangeForSL_calc = pnlForSl / (quantity * leverage);
            const priceChangeForTP_calc = pnlForTp / (quantity * leverage);
            
            // Lấy khoảng cách giá cuối cùng, đảm bảo không nhỏ hơn minPriceDistanceAbsolute
            const finalPriceChangeForSL = Math.max(priceChangeForSL_calc, minPriceDistanceAbsolute);
            const finalPriceChangeForTP = Math.max(priceChangeForTP_calc, minPriceDistanceAbsolute);

            if (side === 'LONG') {
                // slPrice phải nhỏ hơn entryPrice, tpPrice phải lớn hơn entryPrice
                slPrice = entryPrice - finalPriceChangeForSL;
                tpPrice = entryPrice + finalPriceChangeForTP;

                // Làm tròn theo tickSize (làm tròn xuống cho SL LONG, làm tròn lên cho TP LONG)
                slPrice = roundToStep(slPrice, tickSize);
                tpPrice = ceilToStep(tpPrice, tickSize);

                // Điều chỉnh lại nếu làm tròn khiến nó trở lại giá vào lệnh hoặc sai hướng
                // (Đảm bảo slPrice <= entryPrice và tpPrice >= entryPrice sau khi làm tròn)
                if (slPrice >= entryPrice) {
                    slPrice = roundToStep(entryPrice - minPriceDistanceAbsolute, tickSize);
                }
                if (tpPrice <= entryPrice) {
                    tpPrice = ceilToStep(entryPrice + minPriceDistanceAbsolute, tickSize);
                }

            } else { // SHORT
                // slPrice phải lớn hơn entryPrice, tpPrice phải nhỏ hơn entryPrice
                slPrice = entryPrice + finalPriceChangeForSL;
                tpPrice = entryPrice - finalPriceChangeForTP;

                // Làm tròn theo tickSize (làm tròn lên cho SL SHORT, làm tròn xuống cho TP SHORT)
                slPrice = ceilToStep(slPrice, tickSize);
                tpPrice = roundToStep(tpPrice, tickSize);

                // Điều chỉnh lại nếu làm tròn khiến nó trở lại giá vào lệnh hoặc sai hướng
                // (Đảm bảo slPrice >= entryPrice và tpPrice <= entryPrice sau khi làm tròn)
                if (slPrice <= entryPrice) {
                    slPrice = ceilToStep(entryPrice + minPriceDistanceAbsolute, tickSize);
                }
                if (tpPrice >= entryPrice) {
                    tpPrice = roundToStep(entryPrice - minPriceDistanceAbsolute, tickSize);
                }
            }

        } else { // Lệnh Martingale
            // Tính toán TP dựa trên phần trăm lợi nhuận trên tổng giá trị vị thế
            const pnlForTpMartingale = (entryPrice * quantity) * TAKE_PROFIT_PERCENTAGE_MARTINGALE;
            const priceChangeForTPMartingale_calc = pnlForTpMartingale / quantity;

            // Lấy khoảng cách giá cuối cùng cho TP, đảm bảo không nhỏ hơn minPriceDistanceAbsolute
            const finalPriceChangeForTPMartingale = Math.max(priceChangeForTPMartingale_calc, minPriceDistanceAbsolute);

            if (side === 'LONG') {
                tpPrice = entryPrice + finalPriceChangeForTPMartingale;
                slPrice = roundToStep(entryPrice - minPriceDistanceAbsolute, tickSize); // SL mặc định cho Martingale
                
                tpPrice = ceilToStep(tpPrice, tickSize);
                slPrice = roundToStep(slPrice, tickSize); // Đảm bảo làm tròn
                
                if (tpPrice <= entryPrice) {
                    tpPrice = ceilToStep(entryPrice + minPriceDistanceAbsolute, tickSize);
                }
                if (slPrice >= entryPrice) {
                    slPrice = roundToStep(entryPrice - minPriceDistanceAbsolute, tickSize);
                }

            } else { // SHORT
                tpPrice = entryPrice - finalPriceChangeForTPMartingale;
                slPrice = ceilToStep(entryPrice + minPriceDistanceAbsolute, tickSize); // SL mặc định cho Martingale
                
                tpPrice = roundToStep(tpPrice, tickSize);
                slPrice = ceilToStep(slPrice, tickSize); // Đảm bảo làm tròn
                
                if (tpPrice >= entryPrice) {
                    tpPrice = roundToStep(entryPrice - minPriceDistanceAbsolute, tickSize);
                }
                if (slPrice <= entryPrice) {
                    slPrice = ceilToStep(entryPrice + minPriceDistanceAbsolute, tickSize);
                }
            }
        }
        
        // Làm tròn cuối cùng theo pricePrecision để gửi lệnh
        slPrice = parseFloat(toFixed(slPrice, pricePrecision));
        tpPrice = parseFloat(toFixed(tpPrice, pricePrecision));

        customLog(`>>> TP: ${tpPrice}, SL: ${slPrice}`, true);

        // Gửi lệnh SL (STOP_MARKET)
        const slOrderParams = {
            symbol: symbol,
            side: side === 'LONG' ? 'SELL' : 'BUY',
            type: 'STOP_MARKET',
            quantity: quantity,
            stopPrice: slPrice,
            closePosition: 'true' // Đảm bảo đóng toàn bộ vị thế
        };
        const slResult = await sendRequest('POST', '/fapi/v1/order', slOrderParams, true);
        customLog(`✅ Đã gửi lệnh SL cho ${symbol}.`, true);

        // Gửi lệnh TP (TAKE_PROFIT_MARKET)
        const tpOrderParams = {
            symbol: symbol,
            side: side === 'LONG' ? 'SELL' : 'BUY',
            type: 'TAKE_PROFIT_MARKET',
            quantity: quantity,
            stopPrice: tpPrice, // Với TAKE_PROFIT_MARKET, stopPrice là giá kích hoạt
            closePosition: 'true'
        };
        const tpResult = await sendRequest('POST', '/fapi/v1/order', tpOrderParams, true);
        customLog(`✅ Đã gửi lệnh TP cho ${symbol}.`, true);

    } catch (error) {
        customLog(`❌ Lỗi đặt TP/SL cho ${symbol}: ${error.message || error}`, true);
        if (error.code === -2021) { // "Order would immediately trigger."
            customLog(`⚠️ SL/TP kích hoạt ngay lập tức cho ${symbol}. Đóng vị thế.`, true);
            await closePosition(symbol, "SL/TP kích hoạt."); // Đóng ngay lập tức
        }
        throw new Error(`Lỗi đặt TP/SL: ${error.message}`);
    }
}

// Hàm hủy tất cả các lệnh chờ
async function cancelAllOpenOrders(symbol) {
    try {
        await sendRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol: symbol }, true);
        customLog(`✅ Đã hủy tất cả lệnh chờ cho ${symbol}.`, true);
    } catch (error) {
        customLog(`❌ Lỗi khi hủy lệnh chờ cho ${symbol}: ${error.message}`, true);
        // Không throw lỗi ở đây để quá trình đóng vị thế không bị gián đoạn hoàn toàn
    }
}

// Hàm đóng vị thế
async function closePosition(symbol, reason) {
    if (isClosingPosition) {
        customLog(`⚠️ Đang trong quá trình đóng lệnh. Bỏ qua yêu cầu đóng lệnh mới cho ${symbol}.`, true);
        return;
    }
    isClosingPosition = true;

    try {
        customLog(`>>> Đóng lệnh ${currentOpenPosition.side} ${symbol} (${reason}). Qty dự kiến: ${currentOpenPosition.quantity}.`, true);

        // Gửi lệnh đóng vị thế MARKET
        const closeSide = currentOpenPosition.side === 'LONG' ? 'SELL' : 'BUY';
        const closeOrderParams = {
            symbol: symbol,
            side: closeSide,
            type: 'MARKET',
            quantity: currentOpenPosition.quantity,
            newOrderRespType: 'FULL',
            reduceOnly: 'true' // Đảm bảo đây là lệnh đóng vị thế
        };
        await sendRequest('POST', '/fapi/v1/order', closeOrderParams, true);
        customLog(`✅ Đã gửi lệnh đóng ${closeSide} ${symbol}. Lý do: ${reason}.`, true);

        // Chờ xác nhận vị thế đóng hoàn toàn trên sàn
        let positionClosed = false;
        for (let i = 0; i < RETRY_CHECK_POSITION_ATTEMPTS; i++) {
            customLog(`>>> Đang chờ xác nhận vị thế ${symbol} (${currentOpenPosition.side}) đã đóng hoàn toàn trên sàn... (Thử ${i + 1}/${RETRY_CHECK_POSITION_ATTEMPTS})`, true);
            await new Promise(resolve => setTimeout(resolve, RETRY_CHECK_POSITION_DELAY_MS));
            const openPositions = await getOpenPositions();
            const position = openPositions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

            if (!position) {
                positionClosed = true;
                customLog(`✅ Vị thế ${symbol} đã xác nhận đóng hoàn toàn trên sàn sau ${i + 1} lần thử.`, true);
                break;
            }
        }

        if (!positionClosed) {
            customLog(`❌ Không thể xác nhận vị thế ${symbol} đã đóng hoàn toàn trên sàn sau ${RETRY_CHECK_POSITION_ATTEMPTS} lần thử.`, true);
            throw new Error(`Vị thế ${symbol} không đóng được.`);
        }

        // Chờ một chút trước khi hủy lệnh để tránh xung đột
        await new Promise(resolve => setTimeout(resolve, DELAY_BEFORE_CANCEL_ORDERS_MS));

        // Hủy tất cả các lệnh chờ sau khi đóng vị thế
        await cancelAllOpenOrders(symbol);

        // Lấy PNL thực tế
        const recentTrades = await sendRequest('GET', '/fapi/v1/userTrades', { symbol: symbol, limit: 5 }, true);
        // Tìm giao dịch đóng vị thế gần nhất
        const closingTrade = recentTrades.find(t => parseFloat(t.positionAmt) === 0 && t.buyer === (closeSide === 'BUY')); // buyer=true for BUY order
        let realizedPnl = 0;
        if (closingTrade && closingTrade.realizedPnl !== '0') {
            realizedPnl = parseFloat(closingTrade.realizedPnl);
            customLog(`💰 PNL thực tế của lệnh vừa đóng: ${realizedPnl.toFixed(4)} USDT.`, true);
        } else {
            customLog(`⚠️ Không tìm thấy PNL thực tế cho lệnh vừa đóng.`, true);
        }

        // Cập nhật tổng PNL và reset trạng thái
        totalPnlUsdt += realizedPnl;
        customLog(`📊 Tổng PNL hiện tại: ${totalPnlUsdt.toFixed(4)} USDT. Tổng vốn đã dùng: ${totalInitialCapitalUsed.toFixed(4)} USDT.`, true);
        
        // Reset trạng thái Martingale
        martingaleLevel = 0;
        currentTradeCapital = AMOUNT_USDT_PER_TRADE_INITIAL;
        currentOpenPosition = null; // Reset vị thế đang mở
        
        // Reset các interval/timeout liên quan đến vị thế
        if (positionCheckInterval) {
            clearInterval(positionCheckInterval);
            positionCheckInterval = null;
        }

    } catch (error) {
        customLog(`❌ Lỗi nghiêm trọng khi đóng vị thế ${symbol}: ${error.message}`, true);
        // Có thể cần xử lý thủ công nếu bot không thể đóng vị thế
    } finally {
        isClosingPosition = false; // Luôn đảm bảo reset cờ
    }
}

// Hàm logic giao dịch chính
async function runTradingLogic() {
    if (!botRunning || isClosingPosition) {
        customLog(`Bot đang tạm dừng hoặc đang trong quá trình đóng lệnh. Bỏ qua chu kỳ giao dịch.`, false);
        return;
    }

    try {
        const balance = await getAccountBalance();
        customLog(`Số dư USDT khả dụng: ${balance.toFixed(2)} USDT.`);

        if (balance < MIN_USDT_BALANCE_TO_OPEN) {
            customLog(`⚠️ Số dư khả dụng (${balance.toFixed(2)} USDT) thấp hơn mức tối thiểu (${MIN_USDT_BALANCE_TO_OPEN} USDT). Không mở lệnh mới.`, true);
            currentOpenPosition = null; // Đảm bảo reset nếu không đủ tiền
            martingaleLevel = 0; // Reset Martingale nếu hết tiền để tránh vòng lặp lỗi
            currentTradeCapital = AMOUNT_USDT_PER_TRADE_INITIAL;
            return;
        }

        const openPositions = await getOpenPositions();

        if (openPositions.length === 0) {
            // Không có vị thế mở, tiến hành mở lệnh mới hoặc lệnh Martingale cấp 0
            currentOpenPosition = null;
            customLog(`Không có vị thế mở. Đang tìm kiếm cơ hội mở lệnh mới (Level 0).`, false);

            const currentPrice = await getCurrentPrice(TARGET_SYMBOL);

            // Xác định hướng đi (có thể dựa trên tín hiệu hoặc random cho mục đích test)
            const side = Math.random() < 0.5 ? 'LONG' : 'SHORT'; // Random cho test

            // Reset Martingale level về 0 khi không có vị thế
            martingaleLevel = 0;
            currentTradeCapital = AMOUNT_USDT_PER_TRADE_INITIAL;
            currentTradeSide = side;

            await openPosition(TARGET_SYMBOL, side, currentTradeCapital, TARGET_LEVERAGE, currentPrice);

        } else {
            // Có vị thế mở, kiểm tra trạng thái và xử lý Martingale
            const position = openPositions.find(p => p.symbol === TARGET_SYMBOL);
            if (!position) {
                customLog(`⚠️ Có vị thế mở nhưng không khớp với TARGET_SYMBOL.`, true);
                currentOpenPosition = null; // Coi như không có vị thế cho TARGET_SYMBOL
                return;
            }

            currentOpenPosition = {
                symbol: position.symbol,
                side: parseFloat(position.positionAmt) > 0 ? 'LONG' : 'SHORT',
                entryPrice: parseFloat(position.entryPrice),
                quantity: Math.abs(parseFloat(position.positionAmt)),
                leverage: parseFloat(position.leverage),
                martingaleLevel: martingaleLevel, // Giữ nguyên level hiện tại
                openTime: currentOpenPosition ? currentOpenPosition.openTime : Date.now()
            };

            const currentPrice = await getCurrentPrice(TARGET_SYMBOL);
            const pnlUsdt = parseFloat(position.unRealizedProfit);
            const pnlPercentage = (pnlUsdt / (currentOpenPosition.entryPrice * currentOpenPosition.quantity / currentOpenPosition.leverage)) * 100;
            
            customLog(`Vị thế ${currentOpenPosition.side} ${TARGET_SYMBOL} đang mở. Giá vào: ${currentOpenPosition.entryPrice}, Giá hiện tại: ${currentPrice}. PNL: ${pnlUsdt.toFixed(4)} USDT (${pnlPercentage.toFixed(2)}%). Level Martingale: ${martingaleLevel}.`, false);

            // Kiểm tra và thực hiện Martingale
            // Điều kiện Martingale: Ví dụ: khi PNL âm đạt một ngưỡng nhất định
            const MARTINGALE_TRIGGER_PERCENTAGE = -5.0; // Kích hoạt Martingale khi lỗ 5% (có thể điều chỉnh)

            if (martingaleLevel < MARTINGALE_MAX_LEVEL && pnlPercentage < MARTINGALE_TRIGGER_PERCENTAGE) {
                customLog(`>>> PNL ${pnlPercentage.toFixed(2)}% < ${MARTINGALE_TRIGGER_PERCENTAGE}%. Kích hoạt Martingale level ${martingaleLevel + 1}.`, true);
                martingaleLevel++;
                currentTradeCapital *= MARTINGALE_MULTIPLIER; // Gấp đôi vốn

                if (balance < currentTradeCapital) {
                    customLog(`❌ Số dư không đủ để Martingale level ${martingaleLevel}. Cần ${currentTradeCapital.toFixed(2)} USDT, chỉ có ${balance.toFixed(2)} USDT.`, true);
                    // Ở đây, bạn có thể chọn đóng vị thế hoặc chờ đợi
                    await closePosition(TARGET_SYMBOL, `Không đủ vốn để Martingale level ${martingaleLevel}.`);
                } else {
                    await openPosition(TARGET_SYMBOL, currentTradeSide, currentTradeCapital, TARGET_LEVERAGE, currentPrice);
                }
            } else if (martingaleLevel >= MARTINGALE_MAX_LEVEL && pnlPercentage < 0) {
                customLog(`⚠️ Đã đạt Martingale level tối đa (${MARTINGALE_MAX_LEVEL}) và đang lỗ. Xem xét đóng vị thế.`, true);
                // Có thể thêm logic đóng lệnh nếu lỗ quá sâu ở level max
                // Ví dụ: Đóng nếu lỗ quá X% ở level cuối cùng
                const MAX_LOSS_AT_LAST_LEVEL = -50.0; // Lỗ 50% tổng vốn vị thế
                if (pnlPercentage < MAX_LOSS_AT_LAST_LEVEL) {
                    customLog(`🔥🔥 Lỗ quá sâu (${pnlPercentage.toFixed(2)}%) ở Martingale level cuối. Đóng vị thế để bảo toàn vốn.`, true);
                    await closePosition(TARGET_SYMBOL, `Lỗ quá sâu ở Martingale level ${MARTINGALE_MAX_LEVEL}.`);
                }
            }
        }

    } catch (error) {
        customLog(`❌ Lỗi trong chu kỳ giao dịch chính: ${error.message}`, true);
        if (error instanceof CriticalApiError) {
            customLog(`Bot đã dừng do lỗi API nghiêm trọng.`, true);
            // Bot sẽ tự động khởi động lại theo logic trong sendRequest
        }
    } finally {
        if (botRunning) {
            const nextRunDelay = Math.random() * 5000 + 5000; // Random từ 5 đến 10 giây
            customLog(`Chờ ${toFixed(nextRunDelay / 1000, 2)} giây cho chu kỳ tiếp theo.`, false);
            nextScheduledTimeout = setTimeout(runTradingLogic, nextRunDelay);
        }
    }
}

// Hàm khởi động bot
function startBot() {
    if (botRunning) {
        customLog("Bot đã đang chạy.", true);
        return;
    }
    botRunning = true;
    botStartTime = new Date();
    customLog("🚀 Khởi động bot thành công!", true);
    // Đồng bộ thời gian server trước
    syncServerTime().then(() => {
        // Sau đó bắt đầu chu kỳ giao dịch
        runTradingLogic();
        // Bắt đầu interval kiểm tra vị thế nếu chưa có
        if (!positionCheckInterval) {
            positionCheckInterval = setInterval(async () => {
                if (currentOpenPosition && !isClosingPosition) {
                    customLog(`Đang kiểm tra vị thế ${TARGET_SYMBOL}...`, false);
                    try {
                        const openPositions = await getOpenPositions();
                        const position = openPositions.find(p => p.symbol === TARGET_SYMBOL && parseFloat(p.positionAmt) !== 0);
                        if (!position && currentOpenPosition) {
                            customLog(`Vị thế ${TARGET_SYMBOL} đã đóng trên sàn. Cập nhật trạng thái bot.`, true);
                            await closePosition(TARGET_SYMBOL, "Đã đóng trên sàn.");
                        } else if (position) {
                            // Cập nhật lại entryPrice và quantity nếu có sự khác biệt (do lệnh khớp một phần, v.v.)
                            if (Math.abs(parseFloat(position.positionAmt)) !== currentOpenPosition.quantity ||
                                parseFloat(position.entryPrice) !== currentOpenPosition.entryPrice) {
                                customLog(`Cập nhật thông tin vị thế ${TARGET_SYMBOL} từ sàn.`, false);
                                currentOpenPosition.quantity = Math.abs(parseFloat(position.positionAmt));
                                currentOpenPosition.entryPrice = parseFloat(position.entryPrice);
                            }
                        }
                    } catch (error) {
                        customLog(`❌ Lỗi khi kiểm tra vị thế định kỳ: ${error.message}`, true);
                    }
                }
            }, 10000); // Kiểm tra mỗi 10 giây
        }
    }).catch(error => {
        customLog(`❌ Lỗi đồng bộ thời gian server khi khởi động: ${error.message}`, true);
        stopBot(); // Dừng bot nếu không đồng bộ được thời gian
    });
}

// Hàm dừng bot
function stopBot(scheduleRestart = false) {
    if (!botRunning) {
        customLog("Bot đã dừng.", true);
        return;
    }
    botRunning = false;
    clearTimeout(nextScheduledTimeout);
    clearInterval(positionCheckInterval);
    nextScheduledTimeout = null;
    positionCheckInterval = null;
    currentCountdownMessage = "Bot đã dừng.";

    if (retryBotTimeout) {
        clearTimeout(retryBotTimeout);
        retryBotTimeout = null;
    }

    if (scheduleRestart) {
        customLog(`Bot sẽ tự khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000} giây...`, true);
        let countdown = ERROR_RETRY_DELAY_MS / 1000;
        currentCountdownMessage = `Bot sẽ tự khởi động lại sau ${countdown} giây...`;

        if (countdownIntervalFrontend) {
            clearInterval(countdownIntervalFrontend);
        }
        countdownIntervalFrontend = setInterval(() => {
            countdown--;
            currentCountdownMessage = `Bot sẽ tự khởi động lại sau ${countdown} giây...`;
            if (countdown <= 0) {
                clearInterval(countdownIntervalFrontend);
                countdownIntervalFrontend = null;
                customLog(`Đang khởi động lại bot...`, true);
                startBot();
            }
        }, 1000);
        retryBotTimeout = setTimeout(() => {
            if (!botRunning) { // Chỉ khởi động lại nếu bot chưa tự chạy lại
                startBot();
            }
        }, ERROR_RETRY_DELAY_MS);
    } else {
        customLog("🛑 Bot đã dừng thành công.", true);
    }
}

// Hàm đồng bộ thời gian với server Binance
async function syncServerTime() {
    try {
        const response = await sendRequest('GET', '/fapi/v1/time');
        const serverTime = response.serverTime;
        serverTimeOffset = serverTime - Date.now();
        customLog(`✅ Đồng bộ thời gian server thành công. Offset: ${serverTimeOffset} ms.`);
    } catch (error) {
        customLog(`❌ Lỗi đồng bộ thời gian server: ${error.message}`, true);
        throw error;
    }
}

// --- WEB SERVER ---
const app = express();
app.use(express.static('public')); // Thư mục public chứa các file tĩnh (html, css, js)

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/status', async (req, res) => {
    let balance = 0;
    let position = null;
    let pnlPercentage = 0;
    let pnlUsdt = 0;
    let currentPrice = 0;

    try {
        balance = await getAccountBalance();
        currentPrice = await getCurrentPrice(TARGET_SYMBOL);
        const openPositions = await getOpenPositions();
        if (openPositions.length > 0) {
            position = openPositions.find(p => p.symbol === TARGET_SYMBOL);
            if (position) {
                pnlUsdt = parseFloat(position.unRealizedProfit);
                pnlPercentage = (pnlUsdt / (parseFloat(position.entryPrice) * Math.abs(parseFloat(position.positionAmt)) / parseFloat(position.leverage))) * 100;
            }
        }
    } catch (error) {
        customLog(`❌ Lỗi khi lấy trạng thái bot cho web: ${error.message}`, false);
    }

    res.json({
        running: botRunning,
        balance: balance.toFixed(2),
        symbol: TARGET_SYMBOL,
        leverage: TARGET_LEVERAGE,
        position: position ? {
            side: parseFloat(position.positionAmt) > 0 ? 'LONG' : 'SHORT',
            entryPrice: parseFloat(position.entryPrice).toFixed(pricePrecision),
            quantity: Math.abs(parseFloat(position.positionAmt)).toFixed(exchangeInfoCache ? exchangeInfoCache[TARGET_SYMBOL].stepSize.toString().split('.')[1].length : 3),
            pnlUsdt: pnlUsdt.toFixed(4),
            pnlPercentage: pnlPercentage.toFixed(2),
            martingaleLevel: martingaleLevel
        } : null,
        currentPrice: currentPrice.toFixed(exchangeInfoCache ? exchangeInfoCache[TARGET_SYMBOL].pricePrecision : 8),
        totalPnlUsdt: totalPnlUsdt.toFixed(4),
        totalInitialCapitalUsed: totalInitialCapitalUsed.toFixed(4),
        countdownMessage: currentCountdownMessage,
        botUptime: botStartTime ? formatUptime(botStartTime) : 'N/A'
    });
});

app.get('/log', (req, res) => {
    fs.readFile(BOT_LOG_FILE, 'utf8', (err, data) => {
        if (err) {
            console.error(`Error reading log file: ${err}`);
            return res.status(500).send('Error reading log file');
        }
        res.send(`<pre>${data}</pre>`);
    });
});

app.post('/start', (req, res) => {
    startBot();
    res.json({ message: 'Bot đang khởi động...' });
});

app.post('/stop', (req, res) => {
    stopBot();
    res.json({ message: 'Bot đang dừng...' });
});

// Hàm format thời gian uptime
function formatUptime(startTime) {
    const now = new Date();
    const diff = now.getTime() - startTime.getTime(); // in milliseconds

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    const remainingHours = hours % 24;
    const remainingMinutes = minutes % 60;
    const remainingSeconds = seconds % 60;

    let uptimeString = '';
    if (days > 0) uptimeString += `${days} ngày `;
    if (remainingHours > 0) uptimeString += `${remainingHours} giờ `;
    if (remainingMinutes > 0) uptimeString += `${remainingMinutes} phút `;
    uptimeString += `${remainingSeconds} giây`;

    return uptimeString.trim();
}

app.listen(WEB_SERVER_PORT, () => {
    customLog(`Web server đang chạy trên cổng ${WEB_SERVER_PORT}`, true);
    // Không tự động khởi động bot khi web server khởi động, chỉ khi có lệnh
});

// Khởi động bot khi file được chạy
// Bạn có thể comment dòng này nếu muốn chỉ khởi động bằng PM2 hoặc qua web UI
startBot(); 
