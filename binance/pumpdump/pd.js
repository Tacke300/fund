import https from 'https';
import crypto from 'crypto';
import express from 'express';
import axios from 'axios';
import http from 'http';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BOT_HISTORY_FILE = './bot_history_real.json';

// ============================================================================
// ⚙️ HỆ THỐNG QUẢN TRỊ ĐỘC LẬP
// ============================================================================
let botSettings = { isRunning: false, maxPositions: 3, invValue: 1, invType: 'percent', minVol: 6.5, posTP: 0.5, posSL: 5.0, dcaStep: 10.0, maxDCA: 8 };
let status = { initialBalance: 0, currentBalance: 0, totalPnl: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let activeOrdersTracker = new Map(); 
let pendingSymbols = new Set();
let serverTimeOffset = 0;

// Khởi tạo file lịch sử riêng của Bot nếu chưa có
if (!fs.existsSync(BOT_HISTORY_FILE)) fs.writeFileSync(BOT_HISTORY_FILE, JSON.stringify([]));

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 200) status.botLogs.pop();
    
    const colors = { success: '\x1b[32m', error: '\x1b[31m', warning: '\x1b[33m', entry: '\x1b[36m', info: '\x1b[37m' };
    console.log(`${colors[type] || colors.info}[${time}] ${msg}\x1b[0m`);
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
                const req = https.request(url, { method, timeout: 5000, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
                    let d = ''; res.on('data', c => d += c);
                    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
                });
                req.on('error', reject); req.end();
            });
            if (res.code === -1021) {
                const t = await new Promise(r => https.get('https://fapi.binance.com/fapi/v1/time', res => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>r(JSON.parse(d))); }));
                serverTimeOffset = t.serverTime - Date.now();
                continue;
            }
            return res;
        } catch (e) { if (i === retries - 1) throw e; await sleep(500); }
    }
}

// ============================================================================
// 🛡️ GIÁP 3 LỚP ĐỘC LẬP
// ============================================================================
async function setupShield(symbol, side, posSide, tp, sl) {
    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
    addBotLog(`🛡️ [GIÁP] Đang kích hoạt 3 lớp cho ${symbol}...`, "info");
    try {
        const ts = Date.now() + serverTimeOffset;
        const q = `symbol=${symbol}&side=${closeSide}&positionSide=${posSide}&type=TAKE_PROFIT_MARKET&stopPrice=${tp}&closePosition=true&timestamp=${ts}`;
        const sig = crypto.createHmac('sha256', SECRET_KEY).update(q).digest('hex');
        await axios.post(`https://fapi.binance.com/fapi/v1/order?${q}&signature=${sig}`, null, { headers: { 'X-MBX-APIKEY': API_KEY } });
        addBotLog(`✅ Lớp 1 (TP Axios): ${symbol} @${tp}`, "success");
    } catch (e) {}
    await sleep(1500);
    try {
        await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: posSide, type: 'STOP_MARKET', stopPrice: sl, closePosition: 'true' });
        addBotLog(`✅ Lớp 2 (SL Fapi): ${symbol} @${sl}`, "success");
    } catch (e) {}
}

// ============================================================================
// 💾 QUẢN LÝ LỊCH SỬ THỰC
// ============================================================================
function saveTradeToHistory(tradeData) {
    try {
        const history = JSON.parse(fs.readFileSync(BOT_HISTORY_FILE));
        history.push({ ...tradeData, time: new Date().toLocaleString('vi-VN') });
        fs.writeFileSync(BOT_HISTORY_FILE, JSON.stringify(history.slice(-500), null, 2));
    } catch (e) { addBotLog("❌ Lỗi ghi file lịch sử", "error"); }
}

async function openPosition(symbol, side, info) {
    const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
    try {
        const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
        const price = parseFloat(ticker.price);
        const acc = await callBinance('/fapi/v2/account');
        
        let margin = botSettings.invType === 'percent' ? (parseFloat(acc.totalWalletBalance) * botSettings.invValue) / 100 : botSettings.invValue;
        let qty = (Math.floor(((margin * 20) / price) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

        addBotLog(`📡 [BINANCE] Đang khớp lệnh ${symbol} Qty: ${qty}...`, "info");
        const order = await callBinance('/fapi/v1/order', 'POST', { symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty });

        if (order.orderId) {
            await sleep(2000);
            const pos = (await callBinance('/fapi/v2/positionRisk')).find(p => p.symbol === symbol && p.positionSide === posSide && Math.abs(p.positionAmt) > 0);
            if (!pos) return;

            const entry = parseFloat(pos.entryPrice);
            const tp = (posSide === 'LONG' ? entry * (1 + botSettings.posTP/100) : entry * (1 - botSettings.posTP/100)).toFixed(info.pricePrecision);
            const sl = (posSide === 'LONG' ? entry * (1 - botSettings.posSL/100) : entry * (1 + botSettings.posSL/100)).toFixed(info.pricePrecision);

            activeOrdersTracker.set(symbol, { 
                symbol, side: posSide, entry, qty: Math.abs(parseFloat(pos.positionAmt)), tp, sl, startTime: Date.now() 
            });

            addBotLog(`🚀 KHỚP THÀNH CÔNG: ${symbol} @${entry}`, "entry");
            await setupShield(symbol, side, posSide, tp, sl);
        }
    } catch (e) { addBotLog(`❌ Lỗi sàn Binance: ${e.message}`, "error"); }
}

async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalWalletBalance);

        const posRisk = await callBinance('/fapi/v2/positionRisk');
        const openPositions = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);

        // Lớp 3: Monitor và Check đóng lệnh từ Sàn
        for (let [symbol, data] of activeOrdersTracker) {
            const floorPos = openPositions.find(p => p.symbol === symbol && p.positionSide === data.side);
            
            if (!floorPos) {
                // Lệnh đã đóng trên sàn (do hit TP/SL hoặc đóng tay)
                addBotLog(`💰 [SÀN ĐÃ ĐÓNG] ${symbol}. Đang dọn dẹp lệnh treo...`, "success");
                activeOrdersTracker.delete(symbol);
                callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(()=>{});
                saveTradeToHistory({ symbol, side: data.side, entry: data.entry, status: "CLOSED" });
                continue;
            }

            // Monitor giá real-time để báo log (không spam)
            const pnl = parseFloat(floorPos.unrealizedProfit);
            if (Math.abs(pnl) > (status.currentBalance * 0.05)) { // Chỉ log khi PnL biến động > 5% vốn
                 // addBotLog(`📈 PnL ${symbol}: ${pnl.toFixed(2)} USDT`, "info");
            }
        }

        // Mở lệnh mới
        if (openPositions.length < botSettings.maxPositions) {
            for (const coin of status.candidatesList) {
                if (!activeOrdersTracker.has(coin.symbol) && !pendingSymbols.has(coin.symbol)) {
                    if (coin.maxV >= botSettings.minVol) {
                        pendingSymbols.add(coin.symbol);
                        openPosition(coin.symbol, coin.c1 >= 0 ? 'BUY' : 'SELL', status.exchangeInfo[coin.symbol])
                            .finally(() => setTimeout(() => pendingSymbols.delete(coin.symbol), 5000));
                        break;
                    }
                }
            }
        }
    } catch (e) {}
}

// 📡 CHỈ LẤY BIẾN ĐỘNG TỪ SERVER 9000
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
            try {
                const r = JSON.parse(d);
                const rawList = r.live || r.data || [];
                status.candidatesList = rawList.map(c => ({
                    symbol: c.symbol,
                    c1: parseFloat(c.c1) || 0,
                    maxV: Math.max(Math.abs(parseFloat(c.c1)||0), Math.abs(parseFloat(c.c5)||0), Math.abs(parseFloat(c.c15)||0))
                })).filter(c => c.symbol.endsWith('USDT')).sort((a,b) => b.maxV - a.maxV);
            } catch (e) {}
        });
    }).on('error', () => {});
}, 1500);

async function init() {
    try {
        const info = await callBinance('/fapi/v1/exchangeInfo');
        info.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize) };
        });
        const acc = await callBinance('/fapi/v2/account');
        status.initialBalance = parseFloat(acc.totalWalletBalance);
        addBotLog(`✅ ĐÃ KẾT NỐI BINANCE. Vốn thực: ${status.initialBalance} USDT`, "success");
    } catch (e) { addBotLog("❌ Lỗi kết nối sàn!", "error"); }
}

init(); 
setInterval(mainLoop, 2000);

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(activeOrdersTracker.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
