const axios = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');

// --- CẤU HÌNH BOT ---
const API_KEY = 'YOUR_BINANCE_API_KEY'; // Thay thế bằng API Key của bạn
const API_SECRET = 'YOUR_BINANCE_API_SECRET'; // Thay thế bằng API Secret của bạn
const BASE_URL = 'https://fapi.binance.com'; // Hoặc 'https://testnet.binancefuture.com' cho testnet
const WS_URL = 'wss://fstream.binance.com/ws'; // Hoặc 'wss://fstream.binance.com/ws' cho testnet

const SYMBOL = 'BTCUSDT'; // Cặp giao dịch
const INITIAL_INVESTMENT_AMOUNT = 5; // Số USDT đầu tư ban đầu cho mỗi lệnh (ví dụ: 5 USDT)
const LEVERAGE = 75; // Đòn bẩy (lưu ý: đòn bẩy tối đa tùy thuộc vào cặp)
const MIN_PERCENTAGE_TO_OPEN = 1.0; // Phần trăm thay đổi giá tối thiểu để mở lệnh (ví dụ: 1% để mở lệnh mới)
const MAX_OPEN_ATTEMPTS = 5; // Số lần thử mở lệnh tối đa nếu không thành công
const OPEN_ATTEMPT_DELAY_MS = 5000; // Độ trễ giữa các lần thử mở lệnh (ms)
const BOT_RUN_INTERVAL_MS = 3000; // Khoảng thời gian chạy lại logic bot (ms)

// Biến lưu trạng thái bot
let botRunning = false;
let currentLongPosition = null;
let currentShortPosition = null;
let lastLongOrderTime = 0;
let lastShortOrderTime = 0;
let lastPrice = 0;
let currentPrice = 0;
let openAttempts = { LONG: 0, SHORT: 0 };
let exchangeInfoCache = {}; // Cache thông tin sàn giao dịch

// --- HÀM HỖ TRỢ CHUNG ---

function addLog(message) {
    const timestamp = new Date().toLocaleString();
    console.log(`[${timestamp}] ${message}`);
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Xử lý lỗi API
class CriticalApiError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'CriticalApiError';
        this.code = code;
    }
}

async function callSignedAPI(path, method, params = {}) {
    const timestamp = Date.now();
    const queryString = new URLSearchParams({
        ...params,
        timestamp: timestamp
    }).toString();
    const signature = crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
    const url = `${BASE_URL}${path}?${queryString}&signature=${signature}`;

    try {
        const response = await axios({
            method: method,
            url: url,
            headers: { 'X-MBX-APIKEY': API_KEY }
        });
        return response.data;
    } catch (error) {
        const status = error.response ? error.response.status : 'N/A';
        const msg = error.response && error.response.data ? error.response.data.msg : 'Unknown error';
        const code = error.response && error.response.data ? error.response.data.code : 'N/A';
        addLog(`Lỗi API ${method} ${path} (${status}): ${msg} (Code: ${code})`);

        // Các lỗi nghiêm trọng cần dừng bot
        if (code === -2015 || code === -1022 || status === 401 || status === 403 || status === 429) {
            throw new CriticalApiError(msg, code);
        }
        throw error; // Ném lại lỗi để xử lý tiếp
    }
}

async function callPublicAPI(path, params = {}) {
    try {
        const response = await axios.get(`${BASE_URL}${path}`, { params });
        return response.data;
    } catch (error) {
        const msg = error.response && error.response.data ? error.response.data.msg : 'Unknown error';
        const code = error.response && error.response.data ? error.response.data.code : 'N/A';
        addLog(`Lỗi Public API ${path}: ${msg} (Code: ${code})`);
        throw error;
    }
}

// --- THÔNG TIN SÀN VÀ ĐÒN BẨY ---

async function getExchangeInfo() {
    if (Object.keys(exchangeInfoCache).length > 0) {
        return exchangeInfoCache;
    }
    addLog('Đang lấy thông tin sàn giao dịch...');
    try {
        const info = await callPublicAPI('/fapi/v1/exchangeInfo');
        info.symbols.forEach(s => {
            if (s.contractType === 'PERPETUAL' && s.status === 'TRADING') {
                const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');
                const lotSizeFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
                const marketLotSizeFilter = s.filters.find(f => f.filterType === 'MARKET_LOT_SIZE'); // Lấy MARKET_LOT_SIZE
                const minNotionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');

                exchangeInfoCache[s.symbol] = {
                    minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : 0),
                    stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.stepSize) : 0.001), // Ưu tiên LOT_SIZE, sau đó MARKET_LOT_SIZE
                    minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.notional) : 0,
                    pricePrecision: s.pricePrecision,
                    quantityPrecision: s.quantityPrecision,
                    tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.001
                };
            }
        });
        addLog('Đã lấy và lưu thông tin sàn giao dịch.');
        return exchangeInfoCache;
    } catch (error) {
        addLog(`Không thể lấy thông tin sàn: ${error.message}`);
        throw new CriticalApiError('Không thể lấy thông tin sàn. Dừng bot.', null);
    }
}

async function getSymbolDetails(symbol) {
    if (!exchangeInfoCache[symbol]) {
        await getExchangeInfo(); // Tải lại nếu chưa có
    }
    return exchangeInfoCache[symbol];
}

async function setLeverage(symbol, leverage) {
    try {
        const currentLeverageSettings = await callSignedAPI('/fapi/v1/leverage', 'GET', { symbol: symbol });
        const currentLeverage = parseInt(currentLeverageSettings.leverage);

        if (currentLeverage !== leverage) {
            addLog(`Đang đặt đòn bẩy cho ${symbol} thành ${leverage}x...`);
            await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol: symbol, leverage: leverage });
            addLog(`Đã đặt đòn bẩy cho ${symbol} thành ${leverage}x.`);
        } else {
            addLog(`Đòn bẩy cho ${symbol} đã là ${leverage}x.`);
        }
    } catch (error) {
        addLog(`Lỗi khi đặt đòn bẩy cho ${symbol}: ${error.msg || error.message}`);
        if (error.code === -4046) { // Lỗi đòn bẩy không hợp lệ
            addLog(`Đòn bẩy ${leverage} không hợp lệ cho ${symbol}. Vui lòng kiểm tra lại.`);
        }
        if (error instanceof CriticalApiError) throw error; // Ném lại lỗi nghiêm trọng
    }
}

async function setHedgeMode() {
    try {
        const dualSidePosition = await callSignedAPI('/fapi/v1/positionSide/dual', 'GET');
        if (!dualSidePosition.dualSidePosition) {
            addLog('Đang bật chế độ Hedge Mode (Dual Side Position)...');
            await callSignedAPI('/fapi/v1/positionSide/dual', 'POST', { dualSidePosition: 'true' });
            addLog('Đã bật chế độ Hedge Mode.');
        } else {
            addLog('Chế độ Hedge Mode đã được bật.');
        }
    } catch (error) {
        addLog(`Lỗi khi đặt Hedge Mode: ${error.msg || error.message}`);
        if (error.code === -4000) { // Đã có lệnh mở, không thể thay đổi
            addLog('Không thể thay đổi chế độ vị thế khi có vị thế hoặc lệnh mở.');
            // Nếu có vị thế hoặc lệnh mở, không nên dừng bot vì đây không phải lỗi nghiêm trọng, chỉ là không thể thay đổi chế độ
        }
        if (error instanceof CriticalApiError) throw error;
    }
}

// --- QUẢN LÝ VỊ THẾ ---

async function getAccountInfo() {
    try {
        const accountInfo = await callSignedAPI('/fapi/v2/account', 'GET');
        const positions = accountInfo.positions.filter(p => parseFloat(p.positionAmt) !== 0 && p.symbol === SYMBOL);
        let updatedLongPos = null;
        let updatedShortPos = null;

        for (const pos of positions) {
            const side = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
            const initialMargin = parseFloat(pos.initialMargin);
            const entryPrice = parseFloat(pos.entryPrice);
            const unrealizedPnl = parseFloat(pos.unrealizedPnl);
            const quantity = Math.abs(parseFloat(pos.positionAmt));
            const currentPrice = parseFloat(pos.markPrice); // Sử dụng markPrice cho giá hiện tại

            const positionData = {
                symbol: pos.symbol,
                side: side,
                quantity: quantity,
                entryPrice: entryPrice,
                unrealizedPnl: unrealizedPnl,
                initialMargin: initialMargin,
                currentPrice: currentPrice,
                // Các biến đã lưu trước đó để duy trì trạng thái
                closedAmount: 0,
                nextPartialCloseIndex: 0,
                partialCloseLevels: [],
                hasAdjustedSLTo200PercentProfit: false,
                hasAdjustedSLTo500PercentProfit: false
            };

            // Nếu vị thế đã tồn tại, duy trì các biến trạng thái
            if (side === 'LONG' && currentLongPosition) {
                Object.assign(positionData, {
                    closedAmount: currentLongPosition.closedAmount,
                    nextPartialCloseIndex: currentLongPosition.nextPartialCloseIndex,
                    partialCloseLevels: currentLongPosition.partialCloseLevels,
                    hasAdjustedSLTo200PercentProfit: currentLongPosition.hasAdjustedSLTo200PercentProfit,
                    hasAdjustedSLTo500PercentProfit: currentLongPosition.hasAdjustedSLTo500PercentProfit
                });
            } else if (side === 'SHORT' && currentShortPosition) {
                Object.assign(positionData, {
                    closedAmount: currentShortPosition.closedAmount,
                    nextPartialCloseIndex: currentShortPosition.nextPartialCloseIndex,
                    partialCloseLevels: currentShortPosition.partialCloseLevels,
                    hasAdjustedSLTo200PercentProfit: currentShortPosition.hasAdjustedSLTo200PercentProfit,
                    hasAdjustedSLTo500PercentProfit: currentShortPosition.hasAdjustedSLTo500PercentProfit
                });
            }

            if (side === 'LONG') {
                updatedLongPos = positionData;
            } else {
                updatedShortPos = positionData;
            }
        }
        currentLongPosition = updatedLongPos;
        currentShortPosition = updatedShortPos;

        if (currentLongPosition) {
            addLog(`Vị thế LONG hiện tại: ${currentLongPosition.quantity.toFixed(currentLongPosition.quantityPrecision || 3)} Qty, Giá vào: ${currentLongPosition.entryPrice}, PnL: ${currentLongPosition.unrealizedPnl.toFixed(2)} USDT`);
        } else {
            addLog('Không có vị thế LONG mở.');
        }
        if (currentShortPosition) {
            addLog(`Vị thế SHORT hiện tại: ${currentShortPosition.quantity.toFixed(currentShortPosition.quantityPrecision || 3)} Qty, Giá vào: ${currentShortPosition.entryPrice}, PnL: ${currentShortPosition.unrealizedPnl.toFixed(2)} USDT`);
        } else {
            addLog('Không có vị thế SHORT mở.');
        }

    } catch (error) {
        addLog(`Lỗi khi lấy thông tin tài khoản: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) throw error;
    }
}

async function closePosition(position) {
    addLog(`Đang đóng hoàn toàn lệnh ${position.side} ${position.symbol}...`);
    try {
        const closeSide = position.side === 'LONG' ? 'SELL' : 'BUY';
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: closeSide,
            positionSide: position.side,
            type: 'MARKET',
            quantity: position.quantity,
            newClientOrderId: `close_${Date.now()}` // Client order ID duy nhất
        });
        addLog(`Đã gửi lệnh đóng ${closeSide} ${position.symbol}. OrderId: ${orderResult.orderId}`);

        if (position.side === 'LONG') {
            currentLongPosition = null;
        } else {
            currentShortPosition = null;
        }
        await sleep(1000); // Đợi 1 giây để lệnh được xử lý hoàn toàn
    } catch (error) {
        addLog(`Lỗi khi đóng lệnh ${position.side} ${position.symbol}: ${error.msg || error.message}`);
        if (error.code === -2011) {
            addLog(`Lỗi -2011 khi đóng ${position.side} ${position.symbol}, có thể vị thế đã đóng hoàn toàn.`);
            if (position.side === 'LONG') {
                currentLongPosition = null;
            } else {
                currentShortPosition = null;
            }
        }
        if (error instanceof CriticalApiError) throw error;
    }
}

async function closePartialPosition(position, percentageOfInitialCapital) {
    addLog(`Đang đóng ${percentageOfInitialCapital}% vốn ban đầu của lệnh ${position.side} ${position.symbol} (lãi/lỗ).`);

    try {
        const symbolInfo = await getSymbolDetails(position.symbol);
        if (!symbolInfo) {
            addLog(`Lỗi lấy symbol info ${position.symbol}. Không đóng từng phần.`);
            return;
        }

        const { quantityPrecision, stepSize, minNotional, minQty } = symbolInfo;
        const currentPrice = position.currentPrice;

        if (!currentPrice || currentPrice <= 0) {
            addLog(`Không có giá hiện tại hợp lệ cho ${position.symbol}. Không thể đóng từng phần.`);
            return;
        }

        const usdtAmountToClose = INITIAL_INVESTMENT_AMOUNT * (percentageOfInitialCapital / 100);
        let quantityToClose = usdtAmountToClose / currentPrice;

        // Làm tròn số lượng theo stepSize của sàn
        quantityToClose = Math.floor(quantityToClose / stepSize) * stepSize;
        quantityToClose = parseFloat(quantityToClose.toFixed(quantityPrecision));

        // Kiểm tra minQty và minNotional
        if (quantityToClose < minQty) {
            addLog(`Số lượng đóng từng phần (${quantityToClose}) quá nhỏ (nhỏ hơn minQty: ${minQty}) cho ${position.symbol}. Hủy.`);
            return;
        }
        if (quantityToClose * currentPrice < minNotional) {
            addLog(`Giá trị lệnh đóng từng phần (${quantityToClose * currentPrice.toFixed(4)}) quá nhỏ (nhỏ hơn minNotional: ${minNotional}) cho ${position.symbol}. Hủy.`);
            return;
        }

        // Đảm bảo không đóng nhiều hơn số lượng hiện có
        if (quantityToClose > position.quantity) {
            addLog(`Số lượng đóng từng phần (${quantityToClose}) lớn hơn số lượng vị thế hiện có (${position.quantity}). Đóng số lượng còn lại.`);
            quantityToClose = position.quantity;
        }

        if (quantityToClose <= 0) {
            addLog(`Số lượng đóng từng phần (${quantityToClose}) quá nhỏ hoặc bằng 0 cho ${position.symbol} sau kiểm tra. Hủy.`);
            return;
        }

        const closeSide = position.side === 'LONG' ? 'SELL' : 'BUY';

        addLog(`Gửi lệnh đóng từng phần: ${position.symbol}, Side: ${closeSide}, PositionSide: ${position.side}, Type: MARKET, Qty: ${quantityToClose}`);
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: closeSide,
            positionSide: position.side,
            type: 'MARKET',
            quantity: quantityToClose,
            newClientOrderId: `partial_close_${position.side}_${Date.now()}`
        });

        addLog(`Đã gửi lệnh đóng từng phần ${closeSide} ${position.symbol}. OrderId: ${orderResult.orderId}`);

        // Cập nhật trạng thái vị thế cục bộ
        position.quantity -= quantityToClose;
        position.closedAmount += usdtAmountToClose; // Lượng USDT đã đóng

        addLog(`Đã đóng ${percentageOfInitialCapital}% vốn của lệnh ${position.side}. Vị thế còn lại: ${position.quantity.toFixed(quantityPrecision)} Qty, Tổng vốn đã đóng: ${position.closedAmount.toFixed(2)} USDT.`);

        await sleep(1000);

    } catch (error) {
        addLog(`Lỗi khi đóng từng phần lệnh ${position.side} ${position.symbol}: ${error.msg || error.message}`);
        if (error.code === -2011) {
            addLog(`Lỗi -2011 khi đóng từng phần ${position.side} ${position.symbol}, có thể vị thế đã đóng hoàn toàn.`);
        }
        else if (error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng khi đóng từng phần.`);
            stopBotLogicInternal();
        }
    }
}

async function addPosition(position, amountToReopen) {
    addLog(`Đang mở thêm vị thế ${position.side} ${position.symbol} với ${amountToReopen} USDT...`);
    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) {
            addLog(`Không tìm thấy chi tiết symbol cho ${position.symbol}. Không thể mở thêm vị thế.`);
            return;
        }
        const { pricePrecision, quantityPrecision, minNotional, stepSize, tickSize, minQty } = symbolDetails;

        const currentPrice = lastPrice; // Sử dụng giá hiện tại từ ticker

        if (!currentPrice || currentPrice <= 0) {
            addLog(`Không có giá hiện tại hợp lệ cho ${position.symbol}. Không thể mở thêm vị thế.`);
            return;
        }

        // Tính toán số lượng dựa trên 'amountToReopen' (USD) và đòn bẩy
        let quantityToAdd = (amountToReopen * LEVERAGE) / currentPrice;

        // Làm tròn số lượng theo stepSize của sàn
        quantityToAdd = Math.floor(quantityToAdd / stepSize) * stepSize;
        quantityToAdd = parseFloat(quantityToAdd.toFixed(quantityPrecision));

        // Kiểm tra minQty và minNotional
        if (quantityToAdd < minQty) {
            addLog(`Số lượng mở thêm (${quantityToAdd}) quá nhỏ (nhỏ hơn minQty: ${minQty}) cho ${position.symbol}. Hủy.`);
            return;
        }
        if (quantityToAdd * currentPrice < minNotional) {
            addLog(`Giá trị lệnh mở thêm (${quantityToAdd * currentPrice.toFixed(4)}) quá nhỏ (nhỏ hơn minNotional: ${minNotional}) cho ${position.symbol}. Hủy.`);
            return;
        }

        if (quantityToAdd <= 0) {
            addLog(`Số lượng mở thêm (${quantityToAdd}) quá nhỏ hoặc bằng 0 cho ${position.symbol} sau kiểm tra. Hủy.`);
            return;
        }

        const openSide = position.side === 'LONG' ? 'BUY' : 'SELL';

        addLog(`Gửi lệnh mở thêm: ${position.symbol}, Side: ${openSide}, PositionSide: ${position.side}, Type: MARKET, Qty: ${quantityToAdd}`);
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: openSide,
            positionSide: position.side,
            type: 'MARKET',
            quantity: quantityToAdd,
            newClientOrderId: `add_${position.side}_${Date.now()}`
        });

        addLog(`Đã gửi lệnh mở thêm ${openSide} ${position.symbol}. OrderId: ${orderResult.orderId}`);
        // Cập nhật lại thông tin vị thế sau khi mở thêm
        await getAccountInfo();
        await sleep(1000);

    } catch (error) {
        addLog(`Lỗi khi mở thêm lệnh ${position.side} ${position.symbol}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng khi mở thêm.`);
            stopBotLogicInternal();
        }
    }
}

async function updateStopLoss(position, newSLPrice) {
    if (!position) return;
    addLog(`Đang cập nhật SL cho lệnh ${position.side} ${position.symbol} về giá: ${newSLPrice}...`);

    try {
        // Hủy các lệnh SL hiện có để tránh trùng lặp
        const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol: position.symbol });
        for (const order of openOrders) {
            if (order.type === 'STOP_MARKET' || order.type === 'TAKE_PROFIT_MARKET') {
                if (order.positionSide === position.side) {
                    addLog(`Hủy lệnh SL/TP cũ OrderId: ${order.orderId} cho ${position.side} ${position.symbol}`);
                    await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: position.symbol, orderId: order.orderId });
                    await sleep(200); // Đợi một chút sau khi hủy
                }
            }
        }

        const symbolInfo = await getSymbolDetails(position.symbol);
        const pricePrecision = symbolInfo ? symbolInfo.pricePrecision : 8;

        const stopPrice = parseFloat(newSLPrice.toFixed(pricePrecision));

        // Đảm bảo stopPrice không quá gần giá hiện tại (có thể gây lỗi)
        // Đây chỉ là một ví dụ, bạn có thể cần điều chỉnh ngưỡng này
        // if (Math.abs(currentPrice - stopPrice) / currentPrice < 0.0001) { // 0.01%
        //     addLog(`Giá SL quá gần giá hiện tại (${currentPrice.toFixed(pricePrecision)}). Bỏ qua cập nhật SL.`);
        //     return;
        // }

        addLog(`Gửi lệnh SL mới: ${position.symbol}, Side: ${position.side === 'LONG' ? 'SELL' : 'BUY'}, PositionSide: ${position.side}, Type: STOP_MARKET, StopPrice: ${stopPrice}, Qty: ${position.quantity}`);
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: position.side === 'LONG' ? 'SELL' : 'BUY', // Ngược lại với side của vị thế
            positionSide: position.side,
            type: 'STOP_MARKET',
            quantity: position.quantity,
            stopPrice: stopPrice,
            closePosition: true, // Đảm bảo đóng toàn bộ vị thế
            newClientOrderId: `sl_${position.side}_${Date.now()}`
        });
        addLog(`Đã gửi lệnh SL mới cho ${position.side} ${position.symbol}. OrderId: ${orderResult.orderId}`);
        await sleep(1000);
    } catch (error) {
        addLog(`Lỗi khi cập nhật SL cho lệnh ${position.side} ${position.symbol}: ${error.msg || error.message}`);
        if (error.code === -2021) { // Stop price would trigger immediately
            addLog(`Lỗi -2021: Giá SL quá gần hoặc đã bị kích hoạt. SL có thể đã được đặt.`);
        }
        if (error instanceof CriticalApiError) throw error;
    }
}

// --- LOGIC GIAO DỊCH CHÍNH ---

async function openPosition(side) {
    if (openAttempts[side] >= MAX_OPEN_ATTEMPTS) {
        addLog(`Đã vượt quá số lần thử mở lệnh ${side} tối đa (${MAX_OPEN_ATTEMPTS}). Dừng thử.`);
        return;
    }

    addLog(`Đang thử mở lệnh ${side} ${SYMBOL}... Lần thử: ${openAttempts[side] + 1}`);

    try {
        const symbolDetails = await getSymbolDetails(SYMBOL);
        if (!symbolDetails) {
            addLog(`Không tìm thấy chi tiết symbol cho ${SYMBOL}. Không thể mở vị thế.`);
            return;
        }
        const { pricePrecision, quantityPrecision, minNotional, stepSize, tickSize } = symbolDetails;

        const maxLeverage = (await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol: SYMBOL }))[0].brackets[0].initialLeverage;

        // Cấu hình TP/SL và Partial Close dựa trên đòn bẩy
        let TAKE_PROFIT_MULTIPLIER;
        let STOP_LOSS_MULTIPLIER = 7; // Mặc định 700% cho SL toàn phần

        let partialCloseSteps = []; // Các mốc % lãi để đóng từng phần

        if (maxLeverage >= 75) {
            TAKE_PROFIT_MULTIPLIER = 10; // 1000%
            for (let i = 1; i <= 9; i++) partialCloseSteps.push(i * 100); // 100%, 200%, ..., 900%
        } else if (maxLeverage === 50) {
            TAKE_PROFIT_MULTIPLIER = 5; // 500%
            for (let i = 1; i <= 9; i++) partialCloseSteps.push(i * 50); // 50%, 100%, ..., 450%
        } else if (maxLeverage < 25) { // Đòn bẩy dưới 25
            TAKE_PROFIT_MULTIPLIER = 3.5; // 350%
            for (let i = 1; i <= 9; i++) partialCloseSteps.push(i * 35); // 35%, 70%, 105%, ..., 315%
        } else {
            addLog(`Cảnh báo: maxLeverage ${maxLeverage} không khớp với các quy tắc TP/SL/Partial Close. Sử dụng mặc định (TP 350%, SL 700%, Partial 35%).`);
            TAKE_PROFIT_MULTIPLIER = 3.5;
            for (let i = 1; i <= 9; i++) partialCloseSteps.push(i * 35);
        }

        const orderSide = side === 'LONG' ? 'BUY' : 'SELL';
        const quantity = parseFloat(((INITIAL_INVESTMENT_AMOUNT * LEVERAGE) / currentPrice).toFixed(quantityPrecision));

        // Kiểm tra minNotional và minQty
        if (quantity * currentPrice < symbolDetails.minNotional) {
            addLog(`Giá trị lệnh mở (${quantity * currentPrice.toFixed(4)}) nhỏ hơn minNotional (${symbolDetails.minNotional}). Không thể mở lệnh.`);
            return;
        }
        if (quantity < symbolDetails.minQty) {
            addLog(`Số lượng lệnh mở (${quantity}) nhỏ hơn minQty (${symbolDetails.minQty}). Không thể mở lệnh.`);
            return;
        }

        addLog(`Gửi lệnh mở: ${SYMBOL}, Side: ${orderSide}, PositionSide: ${side}, Type: MARKET, Qty: ${quantity}`);
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: SYMBOL,
            side: orderSide,
            positionSide: side,
            type: 'MARKET',
            quantity: quantity,
            newClientOrderId: `${side}_${Date.now()}`
        });

        const entryPrice = parseFloat(orderResult.avgPrice || orderResult.fills[0].price);
        addLog(`Đã mở lệnh ${side} ${SYMBOL}. OrderId: ${orderResult.orderId}, Giá vào: ${entryPrice}, Số lượng: ${quantity}`);

        // Cập nhật trạng thái vị thế cục bộ
        const newPosition = {
            symbol: SYMBOL,
            side: side,
            quantity: quantity,
            entryPrice: entryPrice,
            unrealizedPnl: 0, // Sẽ được cập nhật từ getAccountInfo
            initialMargin: INITIAL_INVESTMENT_AMOUNT,
            currentPrice: currentPrice,
            closedAmount: 0,
            nextPartialCloseIndex: 0,
            partialCloseLevels: partialCloseSteps,
            hasAdjustedSLTo200PercentProfit: false,
            hasAdjustedSLTo500PercentProfit: false
        };

        if (side === 'LONG') {
            currentLongPosition = newPosition;
            lastLongOrderTime = Date.now();
        } else {
            currentShortPosition = newPosition;
            lastShortOrderTime = Date.now();
        }

        // Đặt SL và TP ban đầu
        const stopLossPrice = side === 'LONG'
            ? entryPrice - (INITIAL_INVESTMENT_AMOUNT * STOP_LOSS_MULTIPLIER / quantity)
            : entryPrice + (INITIAL_INVESTMENT_AMOUNT * STOP_LOSS_MULTIPLIER / quantity);
        const takeProfitPrice = side === 'LONG'
            ? entryPrice + (INITIAL_INVESTMENT_AMOUNT * TAKE_PROFIT_MULTIPLIER / quantity)
            : entryPrice - (INITIAL_INVESTMENT_AMOUNT * TAKE_PROFIT_MULTIPLIER / quantity);

        await updateStopLoss(newPosition, stopLossPrice);
        // Có thể thêm updateTakeProfit nếu muốn quản lý TP cứng ban đầu
        // await updateTakeProfit(newPosition, takeProfitPrice); // Cần hàm updateTakeProfit

        openAttempts[side] = 0; // Reset số lần thử thành công
        await sleep(1000);
    } catch (error) {
        addLog(`Lỗi khi mở lệnh ${side} ${SYMBOL}: ${error.msg || error.message}`);
        openAttempts[side]++;
        if (openAttempts[side] < MAX_OPEN_ATTEMPTS) {
            addLog(`Thử lại mở lệnh ${side} sau ${OPEN_ATTEMPT_DELAY_MS / 1000} giây...`);
            await sleep(OPEN_ATTEMPT_DELAY_MS);
        } else {
            addLog(`Đã đạt tối đa số lần thử mở lệnh ${side}. Tạm dừng cho lệnh này.`);
            // Bạn có thể chọn dừng bot tại đây nếu muốn
        }
        if (error instanceof CriticalApiError) throw error;
    }
}

async function manageOpenPosition() {
    await getAccountInfo(); // Cập nhật thông tin vị thế mới nhất

    let winningPos = null;
    let losingPos = null;

    if (currentLongPosition && currentLongPosition.unrealizedPnl > 0) {
        winningPos = currentLongPosition;
        losingPos = currentShortPosition;
    } else if (currentShortPosition && currentShortPosition.unrealizedPnl > 0) {
        winningPos = currentShortPosition;
        losingPos = currentLongPosition;
    }

    // --- Logic đóng từng phần lệnh LỖ khi lệnh LÃI đạt mốc ---
    if (winningPos && losingPos) {
        const currentWinningProfitPercentage = (winningPos.unrealizedPnl / winningPos.initialMargin) * 100;
        const nextCloseLevel = winningPos.partialCloseLevels[winningPos.nextPartialCloseIndex];

        if (nextCloseLevel && currentWinningProfitPercentage >= nextCloseLevel) {
            addLog(`Lệnh LÃI (${winningPos.side}) đạt mốc lãi ${nextCloseLevel.toFixed(2)}%. Đang đóng 10% vốn ban đầu của lệnh LỖ (${losingPos.side}).`);
            await closePartialPosition(losingPos, 10); // Đóng 10% vốn ban đầu của lệnh LỖ

            // Chuyển sang mốc tiếp theo cho lệnh LÃI (để nó kích hoạt đóng lệnh lỗ)
            winningPos.nextPartialCloseIndex++;

            // Sau khi đóng từng phần lệnh lỗ, điều chỉnh SL của lệnh lỗ về hòa vốn
            // Hoặc một mức SL bảo vệ nếu bạn muốn
            const symbolDetails = await getSymbolDetails(losingPos.symbol);
            const pricePrecision = symbolDetails ? symbolDetails.pricePrecision : 8;
            const newSLPriceForLosingPos = parseFloat(losingPos.entryPrice.toFixed(pricePrecision));

            addLog(`Điều chỉnh SL của lệnh lỗ ${losingPos.side} về hòa vốn (${newSLPriceForLosingPos.toFixed(pricePrecision)}) sau khi đóng từng phần.`);
            await updateStopLoss(losingPos, newSLPriceForLosingPos);
        }

        // --- Logic điều chỉnh SL cho CẢ HAI LỆNH (Trailing Stop Loss dựa trên %) ---
        const symbolDetails = await getSymbolDetails(winningPos.symbol);
        const tickSize = symbolDetails ? symbolDetails.tickSize : 0.001;
        const pricePrecision = symbolDetails ? symbolDetails.pricePrecision : 8;

        // Tính toán SL cho lệnh lãi (bảo vệ lợi nhuận)
        let slPriceForWinningPos_200PercentProfit;
        let slPriceForWinningPos_500PercentProfit;

        if (winningPos.side === 'LONG') {
            slPriceForWinningPos_200PercentProfit = winningPos.entryPrice + (winningPos.initialMargin * 200 / 100 / winningPos.quantity);
            slPriceForWinningPos_200PercentProfit = Math.floor(slPriceForWinningPos_200PercentProfit / tickSize) * tickSize;
            slPriceForWinningPos_500PercentProfit = winningPos.entryPrice + (winningPos.initialMargin * 500 / 100 / winningPos.quantity);
            slPriceForWinningPos_500PercentProfit = Math.floor(slPriceForWinningPos_500PercentProfit / tickSize) * tickSize;
        } else { // SHORT
            slPriceForWinningPos_200PercentProfit = winningPos.entryPrice - (winningPos.initialMargin * 200 / 100 / winningPos.quantity);
            slPriceForWinningPos_200PercentProfit = Math.ceil(slPriceForWinningPos_200PercentProfit / tickSize) * tickSize;
            slPriceForWinningPos_500PercentProfit = winningPos.entryPrice - (winningPos.initialMargin * 500 / 100 / winningPos.quantity);
            slPriceForWinningPos_500PercentProfit = Math.ceil(slPriceForWinningPos_500PercentProfit / tickSize) * tickSize;
        }
        slPriceForWinningPos_200PercentProfit = parseFloat(slPriceForWinningPos_200PercentProfit.toFixed(pricePrecision));
        slPriceForWinningPos_500PercentProfit = parseFloat(slPriceForWinningPos_500PercentProfit.toFixed(pricePrecision));

        // Giá SL cho lệnh đối ứng (hòa vốn)
        let slPriceForLosingPos_Breakeven = parseFloat(losingPos.entryPrice.toFixed(pricePrecision));

        // Điều chỉnh SL khi lệnh lãi đạt 800%
        if (currentWinningProfitPercentage >= 800 && !winningPos.hasAdjustedSLTo500PercentProfit) {
            addLog(`Lệnh LÃI (${winningPos.side}) đạt ${currentWinningProfitPercentage.toFixed(2)}% lãi. Điều chỉnh SL của lệnh lãi về 500% lãi và SL của lệnh đối ứng về hòa vốn (mốc 800%).`);
            await updateStopLoss(winningPos, slPriceForWinningPos_500PercentProfit); // SL lệnh lãi về 500% lãi
            await updateStopLoss(losingPos, slPriceForLosingPos_Breakeven); // SL lệnh đối ứng về hòa vốn
            winningPos.hasAdjustedSLTo500PercentProfit = true;
            winningPos.hasAdjustedSLTo200PercentProfit = true; // Đảm bảo cờ 200% cũng được bật
        }
        // Điều chỉnh SL khi lệnh lãi đạt 500%
        else if (currentWinningProfitPercentage >= 500 && !winningPos.hasAdjustedSLTo200PercentProfit) {
            addLog(`Lệnh LÃI (${winningPos.side}) đạt ${currentWinningProfitPercentage.toFixed(2)}% lãi. Điều chỉnh SL của lệnh lãi về 200% lãi và SL của lệnh đối ứng về hòa vốn (mốc 500%).`);
            await updateStopLoss(winningPos, slPriceForWinningPos_200PercentProfit); // SL lệnh lãi về 200% lãi
            await updateStopLoss(losingPos, slPriceForLosingPos_Breakeven); // SL lệnh đối ứng về hòa vốn
            winningPos.hasAdjustedSLTo200PercentProfit = true;
        }
    }
    // Trường hợp chỉ còn một lệnh (lệnh kia đã đóng hoàn toàn)
    else if (currentLongPosition && !currentShortPosition) {
        const currentProfitPercentage = (currentLongPosition.unrealizedPnl / currentLongPosition.initialMargin) * 100;
        // Nếu lệnh Long đang lãi và còn lệnh lỗ đã đóng hết, ta có thể tiếp tục đóng từng phần lệnh lãi
        if (currentLongPosition.unrealizedPnl > 0) {
            const nextCloseLevel = currentLongPosition.partialCloseLevels[currentLongPosition.nextPartialCloseIndex];
            if (nextCloseLevel && currentProfitPercentage >= nextCloseLevel) {
                addLog(`Chỉ còn lệnh LÃI LONG. Đạt mốc lãi ${nextCloseLevel.toFixed(2)}%. Đang đóng 10% vốn ban đầu của lệnh LÃI LONG.`);
                await closePartialPosition(currentLongPosition, 10);
                currentLongPosition.nextPartialCloseIndex++;
            }
            // Logic điều chỉnh SL cho lệnh lãi duy nhất (có thể vẫn áp dụng)
            const symbolDetails = await getSymbolDetails(currentLongPosition.symbol);
            const tickSize = symbolDetails ? symbolDetails.tickSize : 0.001;
            const pricePrecision = symbolDetails ? symbolDetails.pricePrecision : 8;

            let slPriceForLongPos_200PercentProfit = currentLongPosition.entryPrice + (currentLongPosition.initialMargin * 200 / 100 / currentLongPosition.quantity);
            slPriceForLongPos_200PercentProfit = Math.floor(slPriceForLongPos_200PercentProfit / tickSize) * tickSize;
            slPriceForLongPos_200PercentProfit = parseFloat(slPriceForLongPos_200PercentProfit.toFixed(pricePrecision));

            let slPriceForLongPos_500PercentProfit = currentLongPosition.entryPrice + (currentLongPosition.initialMargin * 500 / 100 / currentLongPosition.quantity);
            slPriceForLongPos_500PercentProfit = Math.floor(slPriceForLongPos_500PercentProfit / tickSize) * tickSize;
            slPriceForLongPos_500PercentProfit = parseFloat(slPriceForLongPos_500PercentProfit.toFixed(pricePrecision));

            if (currentProfitPercentage >= 800 && !currentLongPosition.hasAdjustedSLTo500PercentProfit) {
                addLog(`Lệnh LONG đạt ${currentProfitPercentage.toFixed(2)}% lãi. Điều chỉnh SL lệnh LONG về 500% lãi.`);
                await updateStopLoss(currentLongPosition, slPriceForLongPos_500PercentProfit);
                currentLongPosition.hasAdjustedSLTo500PercentProfit = true;
                currentLongPosition.hasAdjustedSLTo200PercentProfit = true;
            } else if (currentProfitPercentage >= 500 && !currentLongPosition.hasAdjustedSLTo200PercentProfit) {
                addLog(`Lệnh LONG đạt ${currentProfitPercentage.toFixed(2)}% lãi. Điều chỉnh SL lệnh LONG về 200% lãi.`);
                await updateStopLoss(currentLongPosition, slPriceForLongPos_200PercentProfit);
                currentLongPosition.hasAdjustedSLTo200PercentProfit = true;
            }
        }
    }
    else if (currentShortPosition && !currentLongPosition) {
        const currentProfitPercentage = (currentShortPosition.unrealizedPnl / currentShortPosition.initialMargin) * 100;
        // Nếu lệnh Short đang lãi và còn lệnh lỗ đã đóng hết, ta có thể tiếp tục đóng từng phần lệnh lãi
        if (currentShortPosition.unrealizedPnl > 0) {
            const nextCloseLevel = currentShortPosition.partialCloseLevels[currentShortPosition.nextPartialCloseIndex];
            if (nextCloseLevel && currentProfitPercentage >= nextCloseLevel) {
                addLog(`Chỉ còn lệnh LÃI SHORT. Đạt mốc lãi ${nextCloseLevel.toFixed(2)}%. Đang đóng 10% vốn ban đầu của lệnh LÃI SHORT.`);
                await closePartialPosition(currentShortPosition, 10);
                currentShortPosition.nextPartialCloseIndex++;
            }
            // Logic điều chỉnh SL cho lệnh lãi duy nhất (có thể vẫn áp dụng)
            const symbolDetails = await getSymbolDetails(currentShortPosition.symbol);
            const tickSize = symbolDetails ? symbolDetails.tickSize : 0.001;
            const pricePrecision = symbolDetails ? symbolDetails.pricePrecision : 8;

            let slPriceForShortPos_200PercentProfit = currentShortPosition.entryPrice - (currentShortPosition.initialMargin * 200 / 100 / currentShortPosition.quantity);
            slPriceForShortPos_200PercentProfit = Math.ceil(slPriceForShortPos_200PercentProfit / tickSize) * tickSize;
            slPriceForShortPos_200PercentProfit = parseFloat(slPriceForShortPos_200PercentProfit.toFixed(pricePrecision));

            let slPriceForShortPos_500PercentProfit = currentShortPosition.entryPrice - (currentShortPosition.initialMargin * 500 / 100 / currentShortPosition.quantity);
            slPriceForShortPos_500PercentProfit = Math.ceil(slPriceForShortPos_500PercentProfit / tickSize) * tickSize;
            slPriceForShortPos_500PercentProfit = parseFloat(slPriceForShortPos_500PercentProfit.toFixed(pricePrecision));

            if (currentProfitPercentage >= 800 && !currentShortPosition.hasAdjustedSLTo500PercentProfit) {
                addLog(`Lệnh SHORT đạt ${currentProfitPercentage.toFixed(2)}% lãi. Điều chỉnh SL lệnh SHORT về 500% lãi.`);
                await updateStopLoss(currentShortPosition, slPriceForShortPos_500PercentProfit);
                currentShortPosition.hasAdjustedSLTo500PercentProfit = true;
                currentShortPosition.hasAdjustedSLTo200PercentProfit = true;
            } else if (currentProfitPercentage >= 500 && !currentShortPosition.hasAdjustedSLTo200PercentProfit) {
                addLog(`Lệnh SHORT đạt ${currentProfitPercentage.toFixed(2)}% lãi. Điều chỉnh SL lệnh SHORT về 200% lãi.`);
                await updateStopLoss(currentShortPosition, slPriceForShortPos_200PercentProfit);
                currentShortPosition.hasAdjustedSLTo200PercentProfit = true;
            }
        }
    }
}


async function mainLogic() {
    if (!botRunning) return;

    try {
        // Cập nhật giá hiện tại từ ticker
        // (Giả định lastPrice đã được cập nhật từ WebSocket)
        if (lastPrice === 0) {
            addLog('Chờ giá cập nhật từ WebSocket...');
            return;
        }

        await getAccountInfo(); // Luôn lấy thông tin tài khoản mới nhất

        // --- Đóng cả hai lệnh nếu một trong hai lệnh đạt SL (đang lỗ 700%) ---
        if (currentLongPosition && currentLongPosition.unrealizedPnl < - (currentLongPosition.initialMargin * 7)) {
            addLog(`Lệnh LONG đang lỗ ${currentLongPosition.unrealizedPnl.toFixed(2)} USDT (${((currentLongPosition.unrealizedPnl / currentLongPosition.initialMargin) * 100).toFixed(2)}%). Đóng cả hai lệnh.`);
            await closePosition(currentLongPosition);
            if (currentShortPosition) await closePosition(currentShortPosition);
            // Sau khi đóng, có thể reset trạng thái để mở lại nếu muốn
            addLog('Đã đóng cả hai lệnh do lệnh LONG đạt SL. Đặt lại trạng thái để mở lệnh mới.');
            lastLongOrderTime = 0;
            lastShortOrderTime = 0;
            currentLongPosition = null;
            currentShortPosition = null;
        } else if (currentShortPosition && currentShortPosition.unrealizedPnl < - (currentShortPosition.initialMargin * 7)) {
            addLog(`Lệnh SHORT đang lỗ ${currentShortPosition.unrealizedPnl.toFixed(2)} USDT (${((currentShortPosition.unrealizedPnl / currentShortPosition.initialMargin) * 100).toFixed(2)}%). Đóng cả hai lệnh.`);
            await closePosition(currentShortPosition);
            if (currentLongPosition) await closePosition(currentLongPosition);
            // Sau khi đóng, có thể reset trạng thái để mở lại nếu muốn
            addLog('Đã đóng cả hai lệnh do lệnh SHORT đạt SL. Đặt lại trạng thái để mở lệnh mới.');
            lastLongOrderTime = 0;
            lastShortOrderTime = 0;
            currentLongPosition = null;
            currentShortPosition = null;
        }

        // --- Mở lệnh mới nếu chưa có vị thế nào mở ---
        if (!currentLongPosition && !currentShortPosition) {
            // Logic để quyết định mở Long hay Short đầu tiên
            // Ở đây, tôi sẽ đơn giản mở Long trước, sau đó chờ Short nếu cần
            if (Date.now() - lastLongOrderTime > OPEN_ATTEMPT_DELAY_MS && openAttempts['LONG'] < MAX_OPEN_ATTEMPTS) {
                addLog('Không có vị thế nào mở. Đang cố gắng mở vị thế LONG đầu tiên.');
                await openPosition('LONG');
            } else if (Date.now() - lastShortOrderTime > OPEN_ATTEMPT_DELAY_MS && openAttempts['SHORT'] < MAX_OPEN_ATTEMPTS) {
                // Nếu long mở không thành công, hoặc đang chờ long được mở
                // Bạn có thể tùy chỉnh logic này
            }
            return; // Đợi cho vị thế đầu tiên được mở
        }

        // --- Mở lệnh đối ứng (Short nếu có Long, Long nếu có Short) ---
        if (currentLongPosition && !currentShortPosition && Date.now() - lastShortOrderTime > OPEN_ATTEMPT_DELAY_MS && openAttempts['SHORT'] < MAX_OPEN_ATTEMPTS) {
            addLog('Có vị thế LONG nhưng chưa có SHORT. Đang mở vị thế SHORT đối ứng.');
            await openPosition('SHORT');
        } else if (currentShortPosition && !currentLongPosition && Date.now() - lastLongOrderTime > OPEN_ATTEMPT_DELAY_MS && openAttempts['LONG'] < MAX_OPEN_ATTEMPTS) {
            addLog('Có vị thế SHORT nhưng chưa có LONG. Đang mở vị thế LONG đối ứng.');
            await openPosition('LONG');
        }

        // --- Quản lý các vị thế đang mở (chốt lời, điều chỉnh SL) ---
        if (currentLongPosition || currentShortPosition) {
            await manageOpenPosition();
        }

    } catch (error) {
        addLog(`Lỗi trong mainLogic: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) {
            addLog('Phát hiện lỗi API nghiêm trọng. Dừng bot.');
            stopBotLogicInternal();
        }
    }
}

// --- QUẢN LÝ WEBSOCKET (để lấy giá và cập nhật PnL theo thời gian thực) ---

let ws;

function connectWebSocket() {
    ws = new WebSocket(`${WS_URL}/ws/${SYMBOL.toLowerCase()}@markPrice@1s`);

    ws.onopen = () => {
        addLog('Đã kết nối WebSocket để nhận giá.');
    };

    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.e === 'markPriceUpdate') {
            lastPrice = parseFloat(message.p);
            // addLog(`Giá ${SYMBOL}: ${lastPrice}`); // Quá nhiều log nếu bật
            if (currentLongPosition) currentLongPosition.currentPrice = lastPrice;
            if (currentShortPosition) currentShortPosition.currentPrice = lastPrice;
        }
    };

    ws.onclose = (event) => {
        addLog(`WebSocket đóng: Mã ${event.code}, Lý do: ${event.reason}. Đang thử kết nối lại...`);
        setTimeout(connectWebSocket, 5000); // Thử kết nối lại sau 5 giây
    };

    ws.onerror = (error) => {
        addLog(`Lỗi WebSocket: ${error.message}.`);
        ws.close(); // Đóng kết nối để kích hoạt onclose và kết nối lại
    };
}

// --- KHỞI ĐỘNG VÀ DỪNG BOT ---

let botInterval;

async function startBotLogic() {
    if (botRunning) {
        addLog('Bot đã chạy rồi.');
        return;
    }
    botRunning = true;
    addLog('Đang khởi động bot...');

    try {
        await getExchangeInfo(); // Lấy thông tin sàn trước
        await setLeverage(SYMBOL, LEVERAGE); // Đặt đòn bẩy
        await setHedgeMode(); // Đặt chế độ Hedge Mode

        connectWebSocket(); // Bắt đầu kết nối WebSocket

        addLog('Bot đã sẵn sàng và đang chạy logic chính.');
        botInterval = setInterval(mainLogic, BOT_RUN_INTERVAL_MS);
    } catch (error) {
        addLog(`Lỗi khởi tạo bot: ${error.message}. Dừng bot.`);
        stopBotLogicInternal();
    }
}

function stopBotLogicInternal() {
    if (!botRunning) return;
    botRunning = false;
    addLog('Đang dừng bot...');
    clearInterval(botInterval);
    if (ws) {
        ws.close();
        addLog('Đã đóng kết nối WebSocket.');
    }
    addLog('Bot đã dừng.');
}

// Khởi động bot khi ứng dụng bắt đầu
startBotLogic();

// Để dừng bot từ bên ngoài (ví dụ: Ctrl+C)
process.on('SIGINT', () => {
    addLog('Phát hiện tín hiệu SIGINT. Đang dừng bot...');
    stopBotLogicInternal();
    process.exit();
});

