const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const express = require('express');
const axios = require('axios');
const UserAgents = require('user-agents');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

// Cấu hình tại đây
const PLAYLIST_URL = 'LINK_PLAYLIST_CỦA_ÔNG_VÀO_ĐÂY';
const MAX_CONCURRENT_THREADS = 2; // VPS yếu để 2, mạnh thì tăng lên

let stats = { totalViews: 0, activeThreads: 0, currentProxy: "Đang nạp...", logs: [] };
let proxyList = [];

// 1. Hàm lấy và kiểm tra Proxy (SOCKS5 ổn định hơn HTTP)
async function getFreshProxies() {
    try {
        stats.currentProxy = "Đang lấy danh sách Proxy mới...";
        const res = await axios.get('https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=5000&country=all&anonymity=all');
        proxyList = res.data.split('\r\n').filter(p => p.length > 5);
        stats.currentProxy = `Đã nạp ${proxyList.length} Proxy SOCKS5`;
    } catch (e) {
        stats.currentProxy = "Lỗi lấy Proxy, đợi lượt sau...";
    }
}

// 2. Hàm xử lý xem video chính
async function runWorker(proxy) {
    stats.activeThreads++;
    const userAgent = new UserAgents({ deviceCategory: 'desktop' }).toString();
    
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--mute-audio',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            `--proxy-server=socks5://${proxy}`,
            '--window-size=1280,720'
        ]
    });

    try {
        const page = await browser.newPage();
        await page.setUserAgent(userAgent);
        
        // Tối ưu RAM: Chặn ảnh và CSS nặng
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'stylesheet'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        // Truy cập Video
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2', timeout: 90000 });

        // Tự động Play và Ép 144p
        await page.evaluate(async () => {
            const delay = ms => new Promise(r => setTimeout(r, ms));
            // Nhấn Play nếu cần
            const playBtn = document.querySelector('.ytp-play-button');
            if (playBtn) playBtn.click();
            
            // Ép 144p
            const settings = document.querySelector('.ytp-settings-button');
            if (settings) {
                settings.click(); await delay(500);
                const menu = [...document.querySelectorAll('.ytp-menuitem')];
                const quality = menu.find(i => i.textContent.includes('Quality'));
                if (quality) {
                    quality.click(); await delay(500);
                    const levels = [...document.querySelectorAll('.ytp-menuitem')];
                    const low = levels.find(l => l.textContent.includes('144p'));
                    if (low) low.click();
                }
            }
        });

        // Thời gian xem ngẫu nhiên 2-5 phút
        const watchMs = Math.floor(Math.random() * (300000 - 120000 + 1)) + 120000;
        await new Promise(r => setTimeout(r, watchMs));

        stats.totalViews++;
        addLog(`Thành công: [${proxy}] - Xem ${(watchMs/60000).toFixed(2)} phút`);

    } catch (err) {
        addLog(`Thất bại: [${proxy}] - Lỗi: ${err.message.substring(0, 30)}...`);
    } finally {
        stats.activeThreads--;
        await browser.close();
    }
}

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    stats.logs.unshift(`[${time}] ${msg}`);
    if (stats.logs.length > 20) stats.logs.pop();
}

// 3. Quản lý vòng lặp luồng
async function main() {
    await getFreshProxies();
    
    while (true) {
        if (stats.activeThreads < MAX_CONCURRENT_THREADS && proxyList.length > 0) {
            const proxy = proxyList.shift();
            runWorker(proxy); // Chạy không await để tạo luồng song song
        }

        // Nếu hết proxy thì lấy bộ mới
        if (proxyList.length === 0) {
            await getFreshProxies();
        }

        // Nghỉ một chút trước khi kiểm tra luồng tiếp theo
        await new Promise(r => setTimeout(r, 15000));
    }
}

// 4. Dashboard Giao diện
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:sans-serif; background:#000; color:#0f0; padding:30px">
            <h1 style="color:red">YT-SSH-BOT ULTIMATE</h1>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-bottom:20px">
                <div style="border:1px solid #0f0; padding:10px">Views: ${stats.totalViews}</div>
                <div style="border:1px solid #0f0; padding:10px">Active: ${stats.activeThreads}</div>
            </div>
            <div style="color:yellow; margin-bottom:10px">${stats.currentProxy}</div>
            <div style="background:#111; padding:10px; height:300px; overflow-y:auto; border:1px solid #333">
                ${stats.logs.map(l => `<div style="margin-bottom:5px">${l}</div>`).join('')}
            </div>
            <script>setTimeout(() => location.reload(), 5000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`Cổng Dashboard: ${port}`);
    main();
});
