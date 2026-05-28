
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
let hasLoggedSyncError = false;

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

function saveConfig(apiKey, secretKey) {
    try {
        const data = { apiKey: apiKey.trim(), secretKey: secretKey.trim() };
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 4), 'utf8');
    } catch (e) {}
}

loadConfig(); 

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

let botSettings = { isRunning: false, maxPositions: 3000, invValue: "0.1%", minVol: 5, posTP: 2.1, posSL: 10.0, maxDCA: MAX_DCA_LEVEL };
let status = { botLogs: [], candidatesList: [], blackList: {}, permanentBlacklist: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: null, isReady: false };
let botActivePositions = new Map(); 
let isProcessingDCA = new Set();
let timestampOffset = 0;
let isMarginProtected = false; 
let currentBotIP = null;

let cachedAvailableBalance = 0;
let cachedTotalWalletBalance = 0;
let cachedTotalUnrealizedProfit = 0; 

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

// --- ĐÃ SỬA: Khôi phục endpoint leverageBracket về chuẩn v1 ---
async function fetchExchangeData() {
    if (!botSettings.isRunning) {
        status.isReady = false;
        return;
    }
    try {
        const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = t.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        
        // SỬA TẠI ĐÂY: Trả về v1 để lấy bậc ký quỹ không bị crash lỗi 404
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
        hasLoggedSyncError = false; 
        addBotLog(`🚀 Hệ thống dữ liệu thị trường đã đồng bộ và sẵn sàng.`);
    } catch (e) {
        if (!hasLoggedSyncError) {
            addBotLog(`❌ Lỗi đồng bộ dữ liệu Binance (${e.message}), đang thử lại...`, "error");
            hasLoggedSyncError = true;
        }
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
    if (!status.isReady || !status.exchangeInfo) return setTimeout(priceMonitor, 400);
    try {
        if (!botSettings.isRunning && botActivePositions.size > 0) {
            addBotLog(`🛑 Bot STOP`, "warn");
            botActivePositions.clear();
            isProcessingDCA.clear();
        }

        if (!botSettings.isRunning) return setTimeout(priceMonitor, 400);

        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        
        for (let [key, b] of botActivePositions) {
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realP) {
                b.pnl = parseFloat(realP.unRealizedProfit);
                const markP = parseFloat(realP.markPrice);
                b.priceDev = b.side === 'SHORT' 
                    ? ((b.entryPrice - markP) / b.entryPrice) * 100 
                    : ((markP - b.entryPrice) / b.entryPrice) * 100;

                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                if (b.currentQty !== currentQty) { 
                    b.currentQty = currentQty; 
                }
                b.hitTime = null; 
            } else {
                if (isProcessingDCA.has(b.symbol)) continue;

                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 5 });
                const recent = trades.filter(t => t.time > (Date.now() + timestampOffset - 30000));

                let totalR = 0, totalV = 0, avgClosePrice = 0;
                if (recent.length > 0) {
                    recent.forEach(t => { 
                        totalR += parseFloat(t.realizedPnl); 
                        totalV += (parseFloat(t.price) * parseFloat(t.qty)); 
                    });
                    const totalQtyTraded = recent.reduce((acc, t) => acc + parseFloat(t.qty), 0);
                    if (totalQtyTraded > 0) avgClosePrice = totalV / totalQtyTraded;
                }
                const fee = totalV * 0.0005; 
                const netPnl = totalR - fee;

                let accumulatedLoss = b.accumulatedLoss || 0;
                if (netPnl < 0 && b.side === 'SHORT') {
                    accumulatedLoss += Math.abs(netPnl);
                }

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
                        addBotLog(`🔄 ${b.symbol} dính SL vị thế SHORT. Chuẩn bị kích hoạt chuỗi lệnh tiếp theo...`, "warn");
                    }
                }

                const logType = netPnl > 0 ? "💰 [CHỐT LỜI]" : "😭 [CẮT LỖ]";
                const logStatus = netPnl > 0 ? "success" : "error";
                addBotLog(`${logType} ${b.symbol} | ${b.side} | DCA: ${b.dcaCount}/${botSettings.maxDCA} | ClosePrice: ${avgClosePrice > 0 ? avgClosePrice.toFixed(5) : "MARKET"} | PnL: ${netPnl.toFixed(4)}$`, logStatus);

                if (netPnl < 0 && b.side === 'SHORT') {
                    const jump = b.dcaCount + 1;
                    if (jump <= botSettings.maxDCA) {
                        openPosition(b.symbol, { 
                            ...b, 
                            dcaCount: jump, 
                            margin: b.firstMargin * (jump + 1),
                            accumulatedLoss: accumulatedLoss,
                            firstQty: b.firstQty || b.currentQty,
                            firstPrice: b.firstPrice || b.entryPrice
                        });
                    } else {
                        openPosition(b.symbol, { 
                            ...b, 
                            isFinalLong: true, 
                            margin: b.firstMargin * 10,
                            accumulatedLoss: accumulatedLoss
                        });
                    }
                }
            }
        }
    } catch (e) { console.error("Monitor Err:", e.message); }
    setTimeout(priceMonitor, 400); 
}

async function openPosition(symbol, dcaData = null) {
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol); 
    
    const isDCAorLong = dcaData !== null;
    const side = dcaData?.isFinalLong ? 'LONG' : 'SHORT';
    
    try {
        const info = status.exchangeInfo[symbol];
        const availableUsdt = cachedAvailableBalance;
        
        let currentPrice = 0;
        const targetCandidate = status.candidatesList.find(c => c.symbol === symbol);
        if (targetCandidate && targetCandidate.price) {
            currentPrice = parseFloat(targetCandidate.price);
        } else {
            const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
            currentPrice = parseFloat(ticker.data.price);
        }

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
        
        const orderPromise = exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        const [, order] = await Promise.all([
            exchange.setLeverage(info.maxLeverage, symbol).catch(() => {}),
            orderPromise
        ]);
        
        if (order) {
            const entry = order.price ? parseFloat(order.price) : currentPrice;
            
            const firstE = dcaData ? dcaData.firstEntry : entry;
            const dcaCount = dcaData ? dcaData.dcaCount : 0;
            
            const dcaHistory = dcaData ? [...dcaData.dcaHistory, entry] : [entry];
            const sumPrices = dcaHistory.reduce((sum, p) => sum + p, 0);
            const simpleAvgEntry = sumPrices / dcaHistory.length;

            let tp = 0, sl = 0;
            if (side === 'LONG') {
                tp = entry * 1.15;
                sl = entry * 0.85;
            } else {
                if (dcaCount === 0) {
                    tp = simpleAvgEntry * (1 - botSettings.posTP / 100);
                } else {
                    const firstQty = dcaData.firstQty || qty;
                    const firstPrice = dcaData.firstPrice || entry;
                    const baseTargetPnL = firstQty * firstPrice * (botSettings.posTP / 100); 
                    const scaledTargetPnL = baseTargetPnL * (dcaCount + 1);
                    const totalLossToRecover = dcaData.accumulatedLoss || 0;
                    const requiredProfit = totalLossToRecover + scaledTargetPnL;

                    tp = entry - (requiredProfit / qty);

                    if (tp <= 0 || tp >= entry) {
                        tp = entry * (1 - botSettings.posTP / 100);
                    }
                }
                sl = firstE + (firstE * (botSettings.posSL * (dcaCount + 1)) / 100);
            }

            const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
            Promise.all([
                exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: tp.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' }),
                exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: sl.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' })
            ]).catch((err) => console.error(`Lỗi đặt nhanh TP/SL cho ${symbol}:`, err.message));

            botActivePositions.set(`${symbol}_${side}`, { 
                symbol, side, entryPrice: entry, tp: tp, sl: sl, 
                dcaCount: dcaCount, leverage: info.maxLeverage, firstEntry: firstE, 
                firstMargin: dcaData ? dcaData.firstMargin : actualMarginUsed, currentMargin: actualMarginUsed, 
                currentQty: qty, virtualTotalQty: qty, virtualTotalCost: qty * entry, 
                dcaHistory: dcaHistory, isFinalLong: dcaData?.isFinalLong || false,
                pnl: 0, priceDev: 0, hitTime: null,
                accumulatedLoss: dcaData ? dcaData.accumulatedLoss : 0,
                firstQty: dcaData ? dcaData.firstQty : qty,
                firstPrice: dcaData ? dcaData.firstPrice : entry
            });
            
            const modeStr = isDCAorLong ? (dcaData.isFinalLong ? 'LONG' : `DCA_${dcaData.dcaCount}`) : 'OPEN';
            addBotLog(`📡 [${modeStr}] ${symbol} | ${side} | Lev: x${info.maxLeverage} | Margin: ${actualMarginUsed.toFixed(2)}$ | Entry: ${entry} | TP: ${tp.toFixed(info.pricePrecision)} | SL: ${sl.toFixed(info.pricePrecision)}`);
        }
    } catch (e) { 
        addBotLog(`❌ Lỗi vị thế ${symbol}: ${e.message}`, "error"); 
    } finally { 
        isProcessingDCA.delete(symbol); 
    }
}

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    const visualBlacklist = {};
    const now = Date.now();
    for (const s in status.blackList) {
        const expireTime = Number(status.blackList[s]); 
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
        wallet: { 
            totalWalletBalance: cachedTotalWalletBalance.toFixed(2), 
            availableBalance: cachedAvailableBalance.toFixed(2), 
            totalUnrealizedProfit: cachedTotalUnrealizedProfit.toFixed(2) 
        } 
    });
});

APP.post('/api/settings', async (req, res) => { 
    if (req.body.apiKey !== undefined && req.body.secretKey !== undefined) {
        currentApiKey = req.body.apiKey.trim();
        currentSecretKey = req.body.secretKey.trim();
        
        saveConfig(currentApiKey, currentSecretKey);

        binanceApi.defaults.headers['X-MBX-APIKEY'] = currentApiKey;
        initCCXT();
        addBotLog(`⚙️ Đã lưu cấu hình API mới.`, "success");
        
        status.isReady = false; 
        hasLoggedSyncError = false; 
    }

    if (req.body.isRunning !== undefined) {
        botSettings.isRunning = req.body.isRunning;
        if (botSettings.isRunning && currentApiKey && currentSecretKey) {
            status.isReady = false;
            fetchExchangeData(); 
        }
    }

    if (req.body.maxDCA !== undefined) botSettings.maxDCA = parseInt(req.body.maxDCA);
    if (req.body.maxPositions !== undefined) botSettings.maxPositions = parseInt(req.body.maxPositions);
    if (req.body.minVol !== undefined) botSettings.minVol = parseFloat(req.body.minVol);
    if (req.body.invValue !== undefined) botSettings.invValue = req.body.invValue;
    if (req.body.posTP !== undefined) botSettings.posTP = parseFloat(req.body.posTP);
    if (req.body.posSL !== undefined) botSettings.posSL = parseFloat(req.body.posSL);
    
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
    } catch (e) { setTimeout(init, 5000); }
}

init();

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 800);

setInterval(async () => {
    if (!status.isReady || !botSettings.isRunning || !currentApiKey || !currentSecretKey) return;

    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    if (acc) {
        cachedTotalWalletBalance = parseFloat(acc.totalMarginBalance || 0);
        cachedAvailableBalance = parseFloat(acc.availableBalance || 0);
        cachedTotalUnrealizedProfit = parseFloat(acc.totalUnrealizedProfit || 0); 
        
        if (cachedTotalWalletBalance > 0) {
            const availPercent = (cachedAvailableBalance / cachedTotalWalletBalance) * 100;
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
}, 2000);

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
