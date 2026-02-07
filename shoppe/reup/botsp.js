// botsp.js
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

puppeteer.use(StealthPlugin());

const COOKIE_PATH = path.join(__dirname, 'data', 'cookies.json');
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
fs.ensureDirSync(DOWNLOAD_DIR);
fs.ensureDirSync(path.join(__dirname, 'data'));

let browser = null;
let page = null;
let isRunning = false;

const wait = (ms) => new Promise(r => setTimeout(r, ms));

const log = (io, type, msg) => {
    const time = new Date().toLocaleTimeString('vi-VN');
    io.emit('log', { type, msg, time });
    console.log(`[${type}] ${msg}`);
};

async function getRealVideoUrl(itemid, shopid) {
    try {
        const url = `https://shopee.vn/api/v4/item/get?itemid=${itemid}&shopid=${shopid}`;
        const { data } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        return data?.data?.video_info_list?.[0]?.default_format?.url || null;
    } catch { return null; }
}

async function downloadFile(url, dest) {
    const writer = fs.createWriteStream(dest);
    const res = await axios({ url, method: 'GET', responseType: 'stream' });
    res.data.pipe(writer);
    return new Promise((ok, err) => {
        writer.on('finish', ok);
        writer.on('error', err);
    });
}

function processVideo(input, output) {
    return new Promise((resolve, reject) => {
        ffmpeg(input)
            .videoFilters(['hflip', 'setpts=1.05*PTS', 'eq=saturation=1.1', 'crop=iw*0.95:ih*0.95'])
            .noAudio()
            .on('end', () => resolve(output))
            .on('error', (err) => reject(err))
            .save(output);
    });
}

async function loginShopee(creds, io) {
    try {
        if (browser) await browser.close();
        log(io, 'info', 'Khởi tạo trình duyệt Alpine...');
        
        browser = await puppeteer.launch({
            executablePath: '/usr/bin/chromium-browser',
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });

        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        if (fs.existsSync(COOKIE_PATH)) {
            const cookies = await fs.readJson(COOKIE_PATH);
            await page.setCookie(...cookies);
            log(io, 'success', 'Đã nạp cookie từ bộ nhớ');
        }

        await page.goto('https://shopee.vn/portal/affiliate', { waitUntil: 'networkidle2', timeout: 60000 });

        if (page.url().includes('login')) {
            log(io, 'warning', 'Cần đăng nhập mới...');
            await page.goto('https://shopee.vn/buyer/login', { waitUntil: 'networkidle2' });
            await page.type('input[name="loginKey"]', creds.email, { delay: 100 });
            await page.type('input[name="password"]', creds.password, { delay: 100 });
            await page.click('button.vyS9tm, button[type="button"]');
            
            log(io, 'warning', 'Chờ xác thực OTP/Captcha (2 phút)...');
            await page.waitForNavigation({ timeout: 120000 });
        }

        const newCookies = await page.cookies();
        await fs.writeJson(COOKIE_PATH, newCookies);
        log(io, 'success', 'Đăng nhập thành công!');
        return true;
    } catch (e) {
        log(io, 'error', `Lỗi login: ${e.message}`);
        return false;
    }
}

async function startLoop(io, dbPath) {
    if (isRunning) return;
    isRunning = true;

    let history = [];
    try { history = await fs.readJson(dbPath); } catch {}
    const doneSet = new Set(history.map(x => x.id));

    log(io, 'info', 'Đang quét sản phẩm Affiliate...');
    let products = [];

    const apiListener = async (res) => {
        if (res.url().includes('product_offer')) {
            try {
                const json = await res.json();
                (json.data?.list || []).forEach(p => {
                    products.push({ id: p.item_id, shopid: p.shop_id, name: p.name });
                });
            } catch {}
        }
    };

    page.on('response', apiListener);
    await page.goto('https://shopee.vn/portal/affiliate/offer/product_offer', { waitUntil: 'networkidle2' });
    await wait(5000);
    page.off('response', apiListener);

    log(io, 'success', `Tìm thấy ${products.length} sản phẩm.`);

    for (let i = 0; i < products.length; i++) {
        if (!isRunning) break;
        const p = products[i];
        const uid = `${p.shopid}_${p.id}`;
        
        const percent = Math.round(((i + 1) / products.length) * 100);
        io.emit('progress_update', { status: `Đang xử lý: ${p.name}`, percent });

        if (doneSet.has(uid)) continue;

        try {
            log(io, 'info', `Tiến hành tải video: ${p.name}`);
            const videoUrl = await getRealVideoUrl(p.id, p.shopid);
            if (!videoUrl) { log(io, 'warning', 'Không có video, bỏ qua.'); continue; }

            const raw = path.join(DOWNLOAD_DIR, `raw_${p.id}.mp4`);
            const out = path.join(DOWNLOAD_DIR, `up_${p.id}.mp4`);

            await downloadFile(videoUrl, raw);
            await processVideo(raw, out);
            log(io, 'success', `Đã Render xong: ${p.id}`);

            history.push({ id: uid, name: p.name, date: new Date().toLocaleString('vi-VN') });
            await fs.writeJson(dbPath, history);
            doneSet.add(uid);
            io.emit('update_stats');

            if (fs.existsSync(raw)) fs.unlinkSync(raw);
            if (fs.existsSync(out)) fs.unlinkSync(out);

            await wait(10000); // Nghỉ 10s tránh bị quét
        } catch (e) { log(io, 'error', `Lỗi SP ${p.id}: ${e.message}`); }
    }

    isRunning = false;
    io.emit('bot_finished');
    log(io, 'success', 'Bot đã chạy xong danh sách.');
}

function stopLoop(io) {
    isRunning = false;
    log(io, 'warning', 'Bot đang dừng...');
}

module.exports = { loginShopee, startLoop, stopLoop };
