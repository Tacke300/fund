const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const UserAgents = require('user-agents');
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
const DATA_FILE = './playlist_data.json';
const BLACKLIST_FILE = './blacklist_proxy.json';
const ERROR_DIR = './errors';

if (!fs.existsSync(ERROR_DIR)) fs.mkdirSync(ERROR_DIR);

let stats = {
    totalViews: 0, totalSeconds: 0, activeThreads: 0,
    blacklistedCount: 0, videoCount: 0, threadStatus: {}, history: []
};

let proxyList = [];
let videoTitles = [];
let blacklist = fs.existsSync(BLACKLIST_FILE) ? fs.readJsonSync(BLACKLIST_FILE) : {};

function formatTime(s) {
    const h = Math.floor(s/3600);
    const m = Math.floor((s%3600)/60);
    return `${h}h ${m}m ${s%60}s`;
}

function doLog(proxy, msg) {
    console.log(`\x1b[36m[${new Date().toLocaleTimeString()}]\x1b[0m \x1b[33m[${proxy}]\x1b[0m ${msg}`);
}

async function scanPlaylist() {
    doLog('SYSTEM', "🔍 Đang trinh sát Playlist...");
    const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
    const page = await browser.newPage();
    try {
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        videoTitles = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('#video-title')).map(el => el.innerText.trim()).filter(t => t !== "");
        });
        stats.videoCount = videoTitles.length;
        fs.writeJsonSync(DATA_FILE, videoTitles);
        doLog('SYSTEM', `✅ Đã lưu ${videoTitles.length} video.`);
    } catch (e) { doLog('SYSTEM', "❌ Lỗi quét Playlist."); }
    await browser.close();
}

async function fetchProxies() {
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt'
    ];
    let all = [];
    for (let s of sources) {
        try { const res = await axios.get(s); all = all.concat(res.data.split('\n')); } catch(e){}
    }
    proxyList = [...new Set(all.map(p => p.trim()).filter(p => p.includes(':') && !blacklist[p]))];
    stats.blacklistedCount = Object.keys(blacklist).length;
}

async function runWorker(proxy) {
    stats.activeThreads++;
    const threadId = Math.random().toString(36).substring(7);
    const userDataDir = path.join(__dirname, 'temp', `profile_${threadId}`);
    stats.threadStatus[threadId] = { proxy, title: '---', elapsed: 0, target: 0, lastAction: '🚀 Khởi động', iteration: 0 };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: userDataDir,
            args: [
                `--proxy-server=http://${proxy}`, '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio', '--window-size=1280,720'
            ]
        });

        const page = await browser.newPage();
        await page.setUserAgent(new UserAgents({ deviceCategory: 'desktop' }).toString());
        await page.setDefaultNavigationTimeout(45000);

        // TỐI ƯU: Chặn rác để nhẹ máy
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        stats.threadStatus[threadId].lastAction = '🌍 Vào YouTube...';
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });

        // --- BỘ DIỆT CONSENT ĐA NGÔN NGỮ ---
        stats.threadStatus[threadId].lastAction = '🛡️ Diệt màn hình Chào';
        await page.evaluate(async () => {
            const keywords = ['Accept all', 'I agree', 'Chấp nhận', 'Tôi đồng ý', 'Agree', 'Ich stimme zu', 'Tout accepter', 'Aceptar todo', 'Alle chấp nhận'];
            const btns = Array.from(document.querySelectorAll('button, span, div, yt-formatted-string'));
            const target = btns.find(b => keywords.some(k => b.innerText && b.innerText.includes(k)));
            if (target) target.click();
        });
        await new Promise(r => setTimeout(r, 5000));

        // Bấm Play
        await page.evaluate(() => {
            const playBtn = document.querySelector('a.ytd-playlist-thumbnail') || document.querySelector('#video-title');
            if (playBtn) playBtn.click();
        });

        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 6000));
            let currentTitle = await page.title();

            // Nếu kẹt, thử diệt Consent lần 2
            if (currentTitle.includes("Before you") || currentTitle === "YouTube") {
                await page.evaluate(() => {
                    const b = Array.from(document.querySelectorAll('button')).find(x => /Accept|Agree|Chấp nhận|I agree/i.test(x.innerText));
                    if (b) b.click();
                });
                await new Promise(r => setTimeout(r, 4000));
                currentTitle = await page.title();
            }

            if (currentTitle.includes("Before you") || currentTitle === "YouTube") {
                // Chụp ảnh lỗi để soi
                await page.screenshot({ path: `${ERROR_DIR}/${proxy.replace(/:/g, '_')}.png` });
                throw new Error("Kẹt màn hình chào (Đã chụp ảnh)");
            }

            const watchSecs = Math.floor(Math.random() * 60) + 180; 
            stats.threadStatus[threadId].title = currentTitle.replace("- YouTube", "");
            stats.threadStatus[threadId].iteration = i + 1;
            stats.threadStatus[threadId].target = watchSecs;
            stats.threadStatus[threadId].elapsed = 0;
            stats.threadStatus[threadId].lastAction = '👀 Đang xem';

            for (let s = 0; s < watchSecs; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[threadId].elapsed++;
                stats.totalSeconds++;
                if (s % 60 === 0) {
                    stats.threadStatus[threadId].lastAction = '🖱️ Scroll';
                    await page.evaluate(() => window.scrollBy(0, 100));
                }
            }

            stats.totalViews++;
            stats.history.unshift({ title: currentTitle, proxy, time: new Date().toLocaleTimeString() });
            if (stats.history.length > 20) stats.history.pop();

            stats.threadStatus[threadId].lastAction = '⏭️ Next Video';
            const hasNext = await page.evaluate(() => {
                const n = document.querySelector('.ytp-next-button');
                if(n && window.getComputedStyle(n).display !== 'none') { n.click(); return true; }
                return false;
            });
            if (!hasNext) break;
        }

    } catch (err) {
        doLog(proxy, `❌ Lỗi: ${err.message.substring(0, 35)}`);
        blacklist[proxy] = true;
        fs.writeJsonSync(BLACKLIST_FILE, blacklist);
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        delete stats.threadStatus[threadId];
        stats.activeThreads--;
    }
}

async function main() {
    await scanPlaylist();
    while (true) {
        if (proxyList.length < 50) await fetchProxies();
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
            // Delay 4s để tránh "Requesting main frame too early"
            await new Promise(r => setTimeout(r, 4000)); 
        } else {
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

app.get('/', (req, res) => {
    const threadRows = Object.values(stats.threadStatus).map(t => `
        <tr style="border-bottom:1px solid #333">
            <td style="color:#0af; padding:10px">${t.proxy}</td>
            <td style="color:#fff"><b>[${t.iteration}]</b> ${t.title}</td>
            <td style="color:yellow; text-align:center">${t.elapsed}/${t.target}s</td>
            <td style="color:#0f0">${t.lastAction}</td>
        </tr>
    `).join('');

    res.send(`
        <body style="font-family:Consolas,sans-serif; background:#0d1117; color:#c9d1d9; padding:20px">
            <div style="display:flex; justify-content:space-between; align-items:center">
                <h1 style="color:#58a6ff; margin:0">🛰️ YT ULTIMATE V4</h1>
                <div style="text-align:right">
                    <b style="color:#3fb950; font-size:22px">VIEWS: ${stats.totalViews}</b> | 
                    <b style="color:#d29922; font-size:22px">WATCH: ${formatTime(stats.totalSeconds)}</b>
                </div>
            </div>
            <div style="display:flex; gap:10px; margin:20px 0">
                <div style="background:#161b22; padding:10px; border:1px solid #30363d">🔥 Luồng: ${stats.activeThreads}/${MAX_THREADS}</div>
                <div style="background:#161b22; padding:10px; border:1px solid #30363d">📦 Proxy: ${proxyList.length}</div>
                <div style="background:#161b22; padding:10px; border:1px solid #30363d; color:#f85149">💀 Blacklist: ${stats.blacklistedCount}</div>
            </div>
            <table style="width:100%; border-collapse:collapse; background:#161b22">
                <thead><tr style="background:#21262d; text-align:left"><th style="padding:15px">PROXY</th><th>VIDEO</th><th style="text-align:center">PROGRESS</th><th>ACTION</th></tr></thead>
                <tbody>${threadRows}</tbody>
            </table>
            <div style="margin-top:20px; background:#000; padding:15px; border:1px solid #30363d; height:150px; overflow:auto">
                <h4 style="color:#bc8cff; margin:0">📜 LỊCH SỬ</h4>
                <table style="width:100%; font-size:11px">${stats.history.map(h => `<tr><td style="color:#888">${h.time}</td><td style="color:#0af">${h.proxy}</td><td>${h.title}</td></tr>`).join('')}</table>
            </div>
            <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`DASHBOARD: http://localhost:1111`);
    main();
});
