const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const UserAgents = require('user-agents');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

// --- CẤU HÌNH ---
const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 2; // Chạy ít luồng bằng IP thật để tránh bị xác minh robot (Captcha)
const COOKIE_FILE = './youtube_cookies.json';

let stats = { totalViews: 0, activeThreads: 0, threadStatus: {} };

async function humanize(page) {
    try {
        await page.mouse.move(Math.random() * 800, Math.random() * 600);
        if (Math.random() > 0.5) {
            await page.evaluate(() => window.scrollBy(0, Math.floor(Math.random() * 400)));
        }
    } catch (e) {}
}

async function runWorker() {
    if (stats.activeThreads >= MAX_THREADS) return;
    stats.activeThreads++;
    
    const threadId = Math.random().toString(36).substring(7);
    const userDataDir = path.join(__dirname, 'temp', `profile_${threadId}`);
    stats.threadStatus[threadId] = { title: 'Đang mở...', elapsed: 0, target: 0 };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: false, 
            userDataDir: userDataDir,
            args: [
                '--no-sandbox',
                '--start-maximized',
                '--disable-blink-features=AutomationControlled',
                '--disable-infobars',
                '--no-first-run'
            ],
            ignoreDefaultArgs: ['--enable-automation']
        });

        const page = (await browser.pages())[0];
        
        // Cấu hình vân tay trình duyệt để giống máy thật 100%
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            window.chrome = { runtime: {} };
        });

        if (fs.existsSync(COOKIE_FILE)) {
            const cookies = await fs.readJson(COOKIE_FILE);
            await page.setCookie(...cookies);
        }

        await page.setUserAgent(new UserAgents({ deviceCategory: 'desktop' }).toString());

        console.log(`[${threadId}] 🌍 Đang vào YouTube...`);
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });

        // Tự động tìm và bấm Video đầu tiên
        await page.waitForSelector('a.ytd-playlist-thumbnail', { timeout: 10000 });
        await page.click('a.ytd-playlist-thumbnail');

        for (let i = 0; i < 3; i++) { // Xem 3 video rồi đổi Profile mới
            await new Promise(r => setTimeout(r, 5000));
            const watchSecs = Math.floor(Math.random() * 60) + 180; // Xem ít nhất 3 phút
            
            stats.threadStatus[threadId].title = (await page.title()).split('- YouTube')[0];
            stats.threadStatus[threadId].target = watchSecs;
            stats.threadStatus[threadId].elapsed = 0;

            for (let s = 0; s < watchSecs; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[threadId].elapsed++;
                if (s % 30 === 0) await humanize(page);
            }

            stats.totalViews++;
            
            // Bấm Next
            await page.evaluate(() => {
                const btn = document.querySelector('.ytp-next-button');
                if (btn) btn.click();
            });
        }
    } catch (err) {
        console.log(`❌ Lỗi luồng: ${err.message}`);
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        delete stats.threadStatus[threadId];
        stats.activeThreads--;
    }
}

async function main() {
    while (true) {
        if (stats.activeThreads < MAX_THREADS) {
            runWorker();
        }
        await new Promise(r => setTimeout(r, 15000));
    }
}

app.get('/', (req, res) => {
    res.send(`<h1>BOT ĐANG CHẠY IP THẬT</h1><p>Tổng View: ${stats.totalViews}</p>`);
});

app.listen(port, () => {
    console.log(`DASHBOARD: http://localhost:${port}`);
    main();
});
