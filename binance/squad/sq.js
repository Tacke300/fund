import playwright from 'playwright-extra';
import StealthPlugin from 'playwright-extra-plugin-stealth';
import express from 'express';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Kích hoạt Stealth đúng chuẩn cho Playwright (Sửa lỗi crash exitCode)
playwright.use(StealthPlugin());
const { chromium } = playwright;

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
    const time = new Date().toLocaleTimeString();
    console.log(`[${time}] ➡️ ${message}`);
}

// Khởi tạo trình duyệt - Giữ nguyên tham số của bạn
async function initBrowser(show = false) {
    if (context) {
        try {
            await context.pages();
            return context;
        } catch (e) {
            context = null; 
        }
    }
    logStep(show ? "Mở Chrome hiện hình để Login..." : "Khởi tạo trình duyệt ngầm...");
    context = await chromium.launchPersistentContext(userDataDir, {
        headless: !show,
        viewport: { width: 1280, height: 800 },
        args: [
            '--disable-blink-features=AutomationControlled', 
            '--no-sandbox',
            '--disable-dev-shm-usage'
        ]
    });
    context.setDefaultTimeout(180000); // 3 phút
    return context;
}

// --- CHECK ACCOUNT (Giữ nguyên logic Luffy của bạn) ---
async function checkAccount() {
    logStep("🔍 Bắt đầu kiểm tra tài khoản Luffy...");
    let page = null;
    try {
        const ctx = await initBrowser(false);
        page = await ctx.newPage();
        const profileUrl = 'https://www.binance.com/vi/square/profile/moncey_d_luffy';
        
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 180000 });
        await page.waitForTimeout(10000);

        // Selector linh hoạt kết hợp cả class cũ và role
        const nameNode = await page.locator('h1, div[class*="css-1o8m8j"], div[class*="name"]').first();
        const name = await nameNode.innerText().catch(() => "N/A");
        const follow = await page.locator('div:has-text("Người theo dõi")').last().innerText().catch(() => "0");
        
        if (name !== "N/A" && name !== "") {
            userInfo = { name: name.trim(), followers: follow.replace("Người theo dõi", "").trim(), status: "Sẵn sàng ✅" };
            logStep(`✅ Tìm thấy: ${name} (${userInfo.followers} followers)`);
        } else {
            userInfo.status = "Cần Đăng Nhập";
            logStep("⚠️ Không lấy được tên.");
        }
    } catch (e) {
        logStep(`❌ Lỗi Check: ${e.message}`);
        userInfo.status = "Lỗi mạng/Timeout";
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

// --- POST TASK (Retry 3 lần - Giữ nguyên logic của bạn) ---
async function postTaskWithRetry(retries = 3) {
    if (!isRunning) return;

    for (let i = 1; i <= retries; i++) {
        logStep(`🚀 THỬ ĐĂNG BÀI LẦN ${i}/${retries}...`);
        let page = null;
        try {
            const ctx = await initBrowser(false);
            page = await ctx.newPage();
            
            await page.goto('https://www.binance.com/vi/square', { waitUntil: 'load', timeout: 180000 });

            // Tìm ô nhập liệu (Sử dụng danh sách selector bạn đã viết)
            const textbox = await page.waitForSelector('div[role="textbox"], .public-DraftEditor-content, div[contenteditable="true"]', { state: 'visible', timeout: 60000 });
            
            if (textbox) {
                const coin = TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)];
                const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}USDT`);
                const side = parseFloat(res.data.priceChangePercent) >= 0 ? "LONG 🟢" : "SHORT 🔴";
                const content = `📊 $${coin} Signal: ${side}\n💰 Giá: ${parseFloat(res.data.lastPrice)}\n#BinanceSquare #$${coin}`;
                
                await textbox.click();
                await page.keyboard.type(content, { delay: 50 });
                await page.waitForTimeout(3000);
                
                await page.click('button:has-text("Đăng"), button:has-text("Post")');
                logStep("Đã bấm 'Đăng'. Chờ xác nhận...");
                await page.waitForTimeout(10000);
                
                totalPosts++;
                history.unshift({ coin, time: new Date().toLocaleTimeString(), status: 'Thành công' });
                logStep(`🎉 THÀNH CÔNG: $${coin}`);
                return; // Thoát vòng lặp retry
            }
        } catch (err) {
            logStep(`❌ Thất bại lần ${i}: ${err.message.split('\n')[0]}`);
            if (i === retries) {
                history.unshift({ coin: 'Lỗi', time: new Date().toLocaleTimeString(), status: 'Timeout' });
            }
            await page?.close().catch(() => {});
            await new Promise(res => setTimeout(res, 30000));
        } finally {
            if (page) await page.close().catch(() => {});
        }
    }
}

// Vòng lặp Loop (Thay thế setInterval để tránh đè task khi retry lâu)
async function startLoop() {
    while (isRunning) {
        await postTaskWithRetry();
        logStep("😴 Nghỉ 15 phút...");
        for (let i = 0; i < 900 && isRunning; i++) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

// --- API ROUTES (Đầy đủ) ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));

app.get('/login', async (req, res) => {
    logStep("🔑 Mở cửa sổ Login...");
    if (context) { await context.close().catch(() => {}); context = null; }
    const ctx = await initBrowser(true);
    const page = await ctx.newPage();
    await page.goto('https://www.binance.com/vi/square', { timeout: 0 });
    res.send("ĐÃ MỞ CHROME. Hãy đăng nhập xong rồi TẮT Chrome đi.");
});

app.get('/check', async (req, res) => {
    await checkAccount();
    res.json(userInfo);
});

app.get('/start', (req, res) => {
    if (!isRunning) {
        logStep("🏁 BẮT ĐẦU BOT");
        isRunning = true;
        startLoop();
    }
    res.json({ status: 'started' });
});

app.get('/stop', async (req, res) => {
    logStep("🛑 DỪNG BOT");
    isRunning = false;
    if (context) { await context.close().catch(() => {}); context = null; }
    res.json({ status: 'stopped' });
});

app.listen(port, '0.0.0.0', () => {
    logStep(`SERVER LIVE TẠI PORT ${port}`);
});
