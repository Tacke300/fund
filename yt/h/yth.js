const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const UserAgents = require('user-agents');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

// CẤU HÌNH CHÍNH
const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 3; // Nên để thấp vì mở trình duyệt thật rất tốn RAM
const COOKIE_FILE = './youtube_cookies.json';
const BLACKLIST_FILE = './blacklist_proxy.json';

let stats = {
    totalViews: 0, totalSeconds: 0, activeThreads: 0,
    proxyReady: 0, threadStatus: {}, history: []
};

let proxyList = [];
let blacklist = fs.existsSync(BLACKLIST_FILE) ? fs.readJsonSync(BLACKLIST_FILE) : {};

// Hàm mô phỏng hành vi người thật (Scroll, Mouse Move)
async function humanize(page) {
    try {
        const viewPort = page.viewport();
        // Di chuyển chuột ngẫu nhiên
        await page.mouse.move(Math.random() * viewPort.width, Math.random() * viewPort.height);
        // Cuộn trang ngẫu nhiên
        if (Math.random() > 0.5) {
            await page.evaluate(() => window.scrollBy(0, Math.floor(Math.random() * 300)));
        }
    } catch (e) {}
}

async function fetchProxies() {
    console.log("🔄 Đang lấy danh sách Proxy mới...");
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://proxyspace.pro/http.txt'
    ];
    let all = [];
    for (let s of sources) {
        try { 
            const res = await axios.get(s, { timeout: 5000 }); 
            all = all.concat(res.data.split('\n')); 
        } catch(e) {}
    }
    proxyList = [...new Set(all.map(p => p.trim()).filter(p => p.includes(':') && !blacklist[p]))];
    stats.proxyReady = proxyList.length;
}

async function runWorker(proxy) {
    stats.activeThreads++;
    const threadId = Math.random().toString(36).substring(7);
    const userDataDir = path.join(__dirname, 'temp', `profile_${threadId}`);
    stats.threadStatus[threadId] = { proxy, title: 'Đang khởi tạo...', elapsed: 0, target: 0, lastAction: '🚀 Mở trình duyệt' };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: false, // HIỆN TRÌNH DUYỆT ĐỂ VƯỢT QUÉT
            userDataDir: userDataDir,
            args: [
                `--proxy-server=http://${proxy}`,
                '--no-sandbox',
                '--start-maximized',
                '--disable-blink-features=AutomationControlled',
                '--use-gl=desktop' // Sử dụng GPU thật
            ],
            ignoreDefaultArgs: ['--enable-automation']
        });

        const page = (await browser.pages())[0];
        await page.setViewport({ width: 1280, height: 720 });

        if (fs.existsSync(COOKIE_FILE)) {
            const cookies = await fs.readJson(COOKIE_FILE);
            await page.setCookie(...cookies);
        }

        const ua = new UserAgents({ deviceCategory: 'desktop' }).toString();
        await page.setUserAgent(ua);

        // Chặn bớt rác để nhẹ máy nhưng giữ lại script YouTube
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        stats.threadStatus[threadId].lastAction = '🌍 Truy cập Playlist';
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        // Click nút Chấp nhận/Đồng ý của Google nếu có
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, span'));
            const target = btns.find(b => /Chấp nhận|Agree|Accept|I agree/i.test(b.innerText));
            if (target) target.click();
        });
        await new Promise(r => setTimeout(r, 3000));

        // Click vào video đầu tiên trong playlist
        await page.click('a.ytd-playlist-thumbnail, #video-title');
        
        // Xem tối đa 5 video trong playlist rồi đổi IP
        for (let i = 0; i < 5; i++) {
            await new Promise(r => setTimeout(r, 5000));
            const videoTitle = await page.title();
            const watchSecs = Math.floor(Math.random() * 60) + 120; // Xem 2-3 phút ngẫu nhiên

            stats.threadStatus[threadId].title = videoTitle.split('- YouTube')[0];
            stats.threadStatus[threadId].target = watchSecs;
            stats.threadStatus[threadId].elapsed = 0;
            stats.threadStatus[threadId].lastAction = `👀 Đang xem (${i+1}/5)`;

            for (let s = 0; s < watchSecs; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[threadId].elapsed++;
                stats.totalSeconds++;
                
                // Cứ 20 giây giả lập hành động người 1 lần
                if (s % 20 === 0) await humanize(page);
            }

            stats.totalViews++;
            
            // Bấm Next sang video tiếp theo
            const hasNext = await page.evaluate(() => {
                const nextBtn = document.querySelector('.ytp-next-button');
                if (nextBtn && window.getComputedStyle(nextBtn).display !== 'none') {
                    nextBtn.click();
                    return true;
                }
                return false;
            });
            if (!hasNext) break;
        }

    } catch (err) {
        console.log(`❌ Lỗi luồng ${threadId}: ${err.message}`);
        blacklist[proxy] = true;
        fs.writeJsonSync(BLACKLIST_FILE, blacklist);
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        delete stats.threadStatus[threadId];
        stats.activeThreads--;
    }
}

async function main() {
    console.log("🚀 BOT ĐÃ SẴN SÀNG - CHẾ ĐỘ HIỆN MÀN HÌNH");
    while (true) {
        if (proxyList.length < 10) await fetchProxies();
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
            await new Promise(r => setTimeout(r, 10000)); // Đợi 10s mới mở luồng mới để tránh sốc IP
        } else {
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

// Giao diện Dashboard (Giữ nguyên như cũ)
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:sans-serif; background:#0d1117; color:#c9d1d9; padding:20px">
            <h1 style="color:#58a6ff">🛰️ YT BOT PRO - VISUAL MODE</h1>
            <p>Trạng thái: <b>${stats.activeThreads} luồng đang chạy</b> | Proxy: <b>${stats.proxyReady}</b></p>
            <div style="background:#161b22; padding:15px; border-radius:8px">
                <p>Tổng View: <b style="font-size:20px; color:#3fb950">${stats.totalViews}</b></p>
            </div>
            <table style="width:100%; margin-top:20px; border-collapse:collapse">
                <tr style="background:#21262d">
                    <th style="padding:10px">Proxy</th><th>Video</th><th>Thời gian</th><th>Trạng thái</th>
                </tr>
                ${Object.values(stats.threadStatus).map(t => `
                <tr style="border-bottom:1px solid #333">
                    <td>${t.proxy}</td><td>${t.title}</td><td>${t.elapsed}/${t.target}s</td><td style="color:#3fb950">${t.lastAction}</td>
                </tr>`).join('')}
            </table>
            <script>setTimeout(() => location.reload(), 2000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`DASHBOARD: http://localhost:${port}`);
    main();
});
