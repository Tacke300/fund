const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const app = express();
const port = 9999;

// Cấu hình bot
const TOP_20_COINS = ["BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "AVAX", "DOGE", "DOT", "LINK", "MATIC", "SHIB", "TRX", "LTC", "BCH", "UNI", "NEAR", "APT", "STX", "FIL"];
const userDataDir = path.join(__dirname, 'binance_session');

let botState = {
    isRunning: false,
    totalPosts: 0,
    history: [],
    lastRun: null,
    timer: null
};

// Hàm lấy nội dung (Bạn có thể thay bằng API News thực tế)
const getContent = (coin) => {
    const templates = [
        `Phân tích dòng tiền cho $${coin}: Lực mua đang chiếm ưu thế tại khung H4. Đây là thời điểm quan trọng để quan sát vùng hỗ trợ.`,
        `Thị trường hôm nay tập trung vào $${coin}. Có nhiều tín hiệu on-chain cho thấy các whale đang tích lũy thêm.`,
        `Cập nhật nhanh về $${coin}: Hệ sinh thái đang mở rộng với nhiều đối tác mới. Triển vọng dài hạn rất khả quan.`
    ];
    return templates[Math.floor(Math.random() * templates.length)];
};

async function postTask() {
    if (!botState.isRunning) return;

    let browser;
    try {
        browser = await chromium.launchPersistentContext(userDataDir, {
            headless: true, // Chạy ẩn trên SSH
            args: ['--no-sandbox']
        });

        const page = await browser.newPage();
        const coin = TOP_20_COINS[Math.floor(Math.random() * TOP_20_COINS.length)];
        const tags = TOP_20_COINS.filter(c => c !== coin).sort(() => 0.5 - Math.random()).slice(0, 2);

        await page.goto('https://www.binance.com/vi/square', { timeout: 60000 });
        
        const editorSelector = 'div[role="textbox"]';
        await page.waitForSelector(editorSelector, { timeout: 20000 });
        
        const content = `${getContent(coin)}\n\n#${coin} #${tags[0]} #${tags[1]}\n$${coin} $${tags[0]} $${tags[1]}`;
        
        await page.fill(editorSelector, content);
        await page.click('button:has-text("Đăng")');
        await page.waitForTimeout(5000);

        botState.totalPosts++;
        botState.lastRun = new Date().toLocaleTimeString();
        botState.history.unshift({ coin, time: botState.lastRun, status: 'Thành công' });
        if (botState.history.length > 50) botState.history.pop();

    } catch (err) {
        console.error("Lỗi Bot:", err.message);
        botState.history.unshift({ coin: 'ERR', time: new Date().toLocaleTimeString(), status: 'Lỗi Selector' });
    } finally {
        if (browser) await browser.close();
    }
}

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/stats', (req, res) => res.json(botState));

app.get('/start', (req, res) => {
    if (!botState.isRunning) {
        botState.isRunning = true;
        postTask(); // Chạy ngay lập tức
        botState.timer = setInterval(postTask, 5 * 60 * 1000); // Mỗi 5 phút
    }
    res.send({ status: 'started' });
});

app.get('/stop', (req, res) => {
    botState.isRunning = false;
    if (botState.timer) clearInterval(botState.timer);
    res.send({ status: 'stopped' });
});

app.listen(port, () => {
    console.log(`=========================================`);
    console.log(`🚀 Bot Binance Square đang chạy!`);
    console.log(`🌐 Dashboard: http://localhost:${port}`);
    console.log(`📁 Session: ${userDataDir}`);
    console.log(`=========================================`);
});
