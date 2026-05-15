import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const MAX_DCA_LEVEL = 3; 
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binanceApi = axios.create({ 
    baseURL: 'https://fapi.binance.com', 
    timeout: 15000, 
    headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' } 
});

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 1.2, posSL: 10.0, maxDCA: MAX_DCA_LEVEL };
let status = { botLogs: [], candidatesList: [], blackList: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: {}, isReady: false };
let botActivePositions = new Map();
let isProcessingDCA = new Set();
let serverTimeOffset = 0;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 60) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function binanceRequest(method, endpoint, data = {}) {
    const timestamp = Date.now() + serverTimeOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 10000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    const url = `${endpoint}?${query}&signature=${signature}`;
    
    try {
        const response = await binanceApi({ method, url });
        return response.data;
    } catch (e) {
        if (e.response?.data?.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            serverTimeOffset = t.data.serverTime - Date.now();
            return binanceRequest(method, endpoint, data);
        }
        throw e.response?.data || e;
    }
}

async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        const posRisk = await binanceRequest('GET', '/fapi/v2/positionRisk').catch(() => null);
        if (!posRisk) return setTimeout(priceMonitor, 1000);

        for (let [key, b] of botActivePositions) {
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            if (realP) {
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);
                b.pnl = parseFloat(realP.unRealizedProfit);
                b.priceDev = ((markP - b.entryPrice) / b.entryPrice) * 100;
            } else {
                if (isProcessingDCA.has(b.symbol)) continue;
                
                addBotLog(`⚠️ Kiểm tra trạng thái đóng vị thế của ${b.symbol}...`);
                const trades = await binanceRequest('GET', '/fapi/v1/userTrades', { symbol: b.symbol, limit: 10 }).catch(() => []);
                const recent = trades.filter(t => (Date.now() + serverTimeOffset - t.time) < 60000);
                let totalR = 0; recent.forEach(t => totalR += parseFloat(t.realizedPnl));
                
                botActivePositions.delete(key);
                status.botClosedCount++; 
                status.botPnLClosed += totalR;

                if (totalR > 0 || b.side === 'LONG') {
                    status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                    addBotLog(`💰 [KẾT QUẢ: THÀNH CÔNG] Đã CHỐT LỜI ${b.symbol} (${b.side}) | Tổng PnL: ${totalR.toFixed(2)}$ | Khóa 15 phút.`, 'success');
                } else {
                    addBotLog(`❌ [KẾT QUẢ: THẤT BẠI] Lệnh SHORT ${b.symbol} dính SL lỗ: ${totalR.toFixed(2)}$`, 'error');
                    const ticker = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price?symbol=' + b.symbol);
                    const currentPrice = parseFloat(ticker.data.price);
                    
                    const jump = Math.max(b.dcaCount + 1, Math.floor((currentPrice - b.firstEntry) / (b.firstEntry * botSettings.posSL / 100)));
                    
                    if (jump <= botSettings.maxDCA) {
                        addBotLog(`🔄 [HÀNH ĐỘNG] Kích hoạt DCA Cấp [${jump}/${botSettings.maxDCA}] cho SHORT ${b.symbol}.`);
                        openPosition(b.symbol, { ...b, dcaCount: jump, margin: b.firstMargin * (jump + 1) });
                    } else {
                        addBotLog(`🚨 [HÀNH ĐỘNG] Chạm trần DCA (${botSettings.maxDCA}). Tiến hành QUAY XE mở lệnh LONG CUỐI x20 vốn cho ${b.symbol}.`);
                        openPosition(b.symbol, { ...b, isFinalLong: true, margin: b.firstMargin * 20 });
                    }
                }
            }
        }
    } catch (e) {}
    setTimeout(priceMonitor, 1000);
}

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    let walletData = { totalWalletBalance: "0.00", availableBalance: "0.00", totalUnrealizedProfit: "0.00" };
    try {
        const acc = await binanceRequest('GET', '/fapi/v2/account');
        const botUnrealizedPnL = Array.from(botActivePositions.values()).reduce((s, p) => s + (p.pnl || 0), 0);
        walletData = {
            totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), 
            availableBalance: parseFloat(acc.availableBalance).toFixed(2), 
            totalUnrealizedProfit: botUnrealizedPnL.toFixed(2)
        };
    } catch (e) {}

    res.json({ 
        botSettings, 
        activePositions: Array.from(botActivePositions.values()),
        status: { ...status, blackList: Object.fromEntries(Object.entries(status.blackList).map(([s, t]) => [s, Math.max(0, Math.floor((t - Date.now()) / 1000))])) }, 
        wallet: walletData
    });
});

APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });

async function openPosition(symbol, dcaData = null) {
    if (!status.exchangeInfo[symbol]) return;
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol);
    
    const side = dcaData?.isFinalLong ? 'LONG' : 'SHORT';
    const currentDCALevel = dcaData ? dcaData.dcaCount : 0;
    
    console.log(`\n=================== THAO TÁC VÀO LỆNH: ${symbol} ===================`);
    addBotLog(`🎬 Bắt đầu quy trình mở lệnh ${symbol} [${side}] - DCA Lần: ${currentDCALevel}`);
    
    try {
        const info = status.exchangeInfo[symbol];
        const acc = await binanceRequest('GET', '/fapi/v2/account');
        
        let margin = dcaData ? dcaData.margin : (botSettings.invValue.toString().includes('%') ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue) / 100) : parseFloat(botSettings.invValue));
        if ((margin * info.maxLeverage) < 6.5) {
            margin = 6.5 / info.maxLeverage;
            console.log(`⚠️ Ép Margin tối thiểu lên: ${margin.toFixed(4)}$ để bảo vệ Vol sàn (>6.5$)`);
        }
        
        const ticker = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price?symbol=' + symbol);
        const price = parseFloat(ticker.data.price);
        let qty = (Math.ceil(((margin * info.maxLeverage) / price) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);
        
        console.log(`[THÔNG SỐ TÍNH TOÁN] Vốn (Margin): ${margin.toFixed(2)}$ | Đòn bẩy (Leverage): x${info.maxLeverage} | Khối lượng (Qty): ${qty}`);
        
        await binanceRequest('POST', '/fapi/v1/leverage', { symbol, leverage: info.maxLeverage });
        
        console.log(`[1/3] Gửi lệnh MARKET mở vị thế...`);
        const order = await binanceRequest('POST', '/fapi/v1/order', { symbol, side: side === 'SHORT' ? 'SELL' : 'BUY', positionSide: side, type: 'MARKET', quantity: qty });
        
        if (order) {
            console.log(`✅ Lệnh MARKET thành công. Đợi sàn cập nhật vị thế (1.2s)...`);
            await new Promise(r => setTimeout(r, 1200));
            
            const pRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol });
            const p = pRisk.find(x => x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0);
            
            if (p) {
                const entry = parseFloat(p.entryPrice);
                const firstE = dcaData ? dcaData.firstEntry : entry;
                
                let tp = (side === 'LONG') ? entry * 1.10 : entry * (1 - botSettings.posTP / 100);
                let sl = (side === 'LONG') ? entry * 0.90 : firstE + (firstE * botSettings.posSL / 100);
                
                addBotLog(`📊 [VỊ THẾ MỞ THÀNH CÔNG] ${symbol} | Side: ${side} | DCA Lần: ${currentDCALevel} | Giá TB (Entry): ${entry} | Ký Quỹ (Margin): ${margin.toFixed(2)}$ | Đích TP: ${tp.toFixed(info.pricePrecision)} | Đích SL: ${sl.toFixed(info.pricePrecision)}`);
                
                await syncTPSL(symbol, side, info, tp, sl);
                
                botActivePositions.set(`${symbol}_${side}`, { 
                    symbol, side, entryPrice: entry, tp, sl, 
                    dcaCount: currentDCALevel, 
                    leverage: info.maxLeverage, firstEntry: firstE, 
                    firstMargin: dcaData ? dcaData.firstMargin : margin, 
                    currentQty: Math.abs(parseFloat(p.positionAmt)), pnl: 0, priceDev: 0 
                });
            } else {
                addBotLog(`❌ [THẤT BẠI] Lệnh MARKET khớp nhưng check PositionRisk không thấy vị thế ${symbol} đâu.`, 'error');
            }
        }
    } catch (e) { 
        addBotLog(`❌ [THẤT BẠI TOÀN TẬP] Lỗi quy trình mở lệnh: ${e.msg || e.message || JSON.stringify(e)}`, 'error'); 
    } finally { 
        console.log(`====================================================================\n`);
        setTimeout(() => isProcessingDCA.delete(symbol), 2000); 
    }
}

// HÀM ĐỒNG BỘ ĐẶT LỆNH TP/SL QUA CỔNG ALGO CHUẨN ĐỊNH DẠNG URL-ENCODED CỦA BINANCE FUTURES
async function syncTPSL(symbol, side, info, tp, sl) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    
    // 1. Dọn dẹp lệnh thường cũ tránh xung đột chéo vị thế
    try {
        const orders = await binanceRequest('GET', '/fapi/v1/openOrders', { symbol });
        const targetOrders = orders.filter(o => o.positionSide === side && (o.type === 'TAKE_PROFIT_MARKET' || o.type === 'STOP_MARKET'));
        for (const o of targetOrders) { 
            await binanceRequest('DELETE', '/fapi/v1/order', { symbol, orderId: o.orderId }); 
        }
        console.log(`[2/3] Đã dọn dẹp sạch ${targetOrders.length} lệnh TP/SL cũ của ${symbol}.`);
    } catch (e) {
        console.log(`⚠️ Không dọn dẹp được lệnh cũ: ${e.msg || e.message}`);
    }

    // 2. Đặt lệnh TAKE_PROFIT_MARKET thông qua API ALGO CHUẨN CHỈNH THAM SỐ
    try {
        await binanceRequest('POST', '/fapi/v1/algo/order', { 
            symbol: symbol, 
            side: sideClose, 
            positionSide: side, 
            algoType: 'TAKE_PROFIT_MARKET', // Bắt buộc đổi từ 'type' sang 'algoType' cho cổng Algo
            triggerPrice: tp.toFixed(info.pricePrecision), // Đổi từ 'stopPrice' sang 'triggerPrice'
            closePosition: 'true',       
            workingType: 'MARK_PRICE',
            priceProtect: 'TRUE'         
        });
        console.log(`🎯 [TP SÀN ALGO: THÀNH CÔNG] Đã đặt lệnh Chốt Lời cho ${symbol} tại giá Mark: ${tp.toFixed(info.pricePrecision)}`);
    } catch (e) {
        addBotLog(`❌ [TP SÀN ALGO: THẤT BẠI] Lỗi đặt TP cho ${symbol}: ${e.msg || e.message || JSON.stringify(e)}`, 'error');
    }

    // 3. Đặt lệnh STOP_MARKET thông qua API ALGO CHUẨN CHỈNH THAM SỐ
    try {
        await binanceRequest('POST', '/fapi/v1/algo/order', { 
            symbol: symbol, 
            side: sideClose, 
            positionSide: side, 
            algoType: 'STOP_MARKET', 
            triggerPrice: sl.toFixed(info.pricePrecision), 
            closePosition: 'true',       
            workingType: 'MARK_PRICE',
            priceProtect: 'TRUE'
        });
        console.log(`🛑 [SL SÀN ALGO: THÀNH CÔNG] Đã đặt lệnh Cắt Lỗ cho ${symbol} tại giá Mark: ${sl.toFixed(info.pricePrecision)}`);
    } catch (e) {
        addBotLog(`❌ [SL SÀN ALGO: THẤT BẠI] Lỗi đặt SL cho ${symbol}: ${e.msg || e.message || JSON.stringify(e)}`, 'error');
    }
}

async function init() {
    console.log(`[${new Date().toLocaleTimeString()}] 🔄 Đang khởi tạo hệ thống...`);
    try {
        const ipRes = await axios.get('https://api.ipify.org?format=json', { timeout: 4000 }).catch(() => ({ data: { ip: "Không lấy được" } }));
        console.log(`🌐 [CHECK IP] IPv4 Hiện Tại Của Bot: ${ipRes.data.ip}`);

        const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
        serverTimeOffset = t.data.serverTime - Date.now();
        
        const info = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
        const brk = await binanceRequest('GET', '/fapi/v1/leverageBracket').catch(() => []);
        
        const temp = {};
        info.data.symbols.forEach(s => {
            const b = brk.find(x => x.symbol === s.symbol);
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            temp[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), 
                maxLeverage: b?.brackets[0]?.initialLeverage || 20 
            };
        });
        
        status.exchangeInfo = temp; 
        status.isReady = true; 
        priceMonitor();
        addBotLog(`🚀 Hệ thống đã chuyển đổi sang cấu trúc tham số Algo, chạy lại ngay!`);
    } catch (e) { 
        console.error("❌ Hệ thống khởi tạo thất bại:", e.message); 
        setTimeout(init, 5000); 
    }
}
init();

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

setInterval(() => {
    if (!status.isReady || !botSettings.isRunning) return;
    if (botActivePositions.size < botSettings.maxPositions && isProcessingDCA.size === 0) {
        const can = status.candidatesList.find(c => {
            const info = status.exchangeInfo[c.symbol];
            return (
                Math.abs(c.c1) >= botSettings.minVol &&        
                !status.blackList[c.symbol] &&                 
                !botActivePositions.has(`${c.symbol}_SHORT`) && 
                info && info.maxLeverage >= 20                 
            );
        });
        if (can) openPosition(can.symbol);
    }
}, 3000);

APP.listen(9001);
