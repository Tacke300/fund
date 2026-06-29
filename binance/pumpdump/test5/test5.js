import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const MIN_NOTIONAL_FORCE = 5.1;

const ANTI_LIQUIDATION_LIMIT = 10; 
const MARGIN_PROTECT_LIMIT = 60;  
const MARGIN_RECOVER_LIMIT = 70;  

const globalStartTime = Date.now();

function formatUptime(startTime) {
    const uptimeMs = Date.now() - startTime;
    const hours = Math.floor(uptimeMs / (3600 * 1000));
    const minutes = Math.floor((uptimeMs % (3600 * 1000)) / (60 * 1000));
    const seconds = Math.floor((uptimeMs % (60 * 1000)) / 1000);
    return `${hours}h ${minutes}m ${seconds}s`;
}

let walletCache = { data: { totalWalletBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" }, lastUpdate: 0 };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

let sharedState = {
    blackList: {},
    permanentBlacklist: {},
    candidatesList: [],
    exchangeInfo: null,
    masterLogs: []
};

let systemSettings = {
    isRunning: false,
    invValue: "1",
    maxPositions: 3,
    gridStepPercent: 1.0,
    heSoDCA: 1,
    tpPercent: 1.0, // Được dùng làm số lượng GridStep để TP
    minVol: 7
};

function parseNormalizedSettings(reqBody, currentSettings) {
    const normalizedBody = {};
    for (let key in reqBody) {
        const lowerKey = key.toLowerCase();
        const val = reqBody[key];
        if (lowerKey.includes('vốn') || lowerKey === 'invvalue') normalizedBody.invValue = val;
        else if (lowerKey === 'maxpositions') normalizedBody.maxPositions = parseInt(val);
        else if (lowerKey === 'gridsteppercent' || lowerKey.includes('lưới')) normalizedBody.gridStepPercent = parseFloat(val);
        else if (lowerKey === 'hesodca' || lowerKey.includes('hệ số')) normalizedBody.heSoDCA = parseFloat(val);
        else if (lowerKey === 'tppercent' || lowerKey.includes('tp')) normalizedBody.tpPercent = parseFloat(val);
        else if (lowerKey === 'minvol') normalizedBody.minVol = parseFloat(val);
        else normalizedBody[key] = val; 
    }
    return { ...currentSettings, ...normalizedBody };
}

let systemBot = {
    id: "MASTER_BOT", startTime: Date.now(),
    status: { botLogs: [], botClosedCount: 0, botPnLClosed: 0, pnlGain: 0, pnlLoss: 0, isReady: false },
    activePairs: new Map(),
    isProcessingLogic: new Set(), logThrottle: new Map(), timestampOffset: 0, isMarginProtected: false,
    exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

function addLog(msg, type = 'info', throttleKey = null) {
    if (throttleKey) {
        const now = Date.now();
        const last = systemBot.logThrottle.get(throttleKey) || 0;
        if (now - last < 10000) return; 
        systemBot.logThrottle.set(throttleKey, now);
    }
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const logItem = { time, msg, type };
    
    systemBot.status.botLogs.unshift(logItem);
    if (systemBot.status.botLogs.length > 200) systemBot.status.botLogs.pop();
    
    sharedState.masterLogs.unshift({ time, msg: `[SYS] ${msg}`, type });
    if (sharedState.masterLogs.length > 400) sharedState.masterLogs.pop();
    
    console.log(`[${time}][${type.toUpperCase()}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    try {
        const timestamp = Date.now() + systemBot.timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await systemBot.binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (e) {
        if (e.response?.data?.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            systemBot.timestampOffset = t.data.serverTime - Date.now();
            return binancePrivate(endpoint, method, data);
        }
        throw e;
    }
}

setInterval(() => {
    const now = Date.now();
    for (const symbol in sharedState.blackList) {
        if (now > sharedState.blackList[symbol]) delete sharedState.blackList[symbol];
    }
}, 1000);

function checkAndAddBlacklist(symbol) {
    if (!systemBot.activePairs.has(symbol)) {
        sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000); 
        addLog(`🚫 [BLACKLIST] Đã chặn ${symbol} 15 phút.`, "warn");
    }
}

async function executeBatchOrder(symbol, positionSide, marginUSD, action) {
    if (marginUSD <= 0) return;
    const info = sharedState.exchangeInfo[symbol];
    if (!info) return;

    try {
        const ticker = await systemBot.binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        
        let qty = (marginUSD * info.maxLeverage) / currentPrice;
        qty = Math.floor(qty / info.stepSize) * info.stepSize;
        
        if (action === 'OPEN' && qty * currentPrice < info.minNotional) {
            qty = Math.ceil((info.minNotional / currentPrice) / info.stepSize) * info.stepSize;
        }
        
        if (qty <= 0) return;
        
        const orderSide = positionSide === 'LONG' ? (action === 'OPEN' ? 'BUY' : 'SELL') : (action === 'OPEN' ? 'SELL' : 'BUY');
        await systemBot.exchange.createOrder(symbol, 'MARKET', orderSide, qty.toFixed(info.quantityPrecision), undefined, { positionSide: positionSide });
    } catch(e) {
        addLog(`❌ [LỖI BATCH LỆNH] ${symbol} | ${positionSide} | ${action} | ${e.message}`, "error");
    }
}

async function forceCloseSymbol(symbol, reasonStr) {
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol }).catch(() => []);
        let totalPnL = 0;
        let pairData = systemBot.activePairs.get(symbol);
        
        for (const p of posRisk) {
            const amt = parseFloat(p.positionAmt);
            if (Math.abs(amt) > 0) {
                const sideClose = p.positionSide === 'SHORT' ? 'BUY' : 'SELL';
                await systemBot.exchange.createOrder(symbol, 'MARKET', sideClose, Math.abs(amt), undefined, { positionSide: p.positionSide }).catch(() => {});
                
                const markP = parseFloat(p.markPrice);
                const feeVolDeduction = (Math.abs(amt) * markP * 0.001);
                totalPnL += (parseFloat(p.unRealizedProfit) - feeVolDeduction);
            }
        }
        
        systemBot.status.botClosedCount++;
        systemBot.status.botPnLClosed += totalPnL;
        if (totalPnL >= 0) systemBot.status.pnlGain = (systemBot.status.pnlGain || 0) + totalPnL;
        else systemBot.status.pnlLoss = (systemBot.status.pnlLoss || 0) + totalPnL;

        if (pairData) {
            addLog(`🔒 [${reasonStr}] Cắt ${symbol} | Lev: x${pairData.leverage} | Entry Gốc: ${pairData.firstEntryPrice} | Tổng Note đã đóng: ${pairData.closedNotesCount} | PnL Tổng Vị Thế: ${totalPnL.toFixed(2)}$`, totalPnL >= 0 ? "success" : "sl");
        } else {
            addLog(`🔒 [${reasonStr}] Đã đóng toàn bộ vị thế ${symbol} | PnL: ${totalPnL.toFixed(2)}$`, totalPnL >= 0 ? "success" : "sl");
        }
        
        const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol }).catch(() => []);
        for (const o of openOrders) {
            await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId }).catch(()=>{});
        }
        
        systemBot.activePairs.delete(symbol);
        checkAndAddBlacklist(symbol);
    } catch (e) {
        addLog(`❌ Lỗi đóng vị thế ${symbol}: ${e.message}`, "error");
    }
}

async function panicCloseAll(reasonLog) {
    try {
        const activeSymbols = Array.from(systemBot.activePairs.keys());
        for(let sym of activeSymbols) {
            await forceCloseSymbol(sym, reasonLog);
        }
        addLog(`⚠️ [KÍCH HOẠT ĐÓNG TOÀN BỘ] Đã giải phóng tài khoản (${reasonLog}).`, "warn");
        return { success: true };
    } catch (e) { return { success: false, msg: e.message }; }
}

async function priceMonitor() {
    if (!systemBot.status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        if (!systemSettings.isRunning) return setTimeout(priceMonitor, 1000);
        const posRisk = await binancePrivate('/fapi/v2/positionRisk').catch(()=>[]);
        
        for (let [symbol, pair] of systemBot.activePairs) {
            if (systemBot.isProcessingLogic.has(symbol)) continue;
            
            const gridPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.gridSide && Math.abs(parseFloat(p.positionAmt)) > 0);
            const dcaPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.dcaSide && Math.abs(parseFloat(p.positionAmt)) > 0);

            if (!gridPos && !dcaPos) {
                systemBot.activePairs.delete(symbol);
                checkAndAddBlacklist(symbol);
                continue;
            }

            systemBot.isProcessingLogic.add(symbol);

            try {
                const markP = parseFloat((gridPos || dcaPos).markPrice);
                const dir = pair.gridSide === 'LONG' ? 1 : -1;
                
                // Level: Mốc lưới hiện tại. Lỗ = Level < 0, Lãi = Level > 0
                const currentLevel = Math.floor((markP - pair.firstEntryPrice) / pair.stepUSD) * dir;

                let ordersToExecute = {
                    LONG: { addMargin: 0, closeMargin: 0 },
                    SHORT: { addMargin: 0, closeMargin: 0 }
                };

                // XỬ LÝ LƯỚI & NOTE
                if (currentLevel < pair.lastLevel) {
                    // Giá chạy ngược xu hướng Grid (Grid Lỗ thêm)
                    for (let k = pair.lastLevel - 1; k >= currentLevel; k--) {
                        // Rule 1: Grid chạm lưới lỗ => Nhồi Grid
                        if (!pair.executedGridLevels[k]) {
                            ordersToExecute[pair.gridSide].addMargin += pair.initialMargin;
                            pair.executedGridLevels[k] = true;
                            
                            // Tính Average của Grid Gốc
                            pair.gridTotalMargin += pair.initialMargin;
                            pair.gridAvgPrice = ((pair.gridAvgPrice * (pair.gridTotalMargin - pair.initialMargin)) + (markP * pair.initialMargin)) / pair.gridTotalMargin;

                            // Rule 3: Tạo Note Mới & Mở DCA Note x5
                            const newNote = { id: `Note_${Math.abs(k)}`, startLevel: k, gridMargin: pair.initialMargin, dcaNoteMargin: pair.initialMargin * 5, dcaNoteAvg: markP, dcaNoteCount: 1 };
                            pair.activeNotes.push(newNote);
                            ordersToExecute[pair.dcaSide].addMargin += newNote.dcaNoteMargin;

                            addLog(`📉 [TẠO NOTE MỚI] ${symbol} | Mốc: ${k} | Giá: ${markP} | Mở 1 Margin Grid + 5 Margin DCA Note`, "warn");
                        }

                        // Rule 4: SL Note (Đi thêm 1 lưới ngược => Cắt Note cũ)
                        for (let i = pair.activeNotes.length - 1; i >= 0; i--) {
                            const note = pair.activeNotes[i];
                            if (k <= note.startLevel - 1) {
                                ordersToExecute[pair.gridSide].closeMargin += note.gridMargin;
                                ordersToExecute[pair.dcaSide].closeMargin += note.dcaNoteMargin;
                                pair.gridTotalMargin -= note.gridMargin;
                                pair.closedNotesCount++;
                                
                                addLog(`🛑 [ĐÓNG NOTE - SL] ${symbol} | ${note.id} | Giá cắt: ${markP} | Cắt 1 Grid (${note.gridMargin.toFixed(2)}$) & 5 DCA Note (${note.dcaNoteMargin.toFixed(2)}$)`, "sl");
                                pair.activeNotes.splice(i, 1);
                            }
                        }
                    }
                } else if (currentLevel > pair.lastLevel) {
                    // Giá chạy thuận hướng Grid (Hồi hoặc Trend tiếp)
                    for (let k = pair.lastLevel + 1; k <= currentLevel; k++) {
                        
                        // Rule 2: DCA Gốc nhồi khi lỗ (Lãi của Grid = Lỗ của DCA => k > 0)
                        if (k > 0 && !pair.executedDcaBaseLevels[k]) {
                            const dcaMargin = pair.initialMargin * systemSettings.heSoDCA;
                            ordersToExecute[pair.dcaSide].addMargin += dcaMargin;
                            pair.executedDcaBaseLevels[k] = true;
                            addLog(`📈 [DCA GỐC] ${symbol} | Mốc: ${k} | Giá: ${markP} | Mở ${dcaMargin.toFixed(2)}$ DCA Gốc`, "info");
                        }

                        // Rule 6: Giá hồi về phía Grid có lãi & Tồn tại Note
                        if (pair.activeNotes.length > 0) {
                            const currentNote = pair.activeNotes[pair.activeNotes.length - 1];
                            const addDcaNoteMargin = pair.initialMargin * 5;
                            let logMsg = `🔄 [GIÁ HỒI - NHỒI NOTE] ${symbol} | ${currentNote.id} | Giá: ${markP}`;

                            if (!pair.executedDcaBaseLevels[k]) {
                                const dcaMargin = pair.initialMargin * systemSettings.heSoDCA;
                                ordersToExecute[pair.dcaSide].addMargin += dcaMargin;
                                pair.executedDcaBaseLevels[k] = true;
                                logMsg += ` | Mở DCA Gốc (${dcaMargin.toFixed(2)}$) + DCA Note (${addDcaNoteMargin.toFixed(2)}$)`;
                            } else {
                                logMsg += ` | Chỉ mở DCA Note (${addDcaNoteMargin.toFixed(2)}$)`;
                            }

                            ordersToExecute[pair.dcaSide].addMargin += addDcaNoteMargin;
                            // Cập nhật Average của Note hiện tại
                            currentNote.dcaNoteAvg = ((currentNote.dcaNoteAvg * currentNote.dcaNoteMargin) + (markP * addDcaNoteMargin)) / (currentNote.dcaNoteMargin + addDcaNoteMargin);
                            currentNote.dcaNoteMargin += addDcaNoteMargin;
                            currentNote.dcaNoteCount++;

                            addLog(logMsg, "warn");
                        }
                    }
                }
                pair.lastLevel = currentLevel;

                // Rule 6.b: Check TP Note
                for (let i = pair.activeNotes.length - 1; i >= 0; i--) {
                    const note = pair.activeNotes[i];
                    const isDcaShort = pair.dcaSide === 'SHORT';
                    const isNoteTpReached = isDcaShort ? (markP <= note.dcaNoteAvg - pair.stepUSD) : (markP >= note.dcaNoteAvg + pair.stepUSD);
                    
                    if (isNoteTpReached) {
                        ordersToExecute[pair.gridSide].closeMargin += note.gridMargin;
                        ordersToExecute[pair.dcaSide].closeMargin += note.dcaNoteMargin;
                        pair.gridTotalMargin -= note.gridMargin;
                        pair.closedNotesCount++;

                        addLog(`✅ [CHỐT NOTE - TP] ${symbol} | ${note.id} | Avg DCA: ${note.dcaNoteAvg.toFixed(4)} | Số lần DCA: ${note.dcaNoteCount} | Cắt toàn bộ (${note.dcaNoteMargin.toFixed(2)}$) DCA Note & 1 Grid (${note.gridMargin.toFixed(2)}$)`, "success");
                        pair.activeNotes.splice(i, 1);
                    }
                }

                // Rule 9: Check Global TP
                let shouldForceCloseAll = false;
                if (pair.activeNotes.length === 0) {
                    const isGridLong = pair.gridSide === 'LONG';
                    const targetTpOffset = systemSettings.tpPercent * pair.stepUSD;
                    const isGlobalTpReached = isGridLong ? (markP >= pair.gridAvgPrice + targetTpOffset) : (markP <= pair.gridAvgPrice - targetTpOffset);
                    
                    if (isGlobalTpReached) {
                        addLog(`🎉 [CHỐT LỜI TỔNG] ${symbol} đạt mục tiêu TP (${systemSettings.tpPercent} GridStep từ Avg Grid). Đóng toàn bộ Cặp!`, "success");
                        shouldForceCloseAll = true;
                    }
                }

                if (shouldForceCloseAll) {
                    await forceCloseSymbol(symbol, "CHỐT LỜI TỔNG GRID + DCA GỐC");
                } else {
                    // Rule 8: Gom lệnh gửi API
                    for (const side of ['LONG', 'SHORT']) {
                        if (ordersToExecute[side].addMargin > 0) await executeBatchOrder(symbol, side, ordersToExecute[side].addMargin, 'OPEN');
                        if (ordersToExecute[side].closeMargin > 0) await executeBatchOrder(symbol, side, ordersToExecute[side].closeMargin, 'CLOSE');
                    }
                }

            } catch(e) {
                addLog(`❌ [LỖI XỬ LÝ LÔGIC] ${symbol}: ${e.message}`, "error");
            } finally {
                systemBot.isProcessingLogic.delete(symbol);
            }
        }
    } catch (e) { }
    setTimeout(priceMonitor, 500); 
}

async function checkMarginLimits() {
    if (!systemBot.status.isReady || !systemSettings.isRunning) return;
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    if (acc && parseFloat(acc.totalMarginBalance) > 0) {
        const availPercent = (parseFloat(acc.availableBalance) / parseFloat(acc.totalMarginBalance)) * 100;
        if (availPercent <= ANTI_LIQUIDATION_LIMIT) { 
            await panicCloseAll(`CHỐNG THANH LÝ ${ANTI_LIQUIDATION_LIMIT}%`); 
            systemBot.isMarginProtected = false; 
            return; 
        }
        if (!systemBot.isMarginProtected && availPercent < MARGIN_PROTECT_LIMIT) {
            systemBot.isMarginProtected = true; addLog(`⚠️ CẢNH BÁO: Khả dụng giảm dưới ${MARGIN_PROTECT_LIMIT}%. Dừng quét lệnh mới!`, "warn");
        } else if (systemBot.isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) {
            systemBot.isMarginProtected = false; addLog(`✅ Khả dụng phục hồi trên ${MARGIN_RECOVER_LIMIT}%. Mở lại quét lệnh.`, "info");
        }
    }
}

function allowCors(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
}

const appServer = express(); 
appServer.use(allowCors); 
appServer.use(express.json()); 
appServer.use(express.static(__dirname, { index: false })); 

appServer.get('/', (req, res) => res.sendFile(path.join(__dirname, 'sever.html')));

async function buildStatusResponse() {
    const now = Date.now();
    if (now - walletCache.lastUpdate > 3000) {
        const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
        if (acc) {
            walletCache.data = { totalWalletBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2), availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) };
            walletCache.lastUpdate = now;
        }
    }
    const posRisk = await binancePrivate('/fapi/v2/positionRisk').catch(() => []);
    const formattedBlacklist = {};
    for (const [sym, expireTime] of Object.entries(sharedState.blackList)) {
        const remainingSecs = Math.floor((expireTime - now) / 1000);
        if (remainingSecs > 0) formattedBlacklist[sym] = remainingSecs;
    }
    return { 
        botSettings: systemSettings, 
        activePositions: Array.from(systemBot.activePairs.values()), 
        exchangePositions: posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0), 
        status: { botLogs: systemBot.status.botLogs, botClosedCount: systemBot.status.botClosedCount, botPnLClosed: systemBot.status.botPnLClosed, pnlGain: systemBot.status.pnlGain || 0, pnlLoss: systemBot.status.pnlLoss || 0, isReady: systemBot.status.isReady, candidatesList: sharedState.candidatesList, blackList: formattedBlacklist, permanentBlacklist: sharedState.permanentBlacklist, exchangeInfo: sharedState.exchangeInfo, timeRun: formatUptime(systemBot.startTime) }, 
        wallet: walletCache.data, timeRun: formatUptime(systemBot.startTime)
    };
}

appServer.post('/api/settings', (req, res) => {
    systemSettings = parseNormalizedSettings(req.body, systemSettings);
    res.json({ success: true, msg: "Cập nhật cấu hình Hệ thống Hedge thành công!" });
});

appServer.get('/api/status', async (req, res) => {
    const masterData = await buildStatusResponse();
    masterData.status.botLogs = sharedState.masterLogs; 
    res.json(masterData);
});

appServer.post('/api/close_all', async (req, res) => res.json(await panicCloseAll("PANIC CLOSE TỪ UI")));

appServer.post('/api/close_position', async (req, res) => { 
    const { symbol } = req.body; 
    if (systemBot.activePairs.has(symbol)) {
        await forceCloseSymbol(symbol, "ĐÓNG THỦ CÔNG CẶP");
        res.json({ success: true });
    } else {
        res.json({ success: false, msg: "Không tìm thấy Cặp lệnh." });
    }
});

async function init() {
    try {
        await systemBot.exchange.loadMarkets();
        // Setup Hedge Mode Force
        await binancePrivate('/fapi/v1/positionSide/dual', 'POST', { dualSidePosition: 'true' }).catch(()=>{});

        const info = await systemBot.binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate('/fapi/v1/leverageBracket');
        const temp = {};
        info.data.symbols.forEach(s => {
            if (s.status !== 'TRADING') return; 
            const b = brk.find(x => x.symbol === s.symbol); const maxLev = b?.brackets[0]?.initialLeverage || 20;
            if (maxLev < 20) { sharedState.permanentBlacklist[s.symbol] = true; return; }
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 5.0), maxLeverage: maxLev };
        });
        sharedState.exchangeInfo = temp; 
        
        systemBot.status.isReady = true;
        priceMonitor(); 
    } catch (e) { setTimeout(init, 5000); }
}

init();

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { sharedState.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

setInterval(async () => {
    await checkMarginLimits();
    if (!systemBot.status.isReady || !systemSettings.isRunning || systemBot.isMarginProtected) return;

    if (systemBot.activePairs.size >= systemSettings.maxPositions) return;

    let entrySignal = null;
    for (const c of sharedState.candidatesList) {
        if (sharedState.blackList[c.symbol] || sharedState.permanentBlacklist[c.symbol]) continue; 
        if (systemBot.activePairs.has(c.symbol)) continue;

        const m1 = parseFloat(c.c1 || 0);
        
        let isNormal = false; let normalSide = 'SHORT';
        if (Math.abs(m1) >= systemSettings.minVol) { isNormal = true; normalSide = m1 > 0 ? 'LONG' : 'SHORT'; }
        
        if (isNormal) {
            entrySignal = { symbol: c.symbol, gridSide: normalSide, dcaSide: normalSide === 'LONG' ? 'SHORT' : 'LONG' };
            break;
        }
    }

    if (entrySignal) {
        const symbol = entrySignal.symbol;
        if (systemBot.isProcessingLogic.has(symbol)) return;

        const info = sharedState.exchangeInfo[symbol];
        if (!info) return;

        const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
        if (!acc) return; 
        const snapshotAvailable = parseFloat(acc.availableBalance || 0);

        const marginSetting = systemSettings.invValue;
        let calculatedMargin = marginSetting.toString().includes('%') ? (snapshotAvailable * parseFloat(marginSetting) / 100) : parseFloat(marginSetting);

        systemBot.isProcessingLogic.add(symbol);
        try {
            // Setup Cross Margin & Leverage for Symbol
            await binancePrivate('/fapi/v1/marginType', 'POST', { symbol, marginType: 'CROSSED' }).catch(()=>{});
            await systemBot.exchange.setLeverage(info.maxLeverage, symbol).catch(()=>{});

            const ticker = await systemBot.binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
            const startPrice = parseFloat(ticker.data.price);

            await executeBatchOrder(symbol, entrySignal.gridSide, calculatedMargin, 'OPEN');
            await executeBatchOrder(symbol, entrySignal.dcaSide, calculatedMargin, 'OPEN');

            systemBot.activePairs.set(symbol, {
                symbol: symbol,
                gridSide: entrySignal.gridSide,
                dcaSide: entrySignal.dcaSide,
                firstEntryPrice: startPrice,
                initialMargin: calculatedMargin,
                leverage: info.maxLeverage,
                stepUSD: startPrice * (systemSettings.gridStepPercent / 100),
                lastLevel: 0,
                executedGridLevels: { 0: true },
                executedDcaBaseLevels: { 0: true },
                activeNotes: [],
                closedNotesCount: 0,
                gridAvgPrice: startPrice,
                gridTotalMargin: calculatedMargin,
                createdAt: Date.now()
            });

            addLog(`[PAIR HEDGE MỚI] ${symbol} | Giá: ${startPrice} | Vốn đầu: ${calculatedMargin.toFixed(2)}$ mỗi chiều | Đòn bẩy: x${info.maxLeverage}`, "open");
        } catch (e) {
            addLog(`❌ [LỖI MỞ LỆNH] ${symbol}: ${e.message}`, "error");
            checkAndAddBlacklist(symbol);
        }
        systemBot.isProcessingLogic.delete(symbol);
    }
}, 3000); 

appServer.listen(1820, () => console.log('🚀 [HEDGE SYSTEM] Đang chạy trên Port 1820 duy nhất!'));
