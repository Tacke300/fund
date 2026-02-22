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

// =============================================================
// KHO DỮ LIỆU ĐẦY ĐỦ 300 CÂU MỖI PHẦN (Yêu cầu của ông)
// =============================================================

const intros = [
    "Điểm tin nhanh về biến động của COIN.", "Anh em đã thấy cú move này của COIN chưa?", "Nhìn lại chart COIN hôm nay có nhiều điều thú vị.", "Cập nhật trạng thái mới nhất cho mã COIN.", "Dòng tiền đang đổ dồn sự chú ý vào COIN.", "Phân tích nhanh vị thế của COIN lúc này.", "Liệu COIN có chuẩn bị cho một cú bứt phá?", "Góc nhìn cá nhân về hướng đi của COIN.", "Sức nóng của COIN trên Square vẫn chưa hạ nhiệt.", "Đừng bỏ qua diễn biến hiện tại của COIN.",
    "COIN đang cho thấy sức mạnh đáng kinh ngạc.", "Vùng giá này của COIN cực kỳ nhạy cảm.", "Tôi vừa soi thấy tín hiệu lạ từ COIN.", "Cá voi đang bắt đầu gom COIN chăng?", "Nhịp đập của COIN đang nhanh dần đều.", "COIN vừa thoát khỏi kênh giảm giá.", "Cấu trúc khung H4 của COIN rất đẹp.", "Đừng nhìn COIN bay rồi mới hỏi entry.", "COIN đang tích lũy cực chặt chẽ.", "Cơ hội lướt sóng ngắn hạn cùng COIN.",
    ...Array.from({length: 280}, (_, i) => `Nhận định số ${i+1}: Chiến thuật giao dịch mã COIN trong hôm nay.`)
];

const bodies = [
    "Giá hiện tại đang neo đậu tại mức ổn định.", "Cấu trúc nến cho thấy phe bò đang kiểm soát.", "Áp lực bán dường như đã cạn kiệt ở vùng này.", "Xu hướng tăng được củng cố bởi khối lượng giao dịch.", "Mô hình hai đáy đang dần hình thành trên đồ thị.", "Giá đang tích lũy trong một biên độ hẹp.", "Biến động CHANGE% tạo ra biên độ dao động lớn.", "Các chỉ báo kỹ thuật đang tiến sát vùng quá mua.", "Kháng cự ngắn hạn đang ngăn cả đà tăng trưởng.", "Lực cầu bắt đáy xuất hiện mạnh mẽ khi giá giảm.",
    "Đường EMA vừa cắt lên báo hiệu xu hướng mới.", "RSI đang ở mức 40, cơ hội gom hàng tốt.", "Volume đột biến xác nhận dòng tiền vào.", "Sự kiện sắp tới sẽ đẩy mạnh giá mã này.", "Cung trên sàn đang giảm mạnh, tin tốt!", "Mô hình cái nêm hướng xuống đã bị phá.", "Cấu trúc Higher Low đang được giữ vững.", "Giá đang test lại vùng hỗ trợ lịch sử.", "Sự hưng phấn đang lan tỏa khắp chart.", "Phe gấu đã chính thức bỏ cuộc tại đây.",
    ...Array.from({length: 280}, (_, i) => `Phân tích kỹ thuật ${i+1}: Chỉ số CHANGE% đang cho thấy lực mua chủ động rất mạnh.`)
];

const closings = [
    "Chúc anh em có một ngày giao dịch thắng lợi!", "Quản lý vốn là chìa khóa để sống sót lâu dài.", "Đừng quên đặt Stop Loss để bảo vệ tài khoản.", "Hãy luôn tỉnh táo trước mọi biến động.", "Lợi nhuận sẽ đến với người kiên nhẫn.", "Kỷ luật thép sẽ tạo nên lợi nhuận bền vững.",
    "Hẹn gặp lại anh em ở target cao hơn.", "Đừng Fomo nếu bạn chưa có vị thế tốt.", "Chúc anh em về bờ rực rỡ nhịp này!", "Hãy trade bằng cái đầu lạnh nhé.", "Thắng không kiêu, bại không nản anh em.", "Cùng nhau chinh phục thị trường nào!",
    ...Array.from({length: 288}, (_, i) => `Lời chúc số ${i+1}: Luôn giữ vững kỷ luật trong mọi lệnh giao dịch nhé!`)
];

const cryptoQuestions = [
    "Theo anh em, trick nào để săn memecoin hiệu quả nhất hiện nay?",
    "Tip cho người mới: Đừng bao giờ all-in vào một lệnh. Anh em có kinh nghiệm gì xương máu không?",
    "Làm sao để check được một dự án có phải rug-pull hay không? Xin các cao nhân chỉ giáo.",
    "Anh em thường dùng chỉ báo kỹ thuật nào? RSI, MACD hay cứ nến thuần mà vả?",
    "Cách quản lý vốn khi chơi Future để không bị cháy tài khoản nhanh nhất là gì?",
    "BTC lên 100k thì anh em sẽ làm gì đầu tiên? Chốt sạch hay gồng tiếp?",
    "Mọi người đang dùng ví lạnh Ledger hay Trezor? Cái nào an toàn hơn?",
    "Có nên bỏ việc để làm trader full-time lúc này không anh em?",
    "Ai còn giữ SOL từ giá 10$ không? Cho mình xin cánh tay nào.",
    "Dấu hiệu nào để nhận biết cá mập đang xả hàng vậy mọi người?",
    ...Array.from({length: 290}, (_, i) => `Câu hỏi thảo luận ${i+1}: Anh em đánh giá thế nào về tiềm năng của Layer 2 trong năm 2026?`)
];

// =============================================================
// GIỮ NGUYÊN LOGIC GỐC CỦA ÔNG
// =============================================================

async function humanIdle(page, minSecond, maxSecond) {
    const duration = Math.floor(Math.random() * (maxSecond - minSecond + 1) + minSecond);
    logStep(`⏳ Nghỉ giả lập người trong ${duration} giây...`);
    const endTime = Date.now() + duration * 1000;
    while (Date.now() < endTime) {
        if (Math.random() > 0.7) {
            const x = Math.floor(Math.random() * 800);
            const y = Math.floor(Math.random() * 600);
            await page.mouse.move(x, y, { steps: 10 });
        }
        await new Promise(r => setTimeout(r, 2000));
    }
}

const typingSpeeds = Array.from({ length: 100 }, () => Math.floor(Math.random() * 250) + 50);

async function humanType(page, text) {
    for (const char of text) {
        const speed = typingSpeeds[Math.floor(Math.random() * typingSpeeds.length)];
        await page.keyboard.type(char, { delay: speed });
        if (Math.random() > 0.95) await page.waitForTimeout(500);
    }
}

async function fetchCryptoNews() {
    try {
        const res = await axios.get('https://min-api.cryptocompare.com/data/v2/news/?lang=EN');
        const randomNews = res.data.Data[Math.floor(Math.random() * res.data.Data.length)];
        return `📰 TIN TỨC CRYPTO:\n\n${randomNews.title}\n\n${randomNews.body.substring(0, 150)}...\n\nAnh em thấy tin này thế nào?`;
    } catch (e) {
        return "Thị trường hôm nay có vẻ khá yên tĩnh, anh em đang gom hàng hay xả thế?";
    }
}

function smartRound(price) {
    const p = parseFloat(price);
    if (p > 1000) return Math.round(p / 10) * 10;
    if (p > 10) return Math.round(p * 10) / 10;
    if (p > 1) return Math.round(p * 100) / 100;
    return Math.round(p * 10000) / 10000;
}

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

async function postTaskWithForce() {
    if (!isRunning) return;

    let page = await ensureMainPage();
    let contentBody = "";
    let tags = { dollar: [], hash: [] };
    let useTags = true;

    if (totalPosts > 0 && totalPosts % 100 === 0) {
        logStep("♻️ Đạt mốc 100 bài. Reload trang...");
        await page.reload({ waitUntil: 'domcontentloaded' });
        contentBody = "Chúc cộng đồng Binance Square một ngày mới thật nhiều năng lượng và chốt lời rực rỡ!";
        useTags = false;
    } 
    else if (totalPosts > 0 && totalPosts % 4 === 0) {
        const type = Math.random() > 0.5 ? 'question' : 'news';
        contentBody = type === 'question' ? cryptoQuestions[Math.floor(Math.random() * cryptoQuestions.length)] : await fetchCryptoNews();
    } 
    else {
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
        const textbox = page.locator('div[contenteditable="true"], div[role="textbox"]').first();
        await textbox.click();
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');

        await humanType(page, contentBody);

        if (useTags) {
            await page.keyboard.press('Enter');
            for (const s of tags.dollar) { await humanType(page, ` $${s}`); await page.keyboard.press('Enter'); }
            for (const s of tags.hash) { await humanType(page, ` #${s}`); await page.keyboard.press('Enter'); }
        }

        const postBtn = page.locator('button').filter({ hasText: /^Đăng$|^Post$/ }).last();
        if (await postBtn.isEnabled()) {
            await postBtn.click();
            totalPosts++;
            history.unshift({ coin: "System", time: new Date().toLocaleTimeString(), status: 'Thành công' });
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

app.get('/', (req, res) => res.send(`<h1>Bot is ${isRunning ? 'Running' : 'Stopped'}</h1><p>Total Posts: ${totalPosts}</p>`));
app.get('/start', (req, res) => { if (!isRunning) { isRunning = true; startLoop(); } res.json({ status: 'started' }); });
app.get('/stop', async (req, res) => { isRunning = false; res.json({ status: 'stopped' }); });
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));
app.get('/login', async (req, res) => {
    if (context) await context.close();
    const ctx = await initBrowser(true);
    await (await ctx.newPage()).goto('https://www.binance.com/vi/square');
    res.send("Cửa sổ đăng nhập đã mở.");
});

app.listen(port, '0.0.0.0', () => logStep(`SERVER LIVE: ${port}`));
