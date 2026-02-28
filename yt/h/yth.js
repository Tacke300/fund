const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const express = require('express');
const axios = require('axios');
const UserAgents = require('user-agents');
const fs = require('fs-extra');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

// --- CẤU HÌNH ---
const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_CONCURRENT_THREADS = 20; 
const BLACKLIST_FILE = './blacklist_proxy.json';

let stats = { totalViews: 0, activeThreads: 0, logs: [], history: [], blacklistedCount: 0 };
let proxyList = [];
let blacklist = {};

if (fs.existsSync(BLACKLIST_FILE)) {
    blacklist = fs.readJsonSync(BLACKLIST_FILE);
    stats.blacklistedCount = Object.keys(blacklist).length;
}

// Hàm Log thông minh
function doLog(proxy, msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    // Log chi tiết ra Terminal
    console.log(`\x1b[36m[${time}]\x1b[0m \x1b[33m[${proxy}]\x1b[0m ${msg}`);
    
    // Log ngắn gọn cho HTML
    if (type === 'html' || type === 'success') {
        stats.logs.unshift(`[${time}] ${msg}`);
        if (stats.logs.length > 30) stats.logs.pop();
    }
}

async function saveBlacklist() {
    await fs.writeJson(BLACKLIST_FILE, blacklist);
    stats.blacklistedCount = Object.keys(blacklist).length;
}

async function fetchProxies() {
    doLog('SYSTEM', "--- ĐANG QUÉT NGUỒN PROXY KHỔNG LỒ ---");
    const apis = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/https.txt'
    ];
    let all = [];
    for (let api of apis) {
        try {
            const res = await axios.get(api, { timeout: 10000 });
            all = all.concat(res.data.split('\n').map(p => p.trim()));
        } catch (e) {}
    }
    proxyList = all.filter(p => p.includes(':') && !blacklist[p]);
    doLog('SYSTEM', `Đã nạp ${proxyList.length} proxy mới.`);
}

async function runWorker(proxy) {
    stats.activeThreads++;
    const userAgent = new UserAgents({ deviceCategory: 'desktop' }).toString();
    let browser;

    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--mute-audio', '--disable-gpu', `--proxy-server=http://${proxy}`]
        });

        const page = await browser.newPage();
        await page.setUserAgent(userAgent);
        await page.setDefaultNavigationTimeout(30000);

        doLog(proxy, "Đang nạp Playlist...");
        await page.goto(PLAYLIST_URL, { waitUntil: 'domcontentloaded' });

        // Tìm số lượng video trong playlist
        const playlistSize = await page.evaluate(() => {
            const list = document.querySelectorAll('a.ytd-playlist-thumbnail, #playlist-items');
            return list.length || 5; // Mặc định thử 5 video nếu ko đếm được
        });

        doLog(proxy, `Bắt đầu Marathon Playlist (${playlistSize} video)...`);

        for (let i = 0; i < playlistSize; i++) {
            doLog(proxy, `Đang xử lý video thứ ${i + 1}/${playlistSize}...`);
            
            await page.evaluate(() => {
                const playBtn = document.querySelector('a.ytd-playlist-thumbnail') || document.querySelector('video');
                if (playBtn) playBtn.click();
                // Ép 144p
                const s = document.querySelector('.ytp-settings-button');
                if(s) s.click();
            });

            await new Promise(r => setTimeout(r, 5000)); // Chờ load
            const videoTitle = await page.title();
            const watchSecs = Math.floor(Math.random() * 120) + 120; // Xem 2-4 phút mỗi vid

            doLog(proxy, `Đang xem: "${videoTitle}" trong ${watchSecs} giây...`);
            
            // Cập nhật thống kê cho HTML
            const historyEntry = { title: videoTitle, proxy: proxy, time: `${(watchSecs/60).toFixed(1)}m` };
            stats.history.unshift(historyEntry);
            if (stats.history.length > 10) stats.history.pop();

            await new Promise(r => setTimeout(r, watchSecs * 1000));
            
            stats.totalViews++;
            doLog(proxy, `Đã xong video ${i+1}. Bấm Next...`, 'html');

            // Bấm Next sang bài tiếp theo
            const hasNext = await page.evaluate(() => {
                const next = document.querySelector('.ytp-next-button');
                if (next && window.getComputedStyle(next).display !== 'none') {
                    next.click();
                    return true;
                }
                return false;
            });

            if (!hasNext) {
                doLog(proxy, "Hết Playlist hoặc không tìm thấy nút Next. Kết thúc sớm.");
                break;
            }
        }

        doLog(proxy, "✅ HOÀN THÀNH TOÀN BỘ PLAYLIST. ĐỔI PROXY...", 'success');

    } catch (err) {
        doLog(proxy, `❌ Lỗi: ${err.message}`);
        blacklist[proxy] = true;
        saveBlacklist();
    } finally {
        if (browser) await browser.close();
        stats.activeThreads--;
    }
}

async function main() {
    while (true) {
        if (proxyList.length < 20) await fetchProxies();
        if (stats.activeThreads < MAX_CONCURRENT_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
        }
        await new Promise(r => setTimeout(r, 5000));
    }
}

app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:Consolas; background:#000; color:#0f0; padding:20px">
            <h2 style="color:#ff00ea">📺 YT MARATHON DASHBOARD (10 THREADS)</h2>
            <div style="display:flex; gap:20px; margin-bottom:20px">
                <div style="border:1px solid #0f0; padding:10px">Views: ${stats.totalViews}</div>
                <div style="border:1px solid #0f0; padding:10px">Active: ${stats.activeThreads}</div>
                <div style="border:1px solid #0f0; padding:10px">Blacklist: ${stats.blacklistedCount}</div>
            </div>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px">
                <div>
                    <h3>Nhật ký xem chi tiết:</h3>
                    <div style="background:#111; padding:10px; font-size:12px; height:300px; overflow:auto">
                        ${stats.history.map(h => `<div style="margin-bottom:5px; color:#fff"><b>${h.time}</b> - ${h.title.substring(0,40)}... <br><small style="color:#888">${h.proxy}</small></div>`).join('')}
                    </div>
                </div>
                <div>
                    <h3>Trạng thái luồng:</h3>
                    <div style="background:#111; padding:10px; font-size:12px; height:300px; overflow:auto; color:#0f0">
                        ${stats.logs.map(l => `<div>${l}</div>`).join('')}
                    </div>
                </div>
            </div>
            <script>setTimeout(() => location.reload(), 5000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`\x1b[42m SUCCESS \x1b[0m Dashboard: http://localhost:${port}`);
    main();
});
