import { chromium as playwrightChromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import fs from 'fs';

// --- CẤU HÌNH BƯỚC 1: GIỮ NGUYÊN SỰ ỔN ĐỊNH ---
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
let userInfo = { name: "Chưa kiểm tra", status: "Offline" };
let context = null;
let mainPage = null;

function logStep(message) {
    console.log(`[${new Date().toLocaleTimeString()}] ➡️ ${message}`);
}

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

// --- BƯỚC 2: TỐI ƯU NHẬP LIỆU & TÌM TEXTBOX ---

async function findTextbox(page) {
    const selectors = [
        'div[contenteditable="true"]', 
        'div[role="textbox"]', 
        '.public-DraftEditor-content',
        'div.notranslate.public-DraftEditor-content'
    ];
    for (let s of selectors) {
        try {
            const el = await page.locator(s).first();
            if (await el.isVisible()) return el;
        } catch (e) {}
    }
    return null;
}

// Hàm gõ nội dung: Tốc độ nhanh, xử lý Tag $, chờ 5s sau khi click
async function typeSmartContent(page, textbox, coin, price, change) {
    const isUp = parseFloat(change) >= 0;
    const side = isUp ? "LONG 🟢" : "SHORT 🔴";
    
    const header = `🔥 PHÂN TÍCH NHANH: $${coin}\n\n📊 Biến động 24h: ${change}%\n🚀 Tín hiệu: ${side}\n📍 Entry: ${parseFloat(price).toFixed(4)}\n\n💡 Nhận định: Xu hướng đang khá rõ nét, anh em chú ý quản lý vốn chặt chẽ.\n\n`;
    
    logStep("🖱 Đã chọn ô text. Đợi 5s cho ổn định rồi mới nhập...");
    await textbox.click();
    await page.waitForTimeout(5000); // Đợi 5s sau khi click theo yêu cầu

    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(1000);
    
    // Gõ nội dung chính (Nhanh)
    await page.keyboard.type(header, { delay: 5 });

    // Gõ Tag $ (Gõ xong đợi 1.5s rồi Enter để khớp Suggestion của Binance)
    const tags = [`$${coin}`, `$BTC`, `$BNB`];
    for (const tag of tags) {
        await page.keyboard.type(tag, { delay: 20 });
        logStep(`⏳ Chờ gợi ý cho ${tag}...`);
        await page.waitForTimeout(1500); 
        await page.keyboard.press('Enter'); 
        await page.keyboard.type(' ', { delay: 10 }); // Gõ thêm dấu cách sau khi Enter tag
    }

    // Hashtag cuối
    await page.keyboard.type(`\n#Binance #CryptoNews #TradingSignal`, { delay: 10 });
}

async function ensureMainPage() {
    const ctx = await initBrowser(false);
    if (!mainPage || mainPage.isClosed()) {
        mainPage = await ctx.newPage();
        logStep("🌍 Đang truy cập Binance Square...");
        await mainPage.goto('https://www.binance.com/vi/square', { waitUntil: 'domcontentloaded', timeout: 120000 });
        logStep("⏳ Chờ 30s cho trang load toàn bộ script...");
        await mainPage.waitForTimeout(30000);
    }
    return mainPage;
}

async function postTaskWithForce() {
    if (!isRunning) return;
    let failCount = 0;

    while (isRunning) {
        try {
            const page = await ensureMainPage();
            let textbox = await findTextbox(page);

            // Đợi 30s nếu chưa thấy ô nhập (tối đa 3 lần = 90s)
            while (!textbox && failCount < 3) {
                failCount++;
                logStep(`⏳ Không thấy ô nhập, chờ 30s (Lần ${failCount}/3)...`);
                await page.waitForTimeout(30000);
                textbox = await findTextbox(page);
            }

            if (!textbox) {
                logStep("⚠️ Quá 90s không thấy ô nhập. Reload trang...");
                await page.reload({ waitUntil: 'domcontentloaded' });
                failCount = 0;
                throw new Error("Reload trang do không tìm thấy textbox");
            }

            const coin = TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)];
            const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}USDT`);
            
            logStep(`🚀 Bắt đầu quy trình đăng bài $${coin}...`);
            await typeSmartContent(page, textbox, coin, res.data.lastPrice, res.data.priceChangePercent);
            
            logStep("⏳ Đã gõ xong. Ngâm bài 10s trước khi bấm nút...");
            await page.waitForTimeout(10000);

            // Tìm nút Đăng chuẩn (Lọc bỏ nút hướng dẫn)
            const postBtn = await page.locator('button').filter({ hasText: /^Đăng$|^Post$/ }).first();
            
            if (await postBtn.isVisible() && await postBtn.isEnabled()) {
                await postBtn.click();
                logStep("🎯 Đã bấm Đăng. Chờ 15s xác nhận...");
                await page.waitForTimeout(15000);

                const contentCheck = await page.content();
                if (contentCheck.includes(coin)) {
                    logStep(`🎉 THÀNH CÔNG RỰC RỠ: Bài $${coin} đã lên sàn!`);
                    totalPosts++;
                    history.unshift({ coin, time: new Date().toLocaleTimeString(), status: 'Thành công' });
                    return; // Thành công thì thoát ra để nghỉ 1 phút
                } else {
                    throw new Error("Bấm nút rồi nhưng không thấy bài trong mã nguồn");
                }
            } else {
                throw new Error("Nút Đăng không bấm được (Disabled/Hidden)");
            }

        } catch (err) {
            logStep(`❌ LỖI: ${err.message}`);
            if (mainPage) await mainPage.screenshot({ path: `error_${Date.now()}.png` }).catch(()=>{});
            logStep("🔄 Đang chuẩn bị thử lại sau 20s...");
            await new Promise(r => setTimeout(r, 20000));
        }
    }
}

async function startLoop() {
    while (isRunning) {
        await postTaskWithForce();
        logStep("😴 Nghỉ 1 phút (60s) chuẩn bị bài tiếp theo...");
        for (let i = 0; i < 60 && isRunning; i++) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

// --- API ROUTES ---

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));

app.get('/login', async (req, res) => {
    logStep("🔑 Mở trình duyệt để đăng nhập thủ công...");
    if (context) { await context.close().catch(() => {}); context = null; }
    const ctx = await initBrowser(true);
    const p = await ctx.newPage();
    await p.goto('https://www.binance.com/vi/square');
    res.send("Đã mở Chrome hiện hình. Đăng nhập xong hãy TẮT trình duyệt để Bot chạy ngầm.");
});

app.get('/start', (req, res) => {
    if (!isRunning) {
        isRunning = true;
        logStep("🏁 KÍCH HOẠT HỆ THỐNG");
        startLoop();
    }
    res.json({ status: 'started' });
});

app.get('/stop', async (req, res) => {
    isRunning = false;
    logStep("🛑 DỪNG HỆ THỐNG");
    if (context) { await context.close().catch(() => {}); context = null; }
    mainPage = null;
    res.json({ status: 'stopped' });
});

app.get('/check', async (req, res) => {
    logStep("🔍 Kiểm tra tài khoản...");
    try {
        const ctx = await initBrowser(false);
        const page = await ctx.newPage();
        await page.goto('https://www.binance.com/vi/square/profile/moncey_d_luffy', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(5000);
        const name = await page.locator('h1, div[class*="css-1o8m8j"]').first().innerText().catch(() => "N/A");
        userInfo = { name, status: name !== "N/A" ? "Sẵn sàng ✅" : "Cần Login" };
        await page.close();
    } catch (e) { logStep("Lỗi check profile"); }
    res.json(userInfo);
});

app.listen(port, '0.0.0.0', () => {
    logStep(`SERVER LIVE TẠI PORT ${port}`);
});
