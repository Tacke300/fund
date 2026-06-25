const express = require('express');
const ccxt = require('ccxt');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const MIN_NOTIONAL_FORCE = 5.1;
const ANTI_LIQUIDATION_LIMIT = 10; 
const MARGIN_PROTECT_LIMIT = 60;  
const MARGIN_RECOVER_LIMIT = 70;  

// Bộ nhớ đệm chia sẻ chung toàn hệ thống để tiết kiệm băng thông và tránh bị Binance BAN IP
let globalExchangeInfo = {};
let globalPermanentBlacklist = {};
let globalCandidatesList = [];
let globalBlackList = {};
let isExchangeInfoLoaded = false;

const activeBots = new Map();

// --- LỚP LÕI XỬ LÝ CHIẾN LƯỢC CHO TỪNG USER INSTANCE ---
class GridDcaBotInstance {
    constructor(username, apiKey, secretKey, botSettings) {
        this.username = username;
        this.botSettings = botSettings; // Chứa minVol, gridStepPercent, heSoDCA, tpPercent...
        this.status = { botLogs: [], botClosedCount: 0, botPnLClosed: 0, pnlGain: 0, pnlLoss: 0 };
        this.activePairs = new Map();
        this.isProcessingLogic = new Set();
        this.logThrottle = new Map();
        this.timestampOffset = 0;
        this.isMarginProtected = false;
        this.walletCache = { totalWalletBalance: "0.00", availableBalance: "0.00", totalUnrealizedProfit: "0.00" };
        this.lastWalletUpdate = 0;

        this.exchange = new ccxt.binance({
            apiKey: apiKey,
            secret: secretKey,
            enableRateLimit: true,
            options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true }
        });

        this.binanceApi = axios.create({
            baseURL: 'https://fapi.binance.com',
            timeout: 15000,
            headers: { 'X-MBX-APIKEY': apiKey }
        });

        // Kích hoạt các luồng lặp ngầm cho thực thể này
        this.startEngine();
    }

    addLog(msg, type = 'info', throttleKey = null) {
        if (throttleKey) {
            const now = Date.now();
            const last = this.logThrottle.get(throttleKey) || 0;
            if (now - last < 10000) return;
            this.logThrottle.set(throttleKey, now);
        }
        const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
        this.status.botLogs.unshift({ time, msg: `[GRID-DCA] ${msg}`, type });
        if (this.status.botLogs.length > 150) this.status.botLogs.pop();
        console.log(`[${this.username}][${time}][${type.toUpperCase()}] ${msg}`);
    }

    async binancePrivate(endpoint, method = 'GET', data = {}) {
        try {
            const timestamp = Date.now() + this.timestampOffset;
            const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
            const signature = crypto.createHmac('sha256', this.exchange.secret).update(query).digest('hex');
            const response = await this.binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
            return response.data;
        } catch (e) {
            if (e.response?.data?.code === -1021) {
                const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
                this.timestampOffset = t.data.serverTime - Date.now();
                return this.binancePrivate(endpoint, method, data);
            }
            throw e;
        }
    }

    async forceCloseSymbol(symbol, reasonStr) {
        try {
            const posRisk = await this.binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol }).catch(() => []);
            let totalPnL = 0;
            
            for (const p of posRisk) {
                const amt = parseFloat(p.positionAmt);
                if (Math.abs(amt) > 0) {
                    const sideClose = p.positionSide === 'SHORT' ? 'BUY' : 'SELL';
                    await this.exchange.createOrder(symbol, 'MARKET', sideClose, Math.abs(amt), undefined, { positionSide: p.positionSide }).catch(() => {});
                    const markP = parseFloat(p.markPrice);
                    const feeVolDeduction = (Math.abs(amt) * markP * 0.001);
                    totalPnL += (parseFloat(p.unRealizedProfit) - feeVolDeduction);
                }
            }
            
            this.status.botClosedCount++;
            this.status.botPnLClosed += totalPnL;
            if (totalPnL >= 0) this.status.pnlGain = (this.status.pnlGain || 0) + totalPnL;
            else this.status.pnlLoss = (this.status.pnlLoss || 0) + totalPnL;

            this.addLog(`🔒 [${reasonStr}] Đã giải phóng cặp ${symbol} | PnL: ${totalPnL.toFixed(2)}$`, totalPnL >= 0 ? "success" : "sl");
            
            const openOrders = await this.binancePrivate('/fapi/v1/openOrders', 'GET', { symbol }).catch(() => []);
            for (const o of openOrders) {
                await this.binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId }).catch(()=>{});
            }
            
            this.activePairs.delete(symbol);
            if (!this.activePairs.has(symbol)) {
                globalBlackList[symbol] = Date.now() + (15 * 60 * 1000);
            }
        } catch (e) {
            this.addLog(`❌ Lỗi đóng vị thế khẩn cấp ${symbol}: ${e.message}`, "error");
        }
    }

    async panicCloseAll(reasonLog) {
        try {
            const activeSymbols = Array.from(this.activePairs.keys());
            for(let sym of activeSymbols) {
                await this.forceCloseSymbol(sym, reasonLog);
            }
            this.addLog(`⚠️ [KÍCH HOẠT THANH LÝ TOÀN BỘ] Đã đóng sạch tài khoản: (${reasonLog}).`, "warn");
            return { success: true };
        } catch (e) { return { success: false, msg: e.message }; }
    }

    async executeMarketOrder(symbol, side, marginUSD) {
        const info = globalExchangeInfo[symbol];
        if(!info) throw new Error("Coin không nằm trong danh mục hỗ trợ");
        
        const ticker = await this.binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        
        const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || MIN_NOTIONAL_FORCE);
        let desiredQty = (marginUSD * info.maxLeverage) / currentPrice;
        let qty = Math.floor(desiredQty / info.stepSize) * info.stepSize;
        
        if (qty * currentPrice < actualMinNotional) {
            qty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
        }
        qty = Number(qty.toFixed(info.quantityPrecision)); 

        await this.exchange.setLeverage(info.maxLeverage, symbol).catch(()=>{});
        
        const orderSide = side === 'LONG' ? 'BUY' : 'SELL'; 
        const order = await this.exchange.createOrder(symbol, 'MARKET', orderSide, qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        return { order, actualMargin: (qty * currentPrice) / info.maxLeverage, executedPrice: currentPrice };
    }

    startEngine() {
        // 1. Luồng giám sát ma trận giá Grid & DCA (Chu kỳ 500ms)
        const runPriceMonitor = async () => {
            if (!this.botSettings.isRunning) return setTimeout(runPriceMonitor, 500);
            try {
                const posRisk = await this.binancePrivate('/fapi/v2/positionRisk').catch(()=>[]);
                
                for (let [symbol, pair] of this.activePairs) {
                    if (this.isProcessingLogic.has(symbol)) continue;
                    
                    const gridPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.gridSide && Math.abs(parseFloat(p.positionAmt)) > 0);
                    const dcaPos = posRisk.find(p => p.symbol === symbol && p.positionSide === pair.dcaSide && Math.abs(parseFloat(p.positionAmt)) > 0);

                    if (!gridPos && !dcaPos) {
                        this.activePairs.delete(symbol);
                        globalBlackList[symbol] = Date.now() + (15 * 60 * 1000);
                        continue;
                    }

                    const markP = parseFloat((gridPos || dcaPos).markPrice);
                    const totalMarginBoth = pair.gridMarginTotal + pair.dcaMarginTotal;
                    const combinedPnL = (gridPos ? parseFloat(gridPos.unRealizedProfit) : 0) + (dcaPos ? parseFloat(dcaPos.unRealizedProfit) : 0);
                    const targetPnLUSD = totalMarginBoth * (parseFloat(this.botSettings.tpPercent || 1) / 100) * pair.leverage;
                    
                    if (combinedPnL >= targetPnLUSD) {
                        this.isProcessingLogic.add(symbol);
                        this.addLog(`🎉 [TARGET HIT] Cặp ${symbol} PnL (${combinedPnL.toFixed(2)}$) đạt mục tiêu chốt lời tổng (${targetPnLUSD.toFixed(2)}$)!`, "success");
                        await this.forceCloseSymbol(symbol, "CHỐT LỜI HEDGE TARGET");
                        this.isProcessingLogic.delete(symbol);
                        continue;
                    }

                    const dir = pair.gridSide === 'LONG' ? 1 : -1;
                    const relativeK = Math.round((markP - pair.firstEntryPrice) / (pair.firstEntryPrice * (parseFloat(this.botSettings.gridStepPercent || 1) / 100))) * dir;
                    
                    const cand = globalCandidatesList.find(c => c.symbol === symbol) || { c1: "0", c5: "0", c15: "0" };
                    const tfStr = `1M:${cand.c1}% 5M:${cand.c5}% 15M:${cand.c15}%`;

                    if (relativeK > pair.maxRelativeK) {
                        this.isProcessingLogic.add(symbol);
                        for (let k = pair.maxRelativeK + 1; k <= relativeK; k++) {
                            if (!pair.executedMacDinh.includes(k)) {
                                try {
                                    pair.dcaMacDinhCount++;
                                    const marginToOpen = pair.initialMargin;
                                    await this.executeMarketOrder(symbol, pair.dcaSide, marginToOpen);
                                    pair.dcaMarginTotal += marginToOpen;
                                    pair.executedMacDinh.push(k);
                                    this.addLog(`⚙️ [DCA MẶC ĐỊNH LẦN ${pair.dcaMacDinhCount}] ${symbol} | Mốc lưới: ${k} | Giá: ${markP} | Margin nạp: ${marginToOpen.toFixed(2)}$ | Biến động: ${tfStr}`, "dca");
                                } catch(e) {}
                            }
                        }
                        pair.maxRelativeK = relativeK;
                        this.isProcessingLogic.delete(symbol);
                    }

                    if (relativeK < pair.maxRelativeK) {
                        this.isProcessingLogic.add(symbol);
                        for (let k = pair.maxRelativeK - 1; k >= relativeK; k--) {
                            if (!pair.executedNote.includes(k)) {
                                try {
                                    pair.dcaNoteCount++;
                                    if (pair.executedMacDinh.includes(k)) {
                                        const marginNote = pair.initialMargin * parseFloat(this.botSettings.heSoDCA || 1);
                                        await this.executeMarketOrder(symbol, pair.gridSide, marginNote);
                                        pair.gridMarginTotal += marginNote;
                                        this.addLog(`💥 [DCA NOTE LẦN ${pair.dcaNoteCount}] ${symbol} | Đỉnh sập sập qua mốc cũ: ${k} | Chỉ nhồi thêm bên Note: ${marginNote.toFixed(2)}$ | Biến động: ${tfStr}`, "warn");
                                    } else {
                                        const marginMacDinh = pair.initialMargin;
                                        const marginNote = pair.initialMargin * parseFloat(this.botSettings.heSoDCA || 1);
                                        await this.executeMarketOrder(symbol, pair.dcaSide, marginMacDinh);
                                        await this.executeMarketOrder(symbol, pair.gridSide, marginNote);
                                        pair.dcaMarginTotal += marginMacDinh;
                                        pair.gridMarginTotal += marginNote;
                                        pair.executedMacDinh.push(k);
                                        this.addLog(`🚨 [DCA TỔNG LẦN ${pair.dcaNoteCount}] ${symbol} | Đỉnh rơi vùng chưa quét lưới mốc: ${k} | Nạp DCA Thường: ${marginMacDinh.toFixed(2)}$ + DCA Note: ${marginNote.toFixed(2)}$`, "warn");
                                    }
                                    pair.executedNote.push(k);
                                } catch(e) {}
                            }
                        }
                        this.isProcessingLogic.delete(symbol);
                    }
                }
            } catch (e) { }
            setTimeout(runPriceMonitor, 500);
        };
        setTimeout(runPriceMonitor, 500);

        // 2. Luồng bảo vệ Margin khắt khe (Chu kỳ 3 giây)
        const runMarginChecker = async () => {
            if (!this.botSettings.isRunning) return setTimeout(runMarginChecker, 3000);
            try {
                const acc = await this.binancePrivate('/fapi/v2/account').catch(() => null);
                if (acc && parseFloat(acc.totalMarginBalance) > 0) {
                    const availPercent = (parseFloat(acc.availableBalance) / parseFloat(acc.totalMarginBalance)) * 100;
                    if (availPercent <= ANTI_LIQUIDATION_LIMIT) { 
                        await this.panicCloseAll(`BẢO VỆ THANH LÝ NGUY HIỂM ${ANTI_LIQUIDATION_LIMIT}%`); 
                        this.isMarginProtected = false; 
                        return setTimeout(runMarginChecker, 3000); 
                    }
                    if (!this.isMarginProtected && availPercent < MARGIN_PROTECT_LIMIT) {
                        this.isMarginProtected = true; 
                        this.addLog(`⚠️ KHÔNG ĐẠT TIÊU CHUẨN AN TOÀN: Khả dụng giảm dưới ${MARGIN_PROTECT_LIMIT}%. Đóng băng luồng mở lệnh mới!`, "warn");
                    } else if (this.isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) {
                        this.isMarginProtected = false; 
                        this.addLog(`✅ KHẢ DỤNG KHÔI PHỤC: Mức quỹ an toàn đạt ${MARGIN_RECOVER_LIMIT}%. Giải phóng lệnh quét mới.`, "info");
                    }
                }
            } catch (e) {}
            setTimeout(runMarginChecker, 3000);
        };
        setTimeout(runMarginChecker, 3000);

        // 3. Luồng quét tín hiệu vào lệnh Hedge mới (Chu kỳ 3 giây)
        const runScanner = async () => {
            if (!this.botSettings.isRunning || this.isMarginProtected) return setTimeout(runScanner, 3000);
            try {
                if (this.activePairs.size >= parseInt(this.botSettings.maxPositions || 3)) return setTimeout(runScanner, 3000);

                let entrySignal = null;
                for (const c of globalCandidatesList) {
                    if (globalBlackList[c.symbol] || globalPermanentBlacklist[c.symbol]) continue; 
                    if (this.activePairs.has(c.symbol)) continue;

                    const m1 = parseFloat(c.c1 || 0);
                    let isNormal = false; 
                    let normalSide = 'SHORT';
                    if (Math.abs(m1) >= parseFloat(this.botSettings.minVol || 7)) { 
                        isNormal = true; 
                        normalSide = m1 > 0 ? 'LONG' : 'SHORT'; 
                    }
                    
                    if (isNormal) {
                        entrySignal = { symbol: c.symbol, gridSide: normalSide, dcaSide: normalSide === 'LONG' ? 'SHORT' : 'LONG' };
                        break;
                    }
                }

                if (entrySignal) {
                    const symbol = entrySignal.symbol;
                    if (this.isProcessingLogic.has(symbol)) return setTimeout(runScanner, 3000);

                    const info = globalExchangeInfo[symbol];
                    if (!info) return setTimeout(runScanner, 3000);

                    const acc = await this.binancePrivate('/fapi/v2/account').catch(() => null);
                    if (!acc) return setTimeout(runScanner, 3000); 
                    const snapshotAvailable = parseFloat(acc.availableBalance || 0);

                    const marginSetting = this.botSettings.invValue;
                    let calculatedMargin = marginSetting.toString().includes('%') ? (snapshotAvailable * parseFloat(marginSetting) / 100) : parseFloat(marginSetting);

                    this.isProcessingLogic.add(symbol);
                    try {
                        const resGrid = await this.executeMarketOrder(symbol, entrySignal.gridSide, calculatedMargin);
                        const resDCA = await this.executeMarketOrder(symbol, entrySignal.dcaSide, calculatedMargin);

                        this.activePairs.set(symbol, {
                            symbol: symbol,
                            gridSide: entrySignal.gridSide,
                            dcaSide: entrySignal.dcaSide,
                            firstEntryPrice: resGrid.executedPrice,
                            initialMargin: resGrid.actualMargin,
                            leverage: info.maxLeverage,
                            maxRelativeK: 0,
                            executedMacDinh: [0],
                            executedNote: [],
                            dcaMacDinhCount: 0,
                            dcaNoteCount: 0,
                            gridMarginTotal: resGrid.actualMargin,
                            dcaMarginTotal: resDCA.actualMargin,
                            createdAt: Date.now()
                        });

                        this.addLog(`🔥 [KHỞI TẠO CẶP HEDGE] ${symbol} | Giá Entry: ${resGrid.executedPrice} | Ký quỹ ban đầu: ${resGrid.actualMargin.toFixed(2)}$ mỗi chiều | Đòn bẩy tối đa: x${info.maxLeverage}`, "open");
                    } catch (e) {
                        this.addLog(`❌ [THẤT BẠI MỞ HEDGE] ${symbol}: ${e.message}`, "error");
                        globalBlackList[symbol] = Date.now() + (15 * 60 * 1000);
                    }
                    this.isProcessingLogic.delete(symbol);
                }
            } catch (e) {}
            setTimeout(runScanner, 3000);
        };
        setTimeout(runScanner, 3000);
    }

    async updateWalletData() {
        const now = Date.now();
        if (now - this.lastWalletUpdate > 3000) {
            const acc = await this.binancePrivate('/fapi/v2/account').catch(() => null);
            if (acc) {
                this.walletCache = {
                    totalWalletBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2),
                    availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2),
                    totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2)
                };
                this.lastWalletUpdate = now;
            }
        }
    }
}

// --- LUỒNG QUÉT BLACKLIST TOÀN CỤC CHẠY NGẦM ---
setInterval(() => {
    const now = Date.now();
    for (const symbol in globalBlackList) {
        if (now > globalBlackList[symbol]) delete globalBlackList[symbol];
    }
}, 1000);

// --- LUỒNG ĐỒNG BỘ DỮ LIỆU TỪ LÕI PHÂN TÍCH (PORT 9000) TẬP TRUNG ---
setInterval(() => {
    axios.get('http://127.0.0.1:9000/api/data').then(res => {
        globalCandidatesList = res.data?.live || [];
    }).catch(() => {});
}, 1500);

// --- HÀM KHỞI TẠO HỆ THỐNG GIAO DỊCH CHUNG ---
async function initGlobalExchangeSpecs() {
    try {
        const publicExchange = new ccxt.binance({ options: { defaultType: 'future' } });
        await publicExchange.loadMarkets();
        
        // Dùng tạm một API public không ký tên để lấy exchangeInfo và leverage bracket
        const info = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
        const temp = {};
        info.data.symbols.forEach(s => {
            if (s.status !== 'TRADING') return;
            temp[s.symbol] = {
                quantityPrecision: s.quantityPrecision,
                pricePrecision: s.pricePrecision,
                stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize),
                minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 5.0),
                maxLeverage: 20 // Cấu hình mặc định, sẽ tự ép theo khung đòn bẩy tài khoản khi đặt lệnh
            };
        });
        globalExchangeInfo = temp;
        isExchangeInfoLoaded = true;
        console.log("✅ [BOT GRID & DCA] Khởi tạo cơ sở dữ liệu thị trường Binance thành công!");
    } catch (e) {
        console.log(`❌ Lỗi đồng bộ thông số sàn công cộng: ${e.message}. Thử lại sau 5 giây...`);
        setTimeout(initGlobalExchangeSpecs, 5000);
    }
}
initGlobalExchangeSpecs();

// --- HTTP ENDPOINTS TIẾP NHẬN TỪ MASTER SERVER ---
app.post('/api/user/toggle', async (req, res) => {
    const { username, apiKey, secretKey, botSettings } = req.body;
    if (!isExchangeInfoLoaded) return res.json({ success: false, msg: "Hệ thống đang nạp tham số sàn, vui lòng đợi." });

    let bot = activeBots.get(username);
    if (!bot) {
        bot = new GridDcaBotInstance(username, apiKey, secretKey, botSettings);
        activeBots.set(username, bot);
    }
    bot.botSettings = botSettings;
    if (bot.botSettings.isRunning) {
        bot.addLog("🚀 Khởi động hệ thống chiến lược Ma trận HEDGE GRID & DCA...");
    }
    return res.json({ success: true });
});

app.post('/api/user/status', async (req, res) => {
    const { username } = req.body;
    let bot = activeBots.get(username);
    if (bot) {
        await bot.updateWalletData();
        return res.json({
            botSettings: bot.botSettings,
            activePositions: Array.from(bot.activePairs.values()),
            status: bot.status,
            wallet: bot.walletCache
        });
    }
    return res.json({
        botSettings: { isRunning: false },
        activePositions: [],
        status: { botLogs: [], botClosedCount: 0, botPnLClosed: 0 },
        wallet: { totalWalletBalance: "0.00", availableBalance: "0.00" }
    });
});

app.listen(1835, '127.0.0.1', () => console.log(`🚀 [BOT 3: GRID & DCA] Đang túc trực chiến đấu ổn định tại Port: 1835`));
