import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-stealth';
import express from 'express';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

// Kích hoạt Stealth để chống Binance chặn
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
let userInfo = { name: "Chưa kiểm tra", followers: "0", status: "Offline" };
let mainTimer = null;

// Hàm mở trình duyệt ngụy trang
async function getBrowserContext(isHeadless) {
    return await chromium.launchPersistentContext(userDataDir, {
        headless: isHeadless,
        channel: 'chrome', 
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ],
        viewport: { width: 1280, height: 800 }
    });
}

// --- HÀM KIỂM TRA TÀI KHOẢN & FOLLOWERS ---
async function checkAccount() {
    let context;
    try {
        context = await getBrowserContext(true);
        const page = await context.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        
        await page.goto('https://www.binance.com/vi/square/profile/me', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(5000);

        // Lấy tên hiển thị
        const nameText = await page.locator('div[class*="css-1o8m8j"]').first().innerText().catch(() => "N/A");
        // Lấy số followers (tìm text có chữ người theo dõi)
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
        userInfo.status = "Lỗi kết nối";
        return false;
    } finally {
        if (context) await context.close();
    }
}

// --- HÀM ĐĂNG BÀI TỰ ĐỘNG ---
async function postTask() {
    if (!isRunning) return;
    let context;
    try {
        context = await getBrowserContext(true);
        const page = await context.newPage();
        await page.goto('https://www.binance.com/vi/square', { waitUntil: 'networkidle', timeout: 60000 });

        const editorSelector = 'div[role="textbox"]';
        await page.waitForSelector(editorSelector, { timeout: 30000 });

        const coin = TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)];
        const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}USDT`);
        const p = parseFloat(res.data.lastPrice);
        
        const content = `📊 Square Update: $${coin}\n💰 Giá: ${p}\n📈 Biến động: ${res.data.priceChangePercent}%\n#$${coin} #BinanceSquare #Trading`;

        await page.fill(editorSelector, content);
        await page.waitForTimeout(2000);
        await page.click('button:has-text("Đăng")');
        await page.waitForTimeout(4000);

        totalPosts++;
        history.unshift({ coin, time: new Date().toLocaleTimeString(), status: 'Thành công' });
    } catch (err) {
        console.log("Lỗi đăng bài:", err.message);
    } finally {
        if (context) await context.close();
    }
}

// --- ROUTES ĐIỀU KHIỂN ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));

app.get('/login', async (req, res) => {
    const context = await getBrowserContext(false);
    const page = await context.newPage();
    await page.goto('https://www.binance.com/vi/square');
    res.send("ĐÃ MỞ TRÌNH DUYỆT TRÊN MÁY TÍNH. Đăng nhập xong hãy ĐÓNG Chrome lại.");
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

app.listen(port, '0.0.0.0', () => console.log(`🚀 Bot Full chạy tại: http://localhost:${port}`));
