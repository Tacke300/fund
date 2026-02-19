/**
 * LUFFY PIRATE BOT - BẢN 08 (FULL TRÊN MỘT FILE - FIX LỖI NaN PnL)
 * Chế độ: Hedge Mode (Phòng hộ)
 * Chức năng: Tự động đòn bẩy, Mở lệnh Market, Kiểm soát TP/SL 15s/lần, Dọn dẹp lệnh rác.
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

// --- NHẬP KHÓA TỪ CONFIG.JS ---
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

// --- HÀM QUẢN LÝ LOG (CHẶN SPAM KHI DỪNG BOT) ---
function addBotLog(msg, type = 'info') {
    if (!botSettings.isRunning) {
        if (type === 'warn' && !isLoggedStop) {
            isLoggedStop = true;
        } else {
            return; 
        }
    } else {
        isLoggedStop = false; 
    }

    const entry = { time: new Date().toLocaleTimeString(), msg, type };
    status.botLogs.unshift(entry);
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

// --- HÀM GỌI API BINANCE (ĐÃ FIX ĐỐI SỐ) ---
async function callSignedAPI(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    let queryObj = { ...params, timestamp, recvWindow: 5000 };
    let queryString = Object.keys(queryObj)
        .filter(k => queryObj[k] !== undefined && queryObj[k] !== null)
        .map(k => `${k}=${encodeURIComponent(queryObj[k])}`)
        .join('&');

    const signature = crypto.createHmac('sha256', SECRET_KEY).update(queryString).digest('hex');
    queryString += `&signature=${signature}`;
    const url = `https://fapi.binance.com${endpoint}?${queryString}`;

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
                } catch (e) { reject({ msg: "LỖI PHẢN HỒI JSON" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

// --- TÍNH TOÁN GIÁ TP/SL THEO ĐÒN BẨY ---
function getPricePlan(leverage, posSide, entryPrice) {
    let mult = 1.11;
    if (leverage >= 26 && leverage <= 49) mult = 2.22;
    else if (leverage >= 50 && leverage <= 74) mult = 3.33;
    else if (leverage >= 75) mult = 5.55;

    const tpRate = mult / leverage;
    const slRate = (mult * 0.5) / leverage;

    return {
        tp: posSide === 'LONG' ? entryPrice * (1 + tpRate) : entryPrice * (1 - tpRate),
        sl: posSide === 'LONG' ? entryPrice * (1 - slRate) : entryPrice * (1 + slRate),
        multiplierText: (mult * 100).toFixed(0)
    };
}

// --- CƠ CHẾ TUẦN TRA & KIỂM SOÁT TP/SL (15 GIÂY) ---
async function enforceTPSL() {
    if (!botSettings.isRunning) return;
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk');
        const activePos = positions.filter(p => parseFloat(p.positionAmt) !== 0);
        const allOrders = await callSignedAPI('/fapi/v1/openOrders');

        // 1. Dọn dẹp lệnh rác (Có lệnh chờ nhưng không còn vị thế)
        for (const order of allOrders) {
            const hasPosition = activePos.find(p => p.symbol === order.symbol && p.positionSide === order.positionSide);
            if (!hasPosition && (order.type === 'TAKE_PROFIT_MARKET' || order.type === 'STOP_MARKET')) {
                await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: order.symbol, orderId: order.orderId });
                addBotLog(`🧹 Dọn dẹp: Đã hủy lệnh chờ rác của ${order.symbol} [${order.positionSide}]`, "warn");
            }
        }

        // 2. Kiểm tra và bổ sung TP/SL thiếu
        for (const p of activePos) {
            const symbol = p.symbol;
            const posSide = p.positionSide;
            const qty = Math.abs(parseFloat(p.positionAmt));
            const entryPrice = parseFloat(p.entryPrice);
            const leverage = parseFloat(p.leverage);
            const info = status.exchangeInfo[symbol];

            if (!info || entryPrice === 0) continue;

            const posOrders = allOrders.filter(o => o.symbol === symbol && o.positionSide === posSide);
            const hasTP = posOrders.some(o => o.type === 'TAKE_PROFIT_MARKET');
            const hasSL = posOrders.some(o => o.type === 'STOP_MARKET');

            if (!hasTP || !hasSL) {
                const plan = getPricePlan(leverage, posSide, entryPrice);
                const orderSide = posSide === 'LONG' ? 'SELL' : 'BUY';

                if (!hasTP) {
                    await callSignedAPI('/fapi/v1/order', 'POST', {
                        symbol, side: orderSide, positionSide: posSide,
                        type: 'TAKE_PROFIT_MARKET', stopPrice: plan.tp.toFixed(info.pricePrecision),
                        quantity: qty, workingType: 'MARK_PRICE'
                    });
                }
                if (!hasSL) {
                    await callSignedAPI('/fapi/v1/order', 'POST', {
                        symbol, side: orderSide, positionSide: posSide,
                        type: 'STOP_MARKET', stopPrice: plan.sl.toFixed(info.pricePrecision),
                        quantity: qty, workingType: 'MARK_PRICE'
                    });
                }
                addBotLog(`🛡️ Hệ thống: Đã ghim bổ sung TP/SL cho ${symbol} [${posSide}]`, "success");
            }
        }
    } catch (e) { /* Tuần tra thầm lặng */ }
}

// --- VÒNG LẶP ĐI SĂN CHÍNH ---
async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        const acc = await callSignedAPI('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);

        const positions = await callSignedAPI('/fapi/v2/positionRisk');
        const activePos = positions.filter(p => parseFloat(p.positionAmt) !== 0);

        http.get('http://127.0.0.1:9000/api/live', (res) => {
            let rawData = '';
            res.on('data', d => rawData += d);
            res.on('end', async () => {
                try {
                    if (!botSettings.isRunning) return;
                    const allData = JSON.parse(rawData);
                    const candidates = allData.filter(c => Math.abs(c.changePercent) >= botSettings.minVol);

                    for (const cand of candidates) {
                        if (!botSettings.isRunning) break;

                        const posSide = cand.changePercent > 0 ? 'LONG' : 'SHORT';
                        if (activePos.find(p => p.symbol === cand.symbol && p.positionSide === posSide)) continue;
                        if (activePos.length >= botSettings.maxPositions) break;
                        if (tempBlacklist.has(cand.symbol) && Date.now() < tempBlacklist.get(cand.symbol)) continue;

                        try {
                            const info = status.exchangeInfo[cand.symbol];
                            if (!info) continue;

                            // 1. Set Leverage
                            const brackets = await callSignedAPI('/fapi/v1/leverageBracket', { symbol: cand.symbol });
                            const maxLev = brackets[0].brackets[0].initialLeverage;
                            await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol: cand.symbol, leverage: maxLev });

                            // 2. Lấy giá và tính toán vốn
                            const ticker = await callSignedAPI('/fapi/v1/ticker/price', { symbol: cand.symbol });
                            const price = parseFloat(ticker.price);
                            let margin = botSettings.invType === 'fixed' ? botSettings.invValue : (status.currentBalance * botSettings.invValue / 100);
                            
                            const plan = getPricePlan(maxLev, posSide, price);
                            
                            // LOG TỔNG TRƯỚC KHI MỞ
                            addBotLog(`🛠️ Chuẩn bị mở ${posSide} ${cand.symbol}: Vốn $${margin.toFixed(2)}, Lev ${maxLev}x, TP ${plan.multiplierText}%`, "info");

                            // 3. Mở Market
                            let qty = (margin * maxLev) / price;
                            qty = Math.floor(qty / info.stepSize) * info.stepSize;

                            const order = await callSignedAPI('/fapi/v1/order', 'POST', {
                                symbol: cand.symbol, side: posSide === 'LONG' ? 'BUY' : 'SELL',
                                positionSide: posSide, type: 'MARKET', quantity: qty.toFixed(info.quantityPrecision)
                            });

                            addBotLog(`✅ ${cand.symbol} [${posSide}]: Mở lệnh Market thành công!`, "success");

                            // Đợi 5s hậu kiểm
                            setTimeout(enforceTPSL, 5000);

                        } catch (err) {
                            addBotLog(`❌ Lỗi ${cand.symbol}: ${err.msg || "Sàn từ chối lệnh"}`, "error");
                            tempBlacklist.set(cand.symbol, Date.now() + 60000);
                        }
                    }
                } catch (e) {}
            });
        });
    } catch (e) {}
}

// --- SERVER SETUP ---
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk');
        const activePositions = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
            const entryPrice = parseFloat(p.entryPrice);
            const markPrice = parseFloat(p.markPrice);
            const leverage = parseFloat(p.leverage);
            const unrealizedProfit = parseFloat(p.unrealizedProfit);
            const positionAmt = Math.abs(parseFloat(p.positionAmt));

            // FIX LỖI NaN: Kiểm tra các giá trị đầu vào của phép chia
            let pnl = "0.00";
            if (entryPrice > 0 && leverage > 0 && positionAmt > 0) {
                const marginUsed = (entryPrice * positionAmt) / leverage;
                pnl = ((unrealizedProfit / marginUsed) * 100).toFixed(2);
            }

            return {
                symbol: p.symbol,
                side: p.positionSide,
                leverage: p.leverage,
                entryPrice: entryPrice.toFixed(5),
                markPrice: markPrice.toFixed(5),
                pnlPercent: pnl
            };
        });
        res.json({ botSettings, status, activePositions, history: [] });
    } catch (e) { res.status(500).send(); }
});

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    if (!botSettings.isRunning) {
        isLoggedStop = false;
        addBotLog("⚓ HẠ BUỒM! Hạm đội đã dừng quét.", "warn");
    } else {
        addBotLog("🚢 GIƯƠNG BUỒM! Bắt đầu cuộc săn mới.", "success");
    }
    res.sendStatus(200);
});

// --- KHỞI TẠO DỮ LIỆU SÀN ---
async function init() {
    try {
        const res = await new Promise(resolve => https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', r => {
            let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d)));
        }));
        res.symbols.forEach(s => {
            const lF = s.filters.find(f => f.filterType === 'LOT_SIZE');
            status.exchangeInfo[s.symbol] = {
                quantityPrecision: s.quantityPrecision,
                pricePrecision: s.pricePrecision,
                stepSize: parseFloat(lF.stepSize)
            };
        });
        console.log("⚓ Hệ thống dữ liệu sàn đã sẵn sàng.");
    } catch (e) { console.log("Lỗi khởi tạo sàn."); }
}

init();
setInterval(mainLoop, 5000); // Săn kèo mỗi 5s
setInterval(enforceTPSL, 15000); // Tuần tra TP/SL mỗi 15s
APP.listen(9001, '0.0.0.0', () => console.log("Hạm đội Luffy sẵn sàng tại cổng 9001"));
