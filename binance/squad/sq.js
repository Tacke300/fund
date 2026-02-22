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

// ==========================================
// 1. KHO NỘI DUNG SIÊU LỚN (X10)
// ==========================================

const intros = [
    "🔥 Cập nhật biến động cực gắt cho mã COIN.", "🚀 Anh em đã chuẩn bị cho cú bay của COIN chưa?",
    "📊 Nhìn lại chart COIN hôm nay, có dấu hiệu gom hàng rõ rệt.", "👀 Đừng rời mắt khỏi mã COIN trong vài giờ tới.",
    "💡 Góc nhìn cá nhân: COIN đang ở vị trí Entry rất đẹp.", "📉 COIN vừa có cú điều chỉnh, là cơ hội hay rủi ro?",
    "💰 Dòng tiền thông minh (Smart Money) đang chảy vào COIN.", "⚡ Tín hiệu Scalping nhanh cho anh em với mã COIN.",
    "🔎 Phân tích kỹ thuật mã COIN: Xu hướng tăng đang hình thành.", "🌟 COIN - Mã tiềm năng nhất trong danh sách theo dõi hôm nay.",
    "🚨 Cảnh báo: COIN đang tiến sát vùng kháng cự quan trọng.", "💎 Vị thế dài hạn cho COIN vẫn đang cực kỳ ổn áp.",
    "🌈 Thị trường xanh tươi, mã COIN cũng không ngoại lệ.", "🔥 Sức nóng của COIN đang lan tỏa khắp cộng đồng Square.",
    "🤖 Bot tín hiệu vừa báo điểm mua cho mã COIN, anh em tham khảo.", "🎯 Mục tiêu ngắn hạn của COIN đã rất gần.",
    "🛡️ Quản lý vốn chặt chẽ khi vào lệnh với COIN lúc này.", "📢 Thông báo: Mã COIN đang có khối lượng giao dịch đột biến.",
    "🔄 Đang có sự chuyển dịch dòng tiền từ BTC sang COIN.", "✨ Sự kiên nhẫn với COIN sẽ sớm được đền đáp."
];

const bodies = [
    "Giá hiện tại đang tích lũy cực chặt trong mô hình tam giác.", "Lực mua (Buy Wall) đang áp đảo hoàn toàn tại vùng hỗ trợ.",
    "Chỉ báo RSI đang cho thấy tín hiệu phân kỳ dương mạnh mẽ.", "Đường EMA 200 vừa được phá vỡ, xác nhận xu hướng tăng dài hạn.",
    "Áp lực bán dường như đã cạn kiệt sau cú rũ bỏ vừa rồi.", "Khối lượng giao dịch (Volume) tăng vọt kèm theo nến rút chân.",
    "Mô hình nến Engulfing xuất hiện ngay tại vùng Entry tiềm năng.", "Biến động CHANGE% cho thấy biên độ dao động đang thu hẹp dần.",
    "Các Market Makers đang đẩy giá COIN đi đúng kịch bản đề ra.", "Cấu trúc thị trường vẫn giữ được Higher Low bền vững.",
    "Vùng thanh khoản phía trên vẫn chưa được khai thác hết.", "Dấu hiệu cá mập đang âm thầm gom hàng mã COIN.",
    "Chỉ số tham lam và sợ hãi đang ở mức trung lập, rất tốt để vào hàng.", "Lệnh Long đang chiếm ưu thế trên bảng lệnh của COIN.",
    "Mô hình cốc tay cầm đang dần hoàn thiện trên khung H4.", "Giá COIN đang bám sát dải trên của Bollinger Bands.",
    "Sự kiện Halving/Update sắp tới sẽ là cú hích lớn cho giá.", "Phân tích On-chain cho thấy lượng COIN rút ra khỏi sàn tăng mạnh.",
    "Hỗ trợ cứng tại vùng Entry đang được bảo vệ cực kỳ nghiêm ngặt.", "Tín hiệu MACD vừa cắt lên, xác nhận đà tăng trưởng mới."
];

const closings = [
    "✅ Chúc anh em có một ngày giao dịch thắng lợi rực rỡ!", "⚠️ Nhắc lại: Luôn luôn đặt Stop Loss để bảo vệ tài khoản.",
    "💎 Kỷ luật là chìa khóa duy nhất để tồn tại trong thị trường này.", "🚀 Hẹn gặp lại anh em ở những mức Target cao hơn!",
    "📈 Anh em thấy kèo này ổn không? Cmt xuống dưới nhé!", "🔥 Hãy tham khảo thêm trước khi đưa ra quyết định cuối cùng.",
    "🍀 Chúc may mắn và gồng lãi thật vững tay nhé anh em!", "💰 Profit không dành cho những người nóng vội.",
    "🤝 Đồng hành cùng cộng đồng để cập nhật thêm nhiều kèo chất.", "📅 Lên kế hoạch giao dịch và hãy bám sát nó.",
    "🎯 Chốt lời không bao giờ sai, hãy biết đủ là đủ.", "⚡ Tốc độ và sự quyết đoán sẽ tạo nên lợi nhuận.",
    "🛡️ Bảo vệ vốn trước khi nghĩ đến việc làm giàu.", "🌈 Chúc anh em một ngày xanh sàn và đầy hưng phấn!",
    "🦾 Kiên định với chiến lược đã đề ra, thành quả sẽ tới.", "🔭 Tầm nhìn dài hạn sẽ giúp bạn vượt qua những biến động ngắn.",
    "🗝️ Kiến thức là sức mạnh, đừng ngừng học hỏi mỗi ngày.", "🥇 Chúc anh em sớm đạt được tự do tài chính!",
    "🌊 Đi theo xu hướng, đừng cố gắng chống lại thị trường.", "🥂 Cheers! Chúc mừng những anh em đã vào được vị thế tốt."
];

const cryptoQuestions = [
    "Theo anh em, memecoin hệ nào sẽ dẫn dắt trend sắp tới?",
    "Anh em thường dùng đòn bẩy bao nhiêu khi đánh Future? x10 hay x50?",
    "Làm sao để tránh bị 'kill Long/Short' trong những lúc thị trường biến động?",
    "Có nên giữ Stablecoin lúc này hay đổi hết sang Altcoin để tối ưu lợi nhuận?",
    "Kinh nghiệm xương máu của anh em khi mới bước chân vào Crypto là gì?",
    "Dự án Layer 2 nào anh em thấy tiềm năng nhất hiện nay? OP, ARB hay ZK?",
    "Anh em chọn lưu trữ coin trên ví sàn hay ví lạnh (Ledger, SafePal)?",
    "Phương pháp DCA có thực sự hiệu quả trong mùa Downtrend không?",
    "Có ai đang bị kẹt lệnh ở vùng đỉnh không? Chia sẻ cho nhẹ lòng nào.",
    "Chỉ báo nào theo anh em là 'thần thánh' nhất? RSI, EMA hay Volume?",
    "Làm thế nào để lọc được các kèo x100 giữa hàng nghìn rác trên Dex?",
    "Anh em nhận định thế nào về tâm lý thị trường hiện tại? Bullish hay Bearish?",
    "App nào anh em dùng để check tin tức nhanh nhất hiện nay?",
    "Nên chốt lời theo mốc Target hay chốt theo cảm nhận thị trường?",
    "Có anh em nào cháy tài khoản vì không đặt Stop Loss chưa?",
    "Săn Airdrop mùa này còn thơm không mọi người?",
    "Kỹ năng quản lý cảm xúc quan trọng thế nào trong Trading?",
    "Làm sao để phân biệt được dự án tiềm năng và dự án 'lùa gà'?",
    "Anh em thích phong cách đánh Scalping (lướt sóng) hay Swing Trading?",
    "Mục tiêu lợi nhuận của anh em trong năm nay là bao nhiêu %?"
];

// ==========================================
// 2. LOGIC XỬ LÝ NỘI DUNG & GIẢ LẬP
// ==========================================

async function humanIdle(page, min, max) {
    if (!page || page.isClosed()) return;
    const duration = Math.floor(Math.random() * (max - min + 1) + min);
    logStep(`⏳ Nghỉ giả lập người trong ${duration} giây...`);
    const endTime = Date.now() + duration * 1000;
    while (Date.now() < endTime) {
        try {
            if (Math.random() > 0.6 && !page.isClosed()) {
                await page.mouse.move(Math.random()*800, Math.random()*600, {steps: 15}).catch(()=>{});
            }
        } catch(e){}
        await new Promise(r => setTimeout(r, 2000));
    }
}

async function humanType(page, text) {
    for (const char of text) {
        await page.keyboard.type(char, { delay: Math.random()*150 + 50 });
        if (Math.random() > 0.97) await page.waitForTimeout(500);
    }
}

function smartRound(price) {
    const p = parseFloat(price);
    if (p > 500) return Math.round(p);
    if (p > 10) return Math.round(p * 10) / 10;
    if (p > 1) return Math.round(p * 100) / 100;
    return Math.round(p * 10000) / 10000;
}

function generateFinalContent(coin, price, change) {
    const entry = smartRound(price);
    const isUp = parseFloat(change) >= 0;
    const tp = smartRound(isUp ? entry * 1.05 : entry * 0.95);
    const sl = smartRound(isUp ? entry * 0.94 : entry * 1.06);

    const intro = intros[Math.floor(Math.random() * intros.length)].replace("COIN", coin);
    const body = bodies[Math.floor(Math.random() * bodies.length)].replace("CHANGE%", `${change}%`);
    const closing = closings[Math.floor(Math.random() * closings.length)];

    return {
        body: `🔥 [SIGNAL]: ${coin}\n\n${intro}\n\n${body}\n\n📍 ENTRY: ${entry}\n🎯 TP: ${tp}\n🛡 SL: ${sl}\n\n${closing}`,
        tags: [`$${coin}`, `$BTC`, `#BinanceSquare`, `#CryptoTrading`]
    };
}

// ==========================================
// 3. LOGIC TRÌNH DUYỆT & SERVER (FIXED)
// ==========================================

async function initBrowser(show = false) {
    if (context) { try { return context; } catch(e) { context = null; } }
    context = await chromium.launchPersistentContext(userDataDir, {
        headless: !show,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    });
    return context;
}

async function ensureMainPage() {
    const ctx = await initBrowser(false);
    if (!mainPage || mainPage.isClosed()) {
        mainPage = await ctx.newPage();
        await mainPage.goto('https://www.binance.com/vi/square', { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    return mainPage;
}

async function postTaskWithForce() {
    if (!isRunning) return;
    let page = null;
    try {
        page = await ensureMainPage();
        let contentText = "";

        if (totalPosts > 0 && totalPosts % 5 === 0) {
            logStep("💡 Đăng bài thảo luận cộng đồng...");
            contentText = cryptoQuestions[Math.floor(Math.random() * cryptoQuestions.length)] + "\n\n#Binance #Discussion";
        } else {
            if (coinQueue.length === 0) {
                const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
                coinQueue = res.data.filter(c => c.symbol.endsWith('USDT')).map(c => ({
                    symbol: c.symbol.replace('USDT', ''), price: c.lastPrice, change: c.priceChangePercent
                })).sort(() => 0.5 - Math.random());
            }
            const coinData = coinQueue.shift();
            const content = generateFinalContent(coinData.symbol, coinData.price, coinData.change);
            contentText = `${content.body}\n\n${content.tags.join(" ")}`;
        }

        const box = await page.locator('div[contenteditable="true"]').first();
        await box.waitFor({state: 'visible'});
        await box.click();
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');

        await humanType(page, contentText);
        await page.waitForTimeout(2000);

        const btn = page.locator('button').filter({ hasText: /^Đăng$|^Post$/ }).last();
        if (await btn.isEnabled()) {
            await btn.click();
            totalPosts++;
            history.unshift({ coin: "Auto", time: new Date().toLocaleTimeString(), status: 'OK' });
            if (history.length > 10) history.pop();
            await humanIdle(page, 20, 100);
        }
    } catch (err) {
        logStep(`❌ Lỗi: ${err.message}`);
        if (err.message.includes('closed')) context = null;
        await new Promise(r => setTimeout(r, 10000));
    }
}

async function startLoop() {
    while (isRunning) { await postTaskWithForce(); }
}

// ==========================================
// 4. GIAO DIỆN ĐIỀU KHIỂN WEB (SIÊU ĐẸP)
// ==========================================

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <title>Control Panel - Binance Square Bot</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { background: #0b0e11; color: #eaecef; font-family: 'Segoe UI', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
            .container { background: #1e2329; padding: 30px; border-radius: 16px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); width: 100%; max-width: 450px; }
            h2 { color: #fcd535; text-align: center; margin-bottom: 25px; }
            .btn { width: 100%; padding: 14px; margin: 10px 0; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; font-size: 15px; }
            .btn-login { background: #fcd535; color: #000; }
            .btn-login:hover { background: #e2bf2f; }
            .btn-start { background: #0ecb81; color: #fff; }
            .btn-start:hover { background: #0ba368; }
            .btn-stop { background: #f6465d; color: #fff; }
            .btn-stop:hover { background: #d93e4f; }
            .status-box { background: #2b3139; padding: 15px; border-radius: 10px; margin-top: 20px; border-left: 4px solid #fcd535; }
            .log-item { font-size: 12px; color: #848e9c; margin-top: 5px; }
        </style>
    </head>
    <body>
        <div class="container">
            <h2>💎 Binance Square Bot</h2>
            <button class="btn btn-login" onclick="cmd('/login')">🔓 MỞ TRÌNH DUYỆT LOGIN</button>
            <button class="btn btn-start" onclick="cmd('/start')">🚀 BẮT ĐẦU CHẠY AUTO</button>
            <button class="btn btn-stop" onclick="cmd('/stop')">🛑 DỪNG BOT LẬP TỨC</button>
            
            <div class="status-box">
                <div id="status-text">Đang kết nối server...</div>
                <div id="stats-detail" style="font-size: 13px; margin-top: 8px;"></div>
                <div id="history-log" class="log-item"></div>
            </div>
        </div>
        <script>
            function cmd(path) { fetch(path).then(r => r.json()).then(d => alert(d.status || d)); }
            setInterval(async () => {
                try {
                    const r = await fetch('/stats');
                    const d = await r.json();
                    document.getElementById('status-text').innerHTML = d.isRunning ? "🟡 Trạng thái: <b>ĐANG CHẠY</b>" : "⚪ Trạng thái: <b>ĐÃ DỪNG</b>";
                    document.getElementById('stats-detail').innerHTML = "📊 Tổng bài đã đăng: <b>" + d.totalPosts + "</b>";
                    if(d.history[0]) document.getElementById('history-log').innerHTML = "🕒 Lần cuối: " + d.history[0].time;
                } catch(e) {}
            }, 3000);
        </script>
    </body>
    </html>
    `);
});

app.get('/login', async (req, res) => {
    isRunning = false;
    if (context) { await context.close().catch(()=>{}); context = null; }
    const ctx = await initBrowser(true);
    await (await ctx.newPage()).goto('https://www.binance.com/vi/square');
    res.json({status: "Đã mở Chrome Login trên máy tính"});
});

app.get('/start', (req, res) => { if(!isRunning) { isRunning = true; startLoop(); } res.json({status: "Đã kích hoạt vòng lặp"}); });
app.get('/stop', async (req, res) => { isRunning = false; res.json({status: "Đã dừng bot"}); });
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));

app.listen(port, '0.0.0.0', () => logStep(`🚀 SERVER MỞ TẠI PORT: ${port}`));
