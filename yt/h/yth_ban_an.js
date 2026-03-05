const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

const countryMap = {
    'VN': { name: 'Việt Nam', flag: '🇻🇳' },
    'US': { name: 'Mỹ', flag: '🇺🇸' },
    'CN': { name: 'Trung Quốc', flag: '🇨🇳' },
    'JP': { name: 'Nhật Bản', flag: '🇯🇵' },
    'KR': { name: 'Hàn Quốc', flag: '🇰🇷' },
    'DE': { name: 'Đức', flag: '🇩🇪' },
    'FR': { name: 'Pháp', flag: '🇫🇷' },
    'GB': { name: 'Anh', flag: '🇬🇧' },
    'CA': { name: 'Canada', flag: '🇨🇦' },
    'RU': { name: 'Nga', flag: '🇷🇺' },
    'SG': { name: 'Singapore', flag: '🇸🇬' },
    'TH': { name: 'Thái Lan', flag: '🇹🇭' },
    'IN': { name: 'Ấn Độ', flag: '🇮🇳' },
    'BR': { name: 'Brazil', flag: '🇧🇷' },
    'AU': { name: 'Úc', flag: '🇦🇺' },
    'HK': { name: 'Hồng Kông', flag: '🇭🇰' },
    'TW': { name: 'Đài Loan', flag: '🇹🇼' },
    'ID': { name: 'Indonesia', flag: '🇮🇩' },
    'MY': { name: 'Malaysia', flag: '🇲🇾' },
    'PH': { name: 'Philippines', flag: '🇵🇭' },
    'NL': { name: 'Hà Lan', flag: '🇳🇱' },
    'IT': { name: 'Ý', flag: '🇮🇹' },
    'ES': { name: 'Tây Ban Nha', flag: '🇪🇸' },
    'PL': { name: 'Ba Lan', flag: '🇵🇱' },
    'UA': { name: 'Ukraine', flag: '🇺🇦' }
};

const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 24; 
const startTime = Date.now();

let stats = {
    totalViews: 0,
    totalWatchSeconds: 0,
    activeThreads: 0,
    proxiesFailed: 0,
    proxyReady: 0,
    checkingQueue: 0,
    threadStatus: {}, 
    logs: [] 
};

let blacklist = new Set();
let rawProxyList = [];
let verifiedProxyList = [];

if (fs.existsSync(path.join(__dirname, 'temp'))) fs.removeSync(path.join(__dirname, 'temp'));

function fullLog(msg, type = 'INFO') {
    const logMsg = `[${new Date().toLocaleTimeString()}] [${type}] ${msg}`;
    stats.logs.unshift(logMsg);
    if (stats.logs.length > 100) stats.logs.pop();
}

async function getProxyDetails(proxy) {
    const start = Date.now();
    try {
        const parts = proxy.split(':');
        const res = await axios.get('http://ip-api.com/json', {
            proxy: { host: parts[0], port: parseInt(parts[1]) },
            timeout: 5000 
        });
        const code = res.data.countryCode;
        const info = countryMap[code] || { name: res.data.country || 'Nước Khác', flag: '🌐' };
        return { displayName: `${info.flag} ${info.name}`, ping: Date.now() - start };
    } catch (e) {
        return { displayName: '🌐 Quốc Tế', ping: '>999' };
    }
}

async function fetchProxies() {
    fullLog('📡 Đang quét toàn bộ 500+ nguồn Proxy...', 'SYSTEM');
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://api.openproxylist.xyz/http.txt',
        'https://proxyspace.pro/http.txt',
        'https://www.proxy-list.download/api/v1/get?type=http',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
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
        'https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/http.txt',
        'https://raw.githubusercontent.com/ylucas07/Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/ArisA6/Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/Duv7/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/Seven945/proxy-list/main/proxy.txt',
        'https://raw.githubusercontent.com/Vann-Dev/proxy-list/main/proxies.txt',
        'https://raw.githubusercontent.com/ToXic-Sama/Proxy-List/main/http.txt',
        'https://raw.githubusercontent.com/AnisYousfi/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/joxatone/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks4.txt',
        'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
        'https://proxyspace.pro/https.txt',
        'https://proxyspace.pro/socks4.txt',
        'https://proxyspace.pro/socks5.txt',
        'https://raw.githubusercontent.com/manuGMG/proxy-365/main/SOCKS5.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies_anonymous/http.txt',
        'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated_proxies.txt'
    ];

    let combinedData = "";
    for (let i = 0; i < sources.length; i += 40) {
        const batch = sources.slice(i, i + 40);
        const results = await Promise.allSettled(batch.map(url => axios.get(url, { timeout: 15000 })));
        results.forEach(res => { if (res.status === 'fulfilled') combinedData += res.value.data + "\n"; });
    }

    const found = combinedData.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}\b/g);
    if (found) {
        const unique = [...new Set(found)].filter(p => !blacklist.has(p));
        rawProxyList = unique.sort(() => Math.random() - 0.5);
        fullLog(`🔥 Đã thu thập ${rawProxyList.length} Proxy thô. Bắt đầu lọc...`, 'SYSTEM');
    }
}

async function fastCheckProxy() {
    while (true) {
        if (rawProxyList.length > 0 && verifiedProxyList.length < 500) {
            const batch = rawProxyList.splice(0, 50);
            stats.checkingQueue = rawProxyList.length;
            
            await Promise.all(batch.map(async (proxy) => {
                const parts = proxy.split(':');
                try {
                    await axios.get('http://www.google.com', {
                        proxy: { host: parts[0], port: parseInt(parts[1]) },
                        timeout: 3500
                    });
                    if (!verifiedProxyList.includes(proxy)) {
                        verifiedProxyList.push(proxy);
                        stats.proxyReady = verifiedProxyList.length;
                    }
                } catch (e) {
                    blacklist.add(proxy);
                }
            }));
        }
        await new Promise(r => setTimeout(r, 1000));
    }
}

async function runWorker(proxy) {
    stats.activeThreads++;
    const id = Math.random().toString(36).substring(7).toUpperCase();
    const userDataDir = path.join(__dirname, 'temp', `profile_${id}`);
    
    const details = await getProxyDetails(proxy);

    stats.threadStatus[id] = { 
        proxy, 
        locationStr: details.displayName, 
        ping: details.ping,
        videoTitle: 'Đang kết nối...', 
        iteration: 0, 
        elapsed: 0, 
        target: 0, 
        status: '🚀 KHỞI ĐỘNG' 
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
        
        while (true) {
            stats.threadStatus[id].status = '📂 Nạp Playlist';
            await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2', timeout: 45000 });
            
            const videoLinks = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
                return [...new Set(links.map(a => a.href.split('&')[0]))]; 
            });

            if (!videoLinks || videoLinks.length === 0) throw new Error("Proxy không tải được nội dung");

            for (let link of videoLinks) {
                stats.threadStatus[id].iteration++;
                const pStart = Date.now();
                await page.goto(link, { waitUntil: 'networkidle2', timeout: 45000 });
                
                stats.threadStatus[id].ping = Date.now() - pStart;
                stats.threadStatus[id].videoTitle = (await page.title()).replace('- YouTube', '').trim();
                stats.threadStatus[id].status = '📺 Đang Buff';
                
                const watchSeconds = Math.floor(Math.random() * 60) + 120;
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
        fullLog(`[ID:${id}] Ngừng: ${err.message}`, 'FAILED');
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        delete stats.threadStatus[id];
        stats.activeThreads--;
    }
}

app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:'Segoe UI', Tahoma, sans-serif; background:#050505; color:#eee; padding:20px; margin:0;">
            <div style="background:#111; padding:20px; border-bottom:5px solid #ff0000; position:sticky; top:0; z-index:100;">
                <h1 style="margin:0; color:#ff0000; display:flex; justify-content:space-between; align-items:center; text-shadow: 0 0 10px rgba(255,0,0,0.5);">
                    YOUTUBE BOT BUFF VIEW (OPTIMIZED)
                    <span style="font-size:14px; color:#aaa; font-weight:normal;">Uptime: ${Math.floor((Date.now()-startTime)/60000)}m</span>
                </h1>
                <div style="display:grid; grid-template-columns: repeat(6, 1fr); gap:15px; margin-top:20px;">
                    <div style="background:#1a1a1a; padding:15px; border-radius:10px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888; margin-bottom:5px;">TỔNG VIEWS</div>
                        <b style="font-size:24px; color:#2ed573;">${stats.totalViews}</b>
                    </div>
                    <div style="background:#1a1a1a; padding:15px; border-radius:10px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888; margin-bottom:5px;">GIỜ XEM</div>
                        <b style="font-size:24px; color:#70a1ff;">${Math.floor(stats.totalWatchSeconds/60)}m</b>
                    </div>
                    <div style="background:#1a1a1a; padding:15px; border-radius:10px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888; margin-bottom:5px;">PROXY SỐNG</div>
                        <b style="font-size:24px; color:#eccc68;">${verifiedProxyList.length}</b>
                    </div>
                    <div style="background:#1a1a1a; padding:15px; border-radius:10px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888; margin-bottom:5px;">ĐANG LỌC</div>
                        <b style="font-size:24px; color:#a29bfe;">${stats.checkingQueue}</b>
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
                <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap:15px;">
                    ${Object.entries(stats.threadStatus).map(([id, t]) => `
                        <div style="background:#121212; border:1px solid #222; padding:15px; border-radius:10px; position:relative; overflow:hidden;">
                            <div style="position:absolute; top:0; left:0; width:100%; height:3px; background:#2ed573;"></div>
                            <div style="display:flex; justify-content:space-between; margin-bottom:10px;">
                                <b style="color:#2ed573; font-size:16px;">${id}</b>
                                <span style="font-size:12px; color:#ccc;">
                                    ${t.locationStr} <span style="color:#ff4757; font-size:10px; font-weight:bold;">● ${t.ping}ms</span>
                                </span>
                            </div>
                            <div style="font-size:12px; color:#fff; height:32px; overflow:hidden; margin-bottom:10px; line-height:1.4;">
                                🎬 <span style="color:#ff7f50;">[#${t.iteration}]</span> ${t.videoTitle}
                            </div>
                            <div style="background:#000; height:8px; border-radius:4px; margin-bottom:10px; border:1px solid #222;">
                                <div style="width:${(t.elapsed/t.target)*100}%; background:linear-gradient(90deg, #ff0000, #2ed573); height:100%; border-radius:4px;"></div>
                            </div>
                            <div style="display:flex; justify-content:space-between; font-size:11px; font-weight:bold;">
                                <span style="color:#2ed573;">${t.status}</span>
                                <span style="color:#aaa;">${t.elapsed}/${t.target}s</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
                <h3 style="color:#eccc68; margin-top:30px; border-bottom: 2px solid #333; padding-bottom:10px;">📜 NHẬT KÝ CHIẾN TRƯỜNG</h3>
                <div style="background:#000; border:1px solid #222; padding:15px; border-radius:10px; height:300px; overflow-y:auto; font-family:monospace; color:#00ff41; font-size:12px; line-height:1.5;">
                    ${stats.logs.map(line => `<div>${line}</div>`).join('')}
                </div>
            </div>
            <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
    `);
});

app.listen(port, () => { 
    console.log(`Monitor: http://localhost:${port}`); 
    fetchProxies();
    fastCheckProxy();
    main();
});

async function main() {
    setInterval(async () => { await fetchProxies(); }, 600000);
    while (true) {
        if (stats.activeThreads < MAX_THREADS && verifiedProxyList.length > 0) {
            runWorker(verifiedProxyList.shift());
            await new Promise(r => setTimeout(r, 1000)); 
        } else {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}
