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
const userDataDir = path.join(__dirname, 'bot_session'); // Sử dụng session riêng biệt

// --- DANH SÁCH 12 COIN CỦA BẠN ---
const TOP_COINS = ["BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "AVAX", "DOGE", "DOT", "LINK", "MATIC", "NEAR"];

let isRunning = false;
let totalPosts = 0;
let history = [];
let userInfo = { name: "Chưa kiểm tra", followers: 0, status: "Offline" };
let mainTimer = null;

// --- HÀM TỰ DỌN DẸP CHIẾM QUYỀN ---
function forceClearSession() {
    try {
        // Giết sạch Chrome treo để tránh lỗi exitCode=2147483651
        execSync('taskkill /F /IM chrome.exe /T', { stdio: 'ignore' });
    } catch (e) {}
    
    const lockFile = path.join(userDataDir, 'SingletonLock');
    if (fs.existsSync(lockFile)) {
        try { fs.unlinkSync(lockFile); } catch (e) {}
    }
}

async function getBrowserContext(isHeadless) {
    forceClearSession(); 
    return await chromium.launchPersistentContext(userDataDir, {
        headless: isHeadless,
        channel: 'chrome', // Dùng Chrome thật để Binance không nghi ngờ
        viewport: { width: 1280, height: 800 },
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-infobars'
        ]
    });
}

// --- HÀM KIỂM TRA TÀI KHOẢN (GIỮ NGUYÊN LOGIC CỦA BẠN) ---
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
        
        if (nameText !== "N/A" && nameText.length > 0) {
            userInfo = { 
                name: nameText, 
                followers: followText.replace("Người theo dõi", "").trim(), 
                status: "Đã đăng nhập ✅" 
            };
            return true;
        } else {
            userInfo.status = "Chưa đăng nhập";
            return false;
        }
    } catch (e) {
        userInfo.status = "Lỗi: " + e.message;
        return false;
    } finally {
        if (context) await context.close();
    }
}

// --- HÀM ĐĂNG BÀI (FULL 12 COIN + SIGNAL LONG/SHORT) ---
async function postTask() {
    if (!isRunning) return;
    let context;
    try {
        context = await getBrowserContext(true);
        const page = await context.newPage();
        await page.goto('https://www.binance.com/vi/square', { waitUntil: 'domcontentloaded', timeout: 60000 });

        const editorSelector = 'div[role="textbox"]';
        await page.waitForSelector(editorSelector, { timeout: 30000 });

        const coin = TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)];
        const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}USDT`);
        
        const p = parseFloat(res.data.lastPrice);
        const change = parseFloat(res.data.priceChangePercent);
        const side = change >= 0 ? "LONG 🟢" : "SHORT 🔴";
        
        const content = `📊 Phân tích nhanh: $${coin}\n💡 Tín hiệu: ${side}\n💵 Giá hiện tại: ${p}\n📈 Biến động: ${change}%\n#TradingSignal #BinanceSquare #$${coin}`;

        await page.fill(editorSelector, content);
        await page.waitForTimeout(2000);
        await page.click('button:has-text("Đăng")');
        await page.waitForTimeout(5000);

        totalPosts++;
        history.unshift({ coin: coin, time: new Date().toLocaleTimeString(), status: 'Thành công' });
    } catch (err) {
        console.error("Lỗi Post:", err.message);
    } finally {
        if (context) await context.close();
    }
}

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));

app.get('/login', async (req, res) => {
    const context = await getBrowserContext(false);
    const page = await context.newPage();
    await page.goto('https://www.binance.com/vi/square', { timeout: 0 });
    res.send("Đã mở Chrome. Đăng nhập xong bạn cứ để đó, bot sẽ tự dọn dẹp khi cần.");
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

app.listen(port, '0.0.0.0', () => console.log(`🚀 Bot Square chạy tại: http://localhost:${port}`));
