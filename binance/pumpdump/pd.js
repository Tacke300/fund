import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let botSettings = { isRunning: false, maxPositions: 3, invValue: 1.5, invType: 'percent', minVol: 1.0, accountSL: 30 };
let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let botManagedSymbols = []; 
let cooldownList = {}; 
let isInitializing = true;
let isProcessing = false;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 200) status.botLogs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 8000 }, res => {
            let d = ''; res.on('data', chunk => d += chunk);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(j); else reject(j);
                } catch (e) { reject({ msg: "LỖI_JSON" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

async function clearOrders(symbol) {
    return callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(() => {});
}

async function cleanupClosedPositions() {
    if (!botSettings.isRunning) return;
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        for (let i = botManagedSymbols.length - 1; i >= 0; i--) {
            const symbol = botManagedSymbols[i];
            const p = positions.find(pos => pos.symbol === symbol);
            if (!p || parseFloat(p.positionAmt) === 0) {
                addBotLog(`🧹 [ĐÓNG] ${symbol} hoàn tất. Xóa lệnh & Ngủ đông 15p.`, "info");
                await clearOrders(symbol);
                cooldownList[symbol] = Date.now() + (15 * 60 * 1000);
                botManagedSymbols.splice(i, 1);
            }
        }
    } catch (e) {}
}

function calcTPSL(lev, side, entryPrice) {
    let m = lev < 26 ? 1.2 : (lev < 50 ? 2.3 : 3.5);
    const rate = m / lev;
    const tp = side === 'LONG' ? entryPrice * (1 + rate) : entryPrice * (1 - rate);
    const sl = side === 'LONG' ? entryPrice * (1 - rate) : entryPrice * (1 + rate);
    return { tp, sl };
}

async function enforceTPSL() {
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const orders = await callBinance('/fapi/v1/openOrders');
        for (const symbol of botManagedSymbols) {
            const p = positions.find(pos => pos.symbol === symbol && parseFloat(pos.positionAmt) !== 0);
            if (!p) continue;
            const side = p.positionSide;
            const hasTP = orders.some(o => o.symbol === symbol && o.type === 'TAKE_PROFIT_MARKET');
            const hasSL = orders.some(o => o.symbol === symbol && o.type === 'STOP_MARKET');
            if (!hasTP || !hasSL) {
                const info = status.exchangeInfo[symbol];
                const plan = calcTPSL(parseFloat(p.leverage), side, parseFloat(p.entryPrice));
                const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
                if (!hasTP) await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: plan.tp.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' });
                if (!hasSL) await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET', stopPrice: plan.sl.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' });
            }
        }
    } catch (e) {}
}

async function hunt() {
    if (isInitializing || !botSettings.isRunning || isProcessing) return;
    if (botManagedSymbols.length >= botSettings.maxPositions) return;

    try {
        isProcessing = true;
        for (const c of status.candidatesList) {
            if (botManagedSymbols.includes(c.symbol)) continue;
            if (cooldownList[c.symbol] && Date.now() < cooldownList[c.symbol]) continue;
            if (botManagedSymbols.length >= botSettings.maxPositions) break;

            const v1 = Math.abs(c.chg1), v5 = Math.abs(c.chg5), v15 = Math.abs(c.chg15);
            if (v1 >= botSettings.minVol || v5 >= botSettings.minVol || v15 >= botSettings.minVol) {
                
                addBotLog(`🚀 [TÍN HIỆU] ${c.symbol} (1m:${c.chg1}% 5m:${c.chg5}% 15m:${c.chg15}%)`, "success");
                await clearOrders(c.symbol);

                const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
                const lev = Math.min(20, brackets[0].brackets[0].initialLeverage);
                await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });

                const acc = await callBinance('/fapi/v2/account');
                status.currentBalance = parseFloat(acc.totalMarginBalance);
                const info = status.exchangeInfo[c.symbol];
                const side = (c.chg1 + c.chg5 + c.chg15) > 0 ? 'LONG' : 'SHORT';
                
                let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
                let qty = ( (margin * lev) / c.currentPrice );
                qty = Math.floor(qty / info.stepSize) * info.stepSize;

                await callBinance('/fapi/v1/order', 'POST', {
                    symbol: c.symbol, side: side === 'LONG' ? 'BUY' : 'SELL',
                    positionSide: side, type: 'MARKET', quantity: qty.toFixed(info.quantityPrecision)
                });

                botManagedSymbols.push(c.symbol);
                setTimeout(enforceTPSL, 3000);
            }
        }
    } catch (e) { addBotLog(`Lỗi Hunt: ${JSON.stringify(e)}`, "error"); }
    finally { isProcessing = false; }
}

function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/live', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d); } catch (e) {} });
    }).on('error', () => {});
}

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
            addBotLog("✅ Bot Ready", "success");
        });
    });
}

init();
setInterval(fetchCandidates, 3000);
setInterval(hunt, 2000);
setInterval(cleanupClosedPositions, 5000);
setInterval(enforceTPSL, 10000);

const APP = express();
APP.use(express.json());
APP.get('/api/status', async (req, res) => res.json({ botSettings, status, botManagedSymbols }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ status: "ok" }); });
APP.listen(9001, '0.0.0.0');
