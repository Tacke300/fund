import https from 'https';
import crypto from 'crypto';
import express from 'express';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
const TAKE_PROFIT_PERCENTAGE_MARTINGALE = 0.005; // 0.5% lợi nhuận trên tổng giá trị vị thế cho mỗi lệnh gấp (Tăng từ 0.05%!)
// Đã thay MIN_PERCENT_PROFIT_TP_SL bằng MIN_TICKS_DISTANCE_FOR_SL_TP
const MIN_TICKS_DISTANCE_FOR_SL_TP = 5; // Số lượng tick tối thiểu mà SL/TP phải cách giá vào lệnh. (Thay MIN_PERCENT_PROFIT_TP_SL)

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

// Hàm utility để gửi HTTP request
async function sendRequest(method, path, params = {}, signed = false) {
    // ... (Hàm này không thay đổi)
}

// Hàm utility để làm tròn số đến số chữ số thập phân nhất định
function toFixed(num, fixed) {
    if (typeof num === 'string') {
        num = parseFloat(num);
    }
    const re = new RegExp('^-?\\d+(?:\\.\\d{0,' + (fixed || -1) + '})?');
    return num.toString().match(re)[0];
}

// Hàm utility để làm tròn theo tickSize/stepSize
const roundToStep = (num, step) => {
    return Math.floor(num / step) * step;
};

// Hàm lấy thông tin exchange
async function getExchangeInfo(symbol) {
    // ... (Hàm này không thay đổi)
}

// Hàm lấy số dư tài khoản
async function getAccountBalance() {
    // ... (Hàm này không thay đổi)
}

// Hàm lấy vị thế đang mở
async function getOpenPositions() {
    // ... (Hàm này không thay đổi)
}

// Hàm điều chỉnh đòn bẩy
async function setLeverage(symbol, leverage) {
    // ... (Hàm này không thay đổi)
}

// Hàm kiểm tra trạng thái bot (API)
async function getBotStatus() {
    // ... (Hàm này không thay đổi)
}

// Hàm tạo timestamp và signature (API)
function createSignature(query_string, secretKey) {
    // ... (Hàm này không thay đổi)
}

// Hàm log tùy chỉnh để tránh spam
function customLog(message, isImportant = false) {
    // ... (Hàm này không thay đổi)
}

// Hàm gửi lệnh TP/SL (đã cải tiến logic tính toán TP/SL)
async function placeStopLossTakeProfit(symbol, side, quantity, entryPrice, leverage) {
    try {
        const exchangeInfo = await getExchangeInfo(symbol);
        const { pricePrecision, tickSize } = exchangeInfo;

        let slPrice, tpPrice;

        if (martingaleLevel === 0) { // Lệnh ban đầu
            // Tính toán giá TP/SL dựa trên phần trăm vốn
            const pnlForSl = currentTradeCapital * STOP_LOSS_PERCENTAGE_INITIAL;
            const pnlForTp = currentTradeCapital * TAKE_PROFIT_PERCENTAGE_INITIAL;

            // Tính toán khoảng cách giá tương ứng
            const priceChangeForSL = pnlForSl / (quantity * leverage);
            const priceChangeForTP = pnlForTp / (quantity * leverage);
            
            // Đảm bảo khoảng cách tối thiểu theo số lượng tick
            const minPriceDistanceAbsolute = tickSize * MIN_TICKS_DISTANCE_FOR_SL_TP;

            if (side === 'LONG') {
                // slPrice phải nhỏ hơn entryPrice, tpPrice phải lớn hơn entryPrice
                slPrice = entryPrice - Math.max(priceChangeForSL, minPriceDistanceAbsolute);
                tpPrice = entryPrice + Math.max(priceChangeForTP, minPriceDistanceAbsolute);

                // Quan trọng: Đảm bảo slPrice KHÔNG BAO GIỜ bằng hoặc lớn hơn entryPrice SAU KHI LÀM TRÒN
                // Và tpPrice KHÔNG BAO GIỜ bằng hoặc nhỏ hơn entryPrice SAU KHI LÀM TRÒN
                slPrice = roundToStep(slPrice, tickSize);
                tpPrice = roundToStep(tpPrice, tickSize);

                // Điều chỉnh lại nếu làm tròn khiến nó trở lại giá vào lệnh hoặc sai hướng
                if (slPrice >= entryPrice) {
                    slPrice = roundToStep(entryPrice - (tickSize * MIN_TICKS_DISTANCE_FOR_SL_TP), tickSize);
                }
                if (tpPrice <= entryPrice) {
                    tpPrice = roundToStep(entryPrice + (tickSize * MIN_TICKS_DISTANCE_FOR_SL_TP), tickSize);
                }

            } else { // SHORT
                // slPrice phải lớn hơn entryPrice, tpPrice phải nhỏ hơn entryPrice
                slPrice = entryPrice + Math.max(priceChangeForSL, minPriceDistanceAbsolute);
                tpPrice = entryPrice - Math.max(priceChangeForTP, minPriceDistanceAbsolute);

                // Quan trọng: Đảm bảo slPrice KHÔNG BAO GIỜ bằng hoặc nhỏ hơn entryPrice SAU KHI LÀM TRÒN
                // Và tpPrice KHÔNG BAO GIỜ bằng hoặc lớn hơn entryPrice SAU KHI LÀM TRÒN
                slPrice = roundToStep(slPrice, tickSize);
                tpPrice = roundToStep(tpPrice, tickSize);

                // Điều chỉnh lại nếu làm tròn khiến nó trở lại giá vào lệnh hoặc sai hướng
                if (slPrice <= entryPrice) {
                    slPrice = roundToStep(entryPrice + (tickSize * MIN_TICKS_DISTANCE_FOR_SL_TP), tickSize);
                }
                if (tpPrice >= entryPrice) {
                    tpPrice = roundToStep(entryPrice - (tickSize * MIN_TICKS_DISTANCE_FOR_SL_TP), tickSize);
                }
            }

        } else { // Lệnh Martingale
            // Tính toán TP dựa trên phần trăm lợi nhuận trên tổng giá trị vị thế
            const pnlForTpMartingale = (entryPrice * quantity) * TAKE_PROFIT_PERCENTAGE_MARTINGALE;

            // Tính toán khoảng cách giá tương ứng
            const priceChangeForTPMartingale = pnlForTpMartingale / quantity;

            // Đảm bảo khoảng cách tối thiểu theo số lượng tick
            const minPriceDistanceAbsolute = tickSize * MIN_TICKS_DISTANCE_FOR_SL_TP;

            if (side === 'LONG') {
                tpPrice = entryPrice + Math.max(priceChangeForTPMartingale, minPriceDistanceAbsolute);
                // SL của lệnh Martingale được đặt ngay dưới giá vào lệnh, hoặc không đặt (nếu bot chỉ TP)
                // Theo log của bạn thì bot đã tự động đóng lệnh khi "SL kích hoạt ngay lập tức".
                // Điều này ngụ ý rằng bạn không đặt SL cho các lệnh Martingale, mà chỉ TP, và SL sẽ là giá vào lệnh của level trước đó
                // hoặc sẽ được xử lý khi giá di chuyển ngược lại quá xa.
                // Để đơn giản, tôi sẽ không đặt SL riêng cho các lệnh Martingale ở đây, bot sẽ tự động đóng vị thế tổng
                // khi giá chạm điểm dừng hoặc khi Martingale không thể tiếp tục.
                slPrice = roundToStep(entryPrice - (tickSize * MIN_TICKS_DISTANCE_FOR_SL_TP), tickSize); // SL mặc định cho Martingale
                if (slPrice >= entryPrice) {
                     slPrice = roundToStep(entryPrice - (tickSize * MIN_TICKS_DISTANCE_FOR_SL_TP), tickSize);
                }
                if (tpPrice <= entryPrice) {
                    tpPrice = roundToStep(entryPrice + (tickSize * MIN_TICKS_DISTANCE_FOR_SL_TP), tickSize);
                }

            } else { // SHORT
                tpPrice = entryPrice - Math.max(priceChangeForTPMartingale, minPriceDistanceAbsolute);
                // Tương tự, SL mặc định cho Martingale
                slPrice = roundToStep(entryPrice + (tickSize * MIN_TICKS_DISTANCE_FOR_SL_TP), tickSize);
                if (slPrice <= entryPrice) {
                    slPrice = roundToStep(entryPrice + (tickSize * MIN_TICKS_DISTANCE_FOR_SL_TP), tickSize);
                }
                if (tpPrice >= entryPrice) {
                    tpPrice = roundToStep(entryPrice - (tickSize * MIN_TICKS_DISTANCE_FOR_SL_TP), tickSize);
                }
            }
        }
        
        // Làm tròn cuối cùng theo pricePrecision để gửi lệnh
        slPrice = parseFloat(toFixed(slPrice, pricePrecision));
        tpPrice = parseFloat(toFixed(tpPrice, pricePrecision));

        customLog(`>>> TP: ${tpPrice}, SL: ${slPrice}`, true);

        // Gửi lệnh SL (STOP_MARKET)
        // ... (phần code gửi lệnh không thay đổi, chỉ giá slPrice được sử dụng)
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
        // ... (kiểm tra lỗi)

        // Gửi lệnh TP (TAKE_PROFIT_MARKET)
        // ... (phần code gửi lệnh không thay đổi, chỉ giá tpPrice được sử dụng)
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
        // ... (kiểm tra lỗi)

    } catch (error) {
        customLog(`❌ Lỗi đặt TP/SL cho ${symbol}: ${error.message || error}`, true);
        if (error.code === -2021) { // "Order would immediately trigger."
            customLog(`⚠️ SL/TP kích hoạt ngay lập tức cho ${symbol}. Đóng vị thế.`, true);
            await closePosition(symbol, "SL/TP kích hoạt."); // Đóng ngay lập tức
        }
        throw new Error(`Lỗi đặt TP/SL: ${error.message}`);
    }
}

// (Các hàm khác của bot không thay đổi)
