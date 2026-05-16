import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs'; 
import WebSocket from 'ws';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE_PATH = path.join(__dirname, 'bot_state_persistent.json');

const binanceApi = axios.create({ 
    baseURL: 'https://fapi.binance.com', 
    timeout: 5000, // Giảm timeout xuống 5s để giải phóng thread nhanh nếu sàn nghẽn
    headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' } 
});

// SYSTEM STATES
let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 0.1, posTP: 1.2, posSL: 10.0, maxDCA: 5 };
let status = { botLogs: [], candidatesList: [], blackList: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: {}, isReady: false, isHedgeMode: true };

let botActivePositions = new Map(); 
let openingSymbols = new Set();     
let serverTimeOffset = 0;
let listenKey = null;
let userWsInstance = null;

// ====================================================================
// STORAGE ENGINE - FIX CHẶT LỖI MẤT TRÍ NHỚ KHI RESTART PM2
// ====================================================================
function saveBotStateToDisk() {
    try {
        const state = {
            // Chuyển Map thành mảng cặp [key, value] chuẩn để lưu được vào JSON
            botActivePositions: Array.from(botActivePositions.entries()),
            blackList: status.blackList,
            botClosedCount: status.botClosedCount,
            botPnLClosed: status.botPnLClosed,
            botSettings
        };
        fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
        // Im lặng hoàn toàn không spam log khi lỗi ghi file cục bộ
    }
}

function loadBotStateFromDisk() {
    try {
        if (fs.existsSync(STATE_FILE_PATH)) {
            const raw = fs.readFileSync(STATE_FILE_PATH, 'utf8');
            if (!raw || raw.trim() === "") return;
            
            const parsed = JSON.parse(raw);
            
            // Khôi phục lại Map từ Array cặp trùng chuẩn xác
            if (parsed.botActivePositions && Array.isArray(parsed.botActivePositions)) {
                botActivePositions = new Map(parsed.botActivePositions);
            }
            
            status.blackList = parsed.blackList || {};
            status.botClosedCount = parsed.botClosedCount || 0;
            status.botPnLClosed = parsed.botPnLClosed || 0;
            if (parsed.botSettings) botSettings = { ...botSettings, ...parsed.botSettings };
            
            addBotLog(`💾 [RECOVERY] PM2 Khởi động lại thành công. Đã phục hồi ${botActivePositions.size} vị thế cũ từ ổ đĩa!`, 'success');
        }
    } catch (e) {
        addBotLog("⚠️ Không thể đọc file trạng thái cũ (File lỗi hoặc trống). Khởi tạo dữ liệu mới.", "warning");
    }
}

// ====================================================================
// SYSTEM UTILS
// ====================================================================
function getPrecision(stepSize) {
    const step = stepSize.toString();
    return step.includes('.') ? step.split('.')[1].replace(/0+$/, '').length : 0;
}

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop(); // Giới hạn 50 log trên UI cho nhẹ ram
    console.log(`[${time}] [${type.toUpperCase()}] ${msg}`);
}

function getReadableBlacklist() {
    const now = Date.now();
    let readable = {};
    for (const s in status.blackList) {
        const diff = status.blackList[s] - now;
        if (diff > 0) {
            const m = Math.floor(diff / 60000);
            const s_rem = Math.floor((diff % 60000) / 1000);
            readable[s] = `${m}p ${s_rem}s`;
        } else {
            delete status.blackList[s];
        }
    }
    return readable;
}

// ====================================================================
// NETWORK LAYER
// ====================================================================
async function binanceRequest(method, endpoint, data = {}) {
    const timestamp = Date.now() + serverTimeOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 10000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    const url = `${endpoint}?${query}&signature=${signature}`;
    
    try {
        const res = await binanceApi({ method, url });
        return res.data;
    } catch (e) {
        if (e.response?.data?.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time').catch(() => ({data:{serverTime: Date.now()}}));
            serverTimeOffset = t.data.serverTime - Date.now();
            return binanceRequest(method, endpoint, data);
        }
        throw e;
    }
}

// ====================================================================
// TRADE CORE (ĐỘC LẬP HOÀN TOÀN LỆNH TAY)
// ====================================================================
async function openPosition(symbol, side) {
    if (!status.isReady || !botSettings.isRunning) return;
    const info = status.exchangeInfo[symbol];
    if (!info) return;

    const positionSide = status.isHedgeMode ? side : 'BOTH';
    const orderSide = side === 'LONG' ? 'BUY' : 'SELL';

    try {
        const acc = await binanceRequest('GET', '/fapi/v2/account');
        let margin = (botSettings.invValue.includes('%')) 
            ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue) / 100) 
            : parseFloat(botSettings.invValue);

        const priceRes = await binanceRequest('GET', '/fapi/v1/ticker/price', { symbol });
        const price = parseFloat(priceRes.price);
        let qty = Number(((margin * 20) / price).toFixed(getPrecision(info.stepSize)));

        if (isNaN(qty) || qty <= 0) return;

        const botOrderId = `bot-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

        const order = await binanceRequest('POST', '/fapi/v1/order', {
            symbol, side: orderSide, positionSide, type: 'MARKET', quantity: qty, newClientOrderId: botOrderId
        });

        if (order && order.orderId) {
            addBotLog(`🎯 BOT VÀO LỆNH THÀNH CÔNG: ${symbol} [${side}]`, 'success');
            botActivePositions.set(`${symbol}_${positionSide}`, {
                symbol, side, entryPrice: price, dcaCount: 0, botOrderId, timestamp: Date.now()
            });
            saveBotStateToDisk();
        }
    } catch (e) {
        status.blackList[symbol] = Date.now() + 2 * 60000; // Lỗi thì khóa ngắn 2 phút thôi
    }
}

// Luồng đối soát kế toán chạy ngầm: KHÔNG CÓ MỘT CHỮ LOG NÀO ĐỂ TRÁNH SPAM
async function reconciliationEngine() {
    if (!status.isReady) return;
    try {
        const posRisk = await binanceRequest('GET', '/fapi/v2/positionRisk');
        const onChain = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);

        let stateChanged = false;

        // Nếu trong file ghi nhớ có vị thế, nhưng trên sàn đã biến mất (Khớp TP/SL ngầm hoặc ai đó bấm đóng tay)
        for (const [key, local] of botActivePositions.entries()) {
            const stillExists = onChain.some(p => `${p.symbol}_${p.positionSide}` === key);
            if (!stillExists) {
                botActivePositions.delete(key);
                stateChanged = true;
            }
        }

        if (stateChanged) {
            saveBotStateToDisk();
        }
    } catch (e) {
        // Lỗi mạng ngầm tự bỏ qua, không in ra màn hình làm bẩn log
    }
}

// ====================================================================
// LUỒNG QUÉT CHẠY SONG SONG TỐC ĐỘ CAO (FAST SCANNER 1S)
// ====================================================================
async function fastScanner() {
    if (!status.isReady || !botSettings.isRunning) return;
    if (botActivePositions.size >= botSettings.maxPositions) return;

    // Lọc cực nhanh các ứng viên hợp lệ
    const validCandidates = status.candidatesList.filter(c => {
        if (!status.exchangeInfo[c.symbol] || status.blackList[c.symbol] || openingSymbols.has(c.symbol)) return false;
        if (Math.abs(c.c1) < botSettings.minVol) return false;
        
        const side = c.c1 > 0 ? 'LONG' : 'SHORT';
        const posKey = `${c.symbol}_${status.isHedgeMode ? side : 'BOTH'}`;
        return !botActivePositions.has(posKey); 
    });

    if (validCandidates.length > 0) {
        // Ưu tiên con giật mạnh nhất
        const target = validCandidates.sort((a, b) => Math.abs(b.c1) - Math.abs(a.c1))[0];
        
        openingSymbols.add(target.symbol);
        runPositionLocked(target.symbol, target.c1 > 0 ? 'LONG' : 'SHORT');
    }
}

// Khóa token tạm thời để tránh luồng 1s click đúp lệnh cho cùng 1 con
async function runPositionLocked(symbol, side) {
    try {
        await openPosition(symbol, side);
    } finally {
        openingSymbols.delete(symbol);
    }
}

// ====================================================================
// API ENDPOINTS & EXPRESS SERVER
// ====================================================================
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.get('/api/status', (req, res) => {
    res.json({
        botSettings,
        activePositions: Array.from(botActivePositions.values()),
        status: { ...status, blackListReadable: getReadableBlacklist() }
    });
});

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    saveBotStateToDisk();
    res.json({ success: true });
});

async function init() {
    loadBotStateFromDisk(); // Đọc bộ nhớ cũ lên trước khi nạp API sàn
    try {
        const info = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
        info.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            if (lot) {
                status.exchangeInfo[s.symbol] = { stepSize: parseFloat(lot.stepSize) };
            }
        });
        
        const posMode = await binanceRequest('GET', '/fapi/v1/positionSide/dual').catch(() => ({dualSidePosition: true}));
        status.isHedgeMode = posMode.dualSidePosition;
        
        status.isReady = true;
        addBotLog("🚀 BOT V3.9.3 PRODUCTION ĐÃ KHỞI CHẠY - ĐÃ KHÓA LOG RÁC & CỨU DỮ LIỆU PM2.", "success");
    } catch (e) { 
        setTimeout(init, 4000); 
    }
}

init();

// Luồng quét 1s
setInterval(fastScanner, 1000);

// Luồng kéo data từ cổng 9000 (Đã bọc chống sập)
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; 
        res.on('data', c => d += c);
        res.on('end', () => { 
            try { 
                status.candidatesList = JSON.parse(d).live || []; 
            } catch(e) {} 
        });
    }).on('error', () => {
        // Cổng 9000 mất kết nối tạm thời? Bot tự lờ đi để bảo toàn tính ổn định, không báo crash bẩn console.
    });
}, 1000);

// Luồng rà soát ngầm (Tuyệt đối im lặng): 10 giây/lần
setInterval(reconciliationEngine, 10000);

APP.listen(9001, () => console.log('🌐 Web dashboard chạy tại: http://localhost:9001'));
