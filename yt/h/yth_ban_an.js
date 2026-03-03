const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const { v4: uuidv4 } = require('uuid');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

// --- CẤU HÌNH ---
const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 10; 
const BATCH_SIZE = 3; 
const TEMP_DIR = path.join(__dirname, 'temp');
const BLACKLIST_FILE = './blacklist_proxy.json';

// --- KHỞI TẠO KHI RESTART PM2 ---
const startTime = Date.now(); // Lưu lúc bot bắt đầu chạy

// FIX LỖI KHÔNG XÓA BLACKLIST: Xóa file vật lý ngay khi khởi động
if (fs.existsSync(BLACKLIST_FILE)) {
    try { fs.unlinkSync(BLACKLIST_FILE); console.log("🔥 Đã xóa file Blacklist cũ!"); } catch(e) {}
}

if (fs.existsSync(TEMP_DIR)) {
    try { fs.removeSync(TEMP_DIR); } catch(e) {}
}
fs.ensureDirSync(TEMP_DIR);

let stats = {
    totalViews: 0, activeThreads: 0,
    proxiesFetched: 0, proxiesFailed: 0,
    threadStatus: {}, logs: []
};

let blacklist = {}; 
let proxyList = [];
let successPool = new Set(); 

function dashLog(msg) {
    const time = new Date().toLocaleTimeString();
    stats.logs.unshift(`[${time}] ${msg}`);
    if (stats.logs.length > 12) stats.logs.pop();
}

// TĂNG NGUỒN PROXY (10+ NGUỒN)
async function fetchProxies() {
    dashLog("📡 Đang quét nguồn Proxy diện rộng...");
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
        'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
        'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt',
        'https://raw.githubusercontent.com/opsxcq/proxy-list/master/list.txt',
        'https://proxy-spider.com/api/proxies.example.txt',
        'https://raw.githubusercontent.com/Zaeem20/free-proxy-list/master/http.txt'
    ];
    
    let all = [];
    for (let s of sources) {
        try {
            const res = await axios.get(s, { timeout: 8000 });
            const found = res.data.split('\n').filter(p => p.includes(':')).map(p => p.trim());
            all = all.concat(found);
        } catch (e) {}
    }

    let unique = [...new Set(all)].filter(p => !blacklist[p]);
    stats.proxiesFetched = unique.length;
    proxyList = unique;

    // NẾU HẾT PROXY MỚI -> DÙNG HÀNG CỨU HỘ
    if (proxyList.length < 50 && successPool.size > 0) {
        dashLog("🆘 Nạp thêm từ Success Pool (Hàng cũ uy tín)...");
        proxyList = [...proxyList, ...Array.from(successPool)];
    }
}

async function runWorker(proxy) {
    stats.activeThreads++;
    const id = uuidv4().split('-')[0].toUpperCase();
    const userDataDir = path.join(TEMP_DIR, `profile_${id}_${Date.now()}`);
    
    stats.threadStatus[id] = { proxy, status: 'Đang mở...', elapsed: 0 };
    let browser;

    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: userDataDir,
            args: [`--proxy-server=http://${proxy}`, '--no-sandbox', '--disable-gpu', '--mute-audio']
        });

        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(60000);

        // Chặn ảnh/css để proxy load mượt hơn
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'stylesheet'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
        
        const videoLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
            return [...new Set(links.map(a => a.href.split('&')[0]))];
        });

        if (!videoLinks || videoLinks.length === 0) throw new Error("Proxy rác");

        await page.goto(videoLinks[0], { waitUntil: 'networkidle2' });
        successPool.add(proxy); 
        
        const watchTime = Math.floor(Math.random() * 40) + 100; 
        stats.threadStatus[id].status = 'Đang xem';

        for (let s = 1; s <= watchTime; s++) {
            await new Promise(r => setTimeout(r, 1000));
            stats.threadStatus[id].elapsed = s;
        }

        stats.totalViews++;
        dashLog(`✅ Thành công (ID: ${id})`);

    } catch (err) {
        blacklist[proxy] = true;
        stats.proxiesFailed++;
        successPool.delete(proxy);
    } finally {
        if (browser) try { await browser.close(); } catch (e) {}
        stats.activeThreads--;
        delete stats.threadStatus[id];
        setTimeout(() => {
            try { if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir); } catch (e) {}
        }, 5000);
    }
}

function getUptime() {
    const diff = Date.now() - startTime;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    return `${h}giờ ${m}phút ${s}giây`;
}

async function main() {
    while (true) {
        if (proxyList.length < 50) await fetchProxies(); // NGƯỠNG 50 THEO YÊU CẦU

        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            for (let i = 0; i < BATCH_SIZE; i++) {
                if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
                    runWorker(proxyList.shift());
                }
            }
            await new Promise(r => setTimeout(r, 12000)); // Nghỉ 12s giữa đợt 3 luồng
        } else {
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:sans-serif; background:#0a0a0a; color:#eee; padding:20px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <h2 style="color:#ff4757; margin:0;">🚀 YOUTUBE MASTER BOT</h2>
                <div style="background:#2f3542; padding:5px 15px; border-radius:20px; font-size:14px;">
                    ⏱️ Thời gian đã chạy: <b>${getUptime()}</b>
                </div>
            </div>

            <div style="display:flex; gap:10px; margin:20px 0;">
                <div style="background:#1e1e1e; padding:15px; flex:1; border-radius:10px; border-left:5px solid #2ed573">
                    <small>VIEWS THÀNH CÔNG</small><br><span style="font-size:28px">${stats.totalViews}</span>
                </div>
                <div style="background:#1e1e1e; padding:15px; flex:1; border-radius:10px; border-left:5px solid #ffa502">
                    <small>PROXY ĐỢI (LIVE)</small><br><span style="font-size:28px">${proxyList.length}</span>
                </div>
                <div style="background:#1e1e1e; padding:15px; flex:1; border-radius:10px; border-left:5px solid #70a1ff">
                    <small>POOL CỨU HỘ</small><br><span style="font-size:28px">${successPool.size}</span>
                </div>
                <div style="background:#1e1e1e; padding:15px; flex:1; border-radius:10px; border-left:5px solid #ff4757">
                    <small>PROXY LỖI</small><br><span style="font-size:28px">${stats.proxiesFailed}</span>
                </div>
            </div>

            <div style="display:grid; grid-template-columns: 1.2fr 1fr; gap:15px;">
                <div style="background:#151515; padding:15px; height:300px; overflow-y:auto; border-radius:10px; border:1px solid #333;">
                    <h4 style="margin:0 0 10px 0; color:#2ed573">🖥️ LUỒNG HOẠT ĐỘNG (${stats.activeThreads}/${MAX_THREADS})</h4>
                    ${Object.entries(stats.threadStatus).map(([id, t]) => `
                        <div style="font-size:11px; padding:6px; background:#222; margin-bottom:4px; display:flex; justify-content:space-between;">
                            <span><b>ID: ${id}</b> | ${t.proxy.substring(0,18)}...</span>
                            <span style="color:#ffa502">${t.status} (${t.elapsed}s)</span>
                        </div>
                    `).join('')}
                </div>
                <div style="background:#000; padding:15px; height:300px; overflow-y:auto; color:#2ed573; font-family:monospace; font-size:12px; border-radius:10px; border:1px solid #333;">
                    <h4 style="margin:0 0 10px 0; color:#fff">📝 NHẬT KÝ CHÍNH</h4>
                    ${stats.logs.map(l => `<div>${l}</div>`).join('')}
                </div>
            </div>
            <script>setTimeout(() => location.reload(), 4000)</script>
        </body>
    `);
});

app.listen(port, () => { console.log(`Dashboard: http://localhost:${port}`); main(); });
