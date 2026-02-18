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
let userInfo = { name: "Chưa kiểm tra", status: "Offline" };
let context = null;
let mainPage = null;

function logStep(message) {
    console.log(`[${new Date().toLocaleTimeString()}] ➡️ ${message}`);
}

// --- HÀM TẠO NỘI DUNG BIẾN THIÊN (MỖI BÀI 1 KIỂU) ---
function generateRichContent(coin, price, change) {
    const entry = parseFloat(price);
    const isUp = parseFloat(change) >= 0;
    const tp1 = isUp ? entry * 1.03 : entry * 0.97;
    const tp2 = isUp ? entry * 1.07 : entry * 0.93;
    const sl = isUp ? entry * 0.96 : entry * 1.04;

    const templates = [
        `💎 [PHÂN TÍCH KỸ THUẬT $${coin}]\nNhận định: Cấu trúc nến đang cho thấy lực ${isUp ? 'MUA' : 'BÁN'} chiếm ưu thế.\n📍 ENTRY: ${entry.toFixed(4)}\n🎯 TP1: ${tp1.toFixed(4)}\n🎯 TP2: ${tp2.toFixed(4)}\n🛡 SL: ${sl.toFixed(4)}\nTin tức: Chỉ số Fear & Greed đang ở mức ổn định, thích hợp để lướt sóng ngắn hạn.`,
        
        `🔥 [TÍN HIỆU HOT $${coin}]\nDòng tiền lớn (Whale) đang có dấu hiệu ${isUp ? 'gom hàng' : 'xả hàng'} âm thầm trong 4h qua.\n📊 Xu hướng: ${isUp ? 'TĂNG MẠNH' : 'GIẢM ĐIỀU CHỈNH'}\n💹 Giá hiện tại: ${entry.toFixed(4)}\n🚀 Target kỳ vọng: ${tp2.toFixed(4)}\n🛑 Cắt lỗ tại: ${sl.toFixed(4)}\nLưu ý: Anh em nhớ cài SL đầy đủ để bảo vệ vốn!`,
        
        `📢 [TIN TỨC THỊ TRƯỜNG $${coin}]\nBiến động ${change}% trong 24h qua đang thu hút sự chú ý của các trader.\n💡 Chiến lược đề xuất: ${isUp ? 'Buy on Dip' : 'Sell on Rally'}\n💰 Entry: ${entry.toFixed(4)}\n💎 Chốt lời: ${tp1.toFixed(4)}\n⚠️ Cảnh báo: Thị trường đang chờ đợi tin tức từ CPI nên biên độ sẽ rất lớn.`,
        
        `⚡ [SCALPING NHANH $${coin}]\nKhung M15 đang cho tín hiệu ${isUp ? 'Bullish' : 'Bearish'} đẹp.\n👉 Lệnh: ${isUp ? 'LONG' : 'SHORT'}\n💵 Entry: ${entry.toFixed(4)}\n✅ TP: ${tp1.toFixed(4)}\n❌ SL: ${sl.toFixed(4)}\nKèo nhanh cho anh em húp xong nghỉ!`,
        
        `🌟 [GÓC NHÌN DÀI HẠN $${coin}]\nDù biến động ${change}% nhưng $${coin} vẫn là tài sản tiềm năng cho chu kỳ tới.\n🛠 Phân tích: RSI đang nằm ở vùng ${isUp ? 'quá mua' : 'quá bán'}.\n📈 Giá vào đẹp: ${entry.toFixed(4)}\n💎 Hold target: ${tp2.toFixed(4) * 2}\n🔥 Đừng bỏ lỡ cơ hội tích lũy giai đoạn này.`
    ];

    return templates[Math.floor(Math.random() * templates.length)];
}

// --- KHỞI TẠO BROWSER ---
async function initBrowser(show = false) {
    if (context) {
        try { await context.pages(); return context; } catch (e) { context = null; }
    }
    context = await chromium.launchPersistentContext(userDataDir, {
        headless: !show,
        viewport: { width: 1280, height: 800 },
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
    });
    return context;
}

// --- HÀM NHẬP LIỆU THÔNG MINH ---
async function typeSmartContent(page, textbox, coin, price, change) {
    const mainContent = generateRichContent(coin, price, change);
    
    logStep("🖱 Đã chọn ô text. Đợi 5s để ổn định...");
    await textbox.click();
    await page.waitForTimeout(5000);

    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(1000);
    
    // 1. Gõ nội dung chính
    await page.keyboard.type(mainContent + "\n\n", { delay: 5 });

    // 2. Gõ các Tag $ (Xử lý đợi 1.5s + Enter để khớp menu)
    const dollarTags = [`$${coin}`, `$BTC`, `$BNB`];
    for (const tag of dollarTags) {
        await page.keyboard.type(tag, { delay: 20 });
        await page.waitForTimeout(1500); 
        await page.keyboard.press('Enter'); 
        await page.keyboard.type('  ', { delay: 10 }); // Gõ 2 dấu cách sau mỗi $ tag
    }

    // 3. Gõ các Hashtag # (Xử lý gõ xong nhấn Enter + Cách để đóng menu gợi ý)
    const hashTags = [`#Binance`, `#Trading`, `#Crypto`];
    logStep("⌨️ Đang gõ Hashtag và xử lý menu gợi ý...");
    for (const tag of hashTags) {
        await page.keyboard.type("\n" + tag, { delay: 10 });
        await page.waitForTimeout(1000); // Đợi menu hiện
        await page.keyboard.press('Enter'); // Chọn hashtag từ menu
        await page.keyboard.type('   ', { delay: 10 }); // THÊM 3 DẤU CÁCH ĐỂ ĐÓNG MENU
    }

    logStep("✅ Đã thêm 3 dấu cách cuối bài để đảm bảo nút Đăng không bị che.");
}

async function findTextbox(page) {
    const selectors = ['div[contenteditable="true"]', 'div[role="textbox"]', '.public-DraftEditor-content'];
    for (let s of selectors) {
        try {
            const el = await page.locator(s).first();
            if (await el.isVisible()) return el;
        } catch (e) {}
    }
    return null;
}

async function ensureMainPage() {
    const ctx = await initBrowser(false);
    if (!mainPage || mainPage.isClosed()) {
        mainPage = await ctx.newPage();
        logStep("🌍 Truy cập Binance Square...");
        await mainPage.goto('https://www.binance.com/vi/square', { waitUntil: 'domcontentloaded', timeout: 120000 });
        logStep("⏳ Chờ 30s load trang...");
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

            while (!textbox && failCount < 3) {
                failCount++;
                logStep(`⏳ Không thấy ô nhập, chờ 30s (Lần ${failCount}/3)...`);
                await page.waitForTimeout(30000);
                textbox = await findTextbox(page);
            }

            if (!textbox) {
                logStep("⚠️ Timeout tìm ô nhập. Reload...");
                await page.reload({ waitUntil: 'domcontentloaded' });
                failCount = 0;
                throw new Error("Reload trang");
            }

            const coin = TOP_COINS[Math.floor(Math.random() * TOP_COINS.length)];
            const res = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${coin}USDT`);
            
            logStep(`🚀 Bắt đầu bài đăng $${coin}...`);
            await typeSmartContent(page, textbox, coin, res.data.lastPrice, res.data.priceChangePercent);
            
            logStep("⏳ Ngâm bài 10s...");
            await page.waitForTimeout(10000);

            const postBtn = await page.locator('button').filter({ hasText: /^Đăng$|^Post$/ }).first();
            
            if (await postBtn.isVisible() && await postBtn.isEnabled()) {
                logStep("🔘 Tiến hành Click nút Đăng...");
                await postBtn.click({ force: true }); // Dùng force: true để ép click nếu có gì che nhẹ
                
                logStep("⏳ Chờ 15s xác nhận...");
                await page.waitForTimeout(15000);

                const contentCheck = await page.content();
                if (contentCheck.includes(coin)) {
                    logStep(`🎉 THÀNH CÔNG: Bài $${coin} đã lên sàn!`);
                    totalPosts++;
                    history.unshift({ coin, time: new Date().toLocaleTimeString(), status: 'Thành công' });
                    return; 
                } else {
                    throw new Error("Không thấy bài đăng trong mã nguồn (có thể trượt click)");
                }
            } else {
                throw new Error("Nút Đăng bị Disabled/Hidden");
            }

        } catch (err) {
            logStep(`❌ LỖI: ${err.message}`);
            if (mainPage) await mainPage.screenshot({ path: `error_${Date.now()}.png` }).catch(()=>{});
            logStep("🔄 Thử lại sau 20s...");
            await new Promise(r => setTimeout(r, 20000));
        }
    }
}

async function startLoop() {
    while (isRunning) {
        await postTaskWithForce();
        logStep("😴 Nghỉ 1 phút...");
        for (let i = 0; i < 60 && isRunning; i++) {
            await new Promise(r => setTimeout(r, 1000));
        }
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
    if (context) { await context.close().catch(() => {}); context = null; }
    const ctx = await initBrowser(true);
    const p = await ctx.newPage();
    await p.goto('https://www.binance.com/vi/square');
    res.send("Đã mở Chrome. Đăng nhập xong hãy TẮT Chrome.");
});
app.get('/check', async (req, res) => {
    try {
        const ctx = await initBrowser(false);
        const page = await ctx.newPage();
        await page.goto('https://www.binance.com/vi/square/profile/moncey_d_luffy');
        await page.waitForTimeout(5000);
        const name = await page.locator('h1, div[class*="css-1o8m8j"]').first().innerText().catch(() => "N/A");
        userInfo = { name, status: name !== "N/A" ? "Sẵn sàng ✅" : "Cần Login" };
        await page.close();
    } catch (e) { logStep("Check fail"); }
    res.json(userInfo);
});
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(port, '0.0.0.0', () => logStep(`SERVER LIVE: ${port}`));
