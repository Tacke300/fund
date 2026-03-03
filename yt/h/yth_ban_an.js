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

// Cấu hình file và URL
const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 10; 
const BLACKLIST_FILE = './blacklist_proxy.json';
const GOOD_PROXIES_FILE = './good_proxies.json';
const COOKIE_FILE = './youtube_cookies.json';

let stats = {
    totalViews: 0, 
    totalSeconds: 0, 
    activeThreads: 0,
    proxiesScraped: 0,    
    proxiesFailed: 0,     
    proxiesSuccess: 0,    
    proxyReady: 0,
    goodCount: 0,
    threadStatus: {},
    logs: []              
};

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const fullLog = `[${time}] ${msg}`;
    console.log(fullLog);
    stats.logs.unshift(fullLog);
    if (stats.logs.length > 100) stats.logs.pop();
}

let proxyList = [];
let blacklist = fs.existsSync(BLACKLIST_FILE) ? fs.readJsonSync(BLACKLIST_FILE) : {};
let goodProxies = fs.existsSync(GOOD_PROXIES_FILE) ? fs.readJsonSync(GOOD_PROXIES_FILE) : [];

async function fetchProxies() {
    addLog("--- BẮT ĐẦU QUÉT NGUỒN PROXY ---");
    const sources = [
        'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/muhammadrizki16/proxy-list/main/http.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
        'https://proxyspace.pro/http.txt'
    ];

    let all = [];
    for (let s of sources) {
        try { 
            // Thêm Header để tránh bị GitHub chặn (Rate Limit)
            const res = await axios.get(s, { 
                timeout: 15000,
                headers: { 'User-Agent': 'Mozilla/5.0' } 
            }); 
            const lines = res.data.split('\n')
                .map(p => p.trim())
                .filter(p => p.includes(':') && /^\d/.test(p)); // Chỉ lấy dòng bắt đầu bằng số (IP)
            
            all = all.concat(lines);
            addLog(`NGUỒN OK: [${lines.length} IP] từ ${s.substring(0, 45)}...`);
        } catch(e) { 
            addLog(`NGUỒN LỖI: Không thể lấy từ ${s.split('/')[2]} (${e.message})`); 
        }
    }

    const unique = [...new Set(all)];
    stats.proxiesScraped = unique.length;
    
    proxyList = unique.filter(p => !blacklist[p]);
    stats.proxyReady = proxyList.length;
    stats.goodCount = goodProxies.length;
    addLog(`HOÀN TẤT: Tổng thu thập ${unique.length} | Sẵn dụng ${proxyList.length} | Đã Blacklist ${Object.keys(blacklist).length}`);
}

async function runWorker(proxy) {
    stats.activeThreads++;
    const id = Math.random().toString(36).substring(7).toUpperCase();
    const userDataDir = path.join(__dirname, 'temp', `profile_${id}`);
    
    stats.threadStatus[id] = { proxy, title: '---', elapsed: 0, target: 0, lastAction: 'Khởi tạo trình duyệt', iteration: 0 };

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            userDataDir: userDataDir,
            args: [
                `--proxy-server=http://${proxy}`, 
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--mute-audio',
                '--ignore-certificate-errors'
            ]
        });

        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(60000);

        if (fs.existsSync(COOKIE_FILE)) {
            const cookies = await fs.readJson(COOKIE_FILE);
            await page.setCookie(...cookies);
        }

        addLog(`[${id}] Thử kết nối Proxy: ${proxy}`);
        stats.threadStatus[id].lastAction = 'Đang truy cập YT...';
        
        const resp = await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
        
        if (!resp) throw new Error("Proxy không phản hồi (Connection Timeout)");
        if (resp.status() === 403) throw new Error("YouTube chặn Proxy này (403 Forbidden)");
        if (resp.status() >= 500) throw new Error(`Lỗi Server YT (${resp.status()})`);

        // Click vào video đầu tiên trong playlist
        const clicked = await page.evaluate(() => {
            const b = document.querySelector('a.ytd-playlist-thumbnail') || document.querySelector('#video-title');
            if (b) { b.click(); return true; }
            return false;
        });

        if (!clicked) throw new Error("Không thể nhấn vào video (Giao diện lỗi hoặc Proxy quá chậm)");

        for (let i = 0; i < 5; i++) {
            await new Promise(r => setTimeout(r, 10000)); // Đợi video load
            const title = await page.title();
            
            if (title.includes("Before you") || title === "YouTube" || title === "Cảnh báo về nội dung") {
                throw new Error("Bị kẹt ở màn hình xác thực/chặn của YT");
            }

            if (i === 0) {
                stats.proxiesSuccess++;
                if (!goodProxies.includes(proxy)) {
                    goodProxies.push(proxy);
                    fs.writeJsonSync(GOOD_PROXIES_FILE, goodProxies);
                }
            }

            const watchTime = Math.floor(Math.random() * 40) + 180;
            stats.threadStatus[id].title = title;
            stats.threadStatus[id].target = watchTime;
            stats.threadStatus[id].elapsed = 0;
            stats.threadStatus[id].iteration = i + 1;
            stats.threadStatus[id].lastAction = 'Đang xem video';
            
            addLog(`[${id}] Đang xem (${i+1}/5): ${title.substring(0,30)}`);

            for (let s = 0; s < watchTime; s++) {
                await new Promise(r => setTimeout(r, 1000));
                stats.threadStatus[id].elapsed++;
                stats.totalSeconds++;
                // Cập nhật log mỗi 60s để biết bot không treo
                if (s % 60 === 0 && s > 0) addLog(`[${id}] Đã xem được ${s} giây...`);
            }

            stats.totalViews++;
            
            // Nhấn nút Next
            const moved = await page.evaluate(() => {
                const n = document.querySelector('.ytp-next-button');
                if (n && window.getComputedStyle(n).display !== 'none') { n.click(); return true; }
                return false;
            });
            if (!moved) {
                addLog(`[${id}] Không tìm thấy nút Next, kết thúc vòng lặp.`);
                break;
            }
        }

    } catch (err) {
        addLog(`[${id}] THẤT BẠI: ${err.message}`);
        stats.proxiesFailed++;
        blacklist[proxy] = true;
        // Lưu blacklist ngay lập tức để luồng khác không lấy trúng
        fs.writeJsonSync(BLACKLIST_FILE, blacklist);
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        delete stats.threadStatus[id];
        stats.activeThreads--;
        addLog(`[${id}] Đã đóng trình duyệt, dọn dẹp xong.`);
    }
}

async function main() {
    addLog("HỆ THỐNG BẮT ĐẦU CHẠY...");
    while (true) {
        if (proxyList.length < 10) {
            await fetchProxies();
        }
        
        if (stats.activeThreads < MAX_THREADS && proxyList.length > 0) {
            const p = proxyList.shift();
            runWorker(p);
            // Delay giữa các lần mở trình duyệt để tránh nghẽn CPU
            await new Promise(r => setTimeout(r, 5000));
        } else {
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:monospace; background:#f4f4f4; padding:20px; color:#333">
            <h2 style="border-bottom:2px solid #333">BẢNG ĐIỀU KHIỂN BOT YOUTUBE</h2>
            
            <div style="display:flex; gap:15px; margin-bottom:20px">
                <div style="background:#fff; padding:15px; border:1px solid #ccc; flex:1">
                    <b>THỐNG KÊ VIEW</b><br>
                    <span style="font-size:20px">Views: ${stats.totalViews}</span><br>
                    Thời gian: ${Math.floor(stats.totalSeconds/3600)}h ${Math.floor((stats.totalSeconds%3600)/60)}m
                </div>
                <div style="background:#fff; padding:15px; border:1px solid #ccc; flex:1">
                    <b>TRẠNG THÁI PROXY</b><br>
                    Quét được: ${stats.proxiesScraped} | Chờ: ${proxyList.length}<br>
                    Thành công: <span style="color:green; font-weight:bold">${stats.proxiesSuccess}</span><br>
                    Bị loại (Lỗi/Chặn): <span style="color:red; font-weight:bold">${stats.proxiesFailed}</span>
                </div>
            </div>

            <b>LUỒNG ĐANG HOẠT ĐỘNG (${stats.activeThreads}/${MAX_THREADS})</b>
            <table border="1" style="width:100%; border-collapse:collapse; background:#fff; margin-top:10px; font-size:12px">
                <tr style="background:#eee">
                    <th>ID</th><th>Proxy</th><th>Video Đang Xem</th><th>Tiến Độ</th><th>Hành Động</th>
                </tr>
                ${Object.entries(stats.threadStatus).map(([id, t]) => `
                <tr>
                    <td align="center">${id}</td>
                    <td>${t.proxy}</td>
                    <td><b>[${t.iteration}]</b> ${t.title}</td>
                    <td align="center">${t.elapsed}/${t.target}s</td>
                    <td style="color:blue">${t.lastAction}</td>
                </tr>`).join('')}
            </table>

            <br>
            <b>LOG CHI TIẾT HỆ THỐNG</b><br>
            <div style="width:100%; height:300px; background:#222; color:#eee; padding:10px; overflow-y:scroll; font-size:11px; line-height:1.5em">
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
