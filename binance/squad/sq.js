const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const axios = require('axios');

const app = express();
const port = 9999;
const userDataDir = path.join(__dirname, 'binance_session');

// Cấu hình danh sách Coin
const TOP_COINS = ["BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "AVAX", "DOGE", "DOT", "LINK", "MATIC", "NEAR", "LTC", "ARB"];

let botState = {
    isRunning: false,
    totalPosts: 0,
    history: [],
    lastRun: null,
    timer: null,
    viewTimer: null
};

// --- HÀM 1: LẤY GIÁ VÀ TẠO TÍN HIỆU (SIGNAL) ---
async function getAnalysis(symbol) {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}USDT`);
        const price = parseFloat(res.data.lastPrice);
        const change = parseFloat(res.data.priceChangePercent);
        
        const side = change >= 0 ? "LONG 🟢" : "SHORT 🔴";
        const entry = price;
        const tp = side.includes("LONG") ? price * 1.03 : price * 0.97; // Mục tiêu 3%
        const sl = side.includes("LONG") ? price * 0.98 : price * 1.02; // Cắt lỗ 2%

        // Link Chart 4H từ TradingView (Dạng Snapshot)
        const chartUrl = `https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.html?symbol=BINANCE%3A${symbol}USDT&width=400&height=400&dateRange=12M&colorTheme=dark&trendLineColor=rgb%2841%2C%2098%2C%20255%29&underLineColor=rgba%2841%2C%2098%2C%20255%2C%200.3%29&underLineBottomColor=rgba%2841%2C%2098%2C%20255%2C%200%29&isTransparent=false&autosize=false&locale=vi_VN`;

        return {
            symbol,
            price: price.toFixed(4),
            change: change.toFixed(2),
            side,
            entry: entry.toFixed(4),
            tp: tp.toFixed(4),
            sl: sl.toFixed(4),
            chartUrl
        };
    } catch (e) {
        return null;
    }
}

// --- HÀM 2: CẬP NHẬT LƯỢT VIEW ---
async function updateViews() {
    if (!botState.isRunning || botState.history.length === 0) return;
    let browser;
    try {
        browser = await chromium.launchPersistentContext(userDataDir, { headless: true, args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.goto('https://www.binance.com/vi/square/profile/me', { waitUntil: 'networkidle' });
        await page.waitForTimeout(5000);

        const viewData = await page.$$eval('div[data-testid="article-card"]', cards => {
            return cards.map(card => {
                const text = card.innerText;
                const match = text.match(/(\d+(\.\d+)?[KMB]?)\s*lượt xem/i);
                return match ? match[1] : "0";
            });
        });

        viewData.forEach((v, i) => {
            if (botState.history[i]) {
                let num = parseFloat(v);
                if (v.includes('K')) num *= 1000;
                if (v.includes('M')) num *= 1000000;
                botState.history[i].views = num;
                botState.history[i].viewDisplay = v;
            }
        });
    } catch (e) { console.error("Lỗi lấy view:", e.message); }
    finally { if (browser) await browser.close(); }
}

// --- HÀM 3: ĐĂNG BÀI (MAIN TASK) ---
async function postTask() {
    if (!botState.isRunning) return;
    let browser;
    try {
        const coin = TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)];
        const data = await getAnalysis(coin);
        if (!data) return;

        browser = await chromium.launchPersistentContext(userDataDir, { headless: true, args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.goto('https://www.binance.com/vi/square', { timeout: 60000 });

        const editorSelector = 'div[role="textbox"]';
        await page.waitForSelector(editorSelector, { timeout: 20000 });

        const content = `📊 PHÂN TÍCH KỸ THUẬT KHUNG 4H: $${coin}\n\n` +
            `Thị trường đang có tín hiệu: ${data.side}\n` +
            `📌 Entry: ${data.entry}\n` +
            `🎯 Target (TP): ${data.tp}\n` +
            `🛑 Stoploss (SL): ${data.sl}\n\n` +
            `Tin tức: Dự án đang có sự gia tăng về khối lượng giao dịch đột biến trong 24h qua. Anh em chú ý quản lý vốn.\n\n` +
            `#${coin} #TradingSignal #TechnicalAnalysis\n` +
            `$${coin} $BTC $BNB`;

        // Nhập nội dung
        await page.fill(editorSelector, content);
        await page.waitForTimeout(2000);

        // Đăng bài
        await page.click('button:has-text("Đăng")');
        await page.waitForTimeout(5000);

        botState.totalPosts++;
        botState.lastRun = new Date().toLocaleTimeString();
        botState.history.unshift({ coin, time: botState.lastRun, status: 'Thành công', views: 0, viewDisplay: '0' });
        if (botState.history.length > 100) botState.history.pop();

    } catch (err) {
        console.error("Lỗi đăng bài:", err.message);
    } finally {
        if (browser) await browser.close();
    }
}

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/stats', (req, res) => res.json(botState));
app.get('/start', (req, res) => {
    if (!botState.isRunning) {
        botState.isRunning = true;
        postTask();
        botState.timer = setInterval(postTask, 5 * 60 * 1000); // 5 phút
        botState.viewTimer = setInterval(updateViews, 20 * 60 * 1000); // 20 phút cập nhật view
    }
    res.json({ status: 'ok' });
});
app.get('/stop', (req, res) => {
    botState.isRunning = false;
    clearInterval(botState.timer);
    clearInterval(botState.viewTimer);
    res.json({ status: 'ok' });
});

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
