import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const MIN_NOTIONAL_FORCE = 5.1;
const MAX_DCA_LEVEL = 999999; 

const SCAN_CONFIG = {
    THUONG: ['M1', 'M5'],            
    DIA_NGUC: ['M1', 'M5', 'M15']    
};

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
    tpPercent: 1.0,
    minVol: 7,
    diangucvol: 15
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
        else if (['minvol', 'diangucvol'].includes(lowerKey)) normalizedBody[key] = parseFloat(val);
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

async function forceCloseSymbol(symbol, reasonStr) {
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol }).catch(() => []);
        let totalPnL = 0;
        
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

        addLog(`🔒 [${reasonStr}] Đã đóng toàn bộ vị thế ${symbol} | PnL: ${totalPnL.toFixed(2)}$`, totalPnL >= 0 ? "success" : "sl");
        
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

async function executeMarketOrder(symbol, side, marginUSD) {
    const info = sharedState.exchangeInfo[symbol];
    if(!info) throw new Error("Coin không hỗ trợ");
    
    const ticker = await systemBot.binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
    const currentPrice = parseFloat(ticker.data.price);
    
    const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || MIN_NOTIONAL_FORCE);
    let desiredQty = (marginUSD * info.maxLeverage) / currentPrice;
    let qty = Math.floor(desiredQty / info.stepSize) * info.stepSize;
    
    if (qty * currentPrice < actualMinNotional) {
        qty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
    }
    qty = Number(qty.toFixed(info.quantityPrecision)); 

    await systemBot.exchange.setLeverage(info.maxLeverage, symbol);
    
    const orderSide = side === 'LONG' ? 'BUY' : 'SELL'; 
    const order = await systemBot.exchange.createOrder(symbol, 'MARKET', orderSide, qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
    
    return { order, actualMargin: (qty * currentPrice) / info.maxLeverage, executedPrice: currentPrice };
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

            const markP = parseFloat((gridPos || dcaPos).markPrice);
            
            const totalMarginBoth = pair.gridMarginTotal + pair.dcaMarginTotal;
            const combinedPnL = (gridPos ? parseFloat(gridPos.unRealizedProfit) : 0) + (dcaPos ? parseFloat(dcaPos.unRealizedProfit) : 0);
            
            const targetPnLUSD = totalMarginBoth * (systemSettings.tpPercent / 100) * pair.leverage * systemSettings.heSoDCA;
            
            if (combinedPnL >= targetPnLUSD) {
                systemBot.isProcessingLogic.add(symbol);
                addLog(`🎉 [CHỐT LỜI TỔNG] ${symbol} PnL (${combinedPnL.toFixed(2)}$) đạt mục tiêu (${targetPnLUSD.toFixed(2)}$). Đóng toàn bộ Cặp!`, "success");
                await forceCloseSymbol(symbol, "CHỐT LỜI HEDGE TARGET");
                systemBot.isProcessingLogic.delete(symbol);
                continue;
            }

            const dir = pair.gridSide === 'LONG' ? 1 : -1;
            const gridStepPrice = pair.firstEntryPrice * (systemSettings.gridStepPercent / 100);
            
            let nextProfitTarget = pair.firstEntryPrice + (pair.maxProfitIndex + 1) * gridStepPrice * dir;
            let nextLossTarget = pair.firstEntryPrice + (pair.currentProfitIndex - 1) * gridStepPrice * dir;

            let crossedTarget = false;

            while ( (dir === 1 && markP >= nextProfitTarget) || (dir === -1 && markP <= nextProfitTarget) ) {
                crossedTarget = true;
                pair.maxProfitIndex++;
                pair.currentProfitIndex = pair.maxProfitIndex;
                
                if (!pair.visitedDCAGrids.has(pair.maxProfitIndex)) {
                    pair.visitedDCAGrids.add(pair.maxProfitIndex);
                    systemBot.isProcessingLogic.add(symbol);
                    try {
                        const marginToOpen = pair.initialMargin * systemSettings.heSoDCA;
                        const res = await executeMarketOrder(symbol, pair.dcaSide, marginToOpen);
                        pair.dcaMarginTotal += res.actualMargin;
                        addLog(`📈 [DCA NORMAL] Lưới thuận đỉnh mới (${pair.maxProfitIndex}). Mở ${pair.dcaSide} margin ${res.actualMargin.toFixed(2)}$`, "info");
                    } catch(e) { }
                    systemBot.isProcessingLogic.delete(symbol);
                }
                nextProfitTarget = pair.firstEntryPrice + (pair.maxProfitIndex + 1) * gridStepPrice * dir;
            }

            while ( (dir === 1 && markP <= nextLossTarget) || (dir === -1 && markP >= nextLossTarget) ) {
                crossedTarget = true;
                pair.currentProfitIndex--;
                
                systemBot.isProcessingLogic.add(symbol);
                try {
                    const resGrid = await executeMarketOrder(symbol, pair.gridSide, pair.initialMargin);
                    pair.gridMarginTotal += resGrid.actualMargin;
                    pair.gridOrders.push(pair.currentProfitIndex);
                    
                    addLog(`🔔 [LỖ LƯỚI GRID] Giá đi ngược về mốc ${pair.currentProfitIndex}. Grid nhồi thêm lệnh ${resGrid.actualMargin.toFixed(2)}$`, "warn");

                    const nextDropIndex = pair.currentProfitIndex - 1;
                    let totalLossSteps = (pair.maxProfitIndex - nextDropIndex);
                    
                    for (let openedAtIndex of pair.gridOrders) {
                        totalLossSteps += (openedAtIndex - nextDropIndex);
                    }

                    const marginRescue = totalLossSteps * pair.initialMargin;
                    const resDca = await executeMarketOrder(symbol, pair.dcaSide, marginRescue);
                    pair.dcaMarginTotal += resDca.actualMargin;
                    
                    addLog(`🛡️ [DCA BƠM CỨU VIỆN] Sụt giảm ${totalLossSteps} mốc lưới. Bot DCA tự động bơm ${resDca.actualMargin.toFixed(2)}$ margin cõng lỗ!`, "dca");
                    
                    const newTotalMargin = pair.gridMarginTotal + pair.dcaMarginTotal;
                    const expectedTP = newTotalMargin * (systemSettings.tpPercent / 100) * pair.leverage * systemSettings.heSoDCA;
                    addLog(`🎯 [DỰ KIẾN TP] Tổng Margin 2 bot: ${newTotalMargin.toFixed(2)}$. Mục tiêu chốt lời tịnh tiến lên: ${expectedTP.toFixed(2)}$ PnL.`, "info");

                } catch(e) { }
                systemBot.isProcessingLogic.delete(symbol);
                nextLossTarget = pair.firstEntryPrice + (pair.currentProfitIndex - 1) * gridStepPrice * dir;
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

        const m1 = parseFloat(c.c1 || 0); const m5 = parseFloat(c.c5 || 0); const m15 = parseFloat(c.c15 || 0);
        
        let isHell = false; let hellSide = 'SHORT';
        for (const tf of SCAN_CONFIG.DIA_NGUC) {
            const val = tf === 'M1' ? m1 : tf === 'M5' ? m5 : m15;
            if (Math.abs(val) >= systemSettings.diangucvol) { isHell = true; hellSide = val > 0 ? 'LONG' : 'SHORT'; break; }
        }

        if (isHell) {
            entrySignal = { symbol: c.symbol, gridSide: hellSide, dcaSide: hellSide === 'LONG' ? 'SHORT' : 'LONG' };
            break; 
        }

        let isNormal = false; let normalSide = 'SHORT';
        for (const tf of SCAN_CONFIG.THUONG) {
            const val = tf === 'M1' ? m1 : tf === 'M5' ? m5 : m15;
            if (Math.abs(val) >= systemSettings.minVol) { isNormal = true; normalSide = val > 0 ? 'LONG' : 'SHORT'; break; }
        }
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
            const resGrid = await executeMarketOrder(symbol, entrySignal.gridSide, calculatedMargin);
            const resDCA = await executeMarketOrder(symbol, entrySignal.dcaSide, calculatedMargin);

            systemBot.activePairs.set(symbol, {
                symbol: symbol,
                gridSide: entrySignal.gridSide,
                dcaSide: entrySignal.dcaSide,
                firstEntryPrice: resGrid.executedPrice,
                initialMargin: resGrid.actualMargin,
                leverage: info.maxLeverage,
                
                maxProfitIndex: 0,
                currentProfitIndex: 0,
                visitedDCAGrids: new Set([0]),
                gridOrders: [], 
                
                gridMarginTotal: resGrid.actualMargin,
                dcaMarginTotal: resDCA.actualMargin,
                createdAt: Date.now()
            });

            addLog(`[PAIR HEDGE MỚI] ${symbol} | Giá: ${resGrid.executedPrice} | Vốn đầu: ${resGrid.actualMargin.toFixed(2)}$ mỗi chiều.`, "open");
        } catch (e) {
            addLog(`❌ [LỖI MỞ LỆNH] ${symbol}: ${e.message}`, "error");
            checkAndAddBlacklist(symbol);
        }
        systemBot.isProcessingLogic.delete(symbol);
    }
}, 3000); 

appServer.listen(1820, () => console.log('🚀 [HEDGE SYSTEM] Đang chạy trên Port 1820 duy nhất!'));
