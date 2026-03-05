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
const MAX_THREADS = 30;
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

if (fs.existsSync(path.join(__dirname, 'temp'))) fs.removeSync(path.join(__dirname, 'temp'));

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

// --- 1. LẤY THÔNG TIN PROXY (PING & LOCATION) ---
async function getProxyInfo(proxy) {
    const start = Date.now();
    try {
        // Sử dụng axios qua proxy để check location và ping
        const res = await axios.get('http://ip-api.com/json', {
            proxy: { host: proxy.split(':')[0], port: parseInt(proxy.split(':')[1]) },
            timeout: 5000
        });
        return {
            location: `${res.data.countryCode} - ${res.data.city}`,
            ping: Date.now() - start
        };
    } catch (e) {
        return { location: 'Unknown', ping: '>5000ms' };
    }
}

// --- 2. CÀO PROXY ---
async function fetchProxies() {
    fullLog('📡 Đang quét Proxy mới...', 'SCRAPER');
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://proxyspace.pro/http.txt'
    ];

    let allRawData = "";
    const responses = await Promise.allSettled(sources.map(url => axios.get(url, { timeout: 8000 })));
    responses.forEach(res => { if (res.status === 'fulfilled') allRawData += res.value.data; });
    
    const found = allRawData.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}/g);
    if (found) {
        proxyList = [...new Set(found)].filter(p => !blacklist.has(p));
        stats.proxyReady = proxyList.length;
    }
}

// --- 3. LUỒNG XỬ LÝ (REPLAY VÔ CỰC CHO 1 IP) ---
async function runWorker(proxy) {
    stats.activeThreads++;
    const id = Math.random().toString(36).substring(7).toUpperCase();
    const userDataDir = path.join(__dirname, 'temp', `profile_${id}`);
    
    // Lấy thông tin vị trí và ping ban đầu
    const info = await getProxyInfo(proxy);

    stats.threadStatus[id] = { 
        proxy, location: info.location, ping: info.ping,
        videoTitle: 'Đang khởi động...', iteration: 0, 
        elapsed: 0, target: 0, status: '🚀 LIVE' 
    };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir,
            args: [`--proxy-server=http://${proxy}`, '--no-sandbox', '--disable-gpu', '--mute-audio']
        });

        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(60000);
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        // VÒNG LẶP VÔ CỰC CHO 1 IP
        while (true) {
            fullLog(`[ID:${id}] [${proxy}] Bắt đầu chu kỳ Playlist mới`, 'LOOP');
            await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
            
            const videoLinks = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
                return [...new Set(links.map(a => a.href.split('&')[0]))]; 
            });

            if (!videoLinks || videoLinks.length === 0) throw new Error("Proxy chết hoặc không load được playlist");

            for (let i = 0; i < videoLinks.length; i++) {
                stats.threadStatus[id].iteration++;
                await page.goto(videoLinks[i], { waitUntil: 'networkidle2' });
                
                const title = await page.title();
                stats.threadStatus[id].videoTitle = title.replace('- YouTube', '').trim();
                stats.threadStatus[id].status = '📺 Đang xem';
                
                const watchSeconds = Math.floor(Math.random() * 40) + 60; // Xem 60-100s để test nhanh, bạn có thể tăng lên
                stats.threadStatus[id].target = watchSeconds;

                for (let s = 1; s <= watchSeconds; s++) {
                    await new Promise(r => setTimeout(r, 1000));
                    stats.threadStatus[id].elapsed = s;
                    stats.totalWatchSeconds++;
                }
                stats.totalViews++;
            }
        }
    } catch (err) {
        blacklist.add(proxy);
        stats.proxiesFailed++;
        fullLog(`[ID:${id}] IP Chết: ${err.message}`, 'FAILED');
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        delete stats.threadStatus[id];
        stats.activeThreads--;
    }
}

// --- 4. QUẢN LÝ ---
async function main() {
    await fetchProxies();
    setInterval(async () => { if (proxyList.length < 50) await fetchProxies(); }, 60000);

    while (true) {
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
            await new Promise(r => setTimeout(r, 3000)); 
        } else {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

// --- 5. GIAO DIỆN MONITOR ---
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:sans-serif; background:#0a0a0a; color:#eee; padding:20px; margin:0;">
            <div style="background:#111; padding:20px; border-bottom:3px solid #ff0000; position:sticky; top:0; z-index:100;">
                <h1 style="margin:0; color:#ff0000; display:flex; justify-content:space-between; align-items:center;">
                    YT INFINITE REPLAY
                    <span style="font-size:14px; color:#aaa;">Uptime: ${Math.floor((Date.now()-startTime)/60000)}m</span>
                </h1>
                <div style="display:grid; grid-template-columns: repeat(5, 1fr); gap:10px; margin-top:15px;">
                    <div style="background:#222; padding:10px; border-radius:5px; text-align:center; border: 1px solid #333;">
                        <div style="font-size:11px; color:#888;">TỔNG VIEWS</div>
                        <b style="font-size:18px; color:#2ed573;">${stats.totalViews}</b>
                    </div>
                    <div style="background:#222; padding:10px; border-radius:5px; text-align:center; border: 1px solid #333;">
                        <div style="font-size:11px; color:#888;">WATCH TIME</div>
                        <b style="font-size:18px; color:#70a1ff;">${formatTime(stats.totalWatchSeconds)}</b>
                    </div>
                    <div style="background:#222; padding:10px; border-radius:5px; text-align:center; border: 1px solid #333;">
                        <div style="font-size:11px; color:#888;">KHO PROXY</div>
                        <b style="font-size:18px; color:#eccc68;">${proxyList.length}</b>
                    </div>
                    <div style="background:#222; padding:10px; border-radius:5px; text-align:center; border: 1px solid #333;">
                        <div style="font-size:11px; color:#888;">LUỒNG</div>
                        <b style="font-size:18px; color:#ff7f50;">${stats.activeThreads}/${MAX_THREADS}</b>
                    </div>
                    <div style="background:#222; padding:10px; border-radius:5px; text-align:center; border: 1px solid #333;">
                        <div style="font-size:11px; color:#888;">IP ĐÃ DIE</div>
                        <b style="font-size:18px; color:#ff4757;">${stats.proxiesFailed}</b>
                    </div>
                </div>
            </div>

            <div style="padding:20px;">
                <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap:15px;">
                    ${Object.entries(stats.threadStatus).map(([id, t]) => `
                        <div style="background:#1a1a1a; border:1px solid #333; padding:15px; border-radius:8px; position:relative;">
                            <div style="position:absolute; top:10px; right:10px; font-size:10px; color:#2ed573; background:#000; padding:2px 5px; border-radius:3px;">
                                📶 ${t.ping}ms
                            </div>
                            <div style="display:flex; flex-direction:column; margin-bottom:10px;">
                                <b style="color:#2ed573; font-size:14px;">🆔 ${id} - ${t.location}</b>
                                <span style="font-size:11px; color:#777;">IP: ${t.proxy}</span>
                            </div>
                            <div style="font-size:13px; height:35px; overflow:hidden; color:#fff; border-left: 2px solid #ff0000; padding-left:10px;">
                                🎬 <b>[#${t.iteration}]</b> ${t.videoTitle}
                            </div>
                            <div style="background:#000; height:6px; border-radius:3px; margin:12px 0;">
                                <div style="width:${(t.elapsed/t.target)*100}%; background:linear-gradient(to right, #ff4757, #2ed573); height:100%; border-radius:3px;"></div>
                            </div>
                            <div style="display:flex; justify-content:space-between; font-size:11px;">
                                <span style="color:#eccc68; font-weight:bold;">${t.status}</span>
                                <span>${t.elapsed}/${t.target}s</span>
                            </div>
                        </div>
                    `).join('')}
                </div>

                <h3 style="color:#eccc68; margin-top:30px;">📜 LOG HỆ THỐNG:</h3>
                <div style="background:#000; border:1px solid #333; padding:15px; border-radius:8px; height:300px; overflow-y:auto; font-family:monospace; color:#00ff41; font-size:12px; line-height:1.6;">
                    ${stats.logs.map(line => `<div>${line}</div>`).join('')}
                </div>
            </div>
            <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
    `);
});

app.listen(port, () => { 
    console.log(`🚀 Monitor đang chạy tại http://localhost:${port}`);
    main(); 
});
