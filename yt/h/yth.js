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

// --- FILE LƯU TRỮ ---
const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 15; 
const BLACKLIST_FILE = './blacklist_proxy.json';
const GOOD_PROXIES_FILE = './good_proxies.json'; 
const COOKIE_FILE = './cookies.json'; // File lưu cookie tập trung
const ERROR_DIR = './errors';

if (!fs.existsSync(ERROR_DIR)) fs.mkdirSync(ERROR_DIR);

let stats = {
    totalViews: 0, totalSeconds: 0, activeThreads: 0,
    blacklistedCount: 0, goodCount: 0, proxyReady: 0, threadStatus: {}, history: []
};

let proxyList = [];
let blacklist = fs.existsSync(BLACKLIST_FILE) ? fs.readJsonSync(BLACKLIST_FILE) : {};
let goodProxies = fs.existsSync(GOOD_PROXIES_FILE) ? fs.readJsonSync(GOOD_PROXIES_FILE) : [];

function formatTime(s) {
    const h = Math.floor(s/3600);
    const m = Math.floor((s%3600)/60);
    return `${h}h ${m}m ${s%60}s`;
}

function saveGoodProxy(proxy) {
    if (!goodProxies.includes(proxy)) {
        goodProxies.push(proxy);
        if (goodProxies.length > 2000) goodProxies.shift(); 
        fs.writeJsonSync(GOOD_PROXIES_FILE, goodProxies);
        stats.goodCount = goodProxies.length;
    }
}

async function fetchProxies() {
    console.log("🔄 Đang quét hàng loạt nguồn Proxy mới...");
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/muhammadrizki16/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
        'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
        'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt',
        'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
        'https://raw.githubusercontent.com/opsxcq/proxy-list/master/list.txt',
        'https://proxyspace.pro/http.txt',
        'https://raw.githubusercontent.com/Zaeem20/proxy-list/master/http.txt'
    ];

    let all = [];
    for (let s of sources) {
        try { 
            const res = await axios.get(s, { timeout: 5000 }); 
            all = all.concat(res.data.split('\n')); 
        } catch(e) { console.log(`⚠️ Nguồn lỗi: ${s.substring(0,30)}`); }
    }

    proxyList = [...new Set(all.map(p => p.trim()).filter(p => p.includes(':') && !blacklist[p]))];
    
    if (proxyList.length < 20 && goodProxies.length > 0) {
        console.log("🚨 CHẾ ĐỘ CẤP CỨU: Tái sử dụng Proxy ngon từ quá khứ!");
        proxyList = [...new Set([...proxyList, ...goodProxies])];
    }

    stats.proxyReady = proxyList.length;
    stats.blacklistedCount = Object.keys(blacklist).length;
    stats.goodCount = goodProxies.length;
}

// LOGIC CŨ CỦA ÔNG - CHỈ THÊM NẠP COOKIE
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
                '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio'
            ]
        });

        const page = await browser.newPage();
        await page.setUserAgent(new UserAgents({ deviceCategory: 'desktop' }).toString());
        await page.setDefaultNavigationTimeout(50000);

        // --- MỚI: NẠP COOKIE NẾU CÓ ---
        if (fs.existsSync(COOKIE_FILE)) {
            const cookies = await fs.readJson(COOKIE_FILE);
            await page.setCookie(...cookies);
        }

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'stylesheet'].includes(req.resourceType()) && !req.url().includes('youtube')) req.abort();
            else req.continue();
        });

        stats.threadStatus[threadId].lastAction = '🌍 Vào YT...';
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });

        await page.evaluate(async () => {
            const keys = ['Accept', 'Agree', 'Chấp nhận', 'Đồng ý', 'Ich stimme', 'Tout accepter', 'Aceptar', 'Alle'];
            const btns = Array.from(document.querySelectorAll('button, span, div'));
            const t = btns.find(b => keys.some(k => b.innerText && b.innerText.includes(k)));
            if (t) t.click();
        });
        await new Promise(r => setTimeout(r, 4000));

        await page.evaluate(() => {
            const btn = document.querySelector('a.ytd-playlist-thumbnail') || document.querySelector('#video-title');
            if (btn) btn.click();
        });

        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 6000));
            let currentTitle = await page.title();
            if (currentTitle.includes("Before you") || currentTitle === "YouTube") throw new Error("Kẹt màn hình chào");
            if (i === 0) saveGoodProxy(proxy);

            const watchSecs = Math.floor(Math.random() * 50) + 180; 
            stats.threadStatus[threadId].title = currentTitle.replace("- YouTube", "");
            stats.threadStatus[threadId].iteration = i + 1;
            stats.threadStatus[threadId].target = watchSecs;
            stats.threadStatus[threadId].elapsed = 0;
            stats.threadStatus[threadId].lastAction = '👀 Cày view';

            for (let s = 0; s < watchSecs; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[threadId].elapsed++;
                stats.totalSeconds++;
            }

            stats.totalViews++;
            stats.history.unshift({ title: currentTitle, proxy, time: new Date().toLocaleTimeString() });
            if (stats.history.length > 20) stats.history.pop();

            const hasNext = await page.evaluate(() => {
                const n = document.querySelector('.ytp-next-button');
                if(n && window.getComputedStyle(n).display !== 'none') { n.click(); return true; }
                return false;
            });
            if (!hasNext) break;
        }

    } catch (err) {
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
    while (true) {
        if (proxyList.length < 50) await fetchProxies();
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
            await new Promise(r => setTimeout(r, 4000)); 
        } else {
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

// --- MỚI: ROUTE ĐỂ ÔNG ĐĂNG NHẬP LẤY COOKIE ---
app.get('/login', async (req, res) => {
    res.send('<h3>Đang mở trình duyệt đăng nhập trên máy chủ... Hãy quay lại terminal hoặc xem màn hình.</h3>');
    console.log("🚀 Đang mở trình duyệt để ông đăng nhập YouTube...");
    const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto('https://accounts.google.com/ServiceLogin?service=youtube');
    
    // Đợi ông đăng nhập xong (đến khi vào youtube)
    try {
        await page.waitForFunction(() => window.location.href.includes('youtube.com'), { timeout: 120000 });
        const cookies = await page.cookies();
        await fs.writeJson(COOKIE_FILE, cookies);
        console.log("✅ Đã lưu cookie thành công!");
    } catch (e) { console.log("❌ Quá thời gian đăng nhập."); }
    await browser.close();
});

// DASHBOARD GIỮ NGUYÊN
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:Segoe UI,sans-serif; background:#0d1117; color:#c9d1d9; padding:20px">
            <h1 style="color:#58a6ff">🛰️ YT BOT V5 - RESURRECTION</h1>
            <div style="margin-bottom: 20px;">
                <a href="/login" style="background:#238636; color:white; padding:10px; border-radius:5px; text-decoration:none">🔑 BẤM VÀO ĐÂY ĐỂ ĐĂNG NHẬP LẤY COOKIE</a>
            </div>
            <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:10px; margin-bottom:20px">
                <div style="background:#161b22; padding:15px; border-left:5px solid #3fb950">
                    <small>VIEWS HOÀN TẤT</small><br><b style="font-size:24px">${stats.totalViews}</b>
                </div>
                <div style="background:#161b22; padding:15px; border-left:5px solid #d29922">
                    <small>TỔNG THỜI GIAN</small><br><b style="font-size:24px">${formatTime(stats.totalSeconds)}</b>
                </div>
                <div style="background:#161b22; padding:15px; border-left:5px solid #0af">
                    <small>PROXY SẴN SÀNG</small><br><b style="font-size:24px">${stats.proxyReady}</b>
                </div>
                <div style="background:#161b22; padding:15px; border-left:5px solid #bc8cff">
                    <small>⭐ PROXY NGON (CẤP CỨU)</small><br><b style="font-size:24px">${stats.goodCount}</b>
                </div>
            </div>
            <table style="width:100%; border-collapse:collapse; background:#161b22">
                <tr style="background:#21262d; text-align:left">
                    <th style="padding:12px">PROXY</th><th>VIDEO</th><th>TIẾN ĐỘ</th><th>HÀNH ĐỘNG</th>
                </tr>
                ${Object.values(stats.threadStatus).map(t => `
                <tr style="border-bottom:1px solid #333">
                    <td style="padding:10px; color:#0af">${t.proxy}</td>
                    <td><small>[${t.iteration}]</small> ${t.title}</td>
                    <td>${t.elapsed}/${t.target}s</td>
                    <td style="color:#3fb950">${t.lastAction}</td>
                </tr>`).join('')}
            </table>
            <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`DASHBOARD: http://localhost:1111`);
    main();
});
