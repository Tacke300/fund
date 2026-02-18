import { chromium as playwrightChromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

const chromium = playwrightChromium;
chromium.use(stealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = 9999;
const userDataDir = path.join(__dirname, 'bot_session_final');

let isRunning = false;
let totalPosts = 0;
let history = [];
let userInfo = { name: "Chưa kiểm tra", status: "Offline" };
let context = null;
let mainPage = null;
let coinQueue = [];

function logStep(message) {
    console.log(`[${new Date().toLocaleTimeString()}] ➡️ ${message}`);
}

// --- LẤY COIN FUTURES ---
async function refreshCoinQueue() {
    try {
        logStep("📊 Lấy danh sách Futures (Sắp xếp giá Cao -> Thấp)...");
        const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price');
        coinQueue = res.data
            .filter(c => c.symbol.endsWith('USDT'))
            .map(c => ({ symbol: c.symbol.replace('USDT', ''), price: parseFloat(c.price) }))
            .sort((a, b) => b.price - a.price);
        logStep(`✅ Đã nạp ${coinQueue.length} coin.`);
    } catch (e) {
        logStep("❌ Lỗi API: " + e.message);
    }
}

// --- TẠO NỘI DUNG PHÂN TÁCH DÒNG ---
function generateFinalContent(coin, price, change) {
    const entry = parseFloat(price);
    const isUp = parseFloat(change) >= 0;
    const tp1 = isUp ? entry * 1.03 : entry * 0.97;
    const tp2 = isUp ? entry * 1.08 : entry * 0.92;
    const sl = isUp ? entry * 0.95 : entry * 1.05;

    // Chọn ngẫu nhiên 2 coin khác từ hàng đợi để làm tag
    const randomCoins = coinQueue
        .filter(c => c.symbol !== coin)
        .sort(() => 0.5 - Math.random())
        .slice(0, 2)
        .map(c => `$${c.symbol}`);

    const body = `🔥 PHÂN TÍCH THỊ TRƯỜNG: ${coin}\n\n` +
                 `Thị trường đang có những phản ứng đáng chú ý tại vùng giá hiện tại. Với mức biến động ${change}% trong 24h qua, cấu trúc giá đang dần hình thành vùng thanh khoản quan trọng.\n\n` +
                 `📍 ENTRY: ${entry.toFixed(4)}\n` +
                 `🎯 TP1: ${tp1.toFixed(4)}\n` +
                 `🎯 TP2: ${tp2.toFixed(4)}\n` +
                 `🛡 SL: ${sl.toFixed(4)}\n\n` +
                 `Lưu ý: Đây là nhận định cá nhân dựa trên phân tích kỹ thuật, anh em hãy luôn quản lý vốn chặt chẽ và cài đặt SL đầy đủ trước khi vào lệnh.`;

    return {
        body,
        tags: [`$${coin}`, ...randomCoins],
        hashes: [`#${coin}`, `#BinanceSquare`, `#CryptoAnalysis`]
    };
}

async function initBrowser(show = false) {
    if (context) {
        try { await context.pages(); return context; } catch (e) { context = null; }
    }
    context = await chromium.launchPersistentContext(userDataDir, {
        headless: !show,
        viewport: { width: 1280, height: 800 },
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    });
    return context;
}

async function ensureMainPage() {
    const ctx = await initBrowser(false);
    if (!mainPage || mainPage.isClosed()) {
        mainPage = await ctx.newPage();
        await mainPage.goto('https://www.binance.com/vi/square', { waitUntil: 'domcontentloaded' });
        await mainPage.waitForTimeout(30000);
    }
    return mainPage;
}

async function postTaskWithForce() {
    if (!isRunning) return;
    if (coinQueue.length === 0) await refreshCoinQueue();
    
    const currentCoin = coinQueue.shift();
    if (!currentCoin) return;

    let page; // Định nghĩa biến page ở đây để catch có thể dùng
    try {
        page = await ensureMainPage();
        
        // Lấy dữ liệu 24h
        const ticker = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${currentCoin.symbol}USDT`);
        const content = generateFinalContent(currentCoin.symbol, ticker.data.lastPrice, ticker.data.priceChangePercent);

        const textbox = await page.locator('div[contenteditable="true"], div[role="textbox"]').first();
        if (!(await textbox.isVisible())) {
            logStep("⏳ Đợi ô soạn thảo (30s)...");
            await page.waitForTimeout(30000);
        }

        logStep(`🖱 Soạn bài cho $${currentCoin.symbol}. Đợi 5s...`);
        await textbox.click();
        await page.waitForTimeout(5000);

        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');

        // Gõ nội dung
        await page.keyboard.type(content.body + "\n\n", { delay: 5 });

        // Gõ Tags $
        for (const t of content.tags) {
            await page.keyboard.type(t, { delay: 10 });
            await page.waitForTimeout(1500);
            await page.keyboard.press('Enter');
            await page.keyboard.type(' ', { delay: 5 });
        }

        // Gõ Hashes #
        for (const h of content.hashes) {
            await page.keyboard.type("\n" + h, { delay: 10 });
            await page.waitForTimeout(1500);
            await page.keyboard.press('Enter');
            await page.keyboard.type('   ', { delay: 5 });
        }

        await page.waitForTimeout(8000);

        // Click nút Đăng của bài viết
        const postBtn = await page.locator('button').filter({ hasText: /^Đăng$|^Post$/ }).last();
        if (await postBtn.isEnabled()) {
            await postBtn.click();
            logStep(`🎯 Đã bấm Đăng $${currentCoin.symbol}.`);
            await page.waitForTimeout(15000);

            if ((await page.content()).includes(currentCoin.symbol)) {
                logStep(`✅ THÀNH CÔNG: $${currentCoin.symbol}`);
                totalPosts++;
                history.unshift({ coin: currentCoin.symbol, time: new Date().toLocaleTimeString(), status: 'Thành công' });
                return;
            }
        }
        throw new Error("Không xác nhận được bài đăng");

    } catch (err) {
        logStep(`❌ LỖI: ${err.message}`);
        if (page) await page.screenshot({ path: `err_${Date.now()}.png` }).catch(()=>{});
        logStep("🔄 Thử lại sau 20s...");
        await new Promise(r => setTimeout(r, 20000));
        // Đưa coin lỗi vào lại hàng đợi để không bỏ sót
        if (currentCoin) coinQueue.push(currentCoin);
    }
}

async function startLoop() {
    while (isRunning) {
        await postTaskWithForce();
        if (isRunning) {
            logStep("😴 Nghỉ 1 phút...");
            for (let i = 0; i < 60 && isRunning; i++) await new Promise(r => setTimeout(r, 1000));
        }
    }
}

// --- API ---
app.get('/start', (req, res) => {
    if (!isRunning) { isRunning = true; logStep("🏁 KHỞI CHẠY"); startLoop(); }
    res.json({ status: 'started' });
});

app.get('/stop', async (req, res) => {
    isRunning = false; logStep("🛑 DỪNG");
    if (context) { await context.close().catch(() => {}); context = null; }
    mainPage = null;
    res.json({ status: 'stopped' });
});

app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));

app.get('/login', async (req, res) => {
    if (context) { await context.close(); context = null; }
    const ctx = await initBrowser(true);
    const p = await ctx.newPage();
    await p.goto('https://www.binance.com/vi/square');
    res.send("Đã mở Chrome.");
});

app.get('/', (req, res) => res.send("Bot is running. Check /stats"));

app.listen(port, '0.0.0.0', () => logStep(`SERVER LIVE: ${port}`));
