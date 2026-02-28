const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const UserAgents = require('user-agents');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const colors = require('colors');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

// --- CẤU HÌNH ---
const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 20; 
const COOKIE_DIR = './cookies';
const BLACKLIST_FILE = './blacklist_proxy.json';

let stats = {
    totalViews: 0, totalSeconds: 0, activeThreads: 0,
    threadStatus: {}, logs: []
};

// 1. HÀM LOG SIÊU CHI TIẾT
function doLog(threadId, msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    let coloredMsg = `[${time}] [${threadId}] ${msg}`;
    
    if (type === 'success') console.log(coloredMsg.green);
    else if (type === 'error') console.log(coloredMsg.red);
    else if (type === 'warn') console.log(coloredMsg.yellow);
    else console.log(coloredMsg.cyan);

    stats.logs.unshift({ time, threadId, msg, type });
    if (stats.logs.length > 100) stats.logs.pop();
}

// 2. CHẾ ĐỘ HÚT COOKIE & NHÂN BẢN
async function loginAndSaveCookies() {
    doLog('SYSTEM', "🚀 ĐANG MỞ TRÌNH DUYỆT ĐỂ ĐĂNG NHẬP...", 'warn');
    const browser = await puppeteer.launch({
        headless: false,
        args: ['--no-sandbox', '--window-size=1280,720']
    });
    const page = await browser.newPage();
    await page.goto('https://accounts.google.com/ServiceLogin?service=youtube', { waitUntil: 'networkidle2' });

    doLog('SYSTEM', "🕒 Đợi ông đăng nhập... Hãy vào đến trang chủ YouTube nhé!", 'warn');
    
    try {
        await page.waitForFunction(() => window.location.href.includes('youtube.com'), { timeout: 120000 });
        const cookies = await page.cookies();
        if (!fs.existsSync(COOKIE_DIR)) fs.mkdirSync(COOKIE_DIR);

        for (let i = 1; i <= MAX_THREADS; i++) {
            await fs.writeJson(path.join(COOKIE_DIR, `cookie${i}.json`), cookies);
        }
        doLog('SYSTEM', "✅ ĐÃ NHÂN BẢN 20 COOKIE THÀNH CÔNG!", 'success');
    } catch (e) {
        doLog('SYSTEM', "❌ Lỗi hoặc hết thời gian đăng nhập!", 'error');
    }
    await browser.close();
    process.exit();
}

// 3. WORKER CHẠY VIEW
async function runWorker(index) {
    stats.activeThreads++;
    const threadId = `THREAD-${index.toString().padStart(2, '0')}`;
    const cookieFile = path.join(COOKIE_DIR, `cookie${index}.json`);
    const userDataDir = path.join(__dirname, 'temp', `profile_${index}`);

    stats.threadStatus[threadId] = { title: '---', progress: 0, status: 'Khởi động', cookie: '❌' };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: userDataDir,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--mute-audio']
        });

        const page = await browser.newPage();
        await page.setUserAgent(new UserAgents().toString());

        // Nạp Cookie
        if (fs.existsSync(cookieFile)) {
            const cookies = await fs.readJson(cookieFile);
            await page.setCookie(...cookies);
            stats.threadStatus[threadId].cookie = '✅';
        }

        doLog(threadId, "🌐 Đang tiến vào Playlist...", 'info');
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        // Click Play
        await new Promise(r => setTimeout(r, 5000));
        await page.evaluate(() => {
            const btn = document.querySelector('a.ytd-playlist-thumbnail') || document.querySelector('#video-title');
            if (btn) btn.click();
        });

        for (let v = 1; v <= 10; v++) {
            await new Promise(r => setTimeout(r, 8000));
            const title = (await page.title()).replace("- YouTube", "");
            stats.threadStatus[threadId].title = title;
            
            const watchTime = Math.floor(Math.random() * 60) + 180; // 3-4 phút
            doLog(threadId, `📺 Đang xem: ${title.substring(0,25)}... (${watchTime}s)`, 'success');

            for (let s = 1; s <= watchTime; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[threadId].progress = Math.floor((s / watchTime) * 100);
                stats.threadStatus[threadId].status = `Xem video ${v}: ${s}s`;
                stats.totalSeconds++;
            }

            stats.totalViews++;
            // Chuyển bài
            await page.evaluate(() => document.querySelector('.ytp-next-button')?.click());
        }
    } catch (err) {
        doLog(threadId, `❌ Lỗi: ${err.message.substring(0, 40)}`, 'error');
    } finally {
        if (browser) await browser.close();
        await fs.remove(userDataDir).catch(() => {});
        delete stats.threadStatus[threadId];
        stats.activeThreads--;
        setTimeout(() => runWorker(index), 5000); // Tự động hồi sinh luồng
    }
}

// 4. DASHBOARD HTML
app.get('/', (req, res) => {
    const rows = Object.entries(stats.threadStatus).map(([id, t]) => `
        <tr style="border-bottom: 1px solid #333">
            <td style="color:#0af; padding:12px"><b>${id}</b></td>
            <td style="text-align:center">${t.cookie}</td>
            <td style="font-size:12px">${t.title}</td>
            <td style="width:150px">
                <div style="background:#333; height:8px; border-radius:4px">
                    <div style="width:${t.progress}%; background:#3fb950; height:8px; border-radius:4px"></div>
                </div>
                <small>${t.progress}%</small>
            </td>
            <td style="color:yellow; font-size:12px">${t.status}</td>
        </tr>`).join('');

    const logItems = stats.logs.map(l => `
        <div style="color:${l.type==='error'?'#f85149':l.type==='success'?'#3fb950':'#8b949e'}; font-size:11px; margin-bottom:4px">
            [${l.time}] [${l.threadId}] ${l.msg}
        </div>`).join('');

    res.send(`
        <body style="background:#0d1117; color:#c9d1d9; font-family:Consolas, monospace; padding:20px; margin:0">
            <div style="display:flex; height:100vh; gap:15px">
                <div style="flex:2; overflow-y:auto">
                    <h2 style="color:#58a6ff; margin:0 0 15px 0">🛰️ YT SUPREME V7 - DASHBOARD</h2>
                    <div style="display:flex; gap:10px; margin-bottom:15px">
                        <div style="background:#161b22; padding:10px; border-radius:5px; border-left:4px solid #3fb950">VIEWS: <b>${stats.totalViews}</b></div>
                        <div style="background:#161b22; padding:10px; border-radius:5px; border-left:4px solid #0af">LUỒNG: <b>${stats.activeThreads}</b></div>
                    </div>
                    <table style="width:100%; border-collapse:collapse; background:#161b22; border-radius:8px; overflow:hidden">
                        <tr style="background:#21262d; text-align:left">
                            <th style="padding:12px">THREAD</th><th>CK</th><th>VIDEO</th><th>PROGRESS</th><th>STATUS</th>
                        </tr>
                        ${rows}
                    </table>
                </div>
                <div style="flex:1; background:#000; padding:15px; overflow-y:auto; border-left:1px solid #30363d">
                    <h4 style="color:#bc8cff; margin:0 0 10px 0">TERMINAL REALTIME</h4>
                    ${logItems}
                </div>
            </div>
            <script>setTimeout(() => location.reload(), 2500)</script>
        </body>
    `);
});

// 5. KHỞI CHẠY
const args = process.argv.slice(2);
if (args.includes('--login')) {
    loginAndSaveCookies();
} else {
    app.listen(port, () => {
        console.log(`DASHBOARD: http://localhost:${port}`.cyan.bold);
        for (let i = 1; i <= MAX_THREADS; i++) {
            setTimeout(() => runWorker(i), i * 3500);
        }
    });
}
