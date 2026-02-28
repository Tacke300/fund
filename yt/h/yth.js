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
const MAX_THREADS = 4;
const BASE_TEMP_DIR = path.resolve(__dirname, 'profiles');

let stats = { totalViews: 0, totalSeconds: 0, activeThreads: 0, threadStatus: {}, history: [] };

// Hàm Log chi tiết để ông soi lỗi
function logSystem(id, msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const icon = type === 'error' ? '❌' : (type === 'success' ? '✅' : '🔹');
    console.log(`[${time}] [${id}] ${icon} ${msg}`);
}

async function runWorker(index) {
    const threadId = `THREAD-${index.toString().padStart(2, '0')}`;
    const userDataDir = path.join(BASE_TEMP_DIR, `data_${index}`);
    
    fs.ensureDirSync(userDataDir);
    logSystem(threadId, `Bắt đầu khởi tạo Profile tại: ${userDataDir}`);

    let browser;
    try {
        // KIỂM TRA FILE CHROME TRƯỚC KHI CHẠY
        if (!fs.existsSync(CHROME_PATH)) {
            throw new Error(`Đường dẫn Chrome sai! Không tìm thấy file tại ${CHROME_PATH}`);
        }

        logSystem(threadId, `Đang gọi Chrome thật (Cửa sổ hiện hình)...`);
        
        browser = await puppeteer.launch({
            executablePath: CHROME_PATH,
            headless: false, // Ép hiện màn hình
            userDataDir: userDataDir,
            args: [
                '--start-maximized',
                `--window-position=${(index-1)*200},${(index-1)*100}`,
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
        stats.threadStatus[threadId] = { title: '---', elapsed: 0, target: 0, lastAction: '🚀 Khởi động' };

        logSystem(threadId, `Đang truy cập Playlist YouTube...`);
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        logSystem(threadId, `Đang tìm nút Play trong danh sách...`);
        const videoSelector = 'a#video-title, ytd-playlist-video-renderer a';
        await page.waitForSelector(videoSelector, { timeout: 30000 });
        
        // Click bằng JS để tránh bị lỗi "Node not clickable"
        await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) el.click();
        }, videoSelector);

        logSystem(threadId, `Đã nhấn Play! Bắt đầu chu kỳ xem.`);

        while (true) {
            await new Promise(r => setTimeout(r, 10000));
            let currentTitle = await page.title();
            let watchSecs = Math.floor(Math.random() * 60) + 180; // Xem 3-4 phút
            
            stats.threadStatus[threadId].title = currentTitle.replace("- YouTube", "");
            stats.threadStatus[threadId].target = watchSecs;
            stats.threadStatus[threadId].lastAction = '👀 Đang xem';

            logSystem(threadId, `Đang xem video: ${currentTitle} (${watchSecs}s)`);

            for (let s = 0; s < watchSecs; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[threadId].elapsed = s;
                stats.totalSeconds++;
            }

            stats.totalViews++;
            logSystem(threadId, `✅ Đã xong 1 View! Đang chuyển video tiếp theo...`, 'success');

            // Phím tắt Next video (Shift + N)
            await page.keyboard.down('Shift');
            await page.keyboard.press('N');
            await page.keyboard.up('Shift');
        }

    } catch (err) {
        logSystem(threadId, `LỖI CHÍ MẠNG: ${err.message}`, 'error');
        if (err.message.includes('user_data')) {
            logSystem(threadId, `LƯU Ý: Có thể Profile đang bị chiếm dụng. Hãy tắt hết Chrome thủ công!`, 'error');
        }
    } finally {
        if (browser) await browser.close();
        stats.activeThreads--;
        logSystem(threadId, `Luồng tạm nghỉ 15s trước khi hồi sinh...`);
        setTimeout(() => runWorker(index), 15000);
    }
}

async function main() {
    console.log("------------------------------------------");
    console.log("🔥 BOT ĐÃ SẴN SÀNG - CHẾ ĐỘ HIỆN MÀN HÌNH 🔥");
    console.log("------------------------------------------");
    for (let i = 1; i <= MAX_THREADS; i++) {
        runWorker(i);
        await new Promise(r => setTimeout(r, 10000)); 
    }
}

// Giữ lại cái Dashboard cho ông check qua Web
app.get('/', (req, res) => {
    res.send(`<h1>VIEW: ${stats.totalViews}</h1><p>THREADS: ${stats.activeThreads}</p>`);
});

app.listen(port, () => main());
