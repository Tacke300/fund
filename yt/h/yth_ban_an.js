const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

// --- CẤU HÌNH SIÊU CẤP ---
const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 15;
const ROTATION_TIME = 1800000; // 30 phút (tự đổi proxy nếu luồng quá cũ)
const startTime = Date.now();

let stats = {
    totalViews: 0, totalWatchSeconds: 0, activeThreads: 0,
    proxiesFailed: 0, proxyReady: 0, threadStatus: {}, logs: []
};

let blacklist = new Set();
let proxyList = [];

// Xóa rác profile cũ
if (fs.existsSync(path.join(__dirname, 'temp'))) fs.removeSync(path.join(__dirname, 'temp'));

function fullLog(msg, type = 'INFO') {
    const time = new Date().toLocaleTimeString();
    const logMsg = `<span class="log-time">[${time}]</span> <span class="log-type-${type}">[${type}]</span> ${msg}`;
    stats.logs.unshift(logMsg);
    if (stats.logs.length > 150) stats.logs.pop();
    console.log(`[${time}] [${type}] ${msg}`);
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
}

// --- 1. SIÊU CÔNG CỤ QUÉT 100K PROXY ---
async function fetchProxies() {
    fullLog('Kích hoạt quét 100+ nguồn Proxy...', 'SCRAPER');
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://api.openproxylist.xyz/http.txt',
        'https://proxyspace.pro/http.txt',
        'https://spys.me/proxy.txt',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
        'https://raw.githubusercontent.com/Zaeem20/free-proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/officialputuid/Free-Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt'
    ];
    let allData = "";
    const res = await Promise.allSettled(sources.map(u => axios.get(u, { timeout: 10000 })));
    res.forEach(r => { if (r.status === 'fulfilled') allData += r.value.data; });
    
    const found = allData.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}/g);
    if (found) {
        proxyList = [...new Set(found)].filter(p => !blacklist.has(p));
        stats.proxyReady = proxyList.length;
        fullLog(`Hệ thống đã nạp ${proxyList.length} Proxy vào kho đạn!`, 'SYSTEM');
    }
}

// --- 2. WORKER LỲ ĐÒN ---
async function runWorker(proxy) {
    stats.activeThreads++;
    const id = Math.random().toString(36).substring(7).toUpperCase();
    const userDataDir = path.join(__dirname, 'temp', `profile_${id}`);
    const birth = Date.now();
    
    stats.threadStatus[id] = { proxy, title: 'Initializing...', iteration: 1, elapsed: 0, target: 0, status: 'STARTING', birth };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir,
            args: [`--proxy-server=http://${proxy}`, '--no-sandbox', '--disable-gpu', '--mute-audio']
        });

        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(120000);

        fullLog(`[${id}] Đang nạp Playlist...`, 'NETWORK');
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
        const vids = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
            return [...new Set(links.map(a => a.href.split('&')[0]))];
        });

        if (!vids.length) throw new Error("Proxy lag/Playlist lỗi");

        while (true) {
            // Tự đổi luồng nếu quá già (Rotation)
            if (Date.now() - birth > ROTATION_TIME && stats.activeThreads >= MAX_THREADS) {
                fullLog(`[${id}] Luồng đã cũ (30p), đổi Proxy mới...`, 'ROTATION');
                break;
            }

            for (let i = 0; i < vids.length; i++) {
                let success = false, retry = 0;
                while (!success && retry < 5) {
                    try {
                        stats.threadStatus[id].iteration = i + 1;
                        stats.threadStatus[id].status = `LOADING VID ${i+1}`;
                        await page.goto(vids[i], { waitUntil: 'networkidle2', timeout: 90000 });
                        await page.waitForSelector('.video-stream', { timeout: 30000 });
                        
                        stats.threadStatus[id].title = (await page.title()).replace('- YouTube', '');
                        stats.threadStatus[id].status = 'WATCHING';
                        
                        const time = Math.floor(Math.random() * 61) + 150; // Xem 2.5 - 3.5 phút
                        stats.threadStatus[id].target = time;

                        for (let s = 1; s <= time; s++) {
                            await new Promise(r => setTimeout(r, 1000));
                            stats.threadStatus[id].elapsed = s;
                            stats.totalWatchSeconds++;
                        }
                        stats.totalViews++;
                        success = true;

                        // Nghỉ giữa các video (15-25s)
                        const rest = Math.floor(Math.random() * 11) + 15;
                        stats.threadStatus[id].status = `SLEEPING ${rest}s`;
                        await new Promise(r => setTimeout(r, rest * 1000));

                    } catch (e) {
                        retry++;
                        stats.threadStatus[id].status = `RETRYING ${retry}/5`;
                        await new Promise(r => setTimeout(r, 15000));
                    }
                }
                if (!success) break;
            }
            fullLog(`[${id}] Replay Playlist...`, 'LOOP');
        }
    } catch (err) {
        blacklist.add(proxy);
        stats.proxiesFailed++;
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        delete stats.threadStatus[id];
        stats.activeThreads--;
    }
}

// --- 3. QUẢN LÝ ---
async function main() {
    await fetchProxies();
    setInterval(() => { if (proxyList.length < 200) fetchProxies(); }, 180000);

    while (true) {
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
            await new Promise(r => setTimeout(r, 6000)); 
        } else {
            await new Promise(r => setTimeout(r, 10000));
        }
    }
}

// --- 4. GIAO DIỆN GALAXY TERMINAL ---
app.get('/', (req, res) => {
    res.send(`
    <html>
    <head>
        <title>GALAXY YT BOT PRO</title>
        <style>
            body { background: #050505; color: #00ff41; font-family: 'Courier New', monospace; margin: 0; padding: 20px; overflow-x: hidden; }
            .header { border: 1px solid #00ff41; padding: 20px; box-shadow: 0 0 15px #00ff41; margin-bottom: 20px; background: rgba(0, 50, 0, 0.2); }
            .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 15px; }
            .card { border: 1px solid #333; padding: 15px; background: #0a0a0a; position: relative; overflow: hidden; }
            .card.active { border-color: #00ff41; box-shadow: inset 0 0 10px rgba(0, 255, 65, 0.1); }
            .progress-bg { background: #111; height: 4px; margin: 10px 0; border-radius: 2px; }
            .progress-bar { background: #00ff41; height: 100%; width: 0%; transition: 0.3s; box-shadow: 0 0 10px #00ff41; }
            .log-box { background: #000; border: 1px solid #333; height: 350px; overflow-y: auto; padding: 15px; margin-top: 20px; font-size: 12px; line-height: 1.5; }
            .stat-val { color: #fff; font-weight: bold; text-shadow: 0 0 5px #fff; }
            .log-time { color: #888; }
            .log-type-SCRAPER { color: #ff00ff; }
            .log-type-ACTION { color: #00ffff; }
            .log-type-SUCCESS { color: #00ff41; }
            .log-type-FAILED { color: #ff4757; }
            .log-type-ROTATION { color: #eccc68; }
            h2 { margin: 0; text-transform: uppercase; letter-spacing: 5px; }
            .blink { animation: blink 1s infinite; }
            @keyframes blink { 0% { opacity: 1; } 50% { opacity: 0; } 100% { opacity: 1; } }
        </style>
    </head>
    <body>
        <div class="header">
            <h2>Galaxy YT Bot <span class="blink">_</span></h2>
            <p>Uptime: <span class="stat-val">${Math.floor((Date.now()-startTime)/60000)}m</span> | 
               Views: <span class="stat-val">${stats.totalViews}</span> | 
               Total Watchtime: <span class="stat-val">${formatTime(stats.totalWatchSeconds)}</span> | 
               Threads: <span class="stat-val">${stats.activeThreads}/${MAX_THREADS}</span> | 
               Proxy Pool: <span class="stat-val">${proxyList.length}</span></p>
        </div>

        <div class="grid">
            ${Object.entries(stats.threadStatus).map(([id, t]) => `
                <div class="card active">
                    <div style="display:flex; justify-content:space-between; font-size:11px; color:#888;">
                        <span>ID: ${id}</span> <span>${t.proxy.split(':')[0]}</span>
                    </div>
                    <div style="margin: 10px 0; color: #fff; height: 35px; overflow: hidden; font-size: 13px;">
                        ${t.iteration}. ${t.title}
                    </div>
                    <div class="progress-bg"><div class="progress-bar" style="width: ${(t.elapsed/t.target)*100}%"></div></div>
                    <div style="display:flex; justify-content:space-between; font-size:11px;">
                        <span style="color:#00ff41">${t.status}</span>
                        <span>${t.elapsed}/${t.target}s</span>
                    </div>
                </div>
            `).join('')}
        </div>

        <div class="log-box" id="logs">
            ${stats.logs.map(l => `<div>${l}</div>`).join('')}
        </div>

        <script>
            setTimeout(() => location.reload(), 5000);
            const objDiv = document.getElementById("logs");
            objDiv.scrollTop = objDiv.scrollHeight;
        </script>
    </body>
    </html>
    `);
});

app.listen(port, () => { main(); });
