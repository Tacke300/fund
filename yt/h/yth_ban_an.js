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

// --- 1. LẤY THÔNG TIN VỊ TRÍ & PING CỦA PROXY ---
async function getProxyInfo(proxy) {
    const start = Date.now();
    try {
        const parts = proxy.split(':');
        const res = await axios.get('http://ip-api.com/json', {
            proxy: { host: parts[0], port: parseInt(parts[1]) },
            timeout: 7000
        });
        return {
            location: `${res.data.country || 'Unknown'} (${res.data.countryCode || '??'})`,
            city: res.data.city || 'Unknown City',
            ping: Date.now() - start
        };
    } catch (e) {
        return { location: 'Bypass/Global', city: 'Unknown', ping: '>7000' };
    }
}

// --- 2. SIÊU CÔNG CỤ QUÉT PROXY (LIÊM KHIẾT 160+ NGUỒN) ---
async function fetchProxies() {
    fullLog('📡 Đang tổng lực càn quét hơn 160 nguồn Proxy toàn cầu...', 'SYSTEM');
    
    const sources = [
        // --- API & WEB SOURCES ---
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://api.openproxylist.xyz/http.txt',
        'https://proxyspace.pro/http.txt',
        'https://www.proxy-list.download/api/v1/get?type=http',
        'https://www.proxyscan.io/download?type=http',
        'https://pubproxy.com/api/proxy?limit=20&format=txt',
        'https://alexa.lr2b.com/proxylist.txt',
        'https://multiproxy.org/txt_all/proxy.txt',
        'https://proxy-spider.com/api/proxies.example.txt',

        // --- GITHUB REPO BATCH 1 ---
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
        'https://raw.githubusercontent.com/SPranshu30/free-proxy-list/main/http.txt',
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
        'https://raw.githubusercontent.com/Miveon/Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/prx77/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/saisuiu/Lion_proxy_list/main/proxy.txt',
        'https://raw.githubusercontent.com/Kuept-one/Proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/Seven945/proxy-list/main/proxy.txt',
        'https://raw.githubusercontent.com/Vann-Dev/proxy-list/main/proxies.txt',
        'https://raw.githubusercontent.com/ToXic-Sama/Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/AnisYousfi/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/joxatone/proxy-list/main/http.txt',

        // --- GITHUB REPO BATCH 2 (THÊM 100 NGUỒN MỚI) ---
        'https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/http.txt',
        'https://raw.githubusercontent.com/ylucas07/Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/ArisA6/Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/Duv7/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/TheSpeedX/ProxyList/master/http.txt',
        'https://raw.githubusercontent.com/proxy4parsing/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies_anonymous/http.txt',
        'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies_anonymous/http.txt',
        'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated_proxies.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/https.txt',
        'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTP_RAW.txt',
        'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt',
        'https://raw.githubusercontent.com/Zaeem20/free-proxy-list/master/https.txt',
        'https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/https.txt',
        'https://raw.githubusercontent.com/HyperBeats/proxy-list/main/https.txt',
        'https://raw.githubusercontent.com/mmpx12/proxy-list/master/https.txt',
        'https://raw.githubusercontent.com/officialputuid/Free-Proxy-List/main/https.txt',
        'https://raw.githubusercontent.com/vakhov/proxy-list/master/https.txt',
        'https://raw.githubusercontent.com/Anonym0usWork12/Free-Proxy/master/https.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt',
        'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
        'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/socks5.txt',
        'https://raw.githubusercontent.com/Zaeem20/free-proxy-list/master/socks5.txt',
        'https://raw.githubusercontent.com/officialputuid/Free-Proxy-List/main/socks5.txt',
        'https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks5.txt',
        'https://raw.githubusercontent.com/B4RC0DE-7/proxy-list/main/SOCKS5.txt',
        'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/socks5.txt',
        'https://raw.githubusercontent.com/manuGMG/proxy-365/main/SOCKS5.txt',
        'https://raw.githubusercontent.com/UptimerBot/proxy-list/main/proxies/socks5.txt',
        'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt',
        'https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/socks5.txt',
        'https://raw.githubusercontent.com/HyperBeats/proxy-list/main/socks5.txt',
        'https://raw.githubusercontent.com/Vann-Dev/proxy-list/main/socks5.txt',
        'https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt',
        'https://raw.githubusercontent.com/yemreay/proxy-list/main/proxies/socks5.txt',
        'https://raw.githubusercontent.com/saschyg93/V2Ray-Config-Directory/main/SOCKS5_RAW.txt',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks4.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks4.txt',
        'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/socks4.txt',
        'https://raw.githubusercontent.com/Zaeem20/free-proxy-list/master/socks4.txt',
        'https://raw.githubusercontent.com/officialputuid/Free-Proxy-List/main/socks4.txt',
        'https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks4.txt',
        'https://raw.githubusercontent.com/B4RC0DE-7/proxy-list/main/SOCKS4.txt',
        'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/socks4.txt',
        'https://raw.githubusercontent.com/UptimerBot/proxy-list/main/proxies/socks4.txt',
        'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks4/data.txt',
        'https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/socks4.txt',
        'https://raw.githubusercontent.com/HyperBeats/proxy-list/main/socks4.txt',
        'https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS4_RAW.txt',
        'https://raw.githubusercontent.com/jetkai/proxy-list/main/archive/proxies-socks4.txt',
        'https://raw.githubusercontent.com/vakhov/proxy-list/master/socks4.txt',
        'https://raw.githubusercontent.com/Tuan-v/Proxy-list/main/socks4.txt',
        'https://raw.githubusercontent.com/Anonym0usWork12/Free-Proxy/master/socks4.txt',
        'https://raw.githubusercontent.com/RX404/Proxy-List/master/socks4.txt',
        'https://raw.githubusercontent.com/yemreay/proxy-list/main/proxies/socks4.txt',
        'https://raw.githubusercontent.com/hookzof/socks4_list/master/proxy.txt',
        'https://raw.githubusercontent.com/TheSpeedX/ProxyList/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
        'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/Zaeem20/free-proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/officialputuid/Free-Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/B4RC0DE-7/proxy-list/main/HTTP.txt',
        'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt',
        'https://raw.githubusercontent.com/UptimerBot/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt',
        'https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/http.txt',
        'https://raw.githubusercontent.com/HyperBeats/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
        'https://raw.githubusercontent.com/jetkai/proxy-list/main/archive/proxies-http.txt',
        'https://raw.githubusercontent.com/vakhov/proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/Tuan-v/Proxy-list/main/proxy-list.txt',
        'https://raw.githubusercontent.com/Anonym0usWork12/Free-Proxy/master/proxy.txt',
        'https://raw.githubusercontent.com/RX404/Proxy-List/master/http.txt',
        'https://raw.githubusercontent.com/yemreay/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/SPranshu30/free-proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
        'https://raw.githubusercontent.com/Tuan-v/Proxy-list/main/proxy-list.txt',
        'https://raw.githubusercontent.com/opsxcq/proxy-list/master/list.txt',
        'https://raw.githubusercontent.com/AnisYousfi/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/joxatone/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/Seven945/proxy-list/main/proxy.txt',
        'https://raw.githubusercontent.com/Vann-Dev/proxy-list/main/proxies.txt',
        'https://raw.githubusercontent.com/ToXic-Sama/Proxy-List/main/http.txt'
    ];

    let combinedData = "";
    // Fetch theo cụm 30 để tối ưu tốc độ
    for (let i = 0; i < sources.length; i += 30) {
        const batch = sources.slice(i, i + 30);
        const results = await Promise.allSettled(batch.map(url => axios.get(url, { timeout: 15000 })));
        results.forEach(res => { if (res.status === 'fulfilled') combinedData += res.value.data + "\n"; });
    }

    const found = combinedData.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}\b/g);
    if (found) {
        proxyList = [...new Set(found)].filter(p => !blacklist.has(p)).sort(() => Math.random() - 0.5);
        stats.proxyReady = proxyList.length;
        fullLog(`🔥 TỔNG LỰC: Đã quét được ${proxyList.length} Proxy từ 160+ nguồn!`, 'SUCCESS');
    }
}

// --- 3. LUỒNG XỬ LÝ (CHẠY VÔ CỰC CHO TỚI KHI IP CHẾT) ---
async function runWorker(proxy) {
    stats.activeThreads++;
    const id = Math.random().toString(36).substring(7).toUpperCase();
    const userDataDir = path.join(__dirname, 'temp', `profile_${id}`);
    
    // Check Ping và Vị trí thực tế của Proxy
    const info = await getProxyInfo(proxy);

    stats.threadStatus[id] = { 
        proxy, 
        location: info.location, 
        city: info.city,
        ping: info.ping,
        videoTitle: 'Mở browser...', 
        iteration: 0, 
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
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0');
        
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        while (true) { // Replay vô cực
            stats.threadStatus[id].status = '📂 Load Playlist';
            await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2', timeout: 60000 });
            
            const videoLinks = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
                return [...new Set(links.map(a => a.href.split('&')[0]))]; 
            });

            if (!videoLinks || videoLinks.length === 0) throw new Error("Proxy không tải được Playlist");

            for (let i = 0; i < videoLinks.length; i++) {
                stats.threadStatus[id].iteration++;
                await page.goto(videoLinks[i], { waitUntil: 'networkidle2', timeout: 60000 });
                
                stats.threadStatus[id].videoTitle = (await page.title()).replace('- YouTube', '').trim();
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
        fullLog(`[ID:${id}] Proxy die: ${err.message}`, 'FAILED');
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
    setInterval(async () => { if (proxyList.length < 5000) await fetchProxies(); }, 600000);

    while (true) {
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
            await new Promise(r => setTimeout(r, 3000)); 
        } else {
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

// --- 5. GIAO DIỆN MONITOR CHUYÊN NGHIỆP ---
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background:#050505; color:#eee; padding:20px; margin:0;">
            <div style="background:#111; padding:20px; border-bottom:5px solid #ff0000; position:sticky; top:0; z-index:100;">
                <h1 style="margin:0; color:#ff0000; display:flex; justify-content:space-between; align-items:center; text-shadow: 0 0 10px rgba(255,0,0,0.5);">
                    YOUTUBE BOT BUFF VIEW
                    <span style="font-size:14px; color:#aaa; font-weight:normal;">Uptime: ${Math.floor((Date.now()-startTime)/60000)} phút</span>
                </h1>
                <div style="display:grid; grid-template-columns: repeat(5, 1fr); gap:15px; margin-top:20px;">
                    <div style="background:#1a1a1a; padding:15px; border-radius:10px; text-align:center; border:1px solid #333; box-shadow: 0 4px 6px rgba(0,0,0,0.3);">
                        <div style="font-size:11px; color:#888; margin-bottom:5px;">TỔNG VIEWS</div>
                        <b style="font-size:24px; color:#2ed573;">${stats.totalViews}</b>
                    </div>
                    <div style="background:#1a1a1a; padding:15px; border-radius:10px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888; margin-bottom:5px;">GIỜ XEM</div>
                        <b style="font-size:24px; color:#70a1ff;">${formatTime(stats.totalWatchSeconds)}</b>
                    </div>
                    <div style="background:#1a1a1a; padding:15px; border-radius:10px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888; margin-bottom:5px;">KHO PROXY</div>
                        <b style="font-size:24px; color:#eccc68;">${proxyList.length}</b>
                    </div>
                    <div style="background:#1a1a1a; padding:15px; border-radius:10px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888; margin-bottom:5px;">LUỒNG CHẠY</div>
                        <b style="font-size:24px; color:#ff7f50;">${stats.activeThreads}/${MAX_THREADS}</b>
                    </div>
                    <div style="background:#1a1a1a; padding:15px; border-radius:10px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888; margin-bottom:5px;">IP DIE</div>
                        <b style="font-size:24px; color:#ff4757;">${stats.proxiesFailed}</b>
                    </div>
                </div>
            </div>

            <div style="padding:20px;">
                <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap:15px;">
                    ${Object.entries(stats.threadStatus).map(([id, t]) => `
                        <div style="background:#121212; border:1px solid #222; padding:18px; border-radius:12px; position:relative; overflow:hidden;">
                            <div style="position:absolute; top:0; left:0; width:100%; height:4px; background:#2ed573;"></div>
                            
                            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
                                <div>
                                    <b style="color:#2ed573; font-size:18px;">ID: ${id}</b><br>
                                    <small style="color:#666; font-family:monospace;">${t.proxy}</small>
                                </div>
                                <div style="text-align:right;">
                                    <span style="background:#ff4757; color:#fff; padding:3px 8px; border-radius:5px; font-size:11px; font-weight:bold;">📶 ${t.ping}ms</span>
                                </div>
                            </div>
                            
                            <div style="background:#1a1a1a; padding:12px; border-radius:8px; margin-bottom:12px; border:1px solid #333;">
                                <div style="font-size:11px; color:#888; text-transform:uppercase; margin-bottom:4px;">📍 Vị trí IP:</div>
                                <div style="font-size:13px; color:#eccc68; font-weight:bold; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                                    ${t.location} - ${t.city}
                                </div>
                            </div>

                            <div style="font-size:13px; color:#fff; margin-bottom:12px; height:34px; line-height:1.3; overflow:hidden;">
                                <span style="color:#ff7f50;">🎬 [#${t.iteration}]</span> ${t.videoTitle}
                            </div>

                            <div style="background:#000; height:10px; border-radius:5px; margin-bottom:12px; border:1px solid #222;">
                                <div style="width:${(t.elapsed/t.target)*100}%; background:linear-gradient(90deg, #ff0000, #2ed573); height:100%; border-radius:5px; transition: width 0.5s;"></div>
                            </div>

                            <div style="display:flex; justify-content:space-between; font-size:12px; font-weight:bold;">
                                <span style="color:#2ed573; text-transform:uppercase;">● ${t.status}</span>
                                <span style="color:#aaa;">${t.elapsed}s / ${t.target}s</span>
                            </div>
                        </div>
                    `).join('')}
                </div>

                <h3 style="color:#eccc68; margin-top:30px; border-bottom: 2px solid #333; padding-bottom:10px; display:flex; align-items:center;">
                    📜 NHẬT KÝ CHIẾN TRƯỜNG
                </h3>
                <div style="background:#000; border:1px solid #222; padding:15px; border-radius:10px; height:350px; overflow-y:auto; font-family:'Courier New', Courier, monospace; color:#00ff41; font-size:13px; line-height:1.6;">
                    ${stats.logs.map(line => `<div>${line}</div>`).join('')}
                </div>
            </div>
            <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
    `);
});

app.listen(port, () => { 
    console.log(`\n========================================`);
    console.log(`🚀 YOUTUBE BOT BUFF VIEW ĐÃ KHỞI CHẠY`);
    console.log(`🌐 Monitor: http://localhost:${port}`);
    console.log(`========================================\n`);
    main(); 
});
