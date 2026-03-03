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
const BLACKLIST_FILE = './blacklist_proxy.json';
const GOOD_PROXIES_FILE = './good_proxies.json';
const COOKIE_FILE = './youtube_cookies.json';

let stats = {
    totalViews: 0, totalSeconds: 0, activeThreads: 0,
    proxiesScraped: 0, proxiesFailed: 0, proxiesSuccess: 0,
    proxyReady: 0, goodCount: 0, threadStatus: {}, logs: []
};

// --- HÀM LOG CHI TIẾT ---
function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const fullLog = `[${time}] ${msg}`;
    console.log(fullLog);
    stats.logs.unshift(fullLog);
    if (stats.logs.length > 100) stats.logs.pop();
}

let proxyList = [];
let blacklist = fs.existsSync(BLACKLIST_FILE) ? fs.readJsonSync(BLACKLIST_FILE) : {};
let goodProxies = fs.existsSync(GOOD_PROXIES_FILE) ? fs.readJsonSync(GOOD_PROXIES_FILE) : [];

// --- QUẢN LÝ PROXY ---
async function fetchProxies() {
    addLog("--- ĐANG QUÉT NGUỒN PROXY MỚI ---");
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/muhammadrizki16/proxy-list/main/http.txt',
        'https://proxyspace.pro/http.txt'
    ];

    let all = [];
    for (let s of sources) {
        try { 
            const res = await axios.get(s, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }); 
            const lines = res.data.split('\n').map(p => p.trim()).filter(p => p.includes(':') && /^\d/.test(p));
            all = all.concat(lines);
            addLog(`Nguồn OK: [${lines.length} IP] từ ${s.substring(0,30)}...`);
        } catch(e) { addLog(`Nguồn lỗi: ${s.split('/')[2]} (${e.message})`); }
    }

    const unique = [...new Set(all)];
    stats.proxiesScraped = unique.length;
    proxyList = unique.filter(p => !blacklist[p]);
    stats.proxyReady = proxyList.length;
    addLog(`Hoàn tất quét: ${unique.length} IP. Sẵn sàng dùng: ${proxyList.length}`);
}

// --- LUỒNG CHẠY CHÍNH ---
async function runWorker(proxy) {
    stats.activeThreads++;
    const id = Math.random().toString(36).substring(7).toUpperCase();
    const userDataDir = path.join(__dirname, 'temp', `profile_${id}`);
    stats.threadStatus[id] = { proxy, title: '---', elapsed: 0, target: 0, lastAction: '🚀 Khởi động', iteration: 0 };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: userDataDir,
            args: [
                `--proxy-server=http://${proxy}`, '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled', '--mute-audio', '--window-size=1280,720'
            ]
        });

        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(50000);
        await page.setUserAgent(new UserAgents({ deviceCategory: 'desktop' }).toString());

        if (fs.existsSync(COOKIE_FILE)) {
            const cookies = await fs.readJson(COOKIE_FILE);
            await page.setCookie(...cookies);
        }

        addLog(`[${id}] Kết nối: ${proxy}`);
        stats.threadStatus[id].lastAction = '🌍 Đang vào YouTube...';
        
        const resp = await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
        if (!resp || resp.status() >= 400) throw new Error(`Proxy chết/chậm (HTTP ${resp?resp.status():'Timeout'})`);

        // --- BƯỚC PHÁ VÂY: TỰ ĐỘNG NHẤN CHẤP NHẬN/XÁC THỰC ---
        stats.threadStatus[id].lastAction = '🔓 Đang mở khóa chặn...';
        await page.evaluate(async () => {
            const keys = ['Accept', 'Agree', 'Chấp nhận', 'Đồng ý', 'I agree', 'Allow', 'OK'];
            const buttons = Array.from(document.querySelectorAll('button, span, div[role="button"]'));
            const target = buttons.find(b => keys.some(k => b.innerText && b.innerText.includes(k)));
            if (target) target.click();
        });
        await new Promise(r => setTimeout(r, 4000));

        // Kiểm tra xem có bị Captcha không
        const isRobot = await page.evaluate(() => document.body.innerText.includes("not a robot") || document.title.includes("Captcha"));
        if (isRobot) throw new Error("Dính CAPTCHA - Bỏ qua Proxy");

        // Nhấn Play video đầu tiên
        const playSuccess = await page.evaluate(() => {
            const btn = document.querySelector('a.ytd-playlist-thumbnail') || document.querySelector('#video-title');
            if (btn) { btn.click(); return true; }
            return false;
        });
        if (!playSuccess) throw new Error("Không tìm thấy video để Play");

        // Vòng lặp xem video trong playlist
        for (let i = 0; i < 5; i++) {
            await new Promise(r => setTimeout(r, 8000));
            const title = await page.title();
            if (title === "YouTube" || !title) throw new Error("Trang trống hoặc bị treo");

            if (i === 0) {
                stats.proxiesSuccess++;
                if (!goodProxies.includes(proxy)) {
                    goodProxies.push(proxy);
                    fs.writeJsonSync(GOOD_PROXIES_FILE, goodProxies);
                }
            }

            const watchTime = Math.floor(Math.random() * 60) + 180; // Xem 3-4 phút
            stats.threadStatus[id].title = title;
            stats.threadStatus[id].target = watchTime;
            stats.threadStatus[id].iteration = i + 1;
            stats.threadStatus[id].lastAction = '✅ Đang cày view';
            
            addLog(`[${id}] Đang xem (${i+1}): ${title.substring(0,25)}...`);

            for (let s = 1; s <= watchTime; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[id].elapsed = s;
                stats.totalSeconds++;
            }

            stats.totalViews++;
            
            // Nhấn Next video
            const hasNext = await page.evaluate(() => {
                const n = document.querySelector('.ytp-next-button');
                if (n && window.getComputedStyle(n).display !== 'none') { n.click(); return true; }
                return false;
            });
            if (!hasNext) break;
        }

    } catch (err) {
        addLog(`[${id}] THẤT BẠI: ${err.message}`);
        stats.proxiesFailed++;
        blacklist[proxy] = true;
        fs.writeJsonSync(BLACKLIST_FILE, blacklist);
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        delete stats.threadStatus[id];
        stats.activeThreads--;
        addLog(`[${id}] Kết thúc luồng.`);
    }
}

// --- QUẢN LÝ CHƯƠNG TRÌNH ---
async function main() {
    addLog("HỆ THỐNG ĐÃ SẴN SÀNG");
    while (true) {
        if (proxyList.length < 20) await fetchProxies();
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
            await new Promise(r => setTimeout(r, 4000));
        } else {
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

// --- DASHBOARD HTML ---
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:monospace; background:#f0f2f5; padding:20px; color:#333">
            <h1 style="text-align:center">🛰️ YT BOT CONTROL CENTER</h1>
            <div style="display:flex; gap:20px; margin-bottom:20px">
                <div style="background:#fff; padding:20px; border-radius:8px; flex:1; box-shadow:0 2px 5px rgba(0,0,0,0.1)">
                    <b style="color:#007bff">THỐNG KÊ HOẠT ĐỘNG</b><br><br>
                    Tổng Views: <span style="font-size:24px">${stats.totalViews}</span><br>
                    Tổng thời gian: ${Math.floor(stats.totalSeconds/3600)}h ${Math.floor((stats.totalSeconds%3600)/60)}m
                </div>
                <div style="background:#fff; padding:20px; border-radius:8px; flex:1; box-shadow:0 2px 5px rgba(0,0,0,0.1)">
                    <b style="color:#28a745">THỐNG KÊ PROXY</b><br><br>
                    Sống: ${stats.proxiesSuccess} | Chết: ${stats.proxiesFailed}<br>
                    Trong hàng đợi: ${proxyList.length} | Tổng quét: ${stats.proxiesScraped}
                </div>
            </div>

            <b>LUỒNG ĐANG CHẠY (${stats.activeThreads}/${MAX_THREADS})</b>
            <table border="1" style="width:100%; border-collapse:collapse; background:#fff; margin-top:10px; border:none; box-shadow:0 2px 5px rgba(0,0,0,0.1)">
                <tr style="background:#343a40; color:#fff">
                    <th style="padding:10px">ID</th><th>Proxy IP</th><th>Video Title</th><th>Progress</th><th>Status</th>
                </tr>
                ${Object.entries(stats.threadStatus).map(([id, t]) => `
                <tr style="border-bottom:1px solid #eee">
                    <td align="center">${id}</td>
                    <td align="center" style="color:#007bff">${t.proxy}</td>
                    <td style="padding-left:10px"><b>[${t.iteration}]</b> ${t.title.substring(0,40)}...</td>
                    <td align="center">${t.elapsed}/${t.target}s</td>
                    <td align="center" style="font-weight:bold">${t.lastAction}</td>
                </tr>`).join('')}
            </table>

            <br><b>LOG CHI TIẾT BƯỚC CHẠY (STEP-BY-STEP)</b><br>
            <div style="width:100%; height:250px; background:#1e1e1e; color:#00ff00; padding:15px; overflow-y:auto; border-radius:8px; margin-top:10px; font-size:12px">
                ${stats.logs.map(l => `<div>${l}</div>`).join('')}
            </div>
            
            <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
    `);
});

app.listen(port, () => {
    addLog(`Bảng điều khiển chạy tại: http://localhost:${port}`);
    main();
});
