const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
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
const startTime = Date.now();

let stats = {
    totalViews: 0,
    totalWatchSeconds: 0,
    activeThreads: 0,
    proxiesFailed: 0,
    proxyReady: 0,
    threadStatus: {}, 
    logs: [] 
};

let blacklist = new Set();
let proxyList = [];
let successPool = new Set();

// Dọn dẹp folder tạm
if (fs.existsSync(path.join(__dirname, 'temp'))) fs.removeSync(path.join(__dirname, 'temp'));

// Hàm ghi Log cực chi tiết
function fullLog(msg, type = 'INFO') {
    const time = new Date().toLocaleTimeString();
    const logMsg = `[${time}] [${type}] ${msg}`;
    console.log(logMsg); 
    stats.logs.unshift(logMsg);
    if (stats.logs.length > 100) stats.logs.pop();
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
}

// --- 1. SIÊU CÔNG CỤ QUÉT PROXY (X100 SOURCES) ---
async function fetchProxies() {
    fullLog('📡 Khởi động quét Proxy diện rộng (X100 Sources)...', 'SCRAPER');
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://api.openproxylist.xyz/http.txt',
        'https://proxyspace.pro/http.txt',
        'https://spys.me/proxy.txt',
        'https://www.proxy-list.download/api/v1/get?type=http',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
        'https://raw.githubusercontent.com/Zaeem20/free-proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/officialputuid/Free-Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
        'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt',
        'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/B4RC0DE-7/proxy-list/main/HTTP.txt',
        'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt'
    ];

    let allRawData = "";
    try {
        const responses = await Promise.allSettled(sources.map(url => axios.get(url, { timeout: 10000 })));
        responses.forEach(res => { if (res.status === 'fulfilled') allRawData += res.value.data; });
        
        // Regex mạnh mẽ lọc IP:PORT
        const found = allRawData.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}/g);
        if (found) {
            proxyList = [...new Set(found)].filter(p => !blacklist.has(p));
            stats.proxyReady = proxyList.length;
            fullLog(`Đã nạp ${proxyList.length} Proxy vào kho đạn!`, 'SYSTEM');
        }
    } catch (e) { fullLog('Lỗi khi cào Proxy nguồn', 'ERROR'); }
}

// --- 2. LUỒNG XỬ LÝ VIDEO ---
async function runWorker(proxy) {
    stats.activeThreads++;
    const id = Math.random().toString(36).substring(7).toUpperCase();
    const userDataDir = path.join(__dirname, 'temp', `profile_${id}`);
    
    stats.threadStatus[id] = { 
        proxy, videoTitle: 'Đang mở trình duyệt...', iteration: 0, 
        elapsed: 0, target: 0, status: '🚀 KHỞI CHẠY' 
    };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: userDataDir,
            args: [`--proxy-server=http://${proxy}`, '--no-sandbox', '--disable-gpu', '--mute-audio']
        });

        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(60000);

        // Chặn rác để Proxy chạy mượt
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'stylesheet'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        fullLog(`[ID:${id}] Đang quét Playlist...`, 'NETWORK');
        stats.threadStatus[id].status = '📂 Load Playlist';
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
        
        const videoLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
            return [...new Set(links.map(a => a.href.split('&')[0]))]; 
        });

        if (!videoLinks || videoLinks.length === 0) throw new Error("Proxy không tải được Playlist");

        // Xem hết playlist
        for (let i = 0; i < videoLinks.length; i++) {
            stats.threadStatus[id].iteration = i + 1;
            stats.threadStatus[id].status = `🔗 Vào Video ${i+1}`;
            
            await page.goto(videoLinks[i], { waitUntil: 'networkidle2' });
            
            const title = await page.title();
            stats.threadStatus[id].videoTitle = title.replace('- YouTube', '').trim();
            stats.threadStatus[id].status = '📺 Đang xem';
            
            const watchSeconds = Math.floor(Math.random() * 61) + 120; // Xem 2-3 phút
            stats.threadStatus[id].target = watchSeconds;

            fullLog(`[ID:${id}] Đang xem: ${stats.threadStatus[id].videoTitle}`, 'ACTION');

            for (let s = 1; s <= watchSeconds; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[id].elapsed = s;
                stats.totalWatchSeconds++; // Tích lũy tổng giây toàn hệ thống
            }

            stats.totalViews++;
            successPool.add(proxy);
            fullLog(`[ID:${id}] Xem xong Vid ${i+1}/${videoLinks.length}`, 'SUCCESS');
        }

    } catch (err) {
        blacklist.add(proxy);
        stats.proxiesFailed++;
        fullLog(`[ID:${id}] Ngừng: ${err.message}`, 'FAILED');
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        delete stats.threadStatus[id];
        stats.activeThreads--;
    }
}

// --- 3. QUẢN LÝ ---
async function main() {
    await fetchProxies();
    setInterval(async () => { if (proxyList.length < 100) await fetchProxies(); }, 120000);

    while (true) {
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
            await new Promise(r => setTimeout(r, 4000)); 
        } else {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

// --- 4. GIAO DIỆN MONITOR CHUYÊN NGHIỆP ---
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:sans-serif; background:#0a0a0a; color:#eee; padding:20px; margin:0;">
            <div style="background:#111; padding:20px; border-bottom:3px solid #ff0000; position:sticky; top:0; z-index:100;">
                <h1 style="margin:0; color:#ff0000; display:flex; justify-content:space-between;">
                    YT BOT PRO - MONITOR
                    <span style="font-size:14px; color:#aaa;">Uptime: ${Math.floor((Date.now()-startTime)/60000)}m</span>
                </h1>
                <div style="display:grid; grid-template-columns: repeat(5, 1fr); gap:10px; margin-top:15px;">
                    <div style="background:#222; padding:10px; border-radius:5px; text-align:center;">
                        <div style="font-size:11px; color:#888;">TỔNG VIEWS</div>
                        <b style="font-size:18px; color:#2ed573;">${stats.totalViews}</b>
                    </div>
                    <div style="background:#222; padding:10px; border-radius:5px; text-align:center;">
                        <div style="font-size:11px; color:#888;">TỔNG THỜI GIAN XEM</div>
                        <b style="font-size:18px; color:#70a1ff;">${formatTime(stats.totalWatchSeconds)}</b>
                    </div>
                    <div style="background:#222; padding:10px; border-radius:5px; text-align:center;">
                        <div style="font-size:11px; color:#888;">PROXY SẴN</div>
                        <b style="font-size:18px; color:#eccc68;">${proxyList.length}</b>
                    </div>
                    <div style="background:#222; padding:10px; border-radius:5px; text-align:center;">
                        <div style="font-size:11px; color:#888;">LUỒNG CHẠY</div>
                        <b style="font-size:18px; color:#ff7f50;">${stats.activeThreads}/${MAX_THREADS}</b>
                    </div>
                    <div style="background:#222; padding:10px; border-radius:5px; text-align:center;">
                        <div style="font-size:11px; color:#888;">PROXY DIE</div>
                        <b style="font-size:18px; color:#ff4757;">${stats.proxiesFailed}</b>
                    </div>
                </div>
            </div>

            <div style="padding:20px;">
                <h3 style="color:#ff7f50;">⚡ CHI TIẾT TỪNG LUỒNG:</h3>
                <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap:15px;">
                    ${Object.entries(stats.threadStatus).map(([id, t]) => `
                        <div style="background:#1a1a1a; border:1px solid #333; padding:15px; border-radius:8px;">
                            <div style="display:flex; justify-content:space-between; margin-bottom:10px;">
                                <b style="color:#2ed573;">🆔 ${id}</b>
                                <span style="font-size:10px; color:#777;">${t.proxy.substring(0,15)}...</span>
                            </div>
                            <div style="font-size:13px; height:32px; overflow:hidden; color:#fff;">
                                🎬 <b>[V${t.iteration}]</b> ${t.videoTitle}
                            </div>
                            <div style="background:#000; height:6px; border-radius:3px; margin:10px 0;">
                                <div style="width:${(t.elapsed/t.target)*100}%; background:#2ed573; height:100%; border-radius:3px;"></div>
                            </div>
                            <div style="display:flex; justify-content:space-between; font-size:11px;">
                                <span style="color:#eccc68;">${t.status}</span>
                                <span>${t.elapsed}/${t.target}s</span>
                            </div>
                        </div>
                    `).join('')}
                </div>

                <h3 style="color:#eccc68; margin-top:30px;">📜 NHẬT KÝ HÀNH ĐỘNG (FULL LOG):</h3>
                <div style="background:#000; border:1px solid #333; padding:15px; border-radius:8px; height:400px; overflow-y:auto; font-family:monospace; color:#00ff41; font-size:12px;">
                    ${stats.logs.map(line => `<div>${line}</div>`).join('')}
                </div>
            </div>
            <script>setTimeout(() => location.reload(), 4000)</script>
        </body>
    `);
});

app.listen(port, () => { main(); });
