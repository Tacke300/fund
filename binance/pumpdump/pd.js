const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

// --- Giữ nguyên các hàm bổ trợ của ông ---
const safeLog = (type, ...args) => {
    const now = new Date();
    const timestamp = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    let color = '\x1b[36m'; 
    if (type === 'success') color = '\x1b[32m'; 
    if (type === 'error' || type === 'warn') color = '\x1b[31m';
    console.log(`${color}[${timestamp} ${type.toUpperCase()}]\x1b[0m`, ...args);
};

const {
    binanceApiKey, binanceApiSecret, bingxApiKey, bingxApiSecret
} = require('../config.js');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================================
// 🛡️ HỆ THỐNG QUẢN TRỊ RỦI RO 5 LỚP (VERSION CCXT)
// ============================================================================

/**
 * LAYER 1 & 2: ĐẶT GIÁP SÀN (TP/SL) + VERIFY
 * Mục tiêu: Đảm bảo lệnh đã lên sàn, không bị lag/hủy ngầm
 */
async function updateSànGiápCCXT(exchange, symbol, positionSide, amount, tpPrice, slPrice) {
    const closeSide = positionSide.toUpperCase() === 'LONG' ? 'sell' : 'buy';
    
    try {
        // Xóa lệnh cũ để cập nhật giáp mới (Dành cho DCA hoặc update giá)
        safeLog('log', `[${exchange.id}] Đang dọn dẹp lệnh treo cũ cho ${symbol}...`);
        await exchange.cancelAllOrders(symbol, { positionSide });

        // Cách 1: TP Market (Chắc chắn khớp khi chạm giá)
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', closeSide, amount, undefined, {
            'stopPrice': exchange.priceToPrecision(symbol, tpPrice),
            'positionSide': positionSide,
            'reduceOnly': true,
            'workingType': 'MARK_PRICE'
        });

        // Cách 2: SL Market (Giáp bảo hiểm cuối cùng)
        await exchange.createOrder(symbol, 'STOP_MARKET', closeSide, amount, undefined, {
            'stopPrice': exchange.priceToPrecision(symbol, slPrice),
            'positionSide': positionSide,
            'reduceOnly': true,
            'workingType': 'MARK_PRICE'
        });

        await sleep(2000);

        // VERIFY: Kiểm tra thực tế trên sàn
        const openOrders = await exchange.fetchOpenOrders(symbol);
        const hasTP = openOrders.some(o => o.info.type?.includes('TAKE_PROFIT') || o.type?.includes('take_profit'));
        const hasSL = openOrders.some(o => o.info.type?.includes('STOP') || o.type?.includes('stop'));

        if (hasTP && hasSL) {
            safeLog('success', `✅ [${exchange.id}] GIÁP confirmed: TP @${tpPrice} | SL @${slPrice}`);
        } else {
            safeLog('warn', `⚠️ [${exchange.id}] Sàn thiếu lệnh giáp. Chuyển sang Layer 3 (Bot Monitor).`);
        }
    } catch (e) {
        safeLog('error', `❌ Lỗi setup giáp ${exchange.id}: ${e.message}`);
    }
}

/**
 * LAYER 4 & 5: ĐÓNG LỆNH CƯỠNG CHẾ (LOOP 5 LẦN)
 * Mục tiêu: Tuyệt đối không để sót vị thế (Anti-Log-Ảo)
 */
async function smartCloseCCXT(exchange, symbol, positionSide, reason) {
    safeLog('warn', `🚨 [${exchange.id}] Close Position: ${symbol} | Lý do: ${reason}`);
    
    let isCleared = false;
    for (let i = 1; i <= 5; i++) {
        try {
            // Kiểm tra vị thế thực tế
            const positions = await exchange.fetchPositions([symbol]);
            const pos = positions.find(p => p.symbol === symbol && p.side.toUpperCase() === positionSide.toUpperCase());
            
            // Nếu không còn vị thế hoặc size = 0
            if (!pos || Math.abs(parseFloat(pos.contracts || pos.info.positionAmt || 0)) === 0) {
                isCleared = true;
                break;
            }

            const amount = Math.abs(parseFloat(pos.contracts || pos.info.positionAmt));
            const side = positionSide.toUpperCase() === 'LONG' ? 'sell' : 'buy';

            safeLog('log', `🔄 [${exchange.id}] Thử đóng Market lần ${i} (Size: ${amount})...`);
            await exchange.createOrder(symbol, 'MARKET', side, amount, undefined, {
                'positionSide': positionSide.toUpperCase(),
                'reduceOnly': true
            });

            await sleep(2000); 
        } catch (e) {
            safeLog('error', `❌ [${exchange.id}] Lỗi đóng lệnh: ${e.message}`);
            await exchange.cancelAllOrders(symbol, { positionSide }); // Xóa lệnh kẹt
        }
    }

    if (isCleared) {
        safeLog('success', `✅ [${exchange.id}] Verified: Vị thế đã sạch.`);
        await exchange.cancelAllOrders(symbol, { positionSide });
    } else {
        safeLog('error', `💀 [${exchange.id}] CRITICAL: Không thể đóng vị thế sau 5 lần thử!`);
    }
    return isCleared;
}

/**
 * LAYER 3: MONITOR (BOT TỰ VÃ KHI GIÁ CHẠM ĐIỂM)
 * Chạy trong vòng lặp chính để dự phòng cho lệnh TP/SL của sàn bị lag
 */
async function monitorAndFailsafe() {
    if (!currentTradeDetails || currentTradeDetails.status !== 'OPEN') return;

    try {
        const { shortExchange, longExchange, shortOriginalSymbol, longOriginalSymbol, 
                shortTpPrice, shortSlPrice, longTpPrice, longSlPrice } = currentTradeDetails;

        const [tShort, tLong] = await Promise.all([
            exchanges[shortExchange].fetchTicker(shortOriginalSymbol),
            exchanges[longExchange].fetchTicker(longOriginalSymbol)
        ]);

        const pS = tShort.last;
        const pL = tLong.last;

        const hitShort = (pS <= shortTpPrice) || (pS >= shortSlPrice);
        const hitLong = (pL >= longTpPrice) || (pL <= longSlPrice);

        if (hitShort || hitLong) {
            const reason = hitShort ? "FAILSAFE_SHORT_TRIGGER" : "FAILSAFE_LONG_TRIGGER";
            safeLog('warn', `🎯 [LAYER 3] Phát hiện giá chạm điểm thoát. Thực thi SmartClose...`);
            
            currentTradeDetails.status = 'CLOSING';
            await Promise.all([
                smartCloseCCXT(exchanges[shortExchange], shortOriginalSymbol, 'SHORT', reason),
                smartCloseCCXT(exchanges[longExchange], longOriginalSymbol, 'LONG', reason)
            ]);
            
            // Xử lý sau khi đóng
            tradeHistory.push({...currentTradeDetails, closeTime: Date.now()});
            currentTradeDetails = null;
        }
    } catch (e) { }
}

// ============================================================================
// 🚀 CẬP NHẬT HÀM EXECUTE TRADES (SỬA LẠI PHẦN MỞ LỆNH)
// ============================================================================

async function executeTrades(opportunity, percentageToUse) {
    // ... (Giữ nguyên phần validate opportunity và balance của ông) ...

    try {
        // --- BƯỚC 1: MỞ LỆNH MARKET ---
        safeLog('log', `[TRADE] Đang mở vị thế đối ứng cho ${cleanedCoin}...`);
        
        // (Giữ nguyên logic tính amountToOrder của ông)
        shortOrder = await shortExchange.createMarketSellOrder(shortOriginalSymbol, parseFloat(shortAmountToOrder), { 'positionSide': 'SHORT' });
        longOrder = await longExchange.createMarketBuyOrder(longOriginalSymbol, parseFloat(longAmountToOrder), { 'positionSide': 'LONG' });

        // --- BƯỚC 2: TÍNH TOÁN TP/SL (THEO ROI/COLLATERAL) ---
        const shortTpPrice = shortEntryPrice * (1 - (TP_PERCENT_OF_COLLATERAL / (actualShortLeverage * 100)));
        const shortSlPrice = shortEntryPrice * (1 + (SL_PERCENT_OF_COLLATERAL / (actualShortLeverage * 100)));
        const longTpPrice = longEntryPrice * (1 + (TP_PERCENT_OF_COLLATERAL / (actualLongLeverage * 100)));
        const longSlPrice = longEntryPrice * (1 - (SL_PERCENT_OF_COLLATERAL / (actualLongLeverage * 100)));

        currentTradeDetails = {
            coin: cleanedCoin, shortExchange: shortExchangeId, longExchange: longExchangeId,
            shortOriginalSymbol, longOriginalSymbol,
            shortTpPrice, shortSlPrice, longTpPrice, longSlPrice,
            status: 'OPEN', openTime: Date.now()
        };

        // --- BƯỚC 3: ÁP DỤNG HỆ THỐNG GIÁP 5 LỚP ---
        await Promise.all([
            updateSànGiápCCXT(shortExchange, shortOriginalSymbol, 'SHORT', shortOrder.amount, shortTpPrice, shortSlPrice),
            updateSànGiápCCXT(longExchange, longOriginalSymbol, 'LONG', longOrder.amount, longTpPrice, longSlPrice)
        ]);

        return true;
    } catch (e) {
        safeLog('error', `❌ Lỗi thực thi: ${e.message}`);
        // Failsafe: Nếu mở 1 bên lỗi, đóng sạch bên còn lại
        await Promise.all([
            smartCloseCCXT(shortExchange, shortOriginalSymbol, 'SHORT', 'CLEANUP_FAIL'),
            smartCloseCCXT(longExchange, longOriginalSymbol, 'LONG', 'CLEANUP_FAIL')
        ]);
        currentTradeDetails = null;
        return false;
    }
}

// ============================================================================
// 🔄 MAIN LOOP (TÍCH HỢP MONITOR)
// ============================================================================

async function mainBotLoop() {
    if (botState !== 'RUNNING') return;

    // 1. Monitor Layer 3 (Luôn ưu tiên kiểm tra lệnh đang mở)
    if (currentTradeDetails) {
        await monitorAndFailsafe();
    }

    // 2. Fetch data & Tìm cơ hội (Logic cũ của ông)
    const serverData = await fetchDataFromServer();
    if (serverData) {
        await processServerData(serverData);
        // ... Logic mở lệnh mới nếu chưa có lệnh ...
    }
}

// Chạy vòng lặp
setInterval(mainBotLoop, DATA_FETCH_INTERVAL_SECONDS * 1000);
