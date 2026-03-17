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
let mainPage = null;
let coinQueue = [];

// --- DỮ LIỆU NỘI DUNG ---
const intros = Array.from({ length: 300 }, (_, i) => `Nhận định mã COIN phiên số ${i+1}. Sóng đang đẹp.`.replace("COIN", "COIN"));
const bodies = Array.from({ length: 300 }, (_, i) => `Phân tích: Biến động CHANGE% cho thấy lực mua đang áp đảo.`.replace("CHANGE%", "CHANGE%"));
const closings = Array.from({ length: 300 }, (_, i) => `Chúc thắng lợi kèo số ${i+1}! Kỷ luật thép.`);
const cryptoQuestions = Array.from({ length: 300 }, (_, i) => `Thảo luận ${i+1}: Anh em kỳ vọng gì ở nhịp này của BTC?`);

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
            console.log("Đang khởi tạo trình duyệt...");
            context = await chromium.launchPersistentContext(userDataDir, {
                headless: false,
                channel: 'chrome', // Chạy bằng Chrome thật trên máy
                viewport: null,
                args: ['--start-maximized', '--no-sandbox', '--disable-blink-features=AutomationControlled']
            });
            context.on('close', () => { context = null; mainPage = null; });
        }

        if (!mainPage || mainPage.isClosed()) {
            mainPage = await context.newPage();
        }

        await mainPage.bringToFront();
        await mainPage.goto('https://www.binance.com/vi/square', { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        const textbox = mainPage.locator('div[contenteditable="true"]').first();
        await textbox.waitFor({ state: 'visible', timeout: 20000 });

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
            history.unshift({ time: new Date().toLocaleTimeString(), status: `Đã đăng: $${content.split(' ')[1] || 'bài'}` });
            await new Promise(r => setTimeout(r, (Math.floor(Math.random() * 60) + 60) * 1000));
        }
    } catch (err) {
        console.error(`❌ Lỗi luồng: ${err.message}`);
        history.unshift({ time: new Date().toLocaleTimeString(), status: `Lỗi: ${err.message.substring(0, 50)}...` });
        
        if (err.message.includes('closed')) {
            context = null; mainPage = null;
        }
        await new Promise(r => setTimeout(r, 10000));
    }
    if (isRunning) postTask();
}

// --- GIAO DIỆN ---
app.get('/', (req, res) => {
    res.send(`<html><body style="background:#0b0e11;color:#fff;text-align:center;padding:50px;font-family:sans-serif;">
        <h1 style="color:#f0b90b;">SQUARE BOT FIX-SELF-KILL</h1>
        <div id="st" style="font-size:20px;margin-bottom:20px;">Kết nối...</div>
        <div style="border:1px dashed #444; padding:20px; max-width:400px; margin:auto; background:#181a20; border-radius:10px;">
            <button style="width:100%;padding:15px;background:#f0b90b;border:none;border-radius:5px;font-weight:bold;cursor:pointer;margin-bottom:10px;" onclick="call('/login')">1. LOGIN (MỞ CHROME ĐỨNG YÊN)</button>
            <button style="width:48%;padding:15px;background:#2ebd85;color:#fff;border:none;border-radius:5px;font-weight:bold;cursor:pointer;" onclick="call('/start')">2. CHẠY AUTO</button>
            <button style="width:48%;padding:15px;background:#f6465d;color:#fff;border:none;border-radius:5px;font-weight:bold;cursor:pointer;" onclick="call('/stop')">DỪNG</button>
        </div>
        <div id="log" style="margin-top:20px;text-align:left;max-width:400px;margin:20px auto;font-size:12px;color:#848e9c;background:#1e2329;padding:15px;border-radius:5px;height:150px;overflow-y:auto;"></div>
        <script>
            function call(u){ fetch(u).then(r=>r.json()).then(d=> alert(d.msg || d.error)); }
            setInterval(()=>{
                fetch('/stats').then(r=>r.json()).then(d=>{
                    document.getElementById('st').innerHTML = (d.isRunning?'<span style="color:#2ebd85;">🟢 ĐANG CHẠY</span>':'<span style="color:#f6465d;">🔴 ĐÃ DỪNG</span>') + ' | Tổng: ' + d.totalPosts;
                    document.getElementById('log').innerHTML = d.history.map(h=>'<div>['+h.time+'] '+h.status+'</div>').join('');
                });
            },2000);
        </script>
    </body></html>`);
});

app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history }));

app.get('/login', async (req, res) => {
    isRunning = false; 
    try {
        // Chỉ đóng context cũ nếu có, không kill chrome toàn hệ thống
        if (context) {
            await context.close().catch(() => {});
            context = null;
        }

        context = await chromium.launchPersistentContext(userDataDir, { 
            headless: false, 
            channel: 'chrome',
            viewport: null,
            args: ['--start-maximized', '--no-sandbox'] 
        });

        mainPage = await context.newPage();
        await mainPage.bringToFront();
        await mainPage.goto('https://www.binance.com/vi/square');
        res.json({ msg: "Chrome đã mở và sẽ đứng yên để ông login!" });
    } catch (err) {
        res.json({ error: "Lỗi mở Chrome: " + err.message });
    }
});

app.get('/start', (req, res) => { 
    if(!context) return res.json({ error: "Phải bấm LOGIN trước!" });
    isRunning = true; 
    postTask(); 
    res.json({ msg: "Bot bắt đầu chạy!" }); 
});

app.get('/stop', (req, res) => { isRunning = false; res.json({ msg: "Đã dừng bot." }); });

app.listen(port, '0.0.0.0', () => {
    console.log(`Bot live tại: http://localhost:${port}`);
});
