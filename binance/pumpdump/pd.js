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
    timeout: 10000, 
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
let lastUserWsTime = Date.now();

// ====================================================================
// CORE UTILS
// ====================================================================
function getPrecision(stepSize) {
    const step = stepSize.toString();
    return step.includes('.') ? step.split('.')[1].replace(/0+$/, '').length : 0;
}

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    console.log(`[${time}] [${type.toUpperCase()}] ${msg}`);
}

// [FIX 2]: Hàm định dạng đếm ngược Blacklist
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

function saveBotStateToDisk() {
    try {
        const state = {
            botActivePositions: Array.from(botActivePositions.entries()),
            blackList: status.blackList,
            botClosedCount: status.botClosedCount,
            botPnLClosed: status.botPnLClosed,
            botSettings
        };
        fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state), 'utf8');
    } catch (e) {}
}

function loadBotStateFromDisk() {
    try {
        if (fs.existsSync(STATE_FILE_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf8'));
            if (parsed.botActivePositions) botActivePositions = new Map(parsed.botActivePositions);
            status.blackList = parsed.blackList || {};
            status.botClosedCount = parsed.botClosedCount || 0;
            status.botPnLClosed = parsed.botPnLClosed || 0;
            botSettings = parsed.botSettings || botSettings;
        }
    } catch (e) {}
}

// ====================================================================
// BINANCE API CORE
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
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            serverTimeOffset = t.data.serverTime - Date.now();
            return binanceRequest(method, endpoint, data);
        }
        throw e;
    }
}

// ====================================================================
// TRADING LOGIC (FIX 1: CHỈ QUẢN LÝ LỆNH BOT)
// ====================================================================
async function openPosition(symbol, side) {
    if (!status.isReady || !botSettings.isRunning) return;
    const info = status.exchangeInfo[symbol];
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

        // Gán ClientOrderId có tiền tố "bot-" để phân biệt tuyệt đối
        const botOrderId = `bot-${Date.now()}`;

        const order = await binanceRequest('POST', '/fapi/v1/order', {
            symbol, side: orderSide, positionSide, type: 'MARKET', quantity: qty, newClientOrderId: botOrderId
        });

        if (order.orderId) {
            addBotLog(`✅ BOT MỞ LỆNH: ${symbol} [${side}] - ID: ${botOrderId}`, 'success');
            // Đưa vào quản lý nội bộ
            botActivePositions.set(`${symbol}_${positionSide}`, {
                symbol, side, entryPrice: price, dcaCount: 0, botOrderId
            });
            saveBotStateToDisk();
        }
    } catch (e) {
        status.blackList[symbol] = Date.now() + 5 * 60000;
        addBotLog(`❌ Lỗi mở lệnh ${symbol}: ${e.message}`, 'error');
    }
}

// [FIX 1]: Rà soát chỉ xử lý những gì Bot mở
async function reconciliationEngine() {
    try {
        const posRisk = await binanceRequest('GET', '/fapi/v2/positionRisk');
        // Chỉ lọc những vị thế đang mở
        const onChain = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);

        // 1. Nếu Bot nghĩ mình đang có lệnh, nhưng sàn báo không có -> Chốt sổ nội bộ
        for (const [key, local] of botActivePositions.entries()) {
            if (!onChain.some(p => `${p.symbol}_${p.positionSide}` === key)) {
                addBotLog(`ℹ️ Bot tự giải phóng vị thế ${local.symbol} (Sàn đã đóng).`);
                botActivePositions.delete(key);
            }
        }
        saveBotStateToDisk();
    } catch (e) {}
}

// ====================================================================
// [FIX 3]: LUỒNG QUÉT SIÊU TỐC 1S
// ====================================================================
async function fastScanner() {
    if (!status.isReady || !botSettings.isRunning) return;
    
    // Check maxPositions chỉ tính dựa trên botActivePositions (Lệnh tay kệ nó)
    if (botActivePositions.size >= botSettings.maxPositions) return;

    // Lọc nhanh ứng viên
    const candidates = status.candidatesList.filter(c => {
        if (status.blackList[c.symbol] || openingSymbols.has(c.symbol)) return false;
        if (Math.abs(c.c1) < botSettings.minVol) return false;
        const side = c.c1 > 0 ? 'LONG' : 'SHORT';
        const posKey = `${c.symbol}_${status.isHedgeMode ? side : 'BOTH'}`;
        return !botActivePositions.has(posKey);
    });

    if (candidates.length > 0) {
        // Lấy con biến động mạnh nhất trong danh sách
        const best = candidates.sort((a, b) => Math.abs(b.c1) - Math.abs(a.c1))[0];
        
        openingSymbols.add(best.symbol);
        await openPosition(best.symbol, best.c1 > 0 ? 'LONG' : 'SHORT');
        openingSymbols.delete(best.symbol);
    }
}

// ====================================================================
// SYSTEM INIT
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
    loadBotStateFromDisk();
    try {
        const info = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
        info.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            status.exchangeInfo[s.symbol] = { stepSize: parseFloat(lot.stepSize) };
        });
        status.isReady = true;
        addBotLog("🚀 BOT V3.9.2 ĐÃ SẴN SÀNG - CHẾ ĐỘ ĐỘC LẬP LỆNH TAY.");
    } catch (e) { setTimeout(init, 5000); }
}

init();

// Luồng quét tín hiệu: 1 giây/lần
setInterval(fastScanner, 1000);

// Luồng lấy dữ liệu gốc: 1 giây/lần
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1000);

// Rà soát sàn (Kế toán): 10 giây/lần cho nhẹ máy
setInterval(reconciliationEngine, 10000);

APP.listen(9001, () => console.log('Sẵn sàng tại http://localhost:9001'));
