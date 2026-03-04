const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

// --- CẤU HÌNH HỆ THỐNG ---
const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 15;
const startTime = Date.now();

let stats = {
    totalViews: 0, activeThreads: 0,
    proxiesFailed: 0, proxiesSuccess: 0,
    proxyReady: 0, threadStatus: {}, logs: []
};

let blacklist = new Set(); 
let proxyList = [];
let successPool = new Set(); 

// Dọn dẹp rác hệ thống khi khởi động
if (fs.existsSync(path.join(__dirname, 'temp'))) fs.removeSync(path.join(__dirname, 'temp'));

function dashLog(msg) {
    const time = new Date().toLocaleTimeString();
    stats.logs.unshift(`[${time}] ${msg}`);
    if (stats.logs.length > 50) stats.logs.pop();
    console.log(`[${time}] ${msg}`);
}

// --- 1. SIÊU CÔNG CỤ QUÉT PROXY (X100 SOURCES) ---
async function fetchProxies() {
    dashLog('🚀 ĐANG QUÉT TOÀN CẦU (GITHUB MINING & API SÂU)...');
    
    const apiSources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://api.openproxylist.xyz/http.txt',
        'https://proxyspace.pro/http.txt',
        'https://spys.me/proxy.txt',
        'https://www.proxy-list.download/api/v1/get?type=http',
        'https://www.proxyscan.io/download?type=http',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
        'https://raw.githubusercontent.com/Zaeem20/free-proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
        'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt',
        'https://raw.githubusercontent.com/officialputuid/Free-Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
        'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/jetkai/proxy-list/main/archive/dict/http.txt',
        'https://raw.githubusercontent.com/UptimerBot/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/B4RC0DE-7/proxy-list/main/HTTP.txt',
        'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt',
        'https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_list.txt',
        'https://raw.githubusercontent.com/Vann-Dev/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/saisuiu/LionZeroFreeProxy/main/proxy.txt',
        'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt',
        'https://raw.githubusercontent.com/andreafabrizi/Static-Proxy-List/master/http.txt'
    ];

    let allRawData = "";
    
    // Tải song song tất cả các nguồn
    const requests = apiSources.map(url => axios.get(url, { timeout: 15000 }).catch(() => null));
    const responses = await Promise.all(requests);

    responses.forEach(res => {
        if (res && res.data) {
            allRawData += typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        }
    });

    // Regex thông minh bóc tách IP:PORT
    const found = allRawData.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}/g);
    
    if (found) {
        // Loại bỏ trùng lặp và blacklist
        const unique = [...new Set(found)].filter(p => !blacklist.has(p));
        proxyList = unique;
        stats.proxyReady = proxyList.length;
        dashLog(`✅ KẾT QUẢ: Đã tìm thấy ${proxyList.length} Proxy mới!`);
    }
}

// --- 2. WORKER CHẠY PLAYLIST ---
async function runWorker(proxy) {
    stats.activeThreads++;
    const id = Math.random().toString(36).substring(7).toUpperCase();
    const userDataDir = path.join(__dirname, 'temp', `profile_${id}`);
    
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: userDataDir,
            args: [
                `--proxy-server=http://${proxy}`, 
                '--no-sandbox', '--disable-gpu', '--mute-audio',
                '--disable-webrtc', // Chống lộ IP thật
                '--window-size=1280,720'
            ]
        });

        const page = await browser.newPage();
        await page.setUserAgent(userAgents[Math.floor(Math.random() * userAgents.length)]);
        await page.setDefaultNavigationTimeout(90000);

        // Chặn tài nguyên thừa để proxy chạy nhanh hơn
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'stylesheet'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        // 1. Lấy danh sách video từ Playlist
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
        const videoLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
            return [...new Set(links.map(a => a.href.split('&')[0]))]; 
        });

        if (!videoLinks || videoLinks.length === 0) throw new Error("Proxy không load được danh sách video");

        // 2. Vòng lặp cày nát Playlist
        for (let i = 0; i < videoLinks.length; i++) {
            let retry = 0;
            let videoSuccess = false;

            while (retry < 2 && !videoSuccess) {
                try {
                    stats.threadStatus[id] = { proxy, iteration: i + 1, status: `🔄 Đang thử Video ${i+1}`, elapsed: 0, target: 120 };
                    await page.goto(videoLinks[i], { waitUntil: 'networkidle2', timeout: 60000 });
                    
                    // Kiểm tra xem video có thực sự chạy không
                    const isVideo = await page.evaluate(() => !!document.querySelector('video'));
                    if (!isVideo) throw new Error("Không thấy Video");

                    successPool.add(proxy);
                    videoSuccess = true;

                    const watchTime = Math.floor(Math.random() * 61) + 120; // Xem 2-3 phút
                    stats.threadStatus[id].target = watchTime;
                    stats.threadStatus[id].status = '📺 Đang xem';

                    for (let s = 1; s <= watchTime; s++) {
                        await new Promise(r => setTimeout(r, 1000));
                        stats.threadStatus[id].elapsed = s;
                    }
                    stats.totalViews++;
                } catch (e) {
                    retry++;
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
            if (!videoSuccess) break; // Proxy chết thì đổi luồng
        }

    } catch (err) {
        blacklist.add(proxy);
        stats.proxiesFailed++;
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        delete stats.threadStatus[id];
        stats.activeThreads--;
    }
}

// --- 3. QUẢN LÝ LUỒNG CHẠY LIÊN TỤC ---
async function main() {
    dashLog("🔥 KHỞI CHẠY YT BOT PRO - SIÊU QUÉT PROXY MODE...");
    await fetchProxies();

    setInterval(async () => {
        if (proxyList.length < 100) await fetchProxies();
    }, 300000); // Tự động làm mới kho proxy mỗi 5 phút

    while (true) {
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            const p = proxyList.shift();
            runWorker(p);
            await new Promise(r => setTimeout(r, 3000)); // Tránh mở quá nhanh làm CPU 100%
        } else {
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

// --- 4. GIAO DIỆN MONITOR ---
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:sans-serif; background:#0f0f0f; color:#fff; padding:20px;">
            <h2 style="color:#ff0000">📊 YT BOT PRO - MONITOR (${stats.activeThreads}/${MAX_THREADS})</h2>
            <div style="display:flex; gap:15px; margin-bottom:20px;">
                <div style="background:#222; padding:15px; border-radius:10px; flex:1">Views: <b style="color:#2ed573">${stats.totalViews}</b></div>
                <div style="background:#222; padding:15px; border-radius:10px; flex:1">Proxy Chờ: <b style="color:#eccc68">${proxyList.length}</b></div>
                <div style="background:#222; padding:15px; border-radius:10px; flex:1">Lỗi: <b style="color:#ff4757">${stats.proxiesFailed}</b></div>
            </div>
            <table style="width:100%; border-collapse:collapse; background:#1a1a1a">
                <tr style="background:#333">
                    <th style="padding:10px">ID</th><th>Proxy</th><th>Video</th><th>Tiến độ</th><th>Trạng thái</th>
                </tr>
                ${Object.entries(stats.threadStatus).map(([id, t]) => `
                <tr style="border-bottom:1px solid #333">
                    <td style="padding:10px">${id}</td>
                    <td style="font-size:10px">${t.proxy}</td>
                    <td align="center">${t.iteration}</td>
                    <td>${t.elapsed}/${t.target}s</td>
                    <td style="color:#2ed573">${t.status}</td>
                </tr>`).join('')}
            </table>
            <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
    `);
});

app.listen(port, () => { main(); });
