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

// --- HÀM SPIN ĐỆ QUY SIÊU CẤP ---
function spin(text) {
    let spun = text.replace(/\{([^{}]+)\}/g, (match, target) => {
        const choices = target.split('|');
        return choices[Math.floor(Math.random() * choices.length)];
    });
    if (spun.includes('{')) return spin(spun); 
    return spun;
}

// --- 1. SIÊU KHO SIGNAL (TĂNG CƯỜNG 100+ CỤM TỪ) ---
const intros = [
    "{🔥|🚀|📊|💎|⚡|📈|🔔} {Điểm tin|Cập nhật|Soi nhanh|Review|Nhìn lại|Góc nhìn|Phân tích|Check|Lọc kèo|Báo động|Quan sát|Theo dõi|Nhận định|Soi chart|Check biến|Cập nhật nhanh|Tin nóng|Vừa phát hiện|Quét tín hiệu} {nhanh|mới nhất|chi tiết|cực nóng|quan trọng|về|hôm nay|thời điểm này|cho anh em|cho cả nhà|vừa xong} của {mã |đồng |token |}COIN.",
    "{Anh em|Mọi người|Cả nhà|Các trader|Các sếp|Quý nhà đầu tư|Dân chơi crypto|Sói già Square|Cộng đồng trading|Các đồng chí|Mấy ông giáo} đã {thấy|quan sát|để ý|kịp nhận ra|soi được|biết tin|check qua|thấy biến} cú {move|đi|nhảy|pump|dump|sóng|biến động|nhịp chạy|vòng chạy|pha bay|pha sập} {bất ngờ|mạnh mẽ|đáng chú ý|khét|lạ|đẹp|ảo|kinh hoàng|ngoạn mục} này của COIN chưa?",
    "{Cấu trúc|Đồ thị|Chart|Hành vi giá|Nến|Vị thế|Khung giá|Mô hình|Xu hướng|Đường giá} COIN {hôm nay|hiện tại|trong khung H4|vừa xong|mới nhất|phiên này|vừa đóng nến|đang nén|đang chạy} có nhiều {điểm thú vị|thứ để nói|tín hiệu lạ|vấn đề cần bàn|kèo thơm|biến số|cơ hội|rủi ro|điểm sáng|cạm bẫy}.",
    "{Dòng tiền|Volume|Sức mua|Lực cầu|Thanh khoản|Whale|Cá mập|Lực gom|Smart Money} đang {đổ dồn|tập trung|chú ý|tìm đến|chảy mạnh|gom mạnh|quan tâm đặc biệt|đẩy mạnh} vào COIN {rất mạnh|khá lớn|đáng kinh ngạc|một cách âm thầm|quyết liệt|vượt kỳ vọng|đột biến|cực căng}.",
    "{Góc nhìn|Nhận định|Đánh giá|View|Kế hoạch|Phân tích|Chia sẻ|Ý kiến|Gợi ý} {cá nhân|kỹ thuật|khách quan|ngắn hạn|dài hạn|chủ quan|thực chiến|nhanh} về {hướng đi|xu hướng|vị thế|target|vùng giá|động thái|nhịp hồi|sức mạnh} của COIN {lúc này|hiện tại|trong 24h tới|sắp tới|giai đoạn này|phiên tới}."
];

const bodies = [
    "Giá {hiện tại|lúc này|thời điểm này|vùng này} đang {neo đậu|tích lũy|giữ chân|đi ngang|sideway|nén lại|chờ đợi|giữ giá|test lại|tranh chấp} tại {vùng|khu vực|mức|điểm|ngưỡng} {ổn định|quan trọng|vàng|hỗ trợ cứng|nhạy cảm|thanh khoản|breakout|cản cứng}.",
    "{Cấu trúc nến|Hành động giá|Phe bò|Lực mua|Thị trường|Lực cầu|Bên Long|Cá voi} cho thấy {bên mua|phe Long|lực cầu|whale|tay to|lực bắt đáy|phe bull} đang {kiểm soát|áp đảo|chiếm ưu thế|thắng thế|gom hàng|đẩy giá|muốn phá đỉnh|giữ nhịp} {hoàn toàn|mạnh mẽ|quyết liệt|rõ rệt|tuyệt đối|đáng kể}.",
    "Áp lực {bán|xả|cung|chốt lời|phân phối|phe Gấu|phe Short} dường như đã {cạn kiệt|yếu đi|biến mất|giảm nhiệt|bị hấp thụ|dừng lại|chững lại|đạt đỉnh} ở {vùng|mức|quanh|khu vực} {giá này|hỗ trợ|entry này|đáy|vùng cầu|vùng giá thấp}.",
    "Xu hướng {tăng|đi lên|uptrend|hồi phục|bứt phá|phi mã|bay cao} được {củng cố|xác nhận|bảo chứng|hỗ trợ|đẩy mạnh|nuôi dưỡng} bởi {khối lượng|volume|thanh khoản|dòng tiền|lực mua} {lớn|đột biến|ổn định|duy trì|cực khủng|hợp lệ|ổn áp}.",
    "{Mô hình|Cấu trúc|Setup|Kịch bản|Dấu hiệu|Tín hiệu} {hai đáy|tích lũy|vai đầu vai ngược|cờ tăng|breakout|nêm|tam giác|đảo chiều|tiếp diễn} đang {dần hình thành|xác nhận|chạy đẹp|rất chuẩn|được kích hoạt|có triển vọng|khá nét}."
];

const closings = [
    "{Chúc|Hy vọng|Mong} anh em có một ngày {giao dịch|trading|làm việc|săn kèo} {thắng lợi|rực rỡ|xanh sàn|bùng nổ|đại thắng|thuận lợi|may mắn|bội thu}!",
    "Quản lý {vốn|rủi ro|tài khoản|lệnh|túi tiền} là {chìa khóa|yếu tố cốt lõi|bí mật|ưu tiên số 1|con đường|nguyên tắc vàng} để {sống sót|thành công|giàu có|đi đường dài|bền vững|về bờ}.",
    "Đừng quên {đặt Stop Loss|cài SL|quản lý lệnh|set chốt lỗ|kỷ luật|bảo vệ tài khoản} để bảo vệ {tài khoản|vốn|túi tiền|thành quả|lợi nhuận|thành quả} {của mình|nhé|an toàn|trước sóng gió|mọi lúc}.",
    "{Hãy luôn|Luôn giữ|Cần giữ|Nên giữ|Cố gắng giữ} tỉnh táo trước mọi {biến động|con sóng|tin tức|fud|cú lừa|fakeout|sóng gió} của thị trường {khốc liệt|đầy cạm bẫy|đầy rủi ro|này}.",
    "{Lợi nhuận|Thành công|Tiền bạc|Kèo thơm|Quả ngọt} sẽ đến với người {kiên nhẫn|kỷ luật|có kiến thức|biết chờ đợi|biết đủ|có kế hoạch|có chiến thuật}."
];

// --- 2. SIÊU MA TRẬN 1 TRIỆU CÂU HỎI ---
function generateQuestion() {
    const openers = [
        "{Cho mình hỏi|Thắc mắc chút|Anh em cho ý kiến|Cần tư vấn|Mọi người ơi|Hỏi ngu chút|Góc thảo luận|Xin chỉ giáo|Cần các pro giúp|Ae Square ơi|Cần review|Xin kinh nghiệm|Nhờ mọi người soi hộ|Cái này là sao nhỉ|Có ai biết không|Tìm đồng môn|Ai rành vụ này chỉ với}",
        "{Thật lòng mà nói|Chưa hiểu lắm|Đang phân vân|Cần tìm hướng đi|Lang thang thấy|Theo dòng sự kiện|Tiện đây cho hỏi|Có ai để ý|Tò mò chút|Thấy nhiều người bảo|Dạo này thấy lạ|Cho hỏi thật lòng}"
    ];
    const topics = [
        "{mẹo|cách|trick|bí kíp|phương pháp|tư duy|chiến thuật|logic|quy tắc|kinh nghiệm} {đánh|trade|vào lệnh|scalping|hold|lướt|săn|kiếm tiền từ} {Future|Margin|Spot|Altcoin|Memecoin|RWA|AI trend|Layer 2|Sui|Aptos|vốn ít|đòn bẩy cao}",
        "{làm sao để|bí quyết|công thức|làm thế nào|hướng đi|bí kíp} {giữ vững tâm lý|kiềm chế cảm xúc|không fomo|quản lý vốn|về bờ|x2 tài khoản|kỷ luật hơn|gồng lời tốt hơn|không bị cháy lệnh|nhìn ra xu hướng}",
        "{kinh nghiệm|quy trình|dấu hiệu|dấu vết|cách|tài liệu} {check|soi|lọc|đánh giá|phát hiện|nhận biết|thẩm định} {dự án|token|coin|kèo|hàng|gem|mã mới} {rug-pull|scam|xịn|tiềm năng|hidden gem|back bởi whale|sắp sập|sắp x10}",
        "{hiệu quả của|sự kết hợp giữa|cách dùng|tầm quan trọng của|so sánh giữa} {RSI|MACD|EMA|Price Action|Volume|SMC|Fibonacci|Ichimoku|Bollinger Bands|Indicator tự chế}"
    ];
    const contexts = [
        "{hiệu quả nhất|tối ưu nhất|an toàn nhất|ít rủi ro nhất|đỉnh nhất|vững nhất|nhanh nhất|đơn giản nhất|thực chiến nhất}",
        "{trong mùa uptrend|khi thị trường sập|lúc sideway|trong giai đoạn này|để tối ưu lợi nhuận|khi đánh nến khung nhỏ|để không bị cháy túi|cho người mới bắt đầu|khi vốn chỉ có vài trăm đô}"
    ];
    const closers = [
        "{Có ai đang áp dụng không?|Xin các cao nhân chỉ giáo.|Anh em chia sẻ đi.|Liệu có khả thi không?|Cùng thảo luận nhé.|Có ai chung thuyền không?} ",
        "{Đang bế tắc quá.|Mong được chỉ điểm.|Cảm ơn anh em trước.|Comment bên dưới nhé!|Ai đi qua cho xin 1 nhận xét.|Chúc ae may mắn.|Hóng các pro chia sẻ.}"
    ];
    
    return spin(`{${openers.join('|')}} {${topics.join('|')}} {${contexts.join('|')}}? {${closers.join('|')}}`);
}

// --- LOGIC POST VÀ ĐIỀU KHIỂN ---
async function postTask() {
    if (!isRunning) return;
    let page;
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
            coinName = "Thảo luận";
        } else {
            const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
            const coin = res.data[Math.floor(Math.random() * 50)];
            coinName = coin.symbol.replace('USDT', '');
            
            const randomIntro = spin(intros[Math.floor(Math.random() * intros.length)]).replace(/COIN/g, coinName);
            const randomBody = spin(bodies[Math.floor(Math.random() * bodies.length)]);
            const randomClosing = spin(closings[Math.floor(Math.random() * closings.length)]);
            
            contentText = `🔥 [MARKET SIGNAL]: ${coinName}\n\n${randomIntro}\n\n${randomBody}\n\n📍 Giá hiện tại: ${coin.lastPrice}\n\n${randomClosing}\n\n$${coinName} #Binance #CryptoVN`;
        }

        const box = await page.locator('div[contenteditable="true"]').first();
        await box.waitFor({state: 'visible'});
        await box.click();
        await page.keyboard.type(contentText, { delay: 40 });

        const btn = page.locator('button').filter({ hasText: /^Đăng$|^Post$/ }).last();
        if (await btn.isEnabled()) {
            await btn.click();
            totalPosts++;
            history.unshift({ coin: coinName, time: new Date().toLocaleTimeString() });
            console.log(`✅ [${new Date().toLocaleTimeString()}] Đã đăng: ${coinName}`);
        }
        await page.close();
        
        // Thời gian nghỉ ngẫu nhiên 40-100 giây
        setTimeout(postTask, Math.floor(Math.random() * 60000) + 40000);
    } catch (err) {
        console.log("❌ Lỗi Post:", err.message);
        if (page) await page.close();
        setTimeout(postTask, 20000);
    }
}

// --- SERVER HTTP ---
app.get('/', (req, res) => {
    res.send(`<html><body style="background:#0b0e11;color:#fff;font-family:sans-serif;text-align:center;padding:100px">
        <h1>🚀 Binance Squad Bot 500M</h1>
        <div style="margin-bottom:20px">
            <button onclick="location.href='/login'" style="padding:15px;background:#fcd535;font-weight:bold;cursor:pointer;border-radius:10px">1. ĐĂNG NHẬP (MỞ TRÌNH DUYỆT)</button>
        </div>
        <div>
            <button onclick="fetch('/start')" style="padding:15px;background:#0ecb81;color:#fff;font-weight:bold;cursor:pointer;border-radius:10px">2. BẮT ĐẦU AUTO</button>
            <button onclick="fetch('/stop')" style="padding:15px;background:#f6465d;color:#fff;font-weight:bold;cursor:pointer;border-radius:10px">DỪNG</button>
        </div>
        <h2 id="total">Post: 0</h2>
        <div id="logs" style="text-align:left;max-width:400px;margin:auto;color:#848e9c"></div>
        <script>setInterval(async()=>{const r=await fetch('/stats');const d=await r.json();document.getElementById('total').innerText="Tổng Post: "+d.totalPosts;document.getElementById('logs').innerHTML=d.history.map(h=>"<p>"+h.time+" - "+h.coin+"</p>").join('')},2000)</script>
    </body></html>`);
});

app.get('/login', async (req, res) => {
    isRunning = false;
    if (context) { await context.close(); context = null; }
    console.log("🔑 Đang mở trình duyệt đăng nhập...");
    const loginContext = await chromium.launchPersistentContext(userDataDir, { headless: false });
    const p = await loginContext.newPage();
    await p.goto('https://www.binance.com/vi/square');
    res.send("<h2>ĐÃ MỞ TRÌNH DUYỆT ĐĂNG NHẬP!</h2><p>Đăng nhập xong hãy TẮT cửa sổ đó rồi quay lại bấm BẮT ĐẦU.</p>");
});

app.get('/start', async (req, res) => {
    if (context) { await context.close(); context = null; }
    isRunning = true; postTask(); 
    res.send("Started"); 
});

app.get('/stop', async (req, res) => { isRunning = false; if(context){await context.close(); context=null;} res.send("Stopped"); });
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history }));

app.listen(port, () => console.log(`[500M BOT] Port: ${port}`));
