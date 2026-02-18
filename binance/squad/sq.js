const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

const app = express();
const port = 9999;

const TOP_20_COINS = ["BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "AVAX", "DOGE", "DOT", "LINK", "MATIC", "SHIB", "TRX", "LTC", "BCH", "UNI", "NEAR", "APT", "STX", "FIL"];
const userDataDir = path.join(__dirname, 'binance_session');

let botState = {
    isRunning: false,
    totalPosts: 0,
    history: [], // Mỗi item: { coin, time, status, views: 0 }
    lastRun: null,
    timer: null,
    viewTimer: null
};

// Hàm đăng bài
async function postTask() {
    if (!botState.isRunning) return;
    let browser;
    try {
        browser = await chromium.launchPersistentContext(userDataDir, { headless: true, args: ['--no-sandbox'] });
        const page = await browser.newPage();
        const coin = TOP_20_COINS[Math.floor(Math.random() * TOP_20_COINS.length)];
        const tags = TOP_20_COINS.filter(c => c !== coin).sort(() => 0.5 - Math.random()).slice(0, 2);

        await page.goto('https://www.binance.com/vi/square', { timeout: 60000 });
        const editorSelector = 'div[role="textbox"]';
        await page.waitForSelector(editorSelector, { timeout: 20000 });
        
        const content = `Thị trường $${coin} đang có biến động đáng chú ý. Các nhà đầu tư cần quan sát kỹ khối lượng giao dịch.\n\n#${coin} #${tags[0]} #${tags[1]}\n$${coin} $${tags[0]} $${tags[1]}`;
        
        await page.fill(editorSelector, content);
        await page.click('button:has-text("Đăng")');
        await page.waitForTimeout(5000);

        botState.totalPosts++;
        botState.lastRun = new Date().toLocaleTimeString();
        botState.history.unshift({ coin, time: botState.lastRun, status: 'Thành công', views: 0 });
    } catch (err) {
        console.error("Lỗi Post:", err.message);
    } finally { if (browser) await browser.close(); }
}

// Hàm cập nhật View từ Profile
async function updateViews() {
    if (!botState.isRunning || botState.history.length === 0) return;
    let browser;
    try {
        browser = await chromium.launchPersistentContext(userDataDir, { headless: true, args: ['--no-sandbox'] });
        const page = await browser.newPage();
        // Bạn cần thay link này bằng link Profile Square của chính bạn
        await page.goto('https://www.binance.com/vi/square/profile/me', { timeout: 60000 });
        await page.waitForTimeout(5000);

        // Selector này lấy các con số view cạnh icon mắt (Cần check thực tế nếu Binance đổi UI)
        const viewElements = await page.$$eval('div[data-testid="article-card"]', cards => {
            return cards.map(card => {
                const text = card.innerText;
                const match = text.match(/(\d+(\.\d+)?[KMB]?)\s*lượt xem/i);
                return match ? match[1] : "0";
            });
        });

        // Cập nhật vào history (tạm thời khớp theo thứ tự mới nhất)
        viewElements.forEach((v, index) => {
            if (botState.history[index]) {
                // Chuyển đổi 1.2K thành 1200 để dễ sort
                let numericView = parseFloat(v);
                if (v.includes('K')) numericView *= 1000;
                if (v.includes('M')) numericView *= 1000000;
                botState.history[index].views = numericView || 0;
                botState.history[index].viewDisplay = v; // Để hiển thị "1.2K"
            }
        });
    } catch (err) {
        console.error("Lỗi lấy View:", err.message);
    } finally { if (browser) await browser.close(); }
}

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/stats', (req, res) => res.json(botState));
app.get('/start', (req, res) => {
    if (!botState.isRunning) {
        botState.isRunning = true;
        postTask();
        botState.timer = setInterval(postTask, 5 * 60 * 1000); // 5 phút đăng bài
        botState.viewTimer = setInterval(updateViews, 15 * 60 * 1000); // 15 phút check view 1 lần
    }
    res.send({ status: 'started' });
});
app.get('/stop', (req, res) => {
    botState.isRunning = false;
    clearInterval(botState.timer);
    clearInterval(botState.viewTimer);
    res.send({ status: 'stopped' });
});

app.listen(port, () => console.log(`Dashboard: http://localhost:${port}`));
