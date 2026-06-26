import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import ccxt from 'ccxt';

const MIN_NOTIONAL_FORCE = 5.1;
const ANTI_LIQUIDATION_LIMIT = 10; 
const MARGIN_PROTECT_LIMIT = 65;  
const MARGIN_RECOVER_LIMIT = 75;  

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 

let walletCache = { data: { totalWalletBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" }, lastUpdate: 0 };

let sharedState = { blackList: {}, permanentBlacklist: {}, candidatesList: [], exchangeInfo: null, masterLogs: [] };
let systemSettings = { isRunning: false, invValue: "1", maxPositions: 3, gridStepPercent: 1.0, heSoDCA: 1, tpPercent: 1.0, minVol: 7 };

let systemBot = {
    id: "MASTER_BOT", startTime: Date.now(),
    status: { botLogs: [], botClosedCount: 0, botPnLClosed: 0, pnlGain: 0, pnlLoss: 0, isReady: false },
    activePairs: new Map(), isProcessingLogic: new Set(), logThrottle: new Map(), timestampOffset: 0, isMarginProtected: false,
    exchange: null, binanceApi: null, currentUser: null, currentLogPath: null
};

function formatUptime(startTime) {
    const uptimeMs = Date.now() - startTime;
    const hours = Math.floor(uptimeMs / (3600 * 1000));
    const minutes = Math.floor((uptimeMs % (3600 * 1000)) / (60 * 1000));
    const seconds = Math.floor((uptimeMs % (60 * 1000)) / 1000);
    return `${hours}h ${minutes}m ${seconds}s`;
}

function addLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const logItem = { time, msg, type };
    console.log(`[${time}][${type.toUpperCase()}] ${msg}`);
    systemBot.status.botLogs.unshift(logItem);
    if (systemBot.status.botLogs.length > 200) systemBot.status.botLogs.pop();
    if (systemBot.currentLogPath) {
        try { fs.appendFileSync(systemBot.currentLogPath, `[${time}][${type.toUpperCase()}] ${msg}\n`); } catch(e){}
    }
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    if(!systemBot.binanceApi) throw new Error("API not loaded");
    try {
        const timestamp = Date.now() + systemBot.timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        const signature = crypto.createHmac('sha256', systemBot.secretKey).update(query).digest('hex');
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
        addLog(`BLACKLIST ${symbol} 15m.`, "warn");
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
        addLog(`CLOSED ${symbol} | PnL: ${totalPnL.toFixed(2)}$`, "success");
        const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol }).catch(() => []);
        for (const o of openOrders) await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId }).catch(()=>{});
        systemBot.activePairs.delete(symbol);
        checkAndAddBlacklist(symbol);
    } catch (e) {
        addLog(`ERROR CLOSE ${symbol}: ${e.message}`, "error");
    }
}

async function panicCloseAll(reasonLog) {
    try {
        const activeSymbols = Array.from(systemBot.activePairs.keys());
        for(let sym of activeSymbols) await forceCloseSymbol(sym, reasonLog);
        addLog(`PANIC CLOSE ALL (${reasonLog}).`, "warn");
        return { success: true };
    } catch (e) { return { success: false, msg: e.message }; }
}

async function executeMarketOrder(symbol, side, marginUSD) {
    const info = sharedState.exchangeInfo[symbol];
    if(!info) throw new Error("Coin not supported");
    const ticker = await systemBot.binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
    const currentPrice = parseFloat(ticker.data.price);
    const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || MIN_NOTIONAL_FORCE);
    let desiredQty = (marginUSD * info.maxLeverage) / currentPrice;
    let qty = Math.floor(desiredQty / info.stepSize) * info.stepSize;
    if (qty * currentPrice < actualMinNotional) qty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
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
            if (!gridPos && !dcaPos) { systemBot.activePairs.delete(symbol); checkAndAddBlacklist(symbol); continue; }
            const markP = parseFloat((gridPos || dcaPos).markPrice);
            const totalMarginBoth = pair.gridMarginTotal + pair.dcaMarginTotal;
            const combinedPnL = (gridPos ? parseFloat(gridPos.unRealizedProfit) : 0) + (dcaPos ? parseFloat(dcaPos.unRealizedProfit) : 0);
            const targetPnLUSD = totalMarginBoth * (systemSettings.tpPercent / 100) * pair.leverage;
            if (combinedPnL >= targetPnLUSD) {
                systemBot.isProcessingLogic.add(symbol);
                addLog(`TARGET HIT ${symbol} PnL (${combinedPnL.toFixed(2)}$). Closing!`, "success");
                await forceCloseSymbol(symbol, "TARGET HIT");
                systemBot.isProcessingLogic.delete(symbol);
                continue;
            }
            const dir = pair.gridSide === 'LONG' ? 1 : -1;
            const relativeK = Math.round((markP - pair.firstEntryPrice) / (pair.firstEntryPrice * (systemSettings.gridStepPercent / 100))) * dir;
            if (relativeK > pair.maxRelativeK) {
                systemBot.isProcessingLogic.add(symbol);
                for (let k = pair.maxRelativeK + 1; k <= relativeK; k++) {
                    if (!pair.executedMacDinh.includes(k)) {
                        try {
                            pair.dcaMacDinhCount++;
                            const marginToOpen = pair.initialMargin;
                            await executeMarketOrder(symbol, pair.dcaSide, marginToOpen);
                            pair.dcaMarginTotal += marginToOpen;
                            pair.executedMacDinh.push(k);
                            addLog(`DCA MAC DINH ${symbol} | K: ${k}`, "dca");
                        } catch(e) {}
                    }
                }
                pair.maxRelativeK = relativeK;
                systemBot.isProcessingLogic.delete(symbol);
            }
            if (relativeK < pair.maxRelativeK) {
                systemBot.isProcessingLogic.add(symbol);
                for (let k = pair.maxRelativeK - 1; k >= relativeK; k--) {
                    if (!pair.executedNote.includes(k)) {
                        try {
                            pair.dcaNoteCount++;
                            if (pair.executedMacDinh.includes(k)) {
                                const marginNote = pair.initialMargin * systemSettings.heSoDCA;
                                await executeMarketOrder(symbol, pair.gridSide, marginNote);
                                pair.gridMarginTotal += marginNote;
                            } else {
                                const marginMacDinh = pair.initialMargin;
                                const marginNote = pair.initialMargin * systemSettings.heSoDCA;
                                await executeMarketOrder(symbol, pair.dcaSide, marginMacDinh);
                                await executeMarketOrder(symbol, pair.gridSide, marginNote);
                                pair.dcaMarginTotal += marginMacDinh;
                                pair.gridMarginTotal += marginNote;
                                pair.executedMacDinh.push(k);
                            }
                            pair.executedNote.push(k);
                            addLog(`DCA NOTE ${symbol} | K: ${k}`, "warn");
                        } catch(e) {}
                    }
                }
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
            await panicCloseAll(`LIQUIDATION PREVENT`); 
            systemBot.isMarginProtected = false; 
            return; 
        }
    }
}

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
        if (isNormal) { entrySignal = { symbol: c.symbol, gridSide: normalSide, dcaSide: normalSide === 'LONG' ? 'SHORT' : 'LONG' }; break; }
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
                symbol: symbol, gridSide: entrySignal.gridSide, dcaSide: entrySignal.dcaSide,
                firstEntryPrice: resGrid.executedPrice, initialMargin: resGrid.actualMargin, leverage: info.maxLeverage,
                maxRelativeK: 0, executedMacDinh: [0], executedNote: [], dcaMacDinhCount: 0, dcaNoteCount: 0,
                gridMarginTotal: resGrid.actualMargin, dcaMarginTotal: resDCA.actualMargin, createdAt: Date.now()
            });
            addLog(`NEW HEDGE PAIR ${symbol}`, "open");
        } catch (e) {
            addLog(`ERROR OPEN ${symbol}: ${e.message}`, "error");
            checkAndAddBlacklist(symbol);
        }
        systemBot.isProcessingLogic.delete(symbol);
    }
}, 3000);

const appServer = express(); 
appServer.use(express.json()); 

async function buildStatusResponse() {
    const now = Date.now();
    if (now - walletCache.lastUpdate > 3000) {
        const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
        if (acc) {
            walletCache.data = { totalWalletBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2), availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) };
            walletCache.lastUpdate = now;
        }
    }
    return { 
        botSettings: systemSettings, 
        activePositions: Array.from(systemBot.activePairs.values()), 
        status: { botLogs: systemBot.status.botLogs, botClosedCount: systemBot.status.botClosedCount, botPnLClosed: systemBot.status.botPnLClosed }, 
        wallet: walletCache.data
    };
}

appServer.post('/api/user/toggle', async (req, res) => {
    const { username, apiKey, secretKey, isRunning } = req.body;
    systemSettings.isRunning = isRunning;
    systemBot.currentUser = username;
    systemBot.secretKey = secretKey;
    systemBot.currentLogPath = path.join(__dirname, 'user', username, 'botgrid_log.txt');
    if(!systemBot.exchange) {
        systemBot.exchange = new ccxt.binance({ apiKey, secret: secretKey, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, adjustForTimeDifference: true, recvWindow: 60000 } });
        systemBot.binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': apiKey } });
        await systemBot.exchange.loadMarkets();
        const info = await systemBot.binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate('/fapi/v1/leverageBracket');
        const temp = {};
        info.data.symbols.forEach(s => {
            if (s.status !== 'TRADING') return; 
            const b = brk.find(x => x.symbol === s.symbol); const maxLev = b?.brackets[0]?.initialLeverage || 20;
            if (maxLev < 20) { sharedState.permanentBlacklist[s.symbol] = true; return; }
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 5.0), maxLeverage: maxLev };
        });
        sharedState.exchangeInfo = temp; 
        systemBot.status.isReady = true;
        priceMonitor();
    }
    res.json({ success: true, status: isRunning ? "RUNNING" : "STOPPED" });
});

appServer.post('/api/user/status', async (req, res) => {
    if(!systemBot.exchange && req.body.apiKey) {
        systemBot.secretKey = req.body.secretKey;
        systemBot.binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': req.body.apiKey } });
    }
    const masterData = await buildStatusResponse();
    res.json(masterData);
});

appServer.get('/:username', (req, res) => {
    const logPath = path.join(__dirname, 'user', req.params.username, 'botgrid_log.txt');
    if (fs.existsSync(logPath)) res.send(`<pre>${fs.readFileSync(logPath, 'utf8')}</pre>`);
    else res.send("NO LOGS");
});

appServer.listen(1842, '127.0.0.1', () => console.log('BOT GRID DCA PORT 1842'));
