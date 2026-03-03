const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const { v4: uuidv4 } = require('uuid');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

// --- CẤU HÌNH ---
const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 10;
const BLACKLIST_FILE = './blacklist_proxy.json';
const TEMP_DIR = path.join(__dirname, 'temp');
const TIMEOUT_VAL = 90000; // 1.5 phút cho phép lag

// Khởi tạo hệ thống
if (fs.existsSync(TEMP_DIR)) fs.removeSync(TEMP_DIR);
fs.ensureDirSync(TEMP_DIR);

let stats = {
    totalViews: 0, totalSeconds: 0, activeThreads: 0,
    proxiesFailed: 0, proxiesSuccess: 0,
    proxyReady: 0, threadStatus: {}, logs: []
};

let blacklist = fs.existsSync(BLACKLIST_FILE) ? fs.readJsonSync(BLACKLIST_FILE) : {};
let proxyList = [];

// Lưu Blacklist định kỳ
function saveBlacklist() {
    fs.writeJsonSync(BLACKLIST_FILE, blacklist);
}

function fullLog(id, msg, type = 'INFO') {
    const time = new Date().toLocaleString();
    console.log(`[${time}] [${id}] [${type}] ${msg}`);
}

function dashLog(msg) {
    const time = new Date().toLocaleTimeString();
    stats.logs.unshift(`[${time}] ${msg}`);
    if (stats.logs.length > 50) stats.logs.pop();
}

// Kiểm tra Proxy cực nhẹ bằng Axios trước khi mở Browser
async function isProxyGood(proxy) {
    const [host, port] = proxy.split(':');
    try {
        await axios.get('https://m.youtube.com', {
            proxy: { host, port: parseInt(port) },
            timeout: 15000 // Proxy phải phản hồi trong 15s mới đạt chuẩn
        });
        return true;
    } catch (e) {
        return false;
    }
}

async function fetchProxies() {
    fullLog('SYSTEM', 'Đang quét nguồn proxy mới...', 'SCRAPER');
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt'
    ];
    let all = [];
    for (let s of sources) {
        try {
            const res = await axios.get(s, { timeout: 8000 });
            const lines = res.data.split('\n').map(p => p.trim()).filter(p => p.includes(':'));
            all = all.concat(lines);
        } catch (e) { fullLog('SYSTEM', `Lỗi nguồn ${s}`, 'ERROR'); }
    }
    proxyList = [...new Set(all)].filter(p => !blacklist[p]);
    stats.proxyReady = proxyList.length;
}

async function runWorker(proxy) {
    // 1. Kiểm tra proxy trước (Không tốn RAM)
    const alive = await isProxyGood(proxy);
    if (!alive) {
        blacklist[proxy] = true;
        saveBlacklist();
        stats.proxiesFailed++;
        fullLog('CHECK', `Bỏ qua proxy chết/chậm: ${proxy}`, 'SKIP');
        return;
    }

    // 2. Nếu sống mới bắt đầu chạy Browser
    stats.activeThreads++;
    const id = uuidv4().split('-')[0].toUpperCase();
    const userDataDir = path.join(TEMP_DIR, `profile_${id}`);
    stats.threadStatus[id] = { proxy, title: 'Đang mở trình duyệt...', elapsed: 0, target: 0, iteration: 0, status: '🌐' };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: userDataDir,
            args: [
                `--proxy-server=http://${proxy}`,
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--mute-audio',
                '--no-zygote'
            ]
        });

        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(TIMEOUT_VAL); // 1.5 phút như yêu cầu

        // Chặn ảnh/css để tiết kiệm băng thông proxy
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'stylesheet'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        fullLog(id, `Đang tải Playlist (Chờ tối đa 90s)...`, 'NETWORK');
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
        
        const videoLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
            return [...new Set(links.map(a => a.href.split('&')[0]))]; 
        });

        if (!videoLinks || videoLinks.length === 0) throw new Error("Không lấy được danh sách video");

        for (let i = 0; i < videoLinks.length; i++) {
            const videoUrl = videoLinks[i];
            stats.threadStatus[id].iteration = i + 1;
            stats.threadStatus[id].status = '📺 Xem video';
            
            fullLog(id, `Mở video ${i+1}: ${videoUrl}`);
            await page.goto(videoUrl, { waitUntil: 'networkidle2' });

            // Đảm bảo video chạy
            await page.evaluate(() => {
                const v = document.querySelector('video');
                if (v) { v.muted = true; v.play(); }
            });

            const watchTime = Math.floor(Math.random() * 61) + 180; 
            stats.threadStatus[id].target = watchTime;
            
            for (let s = 1; s <= watchTime; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[id].elapsed = s;
                stats.totalSeconds++;
                if (s % 30 === 0) stats.threadStatus[id].title = (await page.title()).substring(0, 35);
            }

            stats.totalViews++;
            stats.proxiesSuccess++;
            fullLog(id, `Thành công video ${i+1}/${videoLinks.length}`, 'SUCCESS');
        }

    } catch (err) {
        fullLog(id, `Lỗi: ${err.message}`, 'ERROR');
        stats.proxiesFailed++;
        // Nếu lỗi do mạng/proxy thì blacklist luôn
        if (err.message.includes('net::') || err.message.includes('timeout')) {
            blacklist[proxy] = true;
            saveBlacklist();
        }
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) {}
        }
        // Delay 3s tránh lỗi EPERM trên Windows khi xóa folder
        await new Promise(r => setTimeout(r, 3000));
        try {
            if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        } catch (e) {
            fullLog(id, `EPERM: Folder đang bận, sẽ xóa sau`, 'WARN');
        }
        delete stats.threadStatus[id];
        stats.activeThreads--;
    }
}

async function main() {
    fullLog('SYSTEM', 'Khởi động Bot...', 'START');
    while (true) {
        if (proxyList.length < 5) await fetchProxies();
        
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
            await new Promise(r => setTimeout(r, 4000)); // Giãn cách mở browser tránh sập CPU
        } else {
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

// Giao diện Dashboard
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:sans-serif; background:#121212; color:#eee; padding:20px;">
            <h2 style="color:#ff4757">🔴 YOUTUBE BOT DASHBOARD - ${stats.activeThreads}/${MAX_THREADS} Luồng</h2>
            <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px; margin-bottom:20px;">
                <div style="background:#222; padding:15px; border-radius:5px; border-left:5px solid #2ed573">Views: <b>${stats.totalViews}</b></div>
                <div style="background:#222; padding:15px; border-radius:5px; border-left:5px solid #ffa502">Proxy Chờ: <b>${proxyList.length}</b></div>
                <div style="background:#222; padding:15px; border-radius:5px; border-left:5px solid #ff4757">Proxy Lỗi: <b>${stats.proxiesFailed}</b></div>
                <div style="background:#222; padding:15px; border-radius:5px; border-left:5px solid #70a1ff">Blacklist: <b>${Object.keys(blacklist).length}</b></div>
            </div>
            <table style="width:100%; text-align:left; background:#1e1e1e; border-radius:5px; overflow:hidden;">
                <tr style="background:#333; color:#fff;">
                    <th style="padding:12px;">ID</th>
                    <th>Proxy</th>
                    <th>Video / Tiến độ</th>
                    <th>Status</th>
                </tr>
                ${Object.entries(stats.threadStatus).map(([id, t]) => `
                <tr style="border-bottom:1px solid #222;">
                    <td style="padding:12px;">${id}</td>
                    <td style="font-size:11px; color:#aaa;">${t.proxy}</td>
                    <td><small>#${t.iteration}</small> ${t.title || 'Loading...'} (${t.elapsed}/${t.target}s)</td>
                    <td>${t.status}</td>
                </tr>`).join('')}
            </table>
            <div style="margin-top:20px; background:#000; color:#2ed573; padding:15px; height:200px; overflow-y:auto; font-family:monospace; font-size:12px; border-radius:5px;">
                ${stats.logs.map(l => `<div>${l}</div>`).join('')}
            </div>
            <script>setTimeout(() => location.reload(), 4000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`DASHBOARD: http://localhost:${port}`);
    main();
});
