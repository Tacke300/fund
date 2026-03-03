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

// --- FIX ĐƯỜNG DẪN TUYỆT ĐỐI ---
const BLACKLIST_FILE = path.join(__dirname, 'blacklist_proxy.json'); 
const TEMP_DIR = path.join(__dirname, 'temp');
const startTime = Date.now();

// --- XÓA BLACKLIST KHI RESTART (NHƯ YÊU CẦU) ---
if (fs.existsSync(BLACKLIST_FILE)) {
    try { fs.unlinkSync(BLACKLIST_FILE); } catch(e) {}
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
    if (stats.logs.length > 15) stats.logs.pop();
}

// --- X10 NGUỒN PROXY (QUÉT DIỆN RỘNG) ---
async function fetchProxies() {
    dashLog("🚀 Đang khởi động Deep Scan (x10 Sources)...");
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
        'https://raw.githubusercontent.com/Zaeem20/free-proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
        'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt',
        'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_list.txt',
        'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt',
        'https://raw.githubusercontent.com/officialputuid/Free-Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/http.txt',
        'https://raw.githubusercontent.com/vakhov/free-proxy-list/master/proxy_list.txt',
        'https://raw.githubusercontent.com/proxy4parsing/proxy-list/main/http.txt',
        'https://api.openproxylist.xyz/http.txt'
    ];
    
    let all = [];
    const requests = sources.map(s => axios.get(s, { timeout: 15000 }).catch(e => null));
    const results = await Promise.all(requests);

    results.forEach(res => {
        if (res && res.data) {
            const found = res.data.toString().split('\n')
                .filter(p => p.includes(':'))
                .map(p => p.trim());
            all = all.concat(found);
        }
    });

    // Loại bỏ Proxy nát (Blacklist) và trùng lặp
    proxyList = [...new Set(all)].filter(p => !blacklist[p] && p.length > 7);
    stats.proxiesFetched = proxyList.length;
    
    dashLog(`✅ Đã nạp ${proxyList.length} Proxy mới vào hàng chờ.`);

    if (proxyList.length < 50 && successPool.size > 0) {
        dashLog("🆘 Nạp thêm hàng dự phòng từ Success Pool...");
        proxyList = [...proxyList, ...Array.from(successPool)];
    }
}

async function runWorker(proxy) {
    stats.activeThreads++;
    const id = uuidv4().split('-')[0].toUpperCase();
    const userDataDir = path.join(TEMP_DIR, `profile_${id}_${Date.now()}`);
    
    stats.threadStatus[id] = { proxy, status: 'Khởi động', elapsed: 0 };
    let browser;

    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: userDataDir,
            args: [`--proxy-server=http://${proxy}`, '--no-sandbox', '--disable-setuid-sandbox', '--mute-audio']
        });

        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(60000);

        // Chặn rác tối đa để tăng tốc Proxy yếu
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'stylesheet', 'media'].includes(req.resourceType()) && !req.url().includes('googlevideo')) {
                req.abort();
            } else req.continue();
        });

        await page.goto('https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov', { waitUntil: 'networkidle2' });
        
        const videoLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
            return [...new Set(links.map(a => a.href.split('&')[0]))];
        });

        if (!videoLinks || videoLinks.length === 0) throw new Error("Proxy rác");

        await page.goto(videoLinks[0], { waitUntil: 'networkidle2' });
        successPool.add(proxy); 
        
        const watchTime = Math.floor(Math.random() * 60) + 120; 
        stats.threadStatus[id].status = 'Đang xem';

        for (let s = 1; s <= watchTime; s++) {
            await new Promise(r => setTimeout(r, 1000));
            stats.threadStatus[id].elapsed = s;
        }

        stats.totalViews++;
        dashLog(`✅ View OK (ID: ${id})`);

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
        }, 8000);
    }
}

async function main() {
    while (true) {
        if (proxyList.length < 100) await fetchProxies(); // Nâng ngưỡng nạp lên 100

        if (stats.activeThreads < 10 && proxyList.length > 0) {
            for (let i = 0; i < 3; i++) { // Luôn chạy 3 luồng/đợt
                if (stats.activeThreads < 10 && proxyList.length > 0) {
                    runWorker(proxyList.shift());
                }
            }
            await new Promise(r => setTimeout(r, 15000)); // Nghỉ 15s giữa các đợt mở
        } else {
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - startTime) / 60000);
    res.send(`
        <body style="font-family:sans-serif; background:#0a0a0a; color:#eee; padding:20px;">
            <h2 style="color:#ff4757">🚀 YT SUPER BOT | Uptime: ${uptime}m</h2>
            <div style="display:flex; gap:10px; margin-bottom:20px;">
                <div style="background:#1e1e1e; padding:15px; flex:1; border-radius:10px; border-bottom:4px solid #2ed573">
                    VIEWS: <b>${stats.totalViews}</b>
                </div>
                <div style="background:#1e1e1e; padding:15px; flex:1; border-radius:10px; border-bottom:4px solid #ffa502">
                    PROXY CHỜ: <b>${proxyList.length}</b>
                </div>
                <div style="background:#1e1e1e; padding:15px; flex:1; border-radius:10px; border-bottom:4px solid #70a1ff">
                    POOL NGON: <b>${successPool.size}</b>
                </div>
                <div style="background:#1e1e1e; padding:15px; flex:1; border-radius:10px; border-bottom:4px solid #ff4757">
                    LỖI: <b>${stats.proxiesFailed}</b>
                </div>
            </div>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px;">
                <div style="background:#151515; padding:15px; height:350px; overflow-y:auto;">
                    <h4 style="color:#2ed573">🖥️ LUỒNG ĐANG CHẠY (${stats.activeThreads}/10)</h4>
                    ${Object.entries(stats.threadStatus).map(([id, t]) => `
                        <div style="font-size:11px; margin-bottom:5px; padding:5px; background:#222;">
                            <b>${id}</b> | ${t.status} (${t.elapsed}s)
                        </div>
                    `).join('')}
                </div>
                <div style="background:#000; padding:15px; height:350px; overflow-y:auto; color:#2ed573; font-family:monospace; font-size:12px;">
                    <h4 style="color:#fff">📝 NHẬT KÝ CHÍNH</h4>
                    ${stats.logs.map(l => `<div>${l}</div>`).join('')}
                </div>
            </div>
            <script>setTimeout(() => location.reload(), 5000)</script>
        </body>
    `);
});

app.listen(port, () => { main(); });
