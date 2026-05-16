import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs'; 
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
let isOpeningPosition = false; 

function getPrecision(stepSize) {
    const step = stepSize.toString();
    if (!step.includes('.')) return 0;
    return step.split('.')[1].replace(/0+$/, '').length;
}

function writeRawDebugLog(type, endpoint, payload, responseOrError, latency) {
    const logTime = new Date().toISOString();
    const dataToLog = {
        time: logTime,
        type: type, 
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
        writeRawDebugLog('SUCCESS', endpoint, data, response.data, latency);
        return response.data;
    } catch (e) {
        const latency = Date.now() - startTime;
        const errorPayload = e.response?.data || { message: e.message, code: 'NETWORK_OR_TIMEOUT' };
        
        writeRawDebugLog('ERROR', endpoint, data, errorPayload, latency);

        if (errorPayload.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            serverTimeOffset = t.data.serverTime - Date.now();
            return binanceRequest(method, endpoint, data);
        }
        throw errorPayload;
    }
}

// HÀM ĐÓNG VỊ THẾ KHẨN CẤP / FAILSAFE CANH BẰNG PHẦN MỀM (PP3 & PP4)
async function closePositionMarket(pos, reason = "FAILSAFE") {
    const sideClose = pos.side === 'SHORT' ? 'BUY' : 'SELL';
    const positionSideParam = status.isHedgeMode ? pos.side : 'BOTH';
    
    try {
        addBotLog(`🚨 [HÀNH ĐỘNG KHẨN CẤP] Tiến hành gọi lệnh MARKET giải phóng vị thế ${pos.symbol} Lý do: ${reason}`);
        
        const res = await binanceRequest('POST', '/fapi/v1/order', {
            symbol: pos.symbol,
            side: sideClose,
            positionSide: positionSideParam,
            type: 'MARKET',
            quantity: pos.currentQty,
            reduceOnly: 'true'
        });
        
        if (res) {
            console.log(`✅ [THÀNH CÔNG] Lệnh MARKET cứu nguy đã được sàn khớp hoàn toàn cho ${pos.symbol}`);
            return true;
        }
    } catch (e) {
        console.error(`❌ [THẤT BẠI CHÍ MẠNG] Không thể đóng MARKET khẩn cấp cho ${pos.symbol}:`, e);
        addBotLog(`🚨 [BÁO ĐỘNG ĐỎ] CHÁY TÀI KHOẢN TIỀM ẨN! Lệnh MARKET khẩn cấp cho ${pos.symbol} bị từ chối!`, 'error');
    }
    return false;
}

async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        const posRisk = await binanceRequest('GET', '/fapi/v2/positionRisk').catch(() => null);
        if (!posRisk) return setTimeout(priceMonitor, 1000);

        for (let [key, b] of botActivePositions) {
            let realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (!realP) {
                await new Promise(r => setTimeout(r, 1500));
                const recheckPosRisk = await binanceRequest('GET', '/fapi/v2/positionRisk').catch(() => null);
                
                if (recheckPosRisk) {
                    realP = recheckPosRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
                    if (realP) {
                        console.log(`🛡️ [BẢO VỆ CAP] Sàn lag hụt vị thế ảo của ${b.symbol}. Đã chặn đứng chuỗi DCA sai lệch.`);
                    }
                }
            }

            if (realP) {
                const markP = parseFloat(realP.markPrice);
                b.pnl = parseFloat(realP.unRealizedProfit);
                
                b.priceDev = b.side === 'SHORT'
                    ? ((b.entryPrice - markP) / b.entryPrice) * 100
                    : ((markP - b.entryPrice) / b.entryPrice) * 100;

                // TẦNG 3 (PP3 - SOFTWARE PROTECTION): Tự động so khớp giá xử lý thủ công bằng code nếu các tầng trên fail
                if (b.tpSlMode === 3) {
                    let triggerFailsafe = false;
                    
                    if (b.side === 'SHORT') {
                        if (markP <= b.tp) {
                            addBotLog(`🎯 [PP3 SOFTWARE] Vị thế SHORT ${b.symbol} chạm vùng giá TP cứng (${b.tp}). Kích hoạt đóng tay...`);
                            triggerFailsafe = true;
                        } else if (markP >= b.sl) {
                            addBotLog(`🛑 [PP3 SOFTWARE] Vị thế SHORT ${b.symbol} chạm vùng giá SL cứng (${b.sl}). Kích hoạt đóng tay...`);
                            triggerFailsafe = true;
                        }
                    } else if (b.side === 'LONG') {
                        if (markP >= b.tp) {
                            addBotLog(`🎯 [PP3 SOFTWARE] Vị thế LONG ${b.symbol} chạm vùng giá TP cứng (${b.tp}). Kích hoạt đóng tay...`);
                            triggerFailsafe = true;
                        } else if (markP <= b.sl) {
                            addBotLog(`🛑 [PP3 SOFTWARE] Vị thế LONG ${b.symbol} chạm vùng giá SL cứng (${b.sl}). Kích hoạt đóng tay...`);
                            triggerFailsafe = true;
                        }
                    }

                    if (triggerFailsafe) {
                        const closed = await closePositionMarket(b, "PP3_SOFTWARE_TRIGGER");
                        if (closed) {
                            botActivePositions.delete(key);
                        }
                        continue; 
                    }
                }

            } else {
                if (isProcessingDCA.has(b.symbol)) continue;
                
                addBotLog(`⚠️ Vị thế ${b.symbol} (${b.side}) xác thực không còn trên sàn. Tiến hành check userTrades...`);
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
                    
                    const distance = b.side === 'SHORT'
                        ? currentPrice - b.firstEntry
                        : b.firstEntry - currentPrice;
                    
                    botActivePositions.delete(key);

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
                        addBotLog(`⚠️ [CẢNH BÁO CAO ĐỘ] Giá đi đúng hướng có lãi nhưng hủy vị thế do lag dữ liệu. Chặn đứng lệnh DCA oan!`);
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
    if (isOpeningPosition) return; 
    
    isProcessingDCA.add(symbol);
    isOpeningPosition = true; 
    
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
                
                // Khởi tạo Object cấu hình cục bộ lưu giữ trong bộ nhớ RAM, mặc định gán chế độ tpSlMode = 0 trước khi đồng bộ hóa
                const currentLocalPosition = { 
                    symbol, side, entryPrice: entry, tp, sl, 
                    dcaCount: currentDCALevel, 
                    leverage: info.maxLeverage, firstEntry: firstE, 
                    firstMargin: dcaData ? dcaData.firstMargin : margin, 
                    currentQty: Math.abs(parseFloat(p.positionAmt)), pnl: 0, priceDev: 0,
                    tpSlMode: 0 // Ghi nhận Mode TP/SL hiện hành để theo dõi qua API / Dashboard
                };
                
                botActivePositions.set(`${symbol}_${positionSideParam}`, currentLocalPosition);
                
                // Kích hoạt luồng Fallback Đa Tầng Cấu Hình Lệnh Điều Kiện Đóng Vị Thế
                await cascadeSyncTPSL(symbol, side, info, tp, sl);
            } else {
                addBotLog(`❌ [THẤT BẠI] Lệnh MARKET đã khớp nhưng vòng lặp đồng bộ không tìm thấy vị thế ${symbol} trên sàn.`, 'error');
            }
        }
    } catch (e) { 
        addBotLog(`❌ [LỖI QUY TRÌNH] Quy trình mở vị thế thất bại: ${e.msg || e.message || JSON.stringify(e)}`, 'error'); 
    } finally { 
        console.log(`====================================================================\n`);
        isProcessingDCA.delete(symbol); 
        isOpeningPosition = false; 
    }
}

// ENGINE XỬ LÝ HẠ CẤP RỦI RO ĐA TẦNG (PP1 -> PP2 -> PP3 -> PP4 EMERGENCY)
async function cascadeSyncTPSL(symbol, side, info, tp, sl) {
    const positionSideParam = status.isHedgeMode ? side : 'BOTH';
    const sideClose = (side === 'SHORT') ? 'BUY' : 'SELL';
    
    const localPosKey = `${symbol}_${positionSideParam}`;
    let localData = botActivePositions.get(localPosKey);
    if (!localData) return;

    let realPos = null;
    try {
        const freshRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol });
        realPos = freshRisk.find(x => x.positionSide === positionSideParam && Math.abs(parseFloat(x.positionAmt)) > 0);
    } catch (e) { console.log(`❌ Lỗi quét xác minh thực tế ${symbol}:`, e.msg || e.message); }

    if (!realPos) {
        console.log(`❌ [HỦY BỎ] Không thấy vị thế thực tế trên sàn. Chặn cấu hình TP/SL.`);
        return;
    }

    const currentAmt = Math.abs(parseFloat(realPos.positionAmt));
    const precision = getPrecision(info.stepSize);
    const qty = Number((Math.floor(currentAmt / info.stepSize) * info.stepSize).toFixed(precision));

    localData.currentQty = qty;
    botActivePositions.set(localPosKey, localData);

    // DỌN DẸP LỆNH CHỜ CŨ CHỐNG XUNG ĐỘT ENGINE TRÙNG LẶP
    try {
        const orders = await binanceRequest('GET', '/fapi/v1/openOrders', { symbol });
        const targetOrders = orders.filter(o =>
            o.positionSide === positionSideParam &&
            (o.type === 'TAKE_PROFIT' || o.type === 'STOP' || o.type === 'TAKE_PROFIT_MARKET' || o.type === 'STOP_MARKET')
        );
        for (const o of targetOrders) {
            await binanceRequest('DELETE', '/fapi/v1/order', { symbol, orderId: o.orderId });
        }
        console.log(`🧹 Đã giải phóng sạch ${targetOrders.length} lệnh điều kiện treo cũ của ${symbol}`);
    } catch (e) { console.log(`⚠️ Lỗi dọn dẹp lệnh cũ ${symbol}:`, e.msg || e.message); }

    await new Promise(r => setTimeout(r, 200));

    const targetTPPrice = Number(tp.toFixed(info.pricePrecision));
    const targetSLPrice = Number(sl.toFixed(info.pricePrecision));

    // ====================================================================
    // [PP1] TẦNG 1 — ƯU TIÊN HÀNG ĐẦU: NATIVE CLOSEPOSITION MARKET (Không quantity)
    // ====================================================================
    console.log(`[FLOW TP/SL] Trực xuất TẦNG 1 (PP1 - ClosePosition Market)...`);
    const marketParams = {
        symbol,
        side: sideClose,
        positionSide: positionSideParam,
        closePosition: 'true',
        workingType: 'CONTRACT_PRICE'
    };

    let pp1Success = false;
    try {
        const resTP = await binanceRequest('POST', '/fapi/v1/order', { ...marketParams, type: 'TAKE_PROFIT_MARKET', stopPrice: targetTPPrice });
        const resSL = await binanceRequest('POST', '/fapi/v1/order', { ...marketParams, type: 'STOP_MARKET', stopPrice: targetSLPrice });
        
        if (resTP && resSL) {
            pp1Success = true;
            localData.tpSlMode = 1;
            botActivePositions.set(localPosKey, localData);
            console.log(`✅ [PP1 THÀNH CÔNG] Đồng bộ TP/SL dạng Native ClosePosition OK cho ${symbol}.`);
            return;
        }
    } catch (err) {
        console.warn(`⚠️ [PP1 THẤT BẠI] Sàn từ chối cấu trúc lệnh Tầng 1 cho ${symbol}. Mã lỗi: ${err.code || JSON.stringify(err)}`);
    }

    // ====================================================================
    // [PP2] TẦNG 2 — HẠ CẤP 1: REDUCE ONLY LIMIT TRIGGER ORDER (Cần kẹp quantity)
    // ====================================================================
    if (!pp1Success) {
        console.log(`[FLOW TP/SL] Trực xuất TẦNG 2 (PP2 - ReduceOnly Limit Trigger)...`);
        const limitTriggerParams = {
            symbol,
            side: sideClose,
            positionSide: positionSideParam,
            quantity: qty,
            reduceOnly: 'true',
            workingType: 'CONTRACT_PRICE',
            timeInForce: 'GTC'
        };

        let pp2Success = false;
        try {
            const resTP = await binanceRequest('POST', '/fapi/v1/order', { ...limitTriggerParams, type: 'TAKE_PROFIT', stopPrice: targetTPPrice, price: targetTPPrice });
            const resSL = await binanceRequest('POST', '/fapi/v1/order', { ...limitTriggerParams, type: 'STOP', stopPrice: targetSLPrice, price: targetSLPrice });
            
            if (resTP && resSL) {
                pp2Success = true;
                localData.tpSlMode = 2;
                botActivePositions.set(localPosKey, localData);
                console.log(`✅ [PP2 THÀNH CÔNG] Kích hoạt cấu trúc TP/SL Tầng 2 ReduceOnly GTC thành công cho ${symbol}.`);
                return;
            }
        } catch (err) {
            console.warn(`⚠️ [PP2 THẤT BẠI] Sàn tiếp tục từ chối cấu trúc lệnh Tầng 2 cho ${symbol}. Mã lỗi: ${err.code || JSON.stringify(err)}`);
        }

        // ====================================================================
        // [PP3] TẦNG 3 — HẠ CẤP 2: SOFTWARE EMERGENCY MONITOR (Canh bằng phần mềm)
        // ====================================================================
        if (!pp2Success) {
            addBotLog(`🚨 [CẢNH BÁO PP3] Sàn chặn toàn bộ API điều kiện của ${symbol}. Ép bot chuyển sang chế độ bảo vệ phần mềm Tầng 3!`, 'warning');
            localData.tpSlMode = 3; // Kích hoạt cờ 3 để priceMonitor() chủ động so giá và gọi lệnh Market
            botActivePositions.set(localPosKey, localData);
            
            // Xác thực xem cờ đã ghi nhận vào RAM thành công chưa để phòng vệ rủi ro trống bộ nhớ
            const verifyData = botActivePositions.get(localPosKey);
            if (verifyData && verifyData.tpSlMode === 3) {
                console.log(`🛡️ [PP3 THÀNH CÔNG] Đã cấu hình khóa bảo vệ mềm thành công trong RAM cho Token ${symbol}.`);
                return;
            }

            // ====================================================================
            // [PP4] TẦNG 4 — ĐOÀN CUỐI BI THƯƠNG: EMERGENCY FORCE CLOSE MARKET IMMEDIATELY
            // ====================================================================
            // Nếu không ghi nổi dữ liệu vào RAM hoặc lỗi luồng bất định, bắt buộc phải cắt lệnh Market ngay lập tức, không cho phép vị thế Naked tự sinh tự diệt.
            addBotLog(`🚨 [CHÍ MẠNG] Sập toàn bộ 3 tầng bảo vệ. Kích hoạt TẦNG KHẨN CẤP 4 ĐÓNG NGAY VỊ THẾ CỦA ${symbol}!`, 'error');
            const forceClosed = await closePositionMarket(localData, "PP4_EMERGENCY_FORCE_CLOSE");
            if (forceClosed) {
                botActivePositions.delete(localPosKey);
            }
        }
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
