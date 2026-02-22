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
// 1. KHO DỮ LIỆU ĐẦY ĐỦ 1.200 CÂU (300 x 4)
// ==========================================

const intros = Array.from({ length: 300 }, (_, i) => {
    const list = [
        "Điểm tin nhanh về biến động của COIN.", "Anh em đã thấy cú move này của COIN chưa?", "Nhìn lại chart COIN hôm nay có nhiều điều thú vị.", 
        "Cập nhật trạng thái mới nhất cho mã COIN.", "Dòng tiền đang đổ dồn sự chú ý vào COIN.", "Phân tích nhanh vị thế của COIN lúc này.", 
        "Liệu COIN có chuẩn bị cho một cú bứt phá?", "Góc nhìn cá nhân về hướng đi của COIN.", "Sức nóng của COIN trên Square vẫn chưa hạ nhiệt.", 
        "Đừng bỏ qua diễn biến hiện tại của COIN.", "COIN đang cho thấy sức mạnh đáng kinh ngạc.", "Vùng giá này của COIN cực kỳ nhạy cảm."
    ];
    return list[i % list.length].replace("COIN", "COIN") + (i > 15 ? ` (Phân tích mã hiệu ${i})` : "");
});

const bodies = Array.from({ length: 300 }, (_, i) => {
    const list = [
        "Giá hiện tại đang neo đậu tại mức ổn định.", "Cấu trúc nến cho thấy phe bò đang kiểm soát.", "Áp lực bán dường như đã cạn kiệt ở vùng này.", 
        "Xu hướng tăng được củng cố bởi khối lượng giao dịch.", "Mô hình hai đáy đang dần hình thành trên đồ thị.", "Giá đang tích lũy trong một biên độ hẹp.", 
        "Biến động CHANGE% tạo ra biên độ dao động lớn.", "Các chỉ báo kỹ thuật đang tiến sát vùng quá mua.", "Kháng cự ngắn hạn đang ngăn cả đà tăng trưởng.", 
        "Lực cầu bắt đáy xuất hiện mạnh mẽ khi giá giảm.", "Đường EMA vừa cắt lên báo hiệu xu hướng mới.", "RSI đang ở mức hỗ trợ, cơ hội gom tốt."
    ];
    return list[i % list.length] + (i > 15 ? ` Dấu hiệu thị trường số ${i}.` : "");
});

const closings = Array.from({ length: 300 }, (_, i) => {
    const list = [
        "Chúc anh em có một ngày giao dịch thắng lợi!", "Quản lý vốn là chìa khóa để sống sót lâu dài.", "Đừng quên đặt Stop Loss để bảo vệ tài khoản.", 
        "Hãy luôn tỉnh táo trước mọi biến động.", "Lợi nhuận sẽ đến với người kiên nhẫn.", "Kỷ luật thép sẽ tạo nên lợi nhuận bền vững.",
        "Hẹn gặp lại anh em ở target cao hơn.", "Đừng Fomo nếu bạn chưa có vị thế tốt.", "Chúc anh em về bờ rực rỡ nhịp này!", "Hãy trade bằng cái đầu lạnh nhé."
    ];
    return list[i % list.length] + (i > 15 ? ` [Kỷ luật giao dịch ${i}]` : "");
});

const cryptoQuestions = Array.from({ length: 300 }, (_, i) => {
    const list = [
        "Theo anh em, trick nào để săn memecoin hiệu quả nhất hiện nay?", "Tip cho người mới: Đừng bao giờ all-in vào một lệnh.", 
        "Làm sao để check được một dự án có phải rug-pull hay không?", "Anh em thường dùng chỉ báo kỹ thuật nào? RSI, MACD hay cứ nến thuần?", 
        "Cách quản lý vốn khi chơi Future để không bị cháy tài khoản nhanh nhất là gì?", "BTC lên 100k anh em làm gì đầu tiên?", 
        "Mọi người đang dùng ví lạnh loại nào an toàn nhất?", "Có nên bỏ việc để làm trader full-time lúc này?"
    ];
    return list[i % list.length] + (i > 15 ? ` - Câu hỏi thảo luận ${i}` : "");
});

// ==========================================
// 2. CÁC HÀM TIỆN ÍCH & GIẢ LẬP NGƯỜI DÙNG
// ==========================================

function logStep(msg) { console.log(`[${new Date().toLocaleTimeString()}] ➡️ ${msg}`); }

async function killChrome() {
    try {
        if (process.platform === 'win32') execSync('taskkill /F /IM chrome.exe /T 2>nul || exit 0');
        else execSync('pkill -f chromium || true');
    } catch (e) {}
}

async function humanIdle(page, minSecond, maxSecond) {
    const duration = Math.floor(Math.random() * (maxSecond - minSecond + 1) + minSecond);
    logStep(`⏳ Nghỉ giả lập trong ${duration} giây...`);
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
        await page.keyboard.type(char, { delay: Math.floor(Math.random() * 100) + 50 });
        if (Math.random() > 0.96) await page.waitForTimeout(400);
    }
}

function smartRound(price) {
    const p = parseFloat(price);
    if (p > 1000) return Math.round(p / 10) * 10;
    if (p > 1) return Math.round(p * 100) / 100;
    return Math.round(p * 10000) / 10000;
}

// ==========================================
// 3. LOGIC ĐĂNG BÀI
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
        let useTags = true;
        let tags = { dollar: [], hash: [] };

        if (totalPosts > 0 && totalPosts % 4 === 0) {
            content = cryptoQuestions[Math.floor(Math.random() * 300)];
            useTags = false;
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
            
            content = `🔥 [MARKET SIGNAL]: ${c.symbol}\n\n${intro}\n\n${body}\n\n📍 ENTRY: ${smartRound(c.price)}\n\n${closing}`;
            tags.dollar = [c.symbol, "BTC"];
            tags.hash = [c.symbol, "BinanceSquare"];
        }

        const textbox = mainPage.locator('div[contenteditable="true"]').first();
        await textbox.click();
        await mainPage.keyboard.press('Control+A');
        await mainPage.keyboard.press('Backspace');

        await humanType(mainPage, content);

        if (useTags) {
            await mainPage.keyboard.press('Enter');
            for (const s of tags.dollar) { await humanType(mainPage, ` $${s}`); await mainPage.keyboard.press('Enter'); }
            for (const s of tags.hash) { await humanType(mainPage, ` #${s}`); await mainPage.keyboard.press('Enter'); }
        }

        const btn = mainPage.locator('button').filter({ hasText: /^Đăng$|^Post$/ }).last();
        if (await btn.isEnabled()) {
            await btn.click();
            totalPosts++;
            history.unshift({ time: new Date().toLocaleTimeString(), status: `Thành công bài ${totalPosts}` });
            await humanIdle(mainPage, 40, 90);
        }
    } catch (err) {
        logStep(`Lỗi: ${err.message}`);
        context = null; mainPage = null;
        await new Promise(r => setTimeout(r, 10000));
    }
    if (isRunning) postTask();
}

// ==========================================
// 4. GIAO DIỆN & API (FIX REMOTE ACCESS)
// ==========================================

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <title>BOT SQUARE CONTROL</title>
        <style>
            body { background: #0b0e11; color: #eaecef; font-family: sans-serif; text-align: center; }
            .container { padding: 40px; max-width: 500px; margin: auto; }
            .btn { width: 100%; padding: 15px; margin: 10px 0; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 16px; }
            .login { background: #f0b90b; color: #000; }
            .start { background: #2ebd85; color: #fff; }
            .stop { background: #f6465d; color: #fff; }
            #history { text-align: left; background: #1e2329; padding: 15px; border-radius: 8px; height: 150px; overflow-y: auto; margin-top: 20px; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>BOT SQUAD CONTROL</h1>
            <div id="status">Đang tải dữ liệu...</div>
            <button class="btn login" onclick="call('/login')">1. MỞ CHROME LOGIN</button>
            <button class="btn start" onclick="call('/start')">2. CHẠY BOT</button>
            <button class="btn stop" onclick="call('/stop')">3. DỪNG BOT</button>
            <div id="history"></div>
        </div>
        <script>
            function call(url) { fetch(url).then(r => r.json()).then(d => alert(d.msg)); }
            setInterval(() => {
                fetch('/stats').then(r => r.json()).then(data => {
                    document.getElementById('status').innerText = (data.isRunning ? '🟢 ĐANG CHẠY' : '🔴 ĐANG DỪNG') + ' | Tổng: ' + data.totalPosts;
                    document.getElementById('history').innerHTML = data.history.map(h => '<div>[' + h.time + '] ' + h.status + '</div>').join('');
                });
            }, 2000);
        </script>
    </body>
    </html>
    `);
});

app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history }));

app.get('/login', async (req, res) => {
    isRunning = false;
    await killChrome();
    chromium.launchPersistentContext(userDataDir, { headless: false }).then(async (ctx) => {
        context = ctx;
        mainPage = await context.newPage();
        await mainPage.goto('https://www.binance.com/vi/square');
    });
    res.json({ msg: "Chrome đã bật trên máy BOT. Hãy Login!" });
});

app.get('/start', (req, res) => {
    if (!isRunning) { isRunning = true; postTask(); }
    res.json({ msg: "Bot đã bắt đầu." });
});

app.get('/stop', (req, res) => {
    isRunning = false;
    res.json({ msg: "Đã dừng lệnh." });
});

app.listen(port, '0.0.0.0', () => logStep(`TRUY CẬP TỪ XA: http://localhost:${port}`));
