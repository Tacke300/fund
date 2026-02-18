import { chromium } from 'playwright';
import express from 'express';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = 9999;
const userDataDir = path.join(__dirname, 'bot_session_final');

const TOP_COINS = ["BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "AVAX", "DOGE", "DOT", "LINK", "MATIC", "NEAR"];
let isRunning = false;
let totalPosts = 0;
let history = [];
let userInfo = { name: "Chưa kiểm tra", followers: "0", status: "Offline" };

let browser = null;
let context = null;

// --- HÀM KHỞI TẠO DUY NHẤT MỘT LẦN ---
async function initBrowser(show) {
    if (context) return context; // Nếu đang chạy thì dùng tiếp, không mở thêm
    
    console.log("🚀 Đang khởi tạo trình duyệt...");
    context = await chromium.launchPersistentContext(userDataDir, {
        headless: !show, // Hiện hình khi Login, ẩn khi chạy ngầm
        viewport: { width: 1280, height: 800 },
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    });
    return context;
}

// --- KIỂM TRA TÀI KHOẢN ---
app.get('/check', async (req, res) => {
    try {
        const ctx = await initBrowser(false);
        const page = await ctx.newPage();
        await page.goto('https://www.binance.com/vi/square/profile/me', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(4000);
        
        const name = await page.locator('div[class*="css-1o8m8j"]').first().innerText().catch(() => "N/A");
        const follow = await page.locator('div:has-text("Người theo dõi")').last().innerText().catch(() => "0");
        
        if (name !== "N/A") {
            userInfo = { name, followers: follow.replace("Người theo dõi", "").trim(), status: "Sẵn sàng ✅" };
        }
        await page.close(); // Chỉ đóng tab, KHÔNG đóng context
        res.json(userInfo);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- ĐĂNG BÀI (CHẠY NGẦM) ---
async function postTask() {
    if (!isRunning) return;
    try {
        const ctx = await initBrowser(false);
        const page = await ctx.newPage();
        await page.goto('https://www.binance.com/vi/square', { waitUntil: 'domcontentloaded' });
        
        await page.waitForSelector('div[role="textbox"]', { timeout: 20000 });
        const coin = TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)];
        const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}USDT`);
        
        const content = `📊 $${coin} Signal: ${parseFloat(res.data.priceChangePercent) >= 0 ? "LONG 🟢" : "SHORT 🔴"}\n💰 Giá: ${parseFloat(res.data.lastPrice)}\n#BinanceSquare #$${coin}`;
        
        await page.fill('div[role="textbox"]', content);
        await page.waitForTimeout(2000);
        await page.click('button:has-text("Đăng")');
        await page.waitForTimeout(4000);
        
        totalPosts++;
        history.unshift({ coin, time: new Date().toLocaleTimeString(), status: 'Thành công' });
        await page.close();
    } catch (err) { console.log("Lỗi Post:", err.message); }
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));

app.get('/login', async (req, res) => {
    // Nếu có trình duyệt cũ, đóng hẳn để mở cái có hình
    if (context) { await context.close(); context = null; }
    const ctx = await initBrowser(true); // Mở có hình
    const page = await ctx.newPage();
    await page.goto('https://www.binance.com/vi/square');
    res.send("Hãy đăng nhập trên cửa sổ Chrome vừa hiện ra. Đăng nhập xong KHÔNG ĐƯỢC ĐÓNG, cứ để đó rồi quay lại web bấm Kiểm tra.");
});

app.get('/start', (req, res) => {
    if (!isRunning) {
        isRunning = true;
        postTask();
        setInterval(postTask, 15 * 60 * 1000);
    }
    res.json({ status: 'started' });
});

app.listen(port, '0.0.0.0', () => console.log(`🚀 Bot Square chạy tại port ${port}`));
