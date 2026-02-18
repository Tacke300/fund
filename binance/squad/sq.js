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

const TOP_COINS = ["BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "AVAX", "DOGE", "DOT", "LINK", "MATIC", "NEAR", "LTC"];

// Cấu hình trạng thái bot
let isRunning = false;
let totalPosts = 0;
let history = [];
let lastRun = null;
let mainTimer = null;
let viewTimer = null;

// --- HÀM LẤY GIÁ & SIGNAL ---
async function getAnalysis(symbol) {
    try {
        const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}USDT`);
        const price = parseFloat(res.data.lastPrice);
        const change = parseFloat(res.data.priceChangePercent);
        const side = change >= 0 ? "LONG 🟢" : "SHORT 🔴";
        const entry = price;
        const tp = side.includes("LONG") ? price * 1.03 : price * 0.97;
        const sl = side.includes("LONG") ? price * 0.98 : price * 1.02;

        return { symbol, price: price.toFixed(4), side, entry: entry.toFixed(4), tp: tp.toFixed(4), sl: sl.toFixed(4) };
    } catch (e) { return null; }
}

// --- HÀM ĐĂNG BÀI CHÍNH ---
async function postTask(isManualLogin = false) {
    let browser;
    try {
        // Nếu là đăng nhập thủ công thì hiện trình duyệt (headless: false)
        // Nếu chạy tự động thì ẩn trình duyệt (headless: true)
        const isHeadless = !isManualLogin;

        browser = await chromium.launchPersistentContext(userDataDir, { 
            headless: isHeadless, 
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
        });

        const page = await browser.newPage();
        await page.goto('https://www.binance.com/vi/square', { timeout: 60000 });

        if (isManualLogin) {
            console.log("👉 VUI LÒNG ĐĂNG NHẬP TRÊN TRÌNH DUYỆT ĐANG MỞ...");
            console.log("Sau khi đăng nhập xong, hãy đóng trình duyệt này để lưu Session.");
            return; // Dừng tại đây để người dùng thao tác
        }

        // Chờ ô nhập liệu xuất hiện
        const editorSelector = 'div[role="textbox"]';
        await page.waitForSelector(editorSelector, { timeout: 30000 });

        const coin = TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)];
        const data = await getAnalysis(coin);
        if (!data) return;

        const content = `📊 PHÂN TÍCH KỸ THUẬT 4H: $${coin}\n\n` +
            `Tín hiệu: ${data.side}\n📌 Entry: ${data.entry}\n🎯 TP: ${data.tp}\n🛑 SL: ${data.sl}\n\n` +
            `#${coin} #TradingSignal #BinanceSquare\n$${coin} $BTC`;

        await page.fill(editorSelector, content);
        await page.waitForTimeout(3000);
        await page.click('button:has-text("Đăng")');
        await page.waitForTimeout(5000);

        totalPosts++;
        lastRun = new Date().toLocaleTimeString();
        history.unshift({ coin, time: lastRun, status: 'Thành công' });
        if (history.length > 50) history.pop();

        console.log(`✅ Đã đăng bài $${coin} lúc ${lastRun}`);
    } catch (err) {
        console.error("❌ Lỗi Post:", err.message);
    } finally {
        if (browser && !isManualLogin) await browser.close();
    }
}

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Route để lấy dữ liệu cho Dashboard (Đã sửa lỗi Circular JSON)
app.get('/stats', (req, res) => {
    res.json({ isRunning, totalPosts, lastRun, history });
});

// Chế độ đăng nhập thủ công
app.get('/login', async (req, res) => {
    res.send("Kiểm tra màn hình máy tính, trình duyệt đang mở để bạn đăng nhập...");
    await postTask(true);
});

app.get('/start', (req, res) => {
    if (!isRunning) {
        isRunning = true;
        postTask();
        mainTimer = setInterval(postTask, 10 * 60 * 1000); // 10 phút đăng 1 lần
    }
    res.json({ status: 'started' });
});

app.get('/stop', (req, res) => {
    isRunning = false;
    if (mainTimer) clearInterval(mainTimer);
    res.json({ status: 'stopped' });
});

app.listen(port, () => console.log(`🚀 Squad Bot: http://localhost:${port}`));
