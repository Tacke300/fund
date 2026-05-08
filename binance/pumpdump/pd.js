import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 20000, headers: { 'X-MBX-APIKEY': API_KEY } });

const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true,
    options: { defaultType: 'future', dualSidePosition: true, adjustForTimeDifference: true, recvWindow: 60000 } 
});

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 0.5, posSL: 50.0, dcaStep: 10.0, maxDCA: 4 };
let status = { botLogs: [], exchangeInfo: null, candidatesList: [], isReady: false, blackList: {}, botClosedCount: 0, botPnLClosed: 0 };
let botActivePositions = new Map();
let timestampOffset = 0; 
let openingSymbols = new Set(); 

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (error) {
        throw new Error(error.response?.data?.msg || error.message);
    }
}

// KIỂM TRA VỊ THẾ THỰC TẾ TRÊN SÀN (QUAN TRỌNG)
async function getRealPosition(symbol) {
    try {
        const pos = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
        return pos.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);
    } catch (e) { return null; }
}

// CÀI TP/SL (CÓ CHECK VỊ THẾ SỐNG/CHẾT)
async function syncTPSL(symbol, side, entry, info) {
    try {
        // KIỂM TRA 1: Vị thế còn tồn tại không mới đặt TP/SL
        const realPos = await getRealPosition(symbol);
        if (!realPos) {
            addBotLog(`⚠️ [${symbol}] Vị thế đã đóng trước khi kịp cài TP/SL. Hủy cài đặt.`, "error");
            return null;
        }

        const isShort = (side === 'SHORT');
        const tpPrice = (entry * (isShort ? (1 - botSettings.posTP / 100) : (1 + botSettings.posTP / 100))).toFixed(info.pricePrecision);
        const slPrice = (entry * (isShort ? (1 + botSettings.posSL / 100) : (1 - botSettings.posSL / 100))).toFixed(info.pricePrecision);
        const sideClose = isShort ? 'buy' : 'sell';

        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        await new Promise(r => setTimeout(r, 3000));

        // Đặt lệnh TP
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: tpPrice, closePosition: true });
        await new Promise(r => setTimeout(r, 3000));

        // Đặt lệnh SL
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: slPrice, closePosition: true });
        
        addBotLog(`✨ [${symbol}] Đã cài TP:${tpPrice} | SL:${slPrice}`, "success");
        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice) };
    } catch (e) {
        addBotLog(`🚨 [${symbol}] Lỗi cài TP/SL: ${e.message}`, "error");
        return null;
    }
}

async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    const candidate = status.candidatesList.find(c => c.symbol === symbol) || { c1: 0, c5: 0, c15: 0 };
    
    // CHẶN BLACKLIST NGAY LẬP TỨC
    if (!isDCA && (status.blackList[symbol] || 0) > Date.now()) return;

    if (isDCA) {
        const cp = botActivePositions.get(posKey);
        if (!cp || cp.isProcessing) return; 
        cp.isProcessing = true;
    } else {
        if (botActivePositions.has(posKey) || openingSymbols.has(symbol)) return;
        const info = status.exchangeInfo[symbol];
        if (!info || info.maxLeverage < 20) return; // Chặn coin Lev thấp
        openingSymbols.add(symbol);
    }

    try {
        addBotLog(`🚀 [${symbol}] Đang ${isDCA ? 'DCA' : 'MỞ'} vị thế...`);
        const info = status.exchangeInfo[symbol];
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        
        let marginToUse = 0, currentDCA = 0, firstMargin = 0;
        if (isDCA) {
            let cp = botActivePositions.get(posKey);
            firstMargin = cp.firstMargin;
            marginToUse = firstMargin * 1.2; 
            currentDCA = cp.dcaCount + 1;
        } else {
            const acc = await binancePrivate('/fapi/v2/account');
            marginToUse = botSettings.invValue.toString().includes('%') 
                ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) 
                : parseFloat(botSettings.invValue);
            firstMargin = marginToUse;
        }

        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        while ((qtyNum * currentPrice) < 5.5) qtyNum += info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'market', 'sell', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });

        if (order) {
            await new Promise(r => setTimeout(r, 3000)); 
            const realPos = await getRealPosition(symbol);
            
            if (realPos) {
                const finalEntry = parseFloat(realPos.entryPrice);
                const finalQty = Math.abs(parseFloat(realPos.positionAmt));
                const finalMargin = (finalQty * finalEntry) / info.maxLeverage;

                addBotLog(`📝 [${symbol}] ${isDCA ? 'DCA' : 'OPEN'} Khớp: Entry ${finalEntry}, Margin ${finalMargin.toFixed(2)}$ [1m:${candidate.c1}% | 5m:${candidate.c5}% | 15m:${candidate.c15}%]`);

                const sync = await syncTPSL(symbol, 'SHORT', finalEntry, info);
                botActivePositions.set(posKey, { 
                    symbol, side: 'SHORT', entryPrice: finalEntry, qty: finalQty, 
                    tp: sync ? sync.tp : 0, sl: sync ? sync.sl : 0, 
                    firstMargin, dcaCount: currentDCA, 
                    isProcessing: false, markPrice: currentPrice, pnl: 0, priceDev: 0
                });
            }
        }
    } catch (e) {
        addBotLog(`🚨 [${symbol}] Lỗi mở lệnh: ${e.message}`, "error");
        if(isDCA) { 
            const cp = botActivePositions.get(posKey);
            if(cp) cp.isProcessing = false;
        }
    } finally {
        openingSymbols.delete(symbol);
    }
}

// TÍNH PNL CHÍNH XÁC VÀ TRỪ PHÍ 0.1% TỔNG VOLUME
async function trackClosedPnL(symbol, lastBotPos) {
    try {
        await new Promise(r => setTimeout(r, 5000)); // Đợi sàn kết toán
        const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, limit: 20 });
        const now = Date.now();
        // Lấy các trade trong vòng 1 phút qua của symbol này
        const recentTrades = trades.filter(t => (now - t.time) < 60000);
        
        const rawPnL = recentTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
        // Phí = Tổng Volume (Qty * Entry) * 0.1%
        const totalVolume = lastBotPos.qty * lastBotPos.entryPrice;
        const estimatedFee = totalVolume * 0.001; 
        
        const finalPnL = rawPnL - estimatedFee;
        status.botClosedCount++; 
        status.botPnLClosed += finalPnL;
        addBotLog(`✅ CHỐT ${symbol} | PnL ròng: ${finalPnL.toFixed(4)}$ (Đã trừ phí ${estimatedFee.toFixed(4)}$)`, "success");
    } catch (e) {
        addBotLog(`🚨 [${symbol}] Không lấy được PnL: ${e.message}`, "error");
    }
}

async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const now = Date.now();
        for (let [key, botPos] of botActivePositions) {
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            
            // NẾU VỊ THẾ KHÔNG CÒN TRÊN SÀN -> CHỐT
            if (!realPos || Math.abs(parseFloat(realPos.positionAmt)) === 0) {
                addBotLog(`🏁 [${botPos.symbol}] Vị thế đã đóng trên sàn.`, "info");
                status.blackList[botPos.symbol] = now + (15 * 60 * 1000); // 15p Blacklist
                trackClosedPnL(botPos.symbol, botPos);
                botActivePositions.delete(key);
            } else {
                botPos.markPrice = parseFloat(realPos.markPrice); 
                botPos.pnl = parseFloat(realPos.unRealizedProfit);
                botPos.priceDev = botPos.entryPrice ? ((botPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100 : 0;
            }
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 1000);
}

async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    try {
        // Cập nhật Blacklist (xóa bớt cho nhẹ)
        const now = Date.now();
        Object.keys(status.blackList).forEach(s => { if(status.blackList[s] < now) delete status.blackList[s]; });

        for (let [key, botPos] of botActivePositions) {
            if (botPos.isProcessing) continue; 
            if (botPos.priceDev >= botSettings.dcaStep && botPos.dcaCount < botSettings.maxDCA) { 
                await openPosition(botPos.symbol, true); 
            }
        }
        
        if (botActivePositions.size < botSettings.maxPositions && openingSymbols.size === 0) {
            const keo = status.candidatesList.find(c => {
                const info = status.exchangeInfo[c.symbol];
                const hasVol = [c.c1, c.c5].some(v => Math.abs(parseFloat(v)) >= parseFloat(botSettings.minVol));
                // KIỂM TRA BLACKLIST VÀ LEVERAGE
                return info && info.maxLeverage >= 20 && !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`) && hasVol;
            });
            if (keo) await openPosition(keo.symbol, false);
        }
    } catch (e) {}
}

async function init() {
    try {
        const timeRes = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = timeRes.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brkRes = await binancePrivate('/fapi/v1/leverageBracket');
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = (Array.isArray(brkRes) ? brkRes : brkRes.brackets || []).find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 };
        });
        status.exchangeInfo = tempInfo; status.isReady = true;
        addBotLog("👿 LUFFY V16.7 - ĐÃ FIX LỖI ĐỒNG BỘ", "success");
        priceMonitorLoop();
    } catch (e) { addBotLog("Lỗi Init: " + e.message, "error"); setTimeout(init, 5000); }
}

init(); 
setInterval(mainLoop, 3000);
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 2000);

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', async (req, res) => {
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        const bl = {}; Object.entries(status.blackList).forEach(([s, t]) => { if(t > Date.now()) bl[s] = Math.ceil((t-Date.now())/1000); });
        // Gửi activePositions từ Map để HTML hiển thị
        res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status: { ...status, blackList: bl }, wallet: { totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), availableBalance: parseFloat(acc.availableBalance).toFixed(2), totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit).toFixed(2) } });
    } catch (e) { res.json({ status }); }
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
