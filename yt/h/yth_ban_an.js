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
const BATCH_SIZE = 3; // Mở 3 luồng mỗi đợt
const BLACKLIST_FILE = './blacklist_proxy.json';
const TEMP_DIR = path.join(__dirname, 'temp');

// Khởi tạo thư mục sạch
if (fs.existsSync(TEMP_DIR)) {
    try { fs.removeSync(TEMP_DIR); } catch(e) {}
}
fs.ensureDirSync(TEMP_DIR);

let stats = {
    totalViews: 0, activeThreads: 0,
    proxiesFailed: 0, proxiesSuccess: 0,
    threadStatus: {}, logs: [] // Log cho HTML
};

let blacklist = fs.existsSync(BLACKLIST_FILE) ? fs.readJsonSync(BLACKLIST_FILE) : {};
let proxyList = [];

// CHỈ LOG CÁC SỰ KIỆN CHÍNH LÊN HTML
function dashLog(msg) {
    const time = new Date().toLocaleTimeString();
    stats.logs.unshift(`[${time}] ${msg}`);
    if (stats.logs.length > 20) stats.logs.pop();
}

async function fetchProxies() {
    console.log('--- ĐANG QUÉT PROXY MỚI ---');
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt'
    ];
    let all = [];
    for (let s of sources) {
        try {
            const res = await axios.get(s, { timeout: 5000 });
            all = all.concat(res.data.split('\n').map(p => p.trim()));
        } catch (e) {}
    }
    proxyList = [...new Set(all)].filter(p => p.includes(':') && !blacklist[p]);
}

async function runWorker(proxy) {
    stats.activeThreads++;
    const id = uuidv4().split('-')[0].toUpperCase(); // ID dài hơn để tránh trùng
    const userDataDir = path.join(TEMP_DIR, `profile_${id}_${Date.now()}`);
    
    stats.threadStatus[id] = { proxy, status: 'Khởi tạo', elapsed: 0 };
    let browser;

    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: userDataDir,
            args: [`--proxy-server=http://${proxy}`, '--no-sandbox', '--disable-gpu', '--mute-audio']
        });

        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(90000); // 1.5 phút

        stats.threadStatus[id].status = 'Đang tải Playlist';
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
        
        const videoLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
            return [...new Set(links.map(a => a.href.split('&')[0]))];
        });

        if (!videoLinks || videoLinks.length === 0) throw new Error("Proxy không tải được nội dung");

        // Chỉ xem video đầu tiên trong playlist để xoay vòng luồng nhanh
        const videoUrl = videoLinks[0];
        dashLog(`Thread ${id}: Bắt đầu xem video...`);
        
        await page.goto(videoUrl, { waitUntil: 'networkidle2' });
        const watchTime = Math.floor(Math.random() * 60) + 120; // Xem 2-3 phút

        for (let s = 1; s <= watchTime; s++) {
            await new Promise(r => setTimeout(r, 1000));
            stats.threadStatus[id].elapsed = s;
        }

        stats.totalViews++;
        dashLog(`✅ THÀNH CÔNG: View thứ ${stats.totalViews} (ID: ${id})`);

    } catch (err) {
        console.log(`[${id}] Lỗi: ${err.message}`);
        if (err.message.includes('net::') || err.message.includes('timeout')) {
            blacklist[proxy] = true;
            dashLog(`❌ PROXY CHẾT: ${proxy.substring(0,15)}...`);
            fs.writeJsonSync(BLACKLIST_FILE, blacklist);
        }
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) {}
        }
        stats.activeThreads--;
        delete stats.threadStatus[id];
        
        // Xử lý EPERM: Chờ 5s rồi mới xóa, nếu lỗi thì bỏ qua không sập bot
        setTimeout(() => {
            try { if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir); } catch (e) {}
        }, 5000);
    }
}

async function main() {
    while (true) {
        if (proxyList.length < 10) await fetchProxies();

        if (stats.activeThreads < MAX_THREADS) {
            // Quét từng đợt 3 luồng
            for (let i = 0; i < BATCH_SIZE; i++) {
                if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
                    runWorker(proxyList.shift());
                }
            }
            // Nghỉ 10 giây giữa các đợt mở luồng để giảm tải CPU
            await new Promise(r => setTimeout(r, 10000));
        } else {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:sans-serif; background:#121212; color:#eee; padding:20px;">
            <h2 style="color:#ff4757">🚀 BOT DASHBOARD - LUỒNG ĐANG CHẠY: ${stats.activeThreads}/${MAX_THREADS}</h2>
            <div style="background:#1e1e1e; padding:15px; border-radius:5px; margin-bottom:10px;">
                Tổng View thành công: <b style="color:#2ed573; font-size:20px;">${stats.totalViews}</b>
            </div>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
                <div style="background:#1e1e1e; padding:10px; height:300px; overflow-y:auto; border:1px solid #333">
                    <h3 style="margin-top:0">🖥️ Trạng thái luồng</h3>
                    ${Object.entries(stats.threadStatus).map(([id, t]) => `
                        <div style="font-size:12px; margin-bottom:5px; border-bottom:1px solid #333">
                            <b style="color:#ffa502">${id}</b>: ${t.status} (${t.elapsed}s)
                        </div>
                    `).join('')}
                </div>
                <div style="background:#000; padding:10px; height:300px; overflow-y:auto; color:#2ed573; font-family:monospace; font-size:12px;">
                    <h3 style="color:#fff; margin-top:0">📝 Nhật ký chính</h3>
                    ${stats.logs.map(l => `<div>${l}</div>`).join('')}
                </div>
            </div>
            <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`Dashboard: http://localhost:${port}`);
    main();
});
