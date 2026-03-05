const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

// --- CẤU HÌNH HỆ THỐNG ---
const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 15;
const ROTATION_TIME = 1800000; 
const startTime = Date.now();

let stats = {
    totalViews: 0,
    totalWatchSeconds: 0,
    activeThreads: 0,
    proxiesFailed: 0,
    proxyReady: 0,
    blacklistSize: 0,
    successRate: 0,
    threadStatus: {}, 
    logs: [],
    blacklistSample: [] // Lưu 10 IP bị cấm gần nhất
};

let blacklist = new Set();
let proxyList = [];

if (fs.existsSync(path.join(__dirname, 'temp'))) fs.removeSync(path.join(__dirname, 'temp'));

function fullLog(msg, type = 'INFO') {
    const time = new Date().toLocaleTimeString();
    const colorMap = { 'SUCCESS': '#00ff41', 'FAILED': '#ff4757', 'SCRAPER': '#00ffff', 'SYSTEM': '#eccc68' };
    const color = colorMap[type] || '#fff';
    const logMsg = `<div style="margin-bottom:2px"><span style="color:#666">[${time}]</span> <span style="color:${color}">[${type}]</span> ${msg}</div>`;
    stats.logs.unshift(logMsg);
    if (stats.logs.length > 200) stats.logs.pop();
    console.log(`[${time}] [${type}] ${msg}`);
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
}

// --- 1. ENGINE QUÉT PROXY VÔ TẬN ---
async function fetchProxies() {
    fullLog('🌀 Đang thâm nhập các kho Proxy tổng...', 'SCRAPER');
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
        'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt',
        'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
        'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/B4RC0DE-7/proxy-list/main/HTTP.txt',
        'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt'
    ];

    try {
        const responses = await Promise.allSettled(sources.map(url => axios.get(url, { timeout: 15000 })));
        let allData = "";
        responses.forEach(res => { if (res.status === 'fulfilled') allData += res.value.data; });
        const found = allData.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}/g);
        if (found) {
            const unique = [...new Set(found)].filter(p => !blacklist.has(p));
            proxyList = unique;
            stats.proxyReady = proxyList.length;
            fullLog(`Đã đồng bộ ${proxyList.length} Proxy mới.`, 'SYSTEM');
        }
    } catch (e) { fullLog('Lỗi truy xuất kho dữ liệu Proxy', 'FAILED'); }
}

// --- 2. CORE WORKER (INFINITE LOOP) ---
async function runWorker(proxy) {
    stats.activeThreads++;
    const id = Math.random().toString(36).substring(7).toUpperCase();
    const userDataDir = path.join(__dirname, 'temp', `profile_${id}`);
    const birth = Date.now();
    
    stats.threadStatus[id] = { proxy, title: 'Connecting...', iteration: 1, elapsed: 0, target: 0, status: 'INITIALIZING', birth };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir,
            args: [`--proxy-server=http://${proxy}`, '--no-sandbox', '--disable-gpu', '--mute-audio']
        });

        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(90000);
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');

        fullLog(`[${id}] Tìm nạp Playlist...`, 'SYSTEM');
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
        const vids = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href*="/watch?v="]'))
                        .map(a => a.href.split('&')[0])
                        .filter((v, i, a) => a.indexOf(v) === i);
        });

        if (!vids.length) throw new Error("Blocked by YouTube");

        while (true) {
            if (Date.now() - birth > ROTATION_TIME) break; // Đổi luồng sau 30p

            for (let i = 0; i < vids.length; i++) {
                let success = false, retry = 0;
                while (!success && retry < 3) {
                    try {
                        stats.threadStatus[id].status = `NAVIGATING V${i+1}`;
                        await page.goto(vids[i], { waitUntil: 'networkidle2', timeout: 60000 });
                        await page.waitForSelector('.video-stream', { timeout: 20000 });
                        
                        stats.threadStatus[id].title = (await page.title()).replace('- YouTube', '');
                        stats.threadStatus[id].status = 'PLAYING';
                        
                        const watchTime = Math.floor(Math.random() * 60) + 180;
                        stats.threadStatus[id].target = watchTime;

                        for (let s = 1; s <= watchTime; s++) {
                            await new Promise(r => setTimeout(r, 1000));
                            stats.threadStatus[id].elapsed = s;
                            stats.totalWatchSeconds++;
                        }
                        stats.totalViews++;
                        success = true;
                        
                        // Nghỉ giữa video
                        const rest = 15;
                        stats.threadStatus[id].status = `RESTING`;
                        await new Promise(r => setTimeout(r, rest * 1000));
                    } catch (e) {
                        retry++;
                        await new Promise(r => setTimeout(r, 5000));
                    }
                }
                if (!success) break;
            }
        }
    } catch (err) {
        blacklist.add(proxy);
        stats.blacklistSize = blacklist.size;
        stats.blacklistSample.unshift(proxy);
        if (stats.blacklistSample.length > 10) stats.blacklistSample.pop();
        stats.proxiesFailed++;
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        delete stats.threadStatus[id];
        stats.activeThreads--;
    }
}

// --- 3. MAIN ---
async function main() {
    await fetchProxies();
    setInterval(fetchProxies, 300000);
    while (true) {
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
            await new Promise(r => setTimeout(r, 5000)); 
        }
        await new Promise(r => setTimeout(r, 2000));
    }
}

// --- 4. GIAO DIỆN GALAXY V10 ---
app.get('/', (req, res) => {
    const successRate = ((stats.totalViews / (stats.totalViews + stats.proxiesFailed || 1)) * 100).toFixed(1);
    res.send(`
    <html>
    <head>
        <title>GALAXY CORE V10</title>
        <style>
            :root { --neon: #00ff41; --danger: #ff4757; --bg: #050505; --glass: rgba(20, 20, 20, 0.85); }
            body { background: var(--bg); color: #ccc; font-family: 'Segoe UI', sans-serif; margin: 0; padding: 20px; display: grid; grid-template-columns: 350px 1fr; gap: 20px; height: 100vh; overflow: hidden; }
            
            /* Sidebar Thống kê */
            .sidebar { background: var(--glass); border-right: 1px solid #222; padding: 20px; overflow-y: auto; border: 1px solid #333; border-radius: 15px; }
            .stat-box { margin-bottom: 25px; border-bottom: 1px solid #222; padding-bottom: 15px; }
            .stat-box h4 { color: var(--neon); text-transform: uppercase; font-size: 12px; margin-bottom: 10px; letter-spacing: 2px; }
            .stat-box big { font-size: 28px; color: #fff; font-family: monospace; }
            
            /* Main Content */
            .main-panel { display: flex; flex-direction: column; gap: 20px; overflow-y: auto; padding-right: 10px; }
            .header-nav { display: flex; justify-content: space-between; align-items: center; background: linear-gradient(90deg, #000, #111); padding: 15px 25px; border-radius: 10px; border: 1px solid #333; }
            
            /* Grid luồng */
            .thread-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 15px; }
            .thread-card { background: rgba(255,255,255,0.03); border: 1px solid #222; border-radius: 8px; padding: 12px; transition: 0.3s; position: relative; }
            .thread-card:hover { border-color: var(--neon); background: rgba(0, 255, 65, 0.05); }
            .progress-bar { height: 3px; background: #111; margin: 10px 0; border-radius: 2px; overflow: hidden; }
            .progress-fill { height: 100%; background: var(--neon); box-shadow: 0 0 10px var(--neon); transition: 0.5s; }
            
            /* Logs & Blacklist */
            .bottom-section { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; min-height: 300px; }
            .panel-box { background: #000; border: 1px solid #222; border-radius: 10px; padding: 15px; font-family: monospace; font-size: 11px; }
            .blacklist-item { color: var(--danger); border-bottom: 1px solid #111; padding: 2px 0; }
            
            ::-webkit-scrollbar { width: 5px; }
            ::-webkit-scrollbar-thumb { background: #333; border-radius: 10px; }
        </style>
    </head>
    <body>
        <div class="sidebar">
            <h2 style="color:var(--neon); letter-spacing:-1px;">GALAXY CORE <small style="font-size:10px; vertical-align:middle; color:#666;">V10</small></h2>
            <div class="stat-box"><h4>Total Views</h4><big>${stats.totalViews}</big></div>
            <div class="stat-box"><h4>Total Watchtime</h4><big>${formatTime(stats.totalWatchSeconds)}</big></div>
            <div class="stat-box"><h4>Active Threads</h4><big>${stats.activeThreads}/${MAX_THREADS}</big></div>
            <div class="stat-box"><h4>Proxy Pool</h4><big style="color:#00ffff">${stats.proxyReady}</big></div>
            <div class="stat-box"><h4>Success Rate</h4><big style="color:${successRate > 50 ? 'var(--neon)' : 'var(--danger)'}">${successRate}%</big></div>
            <div class="stat-box" style="border:none">
                <h4>Blacklist (${stats.blacklistSize})</h4>
                <div style="font-size:10px; opacity:0.6">
                    ${stats.blacklistSample.map(ip => `<div class="blacklist-item">✖ ${ip}</div>`).join('')}
                </div>
            </div>
        </div>

        <div class="main-panel">
            <div class="header-nav">
                <span style="font-size:12px; color:#888;">TARGET: <b style="color:#fff">${PLAYLIST_URL.substring(0,50)}...</b></span>
                <span style="font-size:12px; color:#888;">UPTIME: <b style="color:#fff">${Math.floor((Date.now()-startTime)/60000)}m</b></span>
            </div>

            <div class="thread-grid">
                ${Object.entries(stats.threadStatus).map(([id, t]) => `
                    <div class="thread-card">
                        <div style="display:flex; justify-content:space-between; font-size:10px; margin-bottom:8px;">
                            <b style="color:var(--neon)">[${id}]</b>
                            <span style="color:#666">${t.proxy.split(':')[0]}</span>
                        </div>
                        <div style="font-size:12px; color:#eee; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${t.title}</div>
                        <div class="progress-bar"><div class="progress-fill" style="width:${(t.elapsed/t.target)*100}%"></div></div>
                        <div style="display:flex; justify-content:space-between; font-size:10px;">
                            <span style="color:#eccc68">${t.status}</span>
                            <span>${t.elapsed}/${t.target}s</span>
                        </div>
                    </div>
                `).join('')}
            </div>

            <div class="bottom-section">
                <div class="panel-box" style="border-top: 2px solid var(--neon)">
                    <div style="color:var(--neon); margin-bottom:10px; font-weight:bold">SYSTEM REAL-TIME LOGS</div>
                    <div style="height:230px; overflow-y:auto;">${stats.logs.join('')}</div>
                </div>
                <div class="panel-box" style="border-top: 2px solid var(--danger)">
                    <div style="color:var(--danger); margin-bottom:10px; font-weight:bold">BOT ARCHITECTURE INFO</div>
                    <div style="color:#888">
                        - Headless Mode: <span style="color:#fff">ENABLED</span><br>
                        - Stealth Plugin: <span style="color:#fff">ACTIVE</span><br>
                        - Rotation Cycle: <span style="color:#fff">30 MINUTES</span><br>
                        - Fingerprint: <span style="color:#fff">RANDOMIZED</span><br>
                        - Thread Sync: <span style="color:#fff">ASYNCHRONOUS</span><br><br>
                        <div style="text-align:center; margin-top:20px; color:var(--neon); opacity:0.3; font-size:40px;">❖</div>
                    </div>
                </div>
            </div>
        </div>
        <script>setTimeout(() => location.reload(), 4000)</script>
    </body>
    </html>
    `);
});

app.listen(port, () => { main(); });
