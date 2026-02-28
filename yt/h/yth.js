const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs-extra');

puppeteer.use(StealthPlugin());

// --- CẤU HÌNH BẮT BUỘC ---
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'; 
const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 4;
const BASE_TEMP_DIR = path.resolve(__dirname, 'profiles');

let totalViews = 0;

function logThread(id, msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const icon = type === 'error' ? '❌' : (type === 'success' ? '✅' : '🔹');
    console.log(`[${time}] [${id}] ${icon} ${msg}`);
}

async function runWorker(index) {
    const threadId = `THREAD-${index.toString().padStart(2, '0')}`;
    const userDataDir = path.join(BASE_TEMP_DIR, `data_${index}`);
    fs.ensureDirSync(userDataDir);

    let browser;
    try {
        logThread(threadId, `Đang gọi Chrome thật tại: ${CHROME_PATH}`);
        
        browser = await puppeteer.launch({
            executablePath: CHROME_PATH,
            headless: false, // HIỆN MÀN HÌNH
            userDataDir: userDataDir,
            args: [
                '--start-maximized',
                `--window-position=${(index-1)*200},${(index-1)*100}`,
                `--remote-debugging-port=${9220 + index}`,
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-extensions',
                '--mute-audio',
                '--disable-blink-features=AutomationControlled',
                // Ép Windows nhả UI ra màn hình chính
                '--force-device-scale-factor=1',
                '--high-dpi-support=1'
            ],
            ignoreDefaultArgs: ['--enable-automation'] 
        });

        const page = (await browser.pages())[0];
        
        logThread(threadId, `Đang mở Playlist...`);
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        const videoSelector = 'a#video-title, ytd-playlist-video-renderer a';
        await page.waitForSelector(videoSelector, { timeout: 30000 });
        
        await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) el.click();
        }, videoSelector);

        logThread(threadId, `Đã nhấn Play! Bắt đầu cày view.`);

        while (true) {
            await new Promise(r => setTimeout(r, 10000));
            const title = (await page.title()).replace("- YouTube", "").trim();
            const watchSecs = Math.floor(Math.random() * 61) + 180; // 3-4 phút
            
            logThread(threadId, `Đang xem: "${title}" trong ${watchSecs}s`);
            await new Promise(r => setTimeout(r, watchSecs * 1000));

            totalViews++;
            logThread(threadId, `✅ Xong 1 View. Tổng máy: ${totalViews}`, 'success');

            // Next video (Shift + N)
            await page.keyboard.down('Shift');
            await page.keyboard.press('N');
            await page.keyboard.up('Shift');
            logThread(threadId, `Đang chuyển video tiếp theo...`);
        }

    } catch (err) {
        logThread(threadId, `LỖI: ${err.message}`, 'error');
        if (err.message.includes('user_data')) {
            logThread(threadId, `Gợi ý: Tắt hết Chrome đang mở thủ công trước!`, 'error');
        }
    } finally {
        if (browser) await browser.close();
        logThread(threadId, `Khởi động lại luồng sau 15s...`);
        setTimeout(() => runWorker(index), 15000);
    }
}

console.log("🚀 BOT ĐANG CHẠY CHẾ ĐỘ HIỆN HÌNH - 4 LUỒNG");
for (let i = 1; i <= MAX_THREADS; i++) {
    runWorker(i);
}
