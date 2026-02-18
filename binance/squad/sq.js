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
let context = null;
let mainPage = null; 

function logStep(message) {
    const time = new Date().toLocaleTimeString();
    console.log(`[${time}] ➡️ ${message}`);
}

// --- BƯỚC 1: GIỮ NGUYÊN BẢN CŨ CỦA BẠN ---
async function initBrowser(show) {
    if (context) return context;
    logStep("Khởi tạo trình duyệt...");
    context = await chromium.launchPersistentContext(userDataDir, {
        headless: !show,
        viewport: { width: 1280, height: 800 },
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    });
    context.setDefaultTimeout(180000); 
    return context;
}

// --- BƯỚC 2: CẢI TIẾN LOGIC MỞ TRANG VÀ ĐỢI ---

async function ensureMainPage() {
    const ctx = await initBrowser(false);
    if (!mainPage || mainPage.isClosed()) {
        mainPage = await ctx.newPage();
        logStep("🌍 Đang mở trang Binance Square... (Sẽ mở ngay khi bạn bấm Start)");
        await mainPage.goto('https://www.binance.com/vi/square', { waitUntil: 'domcontentloaded', timeout: 180000 });
        await mainPage.waitForTimeout(5000); // Đợi 5s cho ổn định giao diện
    }
    return mainPage;
}

async function postOnce() {
    const page = await ensureMainPage();
    const coin = TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)];
    const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}USDT`);
    const side = parseFloat(res.data.priceChangePercent) >= 0 ? "LONG 🟢" : "SHORT 🔴";
    const content = `📊 $${coin} Signal: ${side}\n💰 Giá: ${parseFloat(res.data.lastPrice)}\n#BinanceSquare #$${coin}`;

    logStep(`✍️ Đang soạn nội dung cho bài $${coin}...`);
    const textbox = await page.waitForSelector('div[role="textbox"]', { state: 'visible', timeout: 60000 });
    
    await textbox.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(content, { delay: 50 });
    await page.waitForTimeout(2000);

    const postBtn = await page.locator('button:has-text("Đăng"), button:has-text("Post")').first();
    await postBtn.click();

    logStep(`🎉 ĐÃ ĐĂNG THÀNH CÔNG: $${coin}`);
    totalPosts++;
    history.unshift({ coin, time: new Date().toLocaleTimeString(), status: 'Thành công' });
}

async function postWithForce() {
    while (isRunning) {
        try {
            await postOnce();
            return; 
        } catch (err) {
            logStep(`❌ LỖI: ${err.message}`);
            if (mainPage) {
                const shotName = `error_${Date.now()}.png`;
                await mainPage.screenshot({ path: shotName }).catch(()=>{});
                logStep(`📸 Đã lưu ảnh lỗi: ${shotName}`);
            }
            logStep("🔄 Thử lại sau 10 giây...");
            await new Promise(r => setTimeout(r, 10000));
        }
    }
}

// LUỒNG CHẠY CHUẨN: MỞ TRANG TRƯỚC -> ĐỢI -> ĐĂNG
async function startLoop() {
    // 1. Mở trang ngay lập tức
    await ensureMainPage();
    
    // 2. Để trang đó mở và đợi 3 phút
    logStep("⏳ Đã mở Square. Đang treo trang đợi 3 phút (180s) cho 'giống người thật'...");
    for (let i = 180; i > 0 && isRunning; i--) {
        if (i % 30 === 0) logStep(`Còn ${i} giây nữa sẽ đăng bài đầu tiên...`);
        await new Promise(r => setTimeout(r, 1000));
    }

    // 3. Bắt đầu đăng bài
    while (isRunning) {
        await postWithForce();

        logStep("⏳ Nghỉ 1 phút (60s) trước bài tiếp theo...");
        for (let i = 0; i < 60 && isRunning; i++) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

// --- API ---

app.get('/start', (req, res) => {
    if (!isRunning) {
        isRunning = true;
        logStep("🏁 BẮT ĐẦU KÍCH HOẠT");
        startLoop(); // Gọi hàm chạy ngầm
    }
    res.json({ status: 'started' });
});

// Các API khác giữ nguyên như bản cũ của bạn...
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));
app.get('/stop', async (req, res) => {
    isRunning = false;
    logStep("🛑 DỪNG BOT");
    if (context) { await context.close().catch(() => {}); context = null; }
    mainPage = null;
    res.json({ status: 'stopped' });
});

app.listen(port, '0.0.0.0', () => logStep(`SERVER LIVE: ${port}`));
