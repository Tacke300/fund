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
const VIDEO_TITLE = "Tên Video Của Ông"; // Nhập tên video chính xác để Bot tìm trên Google/YT
const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 10;
const BLACKLIST_FILE = './blacklist_proxy.json';

let stats = { totalViews: 0, activeThreads: 0, logs: [], history: [], blacklistedCount: 0 };
let proxyList = [];
let blacklist = fs.existsSync(BLACKLIST_FILE) ? fs.readJsonSync(BLACKLIST_FILE) : {};

function doLog(proxy, msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    console.log(`\x1b[36m[${time}]\x1b[0m \x1b[33m[${proxy}]\x1b[0m ${msg}`);
    if (type === 'success' || type === 'html') {
        stats.logs.unshift(`[${time}] ${msg}`);
        if (stats.logs.length > 20) stats.logs.pop();
    }
}

async function fetchProxies() {
    doLog('SYSTEM', "🔄 Đang nạp 100k Proxy từ các nguồn quốc tế...");
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt'
    ];
    let all = [];
    for (let s of sources) {
        try { const res = await axios.get(s); all = all.concat(res.data.split('\n')); } catch(e){}
    }
    proxyList = all.map(p => p.trim()).filter(p => p.includes(':') && !blacklist[p]);
    stats.blacklistedCount = Object.keys(blacklist).length;
}

async function runWorker(proxy) {
    stats.activeThreads++;
    const threadId = Math.random().toString(36).substring(7);
    const userDataDir = path.join(__dirname, 'temp', `profile_${threadId}`);
    let browser;

    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: userDataDir,
            args: [`--proxy-server=http://${proxy}`, '--no-sandbox', '--mute-audio', '--window-size=1280,720']
        });

        const page = await browser.newPage();
        await page.setUserAgent(new UserAgents({ deviceCategory: 'desktop' }).toString());
        await page.setDefaultNavigationTimeout(60000);

        // BƯỚC 1: GIẢ LẬP SEARCH (Nguồn view uy tín nhất)
        doLog(proxy, "🔍 Đang vào Google để tìm video...");
        await page.goto('https://www.google.com', { waitUntil: 'networkidle2' });
        
        // Vượt rào Consent của Google
        await page.evaluate(() => {
            const b = Array.from(document.querySelectorAll('button')).find(x => /Accept|Agree|Chấp nhận/i.test(x.innerText));
            if (b) b.click();
        });
        await new Promise(r => setTimeout(r, 2000));

        // BƯỚC 2: VÀO PLAYLIST VÀ CÀY MARATHON
        doLog(proxy, "📺 Đang truy cập Playlist Marathon...");
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });

        // Tự động nhấn Play video đầu tiên
        await page.evaluate(() => {
            const play = document.querySelector('a.ytd-playlist-thumbnail') || document.querySelector('h3 a');
            if (play) play.click();
        });

        for (let i = 0; i < 10; i++) { // Xem tối đa 10 video mỗi Proxy
            await new Promise(r => setTimeout(r, 5000));
            const title = await page.title();
            if (title.includes("Before you") || title === "YouTube") throw new Error("Kẹt trang xác nhận");

            // HÀNH VI NGƯỜI THẬT
            doLog(proxy, `🎬 Đang xem: ${title.substring(0,30)}...`);
            
            // 1. Ngẫu nhiên cuộn trang
            await page.evaluate(() => window.scrollBy(0, Math.random() * 400));
            
            // 2. Ngẫu nhiên đổi tốc độ (giả lập người vội hoặc xem kỹ)
            await page.evaluate(() => {
                const v = document.querySelector('video');
                if(v) v.playbackRate = [1, 1.25, 1][Math.floor(Math.random()*3)];
            });

            const watchMs = (Math.floor(Math.random() * 120) + 180) * 1000; // Xem 3-5 phút
            await new Promise(r => setTimeout(r, watchMs));
            
            stats.totalViews++;
            stats.history.unshift({ title, proxy, time: new Date().toLocaleTimeString() });
            if (stats.history.length > 20) stats.history.pop();

            // Bấm Next sang video tiếp theo
            const hasNext = await page.evaluate(() => {
                const n = document.querySelector('.ytp-next-button');
                if(n && window.getComputedStyle(n).display !== 'none') { n.click(); return true; }
                return false;
            });

            if (!hasNext) break;
            doLog(proxy, "➡️ Chuyển tiếp video...", "html");
        }

    } catch (err) {
        doLog(proxy, `❌ Lỗi: ${err.message.substring(0, 40)}`);
        blacklist[proxy] = true;
        if (Object.keys(blacklist).length % 10 === 0) fs.writeJsonSync(BLACKLIST_FILE, blacklist);
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        stats.activeThreads--;
    }
}

async function main() {
    while (true) {
        if (proxyList.length < 20) await fetchProxies();
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
        }
        await new Promise(r => setTimeout(r, 4000));
    }
}

// Dashboard HTML (Giữ nguyên như bản trước nhưng thêm CSS đẹp hơn)
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:sans-serif; background:#0a0a0a; color:#eee; padding:20px">
            <h1 style="color:#ff0055">🔥 YT GOD MODE - 10 THREADS ACTIVE</h1>
            <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:10px; margin-bottom:20px">
                <div style="background:#1a1a1a; padding:15px; border-radius:8px">VIEWS: <span style="color:#0f0; font-size:24px">${stats.totalViews}</span></div>
                <div style="background:#1a1a1a; padding:15px; border-radius:8px">ACTIVE: <span style="color:#0af; font-size:24px">${stats.activeThreads}</span></div>
                <div style="background:#1a1a1a; padding:15px; border-radius:8px">DEAD PROXY: <span style="color:#f00; font-size:24px">${stats.blacklistedCount}</span></div>
            </div>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px">
                <div style="background:#111; padding:15px; height:400px; overflow:auto">
                    <h3 style="color:yellow">🎥 VIDEO HISTORY</h3>
                    ${stats.history.map(h => `<div style="font-size:12px; margin-bottom:10px; border-bottom:1px solid #222">[${h.time}] ${h.title}</div>`).join('')}
                </div>
                <div style="background:#111; padding:15px; height:400px; overflow:auto">
                    <h3 style="color:#0f0">⚡ SYSTEM LOGS</h3>
                    ${stats.logs.map(l => `<div style="font-size:11px">${l}</div>`).join('')}
                </div>
            </div>
            <script>setTimeout(() => location.reload(), 5000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`DASHBOARD: http://localhost:1111`);
    main();
});
