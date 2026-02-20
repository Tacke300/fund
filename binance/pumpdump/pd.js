import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let botSettings = { isRunning: false, maxPositions: 3, invValue: 1.5, invType: 'fixed', minVol: 5.0, accountSL: 30 };
let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let isInitializing = true;
let isProcessing = false;

function addBotLog(msg, type = 'info') {
    const entry = { time: new Date().toLocaleTimeString(), msg, type };
    status.botLogs.unshift(entry);
    if (status.botLogs.length > 100) status.botLogs.pop();
    console.log(`[${new Date().toLocaleTimeString()}] [${type.toUpperCase()}] ${msg}`);
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
                } catch (e) { reject({ msg: "JSON_ERROR", detail: d }); }
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
                        stopPrice: plan.tp.toFixed(info.pricePrecision), workingType: 'MARK_PRICE',
                        closePosition: 'true', timeInForce: 'GTC'
                    });
                    addBotLog(`🎯 Đã đặt TAKE_PROFIT cho ${symbol}`, "success");
                }
                if (!hasSL) {
                    await callBinance('/fapi/v1/order', 'POST', {
                        symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET',
                        stopPrice: plan.sl.toFixed(info.pricePrecision), workingType: 'MARK_PRICE',
                        closePosition: 'true', timeInForce: 'GTC'
                    });
                    addBotLog(`🛑 Đã đặt STOP_LOSS cho ${symbol}`, "success");
                }
            }
        }
    } catch (e) {
        addBotLog(`⚠️ Lỗi cài TP/SL: ${e.msg || "Cố gắng thử lại sau..."}`, "error");
    }
}

async function hunt() {
    // LOG TRẠNG THÁI NỀN (Để biết bot có đang chạy ngầm không)
    if (isInitializing) return; // Đang load dữ liệu sàn, chưa làm việc
    if (!botSettings.isRunning) return; // Bot đang ở trạng thái OFF

    if (isProcessing) {
        addBotLog("⏳ Vòng lặp cũ chưa xong, bỏ qua lượt này...", "info");
        return;
    }

    try {
        isProcessing = true;
        addBotLog("🔄 --- BẮT ĐẦU CHU KỲ QUÉT MỚI ---", "info");

        // 1. Kiểm tra danh sách ứng viên
        if (!status.candidatesList || status.candidatesList.length === 0) {
            addBotLog("📡 Đang chờ tín hiệu từ API Signal (Port 9000)...", "info");
            isProcessing = false;
            return;
        }

        // 2. Kiểm tra số lượng vị thế thực tế từ sàn
        addBotLog("🔌 Đang kết nối Binance kiểm tra vị thế...", "info");
        const currentPos = await callBinance('/fapi/v2/positionRisk');
        const activeList = currentPos.filter(p => parseFloat(p.positionAmt) !== 0);
        
        addBotLog(`📊 Hiện có ${activeList.length} lệnh. Giới hạn: ${botSettings.maxPositions}`, "info");

        if (activeList.length >= botSettings.maxPositions) {
            addBotLog("⏹️ Đã đủ số lệnh tối đa. Không quét thêm.", "info");
            isProcessing = false;
            return;
        }

        // 3. Duyệt danh sách ứng viên để vào lệnh
        for (const c of status.candidatesList) {
            // Check trùng
            if (activeList.some(p => p.symbol === c.symbol)) {
                addBotLog(`⏭️ Bỏ qua ${c.symbol} (Đã có vị thế)`, "info");
                continue;
            }

            addBotLog(`💎 PHÁT HIỆN CƠ HỘI: ${c.symbol} (${c.changePercent}%)`, "success");

            try {
                // Lấy thông số đòn bẩy
                const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
                const lev = brackets[0].brackets[0].initialLeverage;
                await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });

                // Tính toán tiền vào lệnh
                const acc = await callBinance('/fapi/v2/account');
                status.currentBalance = parseFloat(acc.totalMarginBalance);
                const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
                const price = parseFloat(ticker.price);
                const info = status.exchangeInfo[c.symbol];
                const side = c.changePercent > 0 ? 'LONG' : 'SHORT';

                let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
                
                // Đảm bảo min Notional 5.1$
                if ((margin * lev) < 5.1) {
                    margin = 5.2 / lev;
                    addBotLog(`⚠️ Tự tăng ký quỹ lên ${margin.toFixed(2)}$ cho ${c.symbol} để đủ lệnh tối thiểu`, "info");
                }

                let qty = Math.floor(((margin * lev) / price) / info.stepSize) * info.stepSize;
                const finalQty = qty.toFixed(info.quantityPrecision);

                addBotLog(`📝 Đang gửi lệnh MARKET ${side} cho ${c.symbol}...`, "info");
                const orderResult = await callBinance('/fapi/v1/order', 'POST', {
                    symbol: c.symbol, side: side === 'LONG' ? 'BUY' : 'SELL',
                    positionSide: side, type: 'MARKET', quantity: finalQty
                });

                addBotLog(`✅ KHỚP LỆNH: ${c.symbol} thành công!`, "success");

                // Đợi 3s cài TP/SL
                addBotLog(`⏱️ Đợi 3s để hệ thống cập nhật giá vào lệnh...`, "info");
                await new Promise(res => setTimeout(res, 3000));
                
                addBotLog(`🛡️ Đang cài TP/SL cho ${c.symbol}...`, "info");
                await enforceTPSL();

                // Kiểm tra xem đã đủ số lượng chưa để lặp tiếp
                const reCheck = await callBinance('/fapi/v2/positionRisk');
                if (reCheck.filter(p => parseFloat(p.positionAmt) !== 0).length >= botSettings.maxPositions) {
                    addBotLog("🏁 Đã đạt giới hạn tối đa sau khi mở lệnh vừa rồi.", "info");
                    break;
                }

            } catch (err) {
                addBotLog(`❌ Thất bại khi mở ${c.symbol}: ${JSON.stringify(err)}`, "error");
            }
        }
    } catch (e) {
        addBotLog(`🔥 Lỗi hệ thống hàm hunt: ${e.message}`, "error");
    } finally {
        addBotLog("⌛ Kết thúc phiên làm việc.", "info");
        isProcessing = false;
    }
}

// Giữ nguyên các phần fetchCandidates, Express và Init bên dưới
function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/live', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const all = JSON.parse(d);
                status.candidatesList = all
                    .filter(c => Math.abs(c.changePercent) >= botSettings.minVol)
                    .sort((a,b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
                    .slice(0, 10);
            } catch (e) {}
        });
    }).on('error', () => {
        if(botSettings.isRunning) addBotLog("📡 Lỗi: Không thể lấy tín hiệu từ Port 9000", "error");
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
        res.json({ botSettings, status, activePositions: active });
    } catch (e) { res.status(500).send(); }
});

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    addBotLog(`⚙️ Cập nhật cấu hình: Trạng thái=${botSettings.isRunning ? "BẬT" : "TẮT"}, Max=${botSettings.maxPositions}`, "info");
    res.json({ status: "ok" });
});

async function init() {
    addBotLog("🔧 Đang khởi tạo thông tin sàn...", "info");
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
            try {
                JSON.parse(d).symbols.forEach(s => {
                    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
                    status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize) };
                });
                isInitializing = false;
                addBotLog("✅ Dữ liệu sàn đã sẵn sàng.", "success");
            } catch (e) { addBotLog("❌ Không thể parse Exchange Info", "error"); }
        });
    });
}

init();
setInterval(fetchCandidates, 3000);
setInterval(hunt, 2000);
setInterval(enforceTPSL, 10000);
APP.listen(9001, '0.0.0.0');
