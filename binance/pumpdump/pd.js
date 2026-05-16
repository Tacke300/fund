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
let status = { botLogs: [], candidatesList: [], blackList: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: {}, isReady: false, isHedgeMode: true };
let botActivePositions = new Map();
let isProcessingDCA = new Set();
let serverTimeOffset = 0;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 60) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function binanceRequest(method, endpoint, data = {}) {
    const timestamp = Date.now() + serverTimeOffset;
    const mergedData = { ...data, timestamp, recvWindow: 10000 };
    
    const queryForSign = new URLSearchParams(mergedData).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(queryForSign).digest('hex');
    
    const finalParams = { ...mergedData, signature };
    const queryString = new URLSearchParams(finalParams).toString();
    const url = `${endpoint}?${queryString}`;
    
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
                const markP = parseFloat(realP.markPrice);
                b.pnl = parseFloat(realP.unRealizedProfit);
                b.priceDev = ((markP - b.entryPrice) / b.entryPrice) * 100;
            } else {
                if (isProcessingDCA.has(b.symbol)) continue;
                
                addBotLog(`⚠️ Vị thế ${b.symbol} (${b.side}) không còn trên sàn. Tiến hành check userTrades...`);
                const trades = await binanceRequest('GET', '/fapi/v1/userTrades', { symbol: b.symbol, limit: 10 }).catch(() => []);
                const recent = trades.filter(t => (Date.now() + serverTimeOffset - t.time) < 60000);
                let totalR = 0; recent.forEach(t => totalR += parseFloat(t.realizedPnl));
                
                status.botClosedCount++; 
                status.botPnLClosed += totalR;

                if (totalR > 0) {
                    botActivePositions.delete(key);
                    status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                    addBotLog(`💰 [KẾT QUẢ: WIN] Đã chốt lời ${b.symbol} (${b.side}) | PnL: ${totalR.toFixed(2)}$ | Khóa vị thế 15p.`, 'success');
                } else {
                    addBotLog(`❌ [KẾT QUẢ: LOSS] Vị thế ${b.symbol} dính SL lỗ thực tế: ${totalR.toFixed(2)}$`);
                    
                    const ticker = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price?symbol=' + b.symbol);
                    const currentPrice = parseFloat(ticker.data.price);
                    
                    const jump = Math.max(b.dcaCount + 1, Math.floor((currentPrice - b.firstEntry) / (b.firstEntry * botSettings.posSL / 100)));
                    
                    botActivePositions.delete(key);

                    if (jump <= botSettings.maxDCA) {
                        addBotLog(`🔄 [HÀNH ĐỘNG] Kích hoạt DCA Cấp [${jump}/${botSettings.maxDCA}] cho ${b.symbol}.`);
                        openPosition(b.symbol, { ...b, dcaCount: jump, margin: b.firstMargin * (jump + 1) });
                    } else {
                        addBotLog(`🚨 [HÀNH ĐỘNG] Chạm trần DCA. Tiến hành QUAY XE mở vị thế LONG CUỐI x20 vốn cho ${b.symbol}.`);
                        openPosition(b.symbol, { ...b, isFinalLong: true, margin: b.firstMargin * 20 });
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
    
    const isLong = dcaData?.isFinalLong ? true : false;
    const side = isLong ? 'LONG' : 'SHORT';
    const positionSideParam = status.isHedgeMode ? side : 'BOTH';
    const orderSideParam = isLong ? 'BUY' : 'SELL';
    
    const currentDCALevel = dcaData ? dcaData.dcaCount : 0;
    
    console.log(`\n=================== THAO TÁC VÀO LỆNH: ${symbol} ===================`);
    addBotLog(`🎬 Khởi động quy trình mở vị thế ${symbol} [${side}] - DCA Lần: ${currentDCALevel}`);
    
    try {
        const info = status.exchangeInfo[symbol];
        const acc = await binanceRequest('GET', '/fapi/v2/account');
        
        let margin = dcaData ? dcaData.margin : (botSettings.invValue.toString().includes('%') ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue) / 100) : parseFloat(botSettings.invValue));
        
        const orderNotional = margin * info.maxLeverage;
        if (orderNotional < info.minNotional) {
            margin = (info.minNotional + 0.5) / info.maxLeverage;
            console.log(`⚠️ Volume vị thế (${orderNotional.toFixed(2)}$) nhỏ hơn Min Notional quy định (${info.minNotional}$). Ép Ký Quy lên: ${margin.toFixed(4)}$`);
        }
        
        const ticker = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price?symbol=' + symbol);
        const price = parseFloat(ticker.data.price);
        
        let rawQty = (margin * info.maxLeverage) / price;
        let qty = Number((Math.ceil(rawQty / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision));
        
        console.log(`[THÔNG SỐ ĐẦU VÀO] Vốn: ${margin.toFixed(2)}$ | Đòn bẩy: x${info.maxLeverage} | Khối lượng Qty: ${qty}`);
        
        await binanceRequest('POST', '/fapi/v1/leverage', { symbol, leverage: info.maxLeverage });
        
        console.log(`[1/3] Gửi lệnh MARKET mở vị thế...`);
        const order = await binanceRequest('POST', '/fapi/v1/order', { 
            symbol, 
            side: orderSideParam, 
            positionSide: positionSideParam, 
            type: 'MARKET', 
            quantity: qty 
        });
        
        if (order) {
            console.log(`✅ Lệnh MARKET khớp thành công. Đang quét xác thực trạng thái vị thế...`);
            
            let p = null;
            for (let i = 0; i < 10; i++) {
                await new Promise(r => setTimeout(r, 300));
                const pRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol }).catch(() => []);
                p = pRisk.find(x => x.positionSide === positionSideParam && Math.abs(parseFloat(x.positionAmt)) > 0);
                if (p) {
                    console.log(`⚡ Tìm thấy vị thế thực tế trên sàn tại lần quét thứ ${i + 1}.`);
                    break;
                }
            }
            
            if (p) {
                const entry = parseFloat(p.entryPrice);
                const firstE = dcaData ? dcaData.firstEntry : entry;
                
                let tp = isLong ? entry * 1.10 : entry * (1 - botSettings.posTP / 100);
                
                // GIỮ NGUYÊN TƯ DUY MARTINGALE: SL cố định tính theo giá của entry đầu tiên (firstEntry)
                let sl = isLong ? entry * 0.90 : firstE + (firstE * botSettings.posSL / 100);
                
                addBotLog(`📊 [MỞ VỊ THẾ THÀNH CÔNG] ${symbol} | Giá Entry TB: ${entry} (Gốc: ${firstE}) | Đích TP: ${tp.toFixed(info.pricePrecision)} | Đích SL: ${sl.toFixed(info.pricePrecision)}`);
                
                // ĐẢO LÊN TRƯỚC: Lưu dữ liệu vào Map trước để hàm syncTPSL lấy được khối lượng vị thế
                botActivePositions.set(`${symbol}_${positionSideParam}`, { 
                    symbol, side, entryPrice: entry, tp, sl, 
                    dcaCount: currentDCALevel, 
                    leverage: info.maxLeverage, firstEntry: firstE, 
                    firstMargin: dcaData ? dcaData.firstMargin : margin, 
                    currentQty: Math.abs(parseFloat(p.positionAmt)), pnl: 0, priceDev: 0 
                });
                
                // Gọi đặt lệnh TP/SL sau khi Map đã sẵn sàng dữ liệu
                await syncTPSL(symbol, side, info, tp, sl);
            } else {
                addBotLog(`❌ [THẤT BẠI] Lệnh MARKET đã khớp nhưng vòng lặp đồng bộ không tìm thấy vị thế ${symbol} trên sàn.`, 'error');
            }
        }
    } catch (e) { 
        addBotLog(`❌ [LỖI QUY TRÌNH] Quy trình mở vị thế thất bại: ${e.msg || e.message || JSON.stringify(e)}`, 'error'); 
    } finally { 
        console.log(`====================================================================\n`);
        isProcessingDCA.delete(symbol); 
    }
}

async function syncTPSL(symbol, side, info, tp, sl) {
    const positionSideParam = status.isHedgeMode ? side : 'BOTH';
    const sideClose = (side === 'SHORT') ? 'BUY' : 'SELL';

    const pos = botActivePositions.get(`${symbol}_${positionSideParam}`);

    if (!pos) {
        console.log(`❌ Không tìm thấy dữ liệu vị thế trong Map để đặt TP/SL cho ${symbol}`);
        return;
    }

    // FIX CHỐNG LỖI PRECISION: Tính toán Qty làm tròn chuẩn theo quy định stepSize của từng tài sản rác/meme
    const qty = parseFloat(
        (Math.floor(pos.currentQty / info.stepSize) * info.stepSize)
        .toFixed(info.quantityPrecision)
    );

    try {
        const orders = await binanceRequest('GET', '/fapi/v1/openOrders', { symbol });
        const targetOrders = orders.filter(o =>
            o.positionSide === positionSideParam &&
            (o.type === 'TAKE_PROFIT_MARKET' || o.type === 'STOP_MARKET')
        );

        for (const o of targetOrders) {
            await binanceRequest('DELETE', '/fapi/v1/order', { symbol, orderId: o.orderId });
        }
        console.log(`🧹 Đã dọn sạch ${targetOrders.length} lệnh TP/SL cũ của ${symbol}`);
    } catch (e) {
        console.log(`⚠️ Lỗi dọn dẹp lệnh cũ của ${symbol}:`, e.msg || e.message);
    }

    // FIX HEDGE MODE: Không dùng reduceOnly, không dùng closePosition. Chỉ cần quantity + positionSide là đủ hiểu.
    const baseParam = {
        symbol,
        side: sideClose,
        positionSide: positionSideParam,
        quantity: qty,
        workingType: 'MARK_PRICE'
    };

    // ĐẶT LỆNH TAKE PROFIT
    try {
        const resTP = await binanceRequest('POST', '/fapi/v1/order', {
            ...baseParam,
            type: 'TAKE_PROFIT_MARKET',
            stopPrice: Number(tp.toFixed(info.pricePrecision))
        });
        if (resTP && resTP.orderId) {
            console.log(`🎯 Đặt lệnh TP [OK] cho ${symbol} | Mức giá: ${tp.toFixed(info.pricePrecision)} | OrderID: ${resTP.orderId}`);
        }
    } catch (e) {
        addBotLog(`❌ Đặt lệnh TP ${symbol} thất bại: ${e.msg || e.message || JSON.stringify(e)}`, 'error');
    }

    // ĐẶT LỆNH STOP LOSS
    try {
        const resSL = await binanceRequest('POST', '/fapi/v1/order', {
            ...baseParam,
            type: 'STOP_MARKET',
            stopPrice: Number(sl.toFixed(info.pricePrecision))
        });
        if (resSL && resSL.orderId) {
            console.log(`🛑 Đặt lệnh SL [OK] cho ${symbol} | Mức giá: ${sl.toFixed(info.pricePrecision)} | OrderID: ${resSL.orderId}`);
        }
    } catch (e) {
        addBotLog(`❌ Đặt lệnh SL ${symbol} thất bại: ${e.msg || e.message || JSON.stringify(e)}`, 'error');
    }
}

async function init() {
    console.log(`[${new Date().toLocaleTimeString()}] 🔄 Đang cấu hình hệ thống...`);
    try {
        const ipRes = await axios.get('https://api.ipify.org?format=json', { timeout: 4000 }).catch(() => ({ data: { ip: "Không lấy được" } }));
        console.log(`🌐 [CHECK IP] IPv4 Hiện Tại Của Bot: ${ipRes.data.ip}`);

        const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
        serverTimeOffset = t.data.serverTime - Date.now();
        
        const posMode = await binanceRequest('GET', '/fapi/v1/positionSide/dual');
        status.isHedgeMode = posMode.dualSidePosition;
        console.log(`⚙️ [TÀI KHOẢN] Chế độ vị thế: ${status.isHedgeMode ? 'HEDGE MODE (Phòng hộ)' : 'ONE-WAY MODE (Một chiều)'}`);

        const info = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
        const brk = await binanceRequest('GET', '/fapi/v1/leverageBracket').catch(() => []);
        
        const temp = {};
        info.data.symbols.forEach(s => {
            const b = brk.find(x => x.symbol === s.symbol);
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            
            const notionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
            const minNotionalValue = notionalFilter ? parseFloat(notionalFilter.notional || notionalFilter.minNotional) : 5.0;

            temp[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), 
                minNotional: minNotionalValue,
                maxLeverage: b?.brackets[0]?.initialLeverage || 20 
            };
        });
        
        status.exchangeInfo = temp; 
        status.isReady = true; 
        priceMonitor();
        addBotLog(`🚀 Khởi tạo thành công! Hệ thống sẵn sàng vào lệnh.`);
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

setInterval(() => {
    if (!status.isReady || !botSettings.isRunning) return;
    if (botActivePositions.size >= botSettings.maxPositions || isProcessingDCA.size > 0) return;

    const can = status.candidatesList.find(c => {
        const info = status.exchangeInfo[c.symbol];
        if (!info || info.maxLeverage < 20) return false;
        if (Math.abs(c.c1) < botSettings.minVol) return false;
        if (status.blackList[c.symbol]) return false;

        const hasLong = botActivePositions.has(`${c.symbol}_LONG`);
        const hasShort = botActivePositions.has(`${c.symbol}_SHORT`);
        const hasBoth = botActivePositions.has(`${c.symbol}_BOTH`);

        return (!hasLong && !hasShort && !hasBoth);
    });

    if (can) {
        console.log(`🎯 [TÍN HIỆU] Phát hiện Coin tiềm năng: ${can.symbol} (Vol: ${can.c1}). Gọi lệnh mở vị thế...`);
        openPosition(can.symbol);
    }
}, 3000);

APP.listen(9001);
