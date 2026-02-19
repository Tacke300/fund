/**
 * LUFFY PIRATE BOT - BẢN 09 (FIXED ERR_INVALID_ARG_TYPE & DNS)
 * Chế độ: Hedge Mode (Phòng hộ)
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

let botSettings = {
    isRunning: false,
    maxPositions: 10,
    invValue: 1.5,
    invType: 'fixed', 
    minVol: 5.0,
    accountSLValue: 30
};

let status = {
    currentBalance: 0,
    botLogs: [],
    candidatesList: [],
    exchangeInfo: {}
};

let tempBlacklist = new Map();
let isLoggedStop = true;

function addBotLog(msg, type = 'info') {
    if (!botSettings.isRunning && type !== 'warn' && type !== 'error') return;
    const entry = { time: new Date().toLocaleTimeString(), msg, type };
    status.botLogs.unshift(entry);
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

// --- HÀM GỌI API BINANCE (FIX CHẶT ARGUMENTS) ---
async function callSignedAPI(endpoint, method = 'GET', params = {}) {
    return new Promise((resolve, reject) => {
        const timestamp = Date.now();
        let queryObj = { ...params, timestamp, recvWindow: 5000 };
        
        // Loại bỏ các tham số undefined/null để tránh lỗi truyền tham số cho crypto
        let queryString = Object.keys(queryObj)
            .filter(k => queryObj[k] !== undefined && queryObj[k] !== null)
            .map(k => `${k}=${encodeURIComponent(queryObj[k])}`)
            .join('&');

        const signature = crypto.createHmac('sha256', SECRET_KEY).update(queryString).digest('hex');
        queryString += `&signature=${signature}`;
        
        const options = {
            hostname: 'fapi.binance.com',
            port: 443,
            path: `${endpoint}?${queryString}`,
            method: method,
            headers: { 'X-MBX-APIKEY': API_KEY },
            timeout: 10000 // Thêm timeout tránh treo lệnh
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
                    else reject({ code: json.code, msg: json.msg });
                } catch (e) { reject({ msg: "JSON_PARSE_ERROR" }); }
            });
        });

        req.on('error', e => reject({ msg: e.message, code: e.code }));
        req.on('timeout', () => { req.destroy(); reject({ msg: "API_TIMEOUT" }); });
        req.end();
    });
}

function getPricePlan(leverage, posSide, entryPrice) {
    const lev = parseFloat(leverage) || 20;
    const price = parseFloat(entryPrice);
    if (!price) return null;

    let mult = 1.11;
    if (lev >= 26 && lev <= 49) mult = 2.22;
    else if (lev >= 50 && lev <= 74) mult = 3.33;
    else if (lev >= 75) mult = 5.55;

    const tpRate = mult / lev;
    const slRate = (mult * 0.5) / lev;

    return {
        tp: posSide === 'LONG' ? price * (1 + tpRate) : price * (1 - tpRate),
        sl: posSide === 'LONG' ? price * (1 - slRate) : price * (1 + slRate),
        multiplierText: (mult * 100).toFixed(0)
    };
}

async function enforceTPSL() {
    if (!botSettings.isRunning) return;
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk');
        const activePos = positions.filter(p => parseFloat(p.positionAmt) !== 0);
        const allOrders = await callSignedAPI('/fapi/v1/openOrders');

        for (const order of allOrders) {
            const hasPosition = activePos.find(p => p.symbol === order.symbol && p.positionSide === order.positionSide);
            if (!hasPosition && (order.type.includes('MARKET'))) {
                await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: order.symbol, orderId: order.orderId });
                addBotLog(`🧹 Hủy lệnh rác: ${order.symbol}`, "warn");
            }
        }

        for (const p of activePos) {
            const info = status.exchangeInfo[p.symbol];
            if (!info || parseFloat(p.entryPrice) === 0) continue;

            const posOrders = allOrders.filter(o => o.symbol === p.symbol && o.positionSide === p.positionSide);
            const hasTP = posOrders.some(o => o.type === 'TAKE_PROFIT_MARKET');
            const hasSL = posOrders.some(o => o.type === 'STOP_MARKET');

            if (!hasTP || !hasSL) {
                const plan = getPricePlan(p.leverage, p.positionSide, p.entryPrice);
                if (!plan) continue;
                const side = p.positionSide === 'LONG' ? 'SELL' : 'BUY';

                if (!hasTP) {
                    await callSignedAPI('/fapi/v1/order', 'POST', {
                        symbol: p.symbol, side, positionSide: p.positionSide,
                        type: 'TAKE_PROFIT_MARKET', stopPrice: plan.tp.toFixed(info.pricePrecision),
                        quantity: Math.abs(parseFloat(p.positionAmt)), workingType: 'MARK_PRICE'
                    });
                }
                if (!hasSL) {
                    await callSignedAPI('/fapi/v1/order', 'POST', {
                        symbol: p.symbol, side, positionSide: p.positionSide,
                        type: 'STOP_MARKET', stopPrice: plan.sl.toFixed(info.pricePrecision),
                        quantity: Math.abs(parseFloat(p.positionAmt)), workingType: 'MARK_PRICE'
                    });
                }
                addBotLog(`🛡️ Ghim TP/SL: ${p.symbol}`, "success");
            }
        }
    } catch (e) {}
}

async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        const acc = await callSignedAPI('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);

        http.get('http://127.0.0.1:9000/api/live', (res) => {
            let rawData = '';
            res.on('data', d => rawData += d);
            res.on('end', async () => {
                try {
                    const allData = JSON.parse(rawData);
                    const candidates = allData.filter(c => Math.abs(c.changePercent) >= botSettings.minVol);
                    const positions = await callSignedAPI('/fapi/v2/positionRisk');
                    const activePos = positions.filter(p => parseFloat(p.positionAmt) !== 0);

                    for (const cand of candidates) {
                        if (activePos.length >= botSettings.maxPositions) break;
                        const posSide = cand.changePercent > 0 ? 'LONG' : 'SHORT';
                        if (activePos.find(p => p.symbol === cand.symbol && p.positionSide === posSide)) continue;
                        if (tempBlacklist.has(cand.symbol) && Date.now() < tempBlacklist.get(cand.symbol)) continue;

                        try {
                            const info = status.exchangeInfo[cand.symbol];
                            if (!info) continue;

                            const brackets = await callSignedAPI('/fapi/v1/leverageBracket', { symbol: cand.symbol });
                            const maxLev = brackets[0].brackets[0].initialLeverage;
                            await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol: cand.symbol, leverage: maxLev });

                            const ticker = await callSignedAPI('/fapi/v1/ticker/price', { symbol: cand.symbol });
                            const price = parseFloat(ticker.price);
                            const margin = botSettings.invType === 'fixed' ? botSettings.invValue : (status.currentBalance * botSettings.invValue / 100);
                            
                            if ((margin * maxLev) < 5.5) continue;

                            let qty = (margin * maxLev) / price;
                            qty = Math.floor(qty / info.stepSize) * info.stepSize;
                            const qtyStr = qty.toFixed(info.quantityPrecision);

                            // CHỐT CHẶN CUỐI: Kiểm tra tham số trước khi gọi API
                            if (isNaN(qty) || qty <= 0) throw { msg: "Số lượng (QTY) không hợp lệ" };

                            await callSignedAPI('/fapi/v1/order', 'POST', {
                                symbol: cand.symbol, side: (posSide === 'LONG' ? 'BUY' : 'SELL'),
                                positionSide: posSide, type: 'MARKET', quantity: qtyStr
                            });

                            addBotLog(`✅ Mở ${posSide} ${cand.symbol}`, "success");
                            setTimeout(enforceTPSL, 3000);
                        } catch (err) {
                            let reason = err.msg || "Lỗi không xác định";
                            if (err.code === -2019) reason = "Hết tiền";
                            if (err.code === 'ENOTFOUND') reason = "Lỗi mạng/DNS Sàn";
                            addBotLog(`❌ ${cand.symbol}: ${reason}`, "error");
                            tempBlacklist.set(cand.symbol, Date.now() + 30000);
                        }
                    }
                } catch (e) {}
            });
        }).on('error', () => {});
    } catch (e) {}
}

// --- SETUP SERVER ---
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk');
        const activePositions = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
            const entry = parseFloat(p.entryPrice);
            const mark = parseFloat(p.markPrice);
            const amt = Math.abs(parseFloat(p.positionAmt));
            const lev = parseFloat(p.leverage);
            const pnl = (entry > 0) ? ((parseFloat(p.unrealizedProfit) / ((entry * amt) / lev)) * 100).toFixed(2) : "0.00";
            return { symbol: p.symbol, side: p.positionSide, leverage: p.leverage, entryPrice: entry.toFixed(5), markPrice: mark.toFixed(5), pnlPercent: pnl };
        });
        res.json({ botSettings, status, activePositions });
    } catch (e) { res.status(500).send(); }
});

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    addBotLog(botSettings.isRunning ? "🚢 GIƯƠNG BUỒM!" : "⚓ HẠ BUỒM!", botSettings.isRunning ? "success" : "warn");
    res.sendStatus(200);
});

async function init() {
    try {
        const res = await new Promise((resolve, reject) => {
            https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', r => {
                let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d)));
            }).on('error', reject);
        });
        res.symbols.forEach(s => {
            const lF = s.filters.find(f => f.filterType === 'LOT_SIZE');
            status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lF.stepSize) };
        });
        console.log("⚓ Dữ liệu sàn OK.");
    } catch (e) { console.log("Lỗi khởi tạo. Kiểm tra mạng!"); }
}

init();
setInterval(mainLoop, 5000);
setInterval(enforceTPSL, 15000);
APP.listen(9001, '0.0.0.0', () => console.log("Luffy Pirate sẵn sàng tại cổng 9001"));
