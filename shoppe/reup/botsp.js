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

let browser = null, page = null, isRunning = false;

const log = (io, type, msg) => {
    const time = new Date().toLocaleTimeString('vi-VN');
    if (io) io.emit('log', { type, msg, time });
    console.log(`[${type.toUpperCase()}] ${msg}`);
};

async function loginShopee(creds, io) {
    try {
        if (browser) await browser.close();
        log(io, 'info', 'Đang mở Chromium (Vui lòng đợi)...');
        
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
            log(io, 'success', 'Đã nạp Cookie cũ.');
        }

        // Tối ưu tốc độ: dùng 'domcontentloaded' thay vì 'networkidle2'
        await page.goto('https://shopee.vn/portal/affiliate/offer/product_offer', { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 3000));

        if (page.url().includes('login')) {
            log(io, 'warning', 'Cookie hết hạn. Đang thử đăng nhập bằng User/Pass...');
            await page.goto('https://shopee.vn/buyer/login');
            await page.type('input[name="loginKey"]', creds.email, { delay: 50 });
            await page.type('input[name="password"]', creds.password, { delay: 50 });
            await page.click('button.vyS9tm, button[type="button"]');
            log(io, 'warning', '👉 Hãy xác thực OTP trên điện thoại nếu có (2 phút)...');
            await page.waitForNavigation({ timeout: 120000 });
        }

        const newCookies = await page.cookies();
        await fs.writeJson(COOKIE_PATH, newCookies);
        log(io, 'success', 'Sẵn sàng hoạt động!');
        return true;
    } catch (e) {
        log(io, 'error', `Khởi tạo thất bại: ${e.message}`);
        return false;
    }
}

async function logoutShopee(io) {
    try {
        if (fs.existsSync(COOKIE_PATH)) fs.unlinkSync(COOKIE_PATH);
        if (browser) await browser.close();
        browser = null; page = null;
        log(io, 'warning', 'Đã đăng xuất và xóa Cookie.');
        return true;
    } catch (e) { return false; }
}

async function startLoop(io, dbPath) {
    if (isRunning) return;
    if (!page) return log(io, 'error', 'Bot chưa được khởi tạo. Hãy nhấn Kết nối trước!');

    isRunning = true;
    let products = [];

    const apiListener = async (res) => {
        if (res.url().includes('product_offer') || res.url().includes('get_product_list')) {
            try {
                const json = await res.json();
                const list = json.data?.list || json.data?.nodes || [];
                list.forEach(p => products.push({ id: p.item_id || p.itemid, shopid: p.shop_id || p.shopid, name: p.name }));
            } catch (e) {}
        }
    };

    page.on('response', apiListener);
    log(io, 'info', 'Đang quét danh sách sản phẩm...');

    try {
        await page.goto('https://shopee.vn/portal/affiliate/offer/product_offer', { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 5000));

        // Kiểm tra lỗi tại sao 0 sản phẩm
        const content = await page.content();
        const url = page.url();

        if (url.includes('login')) {
            log(io, 'error', 'LỖI: Bị đá ra trang đăng nhập. Hãy nhấn Đăng xuất rồi Kết nối lại.');
        } else if (content.includes('punish') || content.includes('captcha')) {
            log(io, 'error', 'LỖI: Shopee chặn Robot (Captcha). Hãy tạm dừng bot và thử lại sau.');
        } else if (products.length === 0) {
            log(io, 'warning', 'KHÔNG CÓ SẢN PHẨM: Tài khoản này có thể chưa đăng ký Shopee Affiliate hoặc danh sách trống.');
        } else {
            log(io, 'success', `Bắt đầu xử lý ${products.length} sản phẩm...`);
            // Logic xử lý video giữ nguyên...
        }
    } catch (e) {
        log(io, 'error', `Lỗi quét: ${e.message}`);
    }

    isRunning = false;
    io.emit('bot_finished');
}

module.exports = { loginShopee, logoutShopee, startLoop, stopLoop: (io) => { isRunning = false; log(io, 'warning', 'Đã dừng.'); } };
