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

// --- HÀM SPIN ĐA TẦNG ---
function spin(text) {
    let spun = text.replace(/\{([^{}]+)\}/g, (match, target) => {
        const choices = target.split('|');
        return choices[Math.floor(Math.random() * choices.length)];
    });
    if (spun.includes('{')) return spin(spun); 
    return spun;
}

// --- KHO NỘI DUNG SIÊU BIẾN THỂ ---
const intros = [
    "{🔥|🚀|📊|💎} {Điểm tin|Cập nhật|Soi nhanh|Review|Nhìn lại|Góc nhìn|Phân tích|Check|Lọc kèo} {mới nhất|chi tiết|cực nóng} về {biến động|hành động giá|tình hình} của {mã |đồng |token |}COIN.",
    "{Anh em|Mọi người|Cả nhà|Các trader} đã {thấy|quan sát|để ý} cú {move|đi|nhảy|pump|dump} {bất ngờ|mạnh mẽ} này của COIN chưa?",
    "{Cấu trúc|Đồ thị|Chart} COIN {hôm nay|hiện tại} có nhiều {điểm thú vị|thứ để nói|tín hiệu lạ|kèo thơm}.",
    "{Dòng tiền|Volume|Sức mua} đang {đổ dồn|tập trung|chú ý} vào COIN {rất mạnh|khá lớn|âm thầm}."
];

const bodies = [
    "Giá {hiện tại|lúc này} đang {neo đậu|tích lũy|đi ngang} tại vùng {quan trọng|vàng|hỗ trợ cứng}.",
    "{Cấu trúc nến|Phe bò|Lực mua} cho thấy {bên mua|phe Long} đang {kiểm soát|áp đảo|chiếm ưu thế}.",
    "Áp lực {bán|xả|chốt lời} dường như đã {cạn kiệt|yếu đi|biến mất} ở vùng {giá này|hỗ trợ|entry này}.",
    "Xu hướng {tăng|đi lên|uptrend} được {củng cố|xác nhận} bởi {volume|thanh khoản} {lớn|đột biến|ổn định}."
];

const closings = [
    "{Chúc|Hy vọng} anh em có một ngày {giao dịch|trading} {thắng lợi|rực rỡ|xanh sàn}!",
    "Quản lý {vốn|rủi ro} là {chìa khóa|bí mật} để {sống sót|thành công|đi đường dài}.",
    "Đừng quên {đặt Stop Loss|cài SL|quản lý lệnh} để bảo vệ {tài khoản|vốn|túi tiền}.",
    "{Hãy luôn|Luôn giữ} tỉnh táo trước mọi {biến động|tin tức|fud} của thị trường."
];

function generateQuestion() {
    const openers = ["{Cho mình hỏi|Thắc mắc chút|Anh em cho ý kiến|Mọi người ơi|Hỏi ngu chút|Xin chỉ giáo}","{Thật lòng mà nói|Chưa hiểu lắm|Đang phân vân|Theo dòng sự kiện}"];
    const topics = ["{mẹo|cách|trick|bí kíp|phương pháp} {đánh|trade|vào lệnh|scalping|hold} {Future|Margin|Spot|Altcoin|Memecoin}","{làm sao để|bí quyết|làm thế nào} {giữ vững tâm lý|kiềm chế cảm xúc|không fomo|quản lý vốn|về bờ}","{kinh nghiệm|dấu hiệu} {check|soi|lọc|đánh giá} {dự án|token|coin} {rug-pull|scam|xịn|tiềm năng}"];
    const contexts = ["{hiệu quả nhất|tối ưu nhất|an toàn nhất|ít rủi ro nhất}","{trong mùa uptrend|khi thị trường sập|lúc sideway|để tối ưu lợi nhuận}"];
    const closers = ["{Có ai đang áp dụng không?|Xin các cao nhân chỉ giáo.|Anh em chia sẻ đi.}","{Cảm ơn anh em trước.|Comment bên dưới nhé!|Chúc ae may mắn.}"];
    return spin(`{${openers.join('|')}} {${topics.join('|')}} {${contexts.join('|')}}? {${closers.join('|')}}`);
}

// --- LOGIC TRÌNH DUYỆT ---
async function initBrowser(show = false) {
    if (context) {
        try { return context; } catch (e) { context = null; }
    }
    context = await chromium.launchPersistentContext(userDataDir, {
        headless: !show,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox']
    });
    return context;
}

async function humanType(page, text) {
    for (const char of text) {
        await page.keyboard.type(char, { delay: Math.floor(Math.random() * 70) + 30 });
    }
}

// --- CHƯƠNG TRÌNH CHÍNH ---
async function postTask() {
    if (!isRunning) return;
    let page;
    try {
        const ctx = await initBrowser(false);
        page = await ctx.newPage();
        await page.goto('https://www.binance.com/vi/square', { waitUntil: 'networkidle', timeout: 60000 });

        let contentText = "";
        let coinName = "";

        if (totalPosts > 0 && totalPosts % 4 === 0) {
            contentText = generateQuestion();
            coinName = "Thảo luận";
        } else {
            const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
            const coin = res.data[Math.floor(Math.random() * 30)];
            coinName = coin.symbol.replace('USDT', '');
            const intro = spin(intros[Math.floor(Math.random() * intros.length)]).replace(/COIN/g, coinName);
            const body = spin(bodies[Math.floor(Math.random() * bodies.length)]);
            const closing = spin(closings[Math.floor(Math.random() * closings.length)]);
            contentText = `🔥 [SIGNAL]: ${coinName}\n\n${intro}\n\n${body}\n\n📍 Giá hiện tại: ${coin.lastPrice}\n\n${closing}\n\n$${coinName} #Binance #Crypto`;
        }

        const box = await page.locator('div[contenteditable="true"]').first();
        await box.click();
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await humanType(page, contentText);

        const btn = page.locator('button').filter({ hasText: /^Đăng$|^Post$/ }).last();
        if (await btn.isEnabled()) {
            await btn.click();
            totalPosts++;
            history.unshift({ coin: coinName, time: new Date().toLocaleTimeString(), status: 'Thành công' });
            if (history.length > 10) history.pop();
        }
        
        await page.close(); // Đóng page sau khi xong để nhẹ RAM
        const sleep = Math.floor(Math.random() * 60 + 40) * 1000;
        setTimeout(postTask, sleep);

    } catch (err) {
        console.error("Lỗi Post:", err.message);
        if (page) await page.close();
        setTimeout(postTask, 10000);
    }
}

// --- SERVER CONTROL ---
app.get('/', (req, res) => {
    res.send(`<html><body style="background:#0b0e11;color:#fff;font-family:sans-serif;padding:50px">
        <h1>Binance Squad Control</h1>
        <button onclick="fetch('/login')" style="padding:10px;background:#fcd535">1. ĐĂNG NHẬP</button>
        <button onclick="fetch('/start')" style="padding:10px;background:#0ecb81">2. BẮT ĐẦU</button>
        <button onclick="fetch('/stop')" style="padding:10px;background:#f6465d">DỪNG</button>
        <div id="status">Đang tải...</div>
        <script>
            setInterval(async () => {
                const r = await fetch('/stats');
                const d = await r.json();
                document.getElementById('status').innerHTML = "<h3>Tổng post: " + d.totalPosts + "</h3><p>Trạng thái: " + (d.isRunning ? "Chạy" : "Dừng") + "</p>";
            }, 2000);
        </script>
    </body></html>`);
});

app.get('/login', async (req, res) => {
    if (context) await context.close();
    const ctx = await initBrowser(true);
    const p = await ctx.newPage();
    await p.goto('https://www.binance.com/vi/square');
    res.send("Đã mở trình duyệt. Hãy đăng nhập rồi ĐỂ NGUYÊN đó.");
});

app.get('/start', (req, res) => { if(!isRunning){ isRunning = true; postTask(); } res.send("Started"); });
app.get('/stop', (req, res) => { isRunning = false; res.send("Stopped"); });
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));

app.listen(port, () => console.log(`Bot running on port ${port}`));
