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

// --- 1. CHECK PROXY INFO ---
async function getProxyInfo(proxy) {
    const start = Date.now();
    try {
        const parts = proxy.split(':');
        const res = await axios.get('http://ip-api.com/json', {
            proxy: { host: parts[0], port: parseInt(parts[1]) },
            timeout: 5000
        });
        return {
            location: `${res.data.countryCode} - ${res.data.city}`,
            ping: Date.now() - start
        };
    } catch (e) {
        return { location: 'Global', ping: '>5000' };
    }
}

// --- 2. SIÊU CÔNG CỤ QUÉT PROXY (110+ SOURCES) ---
async function fetchProxies() {
    fullLog('📡 Đang tổng lực càn quét 110+ nguồn Proxy toàn cầu...', 'SYSTEM');
    
    const sources = [
        // --- NHÓM 1: API CHÍNH ---
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://api.openproxylist.xyz/http.txt',
        'https://proxyspace.pro/http.txt',
        'https://www.proxy-list.download/api/v1/get?type=http',
        'https://www.proxyscan.io/download?type=http',
        'https://pubproxy.com/api/proxy?limit=20&format=txt',

        // --- NHÓM 2: GITHUB ELITE (CẬP NHẬT LIÊN TỤC) ---
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
        'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt',
        'https://raw.githubusercontent.com/proxy4parsing/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/andriy67/Proxy-List/master/proxy-list.txt',
        'https://raw.githubusercontent.com/jetkai/proxy-list/main/archive/proxies.txt',
        'https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/http.txt',
        'https://raw.githubusercontent.com/Ch4r1l3/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/UptimerBot/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
        'https://raw.githubusercontent.com/vakhov/proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/Tuan-v/Proxy-list/main/proxy-list.txt',
        'https://raw.githubusercontent.com/opsxcq/proxy-list/master/list.txt',
        'https://raw.githubusercontent.com/HyperBeats/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/roma8624/proxy_list/main/http.txt',
        'https://raw.githubusercontent.com/ObcbS007/proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/Anonym0usWork12/Free-Proxy/master/proxy.txt',
        'https://raw.githubusercontent.com/RX404/Proxy-List/master/http.txt',
        'https://raw.githubusercontent.com/hendrikbgr/Free-Proxy-Repo/master/proxy_list.txt',
        'https://raw.githubusercontent.com/r0075h3ll/Proxy-List/master/http.txt',
        'https://raw.githubusercontent.com/elliot404/free-proxies/main/proxy_list.txt',
        'https://raw.githubusercontent.com/themiralay/Proxy-List-World/master/http.txt',
        'https://raw.githubusercontent.com/almroot/proxylist/master/list.txt',
        'https://raw.githubusercontent.com/as08/proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/Volodky/Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/yemreay/proxy-list/main/proxies/http.txt',

        // --- NHÓM 3: 50+ NGUỒN BỔ SUNG MỚI (X100 POWER) ---
        'https://raw.githubusercontent.com/Miveon/Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/http.txt',
        'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http_checked.txt',
        'https://raw.githubusercontent.com/Zaeem20/free-proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/prx77/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/I_The_P_I/Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/saisuiu/Lion_proxy_list/main/proxy.txt',
        'https://raw.githubusercontent.com/Kuept-one/Proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/vakhov/proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/Tuan-v/Proxy-list/main/proxy-list.txt',
        'https://raw.githubusercontent.com/Zaeem20/free-proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/http.txt',
        'https://raw.githubusercontent.com/ylucas07/Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/ArisA6/Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/Duv7/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/Ch4r1l3/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/Seven945/proxy-list/main/proxy.txt',
        'https://raw.githubusercontent.com/Vann-Dev/proxy-list/main/proxies.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies_anonymous/http.txt',
        'https://raw.githubusercontent.com/ToXic-Sama/Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/AnisYousfi/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/joxatone/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/officialputuid/Free-Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies_anonymous/http.txt',
        'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
        'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated_proxies.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/https.txt',
        'https://raw.githubusercontent.com/proxy4parsing/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTP_RAW.txt',
        'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt',
        'https://raw.githubusercontent.com/Zaeem20/free-proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/B4RC0DE-7/proxy-list/main/HTTP.txt',
        'https://raw.githubusercontent.com/ObcbS007/proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/HyperBeats/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/http.txt',
        'https://raw.githubusercontent.com/Zaeem20/free-proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/mmpx12/proxy-list/master/https.txt',
        'https://raw.githubusercontent.com/opsxcq/proxy-list/master/list.txt',
        'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
        'https://www.proxy-list.download/api/v1/get?type=https',
        'https://alexa.lr2b.com/proxylist.txt',
        'http://rootjazz.com/proxies/proxies.txt',
        'https://multiproxy.org/txt_all/proxy.txt',
        'https://proxy-spider.com/api/proxies.example.txt',
        'http://proxysearcher.sourceforge.net/Proxy%20List.php?type=http',
        'https://api.proxyscrape.com/?request=displayproxies&proxytype=http',
        'https://www.my-proxy.com/free-proxy-list.html',
        'https://free-proxy-list.net/'
    ];

    let combinedData = "";
    // Chia nhỏ mảng nguồn để tránh bị treo khi fetch quá nhiều cùng lúc
    for (let i = 0; i < sources.length; i += 20) {
        const batch = sources.slice(i, i + 20);
        const results = await Promise.allSettled(
            batch.map(url => axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }))
        );
        results.forEach(res => {
            if (res.status === 'fulfilled' && typeof res.value.data === 'string') {
                combinedData += res.value.data + "\n";
            }
        });
    }

    const found = combinedData.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}\b/g);
    
    if (found) {
        const uniqueProxies = [...new Set(found)].filter(p => !blacklist.has(p));
        proxyList = uniqueProxies.sort(() => Math.random() - 0.5);
        stats.proxyReady = proxyList.length;
        fullLog(`🔥 TỔNG LỰC: Đã nạp ${proxyList.length} Proxy độc nhất!`, 'SUCCESS');
    }
}

// --- 3. LUỒNG XỬ LÝ VIDEO ---
async function runWorker(proxy) {
    stats.activeThreads++;
    const id = Math.random().toString(36).substring(7).toUpperCase();
    const userDataDir = path.join(__dirname, 'temp', `profile_${id}`);
    
    const info = await getProxyInfo(proxy);

    stats.threadStatus[id] = { 
        proxy, location: info.location, ping: info.ping,
        videoTitle: 'Đang mở browser...', iteration: 0, 
        elapsed: 0, target: 0, status: '🚀 LIVE' 
    };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir,
            args: [
                `--proxy-server=http://${proxy}`, 
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas', '--disable-gpu', '--mute-audio'
            ]
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
        
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        // REPLAY VÔ CỰC CHO ĐẾN KHI IP CHẾT
        while (true) {
            stats.threadStatus[id].status = '📂 Nạp Playlist';
            await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2', timeout: 60000 });
            
            const videoLinks = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
                return [...new Set(links.map(a => a.href.split('&')[0]))]; 
            });

            if (!videoLinks || videoLinks.length === 0) throw new Error("Không thể load nội dung qua IP này");

            for (let i = 0; i < videoLinks.length; i++) {
                stats.threadStatus[id].iteration++;
                await page.goto(videoLinks[i], { waitUntil: 'networkidle2', timeout: 60000 });
                
                const title = await page.title();
                stats.threadStatus[id].videoTitle = title.replace('- YouTube', '').trim();
                stats.threadStatus[id].status = '📺 Đang xem';
                
                const watchSeconds = Math.floor(Math.random() * 61) + 120; // 2-3 phút
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
        fullLog(`[ID:${id}] IP Ngừng hoạt động: ${err.message}`, 'FAILED');
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
    setInterval(async () => { if (proxyList.length < 2000) await fetchProxies(); }, 300000);

    while (true) {
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
            await new Promise(r => setTimeout(r, 3000)); 
        } else {
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

// --- 5. MONITOR UI ---
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:sans-serif; background:#080808; color:#eee; padding:20px; margin:0;">
            <div style="background:#111; padding:20px; border-bottom:3px solid #ff0000; position:sticky; top:0; z-index:100;">
                <h1 style="margin:0; color:#ff0000; display:flex; justify-content:space-between; align-items:center;">
                    YT BOT PRO - 110+ SOURCES
                    <span style="font-size:14px; color:#aaa;">Uptime: ${Math.floor((Date.now()-startTime)/60000)}m</span>
                </h1>
                <div style="display:grid; grid-template-columns: repeat(5, 1fr); gap:10px; margin-top:15px;">
                    <div style="background:#1a1a1a; padding:15px; border-radius:5px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888;">TỔNG VIEWS</div>
                        <b style="font-size:20px; color:#2ed573;">${stats.totalViews}</b>
                    </div>
                    <div style="background:#1a1a1a; padding:15px; border-radius:5px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888;">WATCH TIME</div>
                        <b style="font-size:20px; color:#70a1ff;">${formatTime(stats.totalWatchSeconds)}</b>
                    </div>
                    <div style="background:#1a1a1a; padding:15px; border-radius:5px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888;">KHO ĐẠN PROXY</div>
                        <b style="font-size:20px; color:#eccc68;">${proxyList.length}</b>
                    </div>
                    <div style="background:#1a1a1a; padding:15px; border-radius:5px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888;">LUỒNG ĐANG CHẠY</div>
                        <b style="font-size:20px; color:#ff7f50;">${stats.activeThreads}/${MAX_THREADS}</b>
                    </div>
                    <div style="background:#1a1a1a; padding:15px; border-radius:5px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888;">IP ĐÃ DIE</div>
                        <b style="font-size:20px; color:#ff4757;">${stats.proxiesFailed}</b>
                    </div>
                </div>
            </div>

            <div style="padding:20px;">
                <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap:15px;">
                    ${Object.entries(stats.threadStatus).map(([id, t]) => `
                        <div style="background:#121212; border:1px solid #222; padding:15px; border-radius:8px; border-left: 4px solid #ff0000;">
                            <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                                <b style="color:#2ed573;">🆔 ${id} [${t.location}]</b>
                                <span style="font-size:11px; color:#888;">📶 ${t.ping}ms</span>
                            </div>
                            <div style="font-size:13px; height:32px; overflow:hidden; color:#fff; font-weight:bold;">
                                🎬 [#${t.iteration}] ${t.videoTitle}
                            </div>
                            <div style="background:#000; height:8px; border-radius:4px; margin:12px 0; border:1px solid #333;">
                                <div style="width:${(t.elapsed/t.target)*100}%; background:linear-gradient(90deg, #ff0000, #2ed573); height:100%; border-radius:4px;"></div>
                            </div>
                            <div style="display:flex; justify-content:space-between; font-size:12px;">
                                <span style="color:#eccc68; text-transform:uppercase;">● ${t.status}</span>
                                <span>${t.elapsed}/${t.target}s</span>
                            </div>
                        </div>
                    `).join('')}
                </div>

                <h3 style="color:#eccc68; margin-top:30px;">📜 NHẬT KÝ CHIẾN TRƯỜNG:</h3>
                <div style="background:#000; border:1px solid #222; padding:15px; border-radius:8px; height:350px; overflow-y:auto; font-family:monospace; color:#00ff41; font-size:12px; line-height:1.5;">
                    ${stats.logs.map(line => `<div>${line}</div>`).join('')}
                </div>
            </div>
            <script>setTimeout(() => location.reload(), 4000)</script>
        </body>
    `);
});

app.listen(port, () => { 
    console.log(`Bot đã sẵn sàng! Truy cập http://localhost:${port}`);
    main(); 
});
