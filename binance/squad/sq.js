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

// --- TỰ ĐỘNG CÀI ĐẶT DRIVER NẾU THIẾU (PHƯƠNG ÁN DỰ PHÒNG 1) ---
try {
    console.log("Checking browser drivers...");
    execSync('npx playwright install chromium');
} catch (e) {
    console.log("Sử dụng driver hiện có...");
}

const intros = Array.from({ length: 300 }, (_, i) => `Nhận định mã COIN phiên số ${i+1}. Sóng đang đẹp.`.replace("COIN", "COIN"));
const bodies = Array.from({ length: 300 }, (_, i) => `Phân tích: Biến động CHANGE% cho thấy lực mua đang áp đảo.`.replace("CHANGE%", "CHANGE%"));
const closings = Array.from({ length: 300 }, (_, i) => `Chúc thắng lợi kèo số ${i+1}! Kỷ luật thép.`);
const cryptoQuestions = Array.from({ length: 300 }, (_, i) => `Thảo luận ${i+1}: Anh em kỳ vọng gì ở nhịp này của BTC?`);

async function killChrome() {
    try { 
        if (process.platform === 'win32') {
            execSync('taskkill /F /IM chrome.exe /T 2>nul || exit 0');
            execSync('taskkill /F /IM chromium.exe /T 2>nul || exit 0');
        } 
    } catch (e) {}
}

async function humanType(page, text) {
    for (const char of text) {
        await page.keyboard.type(char, { delay: Math.floor(Math.random() * 50) + 30 });
    }
}

// --- LUỒNG CHÍNH VỚI LOG LỖI CHI TIẾT ---
async function postTask() {
    if (!isRunning) return;
    try {
        if (!context) {
            console.log("Đang khởi tạo trình duyệt...");
            context = await chromium.launchPersistentContext(userDataDir, {
                headless: false,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--disable-gpu',
                    '--disable-dev-shm-usage',
                    '--password-store=basic'
                ]
            });
            context.on('close', () => { context = null; mainPage = null; });
        }

        if (!mainPage || mainPage.isClosed()) {
            mainPage = await context.newPage();
        }

        await mainPage.goto('https://www.binance.com/vi/square', { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        const textbox = mainPage.locator('div[contenteditable="true"]').first();
        await textbox.waitFor({ state: 'visible', timeout: 15000 });

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
            content = `🔥 $${c.symbol}\n\n${intros[Math.floor(Math.random()*300)].replace("COIN", c.symbol)}\n\n${bodies[Math.floor(Math.random()*300)].replace("CHANGE%", c.change)}\n\n📍 ENTRY: ${c.price}\n\n${closings[Math.floor(Math.random()*300)]}`;
        }

        await textbox.click();
        await mainPage.keyboard.press('Control+A');
        await mainPage.keyboard.press('Backspace');
        await humanType(mainPage, content);

        const btn = mainPage.locator('button').filter({ hasText: /^Đăng$|^Post$/ }).last();
        if (await btn.isEnabled()) {
            await btn.click();
            totalPosts++;
            history.unshift({ time: new Date().toLocaleTimeString(), status: `Thành công: $${c?.symbol || 'bài viết'}` });
            await new Promise(r => setTimeout(r, (Math.floor(Math.random() * 60) + 60) * 1000));
        }
    } catch (err) {
        let errMsg = err.message.substring(0, 100);
        console.error(`❌ LỖI HỆ THỐNG: ${errMsg}`);
        history.unshift({ time: new Date().toLocaleTimeString(), status: `Lỗi: ${errMsg}` });

        // PHƯƠNG ÁN DỰ PHÒNG: Reset session nếu lỗi nặng
        if (err.message.includes('closed') || err.message.includes('Target closed') || err.message.includes('launch')) {
            console.log("Đang thực hiện phương án dự phòng: Khởi động lại trình duyệt...");
            context = null; 
            mainPage = null;
            await killChrome();
        }
        await new Promise(r => setTimeout(r, 10000));
    }
    if (isRunning) postTask();
}

app.get('/', (req, res) => {
    res.send(`<html><body style="background:#0b0e11;color:#fff;text-align:center;padding:50px;font-family:sans-serif;">
        <h1 style="color:#f0b90b;">SQUARE BOT PRO - DEBUG MODE</h1>
        <div id="st" style="font-size:20px;margin-bottom:20px;">Kết nối...</div>
        <div style="border:1px dashed #444; padding:15px; max-width:500px; margin:auto; background:#181a20;">
            <button style="width:100%;padding:15px;background:#f0b90b;border:none;border-radius:5px;font-weight:bold;cursor:pointer;margin-bottom:10px;" onclick="call('/login')">1. LOGIN (MỞ TRÌNH DUYỆT)</button>
            <button style="width:48%;padding:15px;background:#2ebd85;color:#fff;border:none;border-radius:5px;font-weight:bold;cursor:pointer;" onclick="call('/start')">2. CHẠY AUTO</button>
            <button style="width:48%;padding:15px;background:#f6465d;color:#fff;border:none;border-radius:5px;font-weight:bold;cursor:pointer;" onclick="call('/stop')">DỪNG</button>
        </div>
        <div id="log" style="margin-top:20px;text-align:left;max-width:500px;margin:20px auto;font-size:12px;color:#848e9c;background:#1e2329;padding:15px;border-radius:5px;height:200px;overflow-y:auto;"></div>
        <script>
            function call(u){ 
                fetch(u).then(r=>r.json())
                .then(d=> { if(d.error) alert('LỖI: ' + d.error); else alert(d.msg); })
                .catch(e=> alert('Không kết nối được tới Server bot')); 
            }
            setInterval(()=>{
                fetch('/stats').then(r=>r.json()).then(d=>{
                    document.getElementById('st').innerHTML = (d.isRunning?'<span style="color:#2ebd85;">🟢 ĐANG CHẠY</span>':'<span style="color:#f6465d;">🔴 ĐÃ DỪNG</span>') + ' | Tổng bài: ' + d.totalPosts;
                    document.getElementById('log').innerHTML = d.history.map(h=>\`<div style="margin-bottom:5px;border-bottom:1px solid #333;">[\${h.time}] \${h.status}</div>\`).join('');
                });
            },2000);
        </script>
    </body></html>`);
});

app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history }));

app.get('/login', async (req, res) => {
    isRunning = false; 
    try {
        await killChrome();
        // Xử lý lỗi thư mục bị lock (Dự phòng 2)
        try {
            context = await chromium.launchPersistentContext(userDataDir, { 
                headless: false, 
                args: ['--disable-gpu', '--no-sandbox', '--password-store=basic'] 
            });
        } catch (lockErr) {
            console.log("Thư mục session bị khóa, đang thử khởi tạo lại...");
            await killChrome();
            await new Promise(r => setTimeout(r, 2000));
            context = await chromium.launchPersistentContext(userDataDir, { headless: false });
        }

        mainPage = await context.newPage();
        await mainPage.goto('https://www.binance.com/vi/square');
        res.json({ msg: "Trình duyệt đã mở. Hãy đăng nhập ngay!" });
    } catch (err) {
        console.error("LỖI KHÔNG MỞ ĐƯỢC CHROME:", err);
        res.json({ error: err.message });
    }
});

app.get('/start', (req, res) => { 
    if(!context) return res.json({ error: "Chưa mở trình duyệt. Bấm Login trước!" });
    isRunning = true; 
    postTask(); 
    res.json({ msg: "Bot đã kích hoạt!" }); 
});

app.get('/stop', (req, res) => { isRunning = false; res.json({ msg: "Bot tạm dừng." }); });

app.listen(port, '0.0.0.0', () => {
    console.log(`
    =============================================
    BOT ĐANG CHẠY TẠI: http://localhost:${port}
    Nếu Chrome không hiện, hãy kiểm tra log Terminal này.
    =============================================
    `);
});
