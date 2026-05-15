import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const MAX_DCA_LEVEL = 3; 
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binanceApi = axios.create({ 
    baseURL: 'https://fapi.binance.com', 
    timeout: 15000, 
    headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' } 
});

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 1.2, posSL: 10.0, maxDCA: MAX_DCA_LEVEL };
let status = { botLogs: [], candidatesList: [], blackList: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: {}, isReady: false };
let botActivePositions = new Map();
let isProcessingDCA = new Set();
let serverTimeOffset = 0;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function binanceRequest(method, endpoint, data = {}) {
    const timestamp = Date.now() + serverTimeOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 10000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    const url = `${endpoint}?${query}&signature=${signature}`;
    
    try {
        const response = await binanceApi({ method, url });
        return response.data;
    } catch (e) {
        if (e.response?.data?.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            serverTimeOffset = t.data.serverTime - Date.now();
            return binanceRequest(method, endpoint, data);
        }
        throw e.response?.data || e;
    }
}

async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        const posRisk = await binanceRequest('GET', '/fapi/v2/positionRisk').catch(() => null);
        if (!posRisk) return setTimeout(priceMonitor, 1000);

        for (let [key, b] of botActivePositions) {
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            if (realP) {
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);
                b.pnl = parseFloat(realP.unRealizedProfit);
                b.priceDev = ((markP - b.entryPrice) / b.entryPrice) * 100;
            } else {
                if (isProcessingDCA.has(b.symbol)) continue;
                
                // Lấy PnL thực tế vừa khớp đóng lệnh
                const trades = await binanceRequest('GET', '/fapi/v1/userTrades', { symbol: b.symbol, limit: 10 }).catch(() => []);
                const recent = trades.filter(t => (Date.now() + serverTimeOffset - t.time) < 60000);
                let totalR = 0; recent.forEach(t => totalR += parseFloat(t.realizedPnl));
                
                botActivePositions.delete(key);
                status.botClosedCount++; 
                status.botPnLClosed += totalR;

                // Nếu chốt lời thành công hoặc vị thế vừa đóng là lệnh LONG cuối cùng -> Đưa vào danh sách đen chặn 15p
                if (totalR > 0 || b.side === 'LONG') {
                    status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                    addBotLog(`💰 CHỐT PHÁT 💎 ${b.symbol} (${b.side}) | PnL: ${totalR.toFixed(2)}$`);
                } else {
                    // PHẦN LOGIC DCA KHI DÍNH CẮT LỖ (DÀNH CHO LỆNH SHORT THUA LỖ)
                    const ticker = await axios.get(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${b.symbol}`);
                    const currentPrice = parseFloat(ticker.data.price);
                    
                    // Tính toán bước nhảy dca dựa trên độ lệch giá hiện tại so với giá entry đầu tiên
                    const jump = Math.max(b.dcaCount + 1, Math.floor((currentPrice - b.firstEntry) / (b.firstEntry * botSettings.posSL / 100)));
                    
                    if (jump <= botSettings.maxDCA) {
                        addBotLog(`⚠️ ${b.symbol} dính SL. Kích hoạt DCA Cấp [${jump}/${botSettings.maxDCA}]`);
                        openPosition(b.symbol, { 
                            ...b, 
                            dcaCount: jump, 
                            margin: b.firstMargin * (jump + 1) 
                        });
                    } else {
                        addBotLog(`🚨 ${b.symbol} Vượt ngưỡng DCA! Xả SHORT - QUAY XE VÀO LỆNH LONG CUỐI X20 vốn.`);
                        openPosition(b.symbol, { 
                            ...b, 
                            isFinalLong: true, 
                            margin: b.firstMargin * 20 
                        });
                    }
                }
            }
        }
    } catch (e) {}
    setTimeout(priceMonitor, 1000);
}

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    let walletData = { totalWalletBalance: "0.00", availableBalance: "0.00", totalUnrealizedProfit: "0.00" };
    try {
        const acc = await binanceRequest('GET', '/fapi/v2/account');
        const botUnrealizedPnL = Array.from(botActivePositions.values()).reduce((s, p) => s + (p.pnl || 0), 0);
        walletData = {
            totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), 
            availableBalance: parseFloat(acc.availableBalance).toFixed(2), 
            totalUnrealizedProfit: botUnrealizedPnL.toFixed(2)
        };
    } catch (e) {}

    res.json({ 
        botSettings, 
        activePositions: Array.from(botActivePositions.values()),
        status: { ...status, blackList: Object.fromEntries(Object.entries(status.blackList).map(([s, t]) => [s, Math.max(0, Math.floor((t - Date.now()) / 1000))])) }, 
        wallet: walletData
    });
});

APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });

async function openPosition(symbol, dcaData = null) {
    if (!status.exchangeInfo[symbol]) return;
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol);
    
    // Nếu là lệnh dca cuối vượt ngưỡng thì đánh LONG, còn lại chu kỳ bình thường đánh SHORT
    const side = dcaData?.isFinalLong ? 'LONG' : 'SHORT';
    try {
        const info = status.exchangeInfo[symbol];
        const acc = await binanceRequest('GET', '/fapi/v2/account');
        
        // Tính Margin
        let margin = dcaData ? dcaData.margin : (botSettings.invValue.toString().includes('%') ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue) / 100) : parseFloat(botSettings.invValue));
        if ((margin * info.maxLeverage) < 6.5) margin = 6.5 / info.maxLeverage;
        
        const ticker = await axios.get(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
        const price = parseFloat(ticker.data.price);
        let qty = (Math.ceil(((margin * info.maxLeverage) / price) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);
        
        // Sét đòn bẩy tối đa của coin
        await binanceRequest('POST', '/fapi/v1/leverage', { symbol, leverage: info.maxLeverage });
        
        // Đặt lệnh Market mở vị thế
        const order = await binanceRequest('POST', '/fapi/v1/order', { symbol, side: side === 'SHORT' ? 'SELL' : 'BUY', positionSide: side, type: 'MARKET', quantity: qty });
        
        if (order) {
            await new Promise(r => setTimeout(r, 1200));
            const pRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol });
            const p = pRisk.find(x => x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0);
            
            if (p) {
                const entry = parseFloat(p.entryPrice);
                const firstE = dcaData ? dcaData.firstEntry : entry;
                
                // LOGIC CÀI TP/SL ĐÚNG THEO PHẦN TRĂM CỦA ÔNG
                let tp = (side === 'LONG') ? entry * 1.10 : entry * (1 - botSettings.posTP / 100);
                let sl = (side === 'LONG') ? entry * 0.90 : firstE + (firstE * botSettings.posSL / 100);
                
                // Đồng bộ cài lệnh dừng TP/SL lên sàn luôn
                await syncTPSL(symbol, side, info, tp, sl);
                
                botActivePositions.set(`${symbol}_${side}`, { 
                    symbol, side, entryPrice: entry, tp, sl, 
                    dcaCount: dcaData ? dcaData.dcaCount : 0, 
                    leverage: info.maxLeverage, firstEntry: firstE, 
                    firstMargin: dcaData ? dcaData.firstMargin : margin, 
                    currentQty: Math.abs(parseFloat(p.positionAmt)), pnl: 0, priceDev: 0 
                });
                addBotLog(`✅ Đã mở vị thế ${symbol} [${side}] thành công.`);
            }
        }
    } catch (e) { addBotLog(`❌ Lỗi mở lệnh: ${e.msg || e.message}`); }
    finally { setTimeout(() => isProcessingDCA.delete(symbol), 2000); }
}

// KHÔI PHỤC HÀM ĐẶT TP/SL LÊN SÀN
async function syncTPSL(symbol, side, info, tp, sl) {
    try {
        // Xóa sạch lệnh dừng cũ của coin này tránh xung đột lệnh cũ mới
        const orders = await binanceRequest('GET', '/fapi/v1/openOrders', { symbol });
        for (const o of orders.filter(o => o.positionSide === side)) { 
            await binanceRequest('DELETE', '/fapi/v1/order', { symbol, orderId: o.orderId }); 
        }
        const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
        
        // Rải lại 2 lệnh dừng Market (Được kích hoạt theo giá Mark)
        await binanceRequest('POST', '/fapi/v1/order', { symbol, side: sideClose, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: tp.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' });
        await binanceRequest('POST', '/fapi/v1/order', { symbol, side: sideClose, positionSide: side, type: 'STOP_MARKET', stopPrice: sl.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' });
    } catch (e) {
        console.error(`[TP/SL Error] Không đồng bộ được TP/SL cho ${symbol}:`, e.msg || e.message);
    }
}

async function init() {
    console.log(`[${new Date().toLocaleTimeString()}] 🔄 Đang khởi tạo hệ thống...`);
    try {
        const ipRes = await axios.get('https://api.ipify.org?format=json', { timeout: 4000 }).catch(() => ({ data: { ip: "Không lấy được" } }));
        console.log(`🌐 [CHECK IP] IPv4 Hiện Tại Của Bot: ${ipRes.data.ip}`);

        const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
        serverTimeOffset = t.data.serverTime - Date.now();
        
        const info = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
        const brk = await binanceRequest('GET', '/fapi/v1/leverageBracket').catch(() => []);
        
        const temp = {};
        info.data.symbols.forEach(s => {
            const b = brk.find(x => x.symbol === s.symbol);
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            temp[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), 
                maxLeverage: b?.brackets[0]?.initialLeverage || 20 
            };
        });
        
        status.exchangeInfo = temp; 
        status.isReady = true; 
        priceMonitor();
        addBotLog(`🚀 Hệ thống đã sẵn sàng và chạy đúng logic gốc!`);
    } catch (e) { 
        console.error("❌ Hệ thống khởi tạo thất bại:", e.message); 
        setTimeout(init, 5000); 
    }
}
init();

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

// VÒNG LẶP QUÉT VÀ LỌC MỞ LỆNH CHUẨN LOGIC
setInterval(() => {
    if (!status.isReady || !botSettings.isRunning) return;
    if (botActivePositions.size < botSettings.maxPositions && isProcessingDCA.size === 0) {
        
        const can = status.candidatesList.find(c => {
            const info = status.exchangeInfo[c.symbol];
            return (
                Math.abs(c.c1) >= botSettings.minVol &&        // Đạt điều kiện Volume quét
                !status.blackList[c.symbol] &&                 // Không nằm trong danh sách đen chặn 15p
                !botActivePositions.has(`${c.symbol}_SHORT`) && // Không trùng lệnh SHORT đang chạy của chính nó
                info && info.maxLeverage >= 20                 // 🔥 LOGIC KHÓA: CHỈ CHẤP NHẬN COIN CÓ MAX LEVERAGE TỪ 20 TRỞ LÊN
            );
        });
        
        if (can) openPosition(can.symbol);
    }
}, 3000);

APP.listen(9001);
