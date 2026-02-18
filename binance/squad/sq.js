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

// Hàm lấy Browser (Fix lỗi tranh chấp context)
async function getBrowser(show = false) {
    if (context) {
        try {
            // Kiểm tra xem context còn sống không
            await context.browser().version();
            return context;
        } catch (e) {
            context = null; // Nếu chết thì reset để tạo mới
        }
    }
    
    context = await chromium.launchPersistentContext(userDataDir, {
        headless: !show,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--use-fake-ui-for-media-stream',
            '--window-size=1280,720',
            '--no-sandbox',
            '--disable-dev-shm-usage'
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
        stealthSync(page);

        log("Đang vào Square...");
        // Tăng timeout lên một chút để tránh "chó gặm" khi mạng lag
        await page.goto('https://www.binance.com/vi/square', { waitUntil: 'domcontentloaded', timeout: 60000 });

        log("Đang tìm ô nhập liệu...");
        // Selector của Binance Square rất hay thay đổi, dùng tổ hợp này cho chắc
        const box = await page.waitForSelector('div[role="textbox"], .public-DraftEditor-content, [contenteditable="true"]', { timeout: 60000 });
        
        if (box) {
            const coin = TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)];
            const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}USDT`);
            const price = parseFloat(res.data.lastPrice).toFixed(2);
            const change = parseFloat(res.data.priceChangePercent).toFixed(2);
            
            const content = `📊 $${coin} Signal: ${change >= 0 ? "LONG 🟢" : "SHORT 🔴"}\n💰 Price: ${price}\n📈 24h: ${change}%\n#BinanceSquare`;
            
            await box.click();
            await page.keyboard.type(content, { delay: 50 });
            await page.waitForTimeout(3000);
            
            const btn = page.locator('button:has-text("Đăng"), button:has-text("Post")').first();
            await btn.click();
            
            // Đợi một chút xem có lỗi gì hiện ra không
            await page.waitForTimeout(5000);
            
            log(`✅ Thành công: $${coin}`);
            totalPosts++;
            history.unshift({ coin, time: new Date().toLocaleTimeString(), status: 'Thành công' });
        }
    } catch (e) {
        log(`❌ Lỗi: ${e.message.split('\n')[0]}`);
        // Nếu lỗi do trình duyệt đóng ngang, xóa context để lần sau mở lại
        if (e.message.includes('closed') || e.message.includes('not found')) context = null;
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

// --- API Routes (Giữ nguyên như cũ của bạn) ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));

app.get('/login', async (req, res) => {
    log("🔑 Mở trình duyệt để Login...");
    if (context) {
        await context.close().catch(() => {});
        context = null;
    }
    const ctx = await getBrowser(true);
    await ctx.newPage().then(p => p.goto('https://www.binance.com/vi/square'));
    res.send("Đã mở Chrome. Đăng nhập xong hãy TẮT CỬA SỔ CHROME đó đi, rồi quay lại web này bấm START.");
});

app.get('/check', async (req, res) => {
    log("🔍 Check tài khoản...");
    let page = null;
    try {
        const ctx = await getBrowser(false);
        page = await ctx.newPage();
        await page.goto('https://www.binance.com/vi/square/profile/moncey_d_luffy', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(5000);
        const title = await page.title();
        userInfo = { name: title.includes("Luffy") ? "Luffy OK" : "Chưa nhận diện", status: "Online" };
    } catch (e) { 
        userInfo.status = "Lỗi check"; 
    } finally {
        if (page) await page.close().catch(() => {});
    }
    res.json(userInfo);
});

app.get('/start', (req, res) => {
    if (!isRunning) {
        isRunning = true;
        postTask();
        setInterval(postTask, 15 * 60 * 1000);
        log("🏁 Bot đã bắt đầu chạy tự động (15p/lần)");
    }
    res.json({ status: 'started' });
});

app.listen(9999, '0.0.0.0', () => {
    console.log("==========================================");
    log("SERVER LIVE: http://localhost:9999");
    console.log("==========================================");
});
