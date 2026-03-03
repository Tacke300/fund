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
const BLACKLIST_FILE = path.join(__dirname, 'blacklist_proxy2.json');
const startTime = Date.now();

// --- FIX LỖI: XÓA BLACKLIST KHI RESTART PM2 ---
if (fs.existsSync(BLACKLIST_FILE)) {
    try { 
        fs.unlinkSync(BLACKLIST_FILE); 
        console.log("🔥 ĐÃ XÓA SẠCH BLACKLIST CŨ ĐỂ CHẠY LẠI TỪ ĐẦU!");
    } catch(e) {}
}

let stats = {
    totalViews: 0, totalSeconds: 0, activeThreads: 0,
    proxiesFailed: 0, proxiesSuccess: 0,
    proxyReady: 0, threadStatus: {}, logs: []
};

let blacklist = {}; // Reset trắng trong RAM
let proxyList = [];
let successPool = new Set(); // Nơi cứu hộ khi hết proxy

function fullLog(id, msg, type = 'INFO') {
    const time = new Date().toLocaleString();
    console.log(`[${time}] [${id}] [${type}] ${msg}`);
}

function dashLog(msg) {
    const time = new Date().toLocaleTimeString();
    stats.logs.unshift(`[${time}] ${msg}`);
    if (stats.logs.length > 50) stats.logs.pop();
}

async function fetchProxies() {
    fullLog('SYSTEM', '🚀 Đang thực hiện Deep Scan nạp x10 Proxy...', 'SCRAPER');
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
        'https://raw.githubusercontent.com/Zaeem20/free-proxy-list/master/http.txt',
        'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
        'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt',
        'https://api.openproxylist.xyz/http.txt',
        'https://raw.githubusercontent.com/officialputuid/Free-Proxy-List/main/http.txt'
    ];
    
    let all = [];
    for (let s of sources) {
        try {
            const res = await axios.get(s, { timeout: 8000 });
            const lines = res.data.split('\n').map(p => p.trim()).filter(p => p.includes(':'));
            all = all.concat(lines);
        } catch (e) {}
    }
    
    // Lọc proxy
    proxyList = [...new Set(all)].filter(p => !blacklist[p]);
    
    // CƠ CHẾ CỨU HỘ: Nếu nguồn mới cạn, lấy từ hàng đã từng thành công
    if (proxyList.length < 50 && successPool.size > 0) {
        dashLog("🆘 Dùng lại Proxy từ Success Pool cứu hộ...");
        proxyList = [...proxyList, ...Array.from(successPool)];
    }
    
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
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            if (['image', 'stylesheet', 'font'].includes(resourceType)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setDefaultNavigationTimeout(60000);
        await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
        
        const videoLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
            return [...new Set(links.map(a => a.href.split('&')[0]))]; 
        });

        if (!videoLinks || videoLinks.length === 0) throw new Error("Proxy không load được playlist");

        for (let i = 0; i < videoLinks.length; i++) {
            const videoUrl = videoLinks[i];
            stats.threadStatus[id].iteration = i + 1;
            stats.threadStatus[id].status = '📺 Đang xem';
            
            await page.goto(videoUrl, { waitUntil: 'networkidle2' });
            
            // Nếu vào được đây là proxy ngon -> Lưu vào Pool cứu hộ
            successPool.add(proxy);

            const watchTime = Math.floor(Math.random() * 61) + 120; // 2-3 phút cho nhanh
            stats.threadStatus[id].target = watchTime;
            
            for (let s = 1; s <= watchTime; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[id].elapsed = s;
                if (s % 30 === 0) stats.threadStatus[id].title = await page.title();
            }

            stats.totalViews++;
            stats.proxiesSuccess++;
            dashLog(`✅ ID ${id} xong video ${i+1}`);
        }

    } catch (err) {
        blacklist[proxy] = true;
        stats.proxiesFailed++;
        successPool.delete(proxy); // Nếu đang trong pool mà chết thì xóa
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        delete stats.threadStatus[id];
        stats.activeThreads--;
    }
}

async function main() {
    while (true) {
        // NGƯỠNG NẠP 50 NHƯ YÊU CẦU
        if (proxyList.length < 50) await fetchProxies();

        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            // Chạy theo cụm để tránh nghẽn
            for (let i = 0; i < 3; i++) {
                if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
                    runWorker(proxyList.shift());
                }
            }
            await new Promise(r => setTimeout(r, 15000));
        } else {
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - startTime) / 60000);
    res.send(`
        <body style="font-family:sans-serif; background:#1a1a1a; color:#eee; padding:20px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <h2 style="color:#ff4757">🔴 YT BOT PRO - ${stats.activeThreads}/${MAX_THREADS} LUỒNG</h2>
                <span style="background:#2ed573; color:#000; padding:5px 15px; border-radius:20px; font-weight:bold">Uptime: ${uptime}m</span>
            </div>
            
            <div style="display:grid; grid-template-columns: repeat(5, 1fr); gap:10px; margin-bottom:20px;">
                <div style="background:#2f3542; padding:15px; border-radius:8px; border-left:5px solid #2ed573">Views: <b>${stats.totalViews}</b></div>
                <div style="background:#2f3542; padding:15px; border-radius:8px; border-left:5px solid #eccc68">Proxy Ready: <b>${proxyList.length}</b></div>
                <div style="background:#2f3542; padding:15px; border-radius:8px; border-left:5px solid #70a1ff">Pool Cứu Hộ: <b>${successPool.size}</b></div>
                <div style="background:#2f3542; padding:15px; border-radius:8px; border-left:5px solid #ff4757">Blacklist: <b>${Object.keys(blacklist).length}</b></div>
                <div style="background:#2f3542; padding:15px; border-radius:8px; border-left:5px solid #ff7f50">Lỗi: <b>${stats.proxiesFailed}</b></div>
            </div>

            <table border="0" style="width:100%; border-collapse:collapse; background:#2f3542; border-radius:8px; overflow:hidden">
                <tr style="background:#57606f; color:#fff; text-align:left">
                    <th style="padding:12px">ID</th>
                    <th>Proxy</th>
                    <th>Tiến trình</th>
                    <th>Thời gian</th>
                    <th style="text-align:center">Trạng thái</th>
                </tr>
                ${Object.entries(stats.threadStatus).map(([id, t]) => `
                <tr style="border-bottom:1px solid #3f444e">
                    <td style="padding:12px"><b>${id}</b></td>
                    <td style="font-size:12px">${t.proxy}</td>
                    <td><small>#${t.iteration}</small> ${t.title ? t.title.substring(0,30) : '...'}</td>
                    <td>
                        <div style="width:100px; background:#1e2227; height:8px; border-radius:5px">
                            <div style="width:${(t.elapsed/t.target)*100}%; background:#2ed573; height:8px; border-radius:5px"></div>
                        </div>
                        <small>${t.elapsed}/${t.target}s</small>
                    </td>
                    <td align="center">${t.status}</td>
                </tr>`).join('')}
            </table>

            <div style="margin-top:20px; background:#000; color:#2ed573; padding:15px; height:200px; overflow-y:auto; font-family:monospace; border-radius:8px;">
                ${stats.logs.map(l => `<div>${l}</div>`).join('')}
            </div>
            <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
    `);
});

app.listen(port, () => { main(); });
