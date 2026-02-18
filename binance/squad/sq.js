import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-stealth';
import express from 'express';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

chromium.use(stealth());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = 9999;
const userDataDir = path.join(__dirname, 'binance_session');

const TOP_COINS = ["BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "AVAX", "DOGE", "DOT", "LINK", "MATIC", "NEAR"];

let isRunning = false;
let totalPosts = 0;
let history = [];
let userInfo = { name: "Chưa kiểm tra", followers: 0, status: "Offline" };
let mainTimer = null;

// Hàm mở trình duyệt (Dùng chung cho cả Login và Check)
async function getBrowserContext(isHeadless) {
    return await chromium.launchPersistentContext(userDataDir, {
        headless: isHeadless,
        channel: 'chrome', // Sử dụng Chrome thật trên máy thay vì Chromium bản thiếu
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox'
        ],
        viewport: { width: 1280, height: 800 }
    });
}

// --- HÀM KIỂM TRA TÀI KHOẢN ---
async function checkAccount() {
    let context;
    try {
        context = await getBrowserContext(true);
        const page = await context.newPage();
        // Giả lập User Agent người dùng thật
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        
        await page.goto('https://www.binance.com/vi/square/profile/me', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(5000);

        // Lấy tên Profile
        const nameText = await page.locator('div[class*="css-1o8m8j"]').first().innerText().catch(() => "N/A");
        
        if (nameText !== "N/A" && nameText.length > 0) {
            userInfo = { name: nameText, followers: "Đã xác thực", status: "Đã đăng nhập ✅" };
            return true;
        } else {
            userInfo.status = "Chưa đăng nhập hoặc bị chặn";
            return false;
        }
    } catch (e) {
        userInfo.status = "Lỗi: " + e.message;
        return false;
    } finally {
        if (context) await context.close();
    }
}

// --- HÀM ĐĂNG BÀI ---
async function postTask() {
    if (!isRunning) return;
    let context;
    try {
        context = await getBrowserContext(true);
        const page = await context.newPage();
        await page.goto('https://www.binance.com/vi/square', { waitUntil: 'networkidle', timeout: 60000 });

        const editorSelector = 'div[role="textbox"]';
        await page.waitForSelector(editorSelector, { timeout: 30000 });

        const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)]}USDT`);
        const p = parseFloat(res.data.lastPrice);
        
        const content = `📊 Phân tích nhanh: $${res.data.symbol}\nGiá hiện tại: ${p}\nXu hướng: ${parseFloat(res.data.priceChangePercent) > 0 ? "Tăng 🟢" : "Giảm 🔴"}\n#TradingSignal #BinanceSquare`;

        await page.fill(editorSelector, content);
        await page.waitForTimeout(2000);
        await page.click('button:has-text("Đăng")');
        await page.waitForTimeout(4000);

        totalPosts++;
        history.unshift({ coin: res.data.symbol, time: new Date().toLocaleTimeString(), status: 'Thành công' });
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
    // Mở Chrome thật để đăng nhập
    const context = await getBrowserContext(false);
    const page = await context.newPage();
    await page.goto('https://www.binance.com/vi/square', { timeout: 0 });
    // Không đóng context ở đây để người dùng tự đóng sau khi đăng nhập xong
    res.send("Đang mở trình duyệt. Hãy đăng nhập rồi ĐÓNG trình duyệt lại.");
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

app.listen(port, () => console.log(`🚀 Bot Square: http://localhost:${port}`));
