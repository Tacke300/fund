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

// Reset hệ thống khi Restart
if (fs.existsSync(TEMP_DIR)) {
    try { fs.removeSync(TEMP_DIR); } catch(e) {}
}
fs.ensureDirSync(TEMP_DIR);

let stats = {
    totalViews: 0, activeThreads: 0,
    proxiesFailed: 0, proxiesSuccess: 0,
    threadStatus: {}, logs: []
};

// QUẢN LÝ PROXY
let blacklist = {}; // Reset sạch mỗi lần restart
let proxyList = [];
let successPool = new Set(); // Nơi lưu trữ Proxy "cứu hộ" (đã từng chạy ok)

function dashLog(msg) {
    const time = new Date().toLocaleTimeString();
    stats.logs.unshift(`[${time}] ${msg}`);
    if (stats.logs.length > 15) stats.logs.pop();
}

async function fetchProxies() {
    console.log('--- ĐANG QUÉT NGUỒN PROXY MỚI ---');
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt'
    ];
    
    let all = [];
    for (let s of sources) {
        try {
            const res = await axios.get(s, { timeout: 10000 });
            const found = res.data.split('\n').filter(p => p.includes(':')).map(p => p.trim());
            all = all.concat(found);
        } catch (e) { console.log(`Lỗi nguồn: ${s.substring(0,30)}`); }
    }

    // Lọc bỏ blacklist
    proxyList = [...new Set(all)].filter(p => !blacklist[p]);

    // NẾU HẾT PROXY MỚI -> ĐỔ PROXY THÀNH CÔNG VÀO CHẠY LẠI
    if (proxyList.length < 5 && successPool.size > 0) {
        dashLog("🆘 Dùng Proxy cứu hộ từ Success Pool...");
        proxyList = [...proxyList, ...Array.from(successPool)];
    }
    
    console.log(`Tổng Proxy khả dụng: ${proxyList.length}`);
}

async function runWorker(proxy) {
    stats.activeThreads++;
    const id = uuidv4().split('-')[0].toUpperCase();
    const userDataDir = path.join(TEMP_DIR, `profile_${id}_${Date.now()}`);
    
    stats.threadStatus[id] = { proxy, status: 'Mở trình duyệt', elapsed: 0 };
    let browser;

    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: userDataDir,
            args: [
                `--proxy-server=http://${proxy}`,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--mute-audio'
            ]
        });

        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(90000); // 1.5 phút để load

        // Chặn rác để Proxy load nhanh hơn
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

        if (!videoLinks || videoLinks.length === 0) throw new Error("Proxy không vào được YouTube");

        // Vào xem video đầu tiên
        await page.goto(videoLinks[0], { waitUntil: 'networkidle2' });
        
        // Proxy chạy tới đây là ngon -> Lưu vào Pool cứu hộ
        successPool.add(proxy); 
        
        const watchTime = Math.floor(Math.random() * 60) + 120; // Xem 2-3p
        stats.threadStatus[id].status = 'Đang xem video';

        for (let s = 1; s <= watchTime; s++) {
            await new Promise(r => setTimeout(r, 1000));
            stats.threadStatus[id].elapsed = s;
        }

        stats.totalViews++;
        dashLog(`✅ VIEW THÀNH CÔNG (ID: ${id})`);

    } catch (err) {
        // Lỗi proxy thì cho vào blacklist của phiên này
        blacklist[proxy] = true;
        stats.proxiesFailed++;
        // Nếu proxy này từng trong successPool mà giờ chết thì xóa nó đi
        successPool.delete(proxy);
        console.log(`[${id}] Lỗi: ${err.message}`);
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) {}
        }
        stats.activeThreads--;
        delete stats.threadStatus[id];
        
        // Xử lý xóa folder an toàn (Fix EPERM)
        setTimeout(() => {
            try { if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir); } catch (e) {}
        }, 8000);
    }
}

async function main() {
    dashLog("🤖 Bot khởi động. Blacklist đã được reset sạch.");
    while (true) {
        if (proxyList.length < 10) await fetchProxies();

        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            // Chạy theo đợt Batch Size để tránh sập CPU
            for (let i = 0; i < BATCH_SIZE; i++) {
                if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
                    runWorker(proxyList.shift());
                }
            }
            await new Promise(r => setTimeout(r, 15000)); // Nghỉ 15s giữa các đợt
        } else {
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:sans-serif; background:#0f0f0f; color:#eee; padding:20px;">
            <h2 style="color:#ff4757">🚀 YOUTUBE BOT PRO - LUỒNG: ${stats.activeThreads}/${MAX_THREADS}</h2>
            <div style="display:flex; gap:10px; margin-bottom:20px;">
                <div style="background:#1e1e1e; padding:15px; flex:1; border-radius:10px; border-bottom:4px solid #2ed573">
                    Views: <span style="font-size:24px">${stats.totalViews}</span>
                </div>
                <div style="background:#1e1e1e; padding:15px; flex:1; border-radius:10px; border-bottom:4px solid #70a1ff">
                    Success Pool: <span style="font-size:24px">${successPool.size}</span>
                </div>
                <div style="background:#1e1e1e; padding:15px; flex:1; border-radius:10px; border-bottom:4px solid #ff4757">
                    Proxy Lỗi: <span style="font-size:24px">${stats.proxiesFailed}</span>
                </div>
            </div>
            <div style="display:grid; grid-template-columns: 1.5fr 1fr; gap:15px;">
                <div style="background:#1e1e1e; padding:15px; height:350px; overflow-y:auto; border-radius:10px;">
                    <h3 style="margin:0 0 10px 0; color:#ffa502">🖥️ Các luồng đang chạy</h3>
                    ${Object.entries(stats.threadStatus).map(([id, t]) => `
                        <div style="font-size:12px; padding:8px; background:#252525; margin-bottom:5px; border-radius:5px;">
                            <b>${id}</b> | Proxy: ${t.proxy.split(':')[0]}... | ${t.status} (${t.elapsed}s)
                        </div>
                    `).join('')}
                </div>
                <div style="background:#000; padding:15px; height:350px; overflow-y:auto; color:#2ed573; font-family:monospace; font-size:12px; border-radius:10px;">
                    <h3 style="color:#fff; margin:0 0 10px 0">📝 Nhật ký sự kiện chính</h3>
                    ${stats.logs.map(l => `<div style="margin-bottom:4px;">${l}</div>`).join('')}
                </div>
            </div>
            <script>setTimeout(() => location.reload(), 5000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`DASHBOARD: http://localhost:${port}`);
    main();
});
