const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const express = require('express');
const axios = require('axios');
const UserAgents = require('user-agents');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

// --- CẤU HÌNH ---
const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_CONCURRENT_THREADS = 1; // VPS yếu nên để 1-2 thôi

let stats = { totalViews: 0, activeThreads: 0, proxyStatus: "Chưa bắt đầu", logs: [] };
let proxyList = [];

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const logEntry = `[${time}] ${msg}`;
    console.log(logEntry);
    stats.logs.unshift(logEntry);
    if (stats.logs.length > 50) stats.logs.pop();
}

// 1. Hàm lấy Proxy từ nhiều nguồn (Chống lỗi định dạng)
async function fetchProxies() {
    addLog("--- Đang quét Proxy từ nhiều nguồn ---");
    const apis = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
        'https://www.proxyscan.io/download?type=https',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt'
    ];

    for (let api of apis) {
        try {
            addLog(`Đang thử nguồn: ${api.substring(0, 30)}...`);
            const res = await axios.get(api, { timeout: 10000 });
            if (res.data && typeof res.data === 'string' && res.data.includes(':')) {
                const found = res.data.split('\n').filter(p => p.trim().includes(':'));
                if (found.length > 0) {
                    proxyList = found.map(p => p.trim());
                    stats.proxyStatus = `Thành công! Lấy được ${proxyList.length} Proxy`;
                    addLog(`✅ Đã nạp ${proxyList.length} proxy từ nguồn này.`);
                    return; // Lấy được rồi thì thoát vòng lặp
                }
            }
        } catch (e) {
            addLog(`❌ Nguồn này lỗi: ${e.message}`);
        }
    }
    
    addLog("⚠️ Không lấy được proxy từ nguồn nào. Sẽ thử lại sau 30s.");
    stats.proxyStatus = "Cạn kiệt Proxy!";
    await new Promise(r => setTimeout(r, 30000));
}

// 2. Worker xử lý (Headless ẩn hoàn toàn)
async function runWorker(proxy) {
    stats.activeThreads++;
    const userAgent = new UserAgents({ deviceCategory: 'desktop' }).toString();
    
    let browser;
    try {
        const launchArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--mute-audio',
            '--disable-gpu',
            '--disable-dev-shm-usage'
        ];
        
        if (proxy) launchArgs.push(`--proxy-server=http://${proxy}`);

        browser = await puppeteer.launch({
            headless: "new",
            args: launchArgs
        });

        const page = await browser.newPage();
        await page.setUserAgent(userAgent);

        // Chặn load rác cho nhẹ VPS
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'stylesheet'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        addLog(`[${proxy || 'IP GỐC'}] -> Đang truy cập Playlist...`);
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2', timeout: 90000 });

        // Tự động Play video đầu tiên
        await page.evaluate(() => {
            const firstVideo = document.querySelector('a.ytd-playlist-thumbnail');
            if (firstVideo) firstVideo.click();
        });

        // Đợi 5s cho video load rồi ép 144p
        await new Promise(r => setTimeout(r, 5000));
        await page.evaluate(() => {
            const settings = document.querySelector('.ytp-settings-button');
            if (settings) {
                settings.click();
                setTimeout(() => {
                    const menu = [...document.querySelectorAll('.ytp-menuitem')];
                    const quality = menu.find(i => i.textContent.includes('Quality'));
                    if (quality) quality.click();
                }, 500);
            }
        });

        const watchTime = Math.floor(Math.random() * (180000)) + 120000; // 2-5 phút
        addLog(`[${proxy || 'IP GỐC'}] -> Đang xem trong ${(watchTime/60000).toFixed(2)} phút...`);
        
        await new Promise(r => setTimeout(r, watchTime));

        stats.totalViews++;
        addLog(`✨ THÀNH CÔNG!`);

    } catch (err) {
        addLog(`⚠️ THẤT BẠI: ${err.message.substring(0, 50)}`);
    } finally {
        if (browser) await browser.close();
        stats.activeThreads--;
    }
}

// 3. Vòng lặp chính
async function main() {
    while (true) {
        if (proxyList.length === 0) {
            await fetchProxies();
        }

        if (stats.activeThreads < MAX_CONCURRENT_THREADS && proxyList.length > 0) {
            const currentProxy = proxyList.shift();
            runWorker(currentProxy); 
        } else if (proxyList.length === 0 && stats.activeThreads < MAX_CONCURRENT_THREADS) {
            // Nếu không có proxy thì chạy bằng IP gốc
            runWorker(null);
        }

        await new Promise(r => setTimeout(r, 15000));
    }
}

// 4. Dashboard (Cổng 1111)
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:monospace; background:#000; color:#0f0; padding:20px">
            <h2 style="color:red">YT BOT DASHBOARD - PORT 1111</h2>
            <p><b>Views:</b> ${stats.totalViews} | <b>Active:</b> ${stats.activeThreads}</p>
            <p><b>Proxy:</b> ${stats.proxyStatus}</p>
            <hr>
            <div style="height:400px; overflow-y:auto; background:#111; padding:10px">
                ${stats.logs.map(l => `<div>${l}</div>`).join('')}
            </div>
            <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`Đã mở dashboard tại cổng ${port}`);
    main();
});
