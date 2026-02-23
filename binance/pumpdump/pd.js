import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CẤU HÌNH TP/SL THEO % BIẾN ĐỘNG GIÁ ---
let tpPercent = 5.0; // Chốt lời khi giá chạy 5%
let slPercent = 5.0; // Cắt lỗ khi giá chạy 5%
// ------------------------------------------

let botSettings = { 
    isRunning: false, 
    maxPositions: 3, 
    invValue: 1.5, 
    invType: 'percent',
    minVol: 5.0, 
    accountSL: 30 
};

let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let botManagedSymbols = []; 
let blockedSymbols = new Map(); 
let isInitializing = true;
let isProcessing = false;
let marginErrorTime = 0;
let lastOrderTime = 0;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    const colors = { success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
    console.log(`${colors[type] || ''}[${time}] ${msg}\x1b[0m`);
}

async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now() - 2500; 
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=20000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
            let d = ''; res.on('data', chunk => d += chunk);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(j); 
                    else reject({ ...j, statusCode: res.statusCode });
                } catch (e) { reject({ msg: "API_REJECT", detail: d }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const response = JSON.parse(d);
                const all = response.live || [];
                status.candidatesList = all.map(c => ({
                    symbol: c.symbol, 
                    changePercent: c.c1, 
                    triggerFrame: "1M", 
                    maxV: Math.max(Math.abs(c.c1), Math.abs(c.c5), Math.abs(c.c15)),
                    c1: c.c1, c5: c.c5, c15: c.c15
                })).sort((a, b) => b.maxV - a.maxV);
            } catch (e) {}
        });
    }).on('error', () => {});
}

async function hunt() {
    if (isInitializing || !botSettings.isRunning || isProcessing) return;
    if (marginErrorTime > 0 && Date.now() < marginErrorTime) return;
    if (Date.now() - lastOrderTime < 15000) return;

    try {
        isProcessing = true;
        const positions = await callBinance('/fapi/v2/positionRisk');
        const activePositions = positions.filter(p => parseFloat(p.positionAmt) !== 0);
        botManagedSymbols = activePositions.map(p => p.symbol);

        if (botManagedSymbols.length >= botSettings.maxPositions) return;

        const now = Date.now();
        const targets = status.candidatesList.filter(c => c.maxV >= botSettings.minVol);

        for (const c of targets) {
            if (botManagedSymbols.length >= botSettings.maxPositions) break;
            if (botManagedSymbols.includes(c.symbol)) continue;
            if (blockedSymbols.has(c.symbol) && now < blockedSymbols.get(c.symbol)) continue;

            try {
                const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
                const lev = brackets[0].brackets[0].initialLeverage;
                
                if (lev <= 20) continue; 

                const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
                const currentPrice = parseFloat(ticker.price);
                const info = status.exchangeInfo[c.symbol];
                const side = c.changePercent > 0 ? 'BUY' : 'SELL';
                const posSide = c.changePercent > 0 ? 'LONG' : 'SHORT';

                addBotLog(`🎯 Kèo thơm: ${c.symbol} | Khung: ${c.triggerFrame} | Biến động: ${c.maxV}% | Giá: ${currentPrice} | Đòn bẩy: x${lev}`, "info");

                await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });
                
                let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
                let qty = Math.floor(((margin * lev) / currentPrice) / info.stepSize) * info.stepSize;
                const finalQty = qty.toFixed(info.quantityPrecision);

                addBotLog(`📤 Đang mở vị thế ${posSide} ${c.symbol} | Qty: ${finalQty} | Đòn bẩy x${lev}`, "info");

                const order = await callBinance('/fapi/v1/order', 'POST', {
                    symbol: c.symbol, side, positionSide: posSide, type: 'MARKET', quantity: finalQty
                });

                if (order.orderId) {
                    addBotLog(`✅ Khớp lệnh: ${c.symbol}. Đang cài TP/SL mức ${tpPercent}%...`, "success");
                    botManagedSymbols.push(c.symbol);
                    
                    const setupSuccess = await enforceTPSLForSymbol(c.symbol);
                    if (setupSuccess) {
                        lastOrderTime = Date.now();
                        addBotLog(`⏳ Hệ thống tạm nghỉ 15s để ổn định.`, "debug");
                    }
                    break; 
                }
            } catch (err) {
                if (err.code === -2019 || (err.msg && err.msg.toLowerCase().includes("margin"))) {
                    addBotLog(`🚨 LỖI MARGIN: Hết tiền. Tạm dừng 1 giờ.`, "error");
                    marginErrorTime = Date.now() + 60 * 60 * 1000;
                    break;
                } else {
                    addBotLog(`❌ Lỗi thực thi ${c.symbol}: ${err.msg || "API Error"}`, "error");
                }
            }
        }
    } finally { isProcessing = false; }
}

async function enforceTPSLForSymbol(symbol) {
    try {
        await new Promise(r => setTimeout(r, 3000));
        const positions = await callBinance('/fapi/v2/positionRisk');
        const p = positions.find(pos => pos.symbol === symbol && parseFloat(pos.positionAmt) !== 0);
        if (!p) return false;

        const info = status.exchangeInfo[symbol];
        const side = p.positionSide;
        const entry = parseFloat(p.entryPrice);

        // Tính giá dựa trên biến động % cố định (không phụ thuộc đòn bẩy)
        const tpRate = tpPercent / 100;
        const slRate = slPercent / 100;

        const tp = side === 'LONG' ? entry * (1 + tpRate) : entry * (1 - tpRate);
        const sl = side === 'LONG' ? entry * (1 - slRate) : entry * (1 + slRate);
        const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

        await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: tp.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' });
        await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET', stopPrice: sl.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' });
        
        addBotLog(`🛡️ Bảo vệ ${symbol}: TP ${tpPercent}% (${tp.toFixed(info.pricePrecision)}) | SL ${slPercent}% (${sl.toFixed(info.pricePrecision)})`, "success");
        return true;
    } catch (e) {
        addBotLog(`⚠️ Lỗi cài TP/SL cho ${symbol}: ${e.msg || "N/A"}`, "error");
        return false;
    }
}

async function cleanupClosedPositions() {
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const now = Date.now();
        const activeFromAPI = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => p.symbol);

        for (let i = botManagedSymbols.length - 1; i >= 0; i--) {
            const s = botManagedSymbols[i];
            if (!activeFromAPI.includes(s)) {
                addBotLog(`🏁 Lệnh ${s} đã kết thúc. Chặn 15p.`, "warn");
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol: s }).catch(()=>{});
                blockedSymbols.set(s, now + 15 * 60 * 1000);
                botManagedSymbols.splice(i, 1);
            }
        }
    } catch (e) {}
}

async function enforceTPSL() {
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const orders = await callBinance('/fapi/v1/openOrders');
        for (const s of botManagedSymbols) {
            const p = positions.find(pos => pos.symbol === s && parseFloat(pos.positionAmt) !== 0);
            if (!p) continue;
            const side = p.positionSide;
            const hasTP = orders.some(o => o.symbol === s && o.positionSide === side && o.type === 'TAKE_PROFIT_MARKET');
            const hasSL = orders.some(o => o.symbol === s && o.positionSide === side && o.type === 'STOP_MARKET');
            
            if (!hasTP || !hasSL) {
                const info = status.exchangeInfo[s];
                const entry = parseFloat(p.entryPrice);
                const tpRate = tpPercent / 100;
                const slRate = slPercent / 100;

                const tp = side === 'LONG' ? entry * (1 + tpRate) : entry * (1 - tpRate);
                const sl = side === 'LONG' ? entry * (1 - slRate) : entry * (1 + slRate);
                const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

                if (!hasTP) await callBinance('/fapi/v1/order', 'POST', { symbol: s, side: closeSide, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: tp.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' }).catch(()=>{});
                if (!hasSL) await callBinance('/fapi/v1/order', 'POST', { symbol: s, side: closeSide, positionSide: side, type: 'STOP_MARKET', stopPrice: sl.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' }).catch(()=>{});
            }
        }
    } catch (e) {}
}

const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => ({
            symbol: p.symbol, side: p.positionSide, leverage: p.leverage, entryPrice: p.entryPrice, markPrice: p.markPrice,
            pnlPercent: (parseFloat(p.unrealizedProfit) / ((parseFloat(p.entryPrice) * Math.abs(p.positionAmt)) / p.leverage) * 100).toFixed(2)
        }));
        res.json({ 
            botSettings, 
            status, 
            activePositions: active,
            topVolatility: status.candidatesList.slice(0, 5)
        });
    } catch (e) { res.status(500).send("ERR"); }
});

APP.post('/api/settings', (req, res) => {
    const newSettings = req.body;
    if (newSettings.maxPositions) newSettings.maxPositions = parseInt(newSettings.maxPositions);
    botSettings = { ...botSettings, ...newSettings };
    addBotLog(`⚙️ Đã lưu cấu hình mới.`, "warn");
    res.json({ status: "ok" });
});

async function init() {
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
            const info = JSON.parse(d);
            info.symbols.forEach(s => {
                const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
                status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize) };
            });
            isInitializing = false;
            addBotLog("🚀 Bot đã sẵn sàng.", "success");
        });
    });
}

init();
setInterval(fetchCandidates, 2000);
setInterval(hunt, 3000);
setInterval(cleanupClosedPositions, 5000);
setInterval(enforceTPSL, 10000);
APP.listen(9001, '0.0.0.0');
