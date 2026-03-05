const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const axios = require('axios');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 6; 
const PROXY_FILE = path.join(__dirname, 'good_proxies.json');
const startTime = Date.now();

let stats = {
    totalViews: 0,
    totalWatchSeconds: 0,
    activeThreads: 0,
    proxyCount: 0,
    threadStatus: {}, 
    logs: [] 
};

if (!fs.existsSync(PROXY_FILE)) fs.writeJsonSync(PROXY_FILE, []);
if (fs.existsSync(path.join(__dirname, 'temp'))) fs.removeSync(path.join(__dirname, 'temp'));

function fullLog(msg, type = 'INFO') {
    const logMsg = `[${new Date().toLocaleTimeString()}] [${type}] ${msg}`;
    stats.logs.unshift(logMsg);
    if (stats.logs.length > 100) stats.logs.pop();
    console.log(logMsg);
}

async function fetchFreeProxies() {
    const sources = [
        'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
        'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks4&timeout=10000',
        'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks4.txt',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
        'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt'
    ];
    let allProxies = [];
    const requests = sources.map(url => axios.get(url, { timeout: 10000 }).catch(() => null));
    const results = await Promise.all(requests);
    results.forEach(res => {
        if (res && res.data) {
            const found = res.data.match(/\d+\.\d+\.\d+\.\d+:\d+/g);
            if (found) allProxies = [...allProxies, ...found];
        }
    });
    return [...new Set(allProxies)];
}

async function checkProxy(proxy) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: [`--proxy-server=http://${proxy}`, '--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        const response = await page.goto('https://m.youtube.com', { waitUntil: 'networkidle2', timeout: 15000 });
        await browser.close();
        return response.status() === 200;
    } catch (e) {
        if (browser) await browser.close();
        return false;
    }
}

async function proxyHunter() {
    while (true) {
        fullLog("Đang quét nguồn proxy mới...", "SCAN");
        const rawList = await fetchFreeProxies();
        for (let p of rawList.slice(0, 100)) {
            if (stats.activeThreads >= MAX_THREADS) {
                const isGood = await checkProxy(p);
                if (isGood) {
                    let current = fs.readJsonSync(PROXY_FILE);
                    if (!current.includes(p)) {
                        current.push(p);
                        fs.writeJsonSync(PROXY_FILE, current);
                    }
                }
            } else {
                await new Promise(r => setTimeout(r, 1000));
            }
        }
        await new Promise(r => setTimeout(r, 30000));
    }
}

async function runWorker(onStarted) {
    stats.activeThreads++;
    const id = Math.random().toString(36).substring(7).toUpperCase();
    const userDataDir = path.join(__dirname, 'temp', `profile_${id}`);
    let hasTriggeredNext = false;

    let proxies = fs.readJsonSync(PROXY_FILE);
    let currentProxy = proxies.length > 0 ? proxies[Math.floor(Math.random() * proxies.length)] : null;

    stats.threadStatus[id] = { 
        videoTitle: 'Khởi tạo...', 
        iteration: 0, elapsed: 0, target: 0, 
        status: currentProxy ? `🌐 Proxy: ${currentProxy}` : '🏠 Direct IP'
    };

    let browser;
    try {
        const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--mute-audio', '--window-size=800,600'];
        if (currentProxy) args.push(`--proxy-server=http://${currentProxy}`);

        browser = await puppeteer.launch({ headless: "new", userDataDir, args });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        while (true) {
            stats.threadStatus[id].status = '📂 Nạp Playlist';
            await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2', timeout: 60000 });
            
            const videoLinks = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
                return [...new Set(links.map(a => a.href.split('&')[0]))]; 
            });

            if (!videoLinks || videoLinks.length === 0) {
                if(!hasTriggeredNext) { hasTriggeredNext = true; onStarted(); }
                await new Promise(r => setTimeout(r, 5000));
                continue;
            }

            for (let link of videoLinks) {
                stats.threadStatus[id].iteration++;
                stats.threadStatus[id].elapsed = 0;
                stats.threadStatus[id].status = '🔗 Nạp Video';

                await page.goto(link, { waitUntil: 'networkidle2', timeout: 60000 });
                const rawTitle = await page.title();
                stats.threadStatus[id].videoTitle = rawTitle.replace('- YouTube', '').trim();

                await page.evaluate(() => {
                    const v = document.querySelector('video');
                    if (v) { v.play(); v.muted = true; }
                    const player = document.getElementById('movie_player');
                    if (player && player.setPlaybackQualityRange) player.setPlaybackQualityRange('tiny');
                }).catch(() => {});

                const watchSeconds = Math.floor(Math.random() * 40) + 100;
                stats.threadStatus[id].target = watchSeconds;
                
                let actualWatchStart = 0;
                let lastTime = -1;
                let idleCount = 0;

                for (let s = 1; s <= watchSeconds + 60; s++) {
                    await new Promise(r => setTimeout(r, 1000));
                    const curTime = await page.evaluate(() => {
                        const v = document.querySelector('video');
                        return v ? v.currentTime : -2;
                    }).catch(() => -2);

                    if (curTime > lastTime && curTime > 0) {
                        if (actualWatchStart === 0 && !hasTriggeredNext) { 
                            hasTriggeredNext = true; onStarted(); 
                        }
                        actualWatchStart++;
                        lastTime = curTime;
                        idleCount = 0;
                        stats.threadStatus[id].elapsed = actualWatchStart;
                        stats.threadStatus[id].status = '📺 Đang Buff';
                        stats.totalWatchSeconds++;
                    } else {
                        idleCount++;
                        stats.threadStatus[id].status = '⏳ Đang Loading...';
                    }

                    if (actualWatchStart >= watchSeconds) break;
                    if (idleCount >= 45) throw new Error("Proxy die or Video stalled");
                }
                stats.totalViews++;
            }
        }
    } catch (err) {
        fullLog(`[ID:${id}] Lỗi: ${err.message}`, 'FAIL');
        if (currentProxy) {
            let list = fs.readJsonSync(PROXY_FILE);
            fs.writeJsonSync(PROXY_FILE, list.filter(p => p !== currentProxy));
        }
        if(!hasTriggeredNext) { hasTriggeredNext = true; onStarted(); }
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        delete stats.threadStatus[id];
        stats.activeThreads--;
    }
}

app.get('/', (req, res) => {
    stats.proxyCount = fs.readJsonSync(PROXY_FILE).length;
    res.send(`
        <body style="font-family:sans-serif; background:#050505; color:#eee; padding:20px; margin:0;">
            <div style="background:#111; padding:20px; border-bottom:5px solid #ff0000; position:sticky; top:0; z-index:100;">
                <h1 style="margin:0; color:#ff0000; display:flex; justify-content:space-between; align-items:center;">
                    🔴 YT-BOT PROXY SYSTEM
                    <span style="font-size:14px; color:#666; font-weight:normal;">Uptime: ${Math.floor((Date.now()-startTime)/60000)}m</span>
                </h1>
                <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:15px; margin-top:20px;">
                    <div style="background:#1a1a1a; padding:15px; border-radius:8px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888;">TỔNG VIEWS</div><b style="font-size:24px; color:#2ed573;">${stats.totalViews}</b>
                    </div>
                    <div style="background:#1a1a1a; padding:15px; border-radius:8px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888;">GIỜ XEM</div><b style="font-size:24px; color:#70a1ff;">${Math.floor(stats.totalWatchSeconds/60)}m</b>
                    </div>
                    <div style="background:#1a1a1a; padding:15px; border-radius:8px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888;">PROXY SỐNG</div><b style="font-size:24px; color:#eccc68;">${stats.proxyCount}</b>
                    </div>
                    <div style="background:#1a1a1a; padding:15px; border-radius:8px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888;">LUỒNG</div><b style="font-size:24px; color:#ff7f50;">${stats.activeThreads}/${MAX_THREADS}</b>
                    </div>
                </div>
            </div>
            <div style="padding:20px;">
                <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap:15px;">
                    ${Object.entries(stats.threadStatus).map(([id, t]) => `
                        <div style="background:#121212; border:1px solid #222; padding:15px; border-radius:8px; border-left: 4px solid red;">
                            <b style="color:#ff0000; font-size:14px;">THREAD: ${id}</b>
                            <div style="font-size:11px; margin:10px 0; color:#fff; height:30px; overflow:hidden;">🎬 ${t.videoTitle}</div>
                            <div style="background:#000; height:6px; border-radius:3px; margin-bottom:10px;">
                                <div style="width:${(t.elapsed/t.target)*100}%; background:#2ed573; height:100%;"></div>
                            </div>
                            <div style="display:flex; justify-content:space-between; font-size:10px;">
                                <span style="color:#888;">${t.status}</span>
                                <span>${t.elapsed}/${t.target}s</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
                <div style="background:#000; border:1px solid #222; padding:15px; height:200px; overflow-y:auto; font-family:monospace; color:#00ff41; font-size:11px; margin-top:20px;">
                    ${stats.logs.map(line => `<div>${line}</div>`).join('')}
                </div>
            </div>
            <script>setTimeout(() => location.reload(), 5000)</script>
        </body>
    `);
});

app.listen(port, () => { 
    proxyHunter();
    main();
});

async function main() {
    if (stats.activeThreads < MAX_THREADS) {
        runWorker(() => {});
        setTimeout(main, 3000); 
    } else {
        setTimeout(main, 10000);
    }
}
