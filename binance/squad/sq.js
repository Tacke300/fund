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

// --- CƠ CHẾ SPIN ĐA TẦNG ---
function spin(text) {
    let spun = text.replace(/\{([^{}]+)\}/g, function(match, target) {
        const choices = target.split('|');
        return choices[Math.floor(Math.random() * choices.length)];
    });
    if (spun.includes('{')) return spin(spun); 
    return spun;
}

// --- SIÊU KHO TỪ VỰNG (100+ CỤM TỪ) ---
const intros = [
    "{🔥|🚀|📊|💎|⚡} {Điểm tin|Cập nhật|Soi nhanh|Review|Nhìn lại|Góc nhìn|Phân tích|Check|Lọc kèo|Báo động|Quan sát|Theo dõi} {nhanh|mới nhất|chi tiết|cực nóng|quan trọng|về} {biến động|hành động giá|tình hình|vị thế|cấu trúc|nhịp chạy|hướng đi|chart} của {mã |đồng |token |}COIN.",
    "{Anh em|Mọi người|Cả nhà|Cộng đồng|Các trader|Các sếp|Quý nhà đầu tư|Dân chơi crypto|Sói già Square} đã {thấy|quan sát|để ý|kịp nhận ra|soi được|biết tin} cú {move|đi|nhảy|pump|dump|sóng|biến động} {bất ngờ|mạnh mẽ|đáng chú ý|khét|lạ|đẹp|ảo} này của COIN chưa?",
    "{Cấu trúc|Đồ thị|Chart|Hành vi giá|Nến|Vị thế} COIN {hôm nay|hiện tại|trong khung H4|vừa xong|mới nhất|phiên này} có nhiều {điểm thú vị|thứ để nói|tín hiệu lạ|vấn đề cần bàn|kèo thơm|biến số|cơ hội|rủi ro}.",
    "{Dòng tiền|Volume|Sức mua|Lực cầu|Thanh khoản|Whale} đang {đổ dồn|tập trung|chú ý|tìm đến|chảy mạnh|gom mạnh} vào COIN {rất mạnh|khá lớn|đáng kinh ngạc|một cách âm thầm|quyết liệt|vượt kỳ vọng}.",
    "{Góc nhìn|Nhận định|Đánh giá|View|Kế hoạch} {cá nhân|kỹ thuật|khách quan|ngắn hạn|dài hạn} về {hướng đi|xu hướng|vị thế|target|vùng giá|động thái} của COIN {lúc này|hiện tại|trong 24h tới|sắp tới}."
];

const bodies = [
    "Giá {hiện tại|lúc này|thời điểm này} đang {neo đậu|tích lũy|giữ chân|đi ngang|sideway|nén lại} tại {vùng|khu vực|mức} {ổn định|quan trọng|vàng|hỗ trợ cứng|nhạy cảm|thanh khoản}.",
    "{Cấu trúc nến|Hành động giá|Phe bò|Lực mua|Thị trường} cho thấy {bên mua|phe Long|lực cầu|whale|tay to} đang {kiểm soát|áp đảo|chiếm ưu thế|thắng thế|gom hàng|đẩy giá} {hoàn toàn|mạnh mẽ|quyết liệt|rõ rệt}.",
    "Áp lực {bán|xả|cung|chốt lời|phân phối} dường như đã {cạn kiệt|yếu đi|biến mất|giảm nhiệt|bị hấp thụ|dừng lại} ở {vùng|mức|quanh} {giá này|hỗ trợ|entry này|đáy|vùng cầu}.",
    "Xu hướng {tăng|đi lên|uptrend|hồi phục|bứt phá} được {củng cố|xác nhận|bảo chứng|hỗ trợ|đẩy mạnh} bởi {khối lượng|volume|thanh khoản|dòng tiền} {lớn|đột biến|ổn định|duy trì|cực khủng}.",
    "{Mô hình|Cấu trúc|Setup|Kịch bản} {hai đáy|tích lũy|vai đầu vai ngược|cờ tăng|breakout|nêm|tam giác} đang {dần hình thành|xác nhận|chạy đẹp|rất chuẩn|được kích hoạt}."
];

const closings = [
    "{Chúc|Hy vọng} anh em có một ngày {giao dịch|trading|làm việc} {thắng lợi|rực rỡ|xanh sàn|bùng nổ|đại thắng|thuận lợi|may mắn}!",
    "Quản lý {vốn|rủi ro|tài khoản|lệnh} là {chìa khóa|yếu tố cốt lõi|bí mật|ưu tiên số 1|con đường} để {sống sót|thành công|giàu có|đi đường dài|bền vững}.",
    "Đừng quên {đặt Stop Loss|cài SL|quản lý lệnh|set chốt lỗ|kỷ luật} để bảo vệ {tài khoản|vốn|túi tiền|thành quả|lợi nhuận} {của mình|nhé|an toàn|trước sóng gió}.",
    "{Hãy luôn|Luôn giữ|Cần giữ|Nên giữ} tỉnh táo trước mọi {biến động|con sóng|tin tức|fud|cú lừa|fakeout} của thị trường {khốc liệt|đầy cạm bẫy|này}.",
    "{Lợi nhuận|Thành công|Tiền bạc|Kèo thơm} sẽ đến với người {kiên nhẫn|kỷ luật|có kiến thức|biết chờ đợi|biết đủ|có kế hoạch}."
];

function generateQuestion() {
    const openers = ["{Cho mình hỏi|Thắc mắc chút|Anh em cho ý kiến|Cần tư vấn|Mọi người ơi|Hỏi ngu chút|Góc thảo luận|Xin chỉ giáo|Cần các pro giúp|Ae Square ơi|Cần review|Xin kinh nghiệm}","{Thật lòng mà nói|Chưa hiểu lắm|Đang phân vân|Cần tìm hướng đi|Lang thang thấy|Theo dòng sự kiện|Tiện đây cho hỏi|Có ai để ý|Tò mò chút}"];
    const topics = ["{mẹo|cách|trick|bí kíp|phương pháp|tư duy|chiến thuật|logic} {đánh|trade|vào lệnh|scalping|hold|lướt|săn} {Future|Margin|Spot|Altcoin|Memecoin|RWA|AI trend|Layer 2|Sui|Aptos}","{làm sao để|bí quyết|công thức|làm thế nào|hướng đi} {giữ vững tâm lý|kiềm chế cảm xúc|không fomo|quản lý vốn|gồng lời|gồng lỗ|về bờ|x2 tài khoản|kỷ luật hơn}","{kinh nghiệm|quy trình|dấu hiệu|dấu vết} {check|soi|lọc|đánh giá|phát hiện|nhận biết} {dự án|token|coin|kèo|hàng|gem} {rug-pull|scam|xịn|tiềm năng|hidden gem|back bởi whale}","{hiệu quả của|sự kết hợp giữa|cách dùng|tầm quan trọng của} {RSI|MACD|EMA|Price Action|Volume|SMC|Fibonacci|Ichimoku|Bollinger Bands}"];
    const contexts = ["{hiệu quả nhất|tối ưu nhất|an toàn nhất|ít rủi ro nhất|đỉnh nhất|vững nhất|nhanh nhất}","{trong mùa uptrend|khi thị trường sập|lúc sideway|trong giai đoạn này|để tối ưu lợi nhuận|khi đánh nến khung nhỏ|để không bị cháy túi}"];
    const closers = ["{Có ai đang áp dụng không?|Xin các cao nhân chỉ giáo.|Anh em chia sẻ ít kinh nghiệm đi.|Liệu có khả thi không?|Cùng thảo luận nhé.}","{Đang bế tắc quá.|Mong được chỉ điểm.|Cảm ơn anh em trước.|Comment bên dưới nhé!|Ai đi qua cho xin 1 nhận xét.|Chúc ae may mắn.}"];
    
    return spin(`{${openers.join('|')}} {${topics.join('|')}} {${contexts.join('|')}}? {${closers.join('|')}}`);
}

// --- LOGIC XỬ LÝ ---
async function humanType(page, text) {
    for (const char of text) {
        await page.keyboard.type(char, { delay: Math.floor(Math.random() * 100) + 30 });
        if (Math.random() > 0.98) await page.waitForTimeout(400);
    }
}

async function humanIdle(page, min, max) {
    const duration = Math.floor(Math.random() * (max - min + 1) + min);
    const endTime = Date.now() + duration * 1000;
    while (Date.now() < endTime) {
        if (Math.random() > 0.6) await page.mouse.move(Math.random()*800, Math.random()*600, {steps: 5});
        await new Promise(r => setTimeout(r, 2000));
    }
}

function generateFinalContent(coin, price, change) {
    const p = parseFloat(price);
    const entry = p > 1 ? Math.round(p * 100) / 100 : p;
    const intro = spin(intros[Math.floor(Math.random() * intros.length)]).replace(/COIN/g, coin);
    const body = spin(bodies[Math.floor(Math.random() * bodies.length)]).replace(/CHANGE%/g, `${change}%`);
    const closing = spin(closings[Math.floor(Math.random() * closings.length)]);

    return {
        body: `🔥 [SIGNAL]: ${coin}\n\n${intro}\n\n${body}\n\n📍 ENTRY: ${entry}\n\n${closing}`,
        dollarTags: [coin],
        hashTags: [coin, "Binance", "CryptoDaily"]
    };
}

// --- APP ROUTES ---
app.get('/', (req, res) => {
    // Tự động trả về HTML nếu không có file index.html bên ngoài
    res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Binance Square Control</title><style>
        body { background: #0b0e11; color: #eaecef; font-family: sans-serif; padding: 20px; }
        .card { background: #1e2329; border-radius: 10px; padding: 20px; margin-bottom: 20px; border: 1px solid #333; }
        .btn { padding: 10px 20px; border-radius: 5px; cursor: pointer; border: none; font-weight: bold; margin-right: 5px; }
        .btn-login { background: #fcd535; color: #000; }
        .btn-start { background: #0ecb81; color: #fff; }
        .user-info { font-size: 1.2em; color: #fcd535; margin: 10px 0; }
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 10px; border-bottom: 1px solid #333; }
    </style></head>
    <body>
        <h1>🚀 Binance Square Bot</h1>
        <div class="card">
            <button class="btn btn-login" onclick="fetch('/login')">1. Đăng nhập</button>
            <div class="user-info" id="userInfo">Account: --</div>
            <div id="botStatus">Trạng thái: Đang dừng</div>
        </div>
        <div class="card">
            <button class="btn btn-start" onclick="fetch('/start')">BẮT ĐẦU</button>
            <button class="btn" style="background:#f6465d; color:white" onclick="fetch('/stop')">DỪNG</button>
            <h3>Lịch sử (Tổng: <span id="total">0</span>)</h3>
            <table><thead><tr><th>Coin</th><th>Thời gian</th><th>Kết quả</th></tr></thead><tbody id="logs"></tbody></table>
        </div>
        <script>
            setInterval(async () => {
                const res = await fetch('/stats');
                const data = await res.json();
                document.getElementById('total').innerText = data.totalPosts;
                document.getElementById('botStatus').innerText = "Trạng thái: " + (data.isRunning ? "Đang chạy 🟢" : "Đang dừng 🔴");
                document.getElementById('logs').innerHTML = data.history.map(h => "<tr><td>$"+h.coin+"</td><td>"+h.time+"</td><td>Thành công</td></tr>").join('');
            }, 2000);
        </script>
    </body></html>`);
});

app.get('/login', async (req, res) => {
    const ctx = await chromium.launchPersistentContext(userDataDir, { headless: false });
    const page = await ctx.newPage();
    await page.goto('https://www.binance.com/vi/square');
    res.send("Đang mở trình duyệt đăng nhập...");
});

app.get('/start', (req, res) => { isRunning = true; runBot(); res.json({status: 'started'}); });
app.get('/stop', (req, res) => { isRunning = false; res.json({status: 'stopped'}); });
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));

// --- BOT CORE ---
async function runBot() {
    if (!context) context = await chromium.launchPersistentContext(userDataDir, { headless: true });
    const page = await context.newPage();
    await page.goto('https://www.binance.com/vi/square');

    while (isRunning) {
        try {
            let content;
            if (totalPosts > 0 && totalPosts % 4 === 0) {
                content = { body: generateQuestion(), dollarTags: [], hashTags: [] };
            } else {
                const ticker = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
                const coin = ticker.data[Math.floor(Math.random() * 50)];
                content = generateFinalContent(coin.symbol.replace('USDT',''), coin.lastPrice, coin.priceChangePercent);
            }

            const box = await page.locator('div[contenteditable="true"]').first();
            await box.click();
            await humanType(page, content.body);

            if (content.dollarTags.length > 0) {
                await page.keyboard.press('Enter');
                await humanType(page, `$${content.dollarTags[0]} #${content.hashTags[0]} #Crypto`);
            }

            const btn = page.locator('button').filter({ hasText: /^Đăng$|^Post$/ }).last();
            if (await btn.isEnabled()) {
                await btn.click();
                totalPosts++;
                history.unshift({ coin: content.dollarTags[0] || "Hỏi đáp", time: new Date().toLocaleTimeString() });
                if (history.length > 10) history.pop();
                await humanIdle(page, 30, 90);
            }
        } catch (e) {
            await page.reload();
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

app.listen(port, () => console.log(`Server chạy tại: http://localhost:${port}`));
