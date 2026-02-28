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
const MAX_THREADS = 7; // Chạy 7 luồng cho ổn định IP và RAM
const BASE_TEMP_DIR = path.join(__dirname, 'temp');

let stats = {
    totalViews: 0, totalSeconds: 0, activeThreads: 0,
    threadStatus: {}, history: []
};

// Dọn dẹp rác khi khởi động
if (fs.existsSync(BASE_TEMP_DIR)) fs.removeSync(BASE_TEMP_DIR);
fs.ensureDirSync(BASE_TEMP_DIR);

function formatTime(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${m}m ${s % 60}s`;
}

async function runWorker(index) {
    stats.activeThreads++;
    const threadId = `THREAD-${index.toString().padStart(2, '0')}`;
    const userDataDir = path.join(BASE_TEMP_DIR, `profile_${index}`);
    
    stats.threadStatus[threadId] = { 
        title: '---', elapsed: 0, target: 0, 
        lastAction: '🚀 Khởi động', iteration: 0 
    };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: false,
            userDataDir: userDataDir,
            args: [
                '--no-sandbox',
                '--window-size=800,600',
                '--mute-audio',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu'
            ],
            ignoreDefaultArgs: ['--enable-automation']
        });

        const page = (await browser.pages())[0];
        await page.setDefaultNavigationTimeout(90000); // Đợi 1.5 phút (Chống lỗi Timeout)

        // CHẾ ĐỘ SIÊU NHẸ: Chặn tải ảnh và CSS không cần thiết để máy không treo
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'stylesheet'].includes(req.resourceType()) && !req.url().includes('youtube.com')) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setUserAgent(new UserAgents({ deviceCategory: 'desktop' }).toString());

        stats.threadStatus[threadId].lastAction = '🌍 Đang tải YouTube...';
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });

        // Tìm và Click video đầu tiên
        await page.waitForSelector('a#video-title, ytd-playlist-video-renderer a', { timeout: 30000 });
        await page.evaluate(() => {
            const vid = document.querySelector('a#video-title') || document.querySelector('ytd-playlist-video-renderer a');
            if (vid) vid.click();
        });

        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 10000));
            let currentTitle = await page.title();
            
            const watchSecs = Math.floor(Math.random() * 60) + 180; // Xem ít nhất 3 phút
            stats.threadStatus[threadId].title = currentTitle.replace("- YouTube", "");
            stats.threadStatus[threadId].iteration = i + 1;
            stats.threadStatus[threadId].target = watchSecs;
            stats.threadStatus[threadId].lastAction = '👀 Đang xem';

            for (let s = 0; s < watchSecs; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[threadId].elapsed = s;
                stats.totalSeconds++;
            }

            stats.totalViews++;
            stats.history.unshift({ title: currentTitle, time: new Date().toLocaleTimeString() });
            if (stats.history.length > 10) stats.history.pop();

            // Chuyển video bằng phím tắt (chuẩn xác nhất)
            await page.keyboard.down('Shift');
            await page.keyboard.press('N');
            await page.keyboard.up('Shift');
            stats.threadStatus[threadId].lastAction = '⏭️ Đổi video';
        }

    } catch (err) {
        let errorVn = "Lỗi hệ thống";
        if (err.message.includes('timeout')) errorVn = "Mạng yếu hoặc máy treo (Timeout)";
        else if (err.message.includes('not clickable')) errorVn = "Bị quảng cáo đè, không bấm được";
        else if (err.message.includes('Target closed')) errorVn = "Trình duyệt bị sập (Hết RAM)";
        
        console.log(`❌ [${threadId}] ${errorVn}`);
    } finally {
        if (browser) await browser.close();
        delete stats.threadStatus[threadId];
        stats.activeThreads--;
        // Nghỉ 10 giây rồi luồng này tự chạy lại profile của nó
        setTimeout(() => runWorker(index), 10000);
    }
}

async function main() {
    console.log(`🚀 ĐANG KHỞI CHẠY 7 LUỒNG...`);
    for (let i = 1; i <= MAX_THREADS; i++) {
        runWorker(i);
        await new Promise(r => setTimeout(r, 10000)); // Mở luồng mới cách nhau 10 giây cho an toàn
    }
}

// --- GIAO DIỆN DASHBOARD ---
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:Segoe UI,sans-serif; background:#0d1117; color:#c9d1d9; padding:20px">
            <h1 style="color:#58a6ff">🛰️ YT BOT PRO - 7 LUỒNG SIÊU NHẸ</h1>
            <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:10px; margin-bottom:20px">
                <div style="background:#161b22; padding:15px; border-left:5px solid #3fb950">
                    <small>TỔNG VIEWS</small><br><b style="font-size:24px">${stats.totalViews}</b>
                </div>
                <div style="background:#161b22; padding:15px; border-left:5px solid #d29922">
                    <small>TỔNG THỜI GIAN</small><br><b style="font-size:24px">${formatTime(stats.totalSeconds)}</b>
                </div>
                <div style="background:#161b22; padding:15px; border-left:5px solid #bc8cff">
                    <small>LUỒNG CHẠY</small><br><b style="font-size:24px">${stats.activeThreads}/${MAX_THREADS}</b>
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
            <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`DASHBOARD: http://localhost:1111`);
    main();
});
