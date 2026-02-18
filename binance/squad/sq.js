import { chromium as playwrightChromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Cấu hình Stealth cho Playwright (Dùng bản của Puppeteer để chống crash)
const chromium = playwrightChromium;
chromium.use(stealthPlugin());

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
let mainPage = null; // Giữ 1 trang duy nhất để không reload

function logStep(message) {
    console.log(`[${new Date().toLocaleTimeString()}] ➡️ ${message}`);
}

// KHỞI TẠO BROWSER
async function initBrowser(show = false) {
    if (context) {
        try { await context.pages(); return context; } catch (e) { context = null; }
    }
    context = await chromium.launchPersistentContext(userDataDir, {
        headless: !show,
        channel: 'chrome', 
        viewport: { width: 1366, height: 768 },
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    });
    return context;
}

// ĐẢM BẢO TRANG SQUARE LUÔN MỞ (KHÔNG RELOAD)
async function ensureMainPage() {
    const ctx = await initBrowser(false);
    if (!mainPage || mainPage.isClosed()) {
        mainPage = await ctx.newPage();
        logStep("🌍 Đang tải Binance Square lần đầu...");
        await mainPage.goto('https://www.binance.com/vi/square', { waitUntil: 'domcontentloaded', timeout: 180000 });
        await mainPage.waitForTimeout(5000);
    }
    return mainPage;
}

// HÀM ĐĂNG BÀI ĐƠN LẺ
async function postOnce() {
    const page = await ensureMainPage();
    const coin = TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)];
    const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}USDT`);
    const content = `📊 $${coin} Signal: ${parseFloat(res.data.priceChangePercent) >= 0 ? "LONG 🟢" : "SHORT 🔴"}\n💰 Giá: ${parseFloat(res.data.lastPrice)}\n#BinanceSquare #$${coin}`;

    logStep(`✍️ Soạn bài cho $${coin}...`);

    // Tìm ô nhập liệu (Selector linh hoạt)
    const textbox = await page.waitForSelector('div[role="textbox"], div[contenteditable="true"]', { timeout: 60000 });
    
    await textbox.click();
    // Xóa nội dung cũ nếu có
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    
    // Gõ nội dung như người thật
    await page.keyboard.type(content, { delay: 30 });
    await page.waitForTimeout(2000);

    // Bấm nút Đăng
    const postBtn = await page.locator('button:has-text("Đăng"), button:has-text("Post")').first();
    await postBtn.click();

    logStep(`🎉 ĐÃ BẤM POST $${coin}`);
    totalPosts++;
    history.unshift({ coin, time: new Date().toLocaleTimeString(), status: 'Thành công' });
}

// HÀM ÉP BUỘC ĐĂNG (RETRY VÔ HẠN)
async function postWithForce() {
    while (isRunning) {
        try {
            await postOnce();
            return; // Thành công thì thoát hàm này để về loop chính
        } catch (err) {
            logStep(`❌ LỖI ĐĂNG BÀI: ${err.message}`);
            if (mainPage) {
                const shotPath = `error_${Date.now()}.png`;
                await mainPage.screenshot({ path: shotPath }).catch(() => {});
                logStep(`📸 Đã chụp ảnh lỗi: ${shotPath}`);
                logStep(`📍 URL hiện tại: ${mainPage.url()}`);
            }
            logStep("🔄 Thử lại sau 15 giây...");
            await new Promise(r => setTimeout(r, 15000));
        }
    }
}

// VÒNG LẶP CHÍNH (3 PHÚT ĐẦU, 1 PHÚT SAU)
async function startLoop() {
    logStep("⏳ Chế độ chờ: 3 phút trước khi bắt đầu bài đầu tiên...");
    for (let i = 0; i < 180 && isRunning; i++) {
        await new Promise(r => setTimeout(r, 1000));
    }

    while (isRunning) {
        await postWithForce();

        logStep("⏳ Nghỉ 1 phút trước khi đăng bài tiếp theo...");
        for (let i = 0; i < 60 && isRunning; i++) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

// API ROUTES
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));

app.get('/login', async (req, res) => {
    logStep("🔑 Mở trình duyệt Login...");
    if (context) { await context.close().catch(() => {}); context = null; }
    const ctx = await initBrowser(true);
    const page = await ctx.newPage();
    await page.goto('https://www.binance.com/vi/square');
    res.send("ĐÃ MỞ CHROME. Đăng nhập xong hãy TẮT Chrome đi.");
});

app.get('/start', (req, res) => {
    if (!isRunning) {
        isRunning = true;
        logStep("🏁 KÍCH HOẠT BOT");
        startLoop();
    }
    res.json({ status: 'started' });
});

app.get('/stop', async (req, res) => {
    isRunning = false;
    logStep("🛑 DỪNG BOT");
    if (context) { await context.close().catch(() => {}); context = null; }
    mainPage = null;
    res.json({ status: 'stopped' });
});

app.get('/check', async (req, res) => {
    logStep("🔍 Kiểm tra profile...");
    try {
        const ctx = await initBrowser(false);
        const page = await ctx.newPage();
        await page.goto('https://www.binance.com/vi/square/profile/moncey_d_luffy', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(5000);
        const name = await page.locator('h1').first().innerText().catch(() => "N/A");
        userInfo = { name, status: name !== "N/A" ? "Sẵn sàng ✅" : "Cần Login" };
        await page.close();
    } catch (e) { logStep("Check fail"); }
    res.json(userInfo);
});

app.listen(port, '0.0.0.0', () => logStep(`SERVER LIVE TẠI ${port}`));
