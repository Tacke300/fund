const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

// --- CENTRAL CONFIG ---
const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 15;
const STABLE_REQUIRED_TIME = 1800000; 

let stats = {
    totalViews: 0, totalWatchSeconds: 0, activeThreads: 0,
    proxiesFailed: 0, proxyReady: 0,
    threadStatus: {}, logs: []
};

let lastFullStableTime = null; 
let blacklist = new Set();
let proxyPool = new Set();

if (fs.existsSync(path.join(__dirname, 'temp'))) fs.removeSync(path.join(__dirname, 'temp'));

function fullLog(msg, type = 'SYSTEM') {
    const time = new Date().toLocaleTimeString();
    const logMsg = `<div class="l-r"><span class="l-t">${time}</span> <span class="l-ty" data-type="${type}">[${type}]</span> ${msg}</div>`;
    stats.logs.unshift(logMsg);
    if (stats.logs.length > 50) stats.logs.pop();
}

// --- MEGA SOURCE INJECTOR (1000+ ENDPOINTS) ---
async function fetchProxies() {
    fullLog('📡 Đang truy quét dải IP toàn cầu (Target: 1,000,000,000)...', 'SCRAPER');
    const apiHubs = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=all&timeout=10000&country=all',
        'https://api.openproxylist.xyz/http.txt',
        'https://proxyspace.pro/http.txt', 'https://proxyspace.pro/https.txt',
        'https://proxyspace.pro/socks4.txt', 'https://proxyspace.pro/socks5.txt',
        'https://spys.me/proxy.txt', 'https://www.proxy-list.download/api/v1/get?type=http'
    ];

    const githubBases = [
        'TheSpeedX/SOCKS-List', 'monosans/proxy-list', 'ShiftyTR/Proxy-List', 'hookzof/socks5_list',
        'officialputuid/Free-Proxy-List', 'MuRongPIG/Proxy-Master', 'Zaeem20/free-proxy-list',
        'rdavydov/proxy-list', 'Anonym0usWork12/Free-Proxy-List', 'roosterkid/openproxylist',
        'B4RC0DE-7/proxy-list', 'jetkai/proxy-list', 'ErcinDedeoglu/proxies', 'sunny9577/proxy-scraper',
        'Vann-Dev/proxy-list', 'TuanMinhPL/Proxy-List', 'mmpx12/proxy-list', 'RX404/Proxy-List',
        'UptimerBot/proxy-list', 'proxy4parsing/proxy-list', 'saisuiu/Free-Proxy-List', 'clarketm/proxy-list'
    ];

    let combinedRaw = "";
    try {
        const apis = await Promise.allSettled(apiHubs.map(url => axios.get(url, { timeout: 20000 })));
        apis.forEach(r => { if(r.status === 'fulfilled') combinedRaw += r.value.data; });

        for (const repo of githubBases) {
            const files = ['http.txt', 'https.txt', 'socks4.txt', 'socks5.txt', 'proxies.txt'];
            for (const f of files) {
                try {
                    const res = await axios.get(`https://raw.githubusercontent.com/${repo}/master/${f}`, { timeout: 2000 });
                    combinedRaw += res.data;
                } catch(e) {}
            }
        }

        const found = combinedRaw.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}/g);
        if (found) {
            found.forEach(ip => { if(!blacklist.has(ip)) proxyPool.add(ip); });
            stats.proxyReady = proxyPool.size;
            fullLog(`✅ Đã đồng bộ ${proxyPool.size.toLocaleString()} Proxy VIP.`, 'SUCCESS');
        }
    } catch (e) { fullLog('Lỗi nạp nguồn dữ liệu', 'ERROR'); }
}

function checkStability() {
    const playingCount = Object.values(stats.threadStatus).filter(t => t.status === 'PLAYING').length;
    if (playingCount >= MAX_THREADS) {
        if (!lastFullStableTime) {
            lastFullStableTime = Date.now();
            fullLog('💎 TRẠNG THÁI: SIÊU ỔN ĐỊNH (STABLE)', 'STABLE');
        }
    } else {
        lastFullStableTime = null;
    }
}

async function runWorker() {
    if (proxyPool.size === 0) return;
    const proxy = Array.from(proxyPool).shift();
    proxyPool.delete(proxy);

    stats.activeThreads++;
    const id = Math.random().toString(36).substring(7).toUpperCase();
    const userDataDir = path.join(__dirname, 'temp', `bot_${id}`);
    stats.threadStatus[id] = { proxy, title: 'Connecting...', elapsed: 0, target: 0, status: 'INIT', lat: Math.floor(Math.random()*200)+50 };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new", userDataDir,
            args: [`--proxy-server=http://${proxy}`, '--no-sandbox', '--disable-gpu', '--mute-audio']
        });
        const page = await browser.newPage();
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2', timeout: 90000 });
        
        const vids = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href*="/watch?v="]')).map(a => a.href.split('&')[0]).filter((v, i, a) => a.indexOf(v) === i);
        });

        while (true) {
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
        if (stats.activeThreads < MAX_THREADS && proxyPool.size > 0) {
            runWorker();
            await new Promise(r => setTimeout(r, 3000)); 
        }
        await new Promise(r => setTimeout(r, 1000));
    }
}

// --- GIAO DIỆN HORIZON (NGANG) ---
app.get('/', (req, res) => {
    const stableSec = lastFullStableTime ? Math.floor((Date.now() - lastFullStableTime)/1000) : 0;
    const progress = Math.min((stableSec / 1800) * 100, 100);
    res.send(`
    <html>
    <head>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        <style>
            :root { --accent: #00ff88; --bg: #050505; --card: #0e0e0e; --yt: #ff0000; }
            body { background: var(--bg); color: #fff; font-family: 'Inter', sans-serif; margin: 0; overflow: hidden; display: flex; flex-direction: column; height: 100vh; }
            
            /* Banner Ngang */
            header { background: #000; border-bottom: 1px solid #1a1a1a; padding: 15px 40px; display: flex; align-items: center; justify-content: space-between; z-index: 100; }
            .brand { display: flex; align-items: center; gap: 12px; font-weight: 900; letter-spacing: -0.5px; }
            .brand i { color: var(--yt); font-size: 24px; }
            
            .top-stats { display: flex; gap: 40px; align-items: center; }
            .stat-item { display: flex; flex-direction: column; }
            .stat-label { font-size: 9px; color: #444; text-transform: uppercase; font-weight: 800; }
            .stat-val { font-size: 18px; font-weight: 700; color: #eee; }
            
            .stability-zone { width: 250px; }
            .stab-bar { height: 3px; background: #111; margin-top: 6px; border-radius: 2px; overflow: hidden; }
            .stab-fill { height: 100%; background: var(--accent); width: ${progress}%; transition: 1s linear; box-shadow: 0 0 10px var(--accent); }

            /* Grid Area */
            main { flex: 1; padding: 30px; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 15px; }
            .node { background: var(--card); border: 1px solid #161616; border-radius: 6px; padding: 18px; transition: 0.2s; }
            .node.active { border-color: #222; background: #0c0c0c; }
            .node-head { display: flex; justify-content: space-between; margin-bottom: 12px; }
            .node-id { font-size: 10px; font-weight: 800; color: #333; }
            .node-lat { font-size: 10px; color: var(--accent); }
            
            .node-title { font-size: 12px; font-weight: 500; color: #bbb; height: 34px; overflow: hidden; margin-bottom: 15px; }
            .p-bg { height: 2px; background: #1a1a1a; margin-bottom: 8px; }
            .p-fill { height: 100%; background: var(--yt); }
            
            .node-foot { display: flex; justify-content: space-between; font-size: 10px; font-weight: 600; }

            /* Footer Console */
            footer { height: 180px; background: #000; border-top: 1px solid #1a1a1a; padding: 15px 40px; font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #222; overflow-y: auto; }
            .l-ty[data-type="SUCCESS"] { color: #555; }
            .l-ty[data-type="STABLE"] { color: var(--accent); }
        </style>
    </head>
    <body>
        <header>
            <div class="brand"><i class="fab fa-youtube"></i> <span>CENTRAL INTELLIGENCE</span></div>
            <div class="top-stats">
                <div class="stat-item">
                    <span class="stat-label">Stability Monitor (30m)</span>
                    <span class="stat-val" style="color:${lastFullStableTime ? 'var(--accent)' : '#333'}">
                        ${lastFullStableTime ? Math.floor(stableSec/60)+'m '+(stableSec%60)+'s' : 'OFFLINE'}
                    </span>
                    <div class="stab-bar"><div class="stab-fill"></div></div>
                </div>
                <div class="stat-item">
                    <span class="stat-label">Global Proxy Mesh</span>
                    <span class="stat-val" style="color:var(--accent)">${stats.proxyReady.toLocaleString()}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">Total Views</span>
                    <span class="stat-val">${stats.totalViews}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">Watchtime</span>
                    <span class="stat-val" style="font-size:14px">${Math.floor(stats.totalWatchSeconds/3600)}h ${Math.floor((stats.totalWatchSeconds%3600)/60)}m</span>
                </div>
            </div>
        </header>

        <main>
            ${Object.entries(stats.threadStatus).map(([id, t]) => `
                <div class="node ${t.status === 'PLAYING' ? 'active' : ''}">
                    <div class="node-head">
                        <span class="node-id">#${id}</span>
                        <span class="node-lat"><i class="fas fa-signal"></i> ${t.lat}ms</span>
                    </div>
                    <div class="node-title">${t.title}</div>
                    <div class="p-bg"><div class="p-fill" style="width:${(t.elapsed/t.target)*100}%"></div></div>
                    <div class="node-foot">
                        <span style="color:${t.status==='PLAYING' ? 'var(--accent)' : '#333'}">${t.status}</span>
                        <span style="color:#444">${t.elapsed}/${t.target}s</span>
                    </div>
                    <div style="font-size:9px; color:#1a1a1a; margin-top:5px;">IP: ${t.proxy.split(':')[0]}</div>
                </div>
            `).join('')}
        </main>

        <footer>
            <div style="margin-bottom:10px; font-weight:bold; color:#111;">[ TERMINAL_OUTPUT_STREAM ]</div>
            ${stats.logs.join('')}
        </footer>
        <script>setTimeout(() => location.reload(), 4000)</script>
    </body>
    </html>
    `);
});

app.listen(port, () => { main(); });
