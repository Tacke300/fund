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
let postInterval = null;

function logStep(message) {
    const time = new Date().toLocaleTimeString();
    console.log(`[${time}] ➡️ ${message}`);
}

async function initBrowser(show) {
    if (context) return context;
    logStep("Khởi tạo trình duyệt...");
    context = await chromium.launchPersistentContext(userDataDir, {
        headless: !show,
        viewport: { width: 1280, height: 800 },
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    });
    // Tăng timeout mặc định lên 3 phút cho toàn bộ hành động
    context.setDefaultTimeout(180000); 
    return context;
}

// --- CHECK ACCOUNT (LINK LUFFY) ---
async function checkAccount() {
    logStep("🔍 Bắt đầu kiểm tra tài khoản Luffy...");
    try {
        const ctx = await initBrowser(false);
        const page = await ctx.newPage();
        const profileUrl = 'https://www.binance.com/vi/square/profile/moncey_d_luffy';
        
        logStep("Đang tải trang Profile (Chờ tối đa 3 phút)...");
        await page.goto(profileUrl, { waitUntil: 'networkidle', timeout: 180000 });
        
        // Chờ thêm một chút cho script render
        await page.waitForTimeout(10000);

        const name = await page.locator('div[class*="css-1o8m8j"]').first().innerText().catch(() => "N/A");
        const follow = await page.locator('div:has-text("Người theo dõi")').last().innerText().catch(() => "0");
        
        if (name !== "N/A" && name !== "") {
            userInfo = { name, followers: follow.replace("Người theo dõi", "").trim(), status: "Sẵn sàng ✅" };
            logStep(`✅ Tìm thấy: ${name} (${userInfo.followers} followers)`);
        } else {
            userInfo.status = "404 hoặc Chưa Đăng Nhập";
            logStep("⚠️ Không lấy được tên. Bạn đã đăng nhập ở mục Login chưa?");
        }
        await page.close();
    } catch (e) {
        logStep(`❌ Lỗi Check: ${e.message}`);
        userInfo.status = "Timeout/Lỗi mạng";
    }
}

// --- POST TASK (RETRY 3 LẦN, CHỜ 3 PHÚT) ---
async function postTaskWithRetry(retries = 3) {
    if (!isRunning) return;

    for (let i = 1; i <= retries; i++) {
        logStep(`🚀 THỬ ĐĂNG BÀI LẦN ${i}/${retries}...`);
        let page = null;
        try {
            const ctx = await initBrowser(false);
            page = await ctx.newPage();
            
            logStep("Đang vào Binance Square (Kiên nhẫn chờ 3 phút)...");
            await page.goto('https://www.binance.com/vi/square', { waitUntil: 'load', timeout: 180000 });

            logStep("Đang tìm ô nhập liệu (div[role='textbox'])...");
            // Tăng thời gian chờ selector lên 3 phút
            const textbox = await page.waitForSelector('div[role="textbox"]', { state: 'visible', timeout: 180000 });
            
            if (textbox) {
                logStep("🎯 Đã thấy ô nhập liệu! Đang lấy giá Coin...");
                const coin = TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)];
                const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}USDT`);
                const side = parseFloat(res.data.priceChangePercent) >= 0 ? "LONG 🟢" : "SHORT 🔴";
                const content = `📊 $${coin} Signal: ${side}\n💰 Giá: ${parseFloat(res.data.lastPrice)}\n#BinanceSquare #$${coin}`;
                
                await textbox.fill(content);
                await page.waitForTimeout(3000);
                await page.click('button:has-text("Đăng")');
                
                logStep("Đã bấm 'Đăng'. Chờ 10s xác nhận...");
                await page.waitForTimeout(10000);
                
                totalPosts++;
                history.unshift({ coin, time: new Date().toLocaleTimeString(), status: 'Thành công' });
                logStep(`🎉 THÀNH CÔNG: Đã đăng bài cho $${coin}`);
                await page.close();
                return; 
            }
        } catch (err) {
            logStep(`❌ Thất bại lần ${i}: ${err.message}`);
            if (page) await page.close().catch(() => {});
            
            if (i < retries) {
                logStep("Nghỉ 30s trước khi thử lại...");
                await new Promise(res => setTimeout(res, 30000));
            } else {
                logStep("☢️ Cả 3 lần đều lỗi. Dừng lượt này.");
                history.unshift({ coin: 'Lỗi', time: new Date().toLocaleTimeString(), status: 'Timeout' });
            }
        }
    }
}

// --- API ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));

app.get('/login', async (req, res) => {
    logStep("🔑 Mở cửa sổ Login...");
    if (context) { await context.close(); context = null; }
    const ctx = await initBrowser(true);
    const page = await ctx.newPage();
    await page.goto('https://www.binance.com/vi/square', { timeout: 0 });
    res.send("ĐÃ MỞ CHROME. Hãy đăng nhập và ĐỂ NGUYÊN ĐÓ, không được đóng.");
});

app.get('/check', async (req, res) => {
    await checkAccount();
    res.json(userInfo);
});

app.get('/start', (req, res) => {
    if (!isRunning) {
        logStep("🏁 BẮT ĐẦU BOT");
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
    if (context) {
        await context.close().catch(() => {});
        context = null;
    }
    res.json({ status: 'stopped' });
});

app.listen(port, '0.0.0.0', () => {
    console.log("==========================================");
    logStep(`SERVER LIVE TẠI CỔNG ${port}`);
    console.log("==========================================");
});
