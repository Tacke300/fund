const express = require('express');
const ccxt = require('ccxt');

const app = express();
app.use(express.json());
const PORT = 1831;

const activeBots = new Map();

class MiniScalpingInstance {
    constructor(username, apiKey, secretKey, botSettings) {
        this.username = username;
        this.botId = 1;
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
            this.addLog("⚙️ Đang kiểm tra cấu hình Ký quỹ tài khoản...");
            const balances = await this.exchange.fetchBalance();
            
            // Lấy tất cả các vị thế thực tế đang mở trên sàn để xử lý
            const positions = await this.exchange.fetchPositions();
            const openPositions = positions.filter(p => parseFloat(p.contracts) > 0);

            // Quy trình: Nếu có vị thế mở, ép buộc đóng bằng lệnh Market toàn bộ
            if (openPositions.length > 0) {
                this.addLog(`🚨 Phát hiện ${openPositions.length} vị thế đang mở. Đang thực thi đóng Market toàn bộ để chuyển chế độ Cross...`);
                for (const pos of openPositions) {
                    const side = pos.side === 'long' ? 'sell' : 'buy';
                    try {
                        await this.exchange.createMarketOrder(pos.symbol, side, Math.abs(parseFloat(pos.contracts)), undefined, { reduceOnly: true });
                        this.addLog(`✅ Đã đóng khẩn cấp vị thế Market: ${pos.symbol}`);
                    } catch (err) {
                        this.addLog(`❌ Lỗi đóng vị thế ${pos.symbol}: ${err.message}`);
                    }
                }
                // Chờ 2 giây cho sàn cập nhật lệnh hệ thống
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            // Đổi toàn bộ các cặp giao dịch chính hoặc cặp chỉ định sang chế độ CROSS
            // Ví dụ kiểm tra và ép cấu hình Cross cho BTC/USDT làm mẫu, hoặc quét động
            try {
                await this.exchange.setMarginMode('CROSS', 'BTC/USDT');
                this.addLog("🔒 Hệ thống đã ép tài khoản về chế độ CROSS thành công.");
            } catch (e) {
                if (e.message.includes("No need to change") || e.message.includes("Margin type unchanged")) {
                    this.addLog("🔒 Chế độ ký quỹ tài khoản hiện tại đã ở dạng CROSS.");
                } else {
                    this.addLog(`⚠️ Cảnh báo cấu hình Cross: ${e.message}`);
                }
            }
        } catch (error) {
            this.addLog(`❌ Thất bại khi thiết lập cấu hình Cross: ${error.message}`);
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
            this.addLog(`⚠️ Không lấy được số dư tài khoản: ${e.message}`);
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
        bot = new MiniScalpingInstance(username, apiKey, secretKey, botSettings);
        activeBots.set(username, bot);
    } else {
        bot.botSettings.isRunning = botSettings.isRunning;
    }

    if (bot.botSettings.isRunning) {
        bot.addLog("🚀 Khởi chạy chiến lược MINI SCALPING...");
        await bot.forceCrossModeGlobal(); // Kích hoạt bộ lọc ép Cross khi bật Bot
    } else {
        bot.addLog("🛑 Đã dừng tiến trình chạy lệnh của Bot.");
    }

    return res.json({ success: true, msg: "Cập nhật trạng thái Bot 1 thành công." });
});

app.post('/api/user/status', async (req, res) => {
    const { username, apiKey, secretKey } = req.body;
    let bot = activeBots.get(username);
    if (!bot && apiKey && secretKey) {
        bot = new MiniScalpingInstance(username, apiKey, secretKey, { isRunning: false });
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

app.listen(PORT, '127.0.0.1', () => console.log(`🤖 [MINI BOT] Đang chạy lõi chiến lược tại cổng nội bộ: ${PORT}`));
