import https from 'https';
import crypto from 'crypto';
import express from 'express';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Tối ưu Agent để giữ kết nối không bị ngắt quãng
const keepAliveAgent = new https.Agent({ keepAlive: true, timeout: 60000 });

const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    timeout: 45000, 
    options: { defaultType: 'future', dualSidePosition: true },
    agent: keepAliveAgent
});

let botSettings = { 
    isRunning: false, maxPositions: 3, invValue: 1, invType: 'percent', 
    minVol: 6.5, posTP: 0.5, posSL: 5.0
};

let status = { 
    currentBalance: 0, availableBalance: 0, 
    botLogs: [], exchangeInfo: {}, candidatesList: [], history: [] 
};

let activeOrdersTracker = new Map(); 
let pendingSymbols = new Set();
let isReady = false; 

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

// Hàm gọi API lõi với cơ chế chống "đơ" kết nối
async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;
    
    return new Promise((resolve, reject) => {
        const req = https.request(url, { 
            method, 
            timeout: 10000, 
            agent: keepAliveAgent, // Dùng chung agent để tránh tạo quá nhiều kết nối mới
            headers: { 'X-MBX-APIKEY': API_KEY } 
        }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { 
                try { 
                    const parsed = JSON.parse(d);
                    if (parsed.code && parsed.code < 0) reject(new Error(parsed.msg));
                    else resolve(parsed);
                } catch (e) { reject(new Error("Phản hồi sàn lỗi")); } 
            });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error("Sàn phản hồi chậm (Timeout)")); });
        req.on('error', (e) => reject(e));
        req.end();
    });
}

async function openPosition(symbol, side) {
    const info = status.exchangeInfo[symbol];
    if (!info) return;
    const posSide = side === 'BUY' ? 'LONG' : 'SHORT';

    try {
        const acc = await callBinance('/fapi/v2/account');
        const avail = parseFloat(acc.availableBalance);
        const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
        const price = parseFloat(ticker.price);
        
        let margin = botSettings.invType === 'percent' ? (avail * botSettings.invValue) / 100 : botSettings.invValue;
        let qty = ((margin * info.maxLeverage / price) / info.stepSize * info.stepSize).toFixed(info.quantityPrecision);

        // Thực thi lệnh qua CCXT để ổn định hơn cho các lệnh Stop
        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createMarketOrder(symbol, side.toLowerCase(), qty, { positionSide: posSide });

        if (order) {
            addBotLog(`🚀 Khớp lệnh: ${symbol} ${posSide}`, "success");
            const entry = order.price || price;
            const tp = (posSide === 'LONG' ? entry * (1 + botSettings.posTP/100) : entry * (1 - botSettings.posTP/100)).toFixed(info.pricePrecision);
            const sl = (posSide === 'LONG' ? entry * (1 - botSettings.posSL/100) : entry * (1 + botSettings.posSL/100)).toFixed(info.pricePrecision);
            
            // Đặt Giáp Sàn
            try {
                const sideClose = posSide === 'LONG' ? 'sell' : 'buy';
                await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, qty, undefined, { positionSide: posSide, stopPrice: tp, closePosition: true });
                await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, qty, undefined, { positionSide: posSide, stopPrice: sl, closePosition: true });
            } catch (e) { addBotLog(`⚠️ Lỗi đặt TP/SL ${symbol}: ${e.message}`, "error"); }

            activeOrdersTracker.set(symbol, { 
                symbol, side: posSide, entryPrice: entry.toFixed(info.pricePrecision), 
                margin: margin.toFixed(2), markPrice: entry.toFixed(info.pricePrecision),
                tpPrice: tp, slPrice: sl
            });
        }
    } catch (e) { addBotLog(`❌ Mở lệnh thất bại ${symbol}: ${e.message}`, "error"); }
}

async function mainLoop() {
    if (!botSettings.isRunning || !isReady) return;
    try {
        // Chỉ lấy PositionRisk - API này nhẹ nhất để kiểm tra trạng thái
        const posRisk = await callBinance('/fapi/v2/positionRisk');
        
        for (let [symbol, data] of activeOrdersTracker) {
            const p = posRisk.find(x => x.symbol === symbol && x.positionSide === data.side);
            if (!p || parseFloat(p.positionAmt) === 0) {
                addBotLog(`✅ Đã đóng ${symbol}`, "info");
                activeOrdersTracker.delete(symbol);
                // Sau khi đóng, có thể thêm logic lưu history ở đây
                continue;
            }
            data.markPrice = parseFloat(p.markPrice).toFixed(info.pricePrecision);
        }

        if (activeOrdersTracker.size < botSettings.maxPositions) {
            const kèo = status.candidatesList.find(c => !activeOrdersTracker.has(c.symbol) && !pendingSymbols.has(c.symbol) && Math.abs(c.c1) >= botSettings.minVol);
            if (kèo) {
                pendingSymbols.add(kèo.symbol);
                await openPosition(kèo.symbol, kèo.c1 >= 0 ? 'BUY' : 'SELL');
                setTimeout(() => pendingSymbols.delete(kèo.symbol), 15000);
            }
        }
    } catch (e) { console.error("Loop Error:", e.message); }
}

async function init() {
    try {
        const info = await callBinance('/fapi/v1/exchangeInfo');
        const brackets = await callBinance('/fapi/v1/leverageBracket');
        const bList = Array.isArray(brackets) ? brackets : (brackets.brackets || []);

        info.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = bList.find(b => b.symbol === s.symbol);
            status.exchangeInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), 
                maxLeverage: (brk && brk.brackets) ? brk.brackets[0].initialLeverage : 20 
            };
        });
        isReady = true;
        addBotLog("👿 LUFFY v17.1 - KẾT NỐI ỔN ĐỊNH", "success");
    } catch (e) { 
        addBotLog("🔄 Sàn lỗi, đang kết nối lại...", "error");
        setTimeout(init, 5000); 
    }
}

init();
setInterval(mainLoop, 5000); // 5s một lần để tránh bị Binance "soi" IP

// Lấy data từ bot lọc kèo
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
            try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {}
        });
    }).on('error', () => {});
}, 3000);

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(activeOrdersTracker.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
