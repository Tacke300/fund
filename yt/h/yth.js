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
const MAX_THREADS = 20; // ĐÃ TĂNG LÊN 20 THEO Ý ÔNG
const DATA_FILE = './playlist_data.json';
const BLACKLIST_FILE = './blacklist_proxy.json';

let stats = {
    totalViews: 0,
    totalSeconds: 0,
    activeThreads: 0,
    blacklistedCount: 0,
    videoCount: 0,
    threadStatus: {},
    history: []
};

let proxyList = [];
let videoTitles = [];
let blacklist = fs.existsSync(BLACKLIST_FILE) ? fs.readJsonSync(BLACKLIST_FILE) : {};

function formatTime(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${h}h ${m}m ${s}s`;
}

function doLog(proxy, msg) {
    const time = new Date().toLocaleTimeString();
    console.log(`\x1b[36m[${time}]\x1b[0m \x1b[33m[${proxy}]\x1b[0m ${msg}`);
}

async function scanPlaylist() {
    doLog('SYSTEM', "🔍 Đang trinh sát Playlist...");
    const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
    const page = await browser.newPage();
    try {
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
        videoTitles = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('#video-title')).map(el => el.innerText.trim()).filter(t => t !== "");
        });
        stats.videoCount = videoTitles.length;
        fs.writeJsonSync(DATA_FILE, videoTitles);
        doLog('SYSTEM', `✅ Đã lưu ${videoTitles.length} video.`);
    } catch (e) { doLog('SYSTEM', "❌ Lỗi quét Playlist"); }
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
    proxyList = all.map(p => p.trim()).filter(p => p.includes(':') && !blacklist[p]);
    stats.blacklistedCount = Object.keys(blacklist).length;
}

async function runWorker(proxy) {
    stats.activeThreads++;
    const threadId = Math.random().toString(36).substring(7);
    const userDataDir = path.join(__dirname, 'temp', `profile_${threadId}`);
    stats.threadStatus[threadId] = { proxy, title: 'Khởi tạo...', elapsed: 0, status: '🚀 Kết nối' };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: userDataDir,
            args: [`--proxy-server=http://${proxy}`, '--no-sandbox', '--mute-audio', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        await page.setUserAgent(new UserAgents({ deviceCategory: 'desktop' }).toString());
        await page.setDefaultNavigationTimeout(45000);

        // Bước 1: Vào link Playlist
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });

        // --- HÀM VƯỢT RÀO CONSENT (THÊM LẠI) ---
        await page.evaluate(async () => {
            const clickBtn = (txt) => {
                const btns = Array.from(document.querySelectorAll('button, span, div'));
                const found = btns.find(b => new RegExp(txt, 'i').test(b.innerText));
                if (found) found.click();
            };
            clickBtn('Accept all'); clickBtn('I agree'); clickBtn('Chấp nhận'); clickBtn('Tôi đồng ý');
        });
        await new Promise(r => setTimeout(r, 3000));

        // Click Play video đầu tiên
        await page.evaluate(() => {
            const playBtn = document.querySelector('a.ytd-playlist-thumbnail') || document.querySelector('#video-title');
            if (playBtn) playBtn.click();
        });

        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 5000));
            let currentTitle = await page.title();
            
            // Nếu vẫn dính "Before you continue", thử ép click lần nữa
            if (currentTitle.includes("Before you")) {
                await page.evaluate(() => {
                    const b = Array.from(document.querySelectorAll('button')).find(x => /Accept|Agree|Chấp nhận/i.test(x.innerText));
                    if (b) b.click();
                });
                await new Promise(r => setTimeout(r, 4000));
                currentTitle = await page.title();
            }

            if (currentTitle.includes("Before you") || currentTitle === "YouTube") throw new Error("Kẹt Consent");

            const watchSecs = Math.floor(Math.random() * 120) + 180; 
            stats.threadStatus[threadId].title = currentTitle.replace("- YouTube", "");
            stats.threadStatus[threadId].status = `🔥 Đang xem (${i+1})`;
            stats.threadStatus[threadId].elapsed = 0;

            doLog(proxy, `🎬 [${i+1}] ${currentTitle}`);

            for (let s = 0; s < watchSecs; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[threadId].elapsed++;
                stats.totalSeconds++;
                if (s % 40 === 0) await page.evaluate(() => window.scrollBy(0, 150));
            }

            stats.totalViews++;
            stats.history.unshift({ title: currentTitle, proxy, time: new Date().toLocaleTimeString() });
            if (stats.history.length > 10) stats.history.pop();

            // Next video
            const hasNext = await page.evaluate(() => {
                const n = document.querySelector('.ytp-next-button');
                if(n && window.getComputedStyle(n).display !== 'none') { n.click(); return true; }
                return false;
            });
            if (!hasNext) break;
        }

    } catch (err) {
        doLog(proxy, `❌ Lỗi: ${err.message.substring(0, 25)}`);
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
        // CHẠY TỐI ĐA 20 LUỒNG
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
        }
        await new Promise(r => setTimeout(r, 2000)); // Giảm delay xuống 2s để nhồi luồng nhanh hơn
    }
}

// DASHBOARD (Giữ nguyên giao diện Manager)
app.get('/', (req, res) => {
    const threadRows = Object.values(stats.threadStatus).map(t => `
        <tr>
            <td style="color:#0af; font-size:12px">${t.proxy}</td>
            <td style="color:#fff; font-size:12px">${t.title.substring(0,35)}...</td>
            <td style="color:yellow">${t.elapsed}s</td>
            <td style="color:#0f0; font-size:12px">${t.status}</td>
        </tr>
    `).join('');

    res.send(`
        <body style="font-family:Consolas,sans-serif; background:#0d1117; color:#c9d1d9; padding:20px">
            <h1 style="color:#58a6ff; text-align:center">🚀 YT BOT - SUPER 20 THREADS</h1>
            
            <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:15px; margin-bottom:20px">
                <div style="background:#161b22; padding:15px; border-radius:10px; border:1px solid #30363d">
                    <small>TỔNG LƯỢT XEM</small><br><b style="font-size:24px; color:#3fb950">${stats.totalViews}</b>
                </div>
                <div style="background:#161b22; padding:15px; border-radius:10px; border:1px solid #30363d">
                    <small>TỔNG GIỜ XEM</small><br><b style="font-size:24px; color:#d29922">${formatTime(stats.totalSeconds)}</b>
                </div>
                <div style="background:#161b22; padding:15px; border-radius:10px; border:1px solid #30363d">
                    <small>LUỒNG ĐANG CHẠY</small><br><b style="font-size:24px; color:#58a6ff">${stats.activeThreads}/20</b>
                </div>
                <div style="background:#161b22; padding:15px; border-radius:10px; border:1px solid #30363d">
                    <small>BLACKLIST</small><br><b style="font-size:24px; color:#f85149">${stats.blacklistedCount}</b>
                </div>
            </div>

            <table style="width:100%; border-collapse:collapse; background:#161b22; border-radius:10px">
                <thead><tr style="background:#21262d; text-align:left"><th style="padding:10px">PROXY</th><th>VIDEO</th><th>TIME</th><th>STATUS</th></tr></thead>
                <tbody>${threadRows}</tbody>
            </table>
            <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`DASHBOARD: http://localhost:1111`);
    main();
});
