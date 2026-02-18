import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import express from 'express';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import fs from 'fs';

chromium.use(stealth()); // Kích hoạt chế độ lách luật

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
let postInterval = null;

function logStep(message) {
    console.log(`[${new Date().toLocaleTimeString()}] ➡️ ${message}`);
}

// Hàm khởi tạo trình duyệt - MẶC ĐỊNH CHẠY ẨN (headless: true)
async function initBrowser(show = false) {
    if (context) return context;
    logStep(show ? "Mở trình duyệt (hiện hình) để Login..." : "Khởi tạo trình duyệt chạy ngầm...");
    context = await chromium.launchPersistentContext(userDataDir, {
        headless: !show, 
        channel: 'chrome', // Dùng Chrome thật trên máy để tăng độ tin cậy
        viewport: { width: 1366, height: 768 },
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-web-security'
        ]
    });
    return context;
}

// --- CHECK ACCOUNT (SỬA SELECTOR MỚI NHẤT) ---
async function checkAccount() {
    logStep("🔍 Đang kiểm tra profile...");
    try {
        const ctx = await initBrowser(false);
        const page = await ctx.newPage();
        await page.goto('https://www.binance.com/vi/square/profile/moncey_d_luffy', { waitUntil: 'domcontentloaded' });
        
        // Chờ selector tên xuất hiện (thử nhiều class khác nhau của Binance)
        const nameNode = await page.waitForSelector('div[class*="name"], h1, div[class*="css-1o8m8j"]', { timeout: 15000 }).catch(() => null);
        
        if (nameNode) {
            const name = await nameNode.innerText();
            userInfo = { name: name.trim(), followers: "Đã cập nhật", status: "Sẵn sàng ✅" };
            logStep(`✅ Đã nhận diện User: ${name}`);
        } else {
            userInfo.status = "Cần Login lại";
            logStep("⚠️ Không tìm thấy tên. Có thể session đã hết hạn.");
        }
        await page.close();
    } catch (e) {
        logStep(`❌ Lỗi Check: ${e.message}`);
    }
}

// --- POST TASK (NHANH VÀ KHÔNG TREO) ---
async function postTaskWithRetry() {
    if (!isRunning) return;
    logStep("🚀 Tiến trình đăng bài bắt đầu...");
    
    try {
        const ctx = await initBrowser(false);
        const page = await ctx.newPage();
        
        // Bước 1: Vào trang Square
        await page.goto('https://www.binance.com/vi/square', { waitUntil: 'networkidle' });

        // Bước 2: Tìm ô nhập liệu bằng nhiều cách (Selector linh hoạt)
        const selectors = [
            'div[role="textbox"]',
            '.public-DraftEditor-content',
            'div[contenteditable="true"]'
        ];
        
        let textbox = null;
        for (let s of selectors) {
            textbox = await page.$(s);
            if (textbox) break;
        }

        if (textbox) {
            logStep("🎯 Đã thấy ô nhập liệu. Đang soạn bài...");
            const coin = TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)];
            const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}USDT`);
            const content = `📊 $${coin} Signal: ${parseFloat(res.data.priceChangePercent) >= 0 ? "LONG 🟢" : "SHORT 🔴"}\n💰 Price: ${res.data.lastPrice}\n#BinanceSquare #$${coin}`;
            
            await textbox.focus();
            await page.keyboard.type(content, { delay: 50 }); // Gõ như người thật
            await page.waitForTimeout(2000);
            
            // Tìm nút Đăng
            const postBtn = await page.locator('button:has-text("Đăng"), button:has-text("Post")').first();
            await postBtn.click();
            
            logStep(`🎉 Thành công! Đã đăng bài $${coin}`);
            totalPosts++;
            history.unshift({ coin, time: new Date().toLocaleTimeString(), status: 'Thành công' });
        } else {
            logStep("❌ Không tìm thấy ô nhập liệu. Có thể do chưa Login.");
        }
        await page.close();
    } catch (err) {
        logStep(`❌ Lỗi tiến trình: ${err.message}`);
    }
}

// --- API ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));

app.get('/login', async (req, res) => {
    logStep("🔑 Đang mở trình duyệt hiện hình để bạn Login...");
    if (context) { await context.close(); context = null; }
    const ctx = await initBrowser(true); // show = true
    const page = await ctx.newPage();
    await page.goto('https://www.binance.com/vi/square');
    res.send("ĐÃ MỞ CHROME. Đăng nhập xong bạn có thể ĐÓNG CỬA SỔ CHROME đó lại. Bot sẽ tự chạy ngầm bằng cửa sổ khác.");
});

app.get('/check', async (req, res) => {
    await checkAccount();
    res.json(userInfo);
});

app.get('/start', (req, res) => {
    if (!isRunning) {
        logStep("🏁 KÍCH HOẠT CHẾ ĐỘ CHẠY NGẦM");
        isRunning = true;
        postTaskWithRetry();
        postInterval = setInterval(postTaskWithRetry, 15 * 60 * 1000);
    }
    res.json({ status: 'started' });
});

app.get('/stop', async (req, res) => {
    logStep("🛑 DỪNG BOT");
    isRunning = false;
    if (postInterval) clearInterval(postInterval);
    if (context) { await context.close().catch(() => {}); context = null; }
    res.json({ status: 'stopped' });
});

app.listen(port, '0.0.0.0', () => logStep(`SERVER LIVE TẠI ${port}`));
