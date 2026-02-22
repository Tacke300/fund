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

// --- HÀM SPIN ĐỆ QUY (CHÌA KHÓA TẠO 1 TRIỆU BIẾN THỂ) ---
function spin(text) {
    let spun = text.replace(/\{([^{}]+)\}/g, function(match, target) {
        const choices = target.split('|');
        return choices[Math.floor(Math.random() * choices.length)];
    });
    if (spun.includes('{')) return spin(spun); 
    return spun;
}

// --- 1. SIÊU MA TRẬN SIGNAL (HƠN 100 CỤM TỪ) ---
const intros = [
    "{🔥|🚀|📊|💎} {Điểm tin|Cập nhật|Soi nhanh|Review|Nhìn lại|Góc nhìn|Phân tích|Check|Lọc kèo|Báo động} {nhanh|mới nhất|chi tiết|cực nóng|quan trọng|về} {biến động|hành động giá|tình hình|vị thế|cấu trúc|nhịp chạy} của {mã |đồng |token |}COIN.",
    "{Anh em|Mọi người|Cả nhà|Cộng đồng|Các trader|Các sếp|Quý nhà đầu tư} đã {thấy|quan sát|để ý|kịp nhận ra|soi được} cú {move|đi|nhảy|pump|dump|sóng} {bất ngờ|mạnh mẽ|đáng chú ý|khét|lạ} này của COIN chưa?",
    "{Cấu trúc|Đồ thị|Chart|Hành vi giá|Nến} COIN {hôm nay|hiện tại|trong khung H4|vừa xong|mới nhất} có nhiều {điểm thú vị|thứ để nói|tín hiệu lạ|vấn đề cần bàn|kèo thơm|biến số}.",
    "{Dòng tiền|Volume|Sức mua|Lực cầu|Thanh khoản} đang {đổ dồn|tập trung|chú ý|tìm đến|chảy mạnh} vào COIN {rất mạnh|khá lớn|đáng kinh ngạc|một cách âm thầm|quyết liệt}.",
    "{Góc nhìn|Nhận định|Đánh giá|View} {cá nhân|kỹ thuật|khách quan|ngắn hạn} về {hướng đi|xu hướng|vị thế|target|vùng giá} của COIN {lúc này|hiện tại|trong 24h tới}."
];

const bodies = [
    "Giá {hiện tại|lúc này} đang {neo đậu|tích lũy|giữ chân|đi ngang|sideway} tại {vùng|khu vực} {ổn định|quan trọng|vàng|hỗ trợ cứng|nhạy cảm}.",
    "{Cấu trúc nến|Hành động giá|Phe bò|Lực mua} cho thấy {bên mua|phe Long|lực cầu|whale} đang {kiểm soát|áp đảo|chiếm ưu thế|thắng thế|gom hàng} {hoàn toàn|mạnh mẽ|quyết liệt}.",
    "Áp lực {bán|xả|cung|chốt lời} dường như đã {cạn kiệt|yếu đi|biến mất|giảm nhiệt|bị hấp thụ} ở {vùng|mức|quanh} {giá này|hỗ trợ|entry này|đáy}.",
    "Xu hướng {tăng|đi lên|uptrend|hồi phục} được {củng cố|xác nhận|bảo chứng|hỗ trợ} bởi {khối lượng|volume|thanh khoản} {lớn|đột biến|ổn định|duy trì}.",
    "{Mô hình|Cấu trúc|Setup} {hai đáy|tích lũy|vai đầu vai ngược|cờ tăng|breakout|nêm} đang {dần hình thành|xác nhận|chạy đẹp|rất chuẩn}."
];

const closings = [
    "{Chúc|Hy vọng} anh em có một ngày {giao dịch|trading|làm việc} {thắng lợi|rực rỡ|xanh sàn|bùng nổ|đại thắng|thuận lợi}!",
    "Quản lý {vốn|rủi ro|tài khoản} là {chìa khóa|yếu tố cốt lõi|bí mật|ưu tiên số 1} để {sống sót|thành công|giàu có|đi đường dài}.",
    "Đừng quên {đặt Stop Loss|cài SL|quản lý lệnh|set chốt lỗ} để bảo vệ {tài khoản|vốn|túi tiền|thành quả} {của mình|nhé|an toàn}.",
    "{Hãy luôn|Luôn giữ|Cần giữ} tỉnh táo trước mọi {biến động|con sóng|tin tức|fud|cú lừa} của thị trường {khốc liệt này}.",
    "{Lợi nhuận|Thành công|Tiền bạc} sẽ đến với người {kiên nhẫn|kỷ luật|có kiến thức|biết chờ đợi|biết đủ}."
];

// --- 2. HÀM TẠO 1 TRIỆU CÂU HỎI (HƠN 100 CỤM TỪ KẾT HỢP) ---
function generateQuestion() {
    const openers = [
        "{Cho mình hỏi|Thắc mắc chút|Anh em cho ý kiến|Cần tư vấn|Mọi người ơi|Hỏi ngu chút|Góc thảo luận|Xin chỉ giáo|Cần các pro giúp|Ae Square ơi}",
        "{Thật lòng mà nói|Chưa hiểu lắm|Đang phân vân|Cần tìm hướng đi|Lang thang thấy|Theo dòng sự kiện|Tiện đây cho hỏi|Có ai để ý}"
    ];
    const topics = [
        "{mẹo|cách|trick|bí kíp|phương pháp|tư duy|chiến thuật} {đánh|trade|vào lệnh|scalping|hold|lướt} {Future|Margin|Spot|Altcoin|Memecoin|RWA|AI trend|Layer 2}",
        "{làm sao để|bí quyết|công thức|làm thế nào} {giữ vững tâm lý|kiềm chế cảm xúc|không fomo|quản lý vốn|gồng lời|gồng lỗ|về bờ|x2 tài khoản}",
        "{kinh nghiệm|quy trình|dấu hiệu} {check|soi|lọc|đánh giá|phát hiện} {dự án|token|coin|kèo|hàng} {rug-pull|scam|xịn|tiềm năng|hidden gem}",
        "{hiệu quả của|sự kết hợp giữa|cách dùng} {RSI|MACD|EMA|Price Action|Volume|Smart Money Concept|Fibonacci|Ichimoku}"
    ];
    const contexts = [
        "{hiệu quả nhất|tối ưu nhất|an toàn nhất|ít rủi ro nhất|đỉnh nhất|vững nhất}",
        "{trong mùa uptrend|khi thị trường sập|lúc sideway|trong giai đoạn này|để tối ưu lợi nhuận|khi đánh nến khung nhỏ}"
    ];
    const closers = [
        "{Có ai đang áp dụng không?|Xin các cao nhân chỉ giáo.|Anh em chia sẻ ít kinh nghiệm đi.|Liệu có khả thi không?|Cùng thảo luận nhé.}",
        "{Đang bế tắc quá.|Mong được chỉ điểm.|Cảm ơn anh em trước.|Comment bên dưới nhé!|Ai đi qua cho xin 1 nhận xét.}"
    ];

    const template = `{${openers.join('|')}} {${topics.join('|')}} {${contexts.join('|')}}? {${closers.join('|')}}`;
    return spin(template);
}

// --- LOGIC TRÌNH DUYỆT & POST ---
async function humanIdle(page, minSecond, maxSecond) {
    const duration = Math.floor(Math.random() * (maxSecond - minSecond + 1) + minSecond);
    const endTime = Date.now() + duration * 1000;
    while (Date.now() < endTime) {
        if (Math.random() > 0.7) {
            const x = Math.floor(Math.random() * 800), y = Math.floor(Math.random() * 600);
            await page.mouse.move(x, y, { steps: 10 });
        }
        await new Promise(r => setTimeout(r, 2000));
    }
}

async function humanType(page, text) {
    for (const char of text) {
        await page.keyboard.type(char, { delay: Math.floor(Math.random() * 150) + 50 });
        if (Math.random() > 0.97) await page.waitForTimeout(500);
    }
}

function smartRound(price) {
    const p = parseFloat(price);
    if (p > 1000) return Math.round(p / 10) * 10;
    if (p > 10) return Math.round(p * 10) / 10;
    return Math.round(p * 100) / 100;
}

function generateFinalContent(coin, price, change) {
    const entry = smartRound(price);
    const isUp = parseFloat(change) >= 0;
    const tp1 = smartRound(isUp ? entry * 1.03 : entry * 0.97);
    const sl = smartRound(isUp ? entry * 0.95 : entry * 1.05);

    const intro = spin(intros[Math.floor(Math.random() * intros.length)]).replace(/COIN/g, coin);
    const body = spin(bodies[Math.floor(Math.random() * bodies.length)]).replace(/CHANGE%/g, `${change}%`);
    const closing = spin(closings[Math.floor(Math.random() * closings.length)]);

    return {
        body: `🔥 [MARKET SIGNAL]: ${coin}\n\n${intro}\n\n${body}\n\n📍 ENTRY: ${entry}\n🎯 TP: ${tp1}\n🛡 SL: ${sl}\n\n${closing}`,
        dollarTags: [coin], // Viết đúng 1 $
        hashTags: [coin, "Binance", "Crypto"] // Giữ nguyên #
    };
}

async function postTaskWithForce() {
    if (!isRunning) return;
    let page = await ensureMainPage();
    let content = { body: "", dollarTags: [], hashTags: [] };

    if (totalPosts > 0 && totalPosts % 4 === 0) {
        content.body = generateQuestion();
    } else {
        if (coinQueue.length === 0) {
            const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
            coinQueue = res.data.filter(c => c.symbol.endsWith('USDT')).map(c => ({ symbol: c.symbol.replace('USDT', ''), price: c.lastPrice, change: c.priceChangePercent }));
        }
        const coin = coinQueue.shift();
        content = generateFinalContent(coin.symbol, coin.price, coin.change);
    }

    try {
        const textbox = await page.locator('div[contenteditable="true"], div[role="textbox"]').first();
        await textbox.click(); await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
        await humanType(page, content.body);

        if (content.dollarTags.length > 0) {
            await page.keyboard.press('Enter');
            for (const s of content.dollarTags) { await humanType(page, ` $${s}`); await page.keyboard.press('Space'); }
            for (const s of content.hashTags) { await humanType(page, ` #${s}`); await page.keyboard.press('Space'); }
        }

        const postBtn = await page.locator('button').filter({ hasText: /^Đăng$|^Post$/ }).last();
        if (await postBtn.isEnabled()) {
            await postBtn.click();
            totalPosts++;
            await humanIdle(page, 20, 60);
        }
    } catch (e) { console.log("Lỗi:", e.message); await page.goto('https://www.binance.com/vi/square'); }
}

async function initBrowser(show = false) {
    if (!context) context = await chromium.launchPersistentContext(userDataDir, { headless: !show, args: ['--disable-blink-features=AutomationControlled'] });
    return context;
}

async function ensureMainPage() {
    const ctx = await initBrowser(false);
    if (!mainPage || mainPage.isClosed()) {
        mainPage = await ctx.newPage();
        await mainPage.goto('https://www.binance.com/vi/square');
    }
    return mainPage;
}

async function startLoop() { while (isRunning) await postTaskWithForce(); }

app.get('/start', (req, res) => { if (!isRunning) { isRunning = true; startLoop(); } res.json({ status: 'started' }); });
app.get('/stop', (req, res) => { isRunning = false; res.json({ status: 'stopped' }); });
app.listen(port, () => console.log(`Bot running on port ${port}`));
