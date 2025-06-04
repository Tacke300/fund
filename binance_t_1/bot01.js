const https = require('https');
const crypto = require('crypto');
const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// ==================== CẤU HÌNH CHÍNH ====================
const BASE_HOST = 'fapi.binance.com';
const WEB_SERVER_PORT = 1997;
const BOT_LOG_FILE = '/home/tacke300/.pm2/logs/bot-bina-out.log';
const THIS_BOT_PM2_NAME = '1997';

// ==================== BIẾN TOÀN CỤC ====================
let API_KEY = '';
let SECRET_KEY = '';
let serverTimeOffset = 0;
let exchangeInfoCache = null;
let isClosingPosition = false;
let botRunning = false;
let botStartTime = null;
let currentOpenPosition = null;
let positionCheckInterval = null;
let nextScheduledCycleTimeout = null;
let retryBotTimeout = null;

// ==================== CẤU HÌNH CHIẾN LƯỢC ====================
let INITIAL_INVESTMENT_AMOUNT = 0.12; // Default 0.12$
let TARGET_COIN_SYMBOL = 'ETHUSDT';
let APPLY_DOUBLE_STRATEGY = false;
const TAKE_PROFIT_PERCENTAGE_MAIN = 0.60;
const STOP_LOSS_PERCENTAGE_MAIN = 0.175;
const MAX_CONSECUTIVE_LOSSES = 5;

// ==================== BIẾN THEO DÕI ====================
let currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
let consecutiveLossCount = 0;
let nextTradeDirection = 'SHORT';
let totalProfit = 0;
let totalLoss = 0;
let netPNL = 0;
let totalInvestmentCap = 0;

// ==================== HÀM TIỆN ÍCH ====================
function addLog(message) {
    const now = new Date();
    const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    console.log(`[${time}] ${message}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== API FUNCTIONS ====================
async function callPublicAPI(endpoint, params = {}) {
    const query = new URLSearchParams(params).toString();
    const url = `${endpoint}${query ? `?${query}` : ''}`;
    
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: BASE_HOST,
            path: url,
            method: 'GET'
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function callSignedAPI(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now() + serverTimeOffset;
    const recvWindow = 5000;
    
    const query = new URLSearchParams({
        ...params,
        timestamp,
        recvWindow
    }).toString();
    
    const signature = crypto
        .createHmac('sha256', SECRET_KEY)
        .update(query)
        .digest('hex');
    
    const url = `${endpoint}?${query}&signature=${signature}`;
    
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: BASE_HOST,
            path: url,
            method,
            headers: {
                'X-MBX-APIKEY': API_KEY
            }
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// ==================== CORE LOGIC ====================
async function getSymbolDetails(symbol) {
    if (!exchangeInfoCache) {
        const data = await callPublicAPI('/fapi/v1/exchangeInfo');
        exchangeInfoCache = {};
        data.symbols.forEach(s => {
            const filters = {
                minQty: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').minQty),
                stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize),
                minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL').notional),
                tickSize: parseFloat(s.filters.find(f => f.filterType === 'PRICE_FILTER').tickSize),
                pricePrecision: s.pricePrecision,
                quantityPrecision: s.quantityPrecision
            };
            exchangeInfoCache[s.symbol] = filters;
        });
    }
    return exchangeInfoCache[symbol];
}

async function openPosition(symbol, tradeDirection, usdtBalance, maxLeverage) {
    if (currentOpenPosition || isClosingPosition) return;

    try {
        const symbolInfo = await getSymbolDetails(symbol);
        if (!symbolInfo) {
            addLog(`Không lấy được thông tin symbol ${symbol}`);
            return;
        }

        await setLeverage(symbol, maxLeverage);

        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) {
            addLog(`Không lấy được giá hiện tại ${symbol}`);
            return;
        }

        // Tính toán khối lượng CHÍNH XÁC với số vốn 0.12$
        let quantity = (currentInvestmentAmount * maxLeverage) / currentPrice;
        quantity = Math.floor(quantity / symbolInfo.stepSize) * symbolInfo.stepSize;
        quantity = parseFloat(quantity.toFixed(symbolInfo.quantityPrecision));

        // Kiểm tra điều kiện tối thiểu
        if (quantity < symbolInfo.minQty || quantity * currentPrice < symbolInfo.minNotional) {
            addLog(`Khối lượng ${quantity} không đạt yêu cầu tối thiểu`);
            return;
        }

        // Gửi lệnh mở
        const orderSide = tradeDirection === 'LONG' ? 'BUY' : 'SELL';
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol,
            side: orderSide,
            type: 'MARKET',
            quantity,
            newOrderRespType: 'FULL'
        });

        await sleep(1000); // Chờ lệnh khớp

        // Lấy thông tin vị thế thực tế
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const position = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
        if (!position) {
            addLog(`Không tìm thấy vị thế sau khi mở lệnh`);
            return;
        }

        const entryPrice = parseFloat(position.entryPrice);
        const actualQuantity = Math.abs(parseFloat(position.positionAmt));

        // Tính TP/SL CHÍNH XÁC
        const positionValue = actualQuantity * entryPrice;
        const tpPrice = tradeDirection === 'LONG' 
            ? entryPrice * (1 + TAKE_PROFIT_PERCENTAGE_MAIN)
            : entryPrice * (1 - TAKE_PROFIT_PERCENTAGE_MAIN);
        
        const slPrice = tradeDirection === 'LONG'
            ? entryPrice * (1 - STOP_LOSS_PERCENTAGE_MAIN)
            : entryPrice * (1 + STOP_LOSS_PERCENTAGE_MAIN);

        // Làm tròn giá theo tickSize
        const roundedTP = parseFloat((Math.floor(tpPrice / symbolInfo.tickSize) * symbolInfo.tickSize).toFixed(symbolInfo.pricePrecision));
        const roundedSL = parseFloat((Math.floor(slPrice / symbolInfo.tickSize) * symbolInfo.tickSize).toFixed(symbolInfo.pricePrecision));

        // Đặt lệnh TP/SL
        await placeTPSLOrder(symbol, tradeDirection, actualQuantity, roundedTP, roundedSL);

        // Lưu vị thế hiện tại
        currentOpenPosition = {
            symbol,
            quantity: actualQuantity,
            entryPrice,
            initialTPPrice: roundedTP,
            initialSLPrice: roundedSL,
            initialMargin: currentInvestmentAmount,
            openTime: new Date(),
            pricePrecision: symbolInfo.pricePrecision,
            side: tradeDirection
        };

        addLog(`✅ Đã mở ${tradeDirection} ${symbol} @ ${entryPrice} | TP: ${roundedTP} | SL: ${roundedSL}`);

    } catch (error) {
        addLog(`Lỗi mở lệnh: ${error.message}`);
    }
}

async function placeTPSLOrder(symbol, direction, quantity, tpPrice, slPrice) {
    try {
        const closeSide = direction === 'LONG' ? 'SELL' : 'BUY';
        
        // Đặt lệnh SL
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol,
            side: closeSide,
            type: 'STOP_MARKET',
            stopPrice: slPrice,
            quantity,
            closePosition: 'true'
        });

        // Đặt lệnh TP
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol,
            side: closeSide,
            type: 'TAKE_PROFIT_MARKET',
            stopPrice: tpPrice,
            quantity,
            closePosition: 'true'
        });

    } catch (error) {
        addLog(`Lỗi đặt TP/SL: ${error.message}`);
        throw error;
    }
}

async function closePosition(symbol, quantity, reason) {
    if (isClosingPosition) return;
    isClosingPosition = true;

    try {
        // Lấy thông tin vị thế đóng
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const position = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        if (position) {
            const entryPrice = parseFloat(position.entryPrice);
            const closePrice = await getCurrentPrice(symbol);
            const pnl = currentOpenPosition.side === 'LONG'
                ? (closePrice - entryPrice) * quantity
                : (entryPrice - closePrice) * quantity;

            // Cập nhật tổng PNL
            if (pnl > 0) totalProfit += pnl;
            else totalLoss += Math.abs(pnl);
            netPNL = totalProfit - totalLoss;

            addLog(`📊 PNL: ${pnl.toFixed(2)} | Tổng: ${netPNL.toFixed(2)} (Lời: ${totalProfit.toFixed(2)} | Lỗ: ${totalLoss.toFixed(2)})`);
        }

        // Xử lý logic tiếp theo
        if (reason.includes('TP')) {
            consecutiveLossCount = 0;
            currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
            nextTradeDirection = currentOpenPosition.side; // Giữ hướng
            addLog(`💰 TP - Giữ hướng ${nextTradeDirection}`);
        } 
        else if (reason.includes('SL')) {
            consecutiveLossCount++;
            if (APPLY_DOUBLE_STRATEGY) {
                currentInvestmentAmount = (consecutiveLossCount >= MAX_CONSECUTIVE_LOSSES)
                    ? INITIAL_INVESTMENT_AMOUNT
                    : currentInvestmentAmount * 2;
            }
            nextTradeDirection = currentOpenPosition.side === 'LONG' ? 'SHORT' : 'LONG'; // Đảo chiều
            addLog(`💸 SL - Đảo chiều thành ${nextTradeDirection}`);
        }

        currentOpenPosition = null;

    } catch (error) {
        addLog(`Lỗi đóng lệnh: ${error.message}`);
    } finally {
        isClosingPosition = false;
        if (botRunning) scheduleNextMainCycle();
    }
}

// ==================== MAIN LOGIC ====================
async function runTradingLogic() {
    if (!botRunning || currentOpenPosition) return;

    try {
        const account = await callSignedAPI('/fapi/v2/account');
        const usdtBalance = parseFloat(account.availableBalance);

        if (usdtBalance < currentInvestmentAmount) {
            addLog(`Số dư không đủ: ${usdtBalance.toFixed(2)} < ${currentInvestmentAmount.toFixed(2)}`);
            return;
        }

        const symbolInfo = await getSymbolDetails(TARGET_COIN_SYMBOL);
        if (!symbolInfo) return;

        await openPosition(TARGET_COIN_SYMBOL, nextTradeDirection, usdtBalance, 10); // Sử dụng đòn bẩy 10x

    } catch (error) {
        addLog(`Lỗi chu kỳ giao dịch: ${error.message}`);
    }
}

function scheduleNextMainCycle() {
    if (!botRunning) return;
    clearTimeout(nextScheduledCycleTimeout);
    nextScheduledCycleTimeout = setTimeout(runTradingLogic, 1000);
}

// ==================== WEB SERVER ====================
const app = express();
app.use(express.json());
app.use(express.static('public'));

app.post('/api/configure', (req, res) => {
    const { apiKey, secretKey, coinSymbol, initialAmount, applyDoubleStrategy } = req.body;
    
    API_KEY = apiKey;
    SECRET_KEY = secretKey;
    TARGET_COIN_SYMBOL = coinSymbol.toUpperCase();
    INITIAL_INVESTMENT_AMOUNT = parseFloat(initialAmount);
    APPLY_DOUBLE_STRATEGY = applyDoubleStrategy === 'true';
    
    // Reset các biến liên quan
    currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
    consecutiveLossCount = 0;
    nextTradeDirection = 'SHORT';
    
    addLog(`⚙️ Cấu hình mới: ${TARGET_COIN_SYMBOL} | Vốn: ${INITIAL_INVESTMENT_AMOUNT} | X2: ${APPLY_DOUBLE_STRATEGY}`);
    res.json({ success: true });
});

app.get('/api/start', async (req, res) => {
    if (botRunning) {
        res.json({ success: false, message: 'Bot đang chạy' });
        return;
    }
    
    try {
        await syncServerTime();
        botRunning = true;
        scheduleNextMainCycle();
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

app.get('/api/stop', (req, res) => {
    botRunning = false;
    clearTimeout(nextScheduledCycleTimeout);
    res.json({ success: true });
});

app.listen(WEB_SERVER_PORT, () => {
    addLog(`🟢 Bot đã sẵn sàng tại http://localhost:${WEB_SERVER_PORT}`);
});
