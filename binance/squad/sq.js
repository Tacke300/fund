import express from 'express';
import { chromium } from 'playwright';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 9999;
const userDataDir = path.join(__dirname, 'binance_session');

const TOP_COINS = ["BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "AVAX", "DOGE", "DOT", "LINK", "MATIC", "NEAR"];

// Trạng thái hệ thống
let isRunning = false;
let totalPosts = 0;
let history = [];
let userInfo = { name: "Chưa đăng nhập", followers: 0, status: "Offline" };
let mainTimer = null;

// --- HÀM KIỂM TRA THÔNG TIN TÀI KHOẢN ---
async function checkAccount() {
    let browser;
    try {
        browser = await chromium.launchPersistentContext(userDataDir, { headless: true });
        const page = await browser.newPage();
        await page.goto('https://www.binance.com/vi/square/profile/me', { timeout: 60000 });
        
        // Chờ lấy tên hiển thị (Selector này thường dùng cho tên User trên Square)
        await page.waitForTimeout(5000); 
        const name = await page.locator('div[class*="css-1o8m8j"]').first().innerText().catch(() => "N/A");
        const followers = await page.locator('div:has-text("Người theo dõi")').first().innerText().catch(() => "0");

        if (name !== "N/A") {
            userInfo = { name, followers, status: "Đã đăng nhập ✅" };
            return true;
        }
        return false;
    } catch (e) {
        userInfo.status = "Lỗi kết nối hoặc chưa Login";
        return false;
    } finally {
        if (browser) await browser.close();
    }
}

// --- HÀM LẤY GIÁ & SIGNAL ---
async function getAnalysis(symbol) {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}USDT`);
        const price = parseFloat(res.data.lastPrice);
        const change = parseFloat(res.data.priceChangePercent);
        const side = change >= 0 ? "LONG 🟢" : "SHORT 🔴";
        return { symbol, price: price.toFixed(4), side, entry: price.toFixed(4), tp: (price * 1.03).toFixed(4), sl: (price * 0.98).toFixed(4) };
    } catch (e) { return null; }
}

// --- HÀM ĐĂNG BÀI ---
async function postTask() {
    if (!isRunning) return;
    let browser;
    try {
        browser = await chromium.launchPersistentContext(userDataDir, { headless: true });
        const page = await browser.newPage();
        await page.goto('https://www.binance.com/vi/square', { timeout: 60000 });

        const editorSelector = 'div[role="textbox"]';
        await page.waitForSelector(editorSelector, { timeout: 30000 });

        const coin = TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)];
        const data = await getAnalysis(coin);
        if (!data) return;

        const content = `📊 PHÂN TÍCH KỸ THUẬT 4H: $${coin}\n\nTín hiệu: ${data.side}\n📌 Entry: ${data.entry}\n🎯 TP: ${data.tp}\n🛑 SL: ${data.sl}\n\n#${coin} #TradingSignal #BinanceSquare`;

        await page.fill(editorSelector, content);
        await page.waitForTimeout(2000);
        await page.click('button:has-text("Đăng")');
        await page.waitForTimeout(3000);

        totalPosts++;
        history.unshift({ coin, time: new Date().toLocaleTimeString(), status: 'Thành công' });
        console.log(`✅ Đã đăng bài $${coin}`);
    } catch (err) {
        console.error("❌ Lỗi Post:", err.message);
    } finally {
        if (browser) await browser.close();
    }
}

// --- API ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/stats', (req, res) => {
    res.json({ isRunning, totalPosts, history, userInfo });
});

app.get('/login', async (req, res) => {
    // Mở trình duyệt để người dùng đăng nhập thủ công
    const browser = await chromium.launchPersistentContext(userDataDir, { headless: false });
    const page = await browser.newPage();
    await page.goto('https://www.binance.com/vi/square', { timeout: 0 });
    res.send("Vui lòng đăng nhập trên máy tính. Sau khi xong, hãy đóng trình duyệt và nhấn 'Check Account' trên Web.");
});

app.get('/check', async (req, res) => {
    await checkAccount();
    res.json(userInfo);
});

app.get('/start', (req, res) => {
    if (!isRunning) {
        isRunning = true;
        postTask();
        mainTimer = setInterval(postTask, 15 * 60 * 1000);
    }
    res.json({ status: 'started' });
});

app.get('/stop', (req, res) => {
    isRunning = false;
    if (mainTimer) clearInterval(mainTimer);
    res.json({ status: 'stopped' });
});

app.listen(port, () => console.log(`🚀 Bot Square chạy tại: http://localhost:${port}`));
