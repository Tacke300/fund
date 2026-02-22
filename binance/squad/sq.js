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

// --- DỮ LIỆU ĐẦY ĐỦ 1200 CÂU ---
const intros = Array.from({ length: 300 }, (_, i) => `Nhận định mã COIN phiên số ${i+1}. Sóng đang đẹp.`.replace("COIN", "COIN"));
const bodies = Array.from({ length: 300 }, (_, i) => `Phân tích: Biến động CHANGE% cho thấy lực mua đang áp đảo.`.replace("CHANGE%", "CHANGE%"));
const closings = Array.from({ length: 300 }, (_, i) => `Chúc thắng lợi kèo số ${i+1}! Kỷ luật thép.`);
const cryptoQuestions = Array.from({ length: 300 }, (_, i) => `Thảo luận ${i+1}: Anh em kỳ vọng gì ở nhịp này của BTC?`);

async function killChrome() {
    try { if (process.platform === 'win32') execSync('taskkill /F /IM chrome.exe /T 2>nul || exit 0'); } catch (e) {}
}

async function humanType(page, text) {
    for (const char of text) {
        await page.keyboard.type(char, { delay: Math.floor(Math.random() * 50) + 30 });
    }
}

// --- LUỒNG CHÍNH ---
async function postTask() {
    if (!isRunning) return;
    try {
        if (!context) {
            context = await chromium.launchPersistentContext(userDataDir, {
                headless: false,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--disable-gpu', // KHẮC PHỤC LỖI EXIT_CODE=34 TRONG LOG
                    '--disable-software-rasterizer',
                    '--disable-dev-shm-usage',
                    '--password-store=basic' // TRÁNH LỖI TOKEN DECRYPT
                ]
            });
            context.on('close', () => { context = null; mainPage = null; });
        }

        if (!mainPage || mainPage.isClosed()) {
            mainPage = await context.newPage();
        }

        // Truy cập Square
        await mainPage.goto('https://www.binance.com/vi/square', { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        // Chờ box nhập liệu xuất hiện
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
            history.unshift({ time: new Date().toLocaleTimeString(), status: `Đã đăng $${content.split(' ')[1] || 'bài'}` });
            await new Promise(r => setTimeout(r, (Math.floor(Math.random() * 60) + 60) * 1000));
        }
    } catch (err) {
        console.log(`❌ Lỗi luồng: ${err.message}`);
        if (err.message.includes('closed') || err.message.includes('navigation')) {
            context = null; mainPage = null;
        }
        await new Promise(r => setTimeout(r, 10000));
    }
    if (isRunning) postTask();
}

// --- GIAO DIỆN ĐIỀU KHIỂN ---
app.get('/', (req, res) => {
    res.send(`<html><body style="background:#0b0e11;color:#fff;text-align:center;padding:50px;font-family:sans-serif;">
        <h1>SQUARE BOT PRO</h1>
        <div id="st">Kết nối...</div>
        <hr style="border:0.5px solid #333; margin:20px;">
        <button style="padding:15px 30px;background:#f0b90b;border:none;border-radius:5px;font-weight:bold;cursor:pointer;" onclick="call('/login')">1. LOGIN (MỞ CHROME)</button>
        <br><br>
        <button style="padding:15px 30px;background:#2ebd85;color:#fff;border:none;border-radius:5px;font-weight:bold;cursor:pointer;" onclick="call('/start')">2. CHẠY AUTO</button>
        <button style="padding:15px 30px;background:#f6465d;color:#fff;border:none;border-radius:5px;font-weight:bold;cursor:pointer;" onclick="call('/stop')">DỪNG</button>
        <div id="log" style="margin-top:20px;text-align:left;max-width:400px;margin:auto;font-size:13px;color:#aaa;"></div>
        <script>
            function call(u){ fetch(u).then(r=>r.json()).then(d=>alert(d.msg)); }
            setInterval(()=>{
                fetch('/stats').then(r=>r.json()).then(d=>{
                    document.getElementById('st').innerText = (d.isRunning?'🟢 ĐANG CHẠY':'🔴 ĐÃ DỪNG') + ' | Tổng: ' + d.totalPosts;
                    document.getElementById('log').innerHTML = d.history.map(h=>'<div>['+h.time+'] '+h.status+'</div>').join('');
                });
            },2000);
        </script>
    </body></html>`);
});

app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history }));
app.get('/login', async (req, res) => {
    isRunning = false; 
    await killChrome();
    // Khởi tạo mới hoàn toàn
    chromium.launchPersistentContext(userDataDir, { 
        headless: false, 
        args: ['--disable-gpu', '--no-sandbox', '--password-store=basic'] 
    }).then(ctx => {
        context = ctx;
        context.newPage().then(p => { 
            mainPage = p; 
            p.goto('https://www.binance.com/vi/square'); 
        });
    });
    res.json({ msg: "Đang mở trình duyệt. Hãy login xong rồi bấm Chạy Auto!" });
});

app.get('/start', (req, res) => { isRunning = true; postTask(); res.json({ msg: "Bot đã kích hoạt!" }); });
app.get('/stop', (req, res) => { isRunning = false; res.json({ msg: "Bot tạm dừng." }); });

app.listen(port, '0.0.0.0', () => console.log(`Live: http://localhost:${port}`));
