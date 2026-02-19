/**
 * LUFFY PIRATE BOT - BẢN SỬA 06 (FIX LOG & FIX ARG TYPE)
 */
import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { API_KEY, SECRET_KEY } from './config.js';

let botSettings = { isRunning: false, maxPositions: 10, invValue: 1.5, invType: 'fixed', minVol: 5.0 };
let status = { currentBalance: 0, botLogs: [], exchangeInfo: {} };
let tempBlacklist = new Map();
let isLoggedStop = true; // Cờ chặn log hạ buồm lặp lại

// --- QUẢN LÝ LOG (CHẶN TUYỆT ĐỐI KHI DỪNG) ---
function addBotLog(msg, type = 'info') {
    if (!botSettings.isRunning) {
        if (type === 'warn' && !isLoggedStop) {
            // Chỉ cho phép log "Hạ buồm" đúng 1 lần
            isLoggedStop = true;
        } else {
            return; // Dừng hẳn, không log thêm gì nữa
        }
    } else {
        isLoggedStop = false; // Reset cờ khi bắt đầu chạy lại
    }

    const entry = { time: new Date().toLocaleTimeString(), msg, type };
    status.botLogs.unshift(entry);
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

// --- FIX LỖI ERR_INVALID_ARG_TYPE ---
async function callSignedAPI(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    // Đảm bảo params là Object và không chứa giá trị null/undefined
    let queryObj = { ...params, timestamp, recvWindow: 5000 };
    let queryString = Object.keys(queryObj)
        .filter(k => queryObj[k] !== undefined && queryObj[k] !== null)
        .map(k => `${k}=${encodeURIComponent(queryObj[k])}`)
        .join('&');

    const signature = crypto.createHmac('sha256', SECRET_KEY).update(queryString).digest('hex');
    queryString += `&signature=${signature}`;
    
    const url = `https://fapi.binance.com${endpoint}${queryString ? '?' + queryString : ''}`;

    return new Promise((resolve, reject) => {
        const options = { method, headers: { 'X-MBX-APIKEY': API_KEY } };
        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
                    else reject(json);
                } catch (e) { reject({ msg: "JSON_ERROR" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

function getTradePlan(leverage, side, price) {
    let multiplier = leverage < 26 ? 1.11 : (leverage < 50 ? 2.22 : (leverage < 75 ? 3.33 : 5.55));
    const tpRate = multiplier / leverage;
    const slRate = (multiplier * 0.5) / leverage;
    return {
        multiplier,
        tpPrice: side === 'LONG' ? price * (1 + tpRate) : price * (1 - tpRate),
        slPrice: side === 'LONG' ? price * (1 - slRate) : price * (1 + slRate),
        tpRate
    };
}

async function mainLoop() {
    if (!botSettings.isRunning) return;

    try {
        const acc = await callSignedAPI('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        const positions = await callSignedAPI('/fapi/v2/positionRisk');
        const activePos = positions.filter(p => parseFloat(p.positionAmt) !== 0);

        http.get('http://127.0.0.1:9000/api/live', (res) => {
            let data = ''; res.on('data', d => data += d);
            res.on('end', async () => {
                try {
                    if (!botSettings.isRunning) return;
                    const candidates = JSON.parse(data).filter(c => Math.abs(c.changePercent) >= botSettings.minVol);
                    
                    for (const cand of candidates) {
                        if (!botSettings.isRunning) break;
                        const posSide = cand.changePercent > 0 ? 'LONG' : 'SHORT';
                        const tradeSide = cand.changePercent > 0 ? 'BUY' : 'SELL';

                        if (activePos.find(p => p.symbol === cand.symbol && p.positionSide === posSide)) continue;
                        if (activePos.length >= botSettings.maxPositions) break;
                        if (tempBlacklist.has(cand.symbol) && Date.now() < tempBlacklist.get(cand.symbol)) continue;

                        try {
                            const info = status.exchangeInfo[cand.symbol];
                            const brackets = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol: cand.symbol });
                            const maxLev = brackets[0].brackets[0].initialLeverage;
                            await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol: cand.symbol, leverage: maxLev });

                            const ticker = await callSignedAPI('/fapi/v1/ticker/price', 'GET', { symbol: cand.symbol });
                            const price = parseFloat(ticker.price);
                            let margin = botSettings.invType === 'fixed' ? botSettings.invValue : (status.currentBalance * botSettings.invValue / 100);
                            const plan = getTradePlan(maxLev, posSide, price);

                            addBotLog(`🛠 Mở ${posSide} ${cand.symbol}: Lev ${maxLev}x | Vốn $${margin.toFixed(2)} | TP ${(plan.multiplier*100).toFixed(0)}%`, "info");

                            let qty = (margin * maxLev) / price;
                            qty = Math.floor(qty / info.stepSize) * info.stepSize;

                            const order = await callSignedAPI('/fapi/v1/order', 'POST', {
                                symbol: cand.symbol, side: tradeSide, positionSide: posSide, type: 'MARKET', quantity: qty.toFixed(info.quantityPrecision)
                            });

                            addBotLog(`✅ ${cand.symbol}: Mở Market thành công!`, "success");

                            setTimeout(async () => {
                                if (!botSettings.isRunning) return;
                                try {
                                    const entry = parseFloat(order.avgPrice);
                                    const tpP = posSide === 'LONG' ? entry * (1 + plan.tpRate) : entry * (1 - plan.tpRate);
                                    const slP = posSide === 'LONG' ? entry * (1 - (plan.tpRate*0.5)) : entry * (1 + (plan.tpRate*0.5));

                                    await callSignedAPI('/fapi/v1/order', 'POST', {
                                        symbol: cand.symbol, side: tradeSide==='BUY'?'SELL':'BUY', positionSide: posSide,
                                        type: 'TAKE_PROFIT_MARKET', stopPrice: tpP.toFixed(info.pricePrecision), closePosition: 'true'
                                    });
                                    await callSignedAPI('/fapi/v1/order', 'POST', {
                                        symbol: cand.symbol, side: tradeSide==='BUY'?'SELL':'BUY', positionSide: posSide,
                                        type: 'STOP_MARKET', stopPrice: slP.toFixed(info.pricePrecision), closePosition: 'true'
                                    });
                                    addBotLog(`🎯 ${cand.symbol}: Đã ghim TP/SL vị thế.`, "success");
                                } catch (e) {}
                            }, 5000);
                        } catch (err) {
                            addBotLog(`❌ Lỗi ${cand.symbol}: ${JSON.stringify(err)}`, "error");
                            tempBlacklist.set(cand.symbol, Date.now() + 60000);
                        }
                    }
                } catch (e) {}
            });
        });
    } catch (e) {}
}

const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));
APP.get('/api/status', async (req, res) => {
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk');
        const activePositions = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => ({
            symbol: p.symbol, side: p.positionSide, leverage: p.leverage, entryPrice: p.entryPrice, markPrice: p.markPrice,
            pnlPercent: ((parseFloat(p.unrealizedProfit) / ((parseFloat(p.entryPrice) * Math.abs(parseFloat(p.positionAmt))) / parseFloat(p.leverage))) * 100).toFixed(2)
        }));
        res.json({ botSettings, status, activePositions, history: [] });
    } catch (e) { res.status(500).json({ error: "ERR" }); }
});
APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    if (!botSettings.isRunning) {
        isLoggedStop = false; // Reset cờ để addBotLog cho phép ghi 1 dòng warn
        addBotLog("⚓ HẠ BUỒM! Đã dừng hạm đội.", "warn");
    } else {
        addBotLog("🚢 GIƯƠNG BUỒM! Đi săn thôi.", "success");
    }
    res.sendStatus(200);
});

async function init() {
    try {
        const res = await new Promise(resolve => https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', r => {
            let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d)));
        }));
        res.symbols.forEach(s => {
            const pF = s.filters.find(f => f.filterType === 'PRICE_FILTER');
            const lF = s.filters.find(f => f.filterType === 'LOT_SIZE');
            status.exchangeInfo[s.symbol] = {
                pricePrecision: s.pricePrecision, quantityPrecision: s.quantityPrecision,
                stepSize: parseFloat(lF.stepSize), pricePrecision: s.pricePrecision
            };
        });
        console.log("⚓ Dữ liệu sàn OK");
    } catch (e) {}
}

init();
setInterval(mainLoop, 5000);
APP.listen(9001, '0.0.0.0');
