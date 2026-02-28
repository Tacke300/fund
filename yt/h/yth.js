const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

// --- CẤU HÌNH ĐƯỜNG DẪN CHROME THẬT ---
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'; 
const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 4;
const BASE_TEMP_DIR = path.join(__dirname, 'profiles');

let stats = { totalViews: 0, totalSeconds: 0, activeThreads: 0, threadStatus: {}, history: [] };

// Tạo thư mục chứa Profile nếu chưa có
fs.ensureDirSync(BASE_TEMP_DIR);

function formatTime(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${m}m ${s % 60}s`;
}

async function runWorker(index) {
    stats.activeThreads++;
    const threadId = `THREAD-${index.toString().padStart(2, '0')}`;
    const userDataDir = path.join(BASE_TEMP_DIR, `user_data_${index}`);
    
    stats.threadStatus[threadId] = { title: '---', elapsed: 0, target: 0, lastAction: '🚀 Mở Chrome thật', iteration: 0 };

    let browser;
    try {
        browser = await puppeteer.launch({
            executablePath: CHROME_PATH, // CHỈ ĐỊNH CHROME THẬT
            headless: false, 
            userDataDir: userDataDir,
            args: [
                '--no-sandbox',
                '--window-size=800,600',
                '--mute-audio',
                '--disable-blink-features=AutomationControlled',
                '--no-first-run',
                '--no-default-browser-check'
            ],
            ignoreDefaultArgs: ['--enable-automation']
        });

        const page = (await browser.pages())[0];
        await page.setDefaultNavigationTimeout(90000);

        stats.threadStatus[threadId].lastAction = '🌍 Vào YouTube...';
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });

        // Click Video đầu tiên bằng JS để tránh bị đè
        await page.waitForSelector('a#video-title', { timeout: 30000 });
        await page.evaluate(() => {
            const vid = document.querySelector('a#video-title') || document.querySelector('ytd-playlist-video-renderer a');
            if (vid) vid.click();
        });

        for (let i = 0; i < 5; i++) {
            await new Promise(r => setTimeout(r, 10000));
            let currentTitle = await page.title();
            
            const watchSecs = Math.floor(Math.random() * 60) + 180; 
            stats.threadStatus[threadId].title = currentTitle.replace("- YouTube", "");
            stats.threadStatus[threadId].iteration = i + 1;
            stats.threadStatus[threadId].target = watchSecs;
            stats.threadStatus[threadId].lastAction = '👀 Đang cày';

            for (let s = 0; s < watchSecs; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[threadId].elapsed = s;
                stats.totalSeconds++;
                // Thi thoảng cuộn chuột cho giống người
                if (s % 40 === 0) await page.evaluate(() => window.scrollBy(0, 100));
            }

            stats.totalViews++;
            stats.history.unshift({ title: currentTitle, time: new Date().toLocaleTimeString() });

            // Next bằng phím tắt
            await page.keyboard.down('Shift');
            await page.keyboard.press('N');
            await page.keyboard.up('Shift');
        }

    } catch (err) {
        let vnMsg = "Lỗi Chrome";
        if (err.message.includes('timeout')) vnMsg = "Mạng yếu (Timeout)";
        else if (err.message.includes('not clickable')) vnMsg = "Lỗi nút bấm/Ads";
        console.log(`❌ [${threadId}] ${vnMsg}`);
    } finally {
        if (browser) await browser.close();
        delete stats.threadStatus[threadId];
        stats.activeThreads--;
        setTimeout(() => runWorker(index), 15000);
    }
}

async function main() {
    console.log(`🚀 KHỞI CHẠY 7 LUỒNG BẰNG CHROME THẬT...`);
    for (let i = 1; i <= MAX_THREADS; i++) {
        runWorker(i);
        await new Promise(r => setTimeout(r, 12000)); 
    }
}

// Giao diện Dashboard (Giữ nguyên phong cách của ông)
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:sans-serif; background:#0d1117; color:#c9d1d9; padding:20px">
            <h1 style="color:#58a6ff">🛰️ YT BOT - REAL CHROME MODE</h1>
            <div style="display:flex; gap:10px; margin-bottom:20px">
                <div style="background:#161b22; padding:15px; border-radius:5px">VIEWS: <b>${stats.totalViews}</b></div>
                <div style="background:#161b22; padding:15px; border-radius:5px">TIME: <b>${formatTime(stats.totalSeconds)}</b></div>
                <div style="background:#161b22; padding:15px; border-radius:5px">THREADS: <b>${stats.activeThreads}</b></div>
            </div>
            <table border="1" style="width:100%; border-collapse:collapse; background:#161b22; border:none">
                <tr style="background:#21262d"><th>ID</th><th>VIDEO</th><th>TIẾN ĐỘ</th><th>HÀNH ĐỘNG</th></tr>
                ${Object.entries(stats.threadStatus).sort().map(([id, t]) => `
                <tr style="text-align:center">
                    <td style="padding:8px">${id}</td>
                    <td>${t.title}</td>
                    <td>${t.elapsed}/${t.target}s</td>
                    <td style="color:#3fb950">${t.lastAction}</td>
                </tr>`).join('')}
            </table>
            <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
    `);
});

app.listen(port, () => main());
