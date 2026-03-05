const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

const PLAYLIST_URL = 'https://m.youtube.com/playlist?list=PLVhVhpOTVoO069xcj_lJH2A4pgUCI-4ov';
const MAX_THREADS = 24; // Bạn có thể tăng lên nếu CPU mạnh vì không còn nghẽn Proxy
const startTime = Date.now();

let stats = {
    totalViews: 0,
    totalWatchSeconds: 0,
    activeThreads: 0,
    threadStatus: {}, 
    logs: [] 
};

if (fs.existsSync(path.join(__dirname, 'temp'))) fs.removeSync(path.join(__dirname, 'temp'));

function fullLog(msg, type = 'INFO') {
    const logMsg = `[${new Date().toLocaleTimeString()}] [${type}] ${msg}`;
    stats.logs.unshift(logMsg);
    if (stats.logs.length > 100) stats.logs.pop();
}

async function runWorker() {
    stats.activeThreads++;
    const id = Math.random().toString(36).substring(7).toUpperCase();
    const userDataDir = path.join(__dirname, 'temp', `profile_${id}`);
    
    stats.threadStatus[id] = { 
        ip: 'DIRECT', 
        videoTitle: 'Đang kết nối...', 
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
                '--disable-web-security'
            ]
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0');
        await page.setDefaultNavigationTimeout(60000);
        
        while (true) {
            stats.threadStatus[id].status = '📂 Nạp Playlist';
            await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle2' });
            
            const videoLinks = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
                return [...new Set(links.map(a => a.href.split('&')[0]))]; 
            });

            if (!videoLinks || videoLinks.length === 0) throw new Error("Không lấy được danh sách video");

            for (let link of videoLinks) {
                stats.threadStatus[id].iteration++;
                await page.goto(link, { waitUntil: 'networkidle2' });
                
                stats.threadStatus[id].videoTitle = (await page.title()).replace('- YouTube', '').trim();
                stats.threadStatus[id].status = '📺 Đang Buff';
                
                // --- ÉP CHẤT LƯỢNG 144P & PLAY ---
                await page.evaluate(() => {
                    const video = document.querySelector('video');
                    if (video) { video.play(); video.muted = true; }
                    const player = document.getElementById('movie_player');
                    if (player && player.setPlaybackQualityRange) player.setPlaybackQualityRange('tiny');
                    const btn = document.querySelector('.ytp-play-button');
                    if (btn && btn.getAttribute('title')?.includes('Play')) btn.click();
                }).catch(() => {});

                const watchSeconds = Math.floor(Math.random() * 60) + 120;
                stats.threadStatus[id].target = watchSeconds;

                let actualWatchStart = 0;
                let lastCurrentTime = 0;
                let idleCount = 0;

                for (let s = 1; s <= watchSeconds + 120; s++) {
                    await new Promise(r => setTimeout(r, 1000));
                    
                    const videoData = await page.evaluate(() => {
                        const video = document.querySelector('video');
                        if (!video) return { err: 'Không tìm thấy Player' };
                        return { currentTime: video.currentTime };
                    }).catch(() => ({ err: 'Trình duyệt bị đơ' }));

                    if (videoData.err) throw new Error(videoData.err);

                    if (videoData.currentTime > lastCurrentTime) {
                        actualWatchStart++;
                        lastCurrentTime = videoData.currentTime;
                        idleCount = 0;
                    } else {
                        idleCount++;
                    }

                    stats.threadStatus[id].elapsed = actualWatchStart;
                    stats.totalWatchSeconds++;

                    if (actualWatchStart >= watchSeconds) break;
                    
                    // CHỐNG TREO: Nếu 60s không chạy (thường do mạng nhà lag hoặc CPU 100%)
                    if (idleCount >= 60 && actualWatchStart === 0) {
                        throw new Error("Video đứng im 1 phút - Reset luồng");
                    }
                }
                stats.totalViews++;
                fullLog(`[ID:${id}] Hoàn thành video: ${stats.threadStatus[id].videoTitle}`, 'SUCCESS');
            }
        }
    } catch (err) {
        fullLog(`[ID:${id}] Lỗi: ${err.message}`, 'ERROR');
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(userDataDir)) fs.removeSync(userDataDir);
        delete stats.threadStatus[id];
        stats.activeThreads--;
        // Tự động hồi sinh luồng mới sau khi luồng cũ kết thúc
        setTimeout(() => main(), 2000);
    }
}

app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:'Segoe UI', Tahoma, sans-serif; background:#050505; color:#eee; padding:20px; margin:0;">
            <div style="background:#111; padding:20px; border-bottom:5px solid #00ff00; position:sticky; top:0; z-index:100;">
                <h1 style="margin:0; color:#00ff00; display:flex; justify-content:space-between; align-items:center;">
                    YT-BOT DIRECT IP (NO PROXY)
                    <span style="font-size:14px; color:#aaa; font-weight:normal;">Uptime: ${Math.floor((Date.now()-startTime)/60000)}m</span>
                </h1>
                <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:15px; margin-top:20px;">
                    <div style="background:#1a1a1a; padding:15px; border-radius:10px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888;">TỔNG VIEWS</div><b style="font-size:24px; color:#2ed573;">${stats.totalViews}</b>
                    </div>
                    <div style="background:#1a1a1a; padding:15px; border-radius:10px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888;">GIỜ XEM</div><b style="font-size:24px; color:#70a1ff;">${Math.floor(stats.totalWatchSeconds/60)}m</b>
                    </div>
                    <div style="background:#1a1a1a; padding:15px; border-radius:10px; text-align:center; border:1px solid #333;">
                        <div style="font-size:11px; color:#888;">LUỒNG ĐANG CHẠY</div><b style="font-size:24px; color:#ff7f50;">${stats.activeThreads}/${MAX_THREADS}</b>
                    </div>
                </div>
            </div>
            <div style="padding:20px;">
                <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap:15px;">
                    ${Object.entries(stats.threadStatus).map(([id, t]) => `
                        <div style="background:#121212; border:1px solid #222; padding:15px; border-radius:10px;">
                            <b style="color:#00ff00;">THREAD ${id}</b>
                            <div style="font-size:12px; height:32px; overflow:hidden; margin:10px 0;">🎬 ${t.videoTitle}</div>
                            <div style="background:#000; height:6px; border-radius:3px;"><div style="width:${(t.elapsed/t.target)*100}%; background:#00ff00; height:100%;"></div></div>
                            <div style="display:flex; justify-content:space-between; font-size:11px; margin-top:5px;">
                                <span>${t.status}</span><span>${t.elapsed}/${t.target}s</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
                <h3 style="color:#eccc68; margin-top:30px;">📜 NHẬT KÝ HỆ THỐNG</h3>
                <div style="background:#000; border:1px solid #222; padding:10px; height:250px; overflow-y:auto; font-family:monospace; color:#00ff41; font-size:11px;">
                    ${stats.logs.map(line => `<div>${line}</div>`).join('')}
                </div>
            </div>
            <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
    `);
});

app.listen(port, () => { 
    console.log(`Monitor đang chạy tại: http://localhost:${port}`);
    main();
});

async function main() {
    if (stats.activeThreads < MAX_THREADS) {
        runWorker();
        // Giãn cách mở luồng tránh làm sập trình duyệt
        setTimeout(main, 1500);
    }
}
