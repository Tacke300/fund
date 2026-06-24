import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import ccxt from 'ccxt';

const MIN_NOTIONAL_FORCE = 5.1;
const MAX_DCA_LEVEL = 999999;
const ASYMMETRIC_TP_PERCENT = 0.5;

const SCAN_CONFIG = {
    THUONG: ['M1', 'M5'],
    DIA_NGUC: ['M1', 'M5', 'M15']
};

const ANTI_LIQUIDATION_LIMIT = 10;
const MARGIN_PROTECT_LIMIT = 70;
const MARGIN_RECOVER_LIMIT = 80;

// Tập hợp quản lý phiên làm việc của các User đang hoạt động
const activeUserBots = new Map();

let sharedState = {
    blackList: {},
    permanentBlacklist: {},
    candidatesList: [],
    exchangeInfo: null,
    dcaAmOpponentClosedProfit: {},
    masterLogs: [],
    errorSpamGuard: {},
    pendingOrders: new Set()
};

function formatUptime(startTime) {
    const uptimeMs = Date.now() - startTime;
    const hours = Math.floor(uptimeMs / (3600 * 1000));
    const minutes = Math.floor((uptimeMs % (3600 * 1000)) / (60 * 1000));
    return `${hours}h ${minutes}m`;
}

// --- THỰC THỂ KHỞI TẠO ĐỐI TƯỢNG BOT CHO TỪNG USER CHẠY ĐỘC LẬP ---
class MiniScalpingBotInstance {
    constructor(username, apiKey, secretKey, botSettings) {
        this.username = username;
        this.id = `BOT_1_${username}`;
        this.startTime = Date.now();
        this.botSettings = botSettings;
        this.secretKey = secretKey; // Giữ lại để mã hóa chữ ký private

        this.status = { botLogs: [], botClosedCount: 0, botPnLClosed: 0, pnlGain: 0, pnlLoss: 0, isReady: false };
        this.botActivePositions = new Map();
        this.isProcessingDCA = new Set();
        this.logThrottle = new Map();
        this.timestampOffset = 0;
        this.isMarginProtected = false;
        this.walletCache = { totalWalletBalance: "0.00", availableBalance: "0.00", totalUnrealizedProfit: "0.00" };

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
    }

    async init() {
        try {
            await this.exchange.loadMarkets();
            this.status.isReady = true;
            addBotLog(this, `✅ Khởi tạo thành công kết nối sàn Binance cho luồng của [${this.username}]`);
        } catch (e) {
            addBotLog(this, `❌ Lỗi xác thực tài khoản hoặc kết nối sàn: ${e.message}`, "error");
        }
    }
}

function addBotLog(bot, msg, type = 'info', isDianguc = false) {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    let uiMsg = msg;
    if (isDianguc && !msg.includes('<span')) {
        uiMsg = `<span style="color: #ef4444; font-weight: 600;">[ĐỊA NGỤC] ${msg}</span>`;
    }
    const logItem = { time, msg: uiMsg, type, isDianguc, botId: bot.id };
    bot.status.botLogs.unshift(logItem);
    if (bot.status.botLogs.length > 100) bot.status.botLogs.pop();
    console.log(`[${time}][${bot.username}] ${msg}`);
}

async function binancePrivate(bot, endpoint, method = 'GET', data = {}) {
    try {
        const timestamp = Date.now() + bot.timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
        const signature = crypto.createHmac('sha256', bot.secretKey).update(query).digest('hex');
        const response = await bot.binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (e) {
        if (e.response?.data?.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            bot.timestampOffset = t.data.serverTime - Date.now();
            return binancePrivate(bot, endpoint, method, data);
        }
        throw e;
    }
}

async function syncTPSL(bot, symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    try {
        const orders = await binancePrivate(bot, '/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of orders.filter(o => o.positionSide === side)) {
            await binancePrivate(bot, '/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId }).catch(()=>{});
        }
        if (tpPrice) await bot.exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: tpPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'CONTRACT_PRICE' });
        if (slPrice) await bot.exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: slPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'CONTRACT_PRICE' });
    } catch (e) {}
}

async function closePositionAndLog(bot, b, markP, reasonStr) {
    try {
        const info = sharedState.exchangeInfo[b.symbol];
        const pPrec = info ? info.pricePrecision : 6;

        const posRisk = await binancePrivate(bot, '/fapi/v2/positionRisk', 'GET', { symbol: b.symbol }).catch(() => []);
        const realP = posRisk.find(p => p.positionSide === b.side && Math.abs(parseFloat(p.positionAmt)) > 0);
        
        if (realP) {
            const actualQty = Math.abs(parseFloat(realP.positionAmt));
            await bot.exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', actualQty, undefined, { positionSide: b.side });
        }
        
        let finalPnL = b.side === 'LONG' ? (markP - b.avgEntry) * b.currentQty : (b.avgEntry - markP) * b.currentQty;
        bot.status.botClosedCount++;
        bot.status.botPnLClosed += finalPnL;

        addBotLog(bot, `🔒 [${reasonStr}] ${b.symbol} ${b.side} | Giá chốt: ${markP.toFixed(pPrec)} | PnL: ${finalPnL.toFixed(2)}$`, "success", b.isDiangucMode);
    } catch (e) {
        addBotLog(bot, `❌ Lỗi đóng vị thế ${b.symbol}: ${e.message}`, "error");
    }
}

async function openPosition(bot, symbol, dcaData = null, forcedSide = null, sharedQty = null, sharedMargin = null, sharedPrice = null, isHellSignal = false, signalVols = null) {
    const side = forcedSide || (dcaData ? dcaData.side : 'SHORT');
    const isDCA = dcaData !== null;
    const lockKey = `${symbol}_${side}`;
    
    if (bot.isProcessingDCA.has(lockKey)) return;
    bot.isProcessingDCA.add(lockKey);

    try {
        const info = sharedState.exchangeInfo[symbol];
        if (!info) return;

        let qty = 0, margin = 0, currentPrice = 0;
        if (isDCA) {
            const ticker = await axios.get(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
            currentPrice = parseFloat(ticker.data.price);
            margin = dcaData.margin;
            qty = Number(((margin * info.maxLeverage) / currentPrice).toFixed(info.quantityPrecision));
        } else {
            qty = sharedQty; margin = sharedMargin; currentPrice = sharedPrice;
        }

        if (qty <= 0) return;

        await bot.exchange.setLeverage(info.maxLeverage, symbol);
        const order = await bot.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', qty, undefined, { positionSide: side });
        
        if (order) {
            const filledPrice = currentPrice;
            const isModeHell = isDCA ? dcaData.isDiangucMode : isHellSignal;
            const dcaType = isModeHell ? bot.botSettings.dcaTypeDianguc : bot.botSettings.dcaTypeThuong;

            let cumulativeQty = qty;
            let cumulativeCost = qty * filledPrice;
            let newAvgEntry = filledPrice;
            let totalMargin = margin;

            if (isDCA) {
                cumulativeQty = dcaData.cumulativeQty + qty;
                cumulativeCost = dcaData.cumulativeCost + (qty * filledPrice);
                newAvgEntry = cumulativeCost / cumulativeQty;
                totalMargin = dcaData.currentMargin + margin;
            }

            const firstE = dcaData ? dcaData.firstEntry : newAvgEntry;
            const dcaCount = dcaData ? dcaData.dcaCount : 0;
            const dcaThreshold = isModeHell ? bot.botSettings.diangucdca : bot.botSettings.posdca;
            const tpPercent = isModeHell ? bot.botSettings.dianguctp : bot.botSettings.posTP;
            const slPercent = isModeHell ? bot.botSettings.diangucsl : bot.botSettings.posSL;

            const dir = (side === 'LONG' ? 1 : -1);
            let nextDCA = dcaType === 'DUONG' ? firstE * (1 + dir * ((dcaCount + 1) * dcaThreshold / 100)) : firstE * (1 - dir * ((dcaCount + 1) * dcaThreshold / 100));
            
            let finalTP = dcaType === 'DUONG' ? newAvgEntry * (1 + dir * (tpPercent / 100)) : newAvgEntry + dir * (firstE * (tpPercent / 100));
            let finalSL = firstE * (1 - dir * (slPercent / 100));

            bot.botActivePositions.set(lockKey, {
                symbol, side, entryPrice: firstE, tp: finalTP, sl: finalSL, dcaCount,
                currentMargin: totalMargin, currentQty: cumulativeQty, cumulativeQty, cumulativeCost,
                isDiangucMode: isModeHell, avgEntry: newAvgEntry, nextDCA, livePrice: filledPrice, pnl: 0,
                createdAt: dcaData ? dcaData.createdAt : Date.now()
            });

            addBotLog(bot, `🚀 [${isDCA ? 'DCA CẤP '+dcaCount : 'MỞ VỊ THẾ'}] ${symbol} ${side} | Vốn: ${totalMargin.toFixed(2)}$ | Giá vào: ${newAvgEntry.toFixed(info.pricePrecision)}`, "open", isModeHell);
            
            setTimeout(async () => { await syncTPSL(bot, symbol, side, info, finalTP, finalSL); }, 5000);
        }
    } catch (e) {
        addBotLog(bot, `❌ Thất bại khi mở lệnh ${symbol}: ${e.message}`, "error");
    } finally {
        bot.isProcessingDCA.delete(lockKey);
    }
}

// --- VÒNG LẶP MONITOR GIÁ CHẠY CHO TẤT CẢ CÁC TÀI KHOẢN ACTIVE ---
setInterval(async () => {
    for (const [username, bot] of activeUserBots.entries()) {
        if (!bot.status.isReady || !bot.botSettings.isRunning) continue;

        try {
            const posRisk = await binancePrivate(bot, '/fapi/v2/positionRisk');
            
            // Cập nhật ví định kỳ
            const acc = await binancePrivate(bot, '/fapi/v2/account').catch(() => null);
            if (acc) {
                bot.walletCache = {
                    totalWalletBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2),
                    availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2),
                    totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2)
                };
            }

            for (let [key, b] of bot.botActivePositions) {
                const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
                if (realP) {
                    const markP = parseFloat(realP.markPrice);
                    b.livePrice = markP;
                    b.pnl = parseFloat(realP.unRealizedProfit);

                    const dcaType = b.isDiangucMode ? bot.botSettings.dcaTypeDianguc : bot.botSettings.dcaTypeThuong;
                    const hitInternalTP = b.side === 'LONG' ? (markP >= b.tp) : (markP <= b.tp);
                    const hitInternalSL = b.side === 'LONG' ? (markP <= b.sl) : (markP >= b.sl);

                    if (hitInternalTP) {
                        bot.botActivePositions.delete(key);
                        await closePositionAndLog(bot, b, markP, "CHỐT TP THÀNH CÔNG");
                        continue;
                    }
                    if (hitInternalSL) {
                        bot.botActivePositions.delete(key);
                        await closePositionAndLog(bot, b, markP, "CẮT LỖ SL HỆ THỐNG");
                        continue;
                    }

                    // Xử lý DCA tự động
                    const isHitDCA = dcaType === 'DUONG' 
                        ? (b.side === 'LONG' ? markP >= b.nextDCA : markP <= b.nextDCA)
                        : (b.side === 'LONG' ? markP <= b.nextDCA : markP >= b.nextDCA);

                    if (isHitDCA && b.dcaCount < 5) {
                        const nextLevel = b.dcaCount + 1;
                        const coef = b.isDiangucMode ? bot.botSettings.heSoDianguc : bot.botSettings.heSoThuong;
                        const nextMargin = (b.currentMargin * coef);
                        
                        openPosition(bot, b.symbol, { ...b, dcaCount: nextLevel, margin: nextMargin }, b.side);
                    }
                } else {
                    bot.botActivePositions.delete(key);
                }
            }
        } catch (e) {
            console.log(`[MONITOR ERROR] Luồng ${username} gặp sự cố kết nối.`);
        }
    }
}, 2000);

// --- BỘ QUÉT TÌM KIẾM TÍN HIỆU ĐỂ VÀO LỆNH TỰ ĐỘNG ---
setInterval(async () => {
    for (const [username, bot] of activeUserBots.entries()) {
        if (!bot.status.isReady || !bot.botSettings.isRunning || bot.botActivePositions.size >= bot.botSettings.maxPositions) continue;

        for (const c of sharedState.candidatesList) {
            if (bot.botActivePositions.has(`${c.symbol}_LONG`) || bot.botActivePositions.has(`${c.symbol}_SHORT`)) continue;

            const m1 = parseFloat(c.c1 || 0);
            let side = m1 > 0 ? 'LONG' : 'SHORT';
            let isHell = Math.abs(m1) >= bot.botSettings.diangucvol;
            let isNormal = Math.abs(m1) >= bot.botSettings.minVol;

            if (isHell || isNormal) {
                const info = sharedState.exchangeInfo?.[c.symbol];
                if (!info) continue;

                const priceTicker = await axios.get(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${c.symbol}`).catch(() => null);
                if (!priceTicker) continue;
                const curPrice = parseFloat(priceTicker.data.price);

                let balance = parseFloat(bot.walletCache.availableBalance);
                let configValue = bot.botSettings.invValue;
                let marginAllocated = configValue.toString().includes('%') ? (balance * parseFloat(configValue) / 100) : parseFloat(configValue);

                let targetQty = Number(((marginAllocated * info.maxLeverage) / curPrice).toFixed(info.quantityPrecision));
                if (targetQty * curPrice < MIN_NOTIONAL_FORCE) {
                    targetQty = Number((MIN_NOTIONAL_FORCE / curPrice).toFixed(info.quantityPrecision));
                }

                if (targetQty > 0) {
                    openPosition(bot, c.symbol, null, side, targetQty, marginAllocated, curPrice, isHell, { m1 });
                    break; 
                }
            }
        }
    }
}, 3000);

// Nạp thông tin cấu hình bước giá từ Binance
async function initGlobalExchangeData() {
    try {
        const info = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
        const temp = {};
        info.data.symbols.forEach(s => {
            if (s.status !== 'TRADING') return;
            temp[s.symbol] = {
                quantityPrecision: s.quantityPrecision,
                pricePrecision: s.pricePrecision,
                stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize),
                maxLeverage: 20
            };
        });
        sharedState.exchangeInfo = temp;
        console.log("📊 [DATA SYSTEM] Đã đồng bộ bộ khung cài đặt đòn bẩy sàn Binance.");
    } catch (e) { setTimeout(initGlobalExchangeData, 10000); }
}
initGlobalExchangeData();

// Kết nối lấy mảng tín hiệu máy quét khung (Port 9000 mặc định của ông)
setInterval(() => {
    axios.get('http://127.0.0.1:9000/api/data').then(res => {
        sharedState.candidatesList = res.data.live || [];
    }).catch(() => {});
}, 2000);

// --- CỤM API ĐIỀU HÀNH NỘI BỘ (CHỈ GIAO TIẾP QUA LOCALHOST VỚI PORT 4000) ---
const appBotMaster = express();
appBotMaster.use(express.json());

appBotMaster.post('/api/user/start', async (req, res) => {
    const { username, apiKey, secretKey, botSettings } = req.body;
    if (!username || !apiKey || !secretKey) return res.json({ success: false, msg: "Tài khoản thiếu API cấu hình sàn." });

    if (activeUserBots.has(username)) {
        const currentBot = activeUserBots.get(username);
        currentBot.botSettings.isRunning = true;
        return res.json({ success: true, msg: "Đã tái khởi động tiến trình giao dịch." });
    }

    const instance = new MiniScalpingBotInstance(username, apiKey, secretKey, botSettings);
    await instance.init();
    activeUserBots.set(username, instance);

    return res.json({ success: true, msg: "Hệ thống đa luồng đã thiết lập tài khoản thành công." });
});

appBotMaster.post('/api/user/stop', (req, res) => {
    const { username } = req.body;
    if (activeUserBots.has(username)) {
        activeUserBots.get(username).botSettings.isRunning = false;
        return res.json({ success: true, msg: "Đã tạm dừng hoạt động trading." });
    }
    return res.json({ success: false, msg: "Thực thể bot chưa chạy." });
});

appBotMaster.get('/api/user/status/:username', (req, res) => {
    const { username } = req.params;
    const bot = activeUserBots.get(username);

    if (!bot) {
        return res.json({
            botSettings: { isRunning: false }, activePositions: [],
            status: { botClosedCount: 0, botPnLClosed: 0, botLogs: [] },
            wallet: { totalWalletBalance: "0.00", availableBalance: "0.00" }
        });
    }

    return res.json({
        botSettings: bot.botSettings,
        activePositions: Array.from(bot.botActivePositions.values()),
        status: {
            botLogs: bot.status.botLogs,
            botClosedCount: bot.status.botClosedCount,
            botPnLClosed: bot.status.botPnLClosed,
            timeRun: formatUptime(bot.startTime)
        },
        wallet: bot.walletCache
    });
});

appBotMaster.listen(8080, '127.0.0.1', () => console.log('🤖 [INTERNAL CORE BOT] Đang xử lý đa luồng ngầm tại địa chỉ 127.0.0.1:8080'));
