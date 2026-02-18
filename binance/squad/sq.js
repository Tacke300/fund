import { chromium } from 'playwright';
import express from 'express';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = 9999;
const userDataDir = path.join(__dirname, 'binance_session');

// Danh sách 12 coin bạn cần
const TOP_COINS = ["BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "AVAX", "DOGE", "DOT", "LINK", "MATIC", "NEAR"];

let isRunning = false;
let totalPosts = 0;
let history = [];
let userInfo = { name: "Chưa kiểm tra", followers: "0", status: "Offline" };
let mainTimer = null;

// --- HÀM CHIẾM QUYỀN TRÌNH DUYỆT (TỰ KILL CHROME TREO) ---
function forceClearSession() {
    try {
        // Giết sạch các tiến trình Chrome đang chiếm folder session
        execSync('taskkill /F /IM chrome.exe /T', { stdio: 'ignore' });
    } catch (e) {}
    
    // Xóa file lock để tránh lỗi "Profile in use"
    const lockFile = path.join(userDataDir, 'SingletonLock');
    if (fs.existsSync(lockFile)) {
        try { fs.unlinkSync(lockFile); } catch (e) {}
    }
}

async function getBrowserContext(isHeadless) {
    forceClearSession(); // Luôn dọn dẹp trước khi mở
    return await chromium.launchPersistentContext(userDataDir, {
        headless: isHeadless,
        channel: 'chrome',
        viewport: { width: 1280, height: 800 },
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-dev-shm-usage'
        ]
    });
}

// --- HÀM KIỂM TRA TÀI KHOẢN (ĐẦY ĐỦ TÊN & FOLLOWERS) ---
async function checkAccount() {
    let context;
    try {
        context = await getBrowserContext(true);
        const page = await context.newPage();
        await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
        
        await page.goto('https://www.binance.com/vi/square/profile/me', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000);

        const nameText = await page.locator('div[class*="css-1o8m8j"]').first().innerText().catch(() => "N/A");
        const followText = await page.locator('div:has-text("Người theo dõi")').last().innerText().catch(() => "0");
        
        if (nameText !== "N/A") {
            userInfo = { 
                name: nameText, 
                followers: followText.replace("Người theo dõi", "").trim(), 
                status: "Đã đăng nhập ✅" 
            };
            return true;
        }
        userInfo.status = "Chưa đăng nhập";
        return false;
    } catch (e) {
        userInfo.status = "Lỗi: " + e.message;
        return false;
    } finally {
        if (context) await context.close();
    }
}

// --- HÀM PHÂN TÍCH & ĐĂNG BÀI (FULL 12 COIN + SIGNAL) ---
async function postTask() {
    if (!isRunning) return;
    let context;
    try {
        context = await getBrowserContext(true);
        const page = await context.newPage();
        await page.goto('https://www.binance.com/vi/square', { waitUntil: 'domcontentloaded' });
        
        await page.waitForSelector('div[role="textbox"]', { timeout: 30000 });

        const coin = TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)];
        const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}USDT`);
        
        const price = parseFloat(res.data.lastPrice);
        const change = parseFloat(res.data.priceChangePercent);
        const side = change >= 0 ? "LONG 🟢" : "SHORT 🔴";
        
        const content = `📊 PHÂN TÍCH NHANH: $${coin}\n\n💡 Tín hiệu: ${side}\n💵 Giá hiện tại: ${price}\n📈 Biến động 24h: ${change}%\n\n#${coin} #BinanceSquare #TradingSignals`;

        await page.fill('div[role="textbox"]', content);
        await page.waitForTimeout(2000);
        await page.click('button:has-text("Đăng")');
        await page.waitForTimeout(5000);

        totalPosts++;
        history.unshift({ coin, time: new Date().toLocaleTimeString(), status: 'Thành công' });
        console.log(`✅ Đã đăng bài cho $${coin}`);
    } catch (err) {
        console.log("❌ Lỗi đăng bài:", err.message);
    } finally {
        if (context) await context.close();
    }
}

// --- API ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));

app.get('/login', async (req, res) => {
    const context = await getBrowserContext(false);
    const page = await context.newPage();
    await page.goto('https://www.binance.com/vi/square');
    res.send("ĐÃ MỞ CHROME. Đăng nhập xong bạn CỨ ĐỂ ĐÓ, khi bấm Check hoặc Start bot sẽ tự dọn dẹp.");
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

app.listen(port, '0.0.0.0', () => console.log(`🚀 Bot Full Chức Năng chạy tại: http://localhost:${port}`));
