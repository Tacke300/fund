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
const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 10; // Chạy 15 luồng
const COOKIE_FILE = './youtube_cookies.json';
const BASE_TEMP_DIR = path.join(__dirname, 'temp');

let stats = {
    totalViews: 0, totalSeconds: 0, activeThreads: 0,
    threadStatus: {}, history: []
};

// Dọn dẹp rác khi khởi động lại
if (fs.existsSync(BASE_TEMP_DIR)) fs.removeSync(BASE_TEMP_DIR);
fs.ensureDirSync(BASE_TEMP_DIR);

function formatTime(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${m}m ${s % 60}s`;
}

async function humanize(page) {
    try {
        await page.mouse.move(Math.random() * 500, Math.random() * 500);
        await page.evaluate(() => window.scrollBy(0, Math.floor(Math.random() * 200)));
    } catch (e) {}
}

async function runWorker(index) {
    stats.activeThreads++;
    const threadId = `THREAD-${index.toString().padStart(2, '0')}`;
    const userDataDir = path.join(BASE_TEMP_DIR, `profile_${index}`);
    
    stats.threadStatus[threadId] = { 
        proxy: 'LOCAL_IP', title: '---', elapsed: 0, target: 0, 
        lastAction: '🚀 Khởi động', iteration: 0 
    };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: false, // Hiện màn hình
            userDataDir: userDataDir,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-size=800,600', // Thu nhỏ để chạy được 15 luồng
                '--mute-audio',
                '--disable-blink-features=AutomationControlled'
            ],
            ignoreDefaultArgs: ['--enable-automation']
        });

        const page = (await browser.pages())[0];
        await page.setViewport({ width: 800, height: 600 });

        if (fs.existsSync(COOKIE_FILE)) {
            const cookies = await fs.readJson(COOKIE_FILE);
            await page.setCookie(...cookies);
        }

        await page.setUserAgent(new UserAgents({ deviceCategory: 'desktop' }).toString());

        stats.threadStatus[threadId].lastAction = '🌍 Vào Playlist';
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        // Tìm và Click video đầu tiên bằng JavaScript (Chống lỗi Not Clickable)
        await page.waitForSelector('a#video-title, ytd-playlist-video-renderer a', { timeout: 20000 });
        await page.evaluate(() => {
            const vid = document.querySelector('a#video-title') || document.querySelector('ytd-playlist-video-renderer a');
            if (vid) vid.click();
        });

        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 10000));
            let currentTitle = await page.title();
            
            const watchSecs = Math.floor(Math.random() * 50) + 180; // 3 phút +
            stats.threadStatus[threadId].title = currentTitle.replace("- YouTube", "");
            stats.threadStatus[threadId].iteration = i + 1;
            stats.threadStatus[threadId].target = watchSecs;
            stats.threadStatus[threadId].lastAction = '👀 Đang xem';

            for (let s = 0; s < watchSecs; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[threadId].elapsed = s;
                stats.totalSeconds++;
                if (s % 30 === 0) await humanize(page);
            }

            stats.totalViews++;
            stats.history.unshift({ title: currentTitle, time: new Date().toLocaleTimeString() });
            if (stats.history.length > 15) stats.history.pop();

            // Next Video bằng phím tắt chuẩn YT
            await page.keyboard.down('Shift');
            await page.keyboard.press('N');
            await page.keyboard.up('Shift');
            stats.threadStatus[threadId].lastAction = '⏭️ Chuyển video';
        }

    } catch (err) {
        console.log(`❌ [${threadId}] Lỗi: ${err.message}`);
    } finally {
        if (browser) await browser.close();
        delete stats.threadStatus[threadId];
        stats.activeThreads--;
        // Đợi 10s rồi luồng này tự hồi sinh (vòng lặp vô hạn)
        setTimeout(() => runWorker(index), 10000);
    }
}

// Khởi chạy 15 luồng song song
async function main() {
    console.log(`🚀 ĐANG KHỞI CHẠY ${MAX_THREADS} LUỒNG...`);
    for (let i = 1; i <= MAX_THREADS; i++) {
        runWorker(i);
        await new Promise(r => setTimeout(r, 5000)); // Delay mở từng luồng để không treo máy
    }
}

// --- GIAO DIỆN DASHBOARD ---
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:Segoe UI,sans-serif; background:#0d1117; color:#c9d1d9; padding:20px">
            <h1 style="color:#58a6ff">🛰️ YT BOT V5 - 15 THREADS VISUAL</h1>
            <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:10px; margin-bottom:20px">
                <div style="background:#161b22; padding:15px; border-left:5px solid #3fb950">
                    <small>TỔNG VIEWS</small><br><b style="font-size:24px">${stats.totalViews}</b>
                </div>
                <div style="background:#161b22; padding:15px; border-left:5px solid #d29922">
                    <small>TỔNG THỜI GIAN</small><br><b style="font-size:24px">${formatTime(stats.totalSeconds)}</b>
                </div>
                <div style="background:#161b22; padding:15px; border-left:5px solid #bc8cff">
                    <small>LUỒNG HOẠT ĐỘNG</small><br><b style="font-size:24px">${stats.activeThreads}/${MAX_THREADS}</b>
                </div>
            </div>
            <table style="width:100%; border-collapse:collapse; background:#161b22">
                <tr style="background:#21262d; text-align:left">
                    <th style="padding:12px">LUỒNG</th><th>VIDEO</th><th>TIẾN ĐỘ</th><th>HÀNH ĐỘNG</th>
                </tr>
                ${Object.entries(stats.threadStatus).sort().map(([id, t]) => `
                <tr style="border-bottom:1px solid #333">
                    <td style="padding:10px; color:#0af">${id}</td>
                    <td><small>[${t.iteration}]</small> ${t.title}</td>
                    <td>${t.elapsed}/${t.target}s</td>
                    <td style="color:#3fb950">${t.lastAction}</td>
                </tr>`).join('')}
            </table>
            <script>setTimeout(() => location.reload(), 2000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`DASHBOARD: http://localhost:1111`);
    main();
});
