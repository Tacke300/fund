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
const BLACKLIST_FILE = './blacklist_proxy.json';
const COOKIE_FILE = './youtube_cookies.json';

let stats = {
    totalViews: 0, totalSeconds: 0, activeThreads: 0,
    proxiesFailed: 0, proxiesSuccess: 0,
    proxyReady: 0, threadStatus: {}, logs: []
};

// Quản lý file hệ thống
let blacklist = fs.existsSync(BLACKLIST_FILE) ? fs.readJsonSync(BLACKLIST_FILE) : {};
let proxyList = [];

// Log Terminal (Chi tiết nhất)
function fullLog(id, msg, type = 'INFO') {
    const time = new Date().toLocaleString();
    console.log(`[${time}] [${id}] [${type}] ${msg}`);
}

// Log Dashboard (Gọn gàng)
function dashLog(msg) {
    const time = new Date().toLocaleTimeString();
    stats.logs.unshift(`[${time}] ${msg}`);
    if (stats.logs.length > 50) stats.logs.pop();
}

async function fetchProxies() {
    fullLog('SYSTEM', 'Đang quét proxy mới...', 'SCRAPER');
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt'
    ];
    let all = [];
    for (let s of sources) {
        try {
            const res = await axios.get(s, { timeout: 8000 });
            const lines = res.data.split('\n').map(p => p.trim()).filter(p => p.includes(':'));
            all = all.concat(lines);
        } catch (e) { fullLog('SYSTEM', `Lỗi nguồn ${s}`, 'ERROR'); }
    }
    proxyList = [...new Set(all)].filter(p => !blacklist[p]);
    stats.proxyReady = proxyList.length;
}

async function runWorker(proxy) {
    stats.activeThreads++;
    const id = Math.random().toString(36).substring(7).toUpperCase();
    const userDataDir = path.join(__dirname, 'temp', `profile_${id}`);
    stats.threadStatus[id] = { proxy, title: 'Khởi tạo...', elapsed: 0, target: 0, iteration: 0, status: '🚀' };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: userDataDir,
            args: [`--proxy-server=http://${proxy}`, '--no-sandbox', '--disable-gpu', '--mute-audio']
        });

        const page = await browser.newPage();
        
        // --- CHẶN HÌNH ẢNH, CSS, ADS ---
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType) && resourceType !== 'media') {
                req.abort();
            } else if (req.url().includes('googleads') || req.url().includes('doubleclick')) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setDefaultNavigationTimeout(60000);

        // Bước 1: Lấy danh sách link video từ Playlist
        fullLog(id, `Đang truy cập playlist để lấy danh sách video...`);
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
        
        const videoLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
            return [...new Set(links.map(a => a.href.split('&')[0]))]; 
        });

        if (!videoLinks || videoLinks.length === 0) throw new Error("Không lấy được danh sách video");
        fullLog(id, `Tìm thấy ${videoLinks.length} video. Bắt đầu xem...`, 'SUCCESS');

        // Bước 2: Xem từng video bằng cách truy cập trực tiếp
        for (let i = 0; i < videoLinks.length; i++) {
            const videoUrl = videoLinks[i];
            stats.threadStatus[id].iteration = i + 1;
            stats.threadStatus[id].status = '📺 Đang xem';
            
            fullLog(id, `Truy cập video: ${videoUrl}`);
            await page.goto(videoUrl, { waitUntil: 'networkidle2' });

            // Kiểm tra nếu bị văng ra trang chủ hoặc trang lỗi
            if (!page.url().includes('watch')) {
                fullLog(id, `Bị văng khỏi video, đang cố gắng vào lại...`, 'RETRY');
                await page.goto(videoUrl, { waitUntil: 'networkidle2' });
            }

            // Click Play nếu cần
            await page.evaluate(() => {
                const btn = document.querySelector('.ytp-play-button') || document.querySelector('video');
                if (btn) btn.click();
            });

            const watchTime = Math.floor(Math.random() * 61) + 180; // 180s - 240s
            stats.threadStatus[id].target = watchTime;
            
            for (let s = 1; s <= watchTime; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[id].elapsed = s;
                stats.totalSeconds++;
                
                // Mỗi 30s kiểm tra tiêu đề để cập nhật Dashboard
                if (s % 30 === 0) {
                    stats.threadStatus[id].title = await page.title();
                }
            }

            stats.totalViews++;
            stats.proxiesSuccess++;
            fullLog(id, `Hoàn thành video ${i+1}/${videoLinks.length}`, 'SUCCESS');
            dashLog(`ID ${id} xong video ${i+1}`);
        }

    } catch (err) {
        fullLog(id, `Lỗi: ${err.message}`, 'ERROR');
        if (err.message.includes("403") || err.message.includes("Captcha")) {
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
    while (true) {
        if (proxyList.length < 10) await fetchProxies();
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            runWorker(proxyList.shift());
            await new Promise(r => setTimeout(r, 3000));
        } else {
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background:#1a1a1a; color:#eee; padding:20px;">
            <h2 style="color:#ff4757">🔴 YOUTUBE BOT DASHBOARD - ${stats.activeThreads}/${MAX_THREADS} LUỒNG</h2>
            
            <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:10px; margin-bottom:20px;">
                <div style="background:#2f3542; padding:15px; border-radius:8px; border-left:5px solid #2ed573">Views: <b>${stats.totalViews}</b></div>
                <div style="background:#2f3542; padding:15px; border-radius:8px; border-left:5px solid #eccc68">Proxy Ready: <b>${proxyList.length}</b></div>
                <div style="background:#2f3542; padding:15px; border-radius:8px; border-left:5px solid #ff4757">Blacklist: <b>${Object.keys(blacklist).length}</b></div>
                <div style="background:#2f3542; padding:15px; border-radius:8px; border-left:5px solid #70a1ff">Lỗi: <b>${stats.proxiesFailed}</b></div>
            </div>

            <table border="0" style="width:100%; border-collapse:collapse; background:#2f3542; border-radius:8px; overflow:hidden">
                <tr style="background:#57606f; color:#fff; text-align:left">
                    <th style="padding:12px">ID Thread</th>
                    <th>Proxy IP</th>
                    <th>Video / Tiến trình</th>
                    <th>Thời gian</th>
                    <th style="text-align:center">Trạng thái</th>
                </tr>
                ${Object.entries(stats.threadStatus).map(([id, t]) => `
                <tr style="border-bottom:1px solid #3f444e">
                    <td style="padding:12px"><span style="background:#ffa502; color:#000; padding:2px 6px; border-radius:4px; font-weight:bold">${id}</span></td>
                    <td style="font-size:12px">${t.proxy}</td>
                    <td><small>#${t.iteration}</small> ${t.title ? t.title.substring(0,40) : 'Đang tải...'}</td>
                    <td>
                        <div style="width:100px; background:#1e2227; height:10px; border-radius:5px">
                            <div style="width:${(t.elapsed/t.target)*100}%; background:#2ed573; height:10px; border-radius:5px"></div>
                        </div>
                        <small>${t.elapsed}/${t.target}s</small>
                    </td>
                    <td align="center">${t.status}</td>
                </tr>`).join('')}
            </table>

            <div style="margin-top:20px; background:#000; color:#2ed573; padding:15px; height:150px; overflow-y:auto; font-family: 'Courier New', Courier, monospace; font-size:13px; border-radius:8px; border:1px solid #333">
                ${stats.logs.map(l => `<div>${l}</div>`).join('')}
            </div>
            <script>setTimeout(() => location.reload(), 2000)</script>
        </body>
    `);
});

app.listen(port, () => {
    fullLog('SYSTEM', `DASHBOARD CHẠY TẠI: http://localhost:${port}`);
    main();
});
