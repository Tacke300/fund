import { chromium as playwrightChromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

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
let mainPage = null;
let coinQueue = [];

// ==========================================
// 1. KHO DỮ LIỆU FULL 1.200 CÂU (300 x 4)
// ==========================================

const intros = Array.from({ length: 300 }, (_, i) => {
    const base = [
        "Soi kèo nhanh mã COIN cho anh em.", "COIN đang có tín hiệu khá đẹp trên chart.", "Cập nhật vùng giá quan trọng của COIN.", 
        "Dòng tiền lớn đang đổ vào COIN.", "Anh em đã lên tàu COIN chưa?", "Nhìn qua đồ thị COIN thấy có biến.", 
        "COIN vừa có cú rút chân cực mạnh.", "Phân tích nhanh xu hướng COIN sắp tới.", "Cơ hội cho anh em lướt sóng mã COIN.", 
        "Cá mập vừa di chuyển lượng lớn COIN.", "Sức nóng mã COIN đang tăng dần.", "COIN phá vỡ vùng tích lũy."
    ];
    return base[i % base.length].replace("COIN", "COIN") + (i > 20 ? ` (Mã số ${i})` : "");
});

const bodies = Array.from({ length: 300 }, (_, i) => {
    const base = [
        "Giá hiện tại đang neo đậu tại mức ổn định.", "Cấu trúc nến cho thấy phe bò đang kiểm soát.", "Áp lực bán dường như đã cạn kiệt ở vùng này.", 
        "Xu hướng tăng được củng cố bởi khối lượng giao dịch.", "Mô hình hai đáy đang dần hình thành trên đồ thị.", "Giá đang tích lũy trong một biên độ hẹp.", 
        "Biến động CHANGE% tạo ra biên độ dao động lớn.", "Các chỉ báo kỹ thuật đang tiến sát vùng quá mua.", "Kháng cự ngắn hạn đang ngăn cả đà tăng trưởng.", 
        "Lực cầu bắt đáy xuất hiện mạnh mẽ khi giá giảm."
    ];
    return base[i % base.length] + (i > 20 ? ` Khung H4 đang cho tín hiệu tốt thứ ${i}.` : "");
});

const closings = Array.from({ length: 300 }, (_, i) => {
    const base = [
        "Chúc anh em có một ngày giao dịch thắng lợi!", "Quản lý vốn là chìa khóa để sống sót lâu dài.", "Đừng quên đặt Stop Loss để bảo vệ tài khoản.", 
        "Hãy luôn tỉnh táo trước mọi biến động.", "Lợi nhuận sẽ đến với người kiên nhẫn.", "Kỷ luật thép sẽ tạo nên lợi nhuận bền vững.",
        "Hẹn gặp lại anh em ở target cao hơn.", "Đừng Fomo nếu bạn chưa có vị thế tốt."
    ];
    return base[i % base.length] + (i > 20 ? ` [Kỷ luật số ${i}]` : "");
});

const cryptoQuestions = Array.from({ length: 300 }, (_, i) => {
    const base = [
        "Theo anh em, trick nào để săn memecoin hiệu quả nhất hiện nay?", "Tip cho người mới: Đừng bao giờ all-in vào một lệnh.", 
        "Làm sao để check được một dự án có phải rug-pull hay không?", "Anh em thường dùng chỉ báo kỹ thuật nào? RSI hay MACD?", 
        "Cách quản lý vốn khi chơi Future để không bị cháy tài khoản?", "BTC lên 100k anh em sẽ làm gì đầu tiên?"
    ];
    return base[i % base.length] + (i > 20 ? ` Thảo luận phiên số ${i}.` : "");
});

// ==========================================
// 2. LOGIC XỬ LÝ TRÌNH DUYỆT & GÕ PHÍM
// ==========================================

async function killChrome() {
    try {
        if (process.platform === 'win32') execSync('taskkill /F /IM chrome.exe /T 2>nul || exit 0');
        else execSync('pkill -f chromium || true');
    } catch (e) {}
}

async function humanType(page, text) {
    for (const char of text) {
        await page.keyboard.type(char, { delay: Math.floor(Math.random() * 100) + 50 });
    }
}

function smartRound(price) {
    const p = parseFloat(price);
    if (p > 1000) return Math.round(p / 10) * 10;
    if (p > 1) return Math.round(p * 100) / 100;
    return Math.round(p * 10000) / 10000;
}

// ==========================================
// 3. HÀM ĐĂNG BÀI CHÍNH
// ==========================================

async function postTask() {
    if (!isRunning) return;
    try {
        if (!context) {
            context = await chromium.launchPersistentContext(userDataDir, {
                headless: false,
                args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
            });
        }
        if (!mainPage || mainPage.isClosed()) {
            mainPage = await context.newPage();
            await mainPage.goto('https://www.binance.com/vi/square', { waitUntil: 'domcontentloaded' });
        }

        let content = "";
        if (totalPosts > 0 && totalPosts % 4 === 0) {
            content = cryptoQuestions[Math.floor(Math.random() * 300)];
        } else {
            if (coinQueue.length === 0) {
                const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
                coinQueue = res.data.filter(c => c.symbol.endsWith('USDT')).map(c => ({
                    symbol: c.symbol.replace('USDT', ''), price: c.lastPrice, change: c.priceChangePercent
                })).sort(() => 0.5 - Math.random());
            }
            const c = coinQueue.shift();
            const intro = intros[Math.floor(Math.random() * 300)].replace("COIN", c.symbol);
            const body = bodies[Math.floor(Math.random() * 300)].replace("CHANGE%", `${c.change}%`);
            const closing = closings[Math.floor(Math.random() * 300)];
            content = `🔥 [MARKET SIGNAL]: ${c.symbol}\n\n${intro}\n\n${body}\n\n📍 ENTRY: ${smartRound(c.price)}\n\n${closing}\n\n$${c.symbol} #BinanceSquare`;
        }

        const textbox = mainPage.locator('div[contenteditable="true"]').first();
        await textbox.click();
        await mainPage.keyboard.press('Control+A');
        await mainPage.keyboard.press('Backspace');
        await humanType(mainPage, content);

        const btn = mainPage.locator('button').filter({ hasText: /^Đăng$|^Post$/ }).last();
        if (await btn.isEnabled()) {
            await btn.click();
            totalPosts++;
            history.unshift({ time: new Date().toLocaleTimeString(), status: 'Thành công' });
            console.log(`✅ Bài số ${totalPosts} thành công.`);
            await new Promise(r => setTimeout(r, (Math.floor(Math.random() * 60) + 60) * 1000));
        }
    } catch (err) {
        console.log(`❌ Lỗi: ${err.message}`);
        context = null; mainPage = null; // Reset để vòng sau khởi tạo lại
        await new Promise(r => setTimeout(r, 10000));
    }
    if (isRunning) postTask();
}

// ==========================================
// 4. GIAO DIỆN HTML TRONG JS
// ==========================================

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Binance Square Bot</title>
        <style>
            body { background: #0b0e11; color: #eaecef; font-family: Arial; text-align: center; padding: 50px; }
            .btn { padding: 15px 30px; margin: 10px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; }
            .start { background: #2ebd85; color: white; }
            .stop { background: #f6465d; color: white; }
            .login { background: #f0b90b; color: #0b0e11; }
            #status { font-size: 24px; margin-bottom: 20px; }
            .log { background: #1e2329; padding: 10px; border-radius: 5px; width: 300px; margin: 20px auto; text-align: left; }
        </style>
    </head>
    <body>
        <h1>🤖 BINANCE SQUARE AUTO-POST</h1>
        <div id="status">Đang tải...</div>
        <button class="btn login" onclick="location.href='/login'">1. ĐĂNG NHẬP (MỞ CHROME)</button><br>
        <button class="btn start" onclick="fetch('/start')">2. BẮT ĐẦU CHẠY</button>
        <button class="btn stop" onclick="fetch('/stop')">3. DỪNG LẠI</button>
        <div class="log" id="history"></div>

        <script>
            setInterval(() => {
                fetch('/stats').then(r => r.json()).then(data => {
                    document.getElementById('status').innerText = 'Trạng thái: ' + (data.isRunning ? 'ĐANG CHẠY' : 'DỪNG') + ' | Tổng bài: ' + data.totalPosts;
                    document.getElementById('history').innerHTML = data.history.map(h => '<div>[' + h.time + '] ' + h.status + '</div>').join('');
                });
            }, 2000);
        </script>
    </body>
    </html>
    `);
});

app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history }));
app.get('/start', (req, res) => { if (!isRunning) { isRunning = true; postTask(); } res.json({s:1}); });
app.get('/stop', (req, res) => { isRunning = false; res.json({s:1}); });
app.get('/login', async (req, res) => {
    await killChrome();
    context = await chromium.launchPersistentContext(userDataDir, { headless: false });
    mainPage = await context.newPage();
    await mainPage.goto('https://www.binance.com/vi/square');
    res.send("<h2>Chrome đã mở, hãy đăng nhập rồi quay lại tab cũ bấm Start.</h2>");
});

app.listen(port, () => console.log(`🚀 Bot live: http://localhost:${port}`));
