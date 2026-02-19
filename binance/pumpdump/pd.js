import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cấu hình đồng bộ với HTML
let botSettings = { isRunning: false, maxPositions: 10, invValue: 1.5, invType: 'fixed', minVol: 5.0, accountSL: 30 };
let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let isInitializing = true;

function addBotLog(msg, type = 'info') {
    const entry = { time: new Date().toLocaleTimeString(), msg, type };
    status.botLogs.unshift(entry);
    if (status.botLogs.length > 50) status.botLogs.pop();
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
                } catch (e) { reject({ msg: "Sàn trả về data lỗi hoặc JSON hỏng" }); }
            });
        });
        req.on('error', e => reject({ msg: "Lỗi kết nối mạng: " + e.message }));
        req.end();
    });
}

function calcTPSL(lev, side, entryPrice) {
    let m = lev < 26 ? 1.11 : (lev < 50 ? 2.22 : (lev < 75 ? 3.33 : 5.55));
    const tpR = m / lev; const slR = (m * 0.5) / lev;
    return {
        tp: side === 'LONG' ? entryPrice * (1 + tpR) : entryPrice * (1 - tpR),
        sl: side === 'LONG' ? entryPrice * (1 - slR) : entryPrice * (1 + slR)
    };
}

// THIẾT LẬP TP/SL SAU 5 GIÂY - KHÔNG GỬI QUANTITY
async function enforceTPSL() {
    if (!botSettings.isRunning) return;
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
                addBotLog(`🛡️ [CÀI TP/SL] Đã ghim cho ${symbol} giá gốc ${entry}`, "success");
            }
        }
    } catch (e) {
        addBotLog(`⚠️ [LỖI TP/SL] ${e.msg || "Không xác định"}`, "error");
    }
}

async function hunt() {
    if (isInitializing) return;
    try {
        // Cập nhật số dư cho UI
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);

        if (!botSettings.isRunning) return;

        // Kiểm tra số lệnh hiện tại
        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0);
        
        if (active.length >= botSettings.maxPositions) {
            // Chỉ log 1 lần khi đầy hạm đội để tránh spam
            return;
        }

        // Duyệt danh sách kèo từ Radar
        for (const c of status.candidatesList) {
            if (!botSettings.isRunning) break;
            const side = c.changePercent > 0 ? 'LONG' : 'SHORT';
            
            // Nếu đã có vị thế coin này rồi thì bỏ qua
            if (active.some(p => p.symbol === c.symbol && p.positionSide === side)) continue;
            
            addBotLog(`🔍 [PHÁT HIỆN] Thấy kèo ${c.symbol} (${c.changePercent}%). Đang mở lệnh...`, "info");

            try {
                const info = status.exchangeInfo[c.symbol];
                // Lấy đòn bẩy tối đa của sàn cho coin này
                const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
                const lev = brackets[0].brackets[0].initialLeverage;
                await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });

                const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
                const price = parseFloat(ticker.price);
                
                // Tính khối lượng vào lệnh
                let qty = Math.ceil(((botSettings.invValue * lev) / price) / info.stepSize) * info.stepSize;
                if ((qty * price) < 5.0) qty = Math.ceil(5.1 / price / info.stepSize) * info.stepSize;

                // Đặt lệnh Market
                await callBinance('/fapi/v1/order', 'POST', { 
                    symbol: c.symbol, side: side === 'LONG' ? 'BUY' : 'SELL', 
                    positionSide: side, type: 'MARKET', quantity: qty.toFixed(info.quantityPrecision) 
                });

                addBotLog(`✅ [THÀNH CÔNG] Đã mở ${side} ${c.symbol} khối lượng $${(qty*price).toFixed(2)}. Chờ 5s cài TP/SL...`, "success");
                
                // Đợi đúng 5 giây lấy Entry Price thật để ghim TP/SL
                setTimeout(enforceTPSL, 5000); 
            } catch (err) { 
                addBotLog(`❌ [THẤT BẠI] Không thể mở ${c.symbol}: ${err.msg || "Lỗi không xác định"}`, "error");
            }
        }
    } catch (e) {
        if (e.msg) addBotLog(`⚠️ [LỖI HỆ THỐNG] ${e.msg}`, "error");
    }
}

// Quét kèo liên tục từ Port 9000
function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/live', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const all = JSON.parse(d);
                status.candidatesList = all
                    .filter(c => Math.abs(c.changePercent) >= botSettings.minVol)
                    .sort((a,b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
                    .slice(0, 5); // Lấy top 5 kèo mạnh nhất
            } catch (e) {}
        });
    }).on('error', () => {
        addBotLog("📡 [LỖI RADAR] Không kết nối được Port 9000. Kiểm tra app quét kèo!", "error");
    });
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
    addBotLog(botSettings.isRunning ? "▶️ BOT BẮT ĐẦU HOẠT ĐỘNG" : "⏸️ BOT ĐÃ TẠM DỪNG", botSettings.isRunning ? "success" : "warn");
    res.json({ status: "ok" });
});

async function init() {
    addBotLog("📡 Đang nạp dữ liệu từ sàn Binance...", "info");
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
            try {
                JSON.parse(d).symbols.forEach(s => {
                    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
                    status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize) };
                });
                isInitializing = false;
                addBotLog("✅ [HỆ THỐNG] Đã sẵn sàng. Chờ lệnh từ Thuyền trưởng.", "success");
            } catch (e) { addBotLog("❌ Lỗi nạp thông tin sàn", "error"); }
        });
    }).on('error', (e) => {
        addBotLog("❌ Không thể nạp Exchange Info: " + e.message, "error");
        setTimeout(init, 5000);
    });
}

init();
setInterval(fetchCandidates, 3000); // 3 giây quét kèo 1 lần
setInterval(hunt, 4000); // 4 giây check để mở vị thế 1 lần
setInterval(enforceTPSL, 10000); // 10 giây quét kiểm tra TP/SL 1 lần

APP.listen(9001, '0.0.0.0');
