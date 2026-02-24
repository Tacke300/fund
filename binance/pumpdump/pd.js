import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CẤU HÌNH ---
let tpPercent = 5.0; // 5% Biến động giá trên đồ thị
let slPercent = 5.0; // 5% Biến động giá trên đồ thị
let botSettings = { 
    isRunning: false, 
    maxPositions: 10, 
    invValue: 1.5, 
    invType: 'percent', 
    minVol: 5.0,
    defaultLeverage: 75  // Đòn bẩy x75
};

let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let botManagedSymbols = []; 
let blockedSymbols = new Map(); 
let isInitializing = true;
let isProcessing = false;

// --- HÀM HỖ TRỢ ---
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    const colors = { success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m' };
    console.log(`${colors[type] || ''}[${time}] ${msg}\x1b[0m`);
}

async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now() - 1000; 
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
            let d = ''; res.on('data', chunk => d += chunk);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(j); 
                    else reject(j);
                } catch (e) { reject({ msg: "PARSE_ERR" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

async function setupAccount(symbol, leverage) {
    try {
        await callBinance('/fapi/v1/leverage', 'POST', { symbol, leverage }).catch(()=>{});
        await callBinance('/fapi/v1/marginType', 'POST', { symbol, marginType: 'CROSSED' }).catch(()=>{});
    } catch (e) {}
}

async function enforceBaoVe(symbol, side, type, price, qty, info) {
    const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
    for (let attempt = 1; attempt <= 3; attempt++) {
        let res = await callBinance('/fapi/v1/order', 'POST', {
            symbol, side: closeSide, positionSide: side,
            type: type === 'TP' ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET',
            stopPrice: price, workingType: 'MARK_PRICE', closePosition: 'true'
        }).catch(e => ({ error: e.msg || "ERR" }));

        if (!res.error || !res.msg) {
            addBotLog(`✅ [${symbol}] Cài ${type} (5% giá) tại: ${price}`, "success");
            return true;
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    return false;
}

// --- LOGIC CHÍNH ---
async function hunt() {
    if (isInitializing || !botSettings.isRunning || isProcessing) return;
    try {
        isProcessing = true;
        if (botManagedSymbols.length >= botSettings.maxPositions) return;

        const positions = await callBinance('/fapi/v2/positionRisk');
        const activeOnExchange = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => p.symbol);
        const managedNames = botManagedSymbols.map(i => i.symbol);

        for (const c of status.candidatesList.filter(c => c.maxV >= botSettings.minVol)) {
            if (activeOnExchange.includes(c.symbol) || managedNames.includes(c.symbol)) continue;
            if (blockedSymbols.has(c.symbol) && Date.now() < blockedSymbols.get(c.symbol)) continue;
            if (c.symbol.toUpperCase().includes('USDC')) continue;

            const info = status.exchangeInfo[c.symbol];
            if (!info) continue;

            // Thiết lập đòn bẩy
            await setupAccount(c.symbol, botSettings.defaultLeverage);

            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
            const currentPrice = parseFloat(ticker.price);
            
            let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
            let qty = (Math.floor(((margin * botSettings.defaultLeverage) / currentPrice) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

            const side = c.changePercent > 0 ? 'BUY' : 'SELL';
            const posSide = c.changePercent > 0 ? 'LONG' : 'SHORT';

            addBotLog(`🚀 Đang vào lệnh ${c.symbol} (${posSide}) x${botSettings.defaultLeverage}`, "info");
            
            const order = await callBinance('/fapi/v1/order', 'POST', { 
                symbol: c.symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty 
            }).catch(e => ({ error: e.msg }));

            if (order.orderId) {
                botManagedSymbols.push({ symbol: c.symbol, openedAt: Date.now(), isSettingUp: true });
                
                // Đợi sàn cập nhật Entry thực tế
                setTimeout(async () => {
                    try {
                        const pCheck = await callBinance('/fapi/v2/positionRisk', 'GET', { symbol: c.symbol });
                        const p = pCheck.find(pos => pos.symbol === c.symbol && parseFloat(pos.positionAmt) !== 0);
                        
                        if (p) {
                            const entry = parseFloat(p.entryPrice);
                            const pQty = Math.abs(parseFloat(p.positionAmt));
                            
                            // LOGIC: TÍNH 5% TRÊN GIÁ (Bất kể đòn bẩy)
                            const tpDiff = entry * (tpPercent / 100);
                            const slDiff = entry * (slPercent / 100);

                            let tpPrice = posSide === 'LONG' ? (entry + tpDiff) : (entry - tpDiff);
                            let slPrice = posSide === 'LONG' ? (entry - slDiff) : (entry + slDiff);

                            // Làm tròn chuẩn theo Tick Size
                            const finalTP = (Math.round(tpPrice / info.tickSize) * info.tickSize).toFixed(info.pricePrecision);
                            const finalSL = (Math.round(slPrice / info.tickSize) * info.tickSize).toFixed(info.pricePrecision);

                            addBotLog(`🔹 [${c.symbol}] Entry thực: ${entry} -> TP (5% giá): ${finalTP} | SL (5% giá): ${finalSL}`);
                            
                            await enforceBaoVe(c.symbol, posSide, 'TP', finalTP, pQty, info);
                            await enforceBaoVe(c.symbol, posSide, 'SL', finalSL, pQty, info);
                        }
                    } finally {
                        const target = botManagedSymbols.find(i => i.symbol === c.symbol);
                        if (target) target.isSettingUp = false;
                    }
                }, 4000); 
                break; 
            }
        }
    } finally { isProcessing = false; }
}

async function cleanup() {
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const activeSymbols = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => p.symbol);
        
        for (let i = botManagedSymbols.length - 1; i >= 0; i--) {
            const item = botManagedSymbols[i];
            const isFinished = !activeSymbols.includes(item.symbol);
            const isNotNew = (Date.now() - item.openedAt) > 20000; 

            if (isFinished && isNotNew && !item.isSettingUp) {
                addBotLog(`🏁 [${item.symbol}] Đã đóng. Clear lệnh treo...`, "warn");
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol: item.symbol }).catch(()=>{});
                botManagedSymbols.splice(i, 1);
                blockedSymbols.set(item.symbol, Date.now() + 3 * 60 * 1000); 
            }
        }
    } catch (e) {}
}

async function updateBalance() {
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
    } catch (e) {}
}

function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const response = JSON.parse(d);
                status.candidatesList = (response.live || []).map(c => ({
                    symbol: c.symbol, changePercent: c.c1, maxV: Math.max(Math.abs(c.c1), Math.abs(c.c5), Math.abs(c.c15))
                })).sort((a, b) => b.maxV - a.maxV);
            } catch (e) {}
        });
    }).on('error', () => {});
}

const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => {
    res.json({ botSettings, botRunningSlots: botManagedSymbols.map(i => i.symbol), status });
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ status: "ok" }); });

async function init() {
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
            try {
                const info = JSON.parse(d);
                info.symbols.forEach(s => {
                    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
                    const prc = s.filters.find(f => f.filterType === 'PRICE_FILTER');
                    status.exchangeInfo[s.symbol] = { 
                        quantityPrecision: s.quantityPrecision, 
                        pricePrecision: s.pricePrecision, 
                        stepSize: parseFloat(lot.stepSize), 
                        tickSize: parseFloat(prc.tickSize)
                    };
                });
                isInitializing = false;
                addBotLog("🚀 BOT SẴN SÀNG - FIX LỖI TỰ ĐÓNG & TP/SL 5% GIÁ", "success");
            } catch (e) {}
        });
    });
}

init();
setInterval(updateBalance, 10000);
setInterval(fetchCandidates, 2000);
setInterval(hunt, 4000);
setInterval(cleanup, 10000);
APP.listen(9001, '0.0.0.0');
