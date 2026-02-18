import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

const playwright = chromium;
playwright.use(StealthPlugin());

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
let context = null;

const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ➡️ ${msg}`);

async function initBrowser(show = false) {
    if (context) {
        try { await context.pages(); return context; } 
        catch (e) { context = null; }
    }
    log(show ? "Mở Chrome hiện hình..." : "Khởi tạo trình duyệt ngầm...");
    context = await playwright.launchPersistentContext(userDataDir, {
        headless: !show,
        channel: 'chrome',
        viewport: { width: 1366, height: 768 },
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    });
    return context;
}

// 1. HÀM CHECK ACCOUNT CẢI TIẾN (Dùng selector an toàn hơn)
async function checkAccount() {
    log("🔍 Kiểm tra profile Luffy...");
    let page = null;
    try {
        const ctx = await initBrowser(false);
        page = await ctx.newPage();
        await page.goto('https://www.binance.com/vi/square/profile/moncey_d_luffy', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000);

        // Đừng dùng css-1o8m8j nữa, dùng heading cho chắc
        const nameNode = await page.getByRole('heading').first();
        const name = await nameNode.innerText().catch(() => "N/A");
        
        if (name !== "N/A") {
            userInfo = { name: name.trim(), followers: "Đã cập nhật", status: "Sẵn sàng ✅" };
            log(`✅ OK: ${name}`);
        } else {
            userInfo.status = "Cần Login";
        }
    } catch (e) {
        log(`❌ Check lỗi: ${e.message.split('\n')[0]}`);
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

// 2. HÀM ĐĂNG BÀI CẢI TIẾN
async function postTask() {
    if (!isRunning) return;
    let page = null;
    try {
        const ctx = await initBrowser(false);
        page = await ctx.newPage();
        
        log("🌍 Đang vào Square...");
        await page.goto('https://www.binance.com/vi/square', { waitUntil: 'networkidle', timeout: 60000 });

        // Tìm ô nhập liệu bằng role cho chuyên nghiệp
        const textbox = await page.getByRole('textbox').or(page.locator('div[contenteditable="true"]')).first();
        await textbox.waitFor({ state: 'visible', timeout: 30000 });
        
        if (textbox) {
            const coin = TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)];
            const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}USDT`);
            const content = `📊 $${coin} Signal: ${parseFloat(res.data.priceChangePercent) >= 0 ? "LONG 🟢" : "SHORT 🔴"}\n💰 Price: ${res.data.lastPrice}\n#BinanceSquare #$${coin}`;
            
            await textbox.focus();
            await page.keyboard.type(content, { delay: 50 });
            await page.waitForTimeout(2000);
            
            await page.getByRole('button', { name: /Đăng|Post/ }).click();
            
            log(`🎉 Đã đăng bài $${coin}`);
            totalPosts++;
            history.unshift({ coin, time: new Date().toLocaleTimeString(), status: 'Thành công' });
        }
    } catch (e) {
        log(`❌ Lỗi Post: ${e.message.split('\n')[0]}`);
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

// 3. VÒNG LẶP VÔ TẬN AN TOÀN (Thay thế setInterval)
async function startAutoLoop() {
    while (isRunning) {
        await postTask();
        log("😴 Nghỉ 15 phút...");
        // Nghỉ 15 phút bằng Promise để không bao giờ bị chồng chéo task
        for (let i = 0; i < 900 && isRunning; i++) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

// --- API ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));

app.get('/login', async (req, res) => {
    log("🔑 Mở Login...");
    if (context) { await context.close().catch(() => {}); context = null; }
    const ctx = await initBrowser(true);
    const p = await ctx.newPage();
    await p.goto('https://www.binance.com/vi/square');
    res.send("ĐÃ MỞ CHROME. Đăng nhập xong hãy ĐÓNG Chrome đó lại rồi bấm START.");
});

app.get('/check', async (req, res) => {
    await checkAccount();
    res.json(userInfo);
});

app.get('/start', (req, res) => {
    if (!isRunning) {
        isRunning = true;
        log("🏁 KÍCH HOẠT AUTO");
        startAutoLoop(); // Chạy vòng lặp ngầm
    }
    res.json({ status: 'started' });
});

app.get('/stop', async (req, res) => {
    log("🛑 DỪNG BOT");
    isRunning = false;
    if (context) { await context.close().catch(() => {}); context = null; }
    res.json({ status: 'stopped' });
});

app.listen(port, '0.0.0.0', () => log(`SERVER LIVE TẠI PORT ${port}`));
