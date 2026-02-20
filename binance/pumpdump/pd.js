import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cấu hình mặc định
let botSettings = { 
    isRunning: false, 
    maxPositions: 3, 
    invValue: 1.5, 
    invType: 'percent', // Mặc định dùng % tài khoản
    minVol: 5.0, 
    accountSL: 30 
};

let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let botManagedSymbols = []; 
let isInitializing = true;
let isProcessing = false;

// HÀM LOG CHI TIẾT 100%
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const entry = { time, msg, type };
    status.botLogs.unshift(entry);
    if (status.botLogs.length > 200) status.botLogs.pop();

    // Màu sắc log terminal
    const colors = {
        success: '\x1b[32m', // Xanh lá
        error: '\x1b[31m',   // Đỏ
        warn: '\x1b[33m',    // Vàng
        info: '\x1b[36m',    // Xanh lơ
        debug: '\x1b[90m'    // Xám
    };
    const c = colors[type] || colors.info;
    console.log(`${c}[${time}] [${type.toUpperCase()}] ${msg}\x1b[0m`);
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
                } catch (e) { reject({ msg: "LỖI_JSON", detail: d }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

// 1. TỰ ĐỘNG DỌN DẸP VỊ THẾ ĐÃ ĐÓNG
async function cleanupClosedPositions() {
    if (!botSettings.isRunning) return;
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        for (let i = botManagedSymbols.length - 1; i >= 0; i--) {
            const symbol = botManagedSymbols[i];
            const p = positions.find(pos => pos.symbol === symbol);
            
            if (!p || parseFloat(p.positionAmt) === 0) {
                addBotLog(`🧹 [DỌN DẸP] Phát hiện ${symbol} đã đóng vị thế.`, "info");
                
                // Xóa lệnh chờ
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol })
                    .then(() => addBotLog(`🗑️ [HỦY LỆNH] Đã xóa lệnh TP/SL cũ của ${symbol}`, "debug"))
                    .catch(() => addBotLog(`💡 [GHI CHÚ] ${symbol} không còn lệnh chờ để xóa.`, "debug"));
                
                botManagedSymbols.splice(i, 1);
                addBotLog(`🔓 [SLOT] Giải phóng xong ${symbol}. Slot trống hiện tại: ${botSettings.maxPositions - botManagedSymbols.length}`, "success");
            }
        }
    } catch (e) {
        addBotLog(`⚠️ [LỖI DỌN DẸP] Không thể kiểm tra vị thế đóng: ${e.msg || "API Busy"}`, "error");
    }
}

// 2. TÍNH TOÁN TP/SL
function calcTPSL(lev, side, entryPrice) {
    let m = lev < 26 ? 1.11 : (lev < 50 ? 2.22 : (lev < 75 ? 3.33 : 5.55));
    const rate = m / lev;
    const tp = side === 'LONG' ? entryPrice * (1 + rate) : entryPrice * (1 - rate);
    const sl = side === 'LONG' ? entryPrice * (1 - rate) : entryPrice * (1 + rate);
    return { tp, sl };
}

// 3. CÀI ĐẶT TP/SL CHI TIẾT
async function enforceTPSL() {
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const orders = await callBinance('/fapi/v1/openOrders');

        for (const symbol of botManagedSymbols) {
            const p = positions.find(pos => pos.symbol === symbol && parseFloat(pos.positionAmt) !== 0);
            if (!p) continue;

            const side = p.positionSide;
            const entry = parseFloat(p.entryPrice);
            if (entry <= 0) {
                addBotLog(`⏳ [ĐỢI GIÁ] ${symbol} chưa cập nhật Entry Price, bỏ qua cài TP/SL lượt này.`, "debug");
                continue;
            }

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
                    addBotLog(`🎯 [TP] Cài chốt lãi ${symbol} tại: ${plan.tp.toFixed(info.pricePrecision)}`, "success");
                }
                if (!hasSL) {
                    await callBinance('/fapi/v1/order', 'POST', {
                        symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET',
                        stopPrice: plan.sl.toFixed(info.pricePrecision), workingType: 'MARK_PRICE',
                        closePosition: 'true', timeInForce: 'GTC'
                    });
                    addBotLog(`🛑 [SL] Cài cắt lỗ ${symbol} tại: ${plan.sl.toFixed(info.pricePrecision)}`, "success");
                }
            }
        }
    } catch (e) {
        addBotLog(`⚠️ [LỖI TP/SL] ${symbol || "API"}: ${e.msg || "Lỗi tham số"}`, "error");
    }
}

// 4. HÀM SĂN LỆNH - LOG CHI TIẾT TỪNG BƯỚC
async function hunt() {
    if (isInitializing) {
        addBotLog("⚙️ [Hệ thống] Đang tải dữ liệu sàn, vui lòng đợi...", "debug");
        return;
    }
    if (!botSettings.isRunning) return; 
    if (isProcessing) return;

    try {
        isProcessing = true;
        
        // KIỂM TRA SLOT
        const currentUsed = botManagedSymbols.length;
        if (currentUsed >= botSettings.maxPositions) {
            addBotLog(`💤 [ĐỦ LỆNH] Bot đã mở ${currentUsed}/${botSettings.maxPositions} mã quản lý [${botManagedSymbols.join(', ')}]. Đang nghỉ chờ slot...`, "info");
            isProcessing = false;
            return;
        }

        // KIỂM TRA TÍN HIỆU
        if (status.candidatesList.length === 0) {
            addBotLog(`📡 [TÍN HIỆU] Chưa có mã nào biến động > ${botSettings.minVol}%. Đang quét tiếp...`, "debug");
            isProcessing = false;
            return;
        }

        addBotLog(`🔍 [QUÉT] Đang kiểm tra ${status.candidatesList.length} ứng viên cho ${botSettings.maxPositions - currentUsed} slot trống.`, "info");

        for (const c of status.candidatesList) {
            if (botManagedSymbols.includes(c.symbol)) {
                addBotLog(`⏭️ [TRÙNG] ${c.symbol} đã có trong danh sách quản lý. Bỏ qua.`, "debug");
                continue;
            }
            if (botManagedSymbols.length >= botSettings.maxPositions) break;

            try {
                addBotLog(`🎯 [CHẤP NHẬN] ${c.symbol} đạt ${c.changePercent}%. Bắt đầu quy trình vào lệnh.`, "info");

                // Đòn bẩy
                const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
                const lev = brackets[0].brackets[0].initialLeverage;
                await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });
                addBotLog(`⚙️ [LEV] Đã set đòn bẩy ${lev}x cho ${c.symbol}`, "debug");

                // Tài chính
                const acc = await callBinance('/fapi/v2/account');
                status.currentBalance = parseFloat(acc.totalMarginBalance);
                const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
                const price = parseFloat(ticker.price);
                const info = status.exchangeInfo[c.symbol];
                const side = c.changePercent > 0 ? 'LONG' : 'SHORT';

                let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
                
                addBotLog(`💰 [VỐN] Số dư: ${status.currentBalance.toFixed(2)}$ | Dự định ký quỹ: ${margin.toFixed(2)}$`, "debug");

                // Check Min Notional
                if ((margin * lev) < 5.1) {
                    margin = 5.2 / lev;
                    addBotLog(`⚖️ [TỰ ĐIỀU CHỈNH] Margin quá thấp, tăng lên ${margin.toFixed(2)}$ để đủ Notional 5.1$`, "warn");
                }

                let qty = Math.floor(((margin * lev) / price) / info.stepSize) * info.stepSize;
                const finalQty = qty.toFixed(info.quantityPrecision);

                if (parseFloat(finalQty) <= 0) {
                    addBotLog(`❌ [LỖI] Khối lượng tính toán của ${c.symbol} bằng 0. Bỏ qua mã này.`, "error");
                    continue;
                }

                // Đặt lệnh
                addBotLog(`📝 [LỆNH] Gửi Market ${side} cho ${c.symbol} - Số lượng: ${finalQty}`, "info");
                await callBinance('/fapi/v1/order', 'POST', {
                    symbol: c.symbol, side: side === 'LONG' ? 'BUY' : 'SELL',
                    positionSide: side, type: 'MARKET', quantity: finalQty
                });

                botManagedSymbols.push(c.symbol);
                addBotLog(`🚀 [THÀNH CÔNG] Bot đã mở lệnh ${c.symbol}. Slot: ${botManagedSymbols.length}/${botSettings.maxPositions}`, "success");

                addBotLog(`⏱️ [NGHỈ] Tạm dừng 3s để sàn khớp lệnh trước khi cài TP/SL...`, "debug");
                await new Promise(res => setTimeout(res, 3000));
                
                await enforceTPSL();

            } catch (err) {
                addBotLog(`❌ [THẤT BẠI] Không thể mở lệnh ${c.symbol}: ${JSON.stringify(err)}`, "error");
            }
        }
    } catch (e) {
        addBotLog(`🔥 [LỖI HỆ THỐNG] Hàm hunt gặp sự cố: ${e.message}`, "error");
    } finally {
        isProcessing = false;
        addBotLog(`🏁 [KẾT THÚC] Hoàn thành chu kỳ quét.`, "debug");
    }
}

// 5. LẤY TÍN HIỆU TỪ CỔNG 9000
function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/live', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const all = JSON.parse(d);
                const filtered = all.filter(c => Math.abs(c.changePercent) >= botSettings.minVol);
                status.candidatesList = filtered
                    .sort((a,b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
                    .slice(0, 10);
                
                if (botSettings.isRunning && status.candidatesList.length > 0) {
                    addBotLog(`📡 [SIGNAL] Nhận ${filtered.length} mã biến động mạnh. Top 1: ${status.candidatesList[0].symbol} (${status.candidatesList[0].changePercent}%)`, "debug");
                }
            } catch (e) {}
        });
    }).on('error', () => {
        if(botSettings.isRunning) addBotLog("📡 [LỖI] Cổng tín hiệu 9000 không phản hồi. Kiểm tra ứng viên thất bại.", "error");
    });
}

// --- EXPRESS & SERVER ---
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
        res.json({ botSettings, status, activePositions: active, botManagedSymbols });
    } catch (e) { res.status(500).send(); }
});

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    const mode = botSettings.isRunning ? "BẬT" : "TẮT";
    addBotLog(`⚙️ [CẤU HÌNH] Thay đổi: Trạng thái=${mode} | Max=${botSettings.maxPositions} | Vào lệnh=${botSettings.invValue}${botSettings.invType === 'percent' ? '%' : '$'}`, "warn");
    res.json({ status: "ok" });
});

async function init() {
    addBotLog("🔧 [KHỞI TẠO] Đang kết nối Binance lấy quy tắc giao dịch...", "info");
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
            try {
                const info = JSON.parse(d);
                info.symbols.forEach(s => {
                    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
                    status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize) };
                });
                isInitializing = false;
                addBotLog("✅ [HỆ THỐNG] Dữ liệu sàn OK. Bot đã sẵn sàng nhận lệnh.", "success");
            } catch (e) { addBotLog("❌ [LỖI] Không thể xử lý dữ liệu từ sàn Binance.", "error"); }
        });
    });
}

// Chạy khởi tạo
init();

// Các chu kỳ quét (Loop)
setInterval(fetchCandidates, 3000);  // 3 giây lấy tín hiệu
setInterval(hunt, 2000);             // 2 giây quét vào lệnh
setInterval(cleanupClosedPositions, 5000); // 5 giây dọn dẹp vị thế đóng
setInterval(enforceTPSL, 10000);     // 10 giây cài bù TP/SL nếu lỗi

APP.listen(9001, '0.0.0.0');
