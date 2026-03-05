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
const MAX_THREADS = 15;
const STABLE_REQUIRED_TIME = 1800000; // 30 phút ổn định
const startTime = Date.now();

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
    const colorMap = { 'SUCCESS': '#00ff41', 'FAILED': '#ff4757', 'SCRAPER': '#00ffff', 'STABLE': '#eccc68', 'ROTATION': '#ff00ff' };
    const logMsg = `<div class="log-item"><span class="log-time">[${time}]</span> <span style="color:${colorMap[type] || '#fff'}">[${type}]</span> ${msg}</div>`;
    stats.logs.unshift(logMsg);
    if (stats.logs.length > 200) stats.logs.pop();
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
}

// --- 1. SIÊU CÀO 100K PROXY ---
async function fetchProxies() {
    fullLog('📡 Đang truy quét 100k Proxy từ toàn bộ kho API thế giới...', 'SCRAPER');
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
        'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
        'https://raw.githubusercontent.com/UptimerBot/proxy-list/main/proxies/http.txt',
        'https://proxy-list.download/api/v1/get?type=http'
    ];
    try {
        const responses = await Promise.allSettled(sources.map(url => axios.get(url, { timeout: 15000 })));
        let allData = "";
        responses.forEach(res => { if (res.status === 'fulfilled') allData += res.value.data; });
        const found = allData.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}/g);
        if (found) {
            proxyList = [...new Set(found)].filter(p => !blacklist.has(p));
            stats.proxyReady = proxyList.length;
            fullLog(`Hệ thống đã nạp ${proxyList.length} Proxy vào kho đạn.`, 'SYSTEM');
        }
    } catch (e) { fullLog('Lỗi cào IP nguồn', 'FAILED'); }
}

function checkStability() {
    const threadValues = Object.values(stats.threadStatus);
    const playingCount = threadValues.filter(t => t.status === 'PLAYING').length;
    if (playingCount >= MAX_THREADS) {
        if (!lastFullStableTime) {
            lastFullStableTime = Date.now();
            fullLog('🔥 ĐÃ ĐẠT 15/15 PLAYING. KÍCH HOẠT ĐẾM NGƯỢC 30P!', 'STABLE');
        }
    } else {
        if (lastFullStableTime) {
            lastFullStableTime = null;
            fullLog('⚠️ HỆ THỐNG MẤT ỔN ĐỊNH. ĐỒNG HỒ RESET!', 'FAILED');
        }
    }
}

// --- 2. LUỒNG XEM VÔ TẬN ---
async function runWorker(proxy) {
    stats.activeThreads++;
    const id = Math.random().toString(36).substring(7).toUpperCase();
    const userDataDir = path.join(__dirname, 'temp', `profile_${id}`);
    const birth = Date.now();
    stats.threadStatus[id] = { proxy, title: 'Đang kết nối...', iteration: 1, elapsed: 0, target: 0, status: 'INIT', birth };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir,
            args: [`--proxy-server=http://${proxy}`, '--no-sandbox', '--disable-gpu', '--mute-audio']
        });
        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(120000);
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
        const vids = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href*="/watch?v="]')).map(a => a.href.split('&')[0]).filter((v, i, a) => a.indexOf(v) === i);
        });
        if (!vids.length) throw new Error("Blocked");

        while (true) {
            if (lastFullStableTime && (Date.now() - lastFullStableTime > STABLE_REQUIRED_TIME)) {
                if (birth < lastFullStableTime) {
                    fullLog(`[${id}] Luồng cũ đã hoàn thành 30p ổn định. Thay Proxy mới.`, 'ROTATION');
                    break;
                }
            }
            for (let i = 0; i < vids.length; i++) {
                let success = false, retry = 0;
                while (!success && retry < 3) {
                    try {
                        stats.threadStatus[id].status = `LOADING`;
                        checkStability();
                        await page.goto(vids[i], { waitUntil: 'networkidle2', timeout: 60000 });
                        await page.waitForSelector('.video-stream', { timeout: 20000 });
                        stats.threadStatus[id].title = (await page.title()).replace('- YouTube', '');
                        stats.threadStatus[id].status = 'PLAYING';
                        checkStability();
                        const watchTime = Math.floor(Math.random() * 61) + 180;
                        stats.threadStatus[id].target = watchTime;
                        for (let s = 1; s <= watchTime; s++) {
                            await new Promise(r => setTimeout(r, 1000));
                            stats.threadStatus[id].elapsed = s;
                            stats.totalWatchSeconds++;
                        }
                        stats.totalViews++;
                        success = true;
                        stats.threadStatus[id].status = 'DELAY';
                        checkStability();
                        await new Promise(r => setTimeout(r, 15000));
                    } catch (e) {
                        retry++;
                        stats.threadStatus[id].status = `RETRY ${retry}`;
                        checkStability();
                        await new Promise(r => setTimeout(r, 5000));
                    }
                }
                if (!success) break;
            }
            fullLog(`[${id}] Hoàn thành Playlist. Replay...`, 'SUCCESS');
        }
    } catch (err) {
        blacklist.add(proxy);
        stats.blacklistSize = blacklist.size;
        stats.blacklistSample.unshift(proxy);
        if (stats.blacklistSample.length > 15) stats.blacklistSample.pop();
        stats.proxiesFailed++;
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
    setInterval(fetchProxies, 300000);
    while (true) {
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
            await new Promise(r => setTimeout(r, 6000)); 
        }
        await new Promise(r => setTimeout(r, 2000));
    }
}

// --- 3. GIAO DIỆN MONITOR SIÊU CẤP ---
app.get('/', (req, res) => {
    const stableSec = lastFullStableTime ? Math.floor((Date.now() - lastFullStableTime)/1000) : 0;
    res.send(`
    <html>
    <head>
        <title>GALAXY ARCHITECT V13</title>
        <style>
            :root { --neon: #00ff41; --danger: #ff4757; --cyan: #00ffff; --bg: #030303; }
            body { background: var(--bg); color: #fff; font-family: 'Segoe UI', Tahoma, sans-serif; margin: 0; display: flex; height: 100vh; overflow: hidden; }
            
            /* CỘT TRÁI - INFO */
            .sidebar { width: 320px; background: #0a0a0a; border-right: 1px solid #222; padding: 20px; display: flex; flex-direction: column; }
            .stat-card { background: #111; border: 1px solid #333; padding: 15px; border-radius: 12px; margin-bottom: 15px; position: relative; }
            .stat-card.active { border-color: var(--cyan); box-shadow: 0 0 15px rgba(0,255,255,0.1); }
            .label { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
            .value { font-size: 24px; font-weight: bold; font-family: monospace; }
            
            /* CỘT GIỮA - MAIN GRID */
            .main { flex: 1; padding: 25px; overflow-y: auto; background: radial-gradient(circle at top, #0f0f0f, #030303); }
            .thread-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 15px; }
            .card { background: rgba(255,255,255,0.03); border: 1px solid #222; border-radius: 10px; padding: 15px; position: relative; overflow: hidden; }
            .card.playing { border-color: var(--neon); animation: glow 2s infinite; }
            @keyframes glow { 0%, 100% { box-shadow: 0 0 5px rgba(0,255,65,0.1); } 50% { box-shadow: 0 0 15px rgba(0,255,65,0.3); } }
            
            /* PROGRESS BARS */
            .bar-bg { background: #000; height: 4px; border-radius: 2px; margin: 10px 0; }
            .bar-fill { height: 100%; background: var(--neon); width: 0%; transition: 0.5s linear; box-shadow: 0 0 10px var(--neon); }
            
            /* CONSOLE LOG */
            .console { height: 250px; background: #000; border-top: 1px solid #333; padding: 15px; font-family: 'Consolas', monospace; font-size: 11px; overflow-y: auto; }
            .log-time { color: #555; }
            .log-item { margin-bottom: 3px; border-bottom: 1px solid #111; padding-bottom: 2px; }

            /* BLACKLIST AREA */
            .blacklist-tag { display: inline-block; padding: 2px 5px; background: #200; color: var(--danger); font-size: 9px; margin: 2px; border-radius: 3px; border: 1px solid #400; }
        </style>
    </head>
    <body>
        <div class="sidebar">
            <h2 style="color:var(--neon); margin:0 0 20px 0;">CORE V13</h2>
            <div class="stat-card ${lastFullStableTime ? 'active' : ''}">
                <div class="label">Stable Countdown (30m)</div>
                <div class="value" style="color:var(--cyan)">${lastFullStableTime ? Math.floor(stableSec/60)+'m '+(stableSec%60)+'s' : 'WAITING...'}</div>
            </div>
            <div class="stat-card">
                <div class="label">Total Views</div>
                <div class="value">${stats.totalViews}</div>
            </div>
            <div class="stat-card">
                <div class="label">Total Time</div>
                <div class="value" style="font-size:18px;">${formatTime(stats.totalWatchSeconds)}</div>
            </div>
            <div class="stat-card">
                <div class="label">Proxy Pool</div>
                <div class="value" style="color:#f1c40f">${stats.proxyReady}</div>
            </div>
            <div style="flex:1; overflow-y:auto; margin-top:10px;">
                <div class="label" style="margin-bottom:10px;">Recent Blacklist (${stats.blacklistSize})</div>
                ${stats.blacklistSample.map(ip => `<span class="blacklist-tag">${ip}</span>`).join('')}
            </div>
        </div>

        <div style="flex:1; display:flex; flex-direction:column;">
            <div class="main">
                <div class="thread-grid">
                    ${Object.entries(stats.threadStatus).map(([id, t]) => `
                        <div class="card ${t.status === 'PLAYING' ? 'playing' : ''}">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span style="font-weight:bold; color:var(--neon); font-size:12px;">🆔 ${id}</span>
                                <span style="font-size:10px; color:#555;">${t.proxy.split(':')[0]}</span>
                            </div>
                            <div style="margin:10px 0; font-size:13px; height:34px; overflow:hidden; line-height:1.3;">
                                ${t.title}
                            </div>
                            <div class="bar-bg"><div class="bar-fill" style="width:${(t.elapsed/t.target)*100}%"></div></div>
                            <div style="display:flex; justify-content:space-between; font-size:10px;">
                                <span style="color:${t.status==='PLAYING' ? 'var(--neon)' : '#eccc68'}">● ${t.status}</span>
                                <span style="color:#888">${t.elapsed}/${t.target}s</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
            <div class="console">
                <div style="color:var(--neon); margin-bottom:10px; border-bottom:1px solid #222;">> SYSTEM_OPERATIONAL_LOGS</div>
                ${stats.logs.join('')}
            </div>
        </div>
        <script>setTimeout(() => location.reload(), 4000)</script>
    </body>
    </html>
    `);
});

app.listen(port, () => { main(); });
