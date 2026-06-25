const express = require('express');
const ccxt = require('ccxt');

// Khởi tạo 2 ứng dụng Express chạy song song trong 1 File cho 2 Port riêng biệt
const appNormal = express();
const appReverse = express();
appNormal.use(express.json());
appReverse.use(express.json());

const activeBotsNormal = new Map();
const activeBotsReverse = new Map();

class MiniBotCore {
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
            this.addLog(`⚙️ [MINI-${this.direction.toUpperCase()}] Đang rà soát trạng thái Cross...`);
            const positions = await this.exchange.fetchPositions();
            const openPositions = positions.filter(p => parseFloat(p.contracts) > 0);

            if (openPositions.length > 0) {
                this.addLog(`🚨 Phát hiện vị thế mở. Đang ép lệnh Market ĐÓNG TOÀN BỘ để chuyển chế độ sang Cross...`);
                for (const pos of openPositions) {
                    const side = pos.side === 'long' ? 'sell' : 'buy';
                    try {
                        await this.exchange.createMarketOrder(pos.symbol, side, Math.abs(parseFloat(pos.contracts)), undefined, { reduceOnly: true });
                        this.addLog(`✅ Đã đóng Market khẩn cấp: ${pos.symbol}`);
                    } catch (err) {
                        this.addLog(`❌ Không thể đóng ${pos.symbol}: ${err.message}`);
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 2000)); // Chờ sàn đồng bộ
            }

            try {
                await this.exchange.setMarginMode('CROSS', 'BTC/USDT');
                this.addLog(`🔒 Tài khoản đã được ép về chế độ Ký quỹ CROSS thành công.`);
            } catch (e) {
                if (e.message.includes("No need to change") || e.message.includes("Margin type unchanged")) {
                    this.addLog(`🔒 Xác nhận: Tài khoản hiện tại đã ở trạng thái CROSS.`);
                } else {
                    this.addLog(`⚠️ Cảnh báo cấu hình Cross: ${e.message}`);
                }
            }
        } catch (error) {
            this.addLog(`❌ Thất bại khi cài đặt cấu hình Cross: ${error.message}`);
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
            this.addLog(`⚠️ Lỗi kết nối lấy số dư: ${e.message}`);
        }
    }

    addLog(msg) {
        const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
        this.status.botLogs.unshift({ time, msg });
        if (this.status.botLogs.length > 25) this.status.botLogs.pop();
    }
}

// --- XỬ LÝ CHO PORT 1831: CÙNG CHIỀU (NORMAL) ---
appNormal.post('/api/user/toggle', async (req, res) => {
    const { username, apiKey, secretKey, botSettings } = req.body;
    let bot = activeBotsNormal.get(username);
    if (!bot) { bot = new MiniBotCore(username, apiKey, secretKey, botSettings, 'normal'); activeBotsNormal.set(username, bot); }
    bot.botSettings.isRunning = botSettings.isRunning;
    if (bot.botSettings.isRunning) { bot.addLog("🚀 Khởi động MINI [CÙNG CHIỀU]..."); await bot.forceCrossModeGlobal(); }
    return res.json({ success: true });
});
appNormal.post('/api/user/status', async (req, res) => {
    let bot = activeBotsNormal.get(req.body.username);
    if (bot) { await bot.updateWallet(); return res.json({ botSettings: bot.botSettings, activePositions: bot.activePositions, status: bot.status, wallet: bot.walletCache }); }
    return res.json({ botSettings: { isRunning: false }, activePositions: [], status: { botClosedCount: 0, botPnLClosed: 0, botLogs: [] }, wallet: { totalWalletBalance: "0.00", availableBalance: "0.00" } });
});

// --- XỬ LÝ CHO PORT 1832: NGƯỢC CHIỀU (REVERSE) ---
appReverse.post('/api/user/toggle', async (req, res) => {
    const { username, apiKey, secretKey, botSettings } = req.body;
    let bot = activeBotsReverse.get(username);
    if (!bot) { bot = new MiniBotCore(username, apiKey, secretKey, botSettings, 'reverse'); activeBotsReverse.set(username, bot); }
    bot.botSettings.isRunning = botSettings.isRunning;
    if (bot.botSettings.isRunning) { bot.addLog("🔥 Khởi động MINI [NGƯỢC CHIỀU] (Đảo Lệnh)..."); await bot.forceCrossModeGlobal(); }
    return res.json({ success: true });
});
appReverse.post('/api/user/status', async (req, res) => {
    let bot = activeBotsReverse.get(req.body.username);
    if (bot) { await bot.updateWallet(); return res.json({ botSettings: bot.botSettings, activePositions: bot.activePositions, status: bot.status, wallet: bot.walletCache }); }
    return res.json({ botSettings: { isRunning: false }, activePositions: [], status: { botClosedCount: 0, botPnLClosed: 0, botLogs: [] }, wallet: { totalWalletBalance: "0.00", availableBalance: "0.00" } });
});

appNormal.listen(1831, '127.0.0.1', () => console.log(`🤖 [BOT MINI] Cổng CÙNG CHIỀU (Normal) kích hoạt tại Port: 1831`));
appReverse.listen(1832, '127.0.0.1', () => console.log(`🤖 [BOT MINI] Cổng NGƯỢC CHIỀU (Reverse) kích hoạt tại Port: 1832`));
