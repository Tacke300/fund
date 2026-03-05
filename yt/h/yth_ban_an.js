const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

// --- SUPERNOVA CONFIG ---
const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 100; // Tăng lên 100 luồng để chiếm trọn màn hình
const STABLE_REQUIRED_TIME = 1800000; 

let stats = {
    totalViews: 0, totalWatchSeconds: 0, activeThreads: 0,
    proxyReady: 0, blacklistCount: 0, logs: [], threadStatus: {}
};

let lastFullStableTime = null; 
let proxyPool = [];
let blacklist = new Set();

if (fs.existsSync(path.join(__dirname, 'temp'))) fs.removeSync(path.join(__dirname, 'temp'));

function fullLog(msg, type = 'INFO') {
    const time = new Date().toLocaleTimeString();
    stats.logs.unshift(`<div class="l-r"><span class="l-t">${time}</span> <b class="${type}">[${type}]</b> ${msg}</div>`);
    if (stats.logs.length > 20) stats.logs.pop();
}

// --- X100 SOURCE INJECTOR ---
async function fetchProxies() {
    fullLog('🚀 Kích hoạt càn quét X100 Proxy Pool...', 'SYSTEM');
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=all&timeout=10000&country=all',
        'https://proxyspace.pro/http.txt', 'https://proxyspace.pro/https.txt',
        'https://proxyspace.pro/socks4.txt', 'https://proxyspace.pro/socks5.txt',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/proxy.txt',
        'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies.txt',
        'https://api.openproxylist.xyz/http.txt',
        'https://www.proxy-list.download/api/v1/get?type=http'
    ];

    try {
        let raw = "";
        const res = await Promise.allSettled(sources.map(s => axios.get(s, { timeout: 15000 })));
        res.forEach(r => { if(r.status === 'fulfilled') raw += r.value.data; });
        
        const found = raw.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}/g);
        if (found) {
            const unique = [...new Set(found)].filter(p => !blacklist.has(p));
            proxyPool = unique;
            stats.proxyReady = proxyPool.length;
            fullLog(`💎 Đã nạp ${proxyPool.length.toLocaleString()} Proxy tinh khiết.`, 'SUCCESS');
        }
    } catch (e) { fullLog('Lỗi truy xuất nguồn Proxy!', 'ERROR'); }
}

async function runWorker() {
    if (proxyPool.length === 0) return;
    const proxy = proxyPool.shift();
    const id = Math.random().toString(36).substring(7).toUpperCase();
    
    const geos = ['🇺🇸 US', '🇻🇳 VN', '🇯🇵 JP', '🇰🇷 KR', '🇩🇪 DE', '🇸🇬 SG', '🇷🇺 RU', '🇨🇦 CA', '🇧🇷 BR', '🇦🇺 AU'];
    const geo = geos[Math.floor(Math.random() * geos.length)];
    const ping = Math.floor(Math.random() * 300) + 20;

    stats.activeThreads++;
    stats.threadStatus[id] = { proxy, status: 'INIT', geo, ping, elapsed: 0, target: 0 };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: [`--proxy-server=http://${proxy}`, '--no-sandbox', '--disable-gpu', '--mute-audio']
        });
        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(40000); 

        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
        const vids = await page.evaluate(() => Array.from(document.querySelectorAll('a[href*="/watch?v="]')).map(a => a.href.split('&')[0]));

        for (let vid of vids.slice(0, 3)) {
            stats.threadStatus[id].status = 'LOAD';
            await page.goto(vid, { waitUntil: 'networkidle2' });
            stats.threadStatus[id].status = 'PLAY';
            
            const watchTime = Math.floor(Math.random() * 60) + 180;
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
        stats.blacklistCount = blacklist.size;
        fullLog(`Bot ${id} chết Proxy -> Blacklist +1`, 'KILL');
    } finally {
        if (browser) await browser.close();
        delete stats.threadStatus[id];
        stats.activeThreads--;
        runWorker(); 
    }
}

async function main() {
    await fetchProxies();
    for(let i=0; i<MAX_THREADS; i++) { runWorker(); await new Promise(r => setTimeout(r, 300)); }
    setInterval(fetchProxies, 600000);
}

// --- UI SUPERNOVA (HIGH CONTRAST) ---
app.get('/', (req, res) => {
    res.send(`
    <html>
    <head>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        <style>
            :root { --bg: #000000; --card: #111111; --neon: #00ff00; --warn: #ffff00; --danger: #ff0000; --text: #ffffff; }
            body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', sans-serif; margin: 0; display: flex; flex-direction: column; height: 100vh; font-weight: bold; }
            
            /* Top Navigation Bar */
            header { display: flex; padding: 15px 30px; background: #080808; border-bottom: 2px solid var(--neon); gap: 50px; align-items: center; justify-content: flex-start; }
            .brand { color: var(--neon); font-size: 20px; text-transform: uppercase; letter-spacing: 2px; }
            .stat-g { display: flex; flex-direction: column; min-width: 120px; }
            .label { font-size: 10px; color: #666; text-transform: uppercase; margin-bottom: 4px; }
            .val { font-size: 20px; font-family: 'Consolas', monospace; color: var(--text); }
            .v-blue { color: #00ccff; } .v-neon { color: var(--neon); } .v-danger { color: var(--danger); }

            /* Bot Nano Tiles */
            main { flex: 1; display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 6px; padding: 10px; overflow-y: auto; align-content: start; }
            .tile { background: var(--card); border: 1px solid #222; padding: 6px; border-radius: 2px; position: relative; }
            .tile.PLAY { border-color: var(--neon); box-shadow: 0 0 5px rgba(0,255,0,0.2); }
            .tile.LOAD { border-color: var(--warn); }
            .t-id { font-size: 9px; color: #444; }
            .t-ping { font-size: 9px; color: var(--neon); position: absolute; right: 5px; top: 5px; }
            .t-geo { font-size: 11px; margin: 4px 0; color: #fff; }
            .t-status { font-size: 10px; display: flex; justify-content: space-between; }
            .bar-bg { height: 3px; background: #222; width: 100%; margin-top: 5px; }
            .bar-fill { height: 100%; background: var(--danger); transition: 1s linear; }

            /* Detailed Console */
            footer { height: 140px; background: #050505; border-top: 2px solid #222; padding: 10px 30px; font-size: 12px; font-family: 'Consolas', monospace; overflow-y: auto; color: #888; }
            .SUCCESS { color: var(--neon); } .KILL { color: var(--danger); font-weight: 900; } .SYSTEM { color: #00ccff; }
        </style>
    </head>
    <body>
        <header>
            <div class="brand"><i class="fas fa-atom"></i> SUPERNOVA</div>
            <div class="stat-g"><span class="label">Proxy Pool</span><span class="val v-neon">${stats.proxyReady.toLocaleString()}</span></div>
            <div class="stat-g"><span class="label">Blacklisted</span><span class="val v-danger">${stats.blacklistCount.toLocaleString()}</span></div>
            <div class="stat-g"><span class="label">Threads</span><span class="val v-blue">${stats.activeThreads}/${MAX_THREADS}</span></div>
            <div class="stat-g"><span class="label">Total Views</span><span class="val">${stats.totalViews}</span></div>
            <div class="stat-g"><span class="label">Watchtime</span><span class="val">${Math.floor(stats.totalWatchSeconds/3600)}H</span></div>
        </header>
        <main>
            ${Object.entries(stats.threadStatus).map(([id, t]) => `
                <div class="tile ${t.status}">
                    <div class="t-id">#${id}</div>
                    <div class="t-ping">${t.ping}ms</div>
                    <div class="t-geo">${t.geo}</div>
                    <div class="t-status">
                        <span style="color: ${t.status === 'PLAY' ? 'var(--neon)' : t.status === 'LOAD' ? 'var(--warn)' : '#555'}">${t.status}</span>
                        <span>${t.elapsed}s</span>
                    </div>
                    <div class="bar-bg"><div class="bar-fill" style="width: ${(t.elapsed/t.target)*100}%"></div></div>
                </div>
            `).join('')}
        </main>
        <footer>
            <div style="margin-bottom:5px; color:#333; border-bottom:1px solid #111;">[ REAL-TIME_BOT_STREAM ]</div>
            ${stats.logs.join('')}
        </footer>
        <script>setTimeout(() => location.reload(), 3000)</script>
    </body>
    </html>
    `);
});

app.listen(port, () => { main(); });
