/**
 * LUFFY PIRATE BOT - BẢN SỬA 05 (FULL CODE)
 * Chế độ: Hedge Mode (Phòng hộ)
 * Tính năng: TP/SL theo đòn bẩy, Delay 5s, Dừng tuyệt đối khi hạ buồm.
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

// --- CẤU HÌNH ---
import { API_KEY, SECRET_KEY } from './config.js';

let botSettings = {
    isRunning: false,
    maxPositions: 10,
    invValue: 1.5,
    invType: 'fixed', 
    minVol: 5.0,
    accountSLValue: 30, // SL Tổng tài khoản
};

let status = {
    currentBalance: 0,
    botLogs: [],
    candidatesList: [],
    exchangeInfo: {}
};

let tempBlacklist = new Map();

// --- QUẢN LÝ LOG (CHẶN LOG KHI DỪNG BOT) ---
function addBotLog(msg, type = 'info') {
    // Nếu Bot đang dừng thì không ghi thêm bất cứ Log nào vào hệ thống
    if (!botSettings.isRunning && type !== 'warn' && type !== 'success') return;

    const entry = { time: new Date().toLocaleTimeString(), msg, type };
    status.botLogs.unshift(entry);
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

// --- HÀM GỌI API BINANCE ---
async function callSignedAPI(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    let queryString = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=5000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(queryString).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${queryString}&signature=${signature}`;

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
                } catch (e) { reject({ msg: "Lỗi định dạng JSON từ sàn" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

// --- TÍNH TOÁN TP/SL THEO ĐÒN BẨY ---
function getTradePlan(leverage, side, price) {
    let multiplier = 1.11;
    if (leverage >= 26 && leverage <= 49) multiplier = 2.22;
    else if (leverage >= 50 && leverage <= 74) multiplier = 3.33;
    else if (leverage >= 75) multiplier = 5.55;

    const tpRate = multiplier / leverage;
    const slRate = (multiplier * 0.5) / leverage; // SL mặc định 50% mức lãi

    const tpPrice = side === 'LONG' ? price * (1 + tpRate) : price * (1 - tpRate);
    const slPrice = side === 'LONG' ? price * (1 - slRate) : price * (1 + slRate);

    return { multiplier, tpPrice, slPrice, tpRate };
}

// --- VÒNG LẶP CHÍNH ---
async function mainLoop() {
    // Chốt chặn 1: Dừng ngay lập tức nếu isRunning = false
    if (!botSettings.isRunning) return;

    try {
        const acc = await callSignedAPI('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);

        const positions = await callSignedAPI('/fapi/v2/positionRisk');
        const activePos = positions.filter(p => parseFloat(p.positionAmt) !== 0);

        // Chốt chặn 2: Kiểm tra lại trước khi quét SVPD
        if (!botSettings.isRunning) return;

        http.get('http://127.0.0.1:9000/api/live', (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', async () => {
                try {
                    if (!botSettings.isRunning) return; // Chốt chặn 3

                    const allCoins = JSON.parse(data);
                    status.candidatesList = allCoins
                        .filter(c => Math.abs(c.changePercent) >= botSettings.minVol)
                        .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
                        .slice(0, 8);

                    for (const cand of status.candidatesList) {
                        if (!botSettings.isRunning) break; // Chốt chặn 4

                        const posSide = cand.changePercent > 0 ? 'LONG' : 'SHORT';
                        const tradeSide = cand.changePercent > 0 ? 'BUY' : 'SELL';

                        // Kiểm tra xem vị thế này đã mở chưa (Hedge Mode)
                        if (activePos.find(p => p.symbol === cand.symbol && p.positionSide === posSide)) continue;
                        if (activePos.length >= botSettings.maxPositions) break;
                        if (tempBlacklist.has(cand.symbol) && Date.now() < tempBlacklist.get(cand.symbol)) continue;

                        try {
                            const info = status.exchangeInfo[cand.symbol];
                            if (!info) continue;

                            // 1. Cài đòn bẩy
                            const brackets = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol: cand.symbol });
                            const maxLev = brackets[0].brackets[0].initialLeverage;
                            await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol: cand.symbol, leverage: maxLev });

                            // 2. Lấy giá và tính toán
                            const ticker = await callSignedAPI('/fapi/v1/ticker/price', { symbol: cand.symbol });
                            const price = parseFloat(ticker.price);
                            let margin = botSettings.invType === 'fixed' ? botSettings.invValue : (status.currentBalance * botSettings.invValue / 100);
                            
                            const plan = getTradePlan(maxLev, posSide, price);

                            // LOG TỔNG THỰC TẾ
                            addBotLog(`🛠 Mở ${posSide} ${cand.symbol}: Lev ${maxLev}x | Vốn $${margin.toFixed(2)} | TP ${(plan.multiplier*100).toFixed(0)}% | SL ${(plan.multiplier*50).toFixed(0)}%`, "info");

                            // 3. Mở lệnh Market
                            let qty = (margin * maxLev) / price;
                            qty = Math.floor(qty / info.stepSize) * info.stepSize;

                            const order = await callSignedAPI('/fapi/v1/order', 'POST', {
                                symbol: cand.symbol,
                                side: tradeSide,
                                positionSide: posSide,
                                type: 'MARKET',
                                quantity: qty.toFixed(info.quantityPrecision)
                            });

                            addBotLog(`✅ ${cand.symbol}: Đã mở lệnh Market thành công!`, "success");

                            // 4. Delay 5s đặt TP/SL (Có chốt chặn dừng bot)
                            setTimeout(async () => {
                                if (!botSettings.isRunning) return; // Không đặt TP/SL nếu đã hạ buồm

                                try {
                                    const entryPrice = parseFloat(order.avgPrice);
                                    const finalTP = posSide === 'LONG' ? entryPrice * (1 + plan.tpRate) : entryPrice * (1 - plan.tpRate);
                                    const finalSL = posSide === 'LONG' ? entryPrice * (1 - (plan.tpRate*0.5)) : entryPrice * (1 + (plan.tpRate*0.5));

                                    // Đặt TP
                                    await callSignedAPI('/fapi/v1/order', 'POST', {
                                        symbol: cand.symbol,
                                        side: tradeSide === 'BUY' ? 'SELL' : 'BUY',
                                        positionSide: posSide,
                                        type: 'TAKE_PROFIT_MARKET',
                                        stopPrice: finalTP.toFixed(info.pricePrecision),
                                        closePosition: 'true'
                                    });

                                    // Đặt SL
                                    await callSignedAPI('/fapi/v1/order', 'POST', {
                                        symbol: cand.symbol,
                                        side: tradeSide === 'BUY' ? 'SELL' : 'BUY',
                                        positionSide: posSide,
                                        type: 'STOP_MARKET',
                                        stopPrice: finalSL.toFixed(info.pricePrecision),
                                        closePosition: 'true'
                                    });

                                    addBotLog(`🎯 ${cand.symbol}: Đã ghim TP/SL vị thế lên sàn.`, "success");
                                } catch (errTP) {
                                    addBotLog(`❌ Lỗi cài TP/SL ${cand.symbol}: ${errTP.msg || "Sàn từ chối"}`, "error");
                                }
                            }, 5000);

                        } catch (err) {
                            addBotLog(`❌ Lỗi ${cand.symbol}: ${err.msg || JSON.stringify(err)}`, "error");
                            tempBlacklist.set(cand.symbol, Date.now() + 60000);
                        }
                    }
                } catch (e) {}
            });
        });
    } catch (e) {
        addBotLog("Lỗi hệ thống: " + (e.msg || "Mất kết nối"), "error");
    }
}

// --- WEB SERVER ---
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk');
        const activePositions = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => ({
            symbol: p.symbol,
            side: p.positionSide,
            leverage: p.leverage,
            entryPrice: parseFloat(p.entryPrice).toFixed(5),
            markPrice: parseFloat(p.markPrice).toFixed(5),
            pnlPercent: ((parseFloat(p.unrealizedProfit) / ((parseFloat(p.entryPrice) * Math.abs(parseFloat(p.positionAmt))) / parseFloat(p.leverage))) * 100).toFixed(2)
        }));
        res.json({ botSettings, status, activePositions, history: [] });
    } catch (e) { res.status(500).json({ error: "API Timeout" }); }
});

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    if (!botSettings.isRunning) {
        addBotLog("⚓ HẠ BUỒM! Đã dừng mọi hoạt động quét lệnh.", "warn");
    } else {
        addBotLog("🚢 GIƯƠNG BUỒM! Bắt đầu đi săn...", "success");
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
                pricePrecision: s.pricePrecision,
                quantityPrecision: s.quantityPrecision,
                stepSize: parseFloat(lF.stepSize)
            };
        });
        console.log("⚓ Hệ thống dữ liệu sàn đã sẵn sàng");
    } catch (e) { console.log("Lỗi khởi tạo sàn"); }
}

init();
setInterval(mainLoop, 4000); // Quét mỗi 4 giây
APP.listen(9001, '0.0.0.0', () => console.log("Bot chạy tại cổng 9001"));
