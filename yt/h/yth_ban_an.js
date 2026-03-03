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

// --- CẤU HÌNH ---
const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 15; 
const BLACKLIST_FILE = './blacklist_proxy.json';
const GOOD_PROXIES_FILE = './good_proxies.json';
const COOKIE_FILE = './youtube_cookies.json';

let stats = {
    totalViews: 0, totalSeconds: 0, activeThreads: 0,
    proxiesScraped: 0, proxiesFailed: 0, proxiesSuccess: 0,
    proxyReady: 0, threadStatus: {}, logs: []
};

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    stats.logs.unshift(`[${time}] ${msg}`);
    if (stats.logs.length > 100) stats.logs.pop();
    console.log(`[${time}] ${msg}`);
}

let proxyList = [];
let blacklist = fs.existsSync(BLACKLIST_FILE) ? fs.readJsonSync(BLACKLIST_FILE) : {};
let goodProxies = fs.existsSync(GOOD_PROXIES_FILE) ? fs.readJsonSync(GOOD_PROXIES_FILE) : [];

async function fetchProxies() {
    addLog("--- QUÉT PROXY MỚI ---");
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://proxyspace.pro/http.txt'
    ];
    let all = [];
    for (let s of sources) {
        try {
            const res = await axios.get(s, { timeout: 10000 });
            const lines = res.data.split('\n').map(p => p.trim()).filter(p => p.includes(':') && /^\d/.test(p));
            all = all.concat(lines);
        } catch(e) {}
    }
    proxyList = [...new Set(all)].filter(p => !blacklist[p]);
    stats.proxyReady = proxyList.length;
    addLog(`Đã nạp ${proxyList.length} Proxy vào hàng chờ.`);
}

async function runWorker(proxy) {
    stats.activeThreads++;
    const id = Math.random().toString(36).substring(7).toUpperCase();
    const userDataDir = path.join(__dirname, 'temp', `profile_${id}`);
    stats.threadStatus[id] = { proxy, title: 'Đang kết nối...', elapsed: 0, target: 0, lastAction: '🚀 Khởi tạo', iteration: 0 };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: userDataDir,
            args: [`--proxy-server=http://${proxy}`, '--no-sandbox', '--disable-setuid-sandbox', '--mute-audio']
        });

        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(60000);
        
        if (fs.existsSync(COOKIE_FILE)) {
            const cookies = await fs.readJson(COOKIE_FILE);
            await page.setCookie(...cookies);
        }

        stats.threadStatus[id].lastAction = '🌍 Load Playlist...';
        const resp = await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
        
        // NẾU LỖI KẾT NỐI: Đưa proxy quay lại cuối hàng chờ, không blacklist ngay
        if (!resp || resp.status() >= 400) {
            addLog(`[${id}] Proxy chậm/lỗi mạng. Đưa lại vào hàng chờ.`);
            proxyList.push(proxy); 
            throw new Error("Connection failed");
        }

        // Vượt rào xác thực
        await page.evaluate(() => {
            const keys = ['Accept', 'Agree', 'Chấp nhận', 'Đồng ý', 'I agree'];
            const btns = Array.from(document.querySelectorAll('button, span'));
            const target = btns.find(b => keys.some(k => b.innerText && b.innerText.includes(k)));
            if (target) target.click();
        });
        await new Promise(r => setTimeout(r, 5000));

        // Nhấn Play
        const play = await page.evaluate(() => {
            const b = document.querySelector('a.ytd-playlist-thumbnail') || document.querySelector('#video-title');
            if (b) { b.click(); return true; }
            return false;
        });

        if (!play) throw new Error("Không tìm thấy video");

        // VÒNG LẶP XEM HẾT PLAYLIST
        let videoCount = 0;
        while (true) {
            videoCount++;
            await new Promise(r => setTimeout(r, 10000));
            const title = await page.title();
            
            if (title.includes("Captcha") || title.includes("robot")) throw new Error("Bị chặn Captcha");

            const watchTime = Math.floor(Math.random() * 60) + 180; // Xem ít nhất 3p
            stats.threadStatus[id].title = title;
            stats.threadStatus[id].target = watchTime;
            stats.threadStatus[id].iteration = videoCount;
            stats.threadStatus[id].lastAction = '👀 Đang xem video';

            for (let s = 1; s <= watchTime; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[id].elapsed = s;
                stats.totalSeconds++;
            }

            stats.totalViews++;
            stats.proxiesSuccess++;

            // Thử nhấn nút Next để xem video tiếp theo trong playlist
            const hasNext = await page.evaluate(() => {
                const n = document.querySelector('.ytp-next-button');
                if (n && window.getComputedStyle(n).display !== 'none') {
                    n.click();
                    return true;
                }
                return false;
            });

            if (!hasNext) {
                addLog(`[${id}] Đã xem hết lượt Playlist. Hoàn thành nhiệm vụ.`);
                break; 
            }
            addLog(`[${id}] Xong video ${videoCount}, chuyển video tiếp theo...`);
        }

    } catch (err) {
        if (err.message.includes("Captcha") || err.message.includes("403")) {
            addLog(`[${id}] Proxy bị chặn cứng (Captcha/403). Cho vào Blacklist.`);
            blacklist[proxy] = true;
            fs.writeJsonSync(BLACKLIST_FILE, blacklist);
        }
        stats.proxiesFailed++;
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        delete stats.threadStatus[id];
        stats.activeThreads--;
    }
}

async function main() {
    addLog("HỆ THỐNG KHỞI CHẠY - ƯU TIÊN FULL LUỒNG");
    while (true) {
        if (proxyList.length < 10) await fetchProxies();
        
        // CHỈ CHẠY LUỒNG MỚI KHI CHƯA FULL MAX_THREADS
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
            await new Promise(r => setTimeout(r, 5000)); // Delay tránh nghẽn CPU
        } else {
            // Nếu đã full luồng, đợi 10 giây rồi kiểm tra lại
            await new Promise(r => setTimeout(r, 10000));
        }
    }
}

// Giữ nguyên phần Dashboard (app.get) như bản trước...
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:monospace; background:#f0f2f5; padding:20px;">
            <h2>HỆ THỐNG ĐANG CHẠY: ${stats.activeThreads}/${MAX_THREADS} LUỒNG</h2>
            <div style="background:#fff; padding:15px; margin-bottom:10px; border-radius:8px;">
                Views: ${stats.totalViews} | Proxy sẵn sàng: ${proxyList.length} | Blacklist: ${Object.keys(blacklist).length}
            </div>
            <table border="1" style="width:100%; border-collapse:collapse; background:#fff">
                <tr style="background:#333; color:#fff">
                    <th>ID</th><th>Proxy</th><th>Video Hiện Tại</th><th>Tiến Độ</th><th>Hành Động</th>
                </tr>
                ${Object.entries(stats.threadStatus).map(([id, t]) => `
                <tr>
                    <td align="center">${id}</td>
                    <td>${t.proxy}</td>
                    <td><b>[Bài ${t.iteration}]</b> ${t.title}</td>
                    <td align="center">${t.elapsed}/${t.target}s</td>
                    <td align="center">${t.lastAction}</td>
                </tr>`).join('')}
            </table>
            <div style="margin-top:20px; background:#000; color:#0f0; padding:10px; height:200px; overflow-y:auto; font-size:12px">
                ${stats.logs.map(l => `<div>${l}</div>`).join('')}
            </div>
            <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`DASHBOARD: http://localhost:${port}`);
    main();
});
