const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

// --- OMNI CONFIG ---
const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 15;
const STABLE_REQUIRED_TIME = 1800000; 
let stats = {
    totalViews: 0, totalWatchSeconds: 0, activeThreads: 0,
    proxiesFailed: 0, proxyReady: 0, blacklistSize: 0,
    threadStatus: {}, logs: [], blacklistSample: []
};

let lastFullStableTime = null; 
let blacklist = new Set();
let proxyList = [];

if (fs.existsSync(path.join(__dirname, 'temp'))) fs.removeSync(path.join(__dirname, 'temp'));

function fullLog(msg, type = 'INFO') {
    const time = new Date().toLocaleTimeString();
    const logMsg = `<div class="l-r"><span class="l-t">${time}</span> <span class="l-ty" data-type="${type}">${type}</span> ${msg}</div>`;
    stats.logs.unshift(logMsg);
    if (stats.logs.length > 100) stats.logs.pop();
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m ${seconds % 60}s`;
}

// --- OMNI-SCRAPER: VÉT CẠN PROXY TOÀN CẦU ---
async function fetchProxies() {
    fullLog('🌌 Đang mở cổng kết nối OMNIVERSE: Thu thập IP toàn cầu...', 'SYSTEM');
    const baseSources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=all&timeout=10000&country=all&ssl=all&anonymity=all',
        'https://proxyspace.pro/http.txt', 'https://proxyspace.pro/https.txt', 'https://proxyspace.pro/socks4.txt', 'https://proxyspace.pro/socks5.txt',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks4.txt',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
        'https://raw.githubusercontent.com/Zaeem20/free-proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/officialputuid/Free-Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt',
        'https://raw.githubusercontent.com/Anonym0usWork12/Free-Proxy-List/master/proxy.txt',
        'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
        'https://raw.githubusercontent.com/RX404/Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies.txt',
        'https://raw.githubusercontent.com/Vann-Dev/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/TuanMinhPL/Proxy-List/master/proxies.txt'
    ];

    let combined = "";
    try {
        const responses = await Promise.allSettled(baseSources.map(url => axios.get(url, { timeout: 35000 })));
        responses.forEach(r => { if(r.status === 'fulfilled') combined += r.value.data; });

        const found = combined.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}/g);
        if (found) {
            proxyList = [...new Set(found)].filter(p => !blacklist.has(p));
            stats.proxyReady = proxyList.length;
            fullLog(`✅ Kho IP Toàn Cầu đã nạp: ${proxyList.length.toLocaleString()} IPs`, 'SUCCESS');
        }
    } catch (e) { fullLog('Lỗi truy xuất Omniverse', 'FAILED'); }
}

function checkStability() {
    const playingCount = Object.values(stats.threadStatus).filter(t => t.status === 'PLAYING').length;
    if (playingCount >= MAX_THREADS) {
        if (!lastFullStableTime) {
            lastFullStableTime = Date.now();
            fullLog('🔥 FULL LUỒNG: BẮT ĐẦU CHU KỲ ỔN ĐỊNH 30P', 'STABLE');
        }
    } else {
        if (lastFullStableTime) {
            lastFullStableTime = null;
            fullLog('❄️ MẤT ỔN ĐỊNH: RESET ĐỒNG HỒ', 'FAILED');
        }
    }
}

async function runWorker(proxy) {
    stats.activeThreads++;
    const id = Math.random().toString(36).substring(7).toUpperCase();
    const userDataDir = path.join(__dirname, 'temp', `p_${id}`);
    const birth = Date.now();
    stats.threadStatus[id] = { proxy, title: 'Connecting...', elapsed: 0, target: 0, status: 'INIT', birth };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new", userDataDir,
            args: [`--proxy-server=http://${proxy}`, '--no-sandbox', '--disable-gpu', '--mute-audio']
        });
        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(90000);
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
        
        const vids = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href*="/watch?v="]')).map(a => a.href.split('&')[0]).filter((v, i, a) => a.indexOf(v) === i);
        });

        while (true) {
            if (lastFullStableTime && (Date.now() - lastFullStableTime > STABLE_REQUIRED_TIME)) {
                if (birth < lastFullStableTime) break;
            }
            for (let vid of vids) {
                stats.threadStatus[id].status = `LOADING`;
                checkStability();
                await page.goto(vid, { waitUntil: 'networkidle2', timeout: 60000 });
                await page.waitForSelector('.video-stream', { timeout: 20000 });
                stats.threadStatus[id].title = (await page.title()).replace('- YouTube', '');
                stats.threadStatus[id].status = 'PLAYING';
                checkStability();
                
                const watchTime = Math.floor(Math.random() * 50) + 180;
                stats.threadStatus[id].target = watchTime;
                for (let s = 1; s <= watchTime; s++) {
                    await new Promise(r => setTimeout(r, 1000));
                    stats.threadStatus[id].elapsed = s;
                    stats.totalWatchSeconds++;
                }
                stats.totalViews++;
            }
        }
    } catch (err) {
        blacklist.add(proxy);
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        delete stats.threadStatus[id];
        stats.activeThreads--;
        checkStability();
    }
}

async function main() {
    await fetchProxies();
    setInterval(fetchProxies, 600000);
    while (true) {
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
            await new Promise(r => setTimeout(r, 4000)); 
        }
        await new Promise(r => setTimeout(r, 2000));
    }
}

// --- GIAO DIỆN THE ARCHITECT ---
app.get('/', (req, res) => {
    const stableSec = lastFullStableTime ? Math.floor((Date.now() - lastFullStableTime)/1000) : 0;
    const progress = Math.min((stableSec / 1800) * 100, 100);
    res.send(`
    <html>
    <head>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        <style>
            :root { --main: #ff4d4d; --bg: #0a0a0a; --card: #141414; }
            body { background: var(--bg); color: #e0e0e0; font-family: 'Inter', sans-serif; margin: 0; display: flex; height: 100vh; overflow: hidden; }
            
            .sidebar { width: 360px; background: #000; border-right: 1px solid #222; padding: 40px 20px; display: flex; flex-direction: column; }
            .logo { font-size: 24px; font-weight: 900; letter-spacing: -1px; margin-bottom: 50px; display: flex; align-items: center; gap: 10px; }
            .logo i { color: var(--main); }

            .stat-group { margin-bottom: 30px; }
            .stat-label { font-size: 10px; color: #444; text-transform: uppercase; font-weight: 800; margin-bottom: 10px; display: block; }
            .stat-value { font-size: 32px; font-weight: 200; font-family: 'Inter', sans-serif; }

            .main { flex: 1; display: flex; flex-direction: column; padding: 40px; }
            .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 20px; flex: 1; overflow-y: auto; }
            
            .card { background: var(--card); padding: 20px; border-radius: 4px; border: 1px solid #222; transition: 0.3s; }
            .card.playing { border-color: var(--main); box-shadow: 0 0 20px rgba(255,77,77,0.1); }
            .card .node-id { font-size: 10px; color: #444; margin-bottom: 15px; }
            .card .title { font-size: 12px; font-weight: 500; height: 34px; overflow: hidden; margin-bottom: 15px; }
            
            .progress-bg { height: 1px; background: #222; width: 100%; margin-bottom: 10px; }
            .progress-fill { height: 100%; background: var(--main); }

            .stable-container { position: relative; margin-bottom: 40px; }
            .stable-bar-bg { height: 4px; background: #111; border-radius: 2px; overflow: hidden; margin-top: 10px; }
            .stable-bar-fill { height: 100%; background: var(--main); width: ${progress}%; transition: 1s linear; }

            .console { height: 200px; background: #000; border-top: 1px solid #111; padding: 20px; font-family: monospace; font-size: 11px; overflow-y: auto; color: #444; }
            .l-r { margin-bottom: 5px; }
            .l-t { color: #222; margin-right: 10px; }
            .l-ty[data-type="STABLE"] { color: var(--main); }
            .l-ty[data-type="SUCCESS"] { color: #fff; }
        </style>
    </head>
    <body>
        <div class="sidebar">
            <div class="logo"><i class="fab fa-youtube"></i> YOUTUBE HOUR VIEW</div>
            
            <div class="stable-container">
                <span class="stat-label">System Stability Monitor</span>
                <div class="stat-value" style="color:${lastFullStableTime ? 'var(--main)' : '#222'}">
                    ${lastFullStableTime ? Math.floor(stableSec/60)+'M '+(stableSec%60)+'S' : 'INACTIVE'}
                </div>
                <div class="stable-bar-bg"><div class="stable-bar-fill"></div></div>
            </div>

            <div class="stat-group">
                <span class="stat-label">Global Proxy Feed</span>
                <div class="stat-value">${stats.proxyReady.toLocaleString()}</div>
            </div>

            <div class="stat-group">
                <span class="stat-label">Accumulated Views</span>
                <div class="stat-value">${stats.totalViews}</div>
            </div>

            <div class="stat-group">
                <span class="stat-label">Total Watchtime</span>
                <div class="stat-value" style="font-size: 18px;">${formatTime(stats.totalWatchSeconds)}</div>
            </div>
        </div>

        <div class="main">
            <div class="grid">
                ${Object.entries(stats.threadStatus).map(([id, t]) => `
                    <div class="card ${t.status === 'PLAYING' ? 'playing' : ''}">
                        <div class="node-id">#${id} // ${t.proxy.split(':')[0]}</div>
                        <div class="title">${t.title}</div>
                        <div class="progress-bg"><div class="progress-fill" style="width:${(t.elapsed/t.target)*100}%"></div></div>
                        <div style="display:flex; justify-content:space-between; font-size:9px;">
                            <span style="color:${t.status==='PLAYING' ? 'var(--main)' : '#444'}">${t.status}</span>
                            <span>${t.elapsed}/${t.target}S</span>
                        </div>
                    </div>
                `).join('')}
            </div>
            <div class="console">${stats.logs.join('')}</div>
        </div>
        <script>setTimeout(() => location.reload(), 4000)</script>
    </body>
    </html>
    `);
});

app.listen(port, () => { main(); });
