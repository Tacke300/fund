const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs-extra');
const express = require('express');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

// --- CẤU HÌNH ---
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'; 
const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 4; // Chỉnh về 4 luồng theo yêu cầu
const BASE_TEMP_DIR = path.resolve(__dirname, 'profiles');

let stats = { totalViews: 0, activeThreads: 0, threadStatus: {} };

// Hàm log có màu và thời gian
function logThread(id, message, isError = false) {
    const time = new Date().toLocaleTimeString();
    const icon = isError ? '❌' : '🔹';
    console.log(`[${time}] [${id}] ${icon} ${message}`);
}

async function runWorker(index) {
    const threadId = `THREAD-${index.toString().padStart(2, '0')}`;
    const userDataDir = path.join(BASE_TEMP_DIR, `data_${index}`);
    
    fs.ensureDirSync(userDataDir);
    logThread(threadId, `Khởi động luồng với Profile: ${userDataDir}`);

    let browser;
    try {
        browser = await puppeteer.launch({
            executablePath: CHROME_PATH,
            headless: false, 
            userDataDir: userDataDir,
            args: [
                '--start-maximized',
                `--window-position=${(index-1)*200},${(index-1)*100}`,
                '--window-size=1000,700',
                `--remote-debugging-port=${9220 + index}`,
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-extensions',
                '--mute-audio',
                '--disable-blink-features=AutomationControlled'
            ],
            ignoreDefaultArgs: ['--enable-automation'] 
        });

        const page = (await browser.pages())[0];
        stats.activeThreads++;
        
        logThread(threadId, `Đang kết nối tới YouTube...`);
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        logThread(threadId, `Đang tìm video trong Playlist...`);
        const videoSelector = 'a#video-title, ytd-playlist-video-renderer a';
        await page.waitForSelector(videoSelector, { timeout: 30000 });
        
        // Click bằng JavaScript để chắc chắn ăn
        await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) el.click();
        }, videoSelector);

        logThread(threadId, `Đã nhấn Play video.`);

        while (true) {
            await new Promise(r => setTimeout(r, 10000));
            const videoTitle = (await page.title()).replace('- YouTube', '').trim();
            
            // Random thời gian xem từ 3 - 5 phút
            const watchSecs = Math.floor(Math.random() * 120) + 180;
            logThread(threadId, `Đang xem: "${videoTitle}" trong ${watchSecs} giây...`);

            // Đợi xem hết thời gian
            await new Promise(r => setTimeout(r, watchSecs * 1000));

            stats.totalViews++;
            logThread(threadId, `✅ Đã hoàn thành 1 view. Tổng view máy: ${stats.totalViews}`);

            logThread(threadId, `Đang chuyển sang video tiếp theo (Shift + N)...`);
            await page.keyboard.down('Shift');
            await page.keyboard.press('N');
            await page.keyboard.up('Shift');
        }

    } catch (err) {
        logThread(threadId, `LỖI: ${err.message}`, true);
    } finally {
        if (browser) {
            logThread(threadId, `Đang đóng trình duyệt để khởi động lại...`);
            await browser.close();
        }
        stats.activeThreads--;
        // Nghỉ 15 giây rồi chạy lại chính nó (vòng lặp vô hạn)
        setTimeout(() => runWorker(index), 15000);
    }
}

async function main() {
    console.log("==========================================");
    console.log("   YOUTUBE BOT PRO - 4 LUỒNG CHROME THẬT  ");
    console.log("==========================================");
    
    for (let i = 1; i <= MAX_THREADS; i++) {
        runWorker(i);
        // Delay mở các luồng để tránh sốc CPU
        await new Promise(r => setTimeout(r, 10000)); 
    }
}

// Web Server để xem thống kê nhanh qua trình duyệt
app.get('/', (req, res) => {
    res.send(`<h1>BOT ĐANG CHẠY</h1><p>Tổng View: ${stats.totalViews}</p><p>Luồng đang mở: ${stats.activeThreads}</p>`);
});

app.listen(port, () => main());
