const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const express = require('express');
const axios = require('axios');

puppeteer.use(StealthPlugin());
const app = express();
const port = 1111;

let stats = { totalViews: 0, activeThreads: 0, currentProxy: "Đang lấy...", logs: [] };
let proxyList = [];

// 1. Hàm tự động lấy danh sách 500+ Proxy miễn phí
async function refreshProxies() {
    try {
        const res = await axios.get('https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all');
        proxyList = res.data.split('\r\n').filter(p => p.length > 0);
        stats.currentProxy = `Đã tải ${proxyList.length} proxy mới`;
    } catch (e) {
        console.log("Lỗi lấy Proxy, dùng IP gốc của VPS...");
    }
}

// 2. Hàm xử lý xem video
async function startWorker(proxy) {
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--mute-audio',
            '--disable-gpu',
            proxy ? `--proxy-server=http://${proxy}` : '' // Dùng Proxy nếu có
        ].filter(Boolean)
    });

    const page = await browser.newPage();
    try {
        stats.activeThreads++;
        // Ép User-Agent ngẫu nhiên
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36');

        console.log(`[+] Đang chạy Proxy: ${proxy || 'IP Gốc'}`);
        await page.goto('LINK_PLAYLIST_CỦA_ÔNG', { waitUntil: 'networkidle2', timeout: 60000 });

        // Tự động bấm nút Play Playlist
        await page.click('a.ytd-playlist-thumbnail').catch(() => {});

        // Ép 144p ngẫu nhiên trong khoảng 2-5 phút
        await page.evaluate(() => {
            const setLowRes = () => {
                const btn = document.querySelector('.ytp-settings-button');
                if (btn) btn.click();
                setTimeout(() => {
                    const items = document.querySelectorAll('.ytp-menuitem');
                    const q = [...items].find(i => i.textContent.includes('Quality'));
                    if (q) q.click();
                    setTimeout(() => {
                        const levels = document.querySelectorAll('.ytp-menuitem');
                        const res = [...levels].find(l => l.textContent.includes('144p'));
                        if (res) res.click();
                    }, 500);
                }, 500);
            };
            setLowRes();
        });

        const watchTime = Math.floor(Math.random() * (300000 - 120000 + 1)) + 120000;
        await new Promise(r => setTimeout(r, watchTime));

        stats.totalViews++;
        stats.logs.push(`Thành công: ${proxy || 'Local IP'} lúc ${new Date().toLocaleTimeString()}`);
    } catch (err) {
        console.log("Lỗi luồng, bỏ qua...");
    } finally {
        stats.activeThreads--;
        await browser.close();
    }
}

// 3. Vòng lặp chính: Hết một vòng (hoặc số lượng nhất định) sẽ đổi Proxy
async function mainLoop() {
    while (true) {
        await refreshProxies();
        
        // Chạy song song 3 luồng (tùy RAM VPS ông, yếu thì để 2-3 thôi)
        for (let i = 0; i < proxyList.slice(0, 10).length; i++) {
            await startWorker(proxyList[i]);
            // Nghỉ 10s giữa các lần mở tránh quá tải VPS
            await new Promise(r => setTimeout(r, 10000));
        }
        
        stats.logs.push("--- ĐÃ XONG 1 VÒNG, ĐỔI DANH SÁCH PROXY MỚI ---");
    }
}

// 4. Giao diện Dashboard HTML
app.get('/', (req, res) => {
    res.send(`
        <body style="font-family:sans-serif; background:#0f0f0f; color:#fff; padding:40px">
            <h1 style="color:#ff0000">📺 YouTube SSH Bot Pro v2</h1>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px">
                <div style="background:#222; padding:20px; border-radius:10px">
                    <h3>Tổng lượt xem</h3> <p style="font-size:30px">${stats.totalViews}</p>
                </div>
                <div style="background:#222; padding:20px; border-radius:10px">
                    <h3>Luồng đang chạy</h3> <p style="font-size:30px">${stats.activeThreads}</p>
                </div>
            </div>
            <h4>Proxy đang nạp: <span style="color:#00ff00">${stats.currentProxy}</span></h4>
            <h4>Nhật ký:</h4>
            <div style="background:#000; padding:10px; height:200px; overflow-y:scroll; font-family:monospace; font-size:12px">
                ${stats.logs.reverse().map(l => `<div>> ${l}</div>`).join('')}
            </div>
            <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`Xem kết quả tại: http://IP_VPS:1111`);
    mainLoop();
});
