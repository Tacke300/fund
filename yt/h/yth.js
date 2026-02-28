const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const express = require('express');
const axios = require('axios');
const UserAgents = require('user-agents');
const fs = require('fs-extra');
const path = require('path');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

// --- CẤU HÌNH ---
const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_CONCURRENT_THREADS = 10; 
const BLACKLIST_FILE = './blacklist_proxy.json';

let stats = { totalViews: 0, activeThreads: 0, logs: [], history: [], blacklistedCount: 0 };
let proxyList = [];
let blacklist = {};

if (fs.existsSync(BLACKLIST_FILE)) {
    blacklist = fs.readJsonSync(BLACKLIST_FILE);
    stats.blacklistedCount = Object.keys(blacklist).length;
}

function doLog(proxy, msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    // Terminal Log (Chi tiết)
    const color = type === 'success' ? '\x1b[42m' : '\x1b[36m';
    console.log(`${color}[${time}]\x1b[0m \x1b[33m[${proxy}]\x1b[0m ${msg}`);
    
    // Dashboard Log (Gọn)
    if (type === 'html' || type === 'success') {
        stats.logs.unshift(`[${time}] ${msg}`);
        if (stats.logs.length > 20) stats.logs.pop();
    }
}

async function fetchProxies() {
    doLog('SYSTEM', "--- ĐANG NẠP KHO PROXY MỚI ---");
    const apis = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/https.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt'
    ];
    let all = [];
    for (let api of apis) {
        try {
            const res = await axios.get(api, { timeout: 10000 });
            all = all.concat(res.data.split('\n').map(p => p.trim()));
        } catch (e) {}
    }
    proxyList = all.filter(p => p.includes(':') && !blacklist[p]);
    doLog('SYSTEM', `Đã lọc được ${proxyList.length} proxy sạch.`);
}

async function runWorker(proxy) {
    stats.activeThreads++;
    const userAgent = new UserAgents({ deviceCategory: 'desktop' }).toString();
    const threadId = Math.random().toString(36).substring(7);
    const userDataDir = path.join(__dirname, 'temp', `profile_${threadId}`); // Profile riêng tránh lỗi kẹt luồng
    let browser;

    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: userDataDir,
            args: [
                '--no-sandbox', '--mute-audio', '--disable-gpu',
                `--proxy-server=http://${proxy}`,
                '--window-size=1280,720'
            ]
        });

        const page = await browser.newPage();
        await page.setUserAgent(userAgent);
        await page.setDefaultNavigationTimeout(40000);

        doLog(proxy, "Mở Playlist & Vượt rào Consent...");
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });

        // Tự động nhấn Accept/Agree nếu gặp bảng điều khoản
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, span'));
            const accept = btns.find(b => /Accept all|Agree|I agree|Chấp nhận|Tôi đồng ý/i.test(b.innerText));
            if (accept) accept.click();
        });
        await new Promise(r => setTimeout(r, 3000));

        // Click vào video đầu tiên để bắt đầu cày
        await page.evaluate(() => {
            const firstVid = document.querySelector('a.ytd-playlist-thumbnail') || document.querySelector('#video-title');
            if (firstVid) firstVid.click();
        });

        await new Promise(r => setTimeout(r, 5000));
        
        // Loop xem toàn bộ Playlist
        for (let i = 0; i < 50; i++) { // Giới hạn tối đa 50 video/playlist
            const title = await page.title();
            if (title.includes("Before you") || title === "YouTube") {
                throw new Error("Bị kẹt tại trang xác nhận");
            }

            const watchTime = Math.floor(Math.random() * 120) + 180; // Xem 3-5 phút mỗi vid
            doLog(proxy, `🎬 Đang xem (${i+1}): ${title} trong ${watchTime}s`);
            
            stats.history.unshift({ title, proxy, time: new Date().toLocaleTimeString() });
            if (stats.history.length > 15) stats.history.pop();

            await new Promise(r => setTimeout(r, watchTime * 1000));
            stats.totalViews++;

            // Bấm Next
            const hasNext = await page.evaluate(() => {
                const next = document.querySelector('.ytp-next-button');
                if (next && window.getComputedStyle(next).display !== 'none') {
                    next.click();
                    return true;
                }
                return false;
            });

            if (!hasNext) {
                doLog(proxy, "Hết Playlist. Hoàn thành!");
                break;
            }
            doLog(proxy, `Chuyển sang video tiếp theo...`, 'html');
            await new Promise(r => setTimeout(r, 5000));
        }

    } catch (err) {
        doLog(proxy, `❌ Lỗi: ${err.message.substring(0, 50)}`);
        if (!blacklist[proxy]) {
            blacklist[proxy] = true;
            fs.writeJsonSync(BLACKLIST_FILE, blacklist);
            stats.blacklistedCount++;
        }
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir); // Dọn dẹp rác RAM
        stats.activeThreads--;
    }
}

async function main() {
    while (true) {
        if (proxyList.length < 20) await fetchProxies();
        if (stats.activeThreads < MAX_CONCURRENT_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
        }
        await new Promise(r => setTimeout(r, 3000));
    }
}

app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:Consolas; background:#000; color:#0f0; padding:20px; line-height:1.2">
            <h2 style="color:#ff00ea; border-bottom:1px solid #333">🚀 YT MARATHON V2 - 10 THREADS</h2>
            <div style="display:flex; gap:20px; margin-bottom:15px">
                <div style="border:1px solid #0f0; padding:10px">VIEWS: <span style="color:#fff">${stats.totalViews}</span></div>
                <div style="border:1px solid #0f0; padding:10px">ACTIVE: <span style="color:#fff">${stats.activeThreads}</span></div>
                <div style="border:1px solid #0f0; padding:10px">DEAD: <span style="color:#fff">${stats.blacklistedCount}</span></div>
            </div>
            <div style="display:grid; grid-template-columns: 1.2fr 0.8fr; gap:15px">
                <div>
                    <h3 style="color:yellow">🎥 LỊCH SỬ VIDEO (THẬT)</h3>
                    <div style="background:#111; padding:10px; height:350px; overflow:auto; border-left:3px solid yellow">
                        ${stats.history.map(h => `<div style="margin-bottom:8px; border-bottom:1px dashed #333; padding-bottom:5px">
                            <span style="color:#888">[${h.time}]</span> <span style="color:#0af">${h.title}</span><br>
                            <small style="color:#555">IP: ${h.proxy}</small>
                        </div>`).join('')}
                    </div>
                </div>
                <div>
                    <h3 style="color:#f0f">⚙️ LUỒNG HỆ THỐNG</h3>
                    <div style="background:#111; padding:10px; height:350px; overflow:auto; font-size:11px">
                        ${stats.logs.map(l => `<div style="color:#0f0">${l}</div>`).join('')}
                    </div>
                </div>
            </div>
            <script>setTimeout(() => location.reload(), 5000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`\x1b[42m SUCCESS \x1b[0m Dashboard: http://localhost:1111`);
    main();
});
