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
const BLACKLIST_FILE = './blacklist_proxy.json';
const GOOD_PROXIES_FILE = './good_proxies.json';
const COOKIE_FILE = './youtube_cookies.json';

// XÓA BLACKLIST KHI KHỞI ĐỘNG BOT
if (fs.existsSync(BLACKLIST_FILE)) {
    fs.writeJsonSync(BLACKLIST_FILE, {});
    console.log("--- ĐÃ LÀM SẠCH BLACKLIST ĐỂ BẮT ĐẦU PHIÊN MỚI ---");
}

let stats = {
    totalViews: 0, totalSeconds: 0, activeThreads: 0,
    proxiesScraped: 0, proxiesSuccess: 0, proxiesFailed: 0,
    proxyReady: 0, sourcesDetail: [], threadStatus: {}, logs: []
};

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    stats.logs.unshift(`[${time}] ${msg}`);
    if (stats.logs.length > 100) stats.logs.pop();
    console.log(`[${time}] ${msg}`);
}

let proxyList = [];
let blacklist = {};
let goodProxies = fs.existsSync(GOOD_PROXIES_FILE) ? fs.readJsonSync(GOOD_PROXIES_FILE) : [];

// --- HÀM QUÉT X10 NGUỒN PROXY ---
async function fetchProxies() {
    addLog("🚀 Đang càn quét x10 nguồn Proxy (GitHub, API, Raw)...");
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/muhammadrizki16/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
        'https://proxyspace.pro/http.txt',
        'https://raw.githubusercontent.com/Anonym0usWork12/proxy-list/master/proxy-list.txt',
        'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
        'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt',
        'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
        'https://raw.githubusercontent.com/opsxcq/proxy-list/master/list.txt',
        'https://raw.githubusercontent.com/Zaeem20/proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/prx77/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/http.txt'
    ];

    let allRaw = [];
    stats.sourcesDetail = [];

    for (let s of sources) {
        try {
            const res = await axios.get(s, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
            const found = res.data.split('\n').map(p => p.trim()).filter(p => p.includes(':') && /^\d/.test(p));
            allRaw = allRaw.concat(found);
            stats.sourcesDetail.push({ name: s.split('/')[2], count: found.length });
        } catch(e) {
            stats.sourcesDetail.push({ name: s.split('/')[2], count: 'Lỗi' });
        }
    }

    const unique = [...new Set(allRaw)];
    proxyList = unique.filter(p => !blacklist[p]);
    stats.proxiesScraped = unique.length;
    stats.proxyReady = proxyList.length;
    addLog(`Tổng quét: ${unique.length} | Lọc trùng & Blacklist còn: ${proxyList.length}`);
}

async function runWorker(proxy) {
    stats.activeThreads++;
    const id = Math.random().toString(36).substring(7).toUpperCase();
    const userDataDir = path.join(__dirname, 'temp', `profile_${id}`);
    stats.threadStatus[id] = { proxy, title: 'Đang kết nối...', elapsed: 0, target: 0, lastAction: '🚀 Khởi tạo', iteration: 0 };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: userDataDir,
            args: [`--proxy-server=http://${proxy}`, '--no-sandbox', '--disable-setuid-sandbox', '--mute-audio']
        });

        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(45000);
        
        if (fs.existsSync(COOKIE_FILE)) {
            const cookies = await fs.readJson(COOKIE_FILE);
            await page.setCookie(...cookies);
        }

        stats.threadStatus[id].lastAction = '🌍 Mở YouTube...';
        const resp = await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
        
        if (!resp || resp.status() >= 400) {
            proxyList.push(proxy); // Đưa lại vào hàng chờ nếu lỗi kết nối
            throw new Error("Proxy yếu/lỗi mạng");
        }

        // Tự động nhấn Accept
        await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button, span')).find(b => 
                ['Accept', 'Agree', 'Chấp nhận', 'Đồng ý', 'I agree'].some(k => b.innerText && b.innerText.includes(k)));
            if (btn) btn.click();
        });
        await new Promise(r => setTimeout(r, 4000));

        // Click Play
        const play = await page.evaluate(() => {
            const b = document.querySelector('a.ytd-playlist-thumbnail') || document.querySelector('#video-title');
            if (b) { b.click(); return true; }
            return false;
        });
        if (!play) throw new Error("Không thấy video");

        let videoIdx = 0;
        while (true) {
            videoIdx++;
            await new Promise(r => setTimeout(r, 8000));
            const title = await page.title();
            if (title.includes("Captcha") || title.includes("robot")) throw new Error("Bị chặn Captcha");

            const watchTime = Math.floor(Math.random() * 60) + 180;
            stats.threadStatus[id].title = title;
            stats.threadStatus[id].target = watchTime;
            stats.threadStatus[id].iteration = videoIdx;
            stats.threadStatus[id].lastAction = '👀 Đang xem';

            for (let s = 1; s <= watchTime; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[id].elapsed = s;
                stats.totalSeconds++;
            }

            stats.totalViews++;
            stats.proxiesSuccess++;

            const hasNext = await page.evaluate(() => {
                const n = document.querySelector('.ytp-next-button');
                if (n && window.getComputedStyle(n).display !== 'none') { n.click(); return true; }
                return false;
            });

            if (!hasNext) break; // Xem hết playlist thì đổi proxy
        }

    } catch (err) {
        if (err.message.includes("Captcha") || err.message.includes("403")) {
            blacklist[proxy] = true;
            fs.writeJsonSync(BLACKLIST_FILE, blacklist);
        }
        stats.proxiesFailed++;
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        delete stats.threadStatus[id];
        stats.activeThreads--;
    }
}

async function main() {
    while (true) {
        if (proxyList.length < 50) await fetchProxies();
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
            await new Promise(r => setTimeout(r, 4000));
        } else {
            await new Promise(r => setTimeout(r, 10000));
        }
    }
}

app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:monospace; background:#0d1117; color:#c9d1d9; padding:20px;">
            <h2 style="color:#58a6ff">🛰️ YT BOT PRO MAX - ${stats.activeThreads}/${MAX_THREADS} THREADS</h2>
            
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px; margin-bottom:20px;">
                <div style="background:#161b22; padding:15px; border:1px solid #30363d;">
                    <b>THỐNG KÊ CHUNG</b><br>
                    Views: <span style="color:#3fb950; font-size:20px">${stats.totalViews}</span><br>
                    Time: ${Math.floor(stats.totalSeconds/60)} phút<br>
                    Proxy Sống: ${stats.proxiesSuccess} | Proxy Chết: ${stats.proxiesFailed}
                </div>
                <div style="background:#161b22; padding:15px; border:1px solid #30363d; overflow-y:auto; height:100px;">
                    <b>CHI TIẾT NGUỒN PROXY</b><br>
                    ${stats.sourcesDetail.map(s => `<small>${s.name}: ${s.count}</small>`).join(' | ')}
                </div>
            </div>

            <table border="1" style="width:100%; border-collapse:collapse; background:#161b22; border:1px solid #30363d;">
                <tr style="background:#21262d">
                    <th>ID</th><th>Proxy</th><th>Video Title</th><th>Progress</th><th>Action</th>
                </tr>
                ${Object.entries(stats.threadStatus).map(([id, t]) => `
                <tr>
                    <td align="center">${id}</td><td>${t.proxy}</td>
                    <td>[${t.iteration}] ${t.title.substring(0,35)}</td>
                    <td align="center">${t.elapsed}/${t.target}s</td>
                    <td align="center" style="color:#d29922">${t.lastAction}</td>
                </tr>`).join('')}
            </table>

            <br><b>LOG HỆ THỐNG</b>
            <div style="background:#000; color:#3fb950; padding:10px; height:200px; overflow-y:auto; font-size:11px; border:1px solid #30363d;">
                ${stats.logs.map(l => `<div>${l}</div>`).join('')}
            </div>
            <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`Bảng điều khiển: http://localhost:${port}`);
    main();
});
