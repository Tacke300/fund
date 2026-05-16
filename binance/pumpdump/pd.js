import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs'; // Tích hợp module file hệ thống để ghi Raw Log Debug
import { API_KEY, SECRET_KEY } from './config.js';

const MAX_DCA_LEVEL = 3; 
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_FILE_PATH = path.join(__dirname, 'bot_raw_debug.log');

const binanceApi = axios.create({ 
    baseURL: 'https://fapi.binance.com', 
    timeout: 15000, 
    headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' } 
});

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 1.2, posSL: 10.0, maxDCA: MAX_DCA_LEVEL };
let status = { botLogs: [], candidatesList: [], blackList: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: {}, isReady: false, isHedgeMode: true };
let botActivePositions = new Map();
let isProcessingDCA = new Set();
let leverageCache = new Set(); 
let serverTimeOffset = 0;
let isOpeningPosition = false; // FIX BUG RACE CONDITION: Khóa Global chống double open lệnh trùng

function getPrecision(stepSize) {
    const step = stepSize.toString();
    if (!step.includes('.')) return 0;
    return step.split('.')[1].replace(/0+$/, '').length;
}

// HÀM GHI RAW LOG DEBUG RA FILE CHUYÊN DỤNG ĐỂ SOI MÃ LỖI BINANCE (-2019, -2021, -4164...)
function writeRawDebugLog(type, endpoint, payload, responseOrError, latency) {
    const logTime = new Date().toISOString();
    const dataToLog = {
        time: logTime,
        type: type, // 'REQUEST_SUCCESS' hoặc 'REQUEST_ERROR'
        endpoint: endpoint,
        requestData: payload,
        latencyMs: latency,
        result: responseOrError
    };
    fs.appendFile(LOG_FILE_PATH, JSON.stringify(dataToLog) + '\n', (err) => {
        if (err) console.error('❌ Không thể ghi file log debug:', err);
    });
}

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 60) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function binanceRequest(method, endpoint, data = {}) {
    const startTime = Date.now();
    const timestamp = startTime + serverTimeOffset;
    const mergedData = { ...data, timestamp, recvWindow: 10000 };
    
    const queryForSign = new URLSearchParams(mergedData).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(queryForSign).digest('hex');
    
    const finalParams = { ...mergedData, signature };
    const queryString = new URLSearchParams(finalParams).toString();
    const url = `${endpoint}?${queryString}`;
    
    try {
        const response = await binanceApi({ method, url });
        const latency = Date.now() - startTime;
        
        // Ghi Log thành công ra file
        writeRawDebugLog('SUCCESS', endpoint, data, response.data, latency);
        return response.data;
    } catch (e) {
        const latency = Date.now() - startTime;
        const errorPayload = e.response?.data || { message: e.message, code: 'NETWORK_OR_TIMEOUT' };
        
        // Ghi Log lỗi chi tiết kẹp full raw response/error code
        writeRawDebugLog('ERROR', endpoint, data, errorPayload, latency);

        if (errorPayload.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            serverTimeOffset = t.data.serverTime - Date.now();
            return binanceRequest(method, endpoint, data);
        }
        throw errorPayload;
    }
}

async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        const posRisk = await binanceRequest('GET', '/fapi/v2/positionRisk').catch(() => null);
        if (!posRisk) return setTimeout(priceMonitor, 1000);

        for (let [key, b] of botActivePositions) {
            let realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            // FIX BUG BINANCE LAG (MỤC 3): Nếu không tìm thấy vị thế, bắt buộc phải đợi 1.5s và gọi check lại lần nữa chống DCA oan
            if (!realP) {
                await new Promise(r => setTimeout(r, 1500));
                const recheckPosRisk = await binanceRequest('GET', '/fapi/v2/positionRisk').catch(() => null);
                
                if (recheckPosRisk) {
                    realP = recheckPosRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
                    if (realP) {
                        console.log(`🛡️ [BẢO VỆ CAP] Sàn lag hụt vị thế ảo của ${b.symbol}. Đã cứu nguy thành công, chặn đứng chuỗi DCA sai lệch!`);
                    }
                }
            }

            if (realP) {
                const markP = parseFloat(realP.markPrice);
                b.pnl = parseFloat(realP.unRealizedProfit);
                
                b.priceDev = b.side === 'SHORT'
                    ? ((b.entryPrice - markP) / b.entryPrice) * 100
                    : ((markP - b.entryPrice) / b.entryPrice) * 100;

            } else {
                if (isProcessingDCA.has(b.symbol)) continue;
                
                addBotLog(`⚠️ Vị thế ${b.symbol} (${b.side}) xác thực không còn trên sàn. Tiến hành check userTrades...`);
                // FIX BUG LIMIT (MỤC 4): Nâng limit lên 50 lệnh để bảo toàn quét đủ khi dính chuỗi partial fill dồn dập
                const trades = await binanceRequest('GET', '/fapi/v1/userTrades', { symbol: b.symbol, limit: 50 }).catch(() => []);
                const recent = trades.filter(t => (Date.now() + serverTimeOffset - t.time) < 60000);
                let totalR = 0; recent.forEach(t => totalR += parseFloat(t.realizedPnl));
                
                status.botClosedCount++; 
                status.botPnLClosed += totalR;

                if (totalR > (-b.firstMargin * 0.02)) {
                    botActivePositions.delete(key);
                    status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                    addBotLog(`💰 [KẾT QUẢ: WIN] Đã chốt lời ${b.symbol} (${b.side}) | PnL: ${totalR.toFixed(2)}$ | Khóa vị thế 15p.`, 'success');
                } else {
                    addBotLog(`❌ [KẾT QUẢ: LOSS] Vị thế ${b.symbol} dính SL lỗ thực tế: ${totalR.toFixed(2)}$`);
                    
                    const ticker = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price?symbol=' + b.symbol);
                    const currentPrice = parseFloat(ticker.data.price);
                    
                    // FIX BUG MATH.ABS (MỤC 5): Tách biệt chiều tính toán khoảng cách giá cho lệnh SHORT để định vị chuẩn hướng thua lỗ
                    const distance = b.side === 'SHORT'
                        ? currentPrice - b.firstEntry
                        : b.firstEntry - currentPrice;
                    
                    botActivePositions.delete(key);

                    // Chỉ tiến hành chuỗi logic DCA khi giá thực tế đi ngược hướng vị thế (distance > 0)
                    if (distance > 0) {
                        const jump = Math.max(
                            b.dcaCount + 1, 
                            Math.floor(distance / (b.firstEntry * botSettings.posSL / 100))
                        );

                        if (jump <= botSettings.maxDCA) {
                            addBotLog(`🔄 [HÀNH ĐỘNG] Kích hoạt DCA Cấp [${jump}/${botSettings.maxDCA}] cho ${b.symbol}.`);
                            openPosition(b.symbol, { ...b, dcaCount: jump, margin: b.firstMargin * (jump + 1) });
                        } else {
                            addBotLog(`🚨 [HÀNH ĐỘNG] Chạm trần DCA. [GIỮ NGUYÊN MỤC 6] Tiến hành QUAY XE mở vị thế LONG CUỐI x20 vốn cho ${b.symbol}.`);
                            openPosition(b.symbol, { ...b, isFinalLong: true, margin: b.firstMargin * 20 });
                        }
                    } else {
                        addBotLog(`⚠️ [CẢNH BÁO CAO ĐỘ] Giá đi đúng hướng có lãi nhưng userTrades trả về âm do phí hoặc lag dữ liệu. Chặn đứng lệnh DCA oan hại tài khoản!`);
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
    if (isOpeningPosition) return; // Chặn đứng lệnh nếu cờ lock global đang bận xử lý
    
    isProcessingDCA.add(symbol);
    isOpeningPosition = true; // Bật Khóa Global bảo vệ luồng mở lệnh Market
    
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
            console.log(`⚠️ Volume vị thế (${orderNotional.toFixed(2)}$) nhỏ hơn Min Notional quy định (${info.minNotional}$). Ép Ký Quỹ lên: ${margin.toFixed(4)}$`);
        }
        
        const ticker = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price?symbol=' + symbol);
        const price = parseFloat(ticker.data.price);
        
        let rawQty = (margin * info.maxLeverage) / price;
        
        const precision = getPrecision(info.stepSize);
        let qty = Number((Math.floor(rawQty / info.stepSize) * info.stepSize).toFixed(precision));
        
        if (qty <= 0) {
            qty = info.stepSize; 
        }

        console.log(`[THÔNG SỐ ĐẦU VÀO] Vốn: ${margin.toFixed(2)}$ | Đòn bẩy: x${info.maxLeverage} | Khối lượng Qty: ${qty}`);
        
        if (!leverageCache.has(symbol)) {
            await binanceRequest('POST', '/fapi/v1/leverage', { symbol, leverage: info.maxLeverage });
            leverageCache.add(symbol);
            console.log(`⚙️ [HỆ THỐNG] Đã đồng bộ và thiết lập đòn bẩy x${info.maxLeverage} cho ${symbol} vào bộ nhớ đệm.`);
        }
        
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
                let sl = isLong ? entry * 0.90 : firstE + (firstE * botSettings.posSL / 100);
                
                addBotLog(`📊 [MỞ VỊ THẾ THÀNH CÔNG] ${symbol} | Giá Entry TB: ${entry} (Gốc: ${firstE}) | Đích TP: ${tp.toFixed(info.pricePrecision)} | Đích SL: ${sl.toFixed(info.pricePrecision)}`);
                
                botActivePositions.set(`${symbol}_${positionSideParam}`, { 
                    symbol, side, entryPrice: entry, tp, sl, 
                    dcaCount: currentDCALevel, 
                    leverage: info.maxLeverage, firstEntry: firstE, 
                    firstMargin: dcaData ? dcaData.firstMargin : margin, 
                    currentQty: Math.abs(parseFloat(p.positionAmt)), pnl: 0, priceDev: 0 
                });
                
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
        isOpeningPosition = false; // Xả Khóa Giải Phóng Luồng
    }
}

async function syncTPSL(symbol, side, info, tp, sl) {
    const positionSideParam = status.isHedgeMode ? side : 'BOTH';
    const sideClose = (side === 'SHORT') ? 'BUY' : 'SELL';

    let realPos = null;
    try {
        const freshRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol });
        realPos = freshRisk.find(x => x.positionSide === positionSideParam && Math.abs(parseFloat(x.positionAmt)) > 0);
    } catch (e) {
        console.log(`❌ Lỗi khi quét vị thế thực tế của ${symbol}:`, e.msg || e.message);
    }

    if (!realPos) {
        console.log(`❌ [HỦY BỎ] Không tìm thấy vị thế thực tế của ${symbol} trên sàn. Bỏ qua đặt cài đặt TP/SL.`);
        return;
    }

    const currentAmt = Math.abs(parseFloat(realPos.positionAmt));
    const precision = getPrecision(info.stepSize);
    const qty = Number((Math.floor(currentAmt / info.stepSize) * info.stepSize).toFixed(precision));

    const localMapData = botActivePositions.get(`${symbol}_${positionSideParam}`);
    if (localMapData) {
        localMapData.currentQty = qty;
        botActivePositions.set(`${symbol}_${positionSideParam}`, localMapData);
    }

    // DỌN DẸP TOÀN BỘ CÁC LỆNH CHỜ TP/SL CŨ
    try {
        const orders = await binanceRequest('GET', '/fapi/v1/openOrders', { symbol });
        const targetOrders = orders.filter(o =>
            o.positionSide === positionSideParam &&
            (o.type === 'TAKE_PROFIT' || o.type === 'STOP' || o.type === 'TAKE_PROFIT_MARKET' || o.type === 'STOP_MARKET')
        );

        for (const o of targetOrders) {
            await binanceRequest('DELETE', '/fapi/v1/order', { symbol, orderId: o.orderId });
        }
        console.log(`🧹 Đã dọn sạch ${targetOrders.length} lệnh TP/SL cũ của ${symbol}`);
    } catch (e) {
        console.log(`⚠️ Lỗi dọn dẹp lệnh cũ của ${symbol}:`, e.msg || e.message);
    }

    await new Promise(r => setTimeout(r, 200));

    const targetTPPrice = Number(tp.toFixed(info.pricePrecision));
    const targetSLPrice = Number(sl.toFixed(info.pricePrecision));

    // FIX BUG WORKINGTYPE (MỤC 2): Chuyển hoàn toàn sang CONTRACT_PRICE (Last Price) để đóng chính xác theo chart giá thật
    const baseParam = {
        symbol,
        side: sideClose,
        positionSide: positionSideParam,
        closePosition: 'true',
        workingType: 'CONTRACT_PRICE' 
    };

    // ĐẶT LỆNH TAKE PROFIT MARKET
    try {
        const resTP = await binanceRequest('POST', '/fapi/v1/order', {
            ...baseParam,
            type: 'TAKE_PROFIT_MARKET',
            stopPrice: targetTPPrice
        });
        if (resTP && resTP.orderId) {
            console.log(`🎯 Đặt lệnh TP (ClosePosition-LastPrice) [OK] cho ${symbol} | Giá: ${targetTPPrice}`);
        }
    } catch (e) {
        addBotLog(`❌ [THẤT BẠI] Lỗi thiết lập TP Market cho ${symbol}: ${e.msg || e.message}`, 'error');
    }

    // ĐẶT LỆNH STOP MARKET
    try {
        const resSL = await binanceRequest('POST', '/fapi/v1/order', {
            ...baseParam,
            type: 'STOP_MARKET',
            stopPrice: targetSLPrice
        });
        if (resSL && resSL.orderId) {
            console.log(`🛑 Đặt lệnh SL (ClosePosition-LastPrice) [OK] cho ${symbol} | Giá: ${targetSLPrice}`);
        }
    } catch (e) {
        addBotLog(`❌ [THẤT BẠI] Lỗi thiết lập SL Market cho ${symbol}: ${e.msg || e.message}`, 'error');
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

// FIX BUG BLACKLIST MEMORY (MỤC 8): Quét dọn giải phóng bộ nhớ RAM cho mảng Blacklist định kỳ mỗi 60s
setInterval(() => {
    const now = Date.now();
    for (const s in status.blackList) {
        if (status.blackList[s] < now) {
            delete status.blackList[s];
            console.log(`🧹 [CLEANUP] Hết thời gian phạt khóa. Đã giải phóng token ${s} khỏi Blacklist.`);
        }
    }
}, 60000);

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

setInterval(() => {
    if (!status.isReady || !botSettings.isRunning) return;
    if (botActivePositions.size >= botSettings.maxPositions || isProcessingDCA.size > 0 || isOpeningPosition) return;

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
