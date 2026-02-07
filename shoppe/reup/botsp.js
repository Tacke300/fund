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
    if (io) io.emit('log', { type, msg, time });
    console.log(`[${type.toUpperCase()}] [${time}] ${msg}`);
};

async function loginShopee(creds, io) {
    try {
        if (browser) await browser.close();
        log(io, 'info', 'Khởi tạo trình duyệt Alpine (Path: /usr/bin/chromium-browser)...');
        
        browser = await puppeteer.launch({
            executablePath: '/usr/bin/chromium-browser', // CỐ ĐỊNH ĐƯỜNG DẪN
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        if (fs.existsSync(COOKIE_PATH)) {
            const cookies = await fs.readJson(COOKIE_PATH);
            await page.setCookie(...cookies);
            log(io, 'success', 'Đã nạp cookie.');
        }

        log(io, 'info', 'Đang kiểm tra trạng thái đăng nhập...');
        await page.goto('https://shopee.vn/portal/affiliate/offer/product_offer', { waitUntil: 'networkidle2', timeout: 60000 });

        const currentUrl = page.url();
        const title = await page.title();
        log(io, 'info', `URL hiện tại: ${currentUrl}`);
        log(io, 'info', `Tiêu đề trang: ${title}`);

        if (currentUrl.includes('login') || title.includes('Login') || title.includes('Đăng nhập')) {
            log(io, 'warning', 'Trạng thái: CHƯA ĐĂNG NHẬP. Đang thử điền Form...');
            await page.goto('https://shopee.vn/buyer/login', { waitUntil: 'networkidle2' });
            await page.type('input[name="loginKey"]', creds.email, { delay: 100 });
            await page.type('input[name="password"]', creds.password, { delay: 100 });
            await page.click('button.vyS9tm, button[type="button"]');
            
            log(io, 'warning', '👉 Đợi bạn giải mã OTP/Captcha trên App (120s)...');
            await page.waitForNavigation({ timeout: 120000 });
            
            const cookiesAfter = await page.cookies();
            await fs.writeJson(COOKIE_PATH, cookiesAfter);
            log(io, 'success', 'Đã cập nhật Cookie mới.');
        } else {
            log(io, 'success', 'Trạng thái: ĐÃ ĐĂNG NHẬP.');
        }

        return true;
    } catch (e) {
        log(io, 'error', `Lỗi login: ${e.message}`);
        return false;
    }
}

async function startLoop(io, dbPath) {
    if (isRunning) return;
    if (!page) return log(io, 'error', 'Lỗi: Page rỗng, hãy Login trước!');
    
    isRunning = true;
    let products = [];

    log(io, 'info', 'Bắt đầu quét dữ liệu Affiliate...');

    // Lắng nghe API ngầm
    const apiListener = async (res) => {
        const url = res.url();
        if (url.includes('product_offer') || url.includes('get_product_list')) {
            try {
                const json = await res.json();
                const list = json.data?.list || json.data?.nodes || [];
                list.forEach(p => {
                    products.push({ id: p.item_id || p.itemid, shopid: p.shop_id || p.shopid, name: p.name });
                });
                log(io, 'info', `Hệ thống vừa bắt được API: ${list.length} SP`);
            } catch (e) {}
        }
    };

    page.on('response', apiListener);

    try {
        await page.goto('https://shopee.vn/portal/affiliate/offer/product_offer', { waitUntil: 'networkidle2' });
        
        // KIỂM TRA XEM CÓ BỊ CHẶN KHÔNG
        const pageTitle = await page.title();
        const pageUrl = page.url();
        log(io, 'info', `DEBUG - URL: ${pageUrl}`);
        log(io, 'info', `DEBUG - Title: ${pageTitle}`);

        // Đọc thử xem có chữ "Captcha" hay "Verification" trong HTML không
        const bodyText = await page.evaluate(() => document.body.innerText);
        if (bodyText.includes('CAPTCHA') || bodyText.includes('xác minh')) {
            log(io, 'error', 'DỪNG: Shopee đang hiện CAPTCHA thanh trượt. Bot không thể quét.');
        } else if (pageUrl.includes('login')) {
            log(io, 'error', 'DỪNG: Bị đá ra trang Login. Cookie đã hỏng.');
        } else {
            log(io, 'info', 'Đang cuộn trang để kích hoạt load dữ liệu...');
            await page.evaluate(() => window.scrollBy(0, 800));
            await wait(7000); 
        }

        page.off('response', apiListener);

        if (products.length === 0) {
            log(io, 'warning', 'KẾT QUẢ: 0 sản phẩm. Nguyên nhân: Trang trống hoặc bị Shopee chặn truy cập API.');
        } else {
            log(io, 'success', `TỔNG CỘNG: Tìm thấy ${products.length} sản phẩm.`);
            // Chạy loop render video của bạn...
        }

    } catch (e) {
        log(io, 'error', `Lỗi khi quét: ${e.message}`);
    }

    isRunning = false;
    io.emit('bot_finished');
}

module.exports = { loginShopee, startLoop, stopLoop: (io) => { isRunning = false; log(io, 'warning', 'Đã dừng bot.'); } };
