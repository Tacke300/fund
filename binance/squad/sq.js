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
const port = 9003;
const userDataDir = path.join(__dirname, 'bot_session_final');

let isRunning = false;
let totalPosts = 0;
let history = [];
let userInfo = { name: "Chưa kiểm tra", status: "Offline", followers: "0" };
let context = null;
let mainPage = null;
let coinQueue = [];

function logStep(message) {
    console.log(`[${new Date().toLocaleTimeString()}] ➡️ ${message}`);
}

// --- 1. HÀM NGHỈ RANDOM & GIẢ CHUỘT (Yêu cầu 1 & 3) ---
async function humanIdle(page, minSecond, maxSecond) {
    const duration = Math.floor(Math.random() * (maxSecond - minSecond + 1) + minSecond);
    logStep(`⏳ Nghỉ giả lập người trong ${duration} giây...`);
    
    const endTime = Date.now() + duration * 1000;
    while (Date.now() < endTime) {
        // Trong lúc nghỉ, thi thoảng di chuyển chuột ngẫu nhiên
        if (Math.random() > 0.7) {
            const x = Math.floor(Math.random() * 800);
            const y = Math.floor(Math.random() * 600);
            await page.mouse.move(x, y, { steps: 10 });
        }
        await new Promise(r => setTimeout(r, 2000));
    }
}

// --- 2. GÕ PHÍM TỐC ĐỘ RANDOM (Yêu cầu 2) ---
// Tạo 100 mức tốc độ gõ (từ 50ms đến 300ms mỗi phím)
const typingSpeeds = Array.from({ length: 100 }, () => Math.floor(Math.random() * 250) + 50);

async function humanType(page, text) {
    for (const char of text) {
        const speed = typingSpeeds[Math.floor(Math.random() * typingSpeeds.length)];
        await page.keyboard.type(char, { delay: speed });
        // Thi thoảng dừng lại 1 chút như đang suy nghĩ
        if (Math.random() > 0.95) await page.waitForTimeout(500);
    }
}

// --- 4. NGUỒN TIN TỨC VÀ CÂU HỎI (Yêu cầu 4) ---
async function fetchCryptoNews() {
    try {
        // Lấy tin từ RSS công khai của CoinTelegraph hoặc News API
        const res = await axios.get('https://min-api.cryptocompare.com/data/v2/news/?lang=EN');
        const randomNews = res.data.Data[Math.floor(Math.random() * res.data.Data.length)];
        return `📰 TIN TỨC CRYPTO MỚI NHẤT:\n\n${randomNews.title}\n\n${randomNews.body.substring(0, 200)}...\n\nAnh em thấy tin này tác động thế nào đến thị trường?`;
    } catch (e) {
        return "Thị trường hôm nay có vẻ khá yên tĩnh, anh em đang gom hàng hay xả thế?";
    }
}

const cryptoQuestions = [
    "Theo anh em, trick nào để săn memecoin hiệu quả nhất hiện nay?",
    "Tip cho người mới: Đừng bao giờ all-in vào một lệnh. Anh em có kinh nghiệm gì xương máu không?",
    "Làm sao để check được một dự án có phải rug-pull hay không? Xin các cao nhân chỉ giáo.",
    "Anh em thường dùng chỉ báo kỹ thuật nào? RSI, MACD hay cứ nến thuần mà vả?",
    "Cách quản lý vốn khi chơi Future để không bị cháy tài khoản nhanh nhất là gì?"
];

// --- LOGIC LÀM TRÒN GIÁ ---
function smartRound(price) {
    const p = parseFloat(price);
    if (p > 1000) return Math.round(p / 10) * 10;
    if (p > 10) return Math.round(p * 10) / 10;
    if (p > 1) return Math.round(p * 100) / 100;
    return Math.round(p * 10000) / 10000;
}

// --- KHO DỮ LIỆU (Giữ nguyên từ code cũ của bạn) ---
const intros = ["Điểm tin nhanh về biến động của COIN.", "Anh em đã thấy cú move này của COIN chưa?", "Nhìn lại chart COIN hôm nay có nhiều điều thú vị.", "Cập nhật trạng thái mới nhất cho mã COIN.", "Dòng tiền đang đổ dồn sự chú ý vào COIN.", "Phân tích nhanh vị thế của COIN lúc này.", "Liệu COIN có chuẩn bị cho một cú bứt phá?", "Góc nhìn cá nhân về hướng đi của COIN.", "Sức nóng của COIN trên Square vẫn chưa hạ nhiệt.", "Đừng bỏ qua diễn biến hiện tại của COIN."];
const bodies = ["Giá hiện tại đang neo đậu tại mức ổn định.", "Cấu trúc nến cho thấy phe bò đang kiểm soát.", "Áp lực bán dường như đã cạn kiệt ở vùng này.", "Xu hướng tăng được củng cố bởi khối lượng giao dịch.", "Mô hình hai đáy đang dần hình thành trên đồ thị.", "Giá đang tích lũy trong một biên độ hẹp.", "Biến động CHANGE% tạo ra biên độ dao động lớn.", "Các chỉ báo kỹ thuật đang tiến sát vùng quá mua.", "Kháng cự ngắn hạn đang ngăn cả đà tăng trưởng.", "Lực cầu bắt đáy xuất hiện mạnh mẽ khi giá giảm."];
const closings = ["Chúc anh em có một ngày giao dịch thắng lợi!", "Quản lý vốn là chìa khóa để sống sót lâu dài.", "Đừng quên đặt Stop Loss để bảo vệ tài khoản.", "Hãy luôn tỉnh táo trước mọi biến động.", "Lợi nhuận sẽ đến với người kiên nhẫn.", "Kỷ luật thép sẽ tạo nên lợi nhuận bền vững."];

function generateFinalContent(coin, price, change) {
    const entry = smartRound(price);
    const isUp = parseFloat(change) >= 0;
    const tp1 = smartRound(isUp ? entry * 1.03 : entry * 0.97);
    const tp2 = smartRound(isUp ? entry * 1.08 : entry * 0.92);
    const sl = smartRound(isUp ? entry * 0.95 : entry * 1.05);

    const intro = intros[Math.floor(Math.random() * intros.length)].replace("COIN", coin);
    const body = bodies[Math.floor(Math.random() * bodies.length)].replace("CHANGE%", `${change}%`);
    const closing = closings[Math.floor(Math.random() * closings.length)];

    const text = `🔥 [MARKET SIGNAL]: ${coin}\n\n${intro}\n\n${body}\n\n📍 ENTRY: ${entry}\n🎯 TP1: ${tp1}\n🎯 TP2: ${tp2}\n🛡 SL: ${sl}\n\n${closing}`;

    const randomSelection = coinQueue.slice(0, 5).sort(() => 0.5 - Math.random());

    return {
        body: text,
        dollarTags: [coin, randomSelection[0]?.symbol || "BTC", randomSelection[1]?.symbol || "ETH"],
        hashTags: [coin, randomSelection[2]?.symbol || "BNB", randomSelection[3]?.symbol || "SOL"]
    };
}

// --- LOGIC TRÌNH DUYỆT ---
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
    }
    return mainPage;
}

// --- HÀM ĐĂNG BÀI CHÍNH ---
async function postTaskWithForce() {
    if (!isRunning) return;

    let page = await ensureMainPage();
    let contentBody = "";
    let tags = { dollar: [], hash: [] };
    let useTags = true;

    // Yêu cầu 5: Cứ 100 bài thì 1 bài không tag và load lại trang
    if (totalPosts > 0 && totalPosts % 100 === 0) {
        logStep("♻️ Đạt mốc 100 bài. Đăng bài không Tag và Reload trang...");
        await page.reload({ waitUntil: 'domcontentloaded' });
        contentBody = "Chào buổi sáng anh em Square! Chúc mọi người một ngày giao dịch hiệu quả và bùng nổ lợi nhuận nhé.";
        useTags = false;
    } 
    // Yêu cầu 4: Cứ 3 bài Signal thì 1 bài Hỏi hoặc Tin tức
    else if (totalPosts > 0 && totalPosts % 4 === 0) {
        const type = Math.random() > 0.5 ? 'question' : 'news';
        logStep(`💡 Đăng bài loại: ${type}`);
        contentBody = type === 'question' ? cryptoQuestions[Math.floor(Math.random() * cryptoQuestions.length)] : await fetchCryptoNews();
    } 
    else {
        // Bài Signal bình thường
        if (coinQueue.length === 0) {
            const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
            coinQueue = res.data.filter(c => c.symbol.endsWith('USDT')).map(c => ({ symbol: c.symbol.replace('USDT', ''), price: c.lastPrice, change: c.priceChangePercent })).sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
        }
        const currentCoin = coinQueue.shift();
        const content = generateFinalContent(currentCoin.symbol, currentCoin.price, currentCoin.change);
        contentBody = content.body;
        tags.dollar = content.dollarTags;
        tags.hash = content.hashTags;
    }

    try {
        const textbox = await page.locator('div[contenteditable="true"], div[role="textbox"]').first();
        await textbox.click();
        await page.waitForTimeout(2000);
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');

        // Gõ nội dung chính (Yêu cầu 2)
        await humanType(page, contentBody);

        if (useTags) {
            await page.keyboard.press('Enter');
            for (const s of tags.dollar) { await humanType(page, ` $${s}`); await page.keyboard.press('Enter'); }
            for (const s of tags.hash) { await humanType(page, ` #${s}`); await page.keyboard.press('Enter'); }
        }

        const postBtn = await page.locator('button').filter({ hasText: /^Đăng$|^Post$/ }).last();
        if (await postBtn.isEnabled()) {
            await postBtn.click();
            totalPosts++;
            history.unshift({ coin: "System", time: new Date().toLocaleTimeString(), status: 'Thành công' });
            // Yêu cầu 1 & 3: Nghỉ random 10-90s và giả chuột
            await humanIdle(page, 10, 90);
        }
    } catch (err) {
        logStep(`❌ Lỗi: ${err.message}`);
    }
}

async function startLoop() {
    while (isRunning) {
        await postTaskWithForce();
    }
}

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/start', (req, res) => { if (!isRunning) { isRunning = true; startLoop(); } res.json({ status: 'started' }); });
app.get('/stop', async (req, res) => { isRunning = false; res.json({ status: 'stopped' }); });
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));
app.get('/login', async (req, res) => {
    if (context) await context.close();
    const ctx = await initBrowser(true);
    await (await ctx.newPage()).goto('https://www.binance.com/vi/square');
    res.send("Login window opened.");
});

app.listen(port, '0.0.0.0', () => logStep(`SERVER MỞ TẠI PORT: ${port}`));
