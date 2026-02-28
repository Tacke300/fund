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
const MAX_THREADS = 10;
const DATA_FILE = './playlist_data.json';
const BLACKLIST_FILE = './blacklist_proxy.json';

let stats = {
    totalViews: 0,
    totalSeconds: 0, // Dùng để tính giờ xem
    activeThreads: 0,
    blacklistedCount: 0,
    videoCount: 0,
    threadStatus: {}, // Lưu trạng thái chi tiết từng luồng
    history: []
};

let proxyList = [];
let videoTitles = [];
let blacklist = fs.existsSync(BLACKLIST_FILE) ? fs.readJsonSync(BLACKLIST_FILE) : {};

// Hàm định dạng thời gian (Giây -> Giờ:Phút:Giây)
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
        doLog('SYSTEM', `✅ Đã lưu ${videoTitles.length} video vào bộ nhớ.`);
    } catch (e) { doLog('SYSTEM', "❌ Lỗi quét Playlist"); }
    await browser.close();
}

async function fetchProxies() {
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt'
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
    
    // Khởi tạo trạng thái luồng trong bảng
    stats.threadStatus[threadId] = { proxy, title: 'Đang khởi động...', elapsed: 0, status: '🚀 Khởi tạo' };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: userDataDir,
            args: [`--proxy-server=http://${proxy}`, '--no-sandbox', '--mute-audio']
        });

        const page = await browser.newPage();
        await page.setUserAgent(new UserAgents({ deviceCategory: 'desktop' }).toString());

        // Vào playlist
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
        await page.evaluate(() => document.querySelector('a.ytd-playlist-thumbnail')?.click());

        for (let i = 0; i < 20; i++) { // Marathon tối đa 20 vid
            await new Promise(r => setTimeout(r, 5000));
            const currentTitle = await page.title();
            const watchSecs = Math.floor(Math.random() * 120) + 180; // 3-5 phút

            // Cập nhật bảng Dashboard
            stats.threadStatus[threadId].title = currentTitle.replace("- YouTube", "");
            stats.threadStatus[threadId].status = `🔥 Đang xem (${i+1})`;
            stats.threadStatus[threadId].elapsed = 0;

            doLog(proxy, `🎬 [${i+1}] Đang xem: ${currentTitle}`);

            // Chạy bộ đếm giây cho Dashboard
            for (let s = 0; s < watchSecs; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[threadId].elapsed++;
                stats.totalSeconds++; // Cộng dồn vào tổng giờ xem toàn bot
                
                // Giả lập scroll mỗi 30s
                if (s % 30 === 0) await page.evaluate(() => window.scrollBy(0, 100));
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
        doLog(proxy, `❌ Lỗi: ${err.message.substring(0, 20)}`);
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
        if (proxyList.length < 20) await fetchProxies();
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
        }
        await new Promise(r => setTimeout(r, 5000));
    }
}

// --- DASHBOARD GIAO DIỆN QUẢN LÝ ---
app.get('/', (req, res) => {
    const threadRows = Object.values(stats.threadStatus).map(t => `
        <tr>
            <td style="color:#0af">${t.proxy}</td>
            <td style="color:#fff">${t.title.substring(0,40)}...</td>
            <td style="color:yellow">${t.elapsed}s</td>
            <td style="color:#0f0">${t.status}</td>
        </tr>
    `).join('');

    res.send(`
        <body style="font-family:Segoe UI,sans-serif; background:#0d1117; color:#c9d1d9; padding:20px">
            <h1 style="color:#58a6ff; text-align:center">🚀 YT BOT - QUẢN LÝ TỔNG THỂ</h1>
            
            <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:15px; margin-bottom:25px">
                <div style="background:#161b22; padding:15px; border-radius:10px; border:1px solid #30363d">
                    <small>TỔNG LƯỢT XEM</small><br><b style="font-size:24px; color:#3fb950">${stats.totalViews}</b>
                </div>
                <div style="background:#161b22; padding:15px; border-radius:10px; border:1px solid #30363d">
                    <small>TỔNG GIỜ XEM</small><br><b style="font-size:24px; color:#d29922">${formatTime(stats.totalSeconds)}</b>
                </div>
                <div style="background:#161b22; padding:15px; border-radius:10px; border:1px solid #30363d">
                    <small>LUỒNG ĐANG CHẠY</small><br><b style="font-size:24px; color:#58a6ff">${stats.activeThreads}/10</b>
                </div>
                <div style="background:#161b22; padding:15px; border-radius:10px; border:1px solid #30363d">
                    <small>VIDEO TRONG LIST</small><br><b style="font-size:24px; color:#bc8cff">${stats.videoCount}</b>
                </div>
            </div>

            <h3 style="color:#8b949e">⚡ TRẠNG THÁI CÁC LUỒNG REAL-TIME</h3>
            <table style="width:100%; border-collapse:collapse; background:#161b22; border-radius:10px; overflow:hidden">
                <thead>
                    <tr style="background:#21262d; text-align:left">
                        <th style="padding:12px">IP PROXY</th>
                        <th>VIDEO ĐANG XEM</th>
                        <th>ĐÃ XEM</th>
                        <th>TRẠNG THÁI</th>
                    </tr>
                </thead>
                <tbody>${threadRows}</tbody>
            </table>

            <div style="margin-top:25px; display:grid; grid-template-columns: 1fr 1fr; gap:20px">
                <div style="background:#0a0a0a; padding:15px; height:250px; overflow:auto; border:1px solid #30363d">
                    <h4 style="color:yellow; margin-top:0">🕒 LỊCH SỬ VỪA HOÀN THÀNH</h4>
                    ${stats.history.map(h => `<div style="font-size:12px; margin-bottom:5px; border-bottom:1px solid #222; padding-bottom:3px">${h.time} - ${h.title}</div>`).join('')}
                </div>
                <div style="background:#0a0a0a; padding:15px; height:250px; overflow:auto; border:1px solid #30363d">
                    <h4 style="color:#f85149; margin-top:0">🚫 BLACKLIST (PROXIES CHẾT)</h4>
                    <div style="font-size:12px">Tổng cộng: ${stats.blacklistedCount} IP đã bị loại bỏ.</div>
                </div>
            </div>

            <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`DASHBOARD: http://localhost:1111`);
    main();
});
