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
const MAX_CONCURRENT_THREADS = 3; // Chạy thử 3 luồng như ông muốn

let stats = { totalViews: 0, activeThreads: 0, proxyStatus: "Đang khởi động", logs: [] };
let proxyList = [];

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const logEntry = `[${time}] ${msg}`;
    console.log(logEntry);
    stats.logs.unshift(logEntry);
    if (stats.logs.length > 50) stats.logs.pop();
}

// 1. Hàm lấy và lọc Proxy Port "ngon"
async function fetchProxies() {
    addLog("--- Đang quét Proxy & Lọc Port chất lượng ---");
    const apis = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/https.txt'
    ];

    let allFound = [];
    for (let api of apis) {
        try {
            const res = await axios.get(api, { timeout: 10000 });
            if (res.data && typeof res.data === 'string') {
                const lines = res.data.split('\n');
                allFound = allFound.concat(lines);
            }
        } catch (e) {}
    }

    // Lọc: Chỉ lấy proxy có port tiềm năng, bỏ port 80, 8081 nếu thích
    const goodPorts = ['8080', '3128', '8888', '999', '443', '1080', '8118'];
    proxyList = allFound
        .map(p => p.trim())
        .filter(p => {
            if (!p.includes(':')) return false;
            const port = p.split(':')[1];
            return goodPorts.includes(port) || port.length > 3; // Ưu tiên port dài
        });

    stats.proxyStatus = `Đã lọc được ${proxyList.length} Proxy xịn`;
    addLog(`✅ Đã nạp ${proxyList.length} proxy chất lượng.`);
}

// 2. Hàm Worker (Đã tối ưu kịch sàn)
async function runWorker(proxy) {
    stats.activeThreads++;
    const userAgent = new UserAgents({ deviceCategory: 'desktop' }).toString();
    let browser;

    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--mute-audio',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                `--proxy-server=http://${proxy}`
            ]
        });

        const page = await browser.newPage();
        await page.setUserAgent(userAgent);
        
        // Timeout ngắn cho kết nối ban đầu
        await page.setDefaultNavigationTimeout(25000); 

        // Chặn rác để nhẹ máy
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'stylesheet'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        addLog(`[${proxy}] -> Thử kết nối...`);
        await page.goto(PLAYLIST_URL, { waitUntil: 'domcontentloaded' });

        // Nếu vào được đến đây là Proxy sống -> Tăng timeout để xem
        await page.setDefaultNavigationTimeout(60000);
        
        addLog(`[${proxy}] -> Kết nối thành công! Đang Play...`);
        
        await page.evaluate(() => {
            const btn = document.querySelector('a.ytd-playlist-thumbnail') || document.querySelector('video');
            if (btn) btn.click();
            // Ép 144p ngầm
            setTimeout(() => {
                const s = document.querySelector('.ytp-settings-button');
                if(s) s.click();
            }, 2000);
        });

        const watchTime = Math.floor(Math.random() * (120000)) + 90000; // Xem 1.5 - 3.5 phút
        await new Promise(r => setTimeout(r, watchTime));

        stats.totalViews++;
        addLog(`✨ THÀNH CÔNG [${proxy}]`);

    } catch (err) {
        // Rút gọn log lỗi cho sạch dashboard
        let msg = err.message.includes('timeout') ? "Quá chậm" : "Proxy chết";
        addLog(`⚠️ Bỏ qua [${proxy}]: ${msg}`);
    } finally {
        if (browser) await browser.close();
        stats.activeThreads--;
    }
}

// 3. Vòng lặp chính (Không dùng await runWorker để chạy song song)
async function main() {
    while (true) {
        if (proxyList.length < 10) await fetchProxies();

        if (stats.activeThreads < MAX_CONCURRENT_THREADS && proxyList.length > 0) {
            const p = proxyList.shift();
            runWorker(p); // Gọi hàm mà KHÔNG có await để tạo luồng mới ngay
        }

        // Nghỉ 5s giữa mỗi lần kiểm tra để không nghẽn CPU
        await new Promise(r => setTimeout(r, 5000));
    }
}

// 4. Dashboard
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:monospace; background:#000; color:#0f0; padding:20px">
            <h2 style="color:red">YT BOT ULTIMATE - ACTIVE THREADS: ${stats.activeThreads}</h2>
            <div style="background:#111; padding:10px; border:1px solid #0f0">
                <b>Views:</b> ${stats.totalViews} | <b>Proxy còn lại:</b> ${proxyList.length}
            </div>
            <p>${stats.proxyStatus}</p>
            <hr>
            <div style="height:400px; overflow-y:auto; font-size:12px">
                ${stats.logs.map(l => `<div>${l}</div>`).join('')}
            </div>
            <script>setTimeout(() => location.reload(), 4000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`Dashboard chạy tại: http://localhost:${port}`);
    main();
});
