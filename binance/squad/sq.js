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

// --- DỮ LIỆU 1200 CÂU ---
const intros = Array.from({ length: 300 }, (_, i) => `Nhận định mã COIN phiên số ${i+1}. Sóng đang khá đẹp cho anh em.`.replace("COIN", "COIN"));
const bodies = Array.from({ length: 300 }, (_, i) => `Phân tích kỹ thuật: Chỉ số CHANGE% cho thấy lực mua chủ động đang áp đảo.`.replace("CHANGE%", "CHANGE%"));
const closings = Array.from({ length: 300 }, (_, i) => `Chúc anh em thắng lợi lớn ở kèo số ${i+1}! Luôn kỷ luật nhé.`);
const cryptoQuestions = Array.from({ length: 300 }, (_, i) => `Câu hỏi thảo luận ${i+1}: Anh em nghĩ sao về xu hướng của BTC trong 24h tới?`);

// --- FIX LỖI WINDOWS/PM2 ---
async function killChrome() {
    try {
        if (process.platform === 'win32') execSync('taskkill /F /IM chrome.exe /T 2>nul || exit 0');
    } catch (e) {}
}

async function humanType(page, text) {
    for (const char of text) {
        await page.keyboard.type(char, { delay: Math.floor(Math.random() * 60) + 40 });
    }
}

async function postTask() {
    if (!isRunning) return;
    try {
        if (!context) {
            context = await chromium.launchPersistentContext(userDataDir, {
                headless: false,
                // Thêm các args này để tránh lỗi "Target closed" trên Windows
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-extensions',
                    '--no-first-run',
                    '--no-default-browser-check'
                ],
                viewport: { width: 1280, height: 720 }
            });
            
            // Lắng nghe nếu trình duyệt bị đóng tay thì reset biến
            context.on('close', () => { context = null; mainPage = null; });
        }

        if (!mainPage || mainPage.isClosed()) {
            mainPage = await context.newPage();
            await mainPage.goto('https://www.binance.com/vi/square', { waitUntil: 'networkidle', timeout: 60000 });
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
            content = `🔥 $${c.symbol}\n\n${intros[Math.floor(Math.random()*300)].replace("COIN", c.symbol)}\n\n${bodies[Math.floor(Math.random()*300)].replace("CHANGE%", c.change)}\n\n📍 ENTRY: ${c.price}\n\n${closings[Math.floor(Math.random()*300)]}`;
        }

        const textbox = mainPage.locator('div[contenteditable="true"]').first();
        await textbox.waitFor({ state: 'visible', timeout: 30000 });
        await textbox.click();
        await mainPage.keyboard.press('Control+A');
        await mainPage.keyboard.press('Backspace');
        await humanType(mainPage, content);

        const btn = mainPage.locator('button').filter({ hasText: /^Đăng$|^Post$/ }).last();
        if (await btn.isEnabled()) {
            await btn.click();
            totalPosts++;
            history.unshift({ time: new Date().toLocaleTimeString(), status: `Đã đăng bài số ${totalPosts}` });
            await new Promise(r => setTimeout(r, (Math.floor(Math.random() * 60) + 60) * 1000));
        }
    } catch (err) {
        console.log(`❌ Lỗi: ${err.message}`);
        // Nếu lỗi do đóng trình duyệt, xóa sạch để khởi tạo lại
        if (err.message.includes('closed')) {
            context = null; mainPage = null;
        }
        await new Promise(r => setTimeout(r, 10000));
    }
    if (isRunning) postTask();
}

// --- GIAO DIỆN ---
app.get('/', (req, res) => {
    res.send(`
    <html><body style="background:#0b0e11;color:#fff;text-align:center;padding:50px;font-family:sans-serif;">
        <h2>BINANCE BOT PANEL</h2>
        <div id="st">Đang kết nối...</div>
        <button style="padding:15px;margin:10px;background:#f0b90b;font-weight:bold;" onclick="call('/login')">LOGIN (MỞ CHROME)</button>
        <button style="padding:15px;margin:10px;background:#2ebd85;color:#fff;" onclick="call('/start')">CHẠY BOT</button>
        <button style="padding:15px;margin:10px;background:#f6465d;color:#fff;" onclick="call('/stop')">DỪNG</button>
        <div id="log" style="margin-top:20px;text-align:left;max-width:400px;margin-left:auto;margin-right:auto;"></div>
        <script>
            function call(u){ fetch(u).then(r=>r.json()).then(d=>alert(d.msg)); }
            setInterval(()=>{
                fetch('/stats').then(r=>r.json()).then(d=>{
                    document.getElementById('st').innerText = (d.isRunning?'RUNNING':'STOPPED') + ' | Tổng: ' + d.totalPosts;
                    document.getElementById('log').innerHTML = d.history.map(h=>'<div>['+h.time+'] '+h.status+'</div>').join('');
                });
            },2000);
        </script>
    </body></html>`);
});

app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history }));
app.get('/login', async (req, res) => {
    isRunning = false; await killChrome();
    chromium.launchPersistentContext(userDataDir, { headless: false, args: ['--no-sandbox'] }).then(ctx => {
        context = ctx; context.newPage().then(p => { mainPage = p; p.goto('https://www.binance.com/vi/square'); });
    });
    res.json({ msg: "Đang mở trình duyệt trên máy bot..." });
});
app.get('/start', (req, res) => { isRunning = true; postTask(); res.json({ msg: "Bot bắt đầu!" }); });
app.get('/stop', (req, res) => { isRunning = false; res.json({ msg: "Đã dừng." }); });

app.listen(port, '0.0.0.0', () => console.log(`Live: http://localhost:${port}`));
