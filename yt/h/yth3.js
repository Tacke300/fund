const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 12; 
const startTime = Date.now();

let stats = {
    totalViews: 0,
    totalWatchSeconds: 0,
    activeThreads: 0,
    threadStatus: {}, 
    logs: [] 
};

// Xóa rác temp cũ khi khởi động lại
if (fs.existsSync(path.join(__dirname, 'temp'))) fs.removeSync(path.join(__dirname, 'temp'));

function fullLog(msg, type = 'INFO') {
    const logMsg = `[${new Date().toLocaleTimeString()}] [${type}] ${msg}`;
    stats.logs.unshift(logMsg);
    if (stats.logs.length > 150) stats.logs.pop();
    console.log(logMsg);
}

async function runWorker() {
    stats.activeThreads++;
    const id = Math.random().toString(36).substring(7).toUpperCase();
    const userDataDir = path.join(__dirname, 'temp', `profile_${id}`);
    
    stats.threadStatus[id] = { 
        videoTitle: 'Đang khởi tạo...', 
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
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-gpu', 
                '--mute-audio',
                '--window-size=800,600'
            ]
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        
        while (true) {
            stats.threadStatus[id].status = '📂 Nạp Playlist';
            fullLog(`[ID:${id}] Đang mở danh sách phát...`, 'WAIT');
            
            await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2', timeout: 60000 });
            
            const videoLinks = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
                return [...new Set(links.map(a => a.href.split('&')[0]))]; 
            });

            if (!videoLinks || videoLinks.length === 0) {
                fullLog(`[ID:${id}] Không tìm thấy video. Thử lại sau 5s...`, 'WARN');
                await new Promise(r => setTimeout(r, 5000));
                continue;
            }

            for (let link of videoLinks) {
                stats.threadStatus[id].iteration++;
                stats.threadStatus[id].elapsed = 0; 
                stats.threadStatus[id].status = '🔗 Nạp Video';

                fullLog(`[ID:${id}] Chuyển hướng: ${link}`, 'LINK');
                await page.goto(link, { waitUntil: 'networkidle2', timeout: 60000 });
                
                const rawTitle = await page.title();
                stats.threadStatus[id].videoTitle = rawTitle.replace('- YouTube', '').trim();
                
                // Kích hoạt Player
                fullLog(`[ID:${id}] Đang kích hoạt Player (144p)...`, 'ACTION');
                await page.evaluate(async () => {
                    const v = document.querySelector('video');
                    if (v) { v.play(); v.muted = true; }
                    // Ép chất lượng thấp nhất để tiết kiệm băng thông
                    const player = document.getElementById('movie_player');
                    if (player && player.setPlaybackQualityRange) player.setPlaybackQualityRange('tiny');
                }).catch(() => {});

                const watchSeconds = Math.floor(Math.random() * 40) + 100; // Xem khoảng 100-140s
                stats.threadStatus[id].target = watchSeconds;
                stats.threadStatus[id].status = '⏳ Đang chờ Play...';

                let actualWatchStart = 0;
                let lastTime = -1;
                let idleCount = 0;

                // Vòng lặp đếm giây thực tế
                for (let s = 1; s <= watchSeconds + 60; s++) {
                    await new Promise(r => setTimeout(r, 1000));
                    
                    const curTime = await page.evaluate(() => {
                        const v = document.querySelector('video');
                        return v ? v.currentTime : -2;
                    }).catch(() => -2);

                    if (curTime > lastTime && curTime > 0) {
                        // VIDEO ĐANG CHẠY THẬT
                        if (actualWatchStart === 0) {
                            fullLog(`[ID:${id}] Video bắt đầu chạy! Đang đếm giây...`, 'START');
                            stats.threadStatus[id].status = '📺 Đang Buff';
                        }
                        actualWatchStart++;
                        lastTime = curTime;
                        idleCount = 0;
                        
                        stats.threadStatus[id].elapsed = actualWatchStart;
                        stats.totalWatchSeconds++;
                    } else {
                        // VIDEO ĐANG ĐỨNG (LOADING HOẶC LỖI)
                        idleCount++;
                        stats.threadStatus[id].status = '⏳ Đang Loading...';
                    }

                    if (actualWatchStart >= watchSeconds) break;
                    
                    if (idleCount >= 45) {
                        fullLog(`[ID:${id}] Video đứng hình quá lâu. Bỏ qua video này.`, 'FAIL');
                        break; 
                    }
                }
                stats.totalViews++;
                fullLog(`[ID:${id}] Hoàn thành: ${stats.threadStatus[id].videoTitle}`, 'SUCCESS');
            }
        }
    } catch (err) {
        fullLog(`[ID:${id}] Lỗi hệ thống: ${err.message}`, 'FATAL');
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        delete stats.threadStatus[id];
        stats.activeThreads--;
        setTimeout(() => main(), 3000); 
    }
}

// GIAO DIỆN MONITOR RED-BLACK
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:sans-serif; background:#050505; color:#eee; padding:20px; margin:0;">
            <div style="background:#111; padding:20px; border-bottom:5px solid #ff0000; position:sticky; top:0; z-index:100;">
                <h1 style="margin:0; color:#ff0000; display:flex; justify-content:space-between; align-items:center;">
                    🔴 YT-BOT DIRECT IP (NO PROXY)
                    <span style="font-size:14px; color:#666; font-weight:normal;">Uptime: ${Math.floor((Date.now()-startTime)/60000)}m</span>
                </h1>
                <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:15px; margin-top:20px;">
                    <div style="background:#1a1a1a; padding:15px; border-radius:8px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888;">TỔNG VIEWS</div><b style="font-size:24px; color:#2ed573;">${stats.totalViews}</b>
                    </div>
                    <div style="background:#1a1a1a; padding:15px; border-radius:8px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888;">GIỜ XEM</div><b style="font-size:24px; color:#70a1ff;">${Math.floor(stats.totalWatchSeconds/60)}m</b>
                    </div>
                    <div style="background:#1a1a1a; padding:15px; border-radius:8px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888;">LUỒNG CHẠY</div><b style="font-size:24px; color:#ff7f50;">${stats.activeThreads}/${MAX_THREADS}</b>
                    </div>
                </div>
            </div>
            <div style="padding:20px;">
                <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap:15px;">
                    ${Object.entries(stats.threadStatus).map(([id, t]) => `
                        <div style="background:#121212; border:1px solid #222; padding:15px; border-radius:8px; border-left: 4px solid ${t.elapsed > 0 ? '#2ed573' : '#ff0000'};">
                            <b style="color:#ff0000; font-size:14px;">THREAD: ${id}</b>
                            <div style="font-size:12px; height:32px; overflow:hidden; margin:10px 0; color:#fff;">🎬 ${t.videoTitle}</div>
                            <div style="background:#000; height:6px; border-radius:3px; margin-bottom:10px;">
                                <div style="width:${(t.elapsed/t.target)*100}%; background:#2ed573; height:100%; transition: 0.5s;"></div>
                            </div>
                            <div style="display:flex; justify-content:space-between; font-size:11px;">
                                <span style="color:#eccc68;">${t.status}</span>
                                <span>${t.elapsed}/${t.target}s</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
                <h3 style="color:#ff0000; margin-top:30px;">📜 LOG HỆ THỐNG CHI TIẾT</h3>
                <div style="background:#000; border:1px solid #222; padding:15px; height:300px; overflow-y:auto; font-family:monospace; color:#00ff41; font-size:12px; line-height:1.6;">
                    ${stats.logs.map(line => `<div>${line}</div>`).join('')}
                </div>
            </div>
            <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
    `);
});

app.listen(port, () => { 
    console.log(`Monitor sẵn sàng tại http://localhost:${port}`);
    main();
});

async function main() {
    if (stats.activeThreads < MAX_THREADS) {
        runWorker();
        setTimeout(main, 2000); 
    }
}
