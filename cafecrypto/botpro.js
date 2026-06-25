const express = require('express');
const ccxt = require('ccxt');

const app = express();
app.use(express.json());
const PORT = 1832;

const activeBots = new Map();

class ScalpingProInstance {
    constructor(username, apiKey, secretKey, botSettings) {
        this.username = username;
        this.botId = 2;
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
            this.addLog("⚙️ [PRO] Đang kiểm tra cấu hình Ký quỹ hệ thống nâng cao...");
            const positions = await this.exchange.fetchPositions();
            const openPositions = positions.filter(p => parseFloat(p.contracts) > 0);

            if (openPositions.length > 0) {
                this.addLog(`🚨 [PRO] Đang giải phóng nhanh ${openPositions.length} lệnh mở để chuyển đổi Cross an toàn...`);
                for (const pos of openPositions) {
                    const side = pos.side === 'long' ? 'sell' : 'buy';
                    try {
                        await this.exchange.createMarketOrder(pos.symbol, side, Math.abs(parseFloat(pos.contracts)), undefined, { reduceOnly: true });
                        this.addLog(`✅ [PRO] Đã dọn sạch vị thế: ${pos.symbol}`);
                    } catch (err) {
                        this.addLog(`❌ [PRO] Không thể thanh lý lệnh ${pos.symbol}: ${err.message}`);
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            try {
                await this.exchange.setMarginMode('CROSS', 'BTC/USDT');
                this.addLog("🔒 [PRO] Ép thành công tài khoản về chế độ phòng vệ CROSS.");
            } catch (e) {
                if (e.message.includes("No need to change") || e.message.includes("Margin type unchanged")) {
                    this.addLog("🔒 [PRO] Kiểm tra: Tài khoản đã ở trạng thái Ký quỹ CROSS.");
                } else {
                    this.addLog(`⚠️ [PRO] Cảnh báo chế độ: ${e.message}`);
                }
            }
        } catch (error) {
            this.addLog(`❌ [PRO] Lỗi tiến trình thiết lập Cross: ${error.message}`);
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
            this.addLog(`⚠️ [PRO] Thất bại khi nạp số dư ví: ${e.message}`);
        }
    }

    addLog(msg) {
        const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
        this.status.botLogs.unshift({ time, msg });
        if (this.status.botLogs.length > 30) this.status.botLogs.pop();
    }
}

app.post('/api/user/toggle', async (req, res) => {
    const { username, apiKey, secretKey, botSettings } = req.body;
    if (!apiKey || !secretKey) return res.json({ success: false, msg: "Chưa thiết lập API Key!" });

    let bot = activeBots.get(username);
    if (!bot) {
        bot = new ScalpingProInstance(username, apiKey, secretKey, botSettings);
        activeBots.set(username, bot);
    } else {
        bot.botSettings.isRunning = botSettings.isRunning;
    }

    if (bot.botSettings.isRunning) {
        bot.addLog("🔥 KÍCH HOẠT ĐỘI HÌNH SCALPING PRO CHIẾN ĐẤU...");
        await bot.forceCrossModeGlobal();
    } else {
        bot.addLog("🛑 Hệ thống tạm dừng hoạt động quét lệnh nâng cao.");
    }

    return res.json({ success: true, msg: "Cập nhật trạng thái Bot 2 thành công." });
});

app.post('/api/user/status', async (req, res) => {
    const { username, apiKey, secretKey } = req.body;
    let bot = activeBots.get(username);
    if (!bot && apiKey && secretKey) {
        bot = new ScalpingProInstance(username, apiKey, secretKey, { isRunning: false });
        activeBots.set(username, bot);
    }
    if (bot) {
        await bot.updateWallet();
        return res.json({
            botSettings: bot.botSettings,
            activePositions: bot.activePositions,
            status: bot.status,
            wallet: bot.walletCache
        });
    }
    return res.json({ botSettings: { isRunning: false }, activePositions: [], status: { botClosedCount: 0, botPnLClosed: 0, botLogs: [] }, wallet: { totalWalletBalance: "0.00", availableBalance: "0.00" } });
});

app.listen(PORT, '127.0.0.1', () => console.log(`🤖 [PRO BOT] Đang chạy lõi chiến lược tại cổng nội bộ: ${PORT}`));
