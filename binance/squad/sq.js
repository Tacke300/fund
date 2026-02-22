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

// --- TRẠNG THÁI BOT ---
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

// ==========================================
// KHO NỘI DUNG SIÊU KHỔNG LỒ (X10)
// ==========================================

const intros = [
    "Điểm tin nhanh về biến động của COIN.", "Anh em đã thấy cú move này của COIN chưa?", "Nhìn lại chart COIN hôm nay có nhiều điều thú vị.", "Cập nhật trạng thái mới nhất cho mã COIN.", "Dòng tiền đang đổ dồn sự chú ý vào COIN.", "Phân tích nhanh vị thế của COIN lúc này.", "Liệu COIN có chuẩn bị cho một cú bứt phá?", "Góc nhìn cá nhân về hướng đi của COIN.", "Sức nóng của COIN trên Square vẫn chưa hạ nhiệt.", "Đừng bỏ qua diễn biến hiện tại của COIN.",
    "🚀 COIN đang có dấu hiệu cá mập gom hàng cực mạnh.", "📊 Phân tích kỹ thuật mã COIN: Vùng mua đã lộ diện.", "🔥 Sóng tới rồi anh em ơi, COIN đang dẫn đầu!", "👀 Theo dõi sát COIN, biến động cực lớn sắp xảy ra.", "💎 COIN - Viên kim cương thô đang chờ ngày bùng nổ.", "📉 Sau cú rũ bỏ, COIN đang tích lũy rất đẹp.", "💰 Dòng vốn ngoại đang âm thầm đẩy mạnh COIN.", "⚡ Tín hiệu Scalping chớp nhoáng cho anh em với COIN.", "🌈 Thị trường xanh mướt, mã COIN không thể đứng ngoài.", "📢 Cảnh báo: COIN sắp phá vỡ vùng kháng cự lịch sử."
];

const bodies = [
    "Giá hiện tại đang neo đậu tại mức ổn định.", "Cấu trúc nến cho thấy phe bò đang kiểm soát.", "Áp lực bán dường như đã cạn kiệt ở vùng này.", "Xu hướng tăng được củng cố bởi khối lượng giao dịch.", "Mô hình hai đáy đang dần hình thành trên đồ thị.", "Giá đang tích lũy trong một biên độ hẹp.", "Biến động CHANGE% tạo ra biên độ dao động lớn.", "Các chỉ báo kỹ thuật đang tiến sát vùng quá mua.", "Kháng cự ngắn hạn đang ngăn cả đà tăng trưởng.", "Lực cầu bắt đáy xuất hiện mạnh mẽ khi giá giảm.",
    "Mô hình nến Engulfing xuất hiện xác nhận đà tăng.", "Đường EMA vừa cắt lên cho tín hiệu mua dài hạn.", "Chỉ số RSI đang ở vùng quá bán, cơ hội hồi phục cao.", "Volume giao dịch tăng đột biến 300% trong 24h qua.", "Sự kiện sắp tới sẽ là chất xúc tác cực mạnh cho giá.", "Cá voi vừa thực hiện lệnh mua 50 triệu USD mã này.", "Mô hình tam giác cân đang đi đến đoạn cuối bứt phá.", "Vùng hỗ trợ cứng đang được bảo vệ cực kỳ nghiêm ngặt.", "Phân tích On-chain cho thấy lượng coin rút ra khỏi sàn tăng mạnh.", "Cấu trúc Higher Low đang duy trì cực kỳ bền bỉ trên chart."
];

const closings = [
    "Chúc anh em có một ngày giao dịch thắng lợi!", "Quản lý vốn là chìa khóa để sống sót lâu dài.", "Đừng quên đặt Stop Loss để bảo vệ tài khoản.", "Hãy luôn tỉnh táo trước mọi biến động.", "Lợi nhuận sẽ đến với người kiên nhẫn.", "Kỷ luật thép sẽ tạo nên lợi nhuận bền vững.",
    "🔥 Kèo thơm không đợi ai, quyết đoán lên anh em!", "🚀 Hẹn gặp anh em ở mặt trăng (To the Moon)!", "💎 Hãy hold thật chặt, thành quả sẽ tới sớm thôi.", "⚠️ Đây không phải lời khuyên đầu tư, hãy tự check lại nhé.", "🍀 Chúc may mắn rực rỡ và túi tiền luôn đầy!", "🦾 Tâm lý vững vàng là 90% của chiến thắng.", "🤝 Đồng hành cùng Square để không bỏ lỡ cơ hội nào.", "🌟 Thành công chỉ đến với người chuẩn bị kỹ càng.", "🔭 Tầm nhìn dài hạn sẽ giúp bạn vượt qua bão tố.", "🥂 Chốt lời xong đừng quên mời bạn bè một ly nhé!"
];

const cryptoQuestions = [
    "Theo anh em, trick nào để săn memecoin hiệu quả nhất hiện nay?",
    "Tip cho người mới: Đừng bao giờ all-in vào một lệnh. Anh em có kinh nghiệm gì xương máu không?",
    "Làm sao để check được một dự án có phải rug-pull hay không? Xin các cao nhân chỉ giáo.",
    "Anh em thường dùng chỉ báo kỹ thuật nào? RSI, MACD hay cứ nến thuần mà vả?",
    "Cách quản lý vốn khi chơi Future để không bị cháy tài khoản nhanh nhất là gì?",
    "Anh em nhận định thế nào về xu hướng BTC trong tuần tới? Lên 100k hay chỉnh về 80k?",
    "Altcoin Season đã thực sự bắt đầu chưa hay chỉ là sóng hồi?",
    "Dùng đòn bẩy x bao nhiêu là an toàn nhất cho người mới tập chơi?",
    "Có nên mua Altcoin lúc này hay đợi BTC ổn định hẳn rồi mới vào?",
    "Sàn giao dịch nào anh em tin dùng nhất ngoài Binance để tìm hidden gem?",
    "Làm sao để lọc được dự án tốt giữa rừng rác trên Dexscreener?",
    "Chiến thuật DCA (trung bình giá) còn hiệu quả trong thị trường biến động này không?",
    "Anh em có tin vào các chuyên gia phán kèo trên mạng không?",
    "Làm thế nào để giữ được cái đầu lạnh khi tài khoản chia 2 chia 3?",
    "Đâu là mã coin anh em đang 'all-in' nhiều nhất trong ví lúc này?",
    "Cảm giác của anh em thế nào sau một ngày giao dịch mệt mỏi?",
    "Có ai đang dùng bot trade tự động không? Xin review chân thực.",
    "Làm sao để nhận biết sớm dấu hiệu của một cú sập thị trường?",
    "Ví lạnh hay ví nóng? Đâu là lựa chọn tối ưu để cất giấu tài sản?",
    "Tại sao chúng ta thường 'mua đỉnh bán đáy'? Cách khắc phục là gì?"
];

// --- LOGIC HỖ TRỢ ---
async function humanIdle(page, minSecond, maxSecond) {
    const duration = Math.floor(Math.random() * (maxSecond - minSecond + 1) + minSecond);
    logStep(`⏳ Nghỉ giả lập người trong ${duration} giây...`);
    const endTime = Date.now() + duration * 1000;
    while (Date.now() < endTime) {
        if (Math.random() > 0.7) {
            const x = Math.floor(Math.random() * 800);
            const y = Math.floor(Math.random() * 600);
            await page.mouse.move(x, y, { steps: 10 }).catch(() => {});
        }
        await new Promise(r => setTimeout(r, 2000));
    }
}

async function humanType(page, text) {
    for (const char of text) {
        const speed = Math.floor(Math.random() * 200) + 50;
        await page.keyboard.type(char, { delay: speed });
        if (Math.random() > 0.95) await page.waitForTimeout(500);
    }
}

async function fetchCryptoNews() {
    try {
        const res = await axios.get('https://min-api.cryptocompare.com/data/v2/news/?lang=EN');
        const randomNews = res.data.Data[Math.floor(Math.random() * res.data.Data.length)];
        return `📰 TIN TỨC MỚI NHẤT:\n\n${randomNews.title}\n\n${randomNews.body.substring(0, 200)}...\n\nAnh em thấy tin này thế nào?`;
    } catch (e) {
        return "Thị trường hôm nay biến động mạnh, anh em bảo trọng nhé!";
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
    const sl = smartRound(isUp ? entry * 0.95 : entry * 1.05);
    const intro = intros[Math.floor(Math.random() * intros.length)].replace("COIN", coin);
    const body = bodies[Math.floor(Math.random() * bodies.length)].replace("CHANGE%", `${change}%`);
    const closing = closings[Math.floor(Math.random() * closings.length)];

    return {
        body: `🔥 [MARKET SIGNAL]: ${coin}\n\n${intro}\n\n${body}\n\n📍 ENTRY: ${entry}\n🎯 TP: ${tp1}\n🛡 SL: ${sl}\n\n${closing}`,
        dollarTags: [coin, "BTC", "BNB"],
        hashTags: ["Trading", "Crypto", "BinanceSquare"]
    };
}

// ==========================================
// LOGIC TRÌNH DUYỆT (GIỮ NGUYÊN CODE GỐC)
// ==========================================

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
    try {
        let page = await ensureMainPage();
        let contentBody = "";
        let tags = { dollar: [], hash: [] };
        let useTags = true;

        if (totalPosts > 0 && totalPosts % 4 === 0) {
            const type = Math.random() > 0.5 ? 'question' : 'news';
            logStep(`💡 Đăng bài loại: ${type}`);
            contentBody = type === 'question' ? cryptoQuestions[Math.floor(Math.random() * cryptoQuestions.length)] : await fetchCryptoNews();
        } else {
            if (coinQueue.length === 0) {
                const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
                coinQueue = res.data.filter(c => c.symbol.endsWith('USDT')).map(c => ({ symbol: c.symbol.replace('USDT', ''), price: c.lastPrice, change: c.priceChangePercent }));
            }
            const currentCoin = coinQueue.shift();
            const content = generateFinalContent(currentCoin.symbol, currentCoin.price, currentCoin.change);
            contentBody = content.body;
            tags.dollar = content.dollarTags;
            tags.hash = content.hashTags;
        }

        const textbox = await page.locator('div[contenteditable="true"], div[role="textbox"]').first();
        await textbox.click();
        await page.waitForTimeout(2000);
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');

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
            await humanIdle(page, 10, 90);
        }
    } catch (err) {
        logStep(`❌ Lỗi: ${err.message}`);
        isRunning = false; // Dừng lại nếu lỗi nặng để tránh spam lỗi
    }
}

async function startLoop() {
    while (isRunning) {
        await postTaskWithForce();
    }
}

// --- GIAO DIỆN HTML NHÚNG TRỰC TIẾP ĐỂ TRÁNH LỖI CANNOT GET ---
const htmlIndex = `
<!DOCTYPE html>
<html>
<head><title>Square Bot Control</title>
<style>
    body { font-family: sans-serif; background: #121212; color: white; text-align: center; }
    .card { background: #1e1e1e; padding: 20px; border-radius: 10px; display: inline-block; margin-top: 50px; }
    button { padding: 10px 20px; margin: 10px; cursor: pointer; border-radius: 5px; border: none; font-weight: bold; }
    .btn-start { background: #28a745; color: white; }
    .btn-stop { background: #dc3545; color: white; }
    .btn-login { background: #ffc107; color: black; }
</style>
</head>
<body>
    <div class="card">
        <h1>🤖 Binance Square Control</h1>
        <button class="btn-login" onclick="fetch('/login')">MỞ TRÌNH DUYỆT ĐĂNG NHẬP</button><br>
        <button class="btn-start" onclick="fetch('/start')">BẮT ĐẦU CHẠY</button>
        <button class="btn-stop" onclick="fetch('/stop')">DỪNG LẠI</button>
        <div id="status"></div>
    </div>
    <script>
        setInterval(() => {
            fetch('/stats').then(res => res.json()).then(data => {
                document.getElementById('status').innerHTML = '<p>Đã đăng: ' + data.totalPosts + '</p><p>Trạng thái: ' + (data.isRunning ? 'Đang chạy' : 'Đang dừng') + '</p>';
            })
        }, 2000);
    </script>
</body>
</html>
`;

// --- ROUTES ---
app.get('/', (req, res) => res.send(htmlIndex));
app.get('/start', (req, res) => { if (!isRunning) { isRunning = true; startLoop(); } res.json({ status: 'started' }); });
app.get('/stop', async (req, res) => { isRunning = false; res.json({ status: 'stopped' }); });
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));
app.get('/login', async (req, res) => {
    if (context) await context.close();
    const ctx = await initBrowser(true);
    const lp = await ctx.newPage();
    await lp.goto('https://www.binance.com/vi/square');
    res.send("Đã mở cửa sổ đăng nhập trên máy tính.");
});

app.listen(port, '0.0.0.0', () => logStep(`SERVER MỞ TẠI PORT: ${port}`));
