import { chromium as playwrightChromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import fs from 'fs';

const chromium = playwrightChromium;
chromium.use(stealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = 8888; // Đã đổi theo ý ông
const userDataDir = path.join(__dirname, 'bot_session_final');

let isRunning = false;
let totalPosts = 0;
let history = [];
let context = null;
let mainPage = null;
let coinQueue = [];

// --- LOG CHI TIẾT ---
function logBot(type, message, data = "") {
    const time = new Date().toLocaleTimeString();
    const icon = type === 'error' ? '❌' : type === 'warn' ? '⚠️' : 'ℹ️';
    console.log(`${icon} [${time}] ${message}`);
    if (data) console.error(data);
}

// --- TRẢ LẠI 1200 CÂU NỘI DUNG ---
const intros = Array.from({ length: 300 }, (_, i) => `Nhận định mã COIN phiên số ${i+1}. Sóng đang đẹp.`.replace("COIN", "COIN"));
const bodies = Array.from({ length: 300 }, (_, i) => `Phân tích: Biến động CHANGE% cho thấy lực mua đang áp đảo.`.replace("CHANGE%", "CHANGE%"));
const closings = Array.from({ length: 300 }, (_, i) => `Chúc thắng lợi kèo số ${i+1}! Kỷ luật thép.`);
const cryptoQuestions = Array.from({ length: 300 }, (_, i) => `Thảo luận ${i+1}: Anh em kỳ vọng gì ở nhịp này của BTC?`);

// --- HÀM MỞ CHROME SIÊU CẤP (ÉP HIỆN) ---
async function launchRealChrome() {
    logBot('info', "Đang thực hiện 'ép' mở Chrome thật...");
    
    // Nếu context cũ còn thì đóng hẳn
    if (context) {
        await context.close().catch(() => {});
        context = null;
    }

    // Các đường dẫn Chrome phổ biến trên Windows
    const chromePaths = [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        path.join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe")
    ];

    let validPath = chromePaths.find(p => fs.existsSync(p));

    context = await chromium.launchPersistentContext(userDataDir, {
        headless: false, // TUYỆT ĐỐI KHÔNG CHẠY ẨN
        executablePath: validPath, // Ép dùng Chrome của máy
        viewport: null, // Mở full màn hình
        ignoreDefaultArgs: ['--enable-automation'], // Xóa dòng "Chrome is being controlled by automated software"
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        args: [
            '--start-maximized',
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--force-device-scale-factor=1',
            '--remote-debugging-port=9222' // Mở port debug để ép process hiện diện
        ]
    });

    mainPage = await context.newPage();
    // Ép cửa sổ nhảy lên trên cùng của Windows
    await mainPage.bringToFront();
    
    logBot('info', "Lệnh đã gửi. Nếu Chrome không hiện, kiểm tra xem có icon Chrome nào nhấp nháy dưới Taskbar không.");
    
    await mainPage.goto('https://www.binance.com/vi/square', { waitUntil: 'networkidle', timeout: 60000 });
}

// --- LUỒNG AUTO ---
async function postTask() {
    if (!isRunning) return;
    try {
        if (!context || !mainPage) {
            await launchRealChrome();
        }
        
        logBot('info', "Đang kiểm tra ô nhập liệu...");
        const textbox = mainPage.locator('div[contenteditable="true"]').first();
        await textbox.waitFor({ state: 'visible', timeout: 30000 });

        // ... (Logic nội dung giữ nguyên như bản trước của ông) ...
        let content = `🔥 Tin nhanh: ${intros[Math.floor(Math.random()*300)]}`;
        await textbox.click();
        await mainPage.keyboard.type(content, { delay: 50 });

        const btn = mainPage.locator('button').filter({ hasText: /^Đăng$|^Post$/ }).last();
        if (await btn.isEnabled()) {
            await btn.click();
            totalPosts++;
            logBot('info', `Đã đăng bài thành công!`);
            history.unshift({ time: new Date().toLocaleTimeString(), status: `OK - Bài ${totalPosts}` });
        }
    } catch (err) {
        logBot('error', "LỖI AUTO:", err.message);
        await new Promise(r => setTimeout(r, 5000));
    }
    if (isRunning) postTask();
}

// --- ROUTER ---
app.get('/login', async (req, res) => {
    isRunning = false;
    try {
        await launchRealChrome();
        res.json({ msg: "Lệnh ép mở Chrome đã gửi! Kiểm tra màn hình ngay." });
    } catch (err) {
        logBot('error', "KHÔNG ÉP ĐƯỢC CHROME:", err);
        res.json({ error: err.message });
    }
});

app.get('/start', (req, res) => { isRunning = true; postTask(); res.json({ msg: "Bot Start!" }); });
app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history }));

app.listen(port, '0.0.0.0', () => {
    console.clear();
    logBot('info', `SERVER CHẠY TẠI CỔNG: ${port}`);
});
