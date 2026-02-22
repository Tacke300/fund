import { chromium as playwrightChromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

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
let coinQueue = [];

function logStep(msg) {
    console.log(`[${new Date().toLocaleTimeString()}] ➡️ ${msg}`);
}

// Hàm này để diệt sạch Chrome đang chạy ngầm, giải phóng thư mục session
function killOldChrome() {
    return new Promise((resolve) => {
        exec('taskkill /F /IM chrome.exe /T', () => {
            logStep("Đã dọn dẹp các tiến trình Chrome cũ.");
            resolve();
        });
    });
}

// --- KHO NỘI DUNG (GIỮ NGUYÊN GỐC CỦA BẠN) ---
const intros = ["🔥 Cập nhật COIN.", "🚀 Sẵn sàng cho COIN chưa?", "📊 Chart COIN gom hàng.", "👀 Soi kèo COIN.", "💡 Entry COIN đẹp.", "📉 COIN điều chỉnh.", "💰 Tiền vào COIN.", "⚡ Scalping COIN.", "🔎 Xu hướng COIN tăng.", "🌟 COIN tiềm năng.", "🚨 Cản mạnh COIN.", "💎 Hold COIN dài.", "🌈 COIN xanh sàn.", "🔥 Hot Square: COIN.", "🤖 Bot báo mua COIN.", "🎯 Target COIN gần.", "🛡️ Quản lý vốn COIN.", "📢 Vol đột biến COIN.", "🔄 Dòng tiền vào COIN.", "✨ Kiên nhẫn với COIN."];
const bodies = ["Tích lũy chặt tam giác.", "Lực mua áp đảo hỗ trợ.", "RSI phân kỳ dương.", "Phá EMA 200 tăng dài.", "Cạn cung sau rũ.", "Vol tăng nến rút chân.", "Engulfing tại Entry.", "Biên độ CHANGE% thu hẹp.", "MM đẩy đúng bài.", "Cấu trúc Higher Low.", "Chưa quét thanh khoản.", "Cá mập gom hàng.", "Tâm lý trung lập.", "Lệnh Long ưu thế.", "Cốc tay cầm H4.", "Bám Bollinger trên.", "Sắp tin Halving.", "On-chain rút sàn mạnh.", "Hỗ trợ cứng giữ vững.", "MACD vừa cắt lên."];
const closings = ["✅ Thắng lợi rực rỡ!", "⚠️ Nhớ Stop Loss.", "💎 Kỷ luật là vàng.", "🚀 Hẹn ở Target!", "📈 Thấy ổn không?", "🔥 Tham khảo kỹ nhé.", "🍀 Vững tay gồng lãi!", "💰 Đừng nóng vội.", "🤝 Cập nhật kèo.", "📅 Bám sát kế hoạch.", "🎯 Chốt lời không sai.", "⚡ Quyết đoán lên.", "🛡️ Bảo vệ vốn.", "🌈 Xanh sàn hưng phấn!", "🦾 Kiên định nhé.", "🔭 Tầm nhìn dài hạn.", "🗝️ Học hỏi mỗi ngày.", "🥇 Tự do tài chính!", "🌊 Thuận xu hướng.", "🥂 Chúc mừng anh em."];
const cryptoQuestions = ["Trend memecoin nào sắp tới?", "Anh em đánh Future x bao nhiêu?", "Cách tránh kill Long Short?", "Giữ Stable hay Altcoin?", "Kinh nghiệm cho người mới?", "Layer 2 nào tiềm năng?", "Ví sàn hay ví lạnh?", "DCA có ổn không?", "Ai kẹt đỉnh không?", "Chỉ báo nào thần thánh?", "Lọc kèo x100 kiểu gì?", "Bullish hay Bearish?", "App tin tức nào nhanh?", "Chốt mốc hay cảm giác?", "Ai cháy vì ko SL chưa?", "Săn Airdrop thơm ko?", "Quản lý cảm xúc?", "Check dự án scam kiểu gì?", "Scalping hay Swing?", "Mục tiêu % năm nay?"];

function smartRound(price) {
    const p = parseFloat(price);
    if (p > 500) return Math.round(p);
    if (p > 1) return Math.round(p * 100) / 100;
    return Math.round(p * 10000) / 10000;
}

// --- QUẢN LÝ TRÌNH DUYỆT (FIX LỖI TARGET CLOSED) ---
async function getBrowser() {
    if (context) return context;
    context = await chromium.launchPersistentContext(userDataDir, {
        headless: false, // BẮT BUỘC ĐỂ HIỆN TRÊN MÁY TÍNH
        args: ['--start-maximized', '--no-sandbox', '--disable-blink-features=AutomationControlled']
    });
    return context;
}

async function postTaskWithForce() {
    if (!isRunning) return;
    let page = null;
    try {
        const ctx = await getBrowser();
        page = await ctx.newPage();
        
        // Chống lỗi Timeout cho mạng yếu
        page.setDefaultTimeout(60000);

        let contentText = "";
        if (totalPosts > 0 && totalPosts % 5 === 0) {
            contentText = cryptoQuestions[Math.floor(Math.random() * cryptoQuestions.length)] + "\n\n#Binance #Square";
        } else {
            if (coinQueue.length === 0) {
                const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
                coinQueue = res.data.filter(c => c.symbol.endsWith('USDT')).map(c => ({
                    symbol: c.symbol.replace('USDT', ''), price: c.lastPrice, change: c.priceChangePercent
                })).sort(() => 0.5 - Math.random());
            }
            const c = coinQueue.shift();
            const intro = intros[Math.floor(Math.random() * intros.length)].replace("COIN", c.symbol);
            const body = bodies[Math.floor(Math.random() * bodies.length)].replace("CHANGE%", `${c.change}%`);
            const closing = closings[Math.floor(Math.random() * closings.length)];
            contentText = `🔥 [SIGNAL]: ${c.symbol}\n\n${intro}\n\n${body}\n\n📍 ENTRY: ${smartRound(c.price)}\n\n${closing}\n\n$${c.symbol} #Crypto`;
        }

        logStep(`Chuẩn bị đăng bài: ${c?.symbol || 'Thảo luận'}`);
        await page.goto('https://www.binance.com/vi/square', { waitUntil: 'domcontentloaded' });
        
        const box = page.locator('div[contenteditable="true"]').first();
        await box.waitFor({ state: 'visible' });
        await box.click();
        await page.keyboard.type(contentText, { delay: 40 });
        await page.waitForTimeout(2000);

        const btn = page.locator('button').filter({ hasText: /^Đăng$|^Post$/ }).last();
        if (await btn.isEnabled()) {
            await btn.click();
            totalPosts++;
            logStep(`✅ Đăng bài thành công (${totalPosts})`);
            history.unshift({ time: new Date().toLocaleTimeString(), status: 'OK' });
        }
        await page.close();
        
        // Lặp lại sau 2-4 phút ngẫu nhiên
        const nextDelay = Math.floor(Math.random() * 120000) + 120000;
        setTimeout(postTaskWithForce, nextDelay);

    } catch (err) {
        logStep(`❌ Lỗi: ${err.message}`);
        if (page) await page.close().catch(() => {});
        // Nếu trình duyệt chết, reset context
        if (err.message.includes('closed')) context = null;
        setTimeout(postTaskWithForce, 10000);
    }
}

// --- ROUTES ---
app.get('/login', async (req, res) => {
    logStep("Nhận lệnh mở Login...");
    isRunning = false;
    if (context) { await context.close(); context = null; }
    await killOldChrome(); // Quan trọng: diệt Chrome cũ để tránh khóa file
    const ctx = await getBrowser();
    const lp = await ctx.newPage();
    await lp.goto('https://www.binance.com/vi/square');
    res.json({ status: "Cửa sổ Login đã mở trên máy tính." });
});

app.get('/start', (req, res) => {
    if (!isRunning) {
        isRunning = true;
        postTaskWithForce();
        res.json({ status: "Bot đã bắt đầu chạy vòng lặp." });
    } else {
        res.json({ status: "Bot đang chạy rồi." });
    }
});

app.get('/stop', async (req, res) => {
    isRunning = false;
    res.json({ status: "Đã gửi lệnh dừng." });
});

app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history }));

app.listen(port, '0.0.0.0', () => {
    logStep(`Server live tại port: ${port}`);
});
