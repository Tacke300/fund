import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import ccxt from 'ccxt';

const MAX_DCA_LEVEL = 2;           
const MARGIN_PROTECT_LIMIT = 60;    
const MARGIN_RECOVER_LIMIT = 70;    

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, 'config.json');

let currentApiKey = "";
let currentSecretKey = "";

// Hàm tự động đọc cấu hình khi khởi động bot
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
            const data = JSON.parse(raw);
            if (data.apiKey) currentApiKey = data.apiKey.trim();
            if (data.secretKey) currentSecretKey = data.secretKey.trim();
        }
    } catch (e) {}
}

// Hàm lưu cấu hình dạng text thô vào config.json (Không log gì ra màn hình)
function saveConfig(apiKey, secretKey) {
    try {
        const data = { apiKey: apiKey.trim(), secretKey: secretKey.trim() };
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 4), 'utf8');
    } catch (e) {}
}

loadConfig(); // Đọc cấu hình ngay khi chạy file

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000 });

let exchange = null;
function initCCXT() {
    if (!currentApiKey || !currentSecretKey) return;
    exchange = new ccxt.binance({ 
        apiKey: currentApiKey, 
        secret: currentSecretKey, 
        enableRateLimit: true, 
        options: { 
            defaultType: 'future', 
            dualSidePosition: true, 
            recvWindow: 60000, 
            adjustForTimeDifference: true 
        } 
    });
}

if (currentApiKey && currentSecretKey) {
    initCCXT();
    binanceApi.defaults.headers['X-MBX-APIKEY'] = currentApiKey;
}

let botSettings = { isRunning: false, maxPositions: 3, invValue: "0.1%", minVol: 2, posTP: 2.1, posSL: 10.0, maxDCA: MAX_DCA_LEVEL };
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
        const signature = crypto.createHmac('sha256', currentSecretKey).update(query).digest('hex');
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

async function fetchExchangeData() {
    try {
        const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = t.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate('/fapi/v1/leverageBracket');
        const temp = {};
        
        info.data.symbols.forEach(s => {
            const b = brk.find(x => x.symbol === s.symbol);
            const maxLev = b?.brackets[0]?.initialLeverage || 20;
            if (maxLev < 20) { 
                status.permanentBlacklist[s.symbol] = true; 
                return; 
            }
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), maxLeverage: maxLev };
        });
        status.exchangeInfo = temp;
        status.isReady = true;
        addBotLog(`🚀 Hệ thống dữ liệu thị trường đã đồng bộ và sẵn sàng.`);
    } catch (e) {
        addBotLog(`❌ Lỗi đồng bộ dữ liệu Binance, thử lại sau 5 giây...`, "error");
        setTimeout(fetchExchangeData, 5000);
    }
}

setInterval(() => {
    const now = Date.now();
    for (const symbol in status.blackList) {
        if (now > status.blackList[symbol]) {
            delete status.blackList[symbol];
            addBotLog(`🔄 Unban Blacklist: ${symbol} (Đã hết thời gian phạt 15 phút)`, "success");
        }
    }
}, 1000);

async function priceMonitor() {
    if (!status.isReady || !status.exchangeInfo) return setTimeout(priceMonitor, 1000);
    try {
        if (!botSettings.isRunning && botActivePositions.size > 0) {
            addBotLog(`🛑 Bot STOP. Hủy toàn bộ TP/SL đang treo...`, "warn");
            for (let [key, b] of botActivePositions) {
                try {
                    const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
                    for (const o of orders.filter(o => o.positionSide === b.side)) {
                        await binancePrivate('/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId });
                    }
                } catch (err) { console.error(`Lỗi hủy: ${b.symbol}`, err.message); }
            }
            botActivePositions.clear();
            isProcessingDCA.clear();
        }

        if (!botSettings.isRunning) return setTimeout(priceMonitor, 1000);

        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        
        for (let [key, b] of botActivePositions) {
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realP) {
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);
                
                b.pnl = parseFloat(realP.unRealizedProfit);
                b.priceDev = ((markP - b.entryPrice) / b.entryPrice) * 100;

                if (b.currentQty !== currentQty) { 
                    b.currentQty = currentQty; 
                    b.hitTime = null; 
                }

                const hitTP = (b.side === 'SHORT' && markP <= b.tp) || (b.side === 'LONG' && markP >= b.tp);
                const hitSL = (b.side === 'SHORT' && markP >= b.sl) || (b.side === 'LONG' && markP <= b.sl);

                if (hitTP || hitSL) {
                    if (!b.hitTime) b.hitTime = Date.now();
                    if (Date.now() - b.hitTime > 30000) {
                        addBotLog(`⚠️ Treo lệnh >30s tại ${b.symbol}. Ép đóng MARKET!`, "warn");
                        await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', currentQty, undefined, { positionSide: b.side });
                    }
                } else { b.hitTime = null; }
            } else {
                if (isProcessingDCA.has(b.symbol)) continue;

                await new Promise(r => setTimeout(r, 1000));

                const allOrders = await binancePrivate('/fapi/v1/allOrders', 'GET', { symbol: b.symbol, limit: 10 });
                const closedById = allOrders.find(o => o.positionSide === b.side && o.status === 'FILLED' && (o.type === 'STOP_MARKET' || o.type === 'TAKE_PROFIT_MARKET'));

                let reasonOfClose = "MANUAL"; 
                if (closedById) {
                    reasonOfClose = closedById.type === 'STOP_MARKET' ? "SL_MARKET" : "TP_MARKET";
                }

                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 10 });
                const recent = trades.filter(t => t.time > (Date.now() + timestampOffset - 45000));
                
                try {
                    const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
                    for (const o of openOrders.filter(o => o.positionSide === b.side)) {
                        await binancePrivate('/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId });
                    }
                } catch(e){}

                let totalR = 0, totalV = 0, avgClosePrice = 0;
                if (recent.length > 0) {
                    recent.forEach(t => { totalR += parseFloat(t.realizedPnl); totalV += (parseFloat(t.price) * parseFloat(t.qty)); });
                    avgClosePrice = totalV / recent.reduce((acc, t) => acc + parseFloat(t.qty), 0);
                }
                const fee = totalV * 0.0005; 
                const netPnl = totalR - fee;

                botActivePositions.delete(key);
                status.botClosedCount++; 
                status.botPnLClosed += netPnl;

                const isFinalLong = b.isFinalLong === true; 
                if (netPnl > 0) {
                    status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                } else {
                    if (isFinalLong) {
                        status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                    } else {
                        addBotLog(`🔄 ${b.symbol} dính SL vị thế SHORT. Tiếp tục chuỗi lệnh, KHÔNG đưa vào Blacklist.`, "warn");
                    }
                }

                const logType = netPnl > 0 ? "💰 [CHỐT LỜI]" : "📉 [CẮT LỖ]";
                const logStatus = netPnl > 0 ? "success" : "error";
                addBotLog(`${logType} ${b.symbol} | ${b.side} | DCA: ${b.dcaCount}/${botSettings.maxDCA} | ClosePrice: ${avgClosePrice.toFixed(5)} | PnL: ${netPnl.toFixed(4)}$ | Type: ${reasonOfClose}`, logStatus);

                if (netPnl < 0 && b.side === 'SHORT') {
                    const jump = b.dcaCount + 1;
                    if (jump <= botSettings.maxDCA) {
                        openPosition(b.symbol, { ...b, dcaCount: jump, margin: b.firstMargin * (jump + 1) });
                    } else {
                        openPosition(b.symbol, { ...b, isFinalLong: true, margin: b.firstMargin * 10 });
                    }
                }
            }
        }
    } catch (e) { console.error("Monitor Err:", e.message); }
    setTimeout(priceMonitor, 1000);
}

async function openPosition(symbol, dcaData = null) {
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol); 
    
    const isDCAorLong = dcaData !== null;
    const side = dcaData?.isFinalLong ? 'LONG' : 'SHORT';
    
    try {
        const info = status.exchangeInfo[symbol];
        await new Promise(r => setTimeout(r, 1000));
        
        const acc = await binancePrivate('/fapi/v2/account');
        if (!acc) throw new Error("Không lấy được dữ liệu tài khoản.");

        const availableUsdt = parseFloat(acc.availableBalance || 0);
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);

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

            const finalQtyBeforeRound = Math.max(desiredQty, minQtyRequiredByFloor);
            qty = Math.ceil(finalQtyBeforeRound / info.stepSize) * info.stepSize;

            if (qty < info.stepSize) qty = info.stepSize;
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
                const sumPrices = dcaHistory.reduce((sum, p) => sum + p, 0);
                const simpleAvgEntry = sumPrices / dcaHistory.length;

                let tp = 0, sl = 0;
                if (side === 'LONG') {
                    tp = entry * 1.05;
                    sl = entry * 0.95;
                } else {
                    tp = simpleAvgEntry * (1 - botSettings.posTP / 100);
                    sl = firstE + (firstE * (botSettings.posSL * (dcaCount + 1)) / 100);
                }

                const sync = await syncTPSL(symbol, side, info, tp, sl);
                botActivePositions.set(`${symbol}_${side}`, { 
                    symbol, side, entryPrice: entry, tp: sync.tp, sl: sync.sl, 
                    dcaCount: dcaCount, leverage: info.maxLeverage, firstEntry: firstE, 
                    firstMargin: dcaData ? dcaData.firstMargin : actualMarginUsed, currentMargin: actualMarginUsed, 
                    currentQty: qty, virtualTotalQty: qty, virtualTotalCost: qty * entry, 
                    dcaHistory: dcaHistory, isFinalLong: dcaData?.isFinalLong || false,
                    pnl: 0, priceDev: 0, hitTime: null 
                });
                
                const modeStr = isDCAorLong ? (dcaData.isFinalLong ? 'LONG' : `DCA_${dcaData.dcaCount}`) : 'OPEN';
                addBotLog(`📡 [${modeStr}] ${symbol} | ${side} | Lev: x${info.maxLeverage} | Margin: ${actualMarginUsed.toFixed(2)}$ | Entry: ${entry} | TP: ${sync.tp.toFixed(info.pricePrecision)} | SL: ${sync.sl.toFixed(info.pricePrecision)}`);
            }
        }
    } catch (e) { 
        addBotLog(`❌ Lỗi vị thế ${symbol}: ${e.message}`, "error"); 
    } finally { 
        setTimeout(() => isProcessingDCA.delete(symbol), 2000); 
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

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    if (!currentApiKey || !currentSecretKey || !status.exchangeInfo) {
        return res.json({ botSettings, activePositions: [], status, wallet: { totalWalletBalance: "0.00", availableBalance: "NO_API", totalUnrealizedProfit: "0.00" } });
    }
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    
    const visualBlacklist = {};
    const now = Date.now();
    for (const s in status.blackList) {
        const expireTime = Number(status.blackList[s]); // Sửa lỗi ép kiểu tránh dính số NaN
        const remainingTime = expireTime - now;
        if (remainingTime > 0 && !isNaN(remainingTime)) {
            const m = Math.floor(remainingTime / 60000);
            const sRemainder = Math.floor((remainingTime % 60000) / 1000);
            visualBlacklist[s] = `${m}m ${sRemainder}s`;
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
        } : { totalWalletBalance: "0.00", availableBalance: "ERR", totalUnrealizedProfit: "0.00" } 
    });
});

APP.post('/api/settings', async (req, res) => { 
    if (req.body.apiKey !== undefined && req.body.secretKey !== undefined) {
        currentApiKey = req.body.apiKey.trim();
        currentSecretKey = req.body.secretKey.trim();
        
        // Gọi hàm lưu file cứng dạng text và KHÔNG sinh ra bất cứ dòng log nào
        saveConfig(currentApiKey, currentSecretKey);

        binanceApi.defaults.headers['X-MBX-APIKEY'] = currentApiKey;
        initCCXT();
        addBotLog(`⚙️ Đã lưu cấu hình API mới.`, "success");
        
        status.isReady = false; 
        fetchExchangeData();
    }

    botSettings = { ...botSettings, ...req.body }; 
    if (req.body.maxDCA !== undefined) botSettings.maxDCA = parseInt(botSettings.maxDCA);
    if (req.body.maxPositions !== undefined) botSettings.maxPositions = parseInt(botSettings.maxPositions);
    if (req.body.minVol !== undefined) botSettings.minVol = parseFloat(botSettings.minVol);
    
    res.json({ success: true }); 
});

async function init() {
    try {
        console.log("\n=================================================================");
        console.log("Chào mừng bạn đến với Moncey_D_Luffy chúc bạn luôn rực rỡ !!!");
        console.log("=================================================================\n");
        addBotLog(`✨ Chào mừng bạn đến với Moncey_D_Luffy chúc bạn luôn rực rỡ !!!`, "success");

        const ipRes = await axios.get('https://api4.ipify.org?format=json', { timeout: 8000 }).catch(() => ({ data: { ip: "127.0.0.1" } }));
        currentBotIP = ipRes.data.ip; 
        
        console.log(`\n🌍 IP INITIALIZED: ${currentBotIP}`);
        addBotLog(`🌍 IP START: ${currentBotIP}`, "success"); 
        
        priceMonitor();

        if (!currentApiKey || !currentSecretKey) {
            addBotLog(`⚠️ Hệ thống đang chờ cấu hình API từ HTML...`, "warn");
            return;
        }

        await fetchExchangeData();
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
    if (!status.isReady || !botSettings.isRunning || !currentApiKey || !currentSecretKey || !status.exchangeInfo) return;

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
        const can = status.candidatesList.find(c => 
            (Math.abs(c.c1) >= botSettings.minVol || Math.abs(c.c5) >= botSettings.minVol) && 
            !status.blackList[c.symbol] && 
            !status.permanentBlacklist[c.symbol] && 
            !botActivePositions.has(`${c.symbol}_SHORT`) &&
            !botActivePositions.has(`${c.symbol}_LONG`)
        );
        
        if (can) {
            addBotLog(`🎯 [MỤC TIÊU] Phát hiện ${can.symbol} đạt điều kiện! Chi tiết biến động -> M1: ${can.c1}% | M5: ${can.c5}% | M15: ${can.c15}%`, "info");
            openPosition(can.symbol);
        }
    }
}, 3000);

setInterval(async () => {
    if (!status.isReady || !currentBotIP) return; 
    try {
        const ipCheckRes = await axios.get('https://api4.ipify.org?format=json', { timeout: 5000 });
        const newIP = ipCheckRes.data.ip;
        
        if (newIP && newIP !== currentBotIP) {
            addBotLog(`⚠️ [NETWORK] IP CHANGE DETECTED! Cũ: ${currentBotIP} -> Mới: ${newIP}`, "warn");
            currentBotIP = newIP; 
        }
    } catch (err) {} 
}, 30000);

APP.listen(1111);
