// botsp.js
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

puppeteer.use(StealthPlugin());

// ================== CẤU HÌNH ==================
const COOKIE_PATH = path.join(__dirname, 'data', 'cookies.json');
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
fs.ensureDirSync(DOWNLOAD_DIR);
fs.ensureDirSync(path.join(__dirname, 'data'));

let browser = null;
let page = null;
let isRunning = false;

// ================== TIỆN ÍCH ==================
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const log = (io, type, msg) => {
    const time = new Date().toLocaleTimeString('vi-VN');
    io.emit('log', { type, msg, time });
    console.log(`[${type}] ${msg}`);
};

// ================== VIDEO ==================
async function getRealVideoUrl(itemid, shopid) {
    try {
        const url = `https://shopee.vn/api/v4/item/get?itemid=${itemid}&shopid=${shopid}`;
        const { data } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (iPhone)' }
        });
        return data?.data?.video_info_list?.[0]?.default_format?.url || null;
    } catch {
        return null;
    }
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
            .videoFilters([
                'hflip',
                'setpts=1.05*PTS',
                'eq=saturation=1.1',
                'crop=iw*0.95:ih*0.95'
            ])
            .noAudio()
            .on('end', () => resolve(output))
            .on('error', reject)
            .save(output);
    });
}

// ================== CORE ==================
async function loginShopee(creds, io) {
    try {
        if (browser) await browser.close();

        log(io, 'info', 'Khởi tạo trình duyệt...');
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            userDataDir: './user_data'
        });

        page = await browser.newPage();

        if (fs.existsSync(COOKIE_PATH)) {
            const cookies = await fs.readJson(COOKIE_PATH);
            if (cookies.length) {
                await page.setCookie(...cookies);
                log(io, 'info', 'Đã nạp cookie cũ');
            }
        }

        await page.goto('https://shopee.vn/portal/affiliate', { waitUntil: 'networkidle2' });

        if (page.url().includes('login')) {
            log(io, 'warning', 'Cần đăng nhập thủ công (OTP)');
            await page.goto('https://shopee.vn/buyer/login', { waitUntil: 'networkidle2' });

            await page.type('input[name="loginKey"]', creds.email, { delay: 80 });
            await page.type('input[name="password"]', creds.password, { delay: 80 });

            log(io, 'warning', '👉 Nhập OTP/CAPTCHA trong 2 phút');
            await page.waitForNavigation({ timeout: 120000 });
        }

        const newCookies = await page.cookies();
        await fs.writeJson(COOKIE_PATH, newCookies);

        log(io, 'success', 'Đăng nhập Shopee thành công');
        return true;
    } catch (e) {
        log(io, 'error', `Login lỗi: ${e.message}`);
        return false;
    }
}

async function startLoop(io, dbPath) {
    if (isRunning) return;
    isRunning = true;

    let history = [];
    try { history = await fs.readJson(dbPath); } catch {}
    const doneSet = new Set(history.map(x => x.id));

    log(io, 'info', 'Quét danh sách sản phẩm...');
    let products = [];

    const apiListener = async (res) => {
        const url = res.url();
        if (url.includes('product_offer') && res.request().method() === 'GET') {
            try {
                const json = await res.json();
                (json.data?.list || []).forEach(p => {
                    products.push({
                        id: p.item_id,
                        shopid: p.shop_id,
                        name: p.name
                    });
                });
            } catch {}
        }
    };

    page.on('response', apiListener);
    await page.goto('https://shopee.vn/portal/affiliate/offer/product_offer', { waitUntil: 'networkidle2' });
    await wait(7000);
    page.off('response', apiListener);

    log(io, 'success', `Lấy được ${products.length} sản phẩm`);

    for (const p of products) {
        if (!isRunning) break;

        const uid = `${p.shopid}_${p.id}`;
        if (doneSet.has(uid)) continue;

        try {
            log(io, 'info', `Xử lý: ${p.name}`);
            const videoUrl = await getRealVideoUrl(p.id, p.shopid);
            if (!videoUrl) continue;

            const raw = path.join(DOWNLOAD_DIR, `raw_${p.id}.mp4`);
            const out = path.join(DOWNLOAD_DIR, `up_${p.id}.mp4`);

            await downloadFile(videoUrl, raw);
            await processVideo(raw, out);

            log(io, 'info', 'Upload video (test)');
            // 👉 Chưa auto đăng để an toàn

            history.push({ id: uid, name: p.name, time: Date.now() });
            await fs.writeJson(dbPath, history);
            doneSet.add(uid);

            fs.unlinkSync(raw);
            fs.unlinkSync(out);

            await wait(15000);
        } catch (e) {
            log(io, 'error', e.message);
        }
    }

    isRunning = false;
    log(io, 'success', 'Bot hoàn tất');
}

function stopLoop(io) {
    isRunning = false;
    log(io, 'warning', 'Bot đã dừng');
}

// ================== EXPORT (QUAN TRỌNG) ==================
module.exports = {
    loginShopee,
    startLoop,
    stopLoop
};
