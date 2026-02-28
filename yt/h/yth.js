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
const MAX_CONCURRENT_THREADS = 1; // Để 1 để theo dõi log cho chuẩn đã
const PROXY_API = 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all&anonymity=all';

let stats = { totalViews: 0, activeThreads: 0, proxyStatus: "Chưa bắt đầu", logs: [] };
let proxyList = [];

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const logEntry = `[${time}] ${msg}`;
    console.log(logEntry); // Hiện ra terminal SSH
    stats.logs.unshift(logEntry); // Hiện lên web dashboard
    if (stats.logs.length > 50) stats.logs.pop();
}

// 1. Hàm lấy Proxy với Log chi tiết
async function fetchProxies() {
    addLog("Đang gọi API lấy danh sách Proxy...");
    try {
        const res = await axios.get(PROXY_API, { timeout: 15000 });
        if (res.data && typeof res.data === 'string') {
            proxyList = res.data.split('\r\n').filter(p => p.trim().length > 5);
            stats.proxyStatus = `Thành công! Lấy được ${proxyList.length} Proxy`;
            addLog(`✅ Đã nạp ${proxyList.length} proxy vào bộ nhớ.`);
        } else {
            throw new Error("Dữ liệu API trả về không đúng định dạng");
        }
    } catch (e) {
        stats.proxyStatus = `Lỗi lấy Proxy: ${e.message}`;
        addLog(`❌ LỖI API PROXY: ${e.message}`);
        addLog("Tạm nghỉ 30s trước khi thử lại...");
        await new Promise(r => setTimeout(r, 30000));
    }
}

// 2. Worker xử lý từng bước
async function runWorker(proxy) {
    stats.activeThreads++;
    const userAgent = new UserAgents({ deviceCategory: 'desktop' }).toString();
    addLog(`🚀 Khởi tạo trình duyệt qua Proxy: ${proxy}`);

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--mute-audio',
                `--proxy-server=socks5://${proxy}`,
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();
        await page.setUserAgent(userAgent);
        addLog(`[${proxy}] -> Đã mở Tab mới, đang truy cập YouTube...`);

        // Tăng timeout lên hẳn 2 phút cho chắc
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2', timeout: 120000 });
        addLog(`[${proxy}] -> Đã load xong trang. Đang tìm nút Play/Settings...`);

        // Thao tác giả lập
        await page.evaluate(() => {
            const btn = document.querySelector('.ytp-play-button');
            if (btn) btn.click();
            // Code ép 144p đã tối ưu
            const settings = document.querySelector('.ytp-settings-button');
            if (settings) settings.click();
        });

        addLog(`[${proxy}] -> Đang treo máy xem video...`);
        const watchTime = Math.floor(Math.random() * (300000 - 120000 + 1)) + 120000;
        await new Promise(r => setTimeout(r, watchTime));

        stats.totalViews++;
        addLog(`✨ THÀNH CÔNG: [${proxy}] đã xem xong.`);

    } catch (err) {
        addLog(`⚠️ THẤT BẠI: [${proxy}] - Chi tiết lỗi: ${err.message}`);
    } finally {
        if (browser) await browser.close();
        stats.activeThreads--;
        addLog(`🏁 Đã đóng trình duyệt [${proxy}]`);
    }
}

// 3. Vòng lặp chính
async function main() {
    addLog("=== HỆ THỐNG BẮT ĐẦU CHẠY ===");
    while (true) {
        if (proxyList.length === 0) {
            await fetchProxies();
        }

        if (stats.activeThreads < MAX_CONCURRENT_THREADS && proxyList.length > 0) {
            const currentProxy = proxyList.shift();
            runWorker(currentProxy); 
        }

        await new Promise(r => setTimeout(r, 10000)); // Nghỉ giữa các lượt quét
    }
}

// 4. Dashboard (Cổng 1111)
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:monospace; background:#000; color:#00ff00; padding:20px; line-height:1.5">
            <h2 style="color:red; border-bottom: 2px solid red">YOUTUBE DEBUG CONSOLE</h2>
            <div style="display:flex; gap:50px">
                <p><b>Tổng View:</b> ${stats.totalViews}</p>
                <p><b>Luồng chạy:</b> ${stats.activeThreads}</p>
                <p><b>Trạng thái Proxy:</b> ${stats.proxyStatus}</p>
            </div>
            <hr border="1">
            <div style="height:500px; overflow-y:auto; background:#111; padding:15px; border:1px solid #333">
                ${stats.logs.map(l => `<div>${l}</div>`).join('')}
            </div>
            <script>setTimeout(() => location.reload(), 2000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`Dashboard chạy tại port ${port}`);
    main().catch(e => console.error("LỖI HỆ THỐNG:", e));
});
