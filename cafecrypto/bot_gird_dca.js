const express = require('express');
const ccxt = require('ccxt');
const axios = require('axios');

const app = express();
app.use(express.json());

const MIN_NOTIONAL_FORCE = 5.1;
const activeBots = new Map();
let globalCandidatesList = [];

class GridDcaBotInstance {
    constructor(username, apiKey, secretKey) {
        this.username = username;
        this.isRunning = false;
        this.activePairs = new Map();
        this.status = { botLogs: [] };
        
        this.exchange = new ccxt.binance({
            apiKey: apiKey,
            secret: secretKey,
            enableRateLimit: true,
            options: { defaultType: 'future', dualSidePosition: true }
        });
        
        this.startEngineLoop();
    }

    addLog(msg) {
        const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
        this.status.botLogs.unshift({ time, msg });
        if (this.status.botLogs.length > 50) this.status.botLogs.pop();
    }

    startEngineLoop() {
        // Luồng quét lệnh ma trận phòng hộ Hedge & DCA 
        setInterval(async () => {
            if (!this.isRunning) return;
            try {
                // Logic quét candidate của file test5.js dựa trên globalCandidatesList từ port 9000
                // Thực hiện mở/đóng vị thế và lưu vào this.activePairs giống file test5.js gốc
            } catch (e) {}
        }, 3000);
    }
}

// Đồng bộ dữ liệu phân tích từ Port 9000 tập trung
setInterval(() => {
    axios.get('http://127.0.0.1:9000/api/data').then(res => {
        globalCandidatesList = res.data?.live || [];
    }).catch(() => {});
}, 2000);

// API TIẾP NHẬN ĐIỀU KHIỂN TỪ MASTER SERVER
app.post('/api/user/toggle', (req, res) => {
    const { username, apiKey, secretKey, isRunning } = req.body;
    let bot = activeBots.get(username);
    if (!bot) {
        bot = new GridDcaBotInstance(username, apiKey, secretKey);
        activeBots.set(username, bot);
    }
    bot.isRunning = isRunning;
    bot.addLog(isRunning ? "🚀 Hệ thống Ma trận Grid & DCA đã được kích hoạt thành công!" : "🛑 Hệ thống đã tạm dừng lệnh mới.");
    return res.json({ success: true });
});

app.post('/api/user/status', (req, res) => {
    const { username } = req.body;
    const bot = activeBots.get(username);
    if (bot) {
        return res.json({
            activePositions: Array.from(bot.activePairs.values()),
            status: bot.status
        });
    }
    return res.json({ activePositions: [], status: { botLogs: [] } });
});

app.listen(1835, '127.0.0.1', () => console.log(`[CORE BOT 3] Đang túc trực chiến đấu ổn định tại Port: 1835`));
