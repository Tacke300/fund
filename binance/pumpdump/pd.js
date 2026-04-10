import https from 'https';
import crypto from 'crypto';
import express from 'express';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// ⚙️ CONFIG & STATUS
// ============================================================================
let botSettings = { isRunning: false, maxPositions: 3, invValue: 1, invType: 'percent', minVol: 6.5, posTP: 0.5, posSL: 5.0, dcaStep: 10, maxDCA: 8 };
let status = { initialBalance: 0, currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let activeOrdersTracker = new Map(); 
let pendingSymbols = new Set();
let serverTimeOffset = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 500) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function callBinance(endpoint, method = 'GET', params = {}, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const timestamp = Date.now() + serverTimeOffset;
            const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
            const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
            const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
            const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;
            const res = await new Promise((resolve, reject) => {
                const req = https.request(url, { method, timeout: 4000, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
                    let d = ''; res.on('data', c => d += c);
                    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
                });
                req.on('error', reject); req.end();
            });
            if (res.code === -1021) { 
                const t = await new Promise(r => https.get('https://fapi.binance.com/fapi/v1/time', res => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>r(JSON.parse(d))); }));
                serverTimeOffset = t.serverTime - Date.now(); continue;
            }
            return res;
        } catch (e) { if (i === retries - 1) throw e; await sleep(400); }
    }
}

// 🎯 LỚP 2: HÀM ĐÓNG VỊ THẾ BẰNG CALLBINANCE (THAY THẾ CCXT)
async function forceClosePosition(symbol, posSide) {
    try {
        const risk = await callBinance('/fapi/v2/positionRisk');
        const p = risk.find(x => x.symbol === symbol && x.positionSide === posSide);
        const qty = Math.abs(parseFloat(p?.positionAmt || 0));

        if (qty > 0) {
            const side = posSide === 'LONG' ? 'SELL' : 'BUY';
            addBotLog(`🔄 [LỚP 2] Đang vã Market đóng ${symbol} (${posSide}) - Qty: ${qty}`, "warning");
            
            const res = await callBinance('/fapi/v1/order', 'POST', {
                symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty, reduceOnly: 'true'
            });

            if (res.orderId) {
                addBotLog(`✅ [LỚP 2] Đã đóng thành công ${symbol}`, "success");
                return true;
            }
        }
    } catch (e) { addBotLog(`Lỗi đóng lệnh: ${e.message}`, "error"); }
    return false;
}

// 🚀 LỚP 1: MỞ VÀ CÀI GIÁP SÀN (ALGO)
async function openPosition(symbol, side, info, isReverse = false) {
    const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
    try {
        const acc = await callBinance('/fapi/v2/account');
        const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
        const price = parseFloat(ticker.price);
        
        let margin = botSettings.invType === 'percent' ? (parseFloat(acc.totalWalletBalance) * botSettings.invValue) / 100 : botSettings.invValue;
        if (isReverse) margin *= 10;

        let qty = (Math.floor(((margin * 20) / price) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);
        await callBinance('/fapi/v1/leverage', 'POST', { symbol, leverage: 20 });
        
        const order = await callBinance('/fapi/v1/order', 'POST', { symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty });
        if (order.orderId) {
            await sleep(2000);
            const posRisk = await callBinance('/fapi/v2/positionRisk');
            const pos = posRisk.find(p => p.symbol === symbol && p.positionSide === posSide);
            
            const entry = parseFloat(pos.entryPrice);
            const qtyOnFloor = Math.abs(parseFloat(pos.positionAmt));
            
            let tp = (posSide === 'LONG' ? entry * (1 + (isReverse ? 50 : botSettings.posTP)/100) : entry * (1 - (isReverse ? 50 : botSettings.posTP)/100)).toFixed(info.pricePrecision);
            let sl = (posSide === 'LONG' ? entry * (1 - (isReverse ? 50 : botSettings.posSL)/100) : entry * (1 + (isReverse ? 50 : botSettings.posSL)/100)).toFixed(info.pricePrecision);

            activeOrdersTracker.set(symbol, { 
                symbol, side: posSide, entry, initialEntry: entry, 
                qty: qtyOnFloor, tp, sl, dcaCount: 0, isClosing: false, orderIds: [order.orderId] 
            });

            // LỚP 1: CÀI ALGO
            addBotLog(`🛡️ [LỚP 1] Cài giáp ${symbol} - TP: ${tp} | SL: ${sl}`, "info");
            await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: posSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tp, closePosition: 'true', workingType: 'MARK_PRICE' });
            await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: posSide, type: 'STOP_MARKET', stopPrice: sl, closePosition: 'true', workingType: 'MARK_PRICE' });
            
            addBotLog(`✅ [OPEN] ${symbol} @${entry}`, "success");
        }
    } catch (e) { addBotLog(`Lỗi mở lệnh: ${e.message}`, "error"); }
}

async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalWalletBalance); // Cập nhật số dư realtime

        const posRisk = await callBinance('/fapi/v2/positionRisk');

        for (let [symbol, data] of activeOrdersTracker) {
            if (data.isClosing) continue;

            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
            const price = parseFloat(ticker.price);
            const floorPos = posRisk.find(p => p.symbol === symbol && p.positionSide === data.side && Math.abs(parseFloat(p.positionAmt)) > 0);

            // KIỂM TRA CHỐT SÀN (LỚP 1 KHỚP)
            if (!floorPos) {
                data.isClosing = true;
                addBotLog(`💰 [CHỐT SÀN] ${symbol} đã thoát vị thế.`, "info");
                await sleep(2000);
                const trades = await callBinance('/fapi/v1/userTrades', 'GET', { symbol, limit: 10 });
                const totalPnl = trades.filter(t => t.positionSide === data.side).reduce((s, t) => s + parseFloat(t.realizedPnl), 0);
                
                addBotLog(`💵 KẾT QUẢ ${symbol}: PnL ${totalPnl.toFixed(2)}$`, totalPnl >= 0 ? "success" : "error");
                activeOrdersTracker.delete(symbol);
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
                continue;
            }

            // LỚP 3: BOT THEO DÕI (MONITORING)
            let hit = (data.side === 'LONG' && (price >= data.tp || price <= data.sl)) || (data.side === 'SHORT' && (price <= data.tp || price >= data.sl));
            if (hit) {
                data.isClosing = true;
                addBotLog(`🚨 [LỚP 3] Bot kích hoạt Failsafe tại ${price} cho ${symbol}`, "warning");
                await forceClosePosition(symbol, data.side);
                continue;
            }

            // DCA LOGIC (Giữ nguyên gốc)
            const diff = ((price - data.entry) / data.entry) * 100;
            const isAgainst = (data.side === 'LONG' && diff <= -botSettings.dcaStep) || (data.side === 'SHORT' && diff >= botSettings.dcaStep);

            if (isAgainst && !data.isClosing) {
                if (data.dcaCount < botSettings.maxDCA) {
                    data.dcaCount++;
                    addBotLog(`📉 [DCA ${data.dcaCount}] ${symbol} @${price}`, "info");
                    
                    const dcaOrder = await callBinance('/fapi/v1/order', 'POST', { symbol, side: data.side === 'LONG' ? 'BUY' : 'SELL', positionSide: data.side, type: 'MARKET', quantity: (data.qty).toFixed(status.exchangeInfo[symbol].quantityPrecision) });
                    
                    if (dcaOrder.orderId) {
                        await sleep(2500);
                        const posRiskNew = await callBinance('/fapi/v2/positionRisk');
                        const newPos = posRiskNew.find(p => p.symbol === symbol && p.positionSide === data.side);
                        data.entry = parseFloat(newPos.entryPrice);
                        data.qty = Math.abs(parseFloat(newPos.positionAmt));
                        
                        data.tp = (data.side === 'LONG' ? data.entry * (1 + botSettings.posTP/100) : data.entry * (1 - botSettings.posTP/100)).toFixed(status.exchangeInfo[symbol].pricePrecision);
                        data.sl = (data.side === 'LONG' ? data.entry * (1 - botSettings.posSL/100) : data.entry * (1 + botSettings.posSL/100)).toFixed(status.exchangeInfo[symbol].pricePrecision);
                        
                        await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
                        const closeSide = data.side === 'LONG' ? 'SELL' : 'BUY';
                        await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: data.side, type: 'TAKE_PROFIT_MARKET', stopPrice: data.tp, closePosition: 'true', workingType: 'MARK_PRICE' });
                        await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: data.side, type: 'STOP_MARKET', stopPrice: data.sl, closePosition: 'true', workingType: 'MARK_PRICE' });
                        addBotLog(`♻️ Đã reset Giáp Lớp 1 cho ${symbol}`, "info");
                    }
                }
            }
        }
    } catch (e) { if (!e.message.includes('token')) console.log(e.message); }
}

// --- INIT & APP ---
async function init() {
    try {
        const t = await new Promise(r => https.get('https://fapi.binance.com/fapi/v1/time', res => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>r(JSON.parse(d))); }));
        serverTimeOffset = t.serverTime - Date.now();
        const info = await callBinance('/fapi/v1/exchangeInfo');
        info.symbols.forEach(s => {
            status.exchangeInfo[s.symbol] = {
                pricePrecision: s.pricePrecision, quantityPrecision: s.quantityPrecision,
                stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize)
            };
        });
        const acc = await callBinance('/fapi/v2/account');
        status.initialBalance = parseFloat(acc.totalWalletBalance);
        status.currentBalance = status.initialBalance;
        addBotLog("✅ Bot khởi tạo thành công.", "success");
    } catch (e) { console.log(e.message); }
}

init(); 
setInterval(mainLoop, 3500);

const APP = express();
APP.use(express.json());
APP.get('/status', (req, res) => res.json(status));
APP.listen(9001);
