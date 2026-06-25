const express = require('express');
const ccxt = require('ccxt');

const appNormal = express();
const appReverse = express();
appNormal.use(express.json());
appReverse.use(express.json());

const activeBotsNormal = new Map();
const activeBotsReverse = new Map();

class ProBotCore {
    constructor(username, apiKey, secretKey, botSettings, direction) {
        this.username = username;
        this.direction = direction; // 'normal' hoặc 'reverse'
        this.botSettings = botSettings;
        this.status = { botLogs: [], botClosedCount: 0, botPnLClosed: 0 };
        this.activePositions = [];
        this.walletCache = { totalWalletBalance: "0.00", availableBalance: "0.00" };

        this.exchange = new ccxt.binance({
            apiKey: apiKey,
            secret: secretKey,
            enableRateLimit: true,
            options: { defaultType: 'future', adjustForTimeDifference: true }
        });
    }

    async forceCrossModeGlobal() {
        try {
            this.addLog(`⚙️ [PRO-${this.direction.toUpperCase()}] Đang quét dọn hệ thống...`);
            const positions = await this.exchange.fetchPositions();
            const openPositions = positions.filter(p => parseFloat(p.contracts) > 0);

            if (openPositions.length > 0) {
                this.addLog(`🚨 Phát hiện vị thế đang mở. Thực thi lệnh MARKET ĐÓNG TOÀN BỘ ngay lập tức để ép đổi chế độ Cross...`);
                for (const pos of openPositions) {
                    const side = pos.side === 'long' ? 'sell' : 'buy';
                    try {
                        await this.exchange.createMarketOrder(pos.symbol, side, Math.abs(parseFloat(pos.contracts)), undefined, { reduceOnly: true });
                        this.addLog(`✅ [PRO] Đã thanh lý Market vị thế: ${pos.symbol}`);
                    } catch (err) {
                        this.addLog(`❌ Lỗi đóng vị thế ${pos.symbol}: ${err.message}`);
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            try {
                await this.exchange.setMarginMode('CROSS', 'BTC/USDT');
                this.addLog(`🔒 Hệ thống PRO đã khóa tài khoản về chế độ phòng hộ CROSS.`);
            } catch (e) {
                if (e.message.includes("No need to change") || e.message.includes("Margin type unchanged")) {
                    this.addLog(`🔒 Kiểm tra: Tài khoản hiện tại đạt chuẩn Ký quỹ CROSS.`);
                } else {
                    this.addLog(`⚠️ Cảnh báo chế độ: ${e.message}`);
                }
            }
        } catch (error) {
            this.addLog(`❌ Thất bại quy trình cài Cross: ${error.message}`);
        }
    }

    async updateWallet() {
        try {
            const balance = await this.exchange.fetchBalance();
            if (balance && balance.info && balance.info.assets) {
                const usdt = balance.info.assets.find(a => a.asset === 'USDT');
                if (usdt) {
                    this.walletCache.totalWalletBalance = parseFloat(usdt.walletBalance).toFixed(2);
                    this.walletCache.availableBalance = parseFloat(usdt.availableBalance).toFixed(2);
                }
            }
        } catch (e) {
            this.addLog(`⚠️ Lỗi đồng bộ tài sản: ${e.message}`);
        }
    }

    addLog(msg) {
        const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
        this.status.botLogs.unshift({ time, msg });
        if (this.status.botLogs.length > 25) this.status.botLogs.pop();
    }
}

// --- XỬ LÝ CHO PORT 1833: PRO CÙNG CHIỀU (NORMAL) ---
appNormal.post('/api/user/toggle', async (req, res) => {
    const { username, apiKey, secretKey, botSettings } = req.body;
    let bot = activeBotsNormal.get(username);
    if (!bot) { bot = new ProBotCore(username, apiKey, secretKey, botSettings, 'normal'); activeBotsNormal.set(username, bot); }
    bot.botSettings.isRunning = botSettings.isRunning;
    if (bot.botSettings.isRunning) { bot.addLog("🚀 Kích hoạt cấu trúc PRO [CÙNG CHIỀU]..."); await bot.forceCrossModeGlobal(); }
    return res.json({ success: true });
});
appNormal.post('/api/user/status', async (req, res) => {
    let bot = activeBotsNormal.get(req.body.username);
    if (bot) { await bot.updateWallet(); return res.json({ botSettings: bot.botSettings, activePositions: bot.activePositions, status: bot.status, wallet: bot.walletCache }); }
    return res.json({ botSettings: { isRunning: false }, activePositions: [], status: { botClosedCount: 0, botPnLClosed: 0, botLogs: [] }, wallet: { totalWalletBalance: "0.00", availableBalance: "0.00" } });
});

// --- XỬ LÝ CHO PORT 1834: PRO NGƯỢC CHIỀU (REVERSE) ---
appReverse.post('/api/user/toggle', async (req, res) => {
    const { username, apiKey, secretKey, botSettings } = req.body;
    let bot = activeBotsReverse.get(username);
    if (!bot) { bot = new ProBotCore(username, apiKey, secretKey, botSettings, 'reverse'); activeBotsReverse.set(username, bot); }
    bot.botSettings.isRunning = botSettings.isRunning;
    if (bot.botSettings.isRunning) { bot.addLog("🔥 Kích hoạt cấu trúc PRO [NGƯỢC CHIỀU] (Đảo Lệnh)..."); await bot.forceCrossModeGlobal(); }
    return res.json({ success: true });
});
appReverse.post('/api/user/status', async (req, res) => {
    let bot = activeBotsReverse.get(req.body.username);
    if (bot) { await bot.updateWallet(); return res.json({ botSettings: bot.botSettings, activePositions: bot.activePositions, status: bot.status, wallet: bot.walletCache }); }
    return res.json({ botSettings: { isRunning: false }, activePositions: [], status: { botClosedCount: 0, botPnLClosed: 0, botLogs: [] }, wallet: { totalWalletBalance: "0.00", availableBalance: "0.00" } });
});

appNormal.listen(1833, '127.0.0.1', () => console.log(`🚀 [BOT PRO] Cổng CÙNG CHIỀU (Normal) kích hoạt tại Port: 1833`));
appReverse.listen(1834, '127.0.0.1', () => console.log(`🚀 [BOT PRO] Cổng NGƯỢC CHIỀU (Reverse) kích hoạt tại Port: 1834`));
