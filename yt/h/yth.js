const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs-extra');
const { execSync } = require('child_process');

puppeteer.use(StealthPlugin());

// --- CẤU HÌNH ---
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'; 
const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 4;
const BASE_TEMP_DIR = path.resolve(__dirname, 'profiles');

let totalViews = 0;

// HÀM QUÉT SẠCH CHROME ĐANG CHẠY NGẦM (QUAN TRỌNG)
function killChrome() {
    console.log("🧹 Đang dọn dẹp các tiến trình Chrome cũ để tránh chạy ngầm...");
    try {
        // Kill sạch chrome.exe và chromedriver.exe
        execSync('taskkill /F /IM chrome.exe /T', { stdio: 'ignore' });
        execSync('taskkill /F /IM chromedriver.exe /T', { stdio: 'ignore' });
    } catch (e) {
        // Nếu không có chrome nào đang chạy thì bỏ qua
    }
}

function logThread(id, msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const icon = type === 'error' ? '❌' : (type === 'success' ? '✅' : '🔹');
    console.log(`[${time}] [${id}] ${icon} ${msg}`);
}

async function runWorker(index) {
    const threadId = `THREAD-${index.toString().padStart(2, '0')}`;
    const userDataDir = path.join(BASE_TEMP_DIR, `data_${index}`);
    
    // Xóa lock file cũ của Chrome để tránh bị kẹt profile
    const lockFile = path.join(userDataDir, 'SingletonLock');
    if (fs.existsSync(lockFile)) fs.removeSync(lockFile);
    fs.ensureDirSync(userDataDir);

    let browser;
    try {
        logThread(threadId, `Đang gọi Chrome thật (UI Mode)...`);
        
        browser = await puppeteer.launch({
            executablePath: CHROME_PATH,
            headless: false, // PHẢI LÀ FALSE
            userDataDir: userDataDir,
            args: [
                '--start-maximized',
                '--no-sandbox',
                `--remote-debugging-port=${9220 + index}`,
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-extensions',
                '--mute-audio',
                '--disable-blink-features=AutomationControlled',
                // CÁC THAM SỐ ÉP HIỆN CỬA SỔ TRÊN WINDOWS
                '--window-position=0,0',
                '--force-device-scale-factor=1',
                '--enable-ui-devtools' 
            ],
            ignoreDefaultArgs: ['--enable-automation'] 
        });

        const pages = await browser.pages();
        const page = pages[0];
        
        logThread(threadId, `Cửa sổ đã bật! Đang vào YouTube...`);
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        const videoSelector = 'a#video-title, ytd-playlist-video-renderer a';
        await page.waitForSelector(videoSelector, { timeout: 30000 });
        
        await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) el.click();
        }, videoSelector);

        logThread(threadId, `Đã nhấn Play! Đang cày view.`);

        while (true) {
            await new Promise(r => setTimeout(r, 10000));
            const title = (await page.title()).replace("- YouTube", "").trim();
            const watchSecs = Math.floor(Math.random() * 61) + 180; 
            
            logThread(threadId, `Đang xem: "${title}" (${watchSecs}s)`);
            await new Promise(r => setTimeout(r, watchSecs * 1000));

            totalViews++;
            logThread(threadId, `✅ Xong 1 View. Tổng máy: ${totalViews}`, 'success');

            await page.keyboard.down('Shift');
            await page.keyboard.press('N');
            await page.keyboard.up('Shift');
        }

    } catch (err) {
        logThread(threadId, `LỖI: ${err.message}`, 'error');
    } finally {
        if (browser) await browser.close();
        setTimeout(() => runWorker(index), 15000);
    }
}

// CHẠY CHÍNH
console.log("🚀 KHỞI ĐỘNG HỆ THỐNG...");
killChrome(); // Quét sạch trước khi chạy

setTimeout(() => {
    for (let i = 1; i <= MAX_THREADS; i++) {
        runWorker(i);
        // Mở cách nhau 12s để không bị nghẽn UI
        const wait = i * 12000; 
    }
}, 3000);
