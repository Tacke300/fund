import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs'; 
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE_PATH = path.join(__dirname, 'bot_state_persistent.json');

const binanceApi = axios.create({ 
    baseURL: 'https://fapi.binance.com', 
    timeout: 5000, 
    headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' } 
});

// SYSTEM STATES
let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 0.1, posTP: 1.2, posSL: 10.0, maxDCA: 5 };
let status = { botLogs: [], candidatesList: [], blackList: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: {}, isReady: false, isHedgeMode: true };

let botActivePositions = new Map(); 
let openingSymbols = new Set();     
let serverTimeOffset = 0;

// ====================================================================
// STORAGE ENGINE - BẢO TOÀN TRẠNG THÁI KHI RESTART PM2
// ====================================================================
function saveBotStateToDisk() {
    try {
        const state = {
            botActivePositions: Array.from(botActivePositions.entries()),
            blackList: status.blackList,
            botClosedCount: status.botClosedCount,
            botPnLClosed: status.botPnLClosed,
            botSettings
        };
        fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {}
}

function loadBotStateFromDisk() {
    try {
        if (fs.existsSync(STATE_FILE_PATH)) {
            const raw = fs.readFileSync(STATE_FILE_PATH, 'utf8');
            if (!raw || raw.trim() === "") return;
            const parsed = JSON.parse(raw);
            if (parsed.botActivePositions && Array.isArray(parsed.botActivePositions)) {
                botActivePositions = new Map(parsed.botActivePositions);
            }
            status.blackList = parsed.blackList || {};
            status.botClosedCount = parsed.botClosedCount || 0;
            status.botPnLClosed = parsed.botPnLClosed || 0;
            if (parsed.botSettings) botSettings = { ...botSettings, ...parsed.botSettings };
            addBotLog(`💾 [RECOVERY] Đã nạp lại ${botActivePositions.size} vị thế bot từ file cấu hình cũ.`, 'success');
        }
    } catch (e) {
        addBotLog("⚠️ Không thể đọc file trạng thái cũ, dùng cấu hình mặc định.", "warning");
    }
}

function getPrecision(stepSize) {
    const step = stepSize.toString();
    return step.includes('.') ? step.split('.')[1].replace(/0+$/, '').length : 0;
}

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 40) status.botLogs.pop();
    console.log(`[${time}] [${type.toUpperCase()}] ${msg}`);
}

// Hàm format đếm ngược trả dữ liệu sạch về cho API (để file index.html của ông bóc tách)
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
// TRADE CORE - ĐỘC LẬP VỚI LỆNH TAY TRÊN SÀN
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

        // Đóng dấu nhận diện vị thế của bot bằng clientOrderId riêng biệt
        const botOrderId = `bot-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

        const order = await binanceRequest('POST', '/fapi/v1/order', {
            symbol, side: orderSide, positionSide, type: 'MARKET', quantity: qty, newClientOrderId: botOrderId
        });

        if (order && order.orderId) {
            addBotLog(`🎯 BOT VÀO LỆNH THÀNH CÔNG: ${symbol} [${side}]`, 'success');
            botActivePositions.set(`${symbol}_${positionSide}`, {
                symbol, side, entryPrice: price, botOrderId, timestamp: Date.now()
            });
            saveBotStateToDisk();
        }
    } catch (e) {
        status.blackList[symbol] = Date.now() + 2 * 60000;
    }
}

// Rà soát kế toán ngầm - IM LẶNG TUYỆT ĐỐI KHÔNG IN LOG BẨN CONSOLE
async function reconciliationEngine() {
    if (!status.isReady) return;
    try {
        const posRisk = await binanceRequest('GET', '/fapi/v2/positionRisk');
        const onChain = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        let stateChanged = false;

        for (const [key, local] of botActivePositions.entries()) {
            const stillExists = onChain.some(p => `${p.symbol}_${p.positionSide}` === key);
            if (!stillExists) {
                botActivePositions.delete(key);
                stateChanged = true;
            }
        }
        if (stateChanged) saveBotStateToDisk();
    } catch (e) {}
}

// Luồng xử lý quét tín hiệu tốc độ cao 1 giây
async function fastScanner() {
    if (!status.isReady || !botSettings.isRunning) return;
    if (botActivePositions.size >= botSettings.maxPositions) return;

    const validCandidates = status.candidatesList.filter(c => {
        if (!status.exchangeInfo[c.symbol] || status.blackList[c.symbol] || openingSymbols.has(c.symbol)) return false;
        if (Math.abs(c.c1) < botSettings.minVol) return false;
        
        const side = c.c1 > 0 ? 'LONG' : 'SHORT';
        const posKey = `${c.symbol}_${status.isHedgeMode ? side : 'BOTH'}`;
        return !botActivePositions.has(posKey); 
    });

    if (validCandidates.length > 0) {
        const target = validCandidates.sort((a, b) => Math.abs(b.c1) - Math.abs(a.c1))[0];
        openingSymbols.add(target.symbol);
        try {
            await openPosition(target.symbol, target.c1 > 0 ? 'LONG' : 'SHORT');
        } finally {
            openingSymbols.delete(target.symbol);
        }
    }
}

// ====================================================================
// EXPRESS SERVER - GỌI ĐÚNG FILE INDEX.HTML GỐC CỦA ÔNG
// ====================================================================
const APP = express();
APP.use(express.json());

// Chỉ định Express lấy tài nguyên tĩnh từ thư mục hiện tại
APP.use(express.static(__dirname));

// TRẢ VỀ ĐÚNG FILE INDEX.HTML CỦA ÔNG
APP.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Endpoint API để file index.html của ông fetch gọi lấy data realtime
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
    loadBotStateFromDisk();
    try {
        const info = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
        info.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            if (lot) status.exchangeInfo[s.symbol] = { stepSize: parseFloat(lot.stepSize) };
        });
        const posMode = await binanceRequest('GET', '/fapi/v1/positionSide/dual').catch(() => ({dualSidePosition: true}));
        status.isHedgeMode = posMode.dualSidePosition;
        status.isReady = true;
        addBotLog("🚀 BOT ENGINE V3.9.5 KHỞI CHẠY THÀNH CÔNG - ĐÃ TRẢ LẠI FILE INDEX.HTML GỐC.", "success");
    } catch (e) { setTimeout(init, 4000); }
}

init();

// Kích hoạt toàn bộ luồng xử lý ngầm định kỳ
setInterval(fastScanner, 1000);
setInterval(reconciliationEngine, 10000);

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1000);

APP.listen(9001, () => console.log('🌐 Web dashboard đang đọc file index.html tại cổng 9001'));
