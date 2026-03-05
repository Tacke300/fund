const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

// --- CẤU HÌNH CHIẾN THUẬT VẮT KIỆT ---
const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 100; 
const startTime = Date.now();

let stats = {
    totalViews: 0, totalWatchSeconds: 0, activeThreads: 0,
    proxiesFailed: 0, proxyReady: 0, threadStatus: {}, logs: []
};

let blacklist = new Set();
let proxyList = [];

if (fs.existsSync(path.join(__dirname, 'temp'))) fs.removeSync(path.join(__dirname, 'temp'));

function fullLog(msg, type = 'INFO') {
    const time = new Date().toLocaleTimeString();
    stats.logs.unshift(`<div class="l-item"><span class="l-time">${time}</span> <b class="${type}">[${type}]</b> ${msg}</div>`);
    if (stats.logs.length > 25) stats.logs.pop();
}

// --- SIÊU CÔNG CỤ QUÉT PROXY (X1000 SOURCES) ---
async function fetchProxies() {
    fullLog('📡 Đang quét nguồn Proxy VIP...', 'SCRAPER');
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://api.openproxylist.xyz/http.txt',
        'https://proxyspace.pro/http.txt',
        'https://www.proxy-list.download/api/v1/get?type=http',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
        'https://raw.githubusercontent.com/officialputuid/Free-Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt'
    ];

    try {
        const responses = await Promise.allSettled(sources.map(url => axios.get(url, { timeout: 10000 })));
        let allRaw = "";
        responses.forEach(res => { if (res.status === 'fulfilled') allRaw += res.value.data; });
        const found = allRaw.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}/g);
        if (found) {
            proxyList = [...new Set(found)].filter(p => !blacklist.has(p));
            stats.proxyReady = proxyList.length;
            fullLog(`Đã nạp ${proxyList.length.toLocaleString()} Proxy vào kho.`, 'SUCCESS');
        }
    } catch (e) { fullLog('Lỗi nạp Proxy!', 'ERROR'); }
}

async function runWorker() {
    if (proxyList.length === 0) return;
    const proxy = proxyList.shift();
    const id = Math.random().toString(36).substring(7).toUpperCase();
    const userDataDir = path.join(__dirname, 'temp', `bot_${id}`);
    
    const geos = ['🇺🇸 US', '🇻🇳 VN', '🇯🇵 JP', '🇰🇷 KR', '🇩🇪 DE', '🇸🇬 SG', '🇷🇺 RU', '🇧🇷 BR'];
    const geo = geos[Math.floor(Math.random() * geos.length)];
    const ping = Math.floor(Math.random() * 200) + 30;

    stats.activeThreads++;
    stats.threadStatus[id] = { proxy, status: 'INIT', geo, ping, elapsed: 0, target: 0, videoTitle: '---' };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: userDataDir,
            args: [`--proxy-server=http://${proxy}`, '--no-sandbox', '--disable-gpu', '--mute-audio']
        });

        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(60000);

        // VÒNG LẶP VÔ TẬN: Xem playlist liên tục cho đến khi Proxy chết
        while (true) {
            stats.threadStatus[id].status = '📂 LOAD';
            await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
            
            const videoLinks = await page.evaluate(() => 
                Array.from(document.querySelectorAll('a[href*="/watch?v="]')).map(a => a.href.split('&')[0])
            );

            if (!videoLinks || videoLinks.length === 0) break; // Proxy không load được web -> Thoát vòng lặp để đổi IP

            for (let vid of videoLinks) {
                stats.threadStatus[id].status = '📺 PLAY';
                await page.goto(vid, { waitUntil: 'networkidle2' });
                
                stats.threadStatus[id].videoTitle = (await page.title()).substring(0, 15);
                const watchSeconds = Math.floor(Math.random() * 60) + 120;
                stats.threadStatus[id].target = watchSeconds;

                for (let s = 1; s <= watchSeconds; s++) {
                    await new Promise(r => setTimeout(r, 1000));
                    stats.threadStatus[id].elapsed = s;
                    stats.totalWatchSeconds++;
                }
                stats.totalViews++;
            }
            fullLog(`Bot ${id} đã cày xong 1 lượt Playlist. Tiếp tục lượt mới...`, 'STAMINA');
        }
    } catch (err) {
        blacklist.add(proxy);
        stats.proxiesFailed++;
        fullLog(`Bot ${id} đã 'tử trận' (Proxy Die) -> Đang thay quân.`, 'DEAD');
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        delete stats.threadStatus[id];
        stats.activeThreads--;
        runWorker(); // Chỉ nạp Proxy mới khi Proxy cũ đã chết hẳn
    }
}

async function main() {
    await fetchProxies();
    for(let i=0; i<MAX_THREADS; i++) { runWorker(); await new Promise(r => setTimeout(r, 300)); }
    setInterval(async () => { if (proxyList.length < 500) await fetchProxies(); }, 300000);
}

// --- GIAO DIỆN MONITOR OMNI HORIZON ---
app.get('/', (req, res) => {
    res.send(`
    <html>
    <head>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        <style>
            :root { --neon: #00ffcc; --danger: #ff3e3e; --bg: #000000; --card: #0a0a0a; --warn: #ffd700; --text: #ffffff; }
            body { background: var(--bg); color: var(--text); font-family: 'Inter', sans-serif; margin: 0; overflow: hidden; display: flex; flex-direction: column; height: 100vh; }
            header { background: #050505; border-bottom: 2px solid var(--neon); padding: 10px 30px; display: flex; align-items: center; justify-content: space-between; }
            .logo { font-weight: 900; color: var(--neon); letter-spacing: 1px; font-size: 18px; }
            .h-stats { display: flex; gap: 40px; }
            .s-box { display: flex; flex-direction: column; }
            .s-label { font-size: 9px; color: #444; text-transform: uppercase; font-weight: 800; }
            .s-val { font-size: 18px; font-family: 'Consolas', monospace; font-weight: bold; }
            .c-neon { color: var(--neon); } .c-danger { color: var(--danger); }
            main { flex: 1; display: grid; grid-template-columns: repeat(auto-fill, minmax(115px, 1fr)); gap: 6px; padding: 15px; overflow-y: auto; align-content: start; }
            .tile { background: var(--card); border: 1px solid #111; padding: 6px; border-radius: 3px; position: relative; }
            .tile.PLAY { border-color: var(--neon); box-shadow: 0 0 10px rgba(0,255,204,0.1); }
            .t-id { font-size: 8px; color: #333; }
            .t-ping { font-size: 8px; color: var(--neon); position: absolute; right: 5px; top: 5px; }
            .t-geo { font-size: 11px; margin: 4px 0; font-weight: bold; }
            .t-status { font-size: 9px; display: flex; justify-content: space-between; font-weight: 800; }
            .prog { height: 2px; background: #111; margin-top: 4px; }
            .fill { height: 100%; background: var(--danger); }
            footer { height: 120px; background: #000; border-top: 1px solid #111; padding: 10px 30px; font-family: monospace; font-size: 11px; overflow-y: auto; color: #444; }
            .SUCCESS { color: var(--neon); } .DEAD { color: var(--danger); font-weight: bold; } .STAMINA { color: #0088ff; }
        </style>
    </head>
    <body>
        <header>
            <div class="logo"><i class="fas fa-skull"></i> INFINITE DRAIN MODE</div>
            <div class="h-stats">
                <div class="s-box"><span class="s-label">Proxy Pool</span><span class="s-val c-neon">${stats.proxyReady.toLocaleString()}</span></div>
                <div class="s-box"><span class="s-label">Proxies Dead</span><span class="s-val c-danger">${blacklist.size.toLocaleString()}</span></div>
                <div class="s-box"><span class="s-label">Active Bots</span><span class="s-val">${stats.activeThreads}/${MAX_THREADS}</span></div>
                <div class="s-box"><span class="s-label">Total Views</span><span class="s-val c-neon">${stats.totalViews}</span></div>
                <div class="s-box"><span class="s-label">Watchtime</span><span class="s-val">${Math.floor(stats.totalWatchSeconds/3600)}H</span></div>
            </div>
        </header>
        <main>
            ${Object.entries(stats.threadStatus).map(([id, t]) => `
                <div class="tile ${t.status}">
                    <div class="t-id">#${id}</div>
                    <div class="t-ping">${t.ping}ms</div>
                    <div class="t-geo">${t.geo}</div>
                    <div class="t-status">
                        <span style="color:${t.status==='PLAY'?'var(--neon)':'#444'}">${t.status}</span>
                        <span>${t.elapsed}s</span>
                    </div>
                    <div class="prog"><div class="fill" style="width:${(t.elapsed/t.target)*100}%"></div></div>
                </div>
            `).join('')}
        </main>
        <footer>${stats.logs.join('')}</footer>
        <script>setTimeout(() => location.reload(), 3500)</script>
    </body>
    </html>
    `);
});

app.listen(port, () => { main(); });
