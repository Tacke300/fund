const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

// --- CẤU HÌNH ---
const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 10; // Giảm xuống 10 để ổn định trên Windows
const TEMP_DIR = path.join(__dirname, 'temp');

// Tự động dọn dẹp thư mục tạm khi khởi động để tránh lỗi EPERM
if (fs.existsSync(TEMP_DIR)) {
    try { fs.removeSync(TEMP_DIR); } catch (e) { console.log("Cảnh báo: Không thể xóa temp, hãy đóng Chrome ngầm."); }
}
fs.ensureDirSync(TEMP_DIR);

let stats = {
    totalViews: 0, activeThreads: 0,
    proxyReady: 0, proxiesScraped: 0,
    threadStatus: {}, logs: []
};

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    stats.logs.unshift(`[${time}] ${msg}`);
    if (stats.logs.length > 50) stats.logs.pop();
    console.log(`[${time}] ${msg}`);
}

let proxyList = [];
let blacklist = {};

async function fetchProxies() {
    addLog("🔍 Đang quét nguồn Proxy mới...");
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt'
    ];
    let all = [];
    for (let s of sources) {
        try {
            const res = await axios.get(s, { timeout: 10000 });
            all = all.concat(res.data.split('\n').map(p => p.trim()));
        } catch (e) {}
    }
    proxyList = [...new Set(all)].filter(p => p.includes(':') && !blacklist[p]);
    stats.proxyReady = proxyList.length;
    stats.proxiesScraped += proxyList.length;
}

async function runWorker(proxy) {
    stats.activeThreads++;
    const id = Math.random().toString(36).substring(7).toUpperCase();
    const userDataDir = path.join(TEMP_DIR, `profile_${id}_${Date.now()}`); // Thêm timestamp để tránh trùng tên folder
    
    stats.threadStatus[id] = { proxy, title: 'Khởi tạo...', elapsed: 0, target: 0, lastAction: '🚀 Start' };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: userDataDir,
            args: [
                `--proxy-server=http://${proxy}`,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Chống crash RAM
                '--disable-features=IsolateOrigins,site-per-process' // Giảm lỗi Frame
            ]
        });

        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(40000); // Giảm timeout xuống 40s để đổi proxy nhanh hơn

        stats.threadStatus[id].lastAction = '🌍 Loading...';
        await page.goto(PLAYLIST_URL, { waitUntil: 'domcontentloaded' }); // Dùng domcontentloaded để nhanh hơn

        // Nhấn nút đồng ý
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const ok = btns.find(b => /Accept|Agree|Đồng ý|Chấp nhận/i.test(b.innerText));
            if (ok) ok.click();
        });

        // Click Video đầu tiên
        const hasVideo = await page.evaluate(() => {
            const link = document.querySelector('a.ytd-playlist-thumbnail, #video-title');
            if (link) { link.click(); return true; }
            return false;
        });

        if (!hasVideo) throw new Error("Không tìm thấy video");

        // Xem video
        while (true) {
            await new Promise(r => setTimeout(r, 5000));
            const title = await page.title();
            if (title.includes("Captcha")) { blacklist[proxy] = true; throw new Error("Dính Captcha"); }

            const watchTime = 120 + Math.floor(Math.random() * 60);
            stats.threadStatus[id].title = title;
            stats.threadStatus[id].target = watchTime;
            stats.threadStatus[id].lastAction = '✅ Đang xem';

            for (let s = 1; s <= watchTime; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[id].elapsed = s;
            }
            stats.totalViews++;

            // Chuyển bài
            const next = await page.evaluate(() => {
                const btn = document.querySelector('.ytp-next-button');
                if (btn && btn.style.display !== 'none') { btn.click(); return true; }
                return false;
            });
            if (!next) break;
        }

    } catch (err) {
        addLog(`[${id}] Lỗi: ${err.message}`);
        if (err.message.includes("Protocol error")) {
            // Lỗi này thường do máy quá tải, cho luồng nghỉ 5s
            await new Promise(r => setTimeout(r, 5000));
        }
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) {}
        }
        // Xóa folder profile an toàn hơn
        setTimeout(() => {
            try { if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir); } catch (e) {}
        }, 5000); 
        
        delete stats.threadStatus[id];
        stats.activeThreads--;
    }
}

async function main() {
    while (true) {
        if (proxyList.length < 20) await fetchProxies();
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
            await new Promise(r => setTimeout(r, 3000)); // Khoảng cách giữa các luồng để tránh nghẽn CPU
        } else {
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

// UI Dashboard rút gọn
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:sans-serif; background:#1a1a1a; color:#eee; padding:20px;">
            <h2>📺 YT BOT RECOVERY MODE</h2>
            <p>Threads: ${stats.activeThreads}/${MAX_THREADS} | Views: ${stats.totalViews} | Proxy: ${proxyList.length}</p>
            <table border="1" style="width:100%; border-collapse:collapse; background:#333;">
                <tr><th>ID</th><th>Proxy</th><th>Video</th><th>Progress</th><th>Action</th></tr>
                ${Object.entries(stats.threadStatus).map(([id, t]) => `
                <tr>
                    <td>${id}</td><td>${t.proxy}</td>
                    <td>${t.title.substring(0,30)}</td>
                    <td>${t.elapsed}/${t.target}s</td>
                    <td style="color:yellow">${t.lastAction}</td>
                </tr>`).join('')}
            </table>
            <div style="background:#000; padding:10px; height:150px; overflow-y:auto; margin-top:20px; font-size:12px;">
                ${stats.logs.map(l => `<div>${l}</div>`).join('')}
            </div>
            <script>setTimeout(() => location.reload(), 2000)</script>
        </body>
    `);
});

app.listen(port, () => main());
