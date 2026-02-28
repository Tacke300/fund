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
const MAX_THREADS = 15; // Chạy ít luồng bằng IP thật để tránh bị spam IP
const COOKIE_FILE = './youtube_cookies.json';

let stats = {
    totalViews: 0, totalSeconds: 0, activeThreads: 0,
    threadStatus: {}, history: []
};

function formatTime(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${m}m ${s % 60}s`;
}

async function humanize(page) {
    try {
        await page.mouse.move(Math.random() * 800, Math.random() * 600);
        if (Math.random() > 0.5) {
            await page.evaluate(() => window.scrollBy({ top: Math.random() * 300, behavior: 'smooth' }));
        }
    } catch (e) {}
}

async function runWorker() {
    stats.activeThreads++;
    const threadId = Math.random().toString(36).substring(7);
    const userDataDir = path.join(__dirname, 'temp', `profile_${threadId}`);
    stats.threadStatus[threadId] = { proxy: 'IP THẬT', title: 'Đang khởi tạo...', elapsed: 0, target: 0, lastAction: '🚀 Khởi động', iteration: 0 };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: false,
            userDataDir: userDataDir,
            args: [
                '--no-sandbox',
                '--start-maximized',
                '--disable-blink-features=AutomationControlled',
                '--use-gl=desktop'
            ],
            ignoreDefaultArgs: ['--enable-automation']
        });

        const page = (await browser.pages())[0];
        await page.setViewport({ width: 1280, height: 720 });

        if (fs.existsSync(COOKIE_FILE)) {
            const cookies = await fs.readJson(COOKIE_FILE);
            await page.setCookie(...cookies);
        }

        await page.setUserAgent(new UserAgents({ deviceCategory: 'desktop' }).toString());

        stats.threadStatus[threadId].lastAction = '🌍 Vào YT...';
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        // Xử lý nút Chấp nhận/Đồng ý (nếu có)
        await page.evaluate(() => {
            const keys = ['Accept', 'Agree', 'Chấp nhận', 'Đồng ý', 'I agree'];
            const btns = Array.from(document.querySelectorAll('button, span, div'));
            const t = btns.find(b => keys.some(k => b.innerText && b.innerText.includes(k)));
            if (t) t.click();
        });

        // Đợi và click vào video đầu tiên (Sửa lỗi Not Clickable)
        const videoSelector = 'a.ytd-playlist-thumbnail, #video-title, .ytd-playlist-video-renderer a';
        await page.waitForSelector(videoSelector, { timeout: 15000 });
        await page.evaluate((sel) => {
            document.querySelector(sel).click();
        }, videoSelector);

        for (let i = 0; i < 5; i++) {
            await new Promise(r => setTimeout(r, 8000));
            let currentTitle = await page.title();
            
            const watchSecs = Math.floor(Math.random() * 50) + 180; // Xem ~3 phút
            stats.threadStatus[threadId].title = currentTitle.replace("- YouTube", "");
            stats.threadStatus[threadId].iteration = i + 1;
            stats.threadStatus[threadId].target = watchSecs;
            stats.threadStatus[threadId].elapsed = 0;
            stats.threadStatus[threadId].lastAction = '👀 Cày view';

            for (let s = 0; s < watchSecs; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[threadId].elapsed++;
                stats.totalSeconds++;
                if (s % 30 === 0) await humanize(page);
            }

            stats.totalViews++;
            stats.history.unshift({ title: currentTitle, proxy: 'IP THẬT', time: new Date().toLocaleTimeString() });
            if (stats.history.length > 10) stats.history.pop();

            // Click Next video
            const hasNext = await page.evaluate(() => {
                const n = document.querySelector('.ytp-next-button');
                if(n && window.getComputedStyle(n).display !== 'none') { n.click(); return true; }
                return false;
            });
            if (!hasNext) break;
        }

    } catch (err) {
        console.log(`❌ Lỗi luồng ${threadId}: ${err.message}`);
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        delete stats.threadStatus[threadId];
        stats.activeThreads--;
    }
}

async function main() {
    console.log("🚀 BOT ĐÃ SẴN SÀNG - CHẾ ĐỘ IP THẬT");
    while (true) {
        if (stats.activeThreads < MAX_THREADS) {
            runWorker();
            await new Promise(r => setTimeout(r, 20000)); 
        } else {
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

// --- GIAO DIỆN DASHBOARD XỊN ---
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:Segoe UI,sans-serif; background:#0d1117; color:#c9d1d9; padding:20px">
            <h1 style="color:#58a6ff">🛰️ YT BOT PRO - HOME NETWORK MODE</h1>
            <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:10px; margin-bottom:20px">
                <div style="background:#161b22; padding:15px; border-left:5px solid #3fb950">
                    <small>VIEWS HOÀN TẤT</small><br><b style="font-size:24px">${stats.totalViews}</b>
                </div>
                <div style="background:#161b22; padding:15px; border-left:5px solid #d29922">
                    <small>TỔNG THỜI GIAN</small><br><b style="font-size:24px">${formatTime(stats.totalSeconds)}</b>
                </div>
                <div style="background:#161b22; padding:15px; border-left:5px solid #0af">
                    <small>LUỒNG ĐANG CHẠY</small><br><b style="font-size:24px">${stats.activeThreads}</b>
                </div>
            </div>
            <table style="width:100%; border-collapse:collapse; background:#161b22">
                <tr style="background:#21262d; text-align:left">
                    <th style="padding:12px">LUỒNG</th><th>VIDEO</th><th>TIẾN ĐỘ</th><th>HÀNH ĐỘNG</th>
                </tr>
                ${Object.entries(stats.threadStatus).map(([id, t]) => `
                <tr style="border-bottom:1px solid #333">
                    <td style="padding:10px; color:#0af">${id}</td>
                    <td><small>[${t.iteration}]</small> ${t.title}</td>
                    <td>${t.elapsed}/${t.target}s</td>
                    <td style="color:#3fb950">${t.lastAction}</td>
                </tr>`).join('')}
            </table>
            <h3 style="margin-top:30px">LỊCH SỬ GẦN ĐÂY</h3>
            <ul style="list-style:none; padding:0">
                ${stats.history.map(h => `<li style="padding:5px 0; border-bottom:1px solid #21262d">⏰ ${h.time} - ${h.title}</li>`).join('')}
            </ul>
            <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`DASHBOARD: http://localhost:1111`);
    main();
});
