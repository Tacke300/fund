import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CẤU HÌNH ---
let tpPercent = 5.0; 
let slPercent = 5.0; 
let botSettings = { 
    isRunning: false, 
    maxPositions: 10, 
    invValue: 1.5, 
    invType: 'percent', 
    minVol: 5.0,
    defaultLeverage: 20  // Mặc định hạ xuống x20 để an toàn hơn
};

let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let botManagedSymbols = []; 
let blockedSymbols = new Map(); 
let isInitializing = true;
let isProcessing = false;

// --- HÀM HỖ TRỢ ---
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    const colors = { success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m' };
    console.log(`${colors[type] || ''}[${time}] ${msg}\x1b[0m`);
}

async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now() - 1000; 
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
            let d = ''; res.on('data', chunk => d += chunk);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(j); 
                    else reject(j);
                } catch (e) { reject({ msg: "PARSE_ERR" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

// --- HÀM CÀI TP/SL ĐA TẦNG (3 CÁCH) ---
async function enforceBaoVe(symbol, side, type, price, qty, info) {
    const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
    const isTP = type === 'TP';

    // Danh sách các kiểu lệnh thử dần từ dễ đến khó
    const attemptConfigs = [
        // Cách 1: Market Stop (Phổ biến nhất)
        { type: isTP ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET', stopPrice: price, closePosition: 'true' },
        // Cách 2: Limit Stop (Dành cho các cặp lọc lệnh Market)
        { type: isTP ? 'TAKE_PROFIT' : 'STOP', stopPrice: price, price: price, quantity: qty, timeInForce: 'GTC' },
        // Cách 3: Lệnh Limit thuần túy (Nếu là TP)
        { type: 'LIMIT', price: price, quantity: qty, timeInForce: 'GTC' }
    ];

    for (let config of attemptConfigs) {
        // Nếu là SL thì không dùng cách 3 (LIMIT thuần)
        if (!isTP && config.type === 'LIMIT') continue;

        try {
            let res = await callBinance('/fapi/v1/order', 'POST', {
                symbol,
                side: closeSide,
                positionSide: side,
                workingType: 'MARK_PRICE',
                ...config
            });

            if (res.orderId) {
                addBotLog(`✅ [${symbol}] Cài ${type} thành công bằng ${config.type} tại ${price}`, "success");
                return true;
            }
        } catch (e) {
            // Thử cách tiếp theo nếu lỗi
            continue;
        }
    }
    addBotLog(`❌ [${symbol}] Thất bại toàn bộ các cách cài ${type}`, "error");
    return false;
}

async function setupAccount(symbol, leverage) {
    try {
        await callBinance('/fapi/v1/leverage', 'POST', { symbol, leverage }).catch(()=>{});
        await callBinance('/fapi/v1/marginType', 'POST', { symbol, marginType: 'CROSSED' }).catch(()=>{});
    } catch (e) {}
}

// --- LOGIC CHÍNH ---
async function hunt() {
    if (isInitializing || !botSettings.isRunning || isProcessing) return;
    try {
        isProcessing = true;
        if (botManagedSymbols.length >= botSettings.maxPositions) return;

        const positions = await callBinance('/fapi/v2/positionRisk');
        const activeOnExchange = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => p.symbol);
        const managedNames = botManagedSymbols.map(i => i.symbol);

        for (const c of status.candidatesList.filter(c => c.maxV >= botSettings.minVol)) {
            if (activeOnExchange.includes(c.symbol) || managedNames.includes(c.symbol)) continue;
            if (blockedSymbols.has(c.symbol) && Date.now() < blockedSymbols.get(c.symbol)) continue;
            
            const info = status.exchangeInfo[c.symbol];
            // BỎ QUA NẾU KHÔNG CÓ THÔNG TIN HOẶC ĐÒN BẨY TỐI ĐA THẤP HƠN 20
            if (!info || info.maxLeverage < 20) continue;

            await setupAccount(c.symbol, botSettings.defaultLeverage);

            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
            const currentPrice = parseFloat(ticker.price);
            
            let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
            let qty = (Math.floor(((margin * botSettings.defaultLeverage) / currentPrice) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

            const side = c.changePercent > 0 ? 'BUY' : 'SELL';
            const posSide = c.changePercent > 0 ? 'LONG' : 'SHORT';

            addBotLog(`🚀 Vào lệnh ${c.symbol} (${posSide}) - Đòn bẩy tối đa sàn cho: x${info.maxLeverage}`, "info");
            
            const order = await callBinance('/fapi/v1/order', 'POST', { 
                symbol: c.symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty 
            }).catch(e => ({ error: e.msg }));

            if (order.orderId) {
                botManagedSymbols.push({ symbol: c.symbol, openedAt: Date.now(), isSettingUp: true });
                
                setTimeout(async () => {
                    try {
                        const pCheck = await callBinance('/fapi/v2/positionRisk', 'GET', { symbol: c.symbol });
                        const p = pCheck.find(pos => pos.symbol === c.symbol && parseFloat(pos.positionAmt) !== 0);
                        
                        if (p) {
                            const entry = parseFloat(p.entryPrice);
                            const pQty = Math.abs(parseFloat(p.positionAmt));
                            const tpDiff = entry * (tpPercent / 100);
                            const slDiff = entry * (slPercent / 100);

                            let tpPrice = posSide === 'LONG' ? (entry + tpDiff) : (entry - tpDiff);
                            let slPrice = posSide === 'LONG' ? (entry - slDiff) : (entry + slDiff);

                            const finalTP = (Math.round(tpPrice / info.tickSize) * info.tickSize).toFixed(info.pricePrecision);
                            const finalSL = (Math.round(slPrice / info.tickSize) * info.tickSize).toFixed(info.pricePrecision);

                            // Gọi hàm bảo vệ đa tầng
                            await enforceBaoVe(c.symbol, posSide, 'TP', finalTP, pQty, info);
                            await enforceBaoVe(c.symbol, posSide, 'SL', finalSL, pQty, info);
                        }
                    } finally {
                        const target = botManagedSymbols.find(i => i.symbol === c.symbol);
                        if (target) target.isSettingUp = false;
                    }
                }, 3000); 
                break; 
            }
        }
    } finally { isProcessing = false; }
}

// --- CẬP NHẬT THÔNG TIN SÀN (LẤY CẢ MAX LEVERAGE) ---
async function init() {
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
            try {
                const info = JSON.parse(d);
                info.symbols.forEach(s => {
                    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
                    const prc = s.filters.find(f => f.filterType === 'PRICE_FILTER');
                    
                    // Lấy đòn bẩy tối đa từ các cặp tiền
                    const brackets = s.underlyingType === 'COIN' ? 20 : 125; // Dự phòng mặc định

                    status.exchangeInfo[s.symbol] = { 
                        quantityPrecision: s.quantityPrecision, 
                        pricePrecision: s.pricePrecision, 
                        stepSize: parseFloat(lot.stepSize), 
                        tickSize: parseFloat(prc.tickSize),
                        // Binance không trả maxLeverage trực tiếp ở đây, 
                        // nhưng ta có thể lọc dựa trên tên hoặc các tiêu chí khác.
                        // Ở đây ta giả định lọc các cặp rác/cũ có thanh khoản kém.
                        maxLeverage: 125 
                    };
                });

                // Cập nhật đòn bẩy thực tế từ tài khoản cho chính xác
                callBinance('/fapi/v1/leverageBracket').then(brackets => {
                    brackets.forEach(b => {
                        if(status.exchangeInfo[b.symbol]) {
                            status.exchangeInfo[b.symbol].maxLeverage = b.brackets[0].initialLeverage;
                        }
                    });
                    isInitializing = false;
                    addBotLog("🚀 BOT SẴN SÀNG - ĐÃ FIX TP/SL 3 CÁCH & LỌC LEVERAGE > 20", "success");
                });

            } catch (e) { addBotLog("Lỗi khởi tạo: " + e.message, "error"); }
        });
    });
}

// ... (Các hàm cleanup, updateBalance giữ nguyên như cũ)
async function cleanup() {
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const activeSymbols = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => p.symbol);
        for (let i = botManagedSymbols.length - 1; i >= 0; i--) {
            const item = botManagedSymbols[i];
            if (!activeSymbols.includes(item.symbol) && (Date.now() - item.openedAt) > 15000 && !item.isSettingUp) {
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol: item.symbol }).catch(()=>{});
                botManagedSymbols.splice(i, 1);
                blockedSymbols.set(item.symbol, Date.now() + 2 * 60 * 1000); 
            }
        }
    } catch (e) {}
}

async function updateBalance() {
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
    } catch (e) {}
}

function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const response = JSON.parse(d);
                status.candidatesList = (response.live || []).map(c => ({
                    symbol: c.symbol, changePercent: c.c1, maxV: Math.max(Math.abs(c.c1), Math.abs(c.c5), Math.abs(c.c15))
                })).sort((a, b) => b.maxV - a.maxV);
            } catch (e) {}
        });
    }).on('error', () => {});
}

const APP = express();
APP.use(express.json());
APP.get('/api/status', (req, res) => res.json({ botSettings, botRunningSlots: botManagedSymbols.map(i => i.symbol), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ status: "ok" }); });

init();
setInterval(updateBalance, 10000);
setInterval(fetchCandidates, 2000);
setInterval(hunt, 4000);
setInterval(cleanup, 10000);
APP.listen(9001, '0.0.0.0');
