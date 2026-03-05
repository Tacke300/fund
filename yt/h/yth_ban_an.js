const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

// --- QUANTUM CONFIG ---
const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 50; // Tăng luồng vì giao diện giờ đã cực gọn
const STABLE_REQUIRED_TIME = 1800000; 

let stats = {
    totalViews: 0, totalWatchSeconds: 0, activeThreads: 0,
    proxyReady: 0, logs: [], threadStatus: {}
};

let lastFullStableTime = null; 
let proxyPool = [];
let blacklist = new Set();

if (fs.existsSync(path.join(__dirname, 'temp'))) fs.removeSync(path.join(__dirname, 'temp'));

function fullLog(msg, type = 'INFO') {
    const time = new Date().toLocaleTimeString();
    stats.logs.unshift(`<div class="l-r"><span class="l-t">${time}</span> <b class="${type}">${type}</b> ${msg}</div>`);
    if (stats.logs.length > 30) stats.logs.pop();
}

// --- X10 SOURCE VIP + GEO DATA ---
async function fetchProxies() {
    fullLog('🌀 Đang nạp dải Proxy Quantum (X10)...', 'SCRAPER');
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=all&timeout=5000&country=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/proxy.txt',
        'https://proxyspace.pro/http.txt',
        'https://api.openproxylist.xyz/http.txt'
    ];

    try {
        let combined = "";
        const res = await Promise.allSettled(sources.map(s => axios.get(s, { timeout: 10000 })));
        res.forEach(r => { if(r.status === 'fulfilled') combined += r.value.data; });
        
        const found = combined.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}/g);
        if (found) {
            proxyPool = [...new Set(found)].filter(p => !blacklist.has(p));
            stats.proxyReady = proxyPool.length;
            fullLog(`🎯 Đã sẵn sàng ${proxyPool.length.toLocaleString()} IP VIP.`, 'SUCCESS');
        }
    } catch (e) { fullLog('Lỗi nạp Proxy!', 'ERROR'); }
}

async function runWorker() {
    if (proxyPool.length === 0) return;
    const proxy = proxyPool.shift();
    const id = Math.random().toString(36).substring(7).toUpperCase();
    
    // Giả lập lấy quốc gia và ping (để tránh làm chậm bot bằng API thật)
    const countries = ['🇺🇸 USA', '🇻🇳 VNM', '🇯🇵 JPN', '🇰🇷 KOR', '🇩🇪 DEU', '🇸🇬 SGP', '🇷🇺 RUS', '🇫🇷 FRA'];
    const geo = countries[Math.floor(Math.random() * countries.length)];
    const ping = Math.floor(Math.random() * 450) + 50;

    stats.activeThreads++;
    stats.threadStatus[id] = { proxy, status: 'INIT', geo, ping, elapsed: 0, target: 0, title: '' };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: [`--proxy-server=http://${proxy}`, '--no-sandbox', '--disable-gpu']
        });
        const page = await browser.newPage();
        // Thiết lập timeout ngắn để tự thoát nếu proxy đơ
        await page.setDefaultNavigationTimeout(45000); 

        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
        const vids = await page.evaluate(() => Array.from(document.querySelectorAll('a[href*="/watch?v="]')).map(a => a.href.split('&')[0]));

        for (let vid of vids.slice(0, 5)) {
            stats.threadStatus[id].status = 'LOAD';
            await page.goto(vid, { waitUntil: 'networkidle2' });
            stats.threadStatus[id].title = (await page.title()).substring(0, 15);
            stats.threadStatus[id].status = 'PLAY';
            
            const watchTime = Math.floor(Math.random() * 30) + 180;
            stats.threadStatus[id].target = watchTime;
            for (let s = 1; s <= watchTime; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[id].elapsed = s;
                stats.totalWatchSeconds++;
            }
            stats.totalViews++;
        }
    } catch (err) {
        blacklist.add(proxy);
        fullLog(`Bot ${id} lỗi (Proxy Die) -> Đã đổi IP`, 'RETRY');
    } finally {
        if (browser) await browser.close();
        delete stats.threadStatus[id];
        stats.activeThreads--;
        runWorker(); // Tự động đổi Proxy và chạy tiếp ngay lập tức
    }
}

async function main() {
    await fetchProxies();
    for(let i=0; i<MAX_THREADS; i++) { runWorker(); await new Promise(r => setTimeout(r, 500)); }
    setInterval(fetchProxies, 600000);
}

// --- UI NANO-HORIZON ---
app.get('/', (req, res) => {
    res.send(`
    <html>
    <head>
        <style>
            :root { --bg: #030303; --card: #0a0a0a; --green: #00ff66; --red: #ff3333; }
            body { background: var(--bg); color: #fff; font-family: 'Segoe UI', sans-serif; margin: 0; display: flex; flex-direction: column; height: 100vh; }
            
            /* Top Info Bar */
            header { display: flex; padding: 10px 20px; background: #000; border-bottom: 1px solid #111; gap: 30px; align-items: center; }
            .stat-g { display: flex; flex-direction: column; }
            .label { font-size: 10px; color: #444; text-transform: uppercase; font-weight: bold; }
            .val { font-size: 16px; color: var(--green); font-family: monospace; }

            /* Nano Grid */
            main { flex: 1; display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; padding: 15px; overflow-y: auto; align-content: start; }
            .tile { background: var(--card); border: 1px solid #151515; padding: 8px; border-radius: 4px; position: relative; }
            .tile.PLAY { border-color: #1a3a1a; background: #050a05; }
            .tile-id { font-size: 9px; font-weight: 900; color: #333; }
            .tile-geo { font-size: 10px; color: #aaa; margin: 4px 0; }
            .tile-ping { font-size: 9px; color: var(--green); position: absolute; right: 8px; top: 8px; }
            .tile-status { font-size: 10px; font-weight: bold; display: flex; justify-content: space-between; margin-top: 5px; }
            .progress { height: 2px; background: #111; width: 100%; margin-top: 5px; }
            .bar { height: 100%; background: var(--red); transition: 1s linear; }

            /* Terminal Log */
            footer { height: 120px; background: #000; border-top: 1px solid #111; padding: 10px 20px; font-size: 11px; font-family: monospace; overflow-y: auto; color: #444; }
            .SUCCESS { color: var(--green); } .ERROR { color: var(--red); } .RETRY { color: #ffaa00; }
        </style>
    </head>
    <body>
        <header>
            <div class="stat-g"><span class="label">Quantum Mesh</span><span class="val">${stats.proxyReady.toLocaleString()} IPs</span></div>
            <div class="stat-g"><span class="label">Active Threads</span><span class="val">${stats.activeThreads}/${MAX_THREADS}</span></div>
            <div class="stat-g"><span class="label">Global Views</span><span class="val">${stats.totalViews}</span></div>
            <div class="stat-g"><span class="label">Total Watchtime</span><span class="val">${Math.floor(stats.totalWatchSeconds/3600)}H</span></div>
        </header>
        <main>
            ${Object.entries(stats.threadStatus).map(([id, t]) => `
                <div class="tile ${t.status}">
                    <div class="tile-id">#${id}</div>
                    <div class="tile-ping">${t.ping}ms</div>
                    <div class="tile-geo">${t.geo}</div>
                    <div class="tile-status">
                        <span style="color: ${t.status === 'PLAY' ? 'var(--green)' : '#444'}">${t.status}</span>
                        <span>${t.elapsed}s</span>
                    </div>
                    <div class="progress"><div class="bar" style="width: ${(t.elapsed/t.target)*100}%"></div></div>
                </div>
            `).join('')}
        </main>
        <footer>${stats.logs.join('')}</footer>
        <script>setTimeout(() => location.reload(), 3000)</script>
    </body>
    </html>
    `);
});

app.listen(port, () => { main(); });
