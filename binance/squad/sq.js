import { chromium } from 'playwright';
import { stealthSync } from 'playwright-stealth';
import express from 'express';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const userDataDir = path.join(__dirname, 'bot_session_final');

const TOP_COINS = ["BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "AVAX", "DOGE", "DOT", "LINK", "MATIC", "NEAR"];
let isRunning = false;
let totalPosts = 0;
let history = [];
let userInfo = { name: "N/A", status: "Offline" };
let context = null;

const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ➡️ ${msg}`);

async function getBrowser(show = false) {
    if (context) return context;
    context = await chromium.launchPersistentContext(userDataDir, {
        headless: !show,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--use-fake-ui-for-media-stream',
            '--window-size=1280,720'
        ],
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });
    return context;
}

async function postTask() {
    if (!isRunning) return;
    log("🚀 Bắt đầu tiến trình đăng bài...");
    let page = null;
    try {
        const ctx = await getBrowser(false);
        page = await ctx.newPage();
        stealthSync(page); // Áp dụng stealth cho từng page

        // Chỉ đợi 15s cho trang load cơ bản
        log("Đang vào Square...");
        await page.goto('https://www.binance.com/vi/square', { waitUntil: 'commit', timeout: 30000 });

        // Tìm ô nhập liệu (Thử 3 loại selector phổ biến nhất của Binance)
        log("Đang tìm ô nhập liệu...");
        const box = await page.waitForSelector('div[role="textbox"], .public-DraftEditor-content, [contenteditable="true"]', { timeout: 45000 });
        
        if (box) {
            const coin = TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)];
            const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}USDT`);
            const content = `📊 $${coin} Signal: ${parseFloat(res.data.priceChangePercent) >= 0 ? "LONG 🟢" : "SHORT 🔴"}\n💰 Price: ${res.data.lastPrice}\n#BinanceSquare`;
            
            await box.click();
            await page.keyboard.type(content, { delay: 30 });
            await page.waitForTimeout(2000);
            
            const btn = page.locator('button:has-text("Đăng"), button:has-text("Post")').first();
            await btn.click();
            
            log(`✅ Thành công: $${coin}`);
            totalPosts++;
            history.unshift({ coin, time: new Date().toLocaleTimeString(), status: 'Thành công' });
        }
    } catch (e) {
        log(`❌ Lỗi: ${e.message.split('\n')[0]}`);
    } finally {
        if (page) await page.close();
    }
}

// API Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));

app.get('/login', async (req, res) => {
    if (context) await context.close(); context = null;
    const ctx = await getBrowser(true);
    const page = await ctx.newPage();
    await page.goto('https://www.binance.com/vi/square');
    res.send("Đã mở Chrome. Đăng nhập xong hãy tắt Chrome này đi để Bot chạy ẩn.");
});

app.get('/check', async (req, res) => {
    log("🔍 Check tài khoản...");
    try {
        const ctx = await getBrowser(false);
        const page = await ctx.newPage();
        await page.goto('https://www.binance.com/vi/square/profile/moncey_d_luffy', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(5000);
        const name = await page.title(); // Lấy title trang cho nhanh
        userInfo = { name: name.includes("Luffy") ? "Luffy OK" : "Chưa nhận diện", status: "Online" };
        await page.close();
    } catch (e) { userInfo.status = "Lỗi"; }
    res.json(userInfo);
});

app.get('/start', (req, res) => {
    if (!isRunning) {
        isRunning = true;
        postTask();
        setInterval(postTask, 15 * 60 * 1000);
    }
    res.json({ status: 'started' });
});

app.listen(9999, '0.0.0.0', () => log("SERVER LIVE: 9999"));
