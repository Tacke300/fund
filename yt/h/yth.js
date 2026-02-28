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
const MAX_CONCURRENT_THREADS = 10; 
const BLACKLIST_FILE = './blacklist_proxy.json';

let stats = { totalViews: 0, activeThreads: 0, proxyStatus: "Khởi động", logs: [], blacklistedCount: 0 };
let proxyList = [];
let blacklist = {};

// Load danh sách đen từ file
if (fs.existsSync(BLACKLIST_FILE)) {
    blacklist = fs.readJsonSync(BLACKLIST_FILE);
    stats.blacklistedCount = Object.keys(blacklist).length;
}

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    stats.logs.unshift(`[${time}] ${msg}`);
    if (stats.logs.length > 50) stats.logs.pop();
    console.log(`[${time}] ${msg}`);
}

async function saveBlacklist() {
    await fs.writeJson(BLACKLIST_FILE, blacklist);
    stats.blacklistedCount = Object.keys(blacklist).length;
}

// 1. Hàm nạp Proxy khổng lồ từ nhiều nguồn
async function fetchProxies() {
    addLog("🚀 Đang càn quét hàng chục nghìn Proxy...");
    const apis = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt'
    ];

    let allFound = [];
    for (let api of apis) {
        try {
            const res = await axios.get(api, { timeout: 15000 });
            const lines = res.data.split('\n').map(p => p.trim());
            allFound = allFound.concat(lines);
        } catch (e) {}
    }

    // Lọc bỏ proxy trong blacklist và định dạng sai
    proxyList = allFound.filter(p => {
        return p.includes(':') && !blacklist[p];
    });

    stats.proxyStatus = `Nạp mới ${proxyList.length} Proxy sạch.`;
    addLog(`✅ Đã nạp ${proxyList.length} Proxy (Đã loại bỏ ${allFound.length - proxyList.length} cái lỗi).`);
}

// 2. Worker 10 luồng (Tối ưu RAM kịch trần)
async function runWorker(proxy) {
    stats.activeThreads++;
    const userAgent = new UserAgents({ deviceCategory: 'desktop' }).toString();
    let browser;

    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox', '--disable-setuid-sandbox', '--mute-audio',
                '--disable-gpu', '--disable-dev-shm-usage',
                '--js-flags="--max-old-space-size=128"', // Giới hạn RAM cho mỗi tab
                `--proxy-server=http://${proxy}`
            ]
        });

        const page = await browser.newPage();
        await page.setUserAgent(userAgent);
        await page.setDefaultNavigationTimeout(20000); // 20s không xong là cook

        // Chặn load mọi thứ trừ script cần để chạy video
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'stylesheet', 'other'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.goto(PLAYLIST_URL, { waitUntil: 'domcontentloaded' });
        
        // Giả lập click Play
        await page.evaluate(() => {
            const btn = document.querySelector('a.ytd-playlist-thumbnail') || document.querySelector('video');
            if (btn) btn.click();
        });

        stats.totalViews++;
        addLog(`🔥 NGON! [${proxy}] đang cày view.`);
        
        // Xem ngẫu nhiên 1-2 phút (Xoay luồng nhanh để tận dụng Proxy)
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 60000) + 60000));

    } catch (err) {
        // Proxy lỗi -> Cho vào danh sách đen
        if (!blacklist[proxy]) {
            blacklist[proxy] = true;
            if (stats.blacklistedCount % 50 === 0) saveBlacklist(); // Lưu file mỗi 50 Proxy lỗi
        }
    } finally {
        if (browser) await browser.close();
        stats.activeThreads--;
    }
}

// 3. Vòng lặp quản lý luồng
async function main() {
    while (true) {
        if (proxyList.length < 50) await fetchProxies();

        while (stats.activeThreads < MAX_CONCURRENT_THREADS && proxyList.length > 0) {
            const p = proxyList.shift();
            runWorker(p);
            await new Promise(r => setTimeout(r, 1000)); // Delay tránh nghẽn CPU khi mở trình duyệt
        }
        await new Promise(r => setTimeout(r, 3000));
    }
}

// 4. Dashboard xịn
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:Consolas; background:#000; color:#0f0; padding:20px">
            <h2 style="color:red">☢️ YT BEAST MODE: 10 THREADS</h2>
            <div style="background:#111; padding:15px; border:1px solid #0f0; display:flex; gap:30px">
                <div><b>Views:</b> <span style="color:#fff">${stats.totalViews}</span></div>
                <div><b>Active Threads:</b> <span style="color:#fff">${stats.activeThreads}/10</span></div>
                <div><b>Blacklist:</b> <span style="color:#fff">${stats.blacklistedCount}</span></div>
            </div>
            <p style="color:yellow">${stats.proxyStatus}</p>
            <div style="height:400px; overflow-y:auto; background:#000; padding:10px; font-size:11px; border:1px solid #333">
                ${stats.logs.map(l => `<div>${l}</div>`).join('')}
            </div>
            <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`DASHBOARD: http://localhost:1111`);
    main();
});
