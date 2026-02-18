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

// --- HÀM LOG CÓ THỜI GIAN ---
function logStep(message) {
    const time = new Date().toLocaleTimeString();
    console.log(`[${time}] ➡️ ${message}`);
}

async function initBrowser(show) {
    if (context) return context;
    logStep("Khởi tạo trình duyệt mới...");
    context = await chromium.launchPersistentContext(userDataDir, {
        headless: !show,
        viewport: { width: 1280, height: 800 },
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    });
    return context;
}

// --- HÀM KIỂM TRA TÀI KHOẢN (ĐÃ SỬA LINK) ---
async function checkAccount() {
    logStep("Bắt đầu kiểm tra tài khoản...");
    try {
        const ctx = await initBrowser(false);
        const page = await ctx.newPage();
        
        // Thay /me bằng link trực tiếp của bạn
        const profileUrl = 'https://www.binance.com/vi/square/profile/moncey_d_luffy';
        logStep(`Truy cập: ${profileUrl}`);
        
        await page.goto(profileUrl, { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(5000);
        
        const name = await page.locator('div[class*="css-1o8m8j"]').first().innerText().catch(() => "N/A");
        const follow = await page.locator('div:has-text("Người theo dõi")').last().innerText().catch(() => "0");
        
        if (name !== "N/A") {
            userInfo = { name, followers: follow.replace("Người theo dõi", "").trim(), status: "Sẵn sàng ✅" };
            logStep(`Thành công: Tìm thấy User ${name}`);
        } else {
            userInfo.status = "Không tìm thấy thông tin (404/Login?)";
            logStep("Thất bại: Không lấy được tên User.");
        }
        await page.close();
    } catch (e) {
        logStep(`Lỗi checkAccount: ${e.message}`);
        userInfo.status = "Lỗi kết nối";
    }
}

// --- HÀM ĐĂNG BÀI VỚI RETRY 3 LẦN ---
async function postTaskWithRetry(retries = 3) {
    if (!isRunning) return;

    for (let i = 1; i <= retries; i++) {
        logStep(`Thử đăng bài lần ${i}/${retries}...`);
        try {
            const ctx = await initBrowser(false);
            const page = await ctx.newPage();
            
            logStep("Đang tải Binance Square (chờ 30s)...");
            await page.goto('https://www.binance.com/vi/square', { waitUntil: 'networkidle', timeout: 60000 });
            await page.waitForTimeout(5000); // Chờ thêm cho chắc

            logStep("Tìm ô nhập liệu...");
            await page.waitForSelector('div[role="textbox"]', { timeout: 30000 });
            
            const coin = TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)];
            const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}USDT`);
            const side = parseFloat(res.data.priceChangePercent) >= 0 ? "LONG 🟢" : "SHORT 🔴";
            const content = `📊 $${coin} Signal: ${side}\n💰 Giá: ${parseFloat(res.data.lastPrice)}\n#BinanceSquare #$${coin}`;
            
            await page.fill('div[role="textbox"]', content);
            await page.waitForTimeout(2000);
            await page.click('button:has-text("Đăng")');
            logStep("Đã nhấn nút Đăng. Chờ xác nhận...");
            await page.waitForTimeout(5000);
            
            totalPosts++;
            history.unshift({ coin, time: new Date().toLocaleTimeString(), status: 'Thành công' });
            logStep(`✅ Đăng bài $${coin} thành công!`);
            await page.close();
            return; // Thoát nếu thành công

        } catch (err) {
            logStep(`❌ Lỗi lần ${i}: ${err.message}`);
            if (i < retries) {
                logStep("Chờ 30s để thử lại...");
                await new Promise(res => setTimeout(res, 30000));
            } else {
                logStep("Đã thử 3 lần đều thất bại. Bỏ qua lượt này.");
                history.unshift({ coin: 'N/A', time: new Date().toLocaleTimeString(), status: 'Thất bại' });
            }
        }
    }
}

// --- API ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));

app.get('/login', async (req, res) => {
    logStep("Mở trình duyệt cho người dùng Login...");
    if (context) { await context.close(); context = null; }
    const ctx = await initBrowser(true);
    const page = await ctx.newPage();
    await page.goto('https://www.binance.com/vi/square');
    res.send("Trình duyệt đã mở. Đăng nhập xong KHÔNG ĐƯỢC ĐÓNG.");
});

app.get('/check', async (req, res) => {
    await checkAccount();
    res.json(userInfo);
});

app.get('/start', (req, res) => {
    if (!isRunning) {
        logStep("BẮT ĐẦU CHẠY BOT TỰ ĐỘNG (15p/lần)");
        isRunning = true;
        postTaskWithRetry();
        postInterval = setInterval(postTaskWithRetry, 15 * 60 * 1000);
    }
    res.json({ status: 'started' });
});

app.get('/stop', async (req, res) => {
    logStep("DỪNG BOT...");
    isRunning = false;
    if (postInterval) clearInterval(postInterval);
    if (context) {
        await context.close().catch(() => {});
        context = null;
    }
    logStep("Bot đã dừng và đóng trình duyệt.");
    res.json({ status: 'stopped' });
});

app.listen(port, '0.0.0.0', () => {
    console.clear();
    console.log("==========================================");
    console.log(`🚀 SERVER KHỞI TẠO THÀNH CÔNG CỔNG: ${port}`);
    console.log(`🔗 Link: http://localhost:${port}`);
    console.log("==========================================");
});
