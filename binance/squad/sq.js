import { chromium as playwrightChromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import fs from 'fs';

// CẤU HÌNH STEALTH CHUẨN (Fix lỗi Wrong Package)
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

function logStep(message) {
    console.log(`[${new Date().toLocaleTimeString()}] ➡️ ${message}`);
}

// KHỞI TẠO BROWSER (Giữ nguyên tham số của bạn)
async function initBrowser(show = false) {
    if (context) {
        try { await context.pages(); return context; } catch (e) { context = null; }
    }
    logStep(show ? "Mở Chrome hiện hình..." : "Khởi tạo trình duyệt ngầm...");
    
    context = await chromium.launchPersistentContext(userDataDir, {
        headless: !show,
        viewport: { width: 1280, height: 800 },
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-dev-shm-usage'
        ]
    });
    context.setDefaultTimeout(180000);
    return context;
}

// --- GIỮ NGUYÊN TOÀN BỘ LOGIC CỦA BẠN (CHECK ACCOUNT) ---
async function checkAccount() {
    logStep("🔍 Đang kiểm tra profile Luffy...");
    let page = null;
    try {
        const ctx = await initBrowser(false);
        page = await ctx.newPage();
        await page.goto('https://www.binance.com/vi/square/profile/moncey_d_luffy', { waitUntil: 'domcontentloaded', timeout: 180000 });
        await page.waitForTimeout(10000);

        const nameNode = await page.locator('h1, div[class*="css-1o8m8j"], div[class*="name"]').first();
        const name = await nameNode.innerText().catch(() => "N/A");
        const follow = await page.locator('div:has-text("Người theo dõi")').last().innerText().catch(() => "0");
        
        if (name !== "N/A" && name !== "") {
            userInfo = { name: name.trim(), followers: follow.replace("Người theo dõi", "").trim(), status: "Sẵn sàng ✅" };
            logStep(`✅ OK: ${name}`);
        } else {
            userInfo.status = "Cần Login";
        }
    } catch (e) {
        logStep(`❌ Lỗi Check: ${e.message}`);
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

// --- GIỮ NGUYÊN LOGIC ĐĂNG BÀI + RETRY ---
async function postTaskWithRetry(retries = 3) {
    if (!isRunning) return;
    for (let i = 1; i <= retries; i++) {
        logStep(`🚀 THỬ ĐĂNG BÀI LẦN ${i}/${retries}...`);
        let page = null;
        try {
            const ctx = await initBrowser(false);
            page = await ctx.newPage();
            await page.goto('https://www.binance.com/vi/square', { waitUntil: 'load', timeout: 180000 });

            const textbox = await page.waitForSelector('div[role="textbox"], .public-DraftEditor-content, div[contenteditable="true"]', { state: 'visible', timeout: 60000 });
            
            if (textbox) {
                const coin = TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)];
                const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}USDT`);
                const content = `📊 $${coin} Signal: ${parseFloat(res.data.priceChangePercent) >= 0 ? "LONG 🟢" : "SHORT 🔴"}\n💰 Giá: ${parseFloat(res.data.lastPrice)}\n#BinanceSquare #$${coin}`;
                
                await textbox.click();
                await page.keyboard.type(content, { delay: 50 });
                await page.waitForTimeout(3000);
                await page.click('button:has-text("Đăng"), button:has-text("Post")');
                
                logStep(`🎉 THÀNH CÔNG: $${coin}`);
                totalPosts++;
                history.unshift({ coin, time: new Date().toLocaleTimeString(), status: 'Thành công' });
                return;
            }
        } catch (err) {
            logStep(`❌ Thất bại lần ${i}`);
            if (i === retries) history.unshift({ coin: 'Lỗi', time: new Date().toLocaleTimeString(), status: 'Timeout' });
            await new Promise(res => setTimeout(res, 30000));
        } finally {
            if (page) await page.close().catch(() => {});
        }
    }
}

async function startLoop() {
    while (isRunning) {
        await postTaskWithRetry();
        for (let i = 0; i < 900 && isRunning; i++) await new Promise(r => setTimeout(r, 1000));
    }
}

// --- API ROUTES (Giữ nguyên) ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));

app.get('/login', async (req, res) => {
    if (context) { await context.close().catch(() => {}); context = null; }
    const ctx = await initBrowser(true);
    const p = await ctx.newPage();
    await p.goto('https://www.binance.com/vi/square');
    res.send("ĐÃ MỞ CHROME. Đăng nhập xong hãy TẮT Chrome.");
});

app.get('/check', async (req, res) => { await checkAccount(); res.json(userInfo); });

app.get('/start', (req, res) => {
    if (!isRunning) { isRunning = true; logStep("🏁 BẮT ĐẦU BOT"); startLoop(); }
    res.json({ status: 'started' });
});

app.get('/stop', async (req, res) => {
    isRunning = false; logStep("🛑 DỪNG BOT");
    if (context) { await context.close().catch(() => {}); context = null; }
    res.json({ status: 'stopped' });
});

app.listen(port, '0.0.0.0', () => logStep(`SERVER LIVE: ${port}`));
