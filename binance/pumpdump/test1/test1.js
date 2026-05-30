import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';
import { checkEntryCondition } from './dieukien.js';

// =========================================================================
// CẤU HÌNH NHANH - CÁC THÔNG SỐ CỐ ĐỊNH HỆ THỐNG
// =========================================================================
const MAX_DCA_LEVEL = 2;            
const MARGIN_PROTECT_LIMIT = 60;    
const MARGIN_RECOVER_LIMIT = 70;    
const MARGIN_XEDAP = 1;       
const MARGIN_DIANGUC = 2;     
const RESCUE_STEP = 0.01;     
// =========================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });
const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true, 
    options: { 
        defaultType: 'future', 
        dualSidePosition: true, 
        recvWindow: 60000, 
        adjustForTimeDifference: true 
    } 
});

let botSettings = { 
    isRunning: false, 
    maxPositions: 3, 
    invValue: "1%", 
    minVol: 7, 
    posTP: 10, 
    posSL: 10.0, 
    dianguctp: 30,
    diangucsl: 10,
    diangucdca: 10,
    posdca: 3,
    diangucvol: 15,
    maxDCA: MAX_DCA_LEVEL 
};
let status = { botLogs: [], candidatesList: [], blackList: {}, permanentBlacklist: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: null, isReady: false };
let botActivePositions = new Map(); 
let isProcessingDCA = new Set();
let timestampOffset = 0;
let isMarginProtected = false; 
let currentBotIP = null; 

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    try {
        const timestamp = Date.now() + timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (e) {
        if (e.response?.data?.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            timestampOffset = t.data.serverTime - Date.now();
            return binancePrivate(endpoint, method, data);
        }
        throw e;
    }
}

setInterval(() => {
    const now = Date.now();
    for (const symbol in status.blackList) {
        if (now > status.blackList[symbol]) {
            delete status.blackList[symbol];
            addBotLog(`🔄 Unban Blacklist: ${symbol} (Đã hết 15 phút)`, "success");
        }
    }
}, 1000);

async function initBot() {
    // Quét toàn bộ coin trên sàn thay vì fix cứng 2 mã
    const symbols = Object.keys(status.exchangeInfo);
    addBotLog(`🚀 Đang cấu hình CROSS margin cho ${symbols.length} pairs...`, "info");
    
    for (const symbol of symbols) {
        await setCrossMargin(symbol);
        await new Promise(r => setTimeout(r, 150)); // Delay nhỏ tránh dính Rate Limit
    }
    
    status.isReady = true;
    priceMonitor(); 
    addBotLog(`🚀 Hoàn tất setup. Bot sẵn sàng monitor giá.`, "success");
}

async function setCrossMargin(symbol) {
    try {
        await binancePrivate('/fapi/v1/marginType', 'POST', {
            symbol: symbol,
            marginType: 'CROSSED',
            timestamp: Date.now()
        });
    } catch (error) {
        if (error.response?.data?.code !== -4046) {
            console.error(`❌ Lỗi setup CROSS cho ${symbol}:`, error.message);
        }
    }
}

async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        if (!botSettings.isRunning && botActivePositions.size > 0) {
            addBotLog(`🛑 Bot STOP. Hủy toàn bộ lệnh chờ...`, "warn");
            for (let [key, b] of botActivePositions) {
                try {
                    const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
                    for (const o of orders.filter(o => o.positionSide === b.side)) {
                        await binancePrivate('/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId });
                    }
                } catch (err) { }
            }
            botActivePositions.clear();
            isProcessingDCA.clear();
        }

        if (!botSettings.isRunning) return setTimeout(priceMonitor, 1000);

        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        
        for (let [key, b] of botActivePositions) {
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            const lockKey = `${b.symbol}_${b.side}`;

            if (realP) {
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);
                
                b.pnl = parseFloat(realP.unRealizedProfit);
                b.priceDev = ((markP - b.entryPrice) / b.entryPrice) * 100;

                if (b.currentQty !== currentQty) { 
                    b.currentQty = currentQty; 
                    b.hitTime = null; 
                }

                // CÔNG THỨC TRUNG BÌNH GIÁ CỐ TÌNH GIỮ NGUYÊN (Tính năng của tác giả)
                const avgEntry = b.dcaHistory.reduce((sum, p) => sum + p, 0) / b.dcaHistory.length;

                // 1. Cắt lỗ vùng hòa vốn
                if (b.dcaCount > 0 || b.isFinalLong) {
                    let isViolation = false;
                    if (b.side === 'LONG' && markP < avgEntry) isViolation = true;
                    if (b.side === 'SHORT' && markP > avgEntry) isViolation = true;

                    if (isViolation) {
                        addBotLog(`⚠️ [CẮT LỖ VÙNG HÒA VỐN] ${b.symbol} (${b.side})`, "warn");
                        await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', currentQty, undefined, { positionSide: b.side });
                        botActivePositions.delete(key);
                        status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000); // Đóng là ban
                        continue;
                    }
                }

                // 2. Chốt lời hòa vốn (Cứu thương)
                const x = b.dcaCount; 
                let isCuuThuongTriggered = false;
                if (b.side === 'LONG' && markP >= (avgEntry * (1 + x / 100))) isCuuThuongTriggered = true;
                if (b.side === 'SHORT' && markP <= (avgEntry * (1 - x / 100))) isCuuThuongTriggered = true;

                if (isCuuThuongTriggered && b.dcaCount > 0) {
                    addBotLog(`🛡️ [CỨU THƯƠNG THÀNH CÔNG] ${b.symbol}`, "success");
                    await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', currentQty, undefined, { positionSide: b.side });
                    botActivePositions.delete(key);
                    status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000); // Đóng là ban
                    continue;
                }

                // Kiểm tra TP/SL cứng
                const hitTP = (b.side === 'SHORT' && markP <= b.tp) || (b.side === 'LONG' && markP >= b.tp);
                const hitSL = (b.side === 'SHORT' && markP >= b.sl) || (b.side === 'LONG' && markP <= b.sl);

                if (hitTP || hitSL) {
                    if (!b.hitTime) b.hitTime = Date.now();
                    if (Date.now() - b.hitTime > 30000) {
                        addBotLog(`⚠️ Treo lệnh >30s tại ${b.symbol}. Ép đóng MARKET!`, "warn");
                        await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', currentQty, undefined, { positionSide: b.side });
                    }
                } else { b.hitTime = null; }

                // 3. Logic DCA Tăng cường
                const priceDevAbs = Math.abs(b.priceDev);
                const jump = b.dcaCount + 1;
                const dcaThreshold = b.isDiangucMode ? botSettings.diangucdca : botSettings.posdca;

                if (priceDevAbs >= dcaThreshold && jump <= botSettings.maxDCA) {
                    let marginToUse = b.isDiangucMode ? b.firstMargin * (jump * 2) : b.firstMargin;
                    addBotLog(`🚀 [DCA ${b.isDiangucMode ? 'ĐỊA NGỤC' : 'XE ĐẠP'}] ${b.symbol} lần ${jump}`, "info");
                    openPosition(b.symbol, { ...b, dcaCount: jump, margin: marginToUse, dcaHistory: [...b.dcaHistory, markP] }, b.side, 0);
                }

            } else {
                // Đã bị đóng (TP/SL/Manual) -> Tính PnL và BAN blacklist
                if (isProcessingDCA.has(lockKey)) continue;

                await new Promise(r => setTimeout(r, 1000));
                
                try {
                    const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
                    for (const o of openOrders.filter(o => o.positionSide === b.side)) {
                        await binancePrivate('/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId });
                    }
                } catch(e){}

                botActivePositions.delete(key);
                status.botClosedCount++; 
                
                // BẤT KỂ LÝ DO GÌ, VỊ THẾ BỊ ĐÓNG THÌ BAN BLACKLIST 15 PHÚT
                status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                addBotLog(`🔒 [ĐÃ ĐÓNG] ${b.symbol} bị ban 15 phút.`, "warn");
            }
        }
    } catch (e) { console.error("Monitor Err:", e.message); }
    setTimeout(priceMonitor, 1000);
}

async function openPosition(symbol, dcaData = null, forcedSide = null, vol = 0) {
    const side = forcedSide || (dcaData ? dcaData.side : 'SHORT'); 
    const isDCAorLong = dcaData !== null;
    const lockKey = `${symbol}_${side}`;
    
    if (isProcessingDCA.has(lockKey)) return;
    isProcessingDCA.add(lockKey); 
    
    try {
        const info = status.exchangeInfo[symbol];
        await new Promise(r => setTimeout(r, 1000));
        
        const acc = await binancePrivate('/fapi/v2/account');
        if (!acc) throw new Error("Không lấy được account data.");

        const availableUsdt = parseFloat(acc.availableBalance || 0);
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);

        const currentVol = vol || (dcaData?.vol || 0);
        const isDianguc = (currentVol >= botSettings.diangucvol);
        
        let qty = 0;
        let margin = 0;

        if (isDCAorLong) {
            margin = dcaData.margin;
            if ((margin * info.maxLeverage) < 6.5) margin = 6.5 / info.maxLeverage;
            qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        } else {
            margin = botSettings.invValue.toString().includes('%') 
                ? (availableUsdt * parseFloat(botSettings.invValue) / 100) 
                : parseFloat(botSettings.invValue);

            const desiredQty = (margin * info.maxLeverage) / currentPrice;
            const minQtyRequiredByFloor = 5.05 / currentPrice; 
            qty = Math.ceil(Math.max(desiredQty, minQtyRequiredByFloor) / info.stepSize) * info.stepSize;
        }

        const actualMarginUsed = (qty * currentPrice) / info.maxLeverage;
        await exchange.setLeverage(info.maxLeverage, symbol);

        const order = await exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            await new Promise(r => setTimeout(r, 1500));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const p = pRisk.find(x => x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0);
            
            if (p) {
                const entry = parseFloat(p.entryPrice);
                const firstE = dcaData ? dcaData.firstEntry : entry;
                const dcaCount = dcaData ? dcaData.dcaCount : 0;
                const dcaHistory = dcaData ? [...dcaData.dcaHistory, entry] : [entry];
                const simpleAvgEntry = dcaHistory.reduce((sum, p) => sum + p, 0) / dcaHistory.length;
                const accumulatedLoss = dcaData?.totalLossAccumulated || 0;

                let tp, sl;
                const dir = (side === 'LONG') ? 1 : -1;

                if (dcaData?.isFinalLong) {
                    tp = entry * (1 + (dir * 0.05)); 
                    sl = entry * (1 - (dir * 0.05));
                } else {
                    const targetProfit = (dcaCount + 1) * (qty * entry * (botSettings.posTP / 100));
                    tp = simpleAvgEntry + (dir * ((accumulatedLoss + targetProfit) / qty));
                    sl = entry * (1 - (dir * (botSettings.posSL * (dcaCount + 1) / 100)));
                }

                const sync = await syncTPSL(symbol, side, info, tp, sl);

                botActivePositions.set(lockKey, { 
                    symbol, side, entryPrice: entry, tp: sync.tp, sl: sync.sl, dcaCount: dcaCount, 
                    leverage: info.maxLeverage, firstEntry: firstE, firstMargin: dcaData ? dcaData.firstMargin : actualMarginUsed, 
                    currentMargin: actualMarginUsed, currentQty: qty, dcaHistory: dcaHistory,
                    isFinalLong: dcaData?.isFinalLong || false, isDiangucMode: isDianguc, pnl: 0, priceDev: 0, hitTime: null,
                    totalLossAccumulated: accumulatedLoss
                });
                
                const modeStr = isDCAorLong ? (dcaData.isFinalLong ? 'LONG_CỨU' : `DCA_${dcaData.dcaCount}`) : 'OPEN';
                addBotLog(`📡 [${modeStr}] ${symbol} | ${side} | M: ${actualMarginUsed.toFixed(2)}$ | E: ${entry} | TP: ${sync.tp.toFixed(info.pricePrecision)}`);
            }
        }
    } catch (e) { 
        addBotLog(`❌ Lỗi vị thế ${symbol}: ${e.message}`, "error"); 
    } finally { 
        setTimeout(() => isProcessingDCA.delete(lockKey), 3000); 
    }
}

async function syncTPSL(symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    try {
        const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of orders.filter(o => o.positionSide === side)) await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
        await new Promise(r => setTimeout(r, 600));
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: tpPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: slPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
        return { tp: tpPrice, sl: slPrice };
    } catch (e) { return { tp: 0, sl: 0 }; }
}

const APP = express(); 
APP.use(express.json()); 
APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    const visualBlacklist = {};
    const now = Date.now();
    for (const s in status.blackList) {
        const remainingTime = status.blackList[s] - now;
        if (remainingTime > 0) {
            visualBlacklist[s] = `${Math.floor(remainingTime / 60000)}m ${Math.floor((remainingTime % 60000) / 1000)}s`;
        }
    }

    res.json({ 
        botSettings, 
        activePositions: Array.from(botActivePositions.values()), 
        status: { ...status, blackList: visualBlacklist }, 
        wallet: acc ? { 
            totalWalletBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2), 
            availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), 
            totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) 
        } : { totalWalletBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" } 
    });
});

APP.post('/api/settings', (req, res) => { 
    botSettings = { ...botSettings, ...req.body }; 
    botSettings.maxDCA = parseInt(botSettings.maxDCA || MAX_DCA_LEVEL);
    botSettings.maxPositions = parseInt(botSettings.maxPositions);
    botSettings.minVol = parseFloat(botSettings.minVol);
    botSettings.diangucvol = parseFloat(botSettings.diangucvol); 
    addBotLog(`⚙️ Đã cập nhật cấu hình.`, "success");
    res.json({ success: true }); 
});

// ==========================================
// API MỚI DÀNH CHO NÚT ĐÓNG LỆNH TRÊN FRONTEND
// ==========================================
APP.post('/api/close_position', async (req, res) => {
    const { symbol, side } = req.body;
    const key = `${symbol}_${side}`;
    const b = botActivePositions.get(key);
    
    if (!b) return res.json({ success: false, msg: "Không tìm thấy lệnh trong DB Bot" });

    try {
        await exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', b.currentQty, undefined, { positionSide: side });
        botActivePositions.delete(key);
        status.blackList[symbol] = Date.now() + (15 * 60 * 1000);
        addBotLog(`🛑 UI Đóng lệnh thủ công: ${symbol} (${side})`, "warn");
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, msg: e.message });
    }
});

APP.post('/api/close_all', async (req, res) => {
    try {
        let count = 0;
        for (let [key, b] of botActivePositions) {
            await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', b.currentQty, undefined, { positionSide: b.side });
            botActivePositions.delete(key);
            status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
            count++;
        }
        addBotLog(`🛑 UI PANIC Đóng toàn bộ ${count} lệnh`, "warn");
        res.json({ success: true, count });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});
// ==========================================

async function init() {
    try {
        const ipRes = await axios.get('https://api4.ipify.org?format=json', { timeout: 8000 }).catch(() => ({ data: { ip: "127.0.0.1" } }));
        currentBotIP = ipRes.data.ip; 
        
        const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = t.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate('/fapi/v1/leverageBracket');
        const temp = {};
        
        info.data.symbols.forEach(s => {
            if (s.status !== 'TRADING') return; // Bỏ coin đang bảo trì
            const b = brk.find(x => x.symbol === s.symbol);
            const maxLev = b?.brackets[0]?.initialLeverage || 20;
            if (maxLev < 20) { status.permanentBlacklist[s.symbol] = true; return; }
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), maxLeverage: maxLev };
        });
        status.exchangeInfo = temp; 
        
        // GỌI INITBOT ĐỂ QUÉT CROSS & BẮT ĐẦU CHẠY
        initBot(); 
    } catch (e) { setTimeout(init, 5000); }
}

init();

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

setInterval(async () => {
    if (!status.isReady || !botSettings.isRunning) return;

    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    if (acc) {
        const totalWallet = parseFloat(acc.totalMarginBalance || 0);
        const availableUsdt = parseFloat(acc.availableBalance || 0);
        
        if (totalWallet > 0) {
            const availPercent = (availableUsdt / totalWallet) * 100;
            if (!isMarginProtected && availPercent < MARGIN_PROTECT_LIMIT) {
                isMarginProtected = true;
                addBotLog(`🚨 [MARGIN_WARN] Đóng băng quét mới. Khả dụng: ${availPercent.toFixed(1)}%`, "error");
            } else if (isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) {
                isMarginProtected = false;
                addBotLog(`🛡️ [MARGIN_OK] Tiếp tục quét lệnh. Khả dụng: ${availPercent.toFixed(1)}%`, "success");
            }
        }
    }

    if (isMarginProtected) return;

    if (botActivePositions.size < botSettings.maxPositions && isProcessingDCA.size === 0) {
        const entryData = status.candidatesList.find(c => checkEntryCondition(c, botSettings, status, botActivePositions));
        if (entryData) {
            const vol = entryData.vol || 0; 
            addBotLog(`🎯 [MỤC TIÊU] ${entryData.symbol} | Vol: ${vol}%`, "info");
            openPosition(entryData.symbol, null, entryData.side, vol);
        }
    }
}, 3000); 

setInterval(async () => {
    if (!status.isReady || !currentBotIP) return; 
    try {
        const ipCheckRes = await axios.get('https://api4.ipify.org?format=json', { timeout: 5000 });
        const newIP = ipCheckRes.data.ip;
        if (newIP && newIP !== currentBotIP) {
            addBotLog(`⚠️ [NETWORK] IP CHANGE! Cũ: ${currentBotIP} -> Mới: ${newIP}`, "warn");
            currentBotIP = newIP; 
        }
    } catch (err) {} 
}, 30000);

APP.listen(80, () => {
    console.log("Server bot backend listening on port 80...");
});
