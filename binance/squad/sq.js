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

let isRunning = false;
let totalPosts = 0;
let history = [];
let userInfo = { name: "Chưa kiểm tra", status: "Offline" };
let context = null;
let mainPage = null;
let coinQueue = []; // Hàng đợi coin để đăng lần lượt

function logStep(message) {
    console.log(`[${new Date().toLocaleTimeString()}] ➡️ ${message}`);
}

// --- LẤY DANH SÁCH COIN FUTURES VÀ SẮP XẾP GIÁ ---
async function refreshCoinQueue() {
    try {
        logStep("📊 Đang lấy danh sách coin Futures và sắp xếp theo giá...");
        const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price');
        // Lọc USDT và sắp xếp giá từ cao tới thấp
        coinQueue = res.data
            .filter(c => c.symbol.endsWith('USDT'))
            .map(c => ({ symbol: c.symbol.replace('USDT', ''), price: parseFloat(c.price) }))
            .sort((a, b) => b.price - a.price);
        
        logStep(`✅ Đã nạp ${coinQueue.length} coin vào hàng đợi.`);
    } catch (e) {
        logStep("❌ Lỗi lấy danh sách coin: " + e.message);
    }
}

// --- TẠO NỘI DUNG MẠCH LẠC ---
function generateFinalContent(coin, price, change) {
    const entry = parseFloat(price);
    const isUp = parseFloat(change) >= 0;
    const tp1 = isUp ? entry * 1.03 : entry * 0.97;
    const tp2 = isUp ? entry * 1.08 : entry * 0.92;
    const sl = isUp ? entry * 0.95 : entry * 1.05;

    const body = `Thị trường Crypto hôm nay chứng kiến biến động đáng chú ý của $${coin}. Dựa trên dữ liệu phân tích kỹ thuật, chúng ta thấy mức thay đổi ${change}% trong 24 giờ qua đang tạo ra một vùng thanh khoản tiềm năng. Nếu anh em đang quan sát các khung thời gian ngắn, có thể cân nhắc một chiến lược giao dịch với các mốc cụ thể: Vùng Entry đẹp quanh mức ${entry.toFixed(4)}, mục tiêu kỳ vọng TP1 tại ${tp1.toFixed(4)} và TP2 xa hơn tại ${tp2.toFixed(4)}. Để bảo vệ tài khoản, điểm dừng lỗ SL nên đặt tại ${sl.toFixed(4)}. Luôn ghi nhớ thị trường luôn tiềm ẩn rủi ro, hãy đi volume hợp lý.`;

    return {
        body,
        tags: [`$${coin}`, `$BTC`, `$BNB`],
        hashes: [`#${coin}`, `#BinanceSquare`, `#CryptoAnalysis`]
    };
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
    return context;
}

// --- NHẬP LIỆU: VĂN BẢN TRƯỚC -> TAG SAU ---
async function typeSmartContent(page, textbox, coinData) {
    const { body, tags, hashes } = generateFinalContent(coinData.symbol, coinData.price, coinData.change);
    
    logStep(`🖱 Chọn ô text. Đợi 5s...`);
    await textbox.click();
    await page.waitForTimeout(5000);

    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');

    // 1. Gõ mạch văn bản trước
    await page.keyboard.type(body + "\n\n", { delay: 5 });

    // 2. Gõ 3 thẻ $
    for (const t of tags) {
        await page.keyboard.type(t, { delay: 10 });
        await page.waitForTimeout(1500);
        await page.keyboard.press('Enter');
        await page.keyboard.type(' ', { delay: 5 });
    }

    // 3. Gõ 3 thẻ #
    for (const h of hashes) {
        await page.keyboard.type("\n" + h, { delay: 10 });
        await page.waitForTimeout(1500);
        await page.keyboard.press('Enter');
        await page.keyboard.type('   ', { delay: 5 }); // 3 dấu cách đóng menu
    }
    logStep("✅ Hoàn tất soạn thảo.");
}

async function postTaskWithForce() {
    if (!isRunning) return;
    if (coinQueue.length === 0) await refreshCoinQueue();
    
    const currentCoin = coinQueue.shift(); // Lấy con đầu tiên (giá cao nhất)
    if (!currentCoin) return;

    while (isRunning) {
        try {
            const page = await ensureMainPage();
            // Lấy thêm % thay đổi 24h
            const ticker = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${currentCoin.symbol}USDT`);
            currentCoin.change = ticker.data.priceChangePercent;
            currentCoin.price = ticker.data.lastPrice;

            const textbox = await page.locator('div[contenteditable="true"], div[role="textbox"]').first();
            if (!(await textbox.isVisible())) {
                logStep("⏳ Đợi ô soạn thảo hiện ra (30s)...");
                await page.waitForTimeout(30000);
            }

            await typeSmartContent(page, textbox, currentCoin);
            await page.waitForTimeout(5000);

            // --- FIX NÚT ĐĂNG: TÌM NÚT TRONG KHU VỰC SOẠN THẢO ---
            logStep("🔘 Đang tìm đúng nút Đăng của bài viết...");
            const postBtn = await page.locator('button').filter({ hasText: /^Đăng$|^Post$/ }).last(); 
            // Thường nút Đăng ở thanh trên là cái đầu tiên, nút ở ô soạn thảo là cái cuối cùng hiện ra

            if (await postBtn.isEnabled()) {
                await postBtn.click();
                logStep(`🎉 Đã bấm Đăng cho $${currentCoin.symbol}. Chờ check...`);
                await page.waitForTimeout(15000);

                if ((await page.content()).includes(currentCoin.symbol)) {
                    logStep(`✅ THÀNH CÔNG: $${currentCoin.symbol} đã lên.`);
                    totalPosts++;
                    history.unshift({ coin: currentCoin.symbol, time: new Date().toLocaleTimeString(), status: 'Thành công' });
                    return; 
                }
            }
            throw new Error("Không bấm được nút đăng hoặc bài chưa lên");

        } catch (err) {
            logStep(`❌ LỖI: ${err.message}. Thử lại sau 20s...`);
            await page.screenshot({ path: `err_${Date.now()}.png` }).catch(()=>{});
            await new Promise(r => setTimeout(r, 20000));
        }
    }
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

async function startLoop() {
    while (isRunning) {
        await postTaskWithForce();
        logStep("😴 Nghỉ 1 phút...");
        for (let i = 0; i < 60 && isRunning; i++) await new Promise(r => setTimeout(r, 1000));
    }
}

// --- API ---
app.get('/start', (req, res) => {
    if (!isRunning) { isRunning = true; logStep("🏁 BẮT ĐẦU"); startLoop(); }
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
    res.send("Đã mở Chrome. Đăng nhập xong hãy TẮT nó.");
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(port, '0.0.0.0', () => logStep(`BOT LIVE: ${port}`));
