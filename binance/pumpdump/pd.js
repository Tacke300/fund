import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let botSettings = { isRunning: false, maxPositions: 10, invValue: 1.5, invType: 'fixed', minVol: 5.0, accountSL: 30 };
let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let isInitializing = true;
let isProcessing = false; // Khóa chống dồn dập

function addBotLog(msg, type = 'info') {
    const entry = { time: new Date().toLocaleTimeString(), msg, type };
    status.botLogs.unshift(entry);
    if (status.botLogs.length > 30) status.botLogs.pop();
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
                } catch (e) { reject({ msg: "JSON_ERROR" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

function calcTPSL(lev, side, entryPrice) {
    let m = lev < 26 ? 1.11 : (lev < 50 ? 2.22 : (lev < 75 ? 3.33 : 5.55));
    const rate = m / lev; 
    return {
        tp: side === 'LONG' ? entryPrice * (1 + rate) : entryPrice * (1 - rate),
        sl: side === 'LONG' ? entryPrice * (1 - rate) : entryPrice * (1 + rate)
    };
}

async function enforceTPSL() {
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const active = positions.filter(p => parseFloat(p.positionAmt) !== 0);
        const orders = await callBinance('/fapi/v1/openOrders');

        for (const p of active) {
            const symbol = p.symbol;
            const side = p.positionSide;
            const entry = parseFloat(p.entryPrice);
            if (entry <= 0) continue;

            const hasTP = orders.some(o => o.symbol === symbol && o.positionSide === side && o.type === 'TAKE_PROFIT_MARKET');
            const hasSL = orders.some(o => o.symbol === symbol && o.positionSide === side && o.type === 'STOP_MARKET');

            if (!hasTP || !hasSL) {
                const info = status.exchangeInfo[symbol];
                const plan = calcTPSL(parseFloat(p.leverage), side, entry);
                const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

                if (!hasTP) {
                    await callBinance('/fapi/v1/order', 'POST', {
                        symbol, side: closeSide, positionSide: side, type: 'TAKE_PROFIT_MARKET',
                        stopPrice: plan.tp.toFixed(info.pricePrecision), workingType: 'MARK_PRICE', closePosition: 'true'
                    });
                }
                if (!hasSL) {
                    await callBinance('/fapi/v1/order', 'POST', {
                        symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET',
                        stopPrice: plan.sl.toFixed(info.pricePrecision), workingType: 'MARK_PRICE', closePosition: 'true'
                    });
                }
                addBotLog(`🛡️ Đã cài TP/SL cho ${symbol}`, "success");
            }
        }
    } catch (e) {
        addBotLog(`⚠️ Lỗi khi cài TP/SL: ${e.msg || "API Error"}`, "error");
    }
}

async function hunt() {
    if (isInitializing || !botSettings.isRunning || isProcessing) return;

    try {
        isProcessing = true; // Khóa tiến trình

        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);

        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0);

        // Kiểm tra đúng cấu hình số vị thế tối đa
        if (active.length >= botSettings.maxPositions) {
            isProcessing = false;
            return;
        }

        for (const c of status.candidatesList) {
            if (active.some(p => p.symbol === c.symbol)) continue;
            
            try {
                const info = status.exchangeInfo[c.symbol];
                const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
                const lev = brackets[0].brackets[0].initialLeverage;
                await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });

                const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
                const price = parseFloat(ticker.price);
                const side = c.changePercent > 0 ? 'LONG' : 'SHORT';

                // Giữ nguyên gốc cách tính của bạn
                let rawQty = (botSettings.invValue * lev) / price;
                let qty = Math.floor(rawQty / info.stepSize) * info.stepSize;
                
                if ((qty * price) < 5.0) {
                    qty = Math.ceil(5.1 / price / info.stepSize) * info.stepSize;
                }
                const finalQty = qty.toFixed(info.quantityPrecision);

                // Mở lệnh Market
                await callBinance('/fapi/v1/order', 'POST', { 
                    symbol: c.symbol, side: side === 'LONG' ? 'BUY' : 'SELL', 
                    positionSide: side, type: 'MARKET', quantity: finalQty 
                });
                addBotLog(`🚀 Mở ${side} ${c.symbol}`, "success");

                // Đợi đúng 5s rồi cài TP/SL xong mới làm việc khác
                await new Promise(res => setTimeout(res, 5000));
                await enforceTPSL();

                // Sau khi xong 1 con thì thoát để vòng lặp sau check lại từ đầu
                break;

            } catch (err) {
                addBotLog(`❌ LỖI: ${err.msg || "Sàn từ chối"}. DỪNG BOT ĐỂ KIỂM TRA!`, "error");
                botSettings.isRunning = false; // Dừng bot lập tức nếu có lỗi dồn dập
                break;
            }
        }
    } catch (e) {
    } finally {
        isProcessing = false; // Mở khóa tiến trình
    }
}

function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/live', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const all = JSON.parse(d);
                status.candidatesList = all
                    .filter(c => Math.abs(c.changePercent) >= botSettings.minVol)
                    .sort((a,b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
                    .slice(0, 5);
            } catch (e) {}
        });
    }).on('error', () => {});
}

const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    try {
        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
            const entry = parseFloat(p.entryPrice);
            const amt = Math.abs(parseFloat(p.positionAmt));
            const pnl = (entry > 0) ? ((parseFloat(p.unrealizedProfit) / ((entry * amt) / p.leverage)) * 100).toFixed(2) : "0.00";
            return { symbol: p.symbol, side: p.positionSide, leverage: p.leverage, entryPrice: p.entryPrice, markPrice: p.markPrice, pnlPercent: pnl };
        });
        res.json({ botSettings, status, activePositions: active, history: [] });
    } catch (e) { res.status(500).send(); }
});

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    addBotLog("⚙️ Đã cập nhật cấu hình", "info");
    res.json({ status: "ok" });
});

async function init() {
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
            try {
                JSON.parse(d).symbols.forEach(s => {
                    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
                    status.exchangeInfo[s.symbol] = { 
                        quantityPrecision: s.quantityPrecision, 
                        pricePrecision: s.pricePrecision, 
                        stepSize: parseFloat(lot.stepSize) 
                    };
                });
                isInitializing = false;
                addBotLog("✅ HỆ THỐNG SẴN SÀNG", "success");
            } catch (e) {}
        });
    });
}

init();
setInterval(fetchCandidates, 3000);
setInterval(hunt, 2000); // Quét nhanh nhưng bị chặn bởi isProcessing
setInterval(enforceTPSL, 10000); // Quét bù bảo vệ
APP.listen(9001, '0.0.0.0');
