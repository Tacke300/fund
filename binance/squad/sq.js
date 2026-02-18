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

// --- BƯỚC 1: GIỮ NGUYÊN BẢN CŨ CỦA BẠN ---
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
    context.setDefaultTimeout(60000);
    return context;
}

// --- BƯỚC 2: TỐI ƯU TÌM KIẾM & ĐĂNG BÀI (10 CÁCH) ---

async function findTextbox(page) {
    logStep("🔍 Đang quét 10 phương thức tìm ô nhập liệu...");
    
    const selectors = [
        'div[role="textbox"]',                                 // 1. Chuẩn ARIA
        'div[contenteditable="true"]',                         // 2. Thuộc tính soạn thảo
        '.public-DraftEditor-content',                        // 3. Draft.js (Phổ biến ở Binance)
        'textarea[placeholder*="đang nghĩ gì"]',               // 4. Placeholder VN
        'textarea[placeholder*="mind"]',                      // 5. Placeholder EN
        '[data-testid="rich-text-editor"]',                    // 6. Test ID
        '.css-18t94o4 div[contenteditable]',                  // 7. Cấu trúc CSS cụ thể
        'div[aria-label*="nội dung"]',                         // 8. Label VN
        'div[aria-label*="content"]',                          // 9. Label EN
        'div.notranslate.public-DraftEditor-content'           // 10. Class cụ thể của editor
    ];

    for (let i = 0; i < selectors.length; i++) {
        try {
            const el = await page.locator(selectors[i]).first();
            if (await el.isVisible()) {
                logStep(`🎯 Đã tìm thấy ô nhập liệu bằng cách ${i + 1}: (${selectors[i]})`);
                return el;
            }
        } catch (e) {
            continue;
        }
    }
    return null;
}

async function ensureMainPage() {
    const ctx = await initBrowser(false);
    if (!mainPage || mainPage.isClosed()) {
        mainPage = await ctx.newPage();
        logStep("🌍 Đang mở Binance Square...");
        await mainPage.goto('https://www.binance.com/vi/square', { waitUntil: 'domcontentloaded' });
    }
    return mainPage;
}

async function postTaskWithForce() {
    if (!isRunning) return;
    
    try {
        const page = await ensureMainPage();
        logStep("🚀 Kiểm tra trang để bắt đầu đăng bài...");

        const textbox = await findTextbox(page);
        
        if (!textbox) {
            logStep("⚠️ Không thấy ô nhập bài. Thử reload nhẹ trang...");
            await page.reload({ waitUntil: 'domcontentloaded' });
            throw new Error("Không tìm thấy textbox sau khi quét 10 cách");
        }

        // Lấy dữ liệu coin
        const coin = TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)];
        const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}USDT`);
        const content = `📊 $${coin} Signal: ${parseFloat(res.data.priceChangePercent) >= 0 ? "LONG 🟢" : "SHORT 🔴"}\n💰 Giá: ${parseFloat(res.data.lastPrice)}\n#BinanceSquare #$${coin}`;

        logStep(`📝 Đang nhập nội dung bài đăng $${coin}...`);
        await textbox.click();
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await page.keyboard.type(content, { delay: 30 });
        
        await page.waitForTimeout(2000);
        
        logStep("🔘 Đang tìm nút Đăng...");
        const postBtn = await page.locator('button:has-text("Đăng"), button:has-text("Post"), .css-1q6p6u8').first();
        
        if (await postBtn.isEnabled()) {
            await postBtn.click();
            logStep(`🎉 THÀNH CÔNG: Đã đăng bài $${coin}`);
            totalPosts++;
            history.unshift({ coin, time: new Date().toLocaleTimeString(), status: 'Thành công' });
        } else {
            throw new Error("Nút Đăng bị vô hiệu hóa (có thể do trùng bài hoặc nội dung ngắn)");
        }

    } catch (err) {
        logStep(`❌ Lỗi chi tiết: ${err.message}`);
        // Chụp ảnh lỗi để debug nếu cần
        if (mainPage) await mainPage.screenshot({ path: `log_error_${Date.now()}.png` }).catch(()=>{});
        logStep("🔄 Sẽ thử lại sau 30 giây...");
        await new Promise(r => setTimeout(r, 30000));
        return await postTaskWithForce(); // Đệ quy: Retry đến khi thành công
    }
}

async function startLoop() {
    while (isRunning) {
        await postTaskWithForce();
        logStep("⏳ Nghỉ 15 phút trước khi đăng bài tiếp theo...");
        for (let i = 0; i < 900 && isRunning; i++) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

// --- GIỮ NGUYÊN API ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));

app.get('/login', async (req, res) => {
    if (context) { await context.close().catch(() => {}); context = null; }
    const ctx = await initBrowser(true);
    const p = await ctx.newPage();
    await p.goto('https://www.binance.com/vi/square');
    res.send("ĐÃ MỞ CHROME. Đăng nhập xong hãy TẮT Chrome.");
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
    if (!isRunning) {
        isRunning = true;
        logStep("🏁 BẮT ĐẦU BOT");
        startLoop();
    }
    res.json({ status: 'started' });
});

app.get('/stop', async (req, res) => {
    isRunning = false;
    logStep("🛑 DỪNG BOT");
    if (context) { await context.close().catch(() => {}); context = null; }
    mainPage = null;
    res.json({ status: 'stopped' });
});

app.listen(port, '0.0.0.0', () => logStep(`SERVER LIVE: ${port}`));
