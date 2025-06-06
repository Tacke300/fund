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

// === START - BIẾN QUẢN LÝ LỖI VÀ TẦN SUẤT LOG (GLOBAL CHO CÁC CLASS) ===
// Custom Error class cho lỗi API nghiêm trọng
class CriticalApiError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CriticalApiError';
    }
}
// === END - BIẾN QUẢN LÝ LỖI VÀ TẦN SUẤT LOG ===

class BinanceFuturesBot {
    constructor(config) {
        // --- CẤU HÌNH API KEY VÀ SECRET KEY ---
        this.API_KEY = config.apiKey || '';
        this.SECRET_KEY = config.secretKey || '';

        // --- CẤU HÌNH BOT CÁC THAM SỐ GIAO DỊCH ---
        this.INITIAL_INVESTMENT_AMOUNT = parseFloat(config.initialAmount) || 1;
        this.TARGET_COIN_SYMBOL = config.targetSymbol.trim().toUpperCase() || 'ETHUSDT';
        this.APPLY_DOUBLE_STRATEGY = !!config.applyDoubleStrategy;

        // Cấu hình Take Profit & Stop Loss
        this.TAKE_PROFIT_PERCENTAGE_MAIN = 1.55; // 50% lãi trên VỐN
        this.STOP_LOSS_PERCENTAGE_MAIN = 0.8;   // 18% lỗ trên VỐN

        // Số lần thua liên tiếp tối đa trước khi reset về lệnh ban đầu
        this.MAX_CONSECUTIVE_LOSSES = 5;

        // --- BASE URL CỦA BINANCE FUTURES API ---
        this.BASE_HOST = 'fapi.binance.com';

        this.serverTimeOffset = 0; // Offset thời gian để đồng bộ với server Binance

        // Biến cache cho exchangeInfo để tránh gọi API lặp lại
        this.exchangeInfoCache = null;

        // Biến cờ để tránh gửi nhiều lệnh đóng cùng lúc
        this.isClosingPosition = false;

        // Biến cờ điều khiển trạng thái bot (chạy/dừng)
        this.botRunning = false;
        this.botStartTime = null; // Thời điểm bot được khởi động

        // Biến để theo dõi vị thế đang mở
        this.currentOpenPosition = null;
        // Biến để lưu trữ setInterval cho việc kiểm tra vị thế đang mở
        this.positionCheckInterval = null;
        // Biến để lưu trữ setTimeout cho lần chạy tiếp theo của chu kỳ chính (runTradingLogic)
        this.nextScheduledCycleTimeout = null;
        // Biến để lưu trữ setTimeout cho việc tự động khởi động lại bot sau lỗi nghiêm trọng
        this.retryBotTimeout = null;

        // === BIẾN QUẢN LÝ LỖI VÀ TẦN SUẤT LOG CHO TỪNG BOT INSTANCE ===
        this.consecutiveApiErrors = 0; // Đếm số lỗi API liên tiếp
        this.MAX_CONSECUTIVE_API_ERRORS = 5; // Số lỗi API liên tiếp tối đa cho phép trước khi tạm dừng bot
        this.ERROR_RETRY_DELAY_MS = 5000; // Độ trễ (ms) khi bot tạm dừng sau nhiều lỗi (ví dụ: 5 giây)

        // Cache các thông điệp log để tránh spam quá nhiều dòng giống nhau liên tiếp
        this.logCounts = {}; // { messageHash: { count: number, lastLoggedTime: Date } }
        this.LOG_COOLDOWN_MS = 1000; // 1 giây cooldown cho các log không quan trọng lặp lại

        // Biến theo dõi vốn hiện tại cho lệnh
        this.currentInvestmentAmount = this.INITIAL_INVESTMENT_AMOUNT;
        // Biến theo dõi số lần lỗ liên tiếp
        this.consecutiveLossCount = 0;
        // Biến theo dõi hướng lệnh tiếp theo (SHORT là mặc định ban đầu)
        this.nextTradeDirection = 'SHORT'; // Mặc định ban đầu là SHORT

        // Biến để lưu trữ tổng lời/lỗ
        this.totalProfit = 0;
        this.totalLoss = 0;
        this.netPNL = 0;
    }

    // --- HÀM TIỆN ÍCH ---

    // === Cải tiến hàm addLog để tránh spam log giống nhau và tinh gọn log ===
    addLog(message) {
        const now = new Date();
        const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
        let logEntry = `[${time}] [${this.TARGET_COIN_SYMBOL}] ${message}`; // Thêm symbol để dễ phân biệt bot

        const messageHash = crypto.createHash('md5').update(message).digest('hex');

        if (this.logCounts[messageHash]) {
            this.logCounts[messageHash].count++;
            const lastLoggedTime = this.logCounts[messageHash].lastLoggedTime;

            if ((now.getTime() - lastLoggedTime.getTime()) < this.LOG_COOLDOWN_MS) {
                return;
            } else {
                if (this.logCounts[messageHash].count > 1) {
                    console.log(`[${time}] [${this.TARGET_COIN_SYMBOL}] (Lặp lại x${this.logCounts[messageHash].count}) ${message}`);
                }
                this.logCounts[messageHash] = { count: 1, lastLoggedTime: now };
            }
        } else {
            this.logCounts[messageHash] = { count: 1, lastLoggedTime: now };
        }
        console.log(logEntry); // Ghi ra console của server
    }

    // Định dạng thời gian từ Date object sang string theo múi giờ UTC+7 (Asia/Ho_Chi_Minh)
    formatTimeUTC7(dateObject) {
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

    // Tạo chữ ký HMAC SHA256 cho các yêu cầu API
    createSignature(queryString, apiSecret) {
        return crypto.createHmac('sha256', apiSecret)
                            .update(queryString)
                            .digest('hex');
    }

    // Gửi HTTP request cơ bản
    async makeHttpRequest(method, hostname, path, headers, postData = '') {
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
                            errorDetails.msg += ` - Raw: ${data.substring(0, Math.min(data.length, 200))}`; // Tinh gọn log raw
                        }
                        this.addLog(`HTTP Request lỗi: ${errorDetails.msg}`);
                        reject(errorDetails);
                    }
                });
            });

            req.on('error', (e) => {
                this.addLog(`Network lỗi: ${e.message}`);
                reject({ code: 'NETWORK_ERROR', msg: e.message });
            });

            if (method === 'POST' && postData) {
                req.write(postData);
            }
            req.end();
        });
    }

    // Gọi API Binance có chữ ký (dùng cho các thao tác tài khoản, lệnh)
    async callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
        if (!this.API_KEY || !this.SECRET_KEY) {
            throw new CriticalApiError("API Key hoặc Secret Key chưa được cấu hình.");
        }
        const recvWindow = 5000;
        const timestamp = Date.now() + this.serverTimeOffset;

        let queryString = Object.keys(params)
                                        .map(key => `${key}=${params[key]}`)
                                        .join('&');

        queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;

        const signature = this.createSignature(queryString, this.SECRET_KEY);

        let requestPath;
        let requestBody = '';
        const headers = {
            'X-MBX-APIKEY': this.API_KEY,
        };

        if (method === 'GET') {
            requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
            headers['Content-Type'] = 'application/json';
        } else if (method === 'POST') {
            requestPath = fullEndpointPath;
            requestBody = `${queryString}&signature=${signature}`;
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
        } else if (method === 'DELETE') {
            requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
            headers['Content-Type'] = 'application/json';
        } else {
            throw new Error(`Method không hỗ trợ: ${method}`);
        }

        try {
            const rawData = await this.makeHttpRequest(method, this.BASE_HOST, requestPath, headers, requestBody);
            this.consecutiveApiErrors = 0;
            return JSON.parse(rawData);
        } catch (error) {
            this.consecutiveApiErrors++;
            this.addLog(`Lỗi ký API Binance: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
            if (error.code === -2015) {
                this.addLog("  -> Kiểm tra API Key/Secret và quyền Futures.");
            } else if (error.code === -1021) {
                this.addLog("  -> Lỗi lệch thời gian. Đồng bộ đồng hồ máy tính.");
            } else if (error.code === -1022) {
                this.addLog("  -> Lỗi chữ ký. Kiểm tra API Key/Secret hoặc chuỗi tham số.");
            } else if (error.code === 404) {
                this.addLog("  -> Lỗi 404. Đường dẫn API sai.");
            } else if (error.code === 'NETWORK_ERROR') {
                this.addLog("  -> Lỗi mạng.");
            }

            if (this.consecutiveApiErrors >= this.MAX_CONSECUTIVE_API_ERRORS) {
                this.addLog(`Lỗi API liên tiếp. Dừng bot.`, true);
                throw new CriticalApiError("Lỗi API nghiêm trọng, bot dừng.");
            }
            throw error;
        }
    }

    // Gọi API Binance công khai (không cần chữ ký)
    async callPublicAPI(fullEndpointPath, params = {}) {
        const queryString = Object.keys(params)
                                        .map(key => `${key}=${params[key]}`)
                                        .join('&');
        const fullPathWithQuery = `${fullEndpointPath}` + (queryString ? `?${queryString}` : '');

        const headers = {
            'Content-Type': 'application/json',
        };

        try {
            const rawData = await this.makeHttpRequest('GET', this.BASE_HOST, fullPathWithQuery, headers);
            this.consecutiveApiErrors = 0;
            return JSON.parse(rawData);
        } catch (error) {
            this.consecutiveApiErrors++;
            this.addLog(`Lỗi công khai API Binance: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
            if (error.code === 404) {
                this.addLog("  -> Lỗi 404. Đường dẫn API sai.");
            } else if (error.code === 'NETWORK_ERROR') {
                this.addLog("  -> Lỗi mạng.");
            }
            if (this.consecutiveApiErrors >= this.MAX_CONSECUTIVE_API_ERRORS) {
                this.addLog(`Lỗi API liên tiếp. Dừng bot.`, true);
                throw new CriticalApiError("Lỗi API nghiêm trọng, bot dừng.");
            }
            throw error;
        }
    }

    // Đồng bộ thời gian với server Binance để tránh lỗi timestamp
    async syncServerTime() {
        try {
            const data = await this.callPublicAPI('/fapi/v1/time');
            const binanceServerTime = data.serverTime;
            const localTime = Date.now();
            this.serverTimeOffset = binanceServerTime - localTime;
            this.addLog(`Đồng bộ thời gian. Lệch: ${this.serverTimeOffset} ms.`);
        } catch (error) {
            this.addLog(`Lỗi đồng bộ thời gian: ${error.message}.`);
            this.serverTimeOffset = 0;
            throw error;
        }
    }

    // Lấy thông tin đòn bẩy tối đa cho một symbol cụ thể
    async getLeverageBracketForSymbol(symbol) {
        try {
            const response = await this.callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol: symbol });
            if (response && Array.isArray(response) && response.length > 0) {
                const symbolData = response.find(item => item.symbol === symbol);
                if (symbolData && symbolData.brackets && Array.isArray(symbolData.brackets) && symbolData.brackets.length > 0) {
                    const firstBracket = symbolData.brackets[0];
                    return parseInt(firstBracket.maxInitialLeverage || firstBracket.initialLeverage);
                }
            }
            this.addLog(`Không tìm thấy đòn bẩy hợp lệ cho ${symbol}.`);
            return null;
        } catch (error) {
            this.addLog(`Lỗi lấy đòn bẩy cho ${symbol}: ${error.msg || error.message}`);
            return null;
        }
    }

    // Thiết lập đòn bẩy cho một symbol
    async setLeverage(symbol, leverage) {
        try {
            this.addLog(`Đặt đòn bẩy ${leverage}x cho ${symbol}.`);
            await this.callSignedAPI('/fapi/v1/leverage', 'POST', {
                symbol: symbol,
                leverage: leverage
            });
            this.addLog(`Đã đặt đòn bẩy ${leverage}x cho ${symbol}.`);
            return true;
        } catch (error) {
            this.addLog(`Lỗi đặt đòn bẩy ${leverage}x cho ${symbol}: ${error.msg || error.message}`);
            return false;
        }
    }

    // Lấy thông tin sàn (exchangeInfo) và cache lại
    async getExchangeInfo() {
        if (this.exchangeInfoCache) {
            return this.exchangeInfoCache;
        }

        this.addLog('Lấy exchangeInfo...');
        try {
            const data = await this.callPublicAPI('/fapi/v1/exchangeInfo');
            this.addLog(`Đã nhận exchangeInfo. Symbols: ${data.symbols.length}`);

            this.exchangeInfoCache = {};
            data.symbols.forEach(s => {
                const lotSizeFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
                const marketLotSizeFilter = s.filters.find(f => f.filterType === 'MARKET_LOT_SIZE');
                const minNotionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
                const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');

                this.exchangeInfoCache[s.symbol] = {
                    minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : 0),
                    stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : 0.001),
                    minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.notional) : 0,
                    pricePrecision: s.pricePrecision,
                    quantityPrecision: s.quantityPrecision,
                    tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.001
                };
            });
            this.addLog('Đã tải thông tin sàn.');
            return this.exchangeInfoCache;
        } catch (error) {
            this.addLog('Lỗi lấy exchangeInfo: ' + (error.msg || error.message));
            this.exchangeInfoCache = null;
            throw error;
        }
    }

    // Hàm kết hợp để lấy tất cả filters và maxLeverage cho một symbol
    async getSymbolDetails(symbol) {
        const filters = await this.getExchangeInfo();
        if (!filters || !filters[symbol]) {
            this.addLog(`Không tìm thấy filters cho ${symbol}.`);
            return null;
        }
        const maxLeverage = await this.getLeverageBracketForSymbol(symbol);
        return { ...filters[symbol], maxLeverage: maxLeverage };
    }

    // Lấy giá hiện tại của một symbol
    async getCurrentPrice(symbol) {
        try {
            const data = await this.callPublicAPI('/fapi/v1/ticker/price', { symbol: symbol });
            return parseFloat(data.price);
        } catch (error) {
            if (error instanceof CriticalApiError) {
                 this.addLog(`Lỗi nghiêm trọng khi lấy giá cho ${symbol}: ${error.msg || error.message}`);
            }
            return null;
        }
    }

    /**
     * Hủy tất cả các lệnh mở cho một symbol cụ thể.
     * @param {string} symbol - Symbol của cặp giao dịch.
     */
    async cancelOpenOrdersForSymbol(symbol) {
        try {
            await this.callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', { symbol: symbol });
            this.addLog(`Đã hủy tất cả lệnh chờ cho ${symbol}.`);
        } catch (error) {
            this.addLog(`Lỗi hủy lệnh chờ cho ${symbol}: ${error.msg || error.message}`);
        }
    }

    /**
     * Hàm đóng vị thế hiện tại và xử lý logic sau khi đóng.
     * @param {string} symbol - Symbol của cặp giao dịch.
     * @param {number} quantity - Số lượng của vị thế cần đóng (để tham chiếu).
     * @param {string} reason - Lý do đóng vị thế (ví dụ: "TP khớp", "SL khớp", "Thủ công", "Vị thế sót").
     */
    async closePosition(symbol, quantity, reason) {
        this.isClosingPosition = true;

        // Lấy thông tin vị thế đóng
        const positionSideBeforeClose = this.currentOpenPosition?.side; // Lấy hướng lệnh trước khi currentOpenPosition có thể bị reset

        this.addLog(`Đóng lệnh ${positionSideBeforeClose || 'UNKNOWN'} ${symbol} (Lý do: ${reason}). Qty: ${quantity}.`);
        try {
            const symbolInfo = await this.getSymbolDetails(symbol);
            if (!symbolInfo) {
                this.addLog(`Lỗi lấy symbol info ${symbol}. Không đóng lệnh.`);
                this.isClosingPosition = false;
                return;
            }

            const quantityPrecision = symbolInfo.quantityPrecision;

            const positions = await this.callSignedAPI('/fapi/v2/positionRisk', 'GET');
            const currentPositionOnBinance = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

            if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
                this.addLog(`${symbol} đã đóng trên sàn hoặc không có vị thế. Lý do: ${reason}.`);
            } else {
                const actualQuantityToClose = Math.abs(parseFloat(currentPositionOnBinance.positionAmt));
                const adjustedActualQuantity = parseFloat(actualQuantityToClose.toFixed(quantityPrecision));

                // Xác định 'side' để đóng vị thế hiện tại
                const closeSide = (parseFloat(currentPositionOnBinance.positionAmt) < 0) ? 'BUY' : 'SELL'; // BUY để đóng SHORT, SELL để đóng LONG

                this.addLog(`Gửi lệnh đóng ${positionSideBeforeClose}: ${symbol}, ${closeSide}, MARKET, Qty: ${adjustedActualQuantity}`);

                await this.callSignedAPI('/fapi/v1/order', 'POST', {
                    symbol: symbol,
                    side: closeSide,
                    type: 'MARKET',
                    quantity: adjustedActualQuantity,
                    reduceOnly: 'true'
                });

                this.addLog(`Đã gửi lệnh đóng ${positionSideBeforeClose} ${symbol}. Lý do: ${reason}.`);
            }

            // --- BẮT ĐẦU XỬ LÝ LOGIC PNL và HƯỚNG LỆNH TIẾP THEO ---
            let pnlForClosedTrade = 0;
            let pnlCalculated = false;
            const MAX_TRADE_FETCH_RETRIES = 5; // Số lần thử lại tối đa để lấy lịch sử giao dịch
            const TRADE_FETCH_RETRY_DELAY_MS = 500; // Độ trễ giữa các lần thử lại (ms)

            for (let i = 0; i < MAX_TRADE_FETCH_RETRIES; i++) {
                await this.sleep(TRADE_FETCH_RETRY_DELAY_MS); // Đợi để lịch sử giao dịch được cập nhật
                try {
                    // Lấy giao dịch gần nhất của symbol
                    // Sử dụng startTime để chỉ lấy các giao dịch sau khi vị thế được mở
                    const recentTrades = await this.callSignedAPI('/fapi/v1/userTrades', 'GET', {
                        symbol: symbol,
                        limit: 20, // Tăng giới hạn để có nhiều cơ hội tìm thấy trade hơn
                        startTime: this.currentOpenPosition?.openTime?.getTime() // Lọc từ thời điểm mở lệnh
                    });

                    const relevantTrade = recentTrades.find(t => {
                        const tradeQty = parseFloat(t.qty);
                        const tradeSide = t.side; // BUY hoặc SELL
                        const tradeRealizedPnl = parseFloat(t.realizedPnl); // Lấy realizedPnl trực tiếp

                        // Kiểm tra xem đây có phải là giao dịch đóng vị thế và có PNL thực tế
                        const isClosingTrade = (
                            (positionSideBeforeClose === 'LONG' && tradeSide === 'SELL') ||
                            (positionSideBeforeClose === 'SHORT' && tradeSide === 'BUY')
                        ) && tradeRealizedPnl !== 0; // PNL phải khác 0

                        // Kiểm tra số lượng khớp gần đúng (có thể có sai số do precision)
                        const isQuantityMatch = Math.abs(tradeQty - quantity) < 0.000001;

                        // Đảm bảo thời gian giao dịch sau thời điểm mở lệnh
                        const isAfterOpenTime = this.currentOpenPosition?.openTime ? (parseFloat(t.time) >= this.currentOpenPosition.openTime.getTime()) : true;

                        return isClosingTrade && isQuantityMatch && isAfterOpenTime;
                    });

                    if (relevantTrade && relevantTrade.realizedPnl !== undefined && relevantTrade.realizedPnl !== null) {
                        pnlForClosedTrade = parseFloat(relevantTrade.realizedPnl);
                        pnlCalculated = true;
                        this.addLog(`PNL thực tế từ lịch sử giao dịch (realizedPnl): ${pnlForClosedTrade.toFixed(4)} USDT.`);
                        break; // Thoát vòng lặp retry nếu đã tìm thấy PNL
                    } else {
                        this.addLog(`Không tìm thấy realizedPnl trong lịch sử gần đây cho ${symbol} hoặc không khớp. Thử lại ${i + 1}/${MAX_TRADE_FETCH_RETRIES}...`);
                    }
                } catch (tradeError) {
                    this.addLog(`Lỗi khi cố gắng lấy lịch sử giao dịch (thử lại ${i + 1}/${MAX_TRADE_FETCH_RETRIES}): ${tradeError.msg || tradeError.message}`);
                }
            }

            // Fallback: Nếu không tính được PNL từ realizedPnl, cố gắng tính thủ công
            if (!pnlCalculated) {
                this.addLog(`Không thể tìm thấy realizedPnl từ lịch sử sau ${MAX_TRADE_FETCH_RETRIES} lần thử. Cố gắng tính PNL thủ công.`);
                // Sử dụng entryPrice từ currentOpenPosition nếu còn
                if (this.currentOpenPosition && this.currentOpenPosition.entryPrice > 0) {
                    const currentPrice = await this.getCurrentPrice(symbol); // Lấy giá hiện tại
                    if (currentPrice) {
                        if (positionSideBeforeClose === 'LONG') {
                            pnlForClosedTrade = (currentPrice - this.currentOpenPosition.entryPrice) * this.currentOpenPosition.quantity;
                        } else { // SHORT
                            pnlForClosedTrade = (this.currentOpenPosition.entryPrice - currentPrice) * this.currentOpenPosition.quantity;
                        }
                        this.addLog(`PNL ước tính từ giá hiện tại (fallback thủ công): ${pnlForClosedTrade.toFixed(4)} USDT.`);
                    } else {
                        this.addLog(`Không đủ thông tin (currentPrice) để tính PNL thủ công cho ${symbol}.`);
                    }
                } else {
                    this.addLog(`Không đủ thông tin (entryPrice) để tính PNL thủ công cho ${symbol}.`);
                }
            }

            // Cập nhật tổng lời/lỗ
            if (pnlForClosedTrade > 0) {
                this.totalProfit += pnlForClosedTrade;
            } else {
                this.totalLoss += Math.abs(pnlForClosedTrade);
            }
            this.netPNL = this.totalProfit - this.totalLoss;

            this.addLog([
                `🔴 Đã đóng ${positionSideBeforeClose || 'UNKNOWN'} ${symbol}`,
                `├─ Lý do: ${reason}`,
                `├─ PNL: ${pnlForClosedTrade.toFixed(2)} USDT`,
                `├─ Tổng Lời: ${this.totalProfit.toFixed(2)} USDT`,
                `├─ Tổng Lỗ: ${this.totalLoss.toFixed(2)} USDT`,
                `└─ PNL Ròng: ${this.netPNL.toFixed(2)} USDT`
            ].join('\n'));

            // Logic xác định hướng lệnh tiếp theo dựa trên PNL
            if (pnlForClosedTrade >= 0.001) { // PNL dương (kể cả 0.001)
                this.nextTradeDirection = positionSideBeforeClose; // Giữ nguyên hướng
                this.consecutiveLossCount = 0; // Reset chuỗi lỗ
                this.currentInvestmentAmount = this.INITIAL_INVESTMENT_AMOUNT; // Về lại vốn ban đầu
                this.addLog(`PNL dương (${pnlForClosedTrade.toFixed(4)}). Lệnh tiếp theo: GIỮ NGUYÊN HƯỚNG (${this.nextTradeDirection}).`);
            } else { // PNL âm hoặc gần bằng 0
                this.nextTradeDirection = (positionSideBeforeClose === 'LONG' ? 'SHORT' : 'LONG'); // Đảo chiều
                if (this.APPLY_DOUBLE_STRATEGY) {
                    this.consecutiveLossCount++;
                    this.addLog(`PNL âm (${pnlForClosedTrade.toFixed(4)}). Số lần lỗ liên tiếp: ${this.consecutiveLossCount}.`);
                    if (this.consecutiveLossCount >= this.MAX_CONSECUTIVE_LOSSES) {
                        this.currentInvestmentAmount = this.INITIAL_INVESTMENT_AMOUNT; // Về lại vốn ban đầu sau MAX_CONSECUTIVE_LOSSES lần lỗ
                        this.consecutiveLossCount = 0; // Reset chuỗi lỗ
                        this.addLog(`Đã lỗ ${this.MAX_CONSECUTIVE_LOSSES} lần liên tiếp. Reset vốn về ${this.currentInvestmentAmount} USDT và lượt lỗ về 0.`);
                    } else {
                        this.currentInvestmentAmount *= 2; // Gấp đôi vốn cho lệnh tiếp theo
                        this.addLog(`Gấp đôi vốn cho lệnh tiếp theo: ${this.currentInvestmentAmount} USDT.`);
                    }
                } else {
                    this.addLog(`PNL âm (${pnlForClosedTrade.toFixed(4)}). Không áp dụng chiến lược x2 vốn.`);
                    this.currentInvestmentAmount = this.INITIAL_INVESTMENT_AMOUNT; // Giữ nguyên vốn ban đầu
                    this.consecutiveLossCount = 0; // Reset chuỗi lỗ
                }
                this.addLog(`Lệnh tiếp theo: ĐẢO CHIỀU thành (${this.nextTradeDirection}).`);
            }
            // --- KẾT THÚC XỬ LÝ LOGIC PNL và HƯỚNG LỆNH TIẾP THEO ---

            // RESET currentOpenPosition SAU KHI ĐÃ XỬ LÝ TOÀN BỘ LOGIC PNL VÀ HƯỚNG LỆNH TIẾP THEO
            this.currentOpenPosition = null;
            
            // Dọn dẹp các lệnh chờ và kiểm tra vị thế sót
            if (this.positionCheckInterval) {
                clearInterval(this.positionCheckInterval);
                this.positionCheckInterval = null;
            }
            await this.cancelOpenOrdersForSymbol(symbol);
            await this.checkAndHandleRemainingPosition(symbol); // Đảm bảo không còn vị thế sót
            
            // Kích hoạt chu kỳ chính ngay lập tức để mở lệnh mới
            if(this.botRunning) this.scheduleNextMainCycle(); 
            this.isClosingPosition = false;

        } catch (error) {
            this.addLog(`Lỗi đóng vị thế ${symbol}: ${error.msg || error.message}`);
            this.isClosingPosition = false;
            // Nếu có lỗi nghiêm trọng khi đóng, có thể cần dừng bot hoặc thông báo
            if (error instanceof CriticalApiError) {
                this.addLog(`Lỗi API nghiêm trọng khi cố gắng đóng vị thế. Bot dừng.`);
                this.stopBotLogicInternal();
            }
        }
    }

    // Hàm kiểm tra và xử lý vị thế còn sót lại
    async checkAndHandleRemainingPosition(symbol, retryCount = 0) {
        const MAX_RETRY_CHECK_POSITION = 3; // Số lần thử lại tối đa để kiểm tra vị thế sót
        const CHECK_POSITION_RETRY_DELAY_MS = 500; // Độ trễ giữa các lần thử lại (ms)

        this.addLog(`Kiểm tra vị thế còn sót cho ${symbol} (Lần ${retryCount + 1}/${MAX_RETRY_CHECK_POSITION + 1})...`);

        try {
            const positions = await this.callSignedAPI('/fapi/v2/positionRisk', 'GET');
            const remainingPosition = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

            if (remainingPosition && Math.abs(parseFloat(remainingPosition.positionAmt)) > 0) {
                const currentPositionAmount = parseFloat(remainingPosition.positionAmt);
                const currentPrice = await this.getCurrentPrice(symbol);
                const positionSide = currentPositionAmount > 0 ? 'LONG' : 'SHORT';

                this.addLog(`Vị thế ${symbol} còn sót: ${currentPositionAmount} (${positionSide}) @ ${currentPrice}.`);

                if (retryCount < MAX_RETRY_CHECK_POSITION) {
                    this.addLog(`Vị thế sót vẫn còn. Thử lại sau ${CHECK_POSITION_RETRY_DELAY_MS}ms.`);
                    await this.sleep(CHECK_POSITION_RETRY_DELAY_MS);
                    await this.checkAndHandleRemainingPosition(symbol, retryCount + 1); // Gọi đệ quy để thử lại
                } else {
                    this.addLog(`Đã thử ${MAX_RETRY_CHECK_POSITION + 1} lần, vị thế ${symbol} vẫn còn sót. Cố gắng đóng lại lần cuối.`);
                    // Tạo tạm currentOpenPosition để hàm closePosition hoạt động với thông tin cần thiết
                    this.currentOpenPosition = {
                        symbol: symbol,
                        quantity: Math.abs(currentPositionAmount),
                        entryPrice: parseFloat(remainingPosition.entryPrice),
                        initialTPPrice: 0,
                        initialSLPrice: 0,
                        initialMargin: 0,
                        openTime: new Date(parseFloat(remainingPosition.updateTime)),
                        pricePrecision: (this.exchangeInfoCache[symbol] ? this.exchangeInfoCache[symbol].pricePrecision : 8),
                        side: positionSide
                    };
                    await this.closePosition(symbol, Math.abs(currentPositionAmount), 'Vị thế sót cuối cùng');
                }
            } else {
                this.addLog(`Đã xác nhận không còn vị thế ${symbol}.`);
            }
        } catch (error) {
            this.addLog(`Lỗi kiểm tra vị thế sót cho ${symbol}: ${error.code} - ${error.msg || error.message}.`);
            // Không rethrow lỗi ở đây để không làm gián đoạn chu trình chính của bot
        }
    }

    // Hàm chờ một khoảng thời gian
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Hàm mở lệnh (Long hoặc Short)
    async openPosition(symbol, tradeDirection, usdtBalance, maxLeverage) {
        if (this.currentOpenPosition) {
            this.addLog(`Đã có vị thế mở (${this.currentOpenPosition.symbol}). Bỏ qua mở lệnh mới cho ${symbol}.`);
            if(this.botRunning) this.scheduleNextMainCycle();
            return;
        }

        this.addLog(`Mở ${tradeDirection} ${symbol}.`);
        this.addLog(`Mở lệnh với số vốn: ${this.currentInvestmentAmount} USDT.`);
        try {
            const symbolDetails = await this.getSymbolDetails(symbol);
            if (!symbolDetails) {
                this.addLog(`Lỗi lấy chi tiết symbol ${symbol}. Không mở lệnh.`);
                if(this.botRunning) this.scheduleNextMainCycle();
                return;
            }

            const leverageSetSuccess = await this.setLeverage(symbol, maxLeverage);
            if (!leverageSetSuccess) {
                this.addLog(`Lỗi đặt đòn bẩy ${maxLeverage}x cho ${symbol}. Hủy mở lệnh.`);
                if(this.botRunning) this.scheduleNextMainCycle();
                return;
            }

            const { pricePrecision, quantityPrecision, minNotional, minQty, stepSize, tickSize } = symbolDetails;

            const currentPrice = await this.getCurrentPrice(symbol); // Giá thị trường tại thời điểm gửi lệnh
            if (!currentPrice) {
                this.addLog(`Lỗi lấy giá hiện tại cho ${symbol}. Không mở lệnh.`);
                if(this.botRunning) this.scheduleNextMainCycle();
                return;
            }
            this.addLog(`Giá ${symbol} tại thời điểm gửi lệnh: ${currentPrice.toFixed(pricePrecision)}`);

            const capitalToUse = this.currentInvestmentAmount;

            if (usdtBalance < capitalToUse) {
                this.addLog(`Số dư USDT (${usdtBalance.toFixed(2)}) không đủ để mở lệnh (${capitalToUse.toFixed(2)}). Trở về lệnh ban đầu.`);
                // Reset về lệnh ban đầu khi không đủ số dư
                this.currentInvestmentAmount = this.INITIAL_INVESTMENT_AMOUNT;
                this.consecutiveLossCount = 0;
                this.addLog(`Số dư không đủ. Reset vốn về ${this.currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo vẫn là: ${this.nextTradeDirection}.`);
                if(this.botRunning) this.scheduleNextMainCycle();
                return;
            }

            let quantity = (capitalToUse * maxLeverage) / currentPrice;
            quantity = Math.floor(quantity / stepSize) * stepSize;
            quantity = parseFloat(quantity.toFixed(quantityPrecision));

            if (quantity < minQty) {
                this.addLog(`Qty (${quantity.toFixed(quantityPrecision)}) < minQty (${minQty}) cho ${symbol}. Hủy.`);
                if(this.botRunning) this.scheduleNextMainCycle();
                return;
            }

            const currentNotional = quantity * currentPrice;
            if (currentNotional < minNotional) {
                this.addLog(`Notional (${currentNotional.toFixed(pricePrecision)}) < minNotional (${minNotional}) cho ${symbol}. Hủy.`);
                if(this.botRunning) this.scheduleNextMainCycle();
                return;
            }
            if (quantity <= 0) {
                this.addLog(`Qty cho ${symbol} là ${quantity}. Không hợp lệ. Hủy.`);
                if(this.botRunning) this.scheduleNextMainCycle();
                return;
            }

            const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';

            // Gửi lệnh thị trường
            const orderResult = await this.callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: orderSide,
                type: 'MARKET',
                quantity: quantity,
                newOrderRespType: 'FULL'
            });

            this.addLog(`Đã gửi lệnh MARKET để mở ${tradeDirection} ${symbol}.`);

            // --- Đợi 1 giây để lệnh khớp và vị thế được cập nhật trên Binance ---
            await this.sleep(1000);
            this.addLog(`Đã đợi 1 giây sau khi gửi lệnh mở. Đang lấy giá vào lệnh thực tế từ Binance.`);

            // Lấy thông tin vị thế đang mở để có entryPrice chính xác
            const positions = await this.callSignedAPI('/fapi/v2/positionRisk', 'GET');
            const openPositionOnBinance = positions.find(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);

            // Kiểm tra các vị thế khác không phải là symbol hiện tại
            const otherOpenPositions = positions.filter(p => p.symbol !== symbol && parseFloat(p.positionAmt) !== 0);
            if (otherOpenPositions.length > 0) {
                this.addLog(`Cảnh báo: Có vị thế đang mở khác cho bot này trên sàn: ${otherOpenPositions.map(p => `${p.symbol} (${p.positionAmt})`).join(', ')}.`);
                // Bạn có thể thêm logic ở đây để xử lý các vị thế này (ví dụ: đóng chúng)
                // Tuy nhiên, theo yêu cầu ban đầu là mỗi bot chạy một coin, thì trường hợp này không nên xảy ra.
                // Nếu xảy ra, có thể do thao tác thủ công hoặc lỗi logic.
                // Đối với mục đích chạy nhiều bot độc lập, ta sẽ chỉ quản lý vị thế của TARGET_COIN_SYMBOL.
                // Nếu bot này chỉ được phép có 1 vị thế mở, thì có thể dừng hoặc báo động.
            }


            if (!openPositionOnBinance) {
                this.addLog(`Không tìm thấy vị thế mở cho ${symbol} sau 1 giây. Có thể lệnh không khớp hoặc đã đóng ngay lập tức.`);
                if(this.botRunning) this.scheduleNextMainCycle();
                return;
            }

            const entryPrice = parseFloat(openPositionOnBinance.entryPrice);
            const actualQuantity = Math.abs(parseFloat(openPositionOnBinance.positionAmt)); // Lấy số lượng thực tế của vị thế
            const openTime = new Date(parseFloat(openPositionOnBinance.updateTime || Date.now())); // Thời gian cập nhật vị thế
            const formattedOpenTime = this.formatTimeUTC7(openTime);

            this.addLog(`Đã mở ${tradeDirection} ${symbol} lúc ${formattedOpenTime}`);
            this.addLog(`  + Đòn bẩy: ${maxLeverage}x`);
            this.addLog(`  + Ký quỹ: ${capitalToUse.toFixed(2)} USDT | Qty thực tế: ${actualQuantity} ${symbol} | Giá vào thực tế: ${entryPrice.toFixed(pricePrecision)}`);

            // --- Hủy tất cả các lệnh chờ hiện tại (TP/SL) nếu có trước khi đặt lại ---
            await this.cancelOpenOrdersForSymbol(symbol);
            this.addLog(`Đã hủy các lệnh chờ cũ (nếu có) cho ${symbol}.`);

            // --- BẮT ĐẦU TÍNH TOÁN TP/SL THEO % VỐN (dùng giá vào lệnh thực tế và số lượng thực tế) ---
            const profitTargetUSDT = capitalToUse * this.TAKE_PROFIT_PERCENTAGE_MAIN;
            const lossLimitUSDT = capitalToUse * this.STOP_LOSS_PERCENTAGE_MAIN;

            const priceChangeForTP = profitTargetUSDT / actualQuantity;
            const priceChangeForSL = lossLimitUSDT / actualQuantity;

            let slPrice, tpPrice;
            let slOrderSide, tpOrderSide;

            if (tradeDirection === 'LONG') {
                slPrice = entryPrice - priceChangeForSL;
                tpPrice = entryPrice + priceChangeForTP;
                slOrderSide = 'SELL';
                tpOrderSide = 'SELL';

                slPrice = Math.floor(slPrice / tickSize) * tickSize;
                tpPrice = Math.floor(tpPrice / tickSize) * tickSize;

            } else { // SHORT
                slPrice = entryPrice + priceChangeForSL;
                tpPrice = entryPrice - priceChangeForTP;
                slOrderSide = 'BUY';
                tpOrderSide = 'BUY';

                slPrice = Math.ceil(slPrice / tickSize) * tickSize;
                tpPrice = Math.ceil(tpPrice / tickSize) * tickSize;
            }

            slPrice = parseFloat(slPrice.toFixed(pricePrecision));
            tpPrice = parseFloat(tpPrice.toFixed(pricePrecision));

            this.addLog(`TP: ${tpPrice.toFixed(pricePrecision)}, SL: ${slPrice.toFixed(pricePrecision)}`);

            try {
                await this.callSignedAPI('/fapi/v1/order', 'POST', {
                    symbol: symbol,
                    side: slOrderSide,
                    type: 'STOP_MARKET',
                    quantity: actualQuantity,
                    stopPrice: slPrice,
                    closePosition: 'true',
                    newOrderRespType: 'FULL'
                });
                this.addLog(`Đã đặt SL cho ${symbol} @ ${slPrice.toFixed(pricePrecision)}.`);
            } catch (slError) {
                this.addLog(`Lỗi đặt SL cho ${symbol}: ${slError.msg || slError.message}.`);
                if (slError.code === -2021 || (slError.msg && slError.msg.includes('Order would immediately trigger'))) {
                    this.addLog(`SL kích hoạt ngay lập tức cho ${symbol}. Đóng vị thế.`);
                    await this.closePosition(symbol, actualQuantity, 'SL kích hoạt ngay');
                    return;
                }
            }

            try {
                await this.callSignedAPI('/fapi/v1/order', 'POST', {
                    symbol: symbol,
                    side: tpOrderSide,
                    type: 'TAKE_PROFIT_MARKET',
                    quantity: actualQuantity,
                    stopPrice: tpPrice,
                    closePosition: 'true',
                    newOrderRespType: 'FULL'
                });
                this.addLog(`Đã đặt TP cho ${symbol} @ ${tpPrice.toFixed(pricePrecision)}.`);
            } catch (tpError) {
                this.addLog(`Lỗi đặt TP cho ${symbol}: ${tpError.msg || tpError.message}.`);
                if (tpError.code === -2021 || (tpError.msg && tpError.msg.includes('Order would immediately trigger'))) {
                    this.addLog(`TP kích hoạt ngay lập tức cho ${symbol}. Đóng vị thế.`);
                    await this.closePosition(symbol, actualQuantity, 'TP kích hoạt ngay');
                    return;
                }
            }

            this.currentOpenPosition = {
                symbol: symbol,
                quantity: actualQuantity,
                entryPrice: entryPrice,
                initialTPPrice: tpPrice,
                initialSLPrice: slPrice,
                initialMargin: capitalToUse,
                openTime: openTime,
                pricePrecision: pricePrecision,
                side: tradeDirection
            };

            if(!this.positionCheckInterval) {
                this.positionCheckInterval = setInterval(async () => {
                    if (this.botRunning && this.currentOpenPosition) {
                        try {
                            await this.manageOpenPosition();
                        }
                        catch (error) {
                            this.addLog(`Lỗi kiểm tra vị thế định kỳ: ${error.msg || error.message}.`);
                        }
                    } else if (!this.botRunning && this.positionCheckInterval) {
                        clearInterval(this.positionCheckInterval);
                        this.positionCheckInterval = null;
                    }
                }, 300);
            }

        } catch (error) {
            this.addLog(`Lỗi mở ${tradeDirection} ${symbol}: ${error.msg || error.message}`);
            if(error instanceof CriticalApiError) {
                this.addLog(`Bot dừng do lỗi API nghiêm trọng khi mở lệnh.`);
                this.stopBotLogicInternal(); // Dừng bot nếu lỗi API nghiêm trọng
            } else if(this.botRunning) {
                this.scheduleNextMainCycle();
            }
        }
    }

    /**
     * Hàm kiểm tra và quản lý vị thế đang mở (SL/TP)
     */
    async manageOpenPosition() {
        if (!this.currentOpenPosition || this.isClosingPosition) {
            if (!this.currentOpenPosition && this.positionCheckInterval) {
                clearInterval(this.positionCheckInterval);
                this.positionCheckInterval = null;
                if(this.botRunning) this.scheduleNextMainCycle();
            }
            return;
        }

        const { symbol, quantity, side } = this.currentOpenPosition; // Removed initialTPPrice, initialSLPrice as they are not used for PNL decision anymore

        try {
            const positions = await this.callSignedAPI('/fapi/v2/positionRisk', 'GET');
            const currentPositionOnBinance = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

            // Nếu vị thế không còn trên sàn Binance
            if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
                this.addLog(`Vị thế ${symbol} đã đóng trên sàn. Cập nhật bot.`);
                await this.closePosition(symbol, quantity, 'Đã đóng trên sàn'); // Call closePosition to handle PNL logic
                return;
            }

            // Cập nhật PNL chưa hiện thực hóa để hiển thị trên UI
            const currentPrice = await this.getCurrentPrice(symbol);
            if (currentPrice) {
                let unrealizedPnl = 0;
                if (side === 'LONG') {
                    unrealizedPnl = (currentPrice - this.currentOpenPosition.entryPrice) * this.currentOpenPosition.quantity;
                } else { // SHORT
                    unrealizedPnl = (this.currentOpenPosition.entryPrice - currentPrice) * this.currentOpenPosition.quantity;
                }
                this.currentOpenPosition.unrealizedPnl = unrealizedPnl; // Lưu trữ PNL chưa hiện thực hóa
                this.currentOpenPosition.currentPrice = currentPrice; // Lưu trữ giá hiện tại
            }


        } catch (error) {
            this.addLog(`Lỗi quản lý vị thế mở cho ${symbol}: ${error.msg || error.message}`);
            if(error instanceof CriticalApiError) {
                this.addLog(`Bot dừng do lỗi API nghiêm trọng khi quản lý vị thế.`);
                this.stopBotLogicInternal(); // Dừng bot nếu lỗi API nghiêm trọng
            }
        }
    }

    // Hàm chạy logic tìm kiếm cơ hội (chỉ chạy khi không có lệnh mở)
    async runTradingLogic() {
        if (!this.botRunning) {
            this.addLog('Bot dừng. Hủy chu kỳ quét.');
            return;
        }

        if (this.currentOpenPosition) {
            this.addLog('Có vị thế mở. Bỏ qua quét mới.');
            return;
        }

        this.addLog(`Cố gắng mở lệnh ${this.TARGET_COIN_SYMBOL} không phanh...`);
        try {
            const accountInfo = await this.callSignedAPI('/fapi/v2/account', 'GET');
            const usdtAsset = accountInfo.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
            const availableBalance = parseFloat(usdtAsset);

            const targetSymbol = this.TARGET_COIN_SYMBOL;
            let eligibleSymbol = null;

            const symbolDetails = await this.getSymbolDetails(targetSymbol);
            if (symbolDetails && typeof symbolDetails.maxLeverage === 'number' && symbolDetails.maxLeverage > 1) {
                const currentPrice = await this.getCurrentPrice(targetSymbol);
                if (currentPrice === null) {
                    this.addLog(`Lỗi lấy giá cho ${targetSymbol}. Bỏ qua. Sẽ thử lại ngay.`);
                } else {
                    let estimatedQuantity = (this.currentInvestmentAmount * symbolDetails.maxLeverage) / currentPrice;
                    estimatedQuantity = Math.floor(estimatedQuantity / symbolDetails.stepSize) * symbolDetails.stepSize;
                    estimatedQuantity = parseFloat(estimatedQuantity.toFixed(symbolDetails.quantityPrecision));

                    const currentNotional = estimatedQuantity * currentPrice;

                    if (currentNotional >= symbolDetails.minNotional && estimatedQuantity >= symbolDetails.minQty) {
                        eligibleSymbol = {
                            symbol: targetSymbol,
                            maxLeverage: symbolDetails.maxLeverage
                        };
                    } else {
                        this.addLog(`${targetSymbol}: KHÔNG ĐỦ ĐIỀU KIỆN mở lệnh (minNotional/minQty). Sẽ thử lại ngay.`);
                    }
                }
            } else {
                this.addLog(`${targetSymbol}: Không có đòn bẩy hợp lệ hoặc không tìm thấy symbol. Sẽ thử lại ngay.`);
            }

            if (availableBalance < this.currentInvestmentAmount) {
                this.addLog(`Số dư USDT (${availableBalance.toFixed(2)}) không đủ để mở lệnh (${this.currentInvestmentAmount.toFixed(2)} USDT). Trở về lệnh ban đầu.`);
                this.currentInvestmentAmount = this.INITIAL_INVESTMENT_AMOUNT;
                this.consecutiveLossCount = 0;
                this.addLog(`Số dư không đủ. Reset vốn về ${this.currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo vẫn là: ${this.nextTradeDirection}.`);
                this.scheduleNextMainCycle();
                return;
            }

            if (eligibleSymbol) {
                this.addLog(`\nChọn: ${eligibleSymbol.symbol}`);
                this.addLog(`  + Đòn bẩy: ${eligibleSymbol.maxLeverage}x | Vốn: ${this.currentInvestmentAmount.toFixed(2)} USDT`);
                this.addLog(`Mở lệnh ${this.nextTradeDirection} ngay lập tức.`);

                await this.openPosition(eligibleSymbol.symbol, this.nextTradeDirection, availableBalance, eligibleSymbol.maxLeverage);

            } else {
                this.addLog(`Không thể mở lệnh ${this.nextTradeDirection} cho ${targetSymbol}. Sẽ thử lại ngay.`);
                if(this.botRunning) this.scheduleNextMainCycle();
            }
        } catch (error) {
            this.addLog('Lỗi trong chu kỳ giao dịch: ' + (error.msg || error.message));
            if (error instanceof CriticalApiError) {
                this.addLog(`Bot dừng do lỗi API lặp lại. Tự động thử lại sau ${this.ERROR_RETRY_DELAY_MS / 1000}s.`);
                this.stopBotLogicInternal();
                this.retryBotTimeout = setTimeout(async () => {
                    this.addLog('Thử khởi động lại bot...');
                    await this.startBotLogicInternal();
                    this.retryBotTimeout = null;
                }, this.ERROR_RETRY_DELAY_MS);
            } else {
                if(this.botRunning) this.scheduleNextMainCycle();
            }
        }
    }

    // Hàm lên lịch chu kỳ chính của bot (đã bỏ delay)
    async scheduleNextMainCycle() {
        if (!this.botRunning) {
            this.addLog('Bot dừng. Không lên lịch chu kỳ mới.');
            clearTimeout(this.nextScheduledCycleTimeout);
            return;
        }

        if (this.currentOpenPosition) {
            this.addLog('Có vị thế mở. Chờ đóng vị thế hiện tại.');
            return;
        }

        clearTimeout(this.nextScheduledCycleTimeout);

        await this.runTradingLogic();
    }


    // --- HÀM KHỞI ĐỘNG/DỪNG LOGIC BOT (nội bộ, không phải lệnh PM2) ---

    async startBotLogicInternal() {
        if (this.botRunning) {
            this.addLog('Bot đang chạy.');
            return 'Bot đang chạy.';
        }

        if (!this.API_KEY || !this.SECRET_KEY) {
            this.addLog('Lỗi: API Key hoặc Secret Key chưa được cấu hình.');
            return 'Lỗi: API Key hoặc Secret Key chưa được cấu hình.';
        }

        if (this.retryBotTimeout) {
            clearTimeout(this.retryBotTimeout);
            this.retryBotTimeout = null;
            this.addLog('Hủy lịch tự động khởi động lại bot.');
        }

        this.addLog('--- Khởi động Bot ---');
        this.addLog('Kiểm tra kết nối API Binance Futures...');

        try {
            await this.syncServerTime();

            const account = await this.callSignedAPI('/fapi/v2/account', 'GET');
            const usdtBalance = account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
            this.addLog(`API Key OK! USDT khả dụng: ${parseFloat(usdtBalance).toFixed(2)}`);

            this.consecutiveApiErrors = 0;

            await this.getExchangeInfo();
            if (!this.exchangeInfoCache) {
                this.addLog('Lỗi tải exchangeInfo. Bot dừng.');
                this.botRunning = false;
                return 'Không thể tải exchangeInfo.';
            }

            this.botRunning = true;
            this.botStartTime = new Date();
            this.addLog(`--- Bot đã chạy lúc ${this.formatTimeUTC7(this.botStartTime)} ---`);
            this.addLog(`Vốn ban đầu cho mỗi lệnh: ${this.INITIAL_INVESTMENT_AMOUNT} USDT.`);

            this.currentInvestmentAmount = this.INITIAL_INVESTMENT_AMOUNT;
            this.consecutiveLossCount = 0;
            this.nextTradeDirection = 'SHORT'; // Reset hướng lệnh về ban đầu khi khởi động

            this.scheduleNextMainCycle();

            if (!this.positionCheckInterval) {
                this.positionCheckInterval = setInterval(async () => {
                    if (this.botRunning && this.currentOpenPosition) {
                        try {
                            await this.manageOpenPosition();
                        } catch (error) {
                            this.addLog(`Lỗi kiểm tra vị thế định kỳ: ${error.msg || error.message}.`);
                            if(error instanceof CriticalApiError) {
                                this.addLog(`Bot dừng do lỗi API trong kiểm tra vị thế.`);
                                this.stopBotLogicInternal();
                                if (!this.retryBotTimeout) {
                                    this.addLog(`Lên lịch tự động khởi động lại sau ${this.ERROR_RETRY_DELAY_MS / 1000}s.`);
                                    this.retryBotTimeout = setTimeout(async () => {
                                        this.addLog('Thử khởi động lại bot...');
                                        await this.startBotLogicInternal();
                                        this.retryBotTimeout = null;
                                    }, this.ERROR_RETRY_DELAY_MS);
                                }
                            }
                        }
                    } else if (!this.botRunning && this.positionCheckInterval) {
                        clearInterval(this.positionCheckInterval);
                        this.positionCheckInterval = null;
                    }
                }, 300);
            }

            return 'Bot khởi động thành công.';

        } catch (error) {
            const errorMsg = error.msg || error.message;
            this.addLog('[Lỗi khởi động bot] ' + errorMsg);
            this.addLog('   -> Bot dừng. Kiểm tra và khởi động lại.');

            this.stopBotLogicInternal();
            if (error instanceof CriticalApiError && !this.retryBotTimeout) {
                this.addLog(`Lên lịch tự động khởi động lại sau ${this.ERROR_RETRY_DELAY_MS / 1000}s.`);
                this.retryBotTimeout = setTimeout(async () => {
                    this.addLog('Thử khởi động lại bot...');
                    await this.startBotLogicInternal();
                    this.retryBotTimeout = null;
                }, this.ERROR_RETRY_DELAY_MS);
            }
            return `Lỗi khởi động bot: ${errorMsg}`;
        }
    }

    stopBotLogicInternal() {
        if (!this.botRunning) {
            this.addLog('Bot không chạy.');
            return 'Bot không chạy.';
        }
        this.botRunning = false;
        clearTimeout(this.nextScheduledCycleTimeout);
        if (this.positionCheckInterval) {
            clearInterval(this.positionCheckInterval);
            this.positionCheckInterval = null;
        }
        this.consecutiveApiErrors = 0;
        if (this.retryBotTimeout) {
            clearTimeout(this.retryBotTimeout);
            this.retryBotTimeout = null;
            this.addLog('Hủy lịch tự động khởi động lại bot.');
        }
        this.addLog('--- Bot đã dừng ---');
        this.botStartTime = null;
        return 'Bot đã dừng.';
    }
}

// --- KHỞI TẠO SERVER WEB VÀ CÁC API ENDPOINT ---
const app = express();
app.use(express.json()); // Để parse JSON trong body của request POST

// --- CẤU HÌNH CỤ THỂ CHO BOT NÀY (ĐÂY LÀ NƠI BẠN SẼ THAY ĐỔI KHI NHÂN BẢN FILE) ---
// Ví dụ:
const WEB_SERVER_PORT = 1236; // Cần thay đổi cho mỗi bản sao bot
const BOT_LOG_FILE = '/home/tacke300/.pm2/logs/bot-bina-eth-out.log'; // Cần thay đổi cho mỗi bản sao bot
const THIS_BOT_PM2_NAME = 'tung01'; // Cần thay đổi cho mỗi bản sao bot

// Khởi tạo một instance bot duy nhất cho file này
// Các giá trị mặc định, sẽ được cập nhật từ UI
const botInstance = new BinanceFuturesBot({
    apiKey: '',
    secretKey: '',
    targetSymbol: 'ETHUSDT',
    initialAmount: 1,
    applyDoubleStrategy: false
});


app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/logs', (req, res) => {
    fs.readFile(BOT_LOG_FILE, 'utf8', (err, data) => {
        if (err) {
            console.error('Lỗi đọc log file:', err);
            if (err.code === 'ENOENT') {
                return res.status(404).send(`Không tìm thấy log file: ${BOT_LOG_FILE}.`);
            }
            return res.status(500).send('Lỗi đọc log file');
        }
        const cleanData = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

        const lines = cleanData.split('\n');
        const maxDisplayLines = 500;
        const startIndex = Math.max(0, lines.length - maxDisplayLines);
        const limitedLogs = lines.slice(startIndex).join('\n');

        res.send(limitedLogs);
    });
});

app.get('/api/status', async (req, res) => {
    try {
        const pm2List = await new Promise((resolve, reject) => {
            exec('pm2 jlist', (error, stdout, stderr) => {
                if (error) reject(stderr || error.message);
                resolve(stdout);
            });
        });
        const processes = JSON.parse(pm2List);
        const botProcess = processes.find(p => p.name === THIS_BOT_PM2_NAME);

        let statusMessage = 'MAY CHU: DA TAT (PM2)';
        if (botProcess) {
            statusMessage = `MAY CHU: ${botProcess.pm2_env.status.toUpperCase()} (Restarts: ${botProcess.pm2_env.restart_time})`;
            if (botProcess.pm2_env.status === 'online') {
                statusMessage += ` | TRANG THAI: ${botInstance.botRunning ? 'DANG CHAY' : 'DA DUNG'}`;
                if (botInstance.botStartTime) {
                    const uptimeMs = Date.now() - botInstance.botStartTime.getTime();
                    const uptimeMinutes = Math.floor(uptimeMs / (1000 * 60));
                    statusMessage += ` | DA CHAY: ${uptimeMinutes} phút`;
                }
            }
        } else {
            statusMessage = `Bot: Không tìm thấy trong PM2 (Tên: ${THIS_BOT_PM2_NAME})`;
        }
        res.send(statusMessage);
    } catch (error) {
        console.error('Lỗi lấy trạng thái PM2:', error);
        res.status(500).send(`Bot: Lỗi lấy trạng thái. (${error})`);
    }
});

// Endpoint để lấy thống kê giao dịch
app.get('/api/bot_stats', async (req, res) => {
    try {
        let openPositionsData = [];
        if (botInstance.currentOpenPosition) {
            openPositionsData.push({
                symbol: botInstance.currentOpenPosition.symbol,
                side: botInstance.currentOpenPosition.side,
                quantity: botInstance.currentOpenPosition.quantity,
                entryPrice: botInstance.currentOpenPosition.entryPrice,
                currentPrice: botInstance.currentOpenPosition.currentPrice || 0, // Cập nhật từ manageOpenPosition
                unrealizedPnl: botInstance.currentOpenPosition.unrealizedPnl || 0, // Cập nhật từ manageOpenPosition
                pricePrecision: botInstance.currentOpenPosition.pricePrecision
            });
        }

        res.json({
            success: true,
            data: {
                totalProfit: botInstance.totalProfit,
                totalLoss: botInstance.totalLoss,
                netPNL: botInstance.netPNL,
                currentOpenPositions: openPositionsData
            }
        });
    } catch (error) {
        console.error('Lỗi khi lấy thống kê bot:', error);
        res.status(500).json({ success: false, message: 'Lỗi khi lấy thống kê bot.' });
    }
});


// Endpoint để cấu hình các tham số từ frontend
app.post('/api/configure', (req, res) => {
    const { apiKey, secretKey, coinConfigs } = req.body;

    // Cập nhật cấu hình cho botInstance
    botInstance.API_KEY = apiKey.trim();
    botInstance.SECRET_KEY = secretKey.trim();

    if (coinConfigs && coinConfigs.length > 0) {
        const config = coinConfigs[0];
        botInstance.TARGET_COIN_SYMBOL = config.symbol.trim().toUpperCase();
        botInstance.INITIAL_INVESTMENT_AMOUNT = parseFloat(config.initialAmount);
        botInstance.APPLY_DOUBLE_STRATEGY = !!config.applyDoubleStrategy;
    } else {
        botInstance.addLog("Cảnh báo: Không có cấu hình đồng coin nào được gửi.");
    }

    // Cập nhật các biến trạng thái liên quan đến cấu hình ban đầu
    botInstance.currentInvestmentAmount = botInstance.INITIAL_INVESTMENT_AMOUNT;
    botInstance.consecutiveLossCount = 0; // Reset khi cấu hình lại
    botInstance.nextTradeDirection = 'SHORT'; // Reset khi cấu hình lại

    botInstance.addLog(`Đã cập nhật cấu hình:`);
    botInstance.addLog(`  API Key: ${botInstance.API_KEY ? 'Đã thiết lập' : 'Chưa thiết lập'}`);
    botInstance.addLog(`  Secret Key: ${botInstance.SECRET_KEY ? 'Đã thiết lập' : 'Chưa thiết lập'}`);
    botInstance.addLog(`  Đồng coin: ${botInstance.TARGET_COIN_SYMBOL}`);
    botInstance.addLog(`  Số vốn ban đầu: ${botInstance.INITIAL_INVESTMENT_AMOUNT} USDT`);
    botInstance.addLog(`  Chiến lược x2 vốn: ${botInstance.APPLY_DOUBLE_STRATEGY ? 'Bật' : 'Tắt'}`);

    res.json({ success: true, message: 'Cấu hình đã được cập nhật.' });
});

app.get('/start_bot_logic', async (req, res) => {
    const message = await botInstance.startBotLogicInternal();
    res.send(message);
});

app.get('/stop_bot_logic', (req, res) => {
    const message = botInstance.stopBotLogicInternal();
    res.send(message);
});

app.listen(WEB_SERVER_PORT, () => {
    console.log(`Web server trên cổng ${WEB_SERVER_PORT}`);
    console.log(`Truy cập: http://localhost:${WEB_SERVER_PORT}`);
});
