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

// --- KHO TỪ VỰNG SIÊU KHỔNG LỒ (500M) ---
const intros = [
    "{🔥|🚀|📊|💎|⚡|📈} {Điểm tin|Cập nhật|Soi nhanh|Review|Nhìn lại|Góc nhìn|Phân tích|Check|Lọc kèo|Báo động} {nhanh|mới nhất|chi tiết|cực nóng|quan trọng} về {biến động|hành động giá|tình hình} của {mã |đồng |token |}COIN.",
    "{Anh em|Mọi người|Cả nhà|Các trader|Các sếp|Quý nhà đầu tư|Sói già Square} đã {thấy|quan sát|để ý|kịp nhận ra} cú {move|đi|nhảy|pump|dump|sóng} {bất ngờ|mạnh mẽ|đáng chú ý|khét|lạ} này của COIN chưa?",
    "{Cấu trúc|Đồ thị|Chart|Hành vi giá|Nến|Vị thế} COIN {hôm nay|hiện tại|trong khung H4|vừa xong} có nhiều {điểm thú vị|thứ để nói|tín hiệu lạ|kèo thơm|biến số}.",
    "{Dòng tiền|Volume|Sức mua|Lực cầu|Thanh khoản|Whale} đang {đổ dồn|tập trung|chú ý|tìm đến|chảy mạnh|gom mạnh} vào COIN {rất mạnh|khá lớn|đáng kinh ngạc|một cách âm thầm}.",
    "{Góc nhìn|Nhận định|Đánh giá|View|Kế hoạch} {cá nhân|kỹ thuật|khách quan|ngắn hạn|dài hạn} về {hướng đi|xu hướng|vị thế|target|vùng giá} của COIN {lúc này|hiện tại|trong 24h tới}."
];

const bodies = [
    "Giá {hiện tại|lúc này|thời điểm này} đang {neo đậu|tích lũy|giữ chân|đi ngang|sideway|nén lại} tại {vùng|khu vực|mức} {ổn định|quan trọng|vàng|hỗ trợ cứng|nhạy cảm}.",
    "{Cấu trúc nến|Hành động giá|Phe bò|Lực mua|Thị trường} cho thấy {bên mua|phe Long|lực cầu|whale|tay to} đang {kiểm soát|áp đảo|chiếm ưu thế|thắng thế|gom hàng|đẩy giá} {hoàn toàn|mạnh mẽ|quyết liệt}.",
    "Áp lực {bán|xả|cung|chốt lời|phân phối} dường như đã {cạn kiệt|yếu đi|biến mất|giảm nhiệt|bị hấp thụ|dừng lại} ở {vùng|mức|quanh} {giá này|hỗ trợ|entry này|đáy}.",
    "Xu hướng {tăng|đi lên|uptrend|hồi phục|bứt phá} được {củng cố|xác nhận|bảo chứng|hỗ trợ} bởi {khối lượng|volume|thanh khoản|dòng tiền} {lớn|đột biến|ổn định|duy trì}.",
    "{Mô hình|Cấu trúc|Setup|Kịch bản} {hai đáy|tích lũy|vai đầu vai ngược|cờ tăng|breakout|nêm|tam giác} đang {dần hình thành|xác nhận|chạy đẹp|rất chuẩn|được kích hoạt}."
];

const closings = [
    "{Chúc|Hy vọng} anh em có một ngày {giao dịch|trading|làm việc} {thắng lợi|rực rỡ|xanh sàn|bùng nổ|đại thắng}!",
    "Quản lý {vốn|rủi ro|tài khoản|lệnh} là {chìa khóa|yếu tố cốt lõi|bí mật|ưu tiên số 1} để {sống sót|thành công|giàu có|đi đường dài}.",
    "Đừng quên {đặt Stop Loss|cài SL|quản lý lệnh|set chốt lỗ|kỷ luật} để bảo vệ {tài khoản|vốn|túi tiền|thành quả} {của mình|nhé|an toàn}.",
    "{Hãy luôn|Luôn giữ|Cần giữ|Nên giữ} tỉnh táo trước mọi {biến động|con sóng|tin tức|fud|cú lừa} của thị trường {khốc liệt|này}.",
    "{Lợi nhuận|Thành công|Tiền bạc|Kèo thơm} sẽ đến với người {kiên nhẫn|kỷ luật|có kiến thức|biết chờ đợi|biết đủ}."
];

function generateQuestion() {
    const openers = ["{Cho mình hỏi|Thắc mắc chút|Anh em cho ý kiến|Mọi người ơi|Hỏi ngu chút|Xin chỉ giáo|Cần các pro giúp|Ae Square ơi}","{Thật lòng mà nói|Chưa hiểu lắm|Đang phân vân|Cần tìm hướng đi|Theo dòng sự kiện|Tiện đây cho hỏi}"];
    const topics = ["{mẹo|cách|trick|bí kíp|phương pháp|tư duy} {đánh|trade|vào lệnh|scalping|hold|lướt} {Future|Margin|Spot|Altcoin|Memecoin|Layer 2}","{làm sao để|bí quyết|làm thế nào} {giữ vững tâm lý|kiềm chế cảm xúc|không fomo|quản lý vốn|về bờ|kỷ luật hơn}","{kinh nghiệm|quy trình|dấu hiệu} {check|soi|lọc|đánh giá|phát hiện} {dự án|token|coin|kèo} {rug-pull|scam|xịn|tiềm năng|hidden gem}"];
    const contexts = ["{hiệu quả nhất|tối ưu nhất|an toàn nhất|ít rủi ro nhất|đỉnh nhất}","{trong mùa uptrend|khi thị trường sập|lúc sideway|để tối ưu lợi nhuận|khi đánh nến khung nhỏ}"];
    const closers = ["{Có ai đang áp dụng không?|Xin các cao nhân chỉ giáo.|Anh em chia sẻ ít kinh nghiệm đi.|Cùng thảo luận nhé.}","{Đang bế tắc quá.|Mong được chỉ điểm.|Cảm ơn anh em trước.|Comment bên dưới nhé!|Chúc ae may mắn.}"];
    return spin(`{${openers.join('|')}} {${topics.join('|')}} {${contexts.join('|')}}? {${closers.join('|')}}`);
}

// --- QUẢN LÝ TRÌNH DUYỆT CHỐNG KẸT ---
async function closeBrowser() {
    if (context) {
        try {
            await context.close();
            context = null;
            console.log("Safely closed browser.");
        } catch (e) { context = null; }
    }
}

async function postTask() {
    if (!isRunning) return;
    let page = null;
    try {
        if (!context) {
            context = await chromium.launchPersistentContext(userDataDir, {
                headless: true,
                args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
            });
        }
        page = await context.newPage();
        await page.goto('https://www.binance.com/vi/square', { waitUntil: 'domcontentloaded', timeout: 60000 });

        let contentText = "";
        let coinName = "";

        if (totalPosts > 0 && totalPosts % 4 === 0) {
            contentText = generateQuestion();
            coinName = "Hỏi Đáp";
        } else {
            const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
            const coin = res.data[Math.floor(Math.random() * 50)];
            coinName = coin.symbol.replace('USDT', '');
            contentText = `🔥 [SIGNAL]: ${coinName}\n\n${spin(intros[Math.floor(Math.random() * intros.length)]).replace(/COIN/g, coinName)}\n\n${spin(bodies[Math.floor(Math.random() * bodies.length)])}\n\n📍 Price: ${coin.lastPrice}\n\n${spin(closings[Math.floor(Math.random() * closings.length)])}\n\n$${coinName} #Binance #Crypto`;
        }

        const box = await page.locator('div[contenteditable="true"]').first();
        await box.waitFor({state: 'visible'});
        await box.click();
        await page.keyboard.type(contentText, { delay: 30 });

        const btn = page.locator('button').filter({ hasText: /^Đăng$|^Post$/ }).last();
        if (await btn.isEnabled()) {
            await btn.click();
            totalPosts++;
            history.unshift({ coin: coinName, time: new Date().toLocaleTimeString() });
            console.log(`✅ Đã đăng bài cho ${coinName}`);
        }
        
        await page.close();
        setTimeout(postTask, Math.floor(Math.random() * 60000) + 60000);
    } catch (err) {
        console.log("Error during post:", err.message);
        if (page) await page.close();
        await closeBrowser(); // Đóng hẳn trình duyệt nếu lỗi để reset session
        setTimeout(postTask, 20000);
    }
}

// --- SERVER HTTP ---
app.get('/', (req, res) => {
    res.send(`
    <html><body style="background:#0b0e11;color:#fff;font-family:sans-serif;text-align:center;padding:50px">
        <h1>🚀 Binance Squad Bot (V500M)</h1>
        <div style="border:1px solid #333; padding:20px; border-radius:10px; display:inline-block">
            <p>Bước 1: Click Đăng Nhập -> Nó sẽ mở Chrome hiện ra.</p>
            <button onclick="location.href='/login'" style="padding:15px;background:#fcd535;font-weight:bold;cursor:pointer">ĐĂNG NHẬP THỦ CÔNG</button>
            <p>Bước 2: Sau khi Login xong trên Chrome, <b>TẮT HẲN CỬA SỔ CHROME ĐÓ</b>.</p>
            <p>Bước 3: Quay lại đây bấm Bắt Đầu.</p>
            <button onclick="fetch('/start')" style="padding:15px;background:#0ecb81;color:#fff;font-weight:bold;cursor:pointer">BẮT ĐẦU AUTO</button>
            <button onclick="fetch('/stop')" style="padding:15px;background:#f6465d;color:#fff;font-weight:bold;cursor:pointer">DỪNG</button>
        </div>
        <h2 id="total">Đã đăng: 0</h2>
        <script>setInterval(async()=>{const r=await fetch('/stats');const d=await r.json();document.getElementById('total').innerText="Đã đăng: "+d.totalPosts},2000)</script>
    </body></html>`);
});

app.get('/login', async (req, res) => {
    isRunning = false;
    await closeBrowser(); // Đảm bảo đóng hết session ngầm trước khi mở cửa sổ login
    console.log("Opening login window...");
    const loginContext = await chromium.launchPersistentContext(userDataDir, { headless: false });
    const p = await loginContext.newPage();
    await p.goto('https://www.binance.com/vi/square');
    res.send("ĐÃ MỞ TRÌNH DUYỆT LOGIN. HÃY ĐĂNG NHẬP XONG RỒI TẮT NÓ ĐI RỒI MỚI BẤM START.");
});

app.get('/start', async (req, res) => {
    await closeBrowser(); // Reset session trước khi chạy ngầm
    isRunning = true; 
    postTask(); 
    res.send("Started"); 
});

app.get('/stop', async (req, res) => { isRunning = false; await closeBrowser(); res.send("Stopped"); });
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history }));

app.listen(port, () => console.log(`Bot running at http://localhost:${port}`));
