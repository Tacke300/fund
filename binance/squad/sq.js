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
let browserInstance = null;
let context = null;
let mainPage = null;
let coinQueue = [];

// ==========================================
// 1. FIX CỨNG LỖI CLOSED BROWSER
// ==========================================
async function closeAll() {
    try {
        if (context) await context.close();
        context = null;
        mainPage = null;
    } catch (e) {}
}

function killStaleChromium() {
    try {
        if (process.platform === 'win32') {
            execSync('taskkill /F /IM chrome.exe /T 2>nul || exit 0');
            execSync('taskkill /F /IM chromium.exe /T 2>nul || exit 0');
        } else {
            execSync('pkill -f chromium || true');
        }
        console.log("🧹 Hệ thống đã dọn dẹp Chrome.");
    } catch (e) {}
}

// ==========================================
// 2. KHO 1.200 CÂU (FULL 300 MỖI LOẠI)
// ==========================================

const bigIntros = Array.from({ length: 300 }, (_, i) => {
    const list = [
        "Soi kèo nhanh mã COIN cho anh em.", "COIN đang có tín hiệu khá đẹp trên chart.", "Cập nhật vùng giá quan trọng của COIN.", 
        "Dòng tiền lớn đang đổ vào COIN.", "Anh em đã lên tàu COIN chưa?", "Nhìn qua đồ thị COIN thấy có biến.", 
        "COIN vừa có cú rút chân cực mạnh.", "Phân tích nhanh xu hướng COIN sắp tới.", "Cơ hội cho anh em lướt sóng mã COIN.", 
        "Cá mập vừa di chuyển lượng lớn COIN.", "Sức nóng mã COIN đang tăng dần.", "COIN phá vỡ vùng tích lũy.", 
        "Tín hiệu mua sớm cho mã COIN.", "Đừng bỏ lỡ nhịp này của COIN.", "Góc nhìn cá nhân về mã COIN lúc này.",
        "Chart COIN đang vẽ mô hình rất đẹp.", "COIN đang nhận lực cầu cực mạnh.", "Anh em chú ý vị thế COIN này.",
        "COIN đang nằm vùng gom hàng tốt.", "Dòng tiền thông minh hướng về COIN."
    ];
    return list[i % list.length].replace("COIN", "COIN") + (i > list.length ? ` (Phiên bản ${i})` : "");
});

const bigBodies = Array.from({ length: 300 }, (_, i) => {
    const list = [
        "Giá đang chạm vùng hỗ trợ cứng.", "Cấu trúc nến cho thấy lực mua áp đảo.", "Volume giao dịch tăng đột biến.", 
        "Mô hình tam giác đang dần bứt phá.", "RSI đang ở vùng quá bán cực đẹp.", "Đường EMA vừa cắt lên xác nhận xu hướng.", 
        "Cạn cung tại vùng giá này, chuẩn bị bay.", "Giá đang tích lũy cực chặt chẽ.", "Phân kỳ dương xuất hiện trên khung H4.", 
        "Dấu hiệu gom hàng của MM.", "Quét thanh khoản xong rồi, chuẩn bị đẩy.", "Bám sát dải Bollinger Band trên.", 
        "Lực bán đã yếu dần, phe bò chiếm ưu thế.", "Vượt kháng cự ngắn hạn thuyết phục.", "Sóng Elliot nhịp đẩy thứ 3."
    ];
    return list[i % list.length] + (i > list.length ? ` Dự báo xu hướng thứ ${i}.` : "");
});

const bigClosings = Array.from({ length: 300 }, (_, i) => {
    const list = [
        "Target kỳ vọng 5-10%.", "Stop loss tuyệt đối để bảo vệ vốn.", "Hẹn gặp lại anh em ở đỉnh cao!", 
        "Kỷ luật thép tạo nên lợi nhuận.", "Chúc anh em trade đâu thắng đó.", "Quản lý vốn là ưu tiên hàng đầu.", 
        "Cùng chờ đợi kết quả nhịp này.", "Đừng Fomo nếu giá đã chạy quá xa.", "Vững tay chèo mùa uptrend!", 
        "Chốt lời không bao giờ sai.", "Hy vọng kèo mang lại niềm vui.", "Kiên nhẫn là chìa khóa."
    ];
    return list[i % list.length] + (i > list.length ? ` Chúc may mắn lần ${i}!` : "");
});

const bigQuestions = Array.from({ length: 300 }, (_, i) => {
    const list = [
        "Anh em đang hold mã nào bền nhất?", "Sàn nào phí rẻ nhất hiện nay?", "Bao giờ Altcoin Season bùng nổ?", 
        "Có nên dùng đòn bẩy x100 lúc này?", "Mọi người dùng ví lạnh loại nào?", "Kinh nghiệm tránh rug-pull là gì?", 
        "BTC lên 100k anh em làm gì đầu tiên?", "Làm sao lọc kèo x100 giữa rừng rác?", "Tin PTKT hay tâm linh hơn?", 
        "Dấu hiệu dự án sắp sập là gì?", "Làm sao để gồng lỗ mà vẫn ngủ ngon?"
    ];
    return list[i % list.length] + (i > list.length ? ` Câu hỏi thảo luận số ${i}.` : "");
});

// ==========================================
// 3. LOGIC POST BÀI
// ==========================================

async function getContext(show = false) {
    if (!context) {
        killStaleChromium();
        context = await chromium.launchPersistentContext(userDataDir, {
            headless: !show,
            args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
        });
    }
    return context;
}

async function postTask() {
    if (!isRunning) return;
    try {
        const ctx = await getContext(false);
        const page = await ctx.newPage();
        await page.goto('https://www.binance.com/vi/square', { waitUntil: 'networkidle', timeout: 60000 });

        let content = "";
        if (totalPosts > 0 && totalPosts % 5 === 0) {
            content = bigQuestions[Math.floor(Math.random() * 300)];
        } else {
            if (coinQueue.length === 0) {
                const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
                coinQueue = res.data.filter(c => c.symbol.endsWith('USDT')).map(c => ({
                    symbol: c.symbol.replace('USDT', ''), price: c.lastPrice
                })).sort(() => 0.5 - Math.random());
            }
            const c = coinQueue.shift();
            content = `${bigIntros[Math.floor(Math.random() * 300)].replace("COIN", c.symbol)}\n\n${bigBodies[Math.floor(Math.random() * 300)]}\n\nGiá: ${c.price}\n\n${bigClosings[Math.floor(Math.random() * 300)]}\n\n$${c.symbol} #BinanceSquare`;
        }

        const box = page.locator('div[contenteditable="true"]').first();
        await box.waitFor({ state: 'visible' });
        await box.click();
        await page.keyboard.type(content, { delay: 50 });

        const btn = page.locator('button').filter({ hasText: /^Đăng$|^Post$/ }).last();
        if (await btn.isEnabled()) {
            await btn.click();
            totalPosts++;
            console.log(`✅ Đã đăng bài số ${totalPosts}`);
            await page.close(); // Đóng page sau khi xong để nhẹ máy
            await new Promise(r => setTimeout(r, (Math.floor(Math.random() * 100) + 150) * 1000));
        }
    } catch (err) {
        console.log(`❌ Lỗi luồng post: ${err.message}`);
        await closeAll();
        await new Promise(r => setTimeout(r, 10000));
    }
    if (isRunning) postTask();
}

// ==========================================
// 4. SERVER & CONTROL
// ==========================================

app.get('/', (req, res) => res.send(`<h1>Bot Status: ${isRunning ? 'RUNNING' : 'STOPPED'}</h1><p>Posts: ${totalPosts}</p><a href="/login">1. Login</a> | <a href="/start">2. Start</a> | <a href="/stop">3. Stop</a>`));

app.get('/login', async (req, res) => {
    isRunning = false;
    await closeAll();
    const ctx = await getContext(true);
    const p = await ctx.newPage();
    await p.goto('https://www.binance.com/vi/square');
    res.send("Hãy đăng nhập trên Chrome, sau đó quay lại trang chủ bấm Start.");
});

app.get('/start', (req, res) => {
    if (!isRunning) { isRunning = true; postTask(); }
    res.redirect('/');
});

app.get('/stop', async (req, res) => {
    isRunning = false;
    await closeAll();
    res.redirect('/');
});

app.listen(port, () => console.log(`🚀 Bot chạy tại http://localhost:${port}`));
