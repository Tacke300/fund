// --- BẢN SỬA BOT 03 (SERVER SIDE) ---
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
    accountSLValue: 30, // SL Tổng vẫn giữ nguyên
};

let status = { currentBalance: 0, botLogs: [], candidatesList: [], exchangeInfo: {} };
let tempBlacklist = new Map();

function addBotLog(msg, type = 'info') {
    const entry = { time: new Date().toLocaleTimeString(), msg, type };
    status.botLogs.unshift(entry);
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

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
                } catch (e) { reject({ msg: "JSON Error" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

// Hàm tính % TP/SL theo đòn bẩy (Dựa trên vốn Margin)
function getTPSLSettings(leverage) {
    let multiplier = 1.11; // Mặc định < 26 là 111%
    if (leverage >= 26 && leverage <= 49) multiplier = 2.22;
    else if (leverage >= 50 && leverage <= 74) multiplier = 3.33;
    else if (leverage >= 75) multiplier = 5.55;
    
    // SL vị thế tôi để mặc định bằng 1/2 TP hoặc ông có thể chỉnh tùy ý
    // Ở đây tính % biến động giá thực tế = (Multiplier / Leverage)
    return {
        tpRate: multiplier / leverage,
        slRate: (multiplier * 0.5) / leverage // Ví dụ SL bằng 1/2 TP
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
                    const candidates = JSON.parse(data).filter(c => Math.abs(c.changePercent) >= botSettings.minVol);
                    for (const cand of candidates) {
                        if (activePos.find(p => p.symbol === cand.symbol)) continue;
                        if (activePos.length >= botSettings.maxPositions) break;
                        if (tempBlacklist.has(cand.symbol) && Date.now() < tempBlacklist.get(cand.symbol)) continue;

                        try {
                            // BƯỚC 1: SET LEVERAGE
                            const brackets = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol: cand.symbol });
                            const maxLev = brackets[0].brackets[0].initialLeverage;
                            await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol: cand.symbol, leverage: maxLev });
                            addBotLog(`${cand.symbol}: Đã cài đòn bẩy ${maxLev}x`, "info");

                            // BƯỚC 2: TÍNH TOÁN QTY
                            const priceRes = await callSignedAPI('/fapi/v1/ticker/price', 'GET', { symbol: cand.symbol });
                            const price = parseFloat(priceRes.price);
                            let margin = botSettings.invType === 'fixed' ? botSettings.invValue : (status.currentBalance * botSettings.invValue / 100);
                            
                            // Lấy thông tin độ chính xác từ exchangeInfo
                            const info = status.exchangeInfo[cand.symbol] || { stepSize: 0.001, quantityPrecision: 3, pricePrecision: 2 };
                            let qty = (margin * maxLev) / price;
                            qty = Math.floor(qty / info.stepSize) * info.stepSize;

                            // BƯỚC 3: MỞ LỆNH MARKET
                            const side = cand.changePercent > 0 ? 'BUY' : 'SELL';
                            addBotLog(`${cand.symbol}: Đang cài lệnh Market ${side}...`, "info");
                            const order = await callSignedAPI('/fapi/v1/order', 'POST', {
                                symbol: cand.symbol, side: side, type: 'MARKET', quantity: qty.toFixed(info.quantityPrecision)
                            });
                            addBotLog(`✅ ${cand.symbol}: Mở lệnh THÀNH CÔNG tại giá ${order.avgPrice}`, "success");

                            // BƯỚC 4: ĐỢI 5 GIÂY RỒI CÀI TP/SL
                            setTimeout(async () => {
                                try {
                                    const entryPrice = parseFloat(order.avgPrice);
                                    const { tpRate, slRate } = getTPSLSettings(maxLev);
                                    
                                    const tpPrice = side === 'BUY' ? entryPrice * (1 + tpRate) : entryPrice * (1 - tpRate);
                                    const slPrice = side === 'BUY' ? entryPrice * (1 - slRate) : entryPrice * (1 + slRate);

                                    // Đặt lệnh TP
                                    await callSignedAPI('/fapi/v1/order', 'POST', {
                                        symbol: cand.symbol, side: side === 'BUY' ? 'SELL' : 'BUY',
                                        type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice.toFixed(info.pricePrecision), closePosition: 'true'
                                    });
                                    // Đặt lệnh SL
                                    await callSignedAPI('/fapi/v1/order', 'POST', {
                                        symbol: cand.symbol, side: side === 'BUY' ? 'SELL' : 'BUY',
                                        type: 'STOP_MARKET', stopPrice: slPrice.toFixed(info.pricePrecision), closePosition: 'true'
                                    });
                                    addBotLog(`🎯 ${cand.symbol}: Đã cài TP/SL vị thế (${(tpRate*maxLev*100).toFixed(0)}% vốn)`, "success");
                                } catch (e) { addBotLog(`Lỗi cài TP/SL cho ${cand.symbol}`, "error"); }
                            }, 5000);

                        } catch (err) {
                            addBotLog(`❌ Lỗi ${cand.symbol}: ${err.msg || "API Error"}`, "error");
                            tempBlacklist.set(cand.symbol, Date.now() + 60000); // Chặn 1 phút nếu lỗi
                        }
                    }
                } catch (e) {}
            });
        });
    } catch (e) {}
}

// --- SERVER SETUP (9001) ---
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));
APP.get('/api/status', async (req, res) => {
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk');
        const activePositions = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => ({
            symbol: p.symbol, side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
            leverage: p.leverage, entryPrice: p.entryPrice, markPrice: p.markPrice,
            pnlPercent: ((parseFloat(p.unrealizedProfit) / ((parseFloat(p.entryPrice) * Math.abs(parseFloat(p.positionAmt))) / parseFloat(p.leverage))) * 100).toFixed(2)
        }));
        res.json({ botSettings, status, activePositions, history: [] });
    } catch (e) { res.status(500).send(); }
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.sendStatus(200); });

// Khởi tạo Exchange Info
async function init() {
    try {
        const res = await new Promise(resolve => https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', r => {
            let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d)));
        }));
        res.symbols.forEach(s => {
            const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');
            const lotFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
            status.exchangeInfo[s.symbol] = {
                pricePrecision: s.pricePrecision, quantityPrecision: s.quantityPrecision,
                tickSize: parseFloat(priceFilter.tickSize), stepSize: parseFloat(lotFilter.stepSize)
            };
        });
        console.log("⚓ Hệ thống dữ liệu sàn đã sẵn sàng");
    } catch (e) { console.log("Lỗi khởi tạo"); }
}

init();
setInterval(mainLoop, 10000);
APP.listen(9001, '0.0.0.0');
