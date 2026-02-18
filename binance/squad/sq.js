import { chromium as playwrightChromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import fs from 'fs';

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
let mainPage = null; 

function logStep(message) {
    console.log(`[${new Date().toLocaleTimeString()}] ➡️ ${message}`);
}

// --- KHỞI TẠO BROWSER ---
async function initBrowser(show = false) {
    if (context) {
        try { await context.pages(); return context; } catch (e) { context = null; }
    }
    context = await chromium.launchPersistentContext(userDataDir, {
        headless: !show,
        viewport: { width: 1280, height: 800 },
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    });
    context.setDefaultTimeout(60000);
    return context;
}

// --- HÀM TẠO NỘI DUNG PHÂN TÍCH CHUYÊN SÂU ---
function generateSignal(coin, price, change) {
    const isUp = parseFloat(change) >= 0;
    const side = isUp ? "LONG 🟢" : "SHORT 🔴";
    const trend = isUp ? "đang tích lũy tăng mạnh" : "đang chịu áp lực xả";
    
    // Tính toán Entry/TP/SL giả lập dựa trên giá hiện tại
    const entry = parseFloat(price);
    const tp = isUp ? entry * 1.05 : entry * 0.95; // 5% profit
    const sl = isUp ? entry * 0.97 : entry * 1.03; // 3% stop loss

    return `🔥 PHÂN TÍCH NHANH: $${coin}
    
📊 Nhận định: Thị trường ${trend} trong khung 24h qua với biến động ${change}%.
    
🚀 Tín hiệu: ${side}
📍 Entry: ${entry.toFixed(4)}
🎯 TP: ${tp.toFixed(4)}
🛡 SL: ${sl.toFixed(4)}

💡 Tin tức: Dòng tiền đang đổ vào các Altcoin top đầu, $${coin} có dấu hiệu phá vỡ vùng kháng cự ngắn hạn. Anh em chú ý quản lý vốn!

$${coin} $BTC $BNB
#Binance #CryptoNews #TradingSignal`;
}

async function findTextbox(page) {
    const selectors = ['div[contenteditable="true"]', 'div[role="textbox"]', '.public-DraftEditor-content'];
    for (let s of selectors) {
        const el = await page.locator(s).first();
        if (await el.isVisible()) return el;
    }
    return null;
}

async function ensureMainPage() {
    const ctx = await initBrowser(false);
    if (!mainPage || mainPage.isClosed()) {
        mainPage = await ctx.newPage();
        logStep("🌍 Mở Binance Square...");
        await mainPage.goto('https://www.binance.com/vi/square', { waitUntil: 'domcontentloaded' });
        await mainPage.waitForTimeout(5000);
    }
    return mainPage;
}

async function postTaskWithForce() {
    if (!isRunning) return;
    
    try {
        const page = await ensureMainPage();
        const textbox = await findTextbox(page);
        
        if (!textbox) {
            logStep("⚠️ Không thấy ô nhập. Reload...");
            await page.reload();
            throw new Error("Không thấy textbox");
        }

        // Lấy dữ liệu thật từ API
        const coin = TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)];
        const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}USDT`);
        const content = generateSignal(coin, res.data.lastPrice, res.data.priceChangePercent);

        logStep(`📝 Đang soạn bài phân tích $${coin}...`);
        await textbox.click();
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(1500);
        
        // TỐC ĐỘ GÕ NHANH (delay 10ms)
        await page.keyboard.type(content, { delay: 10 });
        
        // CHỜ LÂU HƠN SAU KHI GÕ (8 giây) để giống người đang đọc lại bài
        logStep("⏳ Đã gõ xong. Đang ngâm bài 8s trước khi đăng...");
        await page.waitForTimeout(8000);

        logStep("🔘 Bấm nút Đăng...");
        const postBtn = await page.locator('button:has-text("Đăng"), button:has-text("Post")').filter({ hasNotText: 'đăng bài' }).first();
        
        if (await postBtn.isVisible()) {
            await postBtn.click();
            logStep("⏳ Đã bấm. Chờ 15s kiểm tra...");
            await page.waitForTimeout(15000);

            const newContent = await page.content();
            if (newContent.includes(`$${coin}`)) {
                logStep(`🎉 THÀNH CÔNG: Bài đăng $${coin} đã lên sàn!`);
                totalPosts++;
                history.unshift({ coin, time: new Date().toLocaleTimeString(), status: 'Thành công' });
            } else {
                throw new Error("Không thấy bài đăng sau khi bấm nút.");
            }
        } else {
            throw new Error("Nút Đăng bị ẩn.");
        }

    } catch (err) {
        logStep(`❌ LỖI: ${err.message}`);
        if (mainPage) await mainPage.screenshot({ path: `error_${Date.now()}.png` }).catch(()=>{});
        logStep("🔄 Thử lại sau 20 giây...");
        await new Promise(r => setTimeout(r, 20000));
        return await postTaskWithForce(); 
    }
}

async function startLoop() {
    while (isRunning) {
        await postTaskWithForce();
        logStep("⏳ Nghỉ 1 phút (60s) theo yêu cầu...");
        for (let i = 0; i < 60 && isRunning; i++) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

// --- CÁC ROUTE API GIỮ NGUYÊN ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));
app.get('/login', async (req, res) => {
    if (context) { await context.close().catch(() => {}); context = null; }
    const ctx = await initBrowser(true);
    const p = await ctx.newPage();
    await p.goto('https://www.binance.com/vi/square');
    res.send("ĐÃ MỞ CHROME. Hãy đăng nhập xong rồi TẮT Chrome.");
});
app.get('/check', async (req, res) => {
    logStep("🔍 Đang kiểm tra profile...");
    try {
        const ctx = await initBrowser(false);
        const page = await ctx.newPage();
        await page.goto('https://www.binance.com/vi/square/profile/moncey_d_luffy', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(5000);
        const name = await page.locator('h1, div[class*="css-1o8m8j"]').first().innerText().catch(() => "N/A");
        userInfo = { name, status: name !== "N/A" ? "Sẵn sàng ✅" : "Cần Login" };
        await page.close();
    } catch (e) { logStep("Check fail"); }
    res.json(userInfo);
});
app.get('/start', (req, res) => {
    if (!isRunning) { isRunning = true; logStep("🏁 BẮT ĐẦU BOT"); startLoop(); }
    res.json({ status: 'started' });
});
app.get('/stop', async (req, res) => {
    isRunning = false; logStep("🛑 DỪNG BOT");
    if (context) { await context.close().catch(() => {}); context = null; }
    mainPage = null;
    res.json({ status: 'stopped' });
});

app.listen(port, '0.0.0.0', () => logStep(`SERVER LIVE: ${port}`));
