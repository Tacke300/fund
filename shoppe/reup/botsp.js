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

// Hàm khởi tạo trình duyệt dùng chung để tránh lỗi executablePath
async function initBrowser() {
    return await puppeteer.launch({
        executablePath: '/usr/bin/chromium-browser', // ĐƯỜNG DẪN BẮT BUỘC TRÊN DCODER
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    });
}

async function loginShopee(creds, io) {
    try {
        if (browser) await browser.close();
        log(io, 'info', 'Khởi tạo trình duyệt Alpine...');
        
        browser = await initBrowser();
        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        if (fs.existsSync(COOKIE_PATH)) {
            const cookies = await fs.readJson(COOKIE_PATH);
            await page.setCookie(...cookies);
            log(io, 'success', 'Đã nạp cookie từ bộ nhớ');
        }

        await page.goto('https://shopee.vn/portal/affiliate/offer/product_offer', { waitUntil: 'networkidle2', timeout: 60000 });

        if (page.url().includes('login')) {
            log(io, 'warning', 'Cookie hết hạn, đang đăng nhập lại...');
            await page.goto('https://shopee.vn/buyer/login', { waitUntil: 'networkidle2' });
            await page.type('input[name="loginKey"]', creds.email, { delay: 100 });
            await page.type('input[name="password"]', creds.password, { delay: 100 });
            await page.click('button.vyS9tm, button[type="button"]');
            
            log(io, 'warning', '👉 Vui lòng check OTP trên điện thoại (đợi 2 phút)...');
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
    if (!page) return log(io, 'error', 'Bot chưa đăng nhập!');
    
    isRunning = true;
    let products = [];

    log(io, 'info', 'Đang quét sản phẩm Affiliate...');

    // Lắng nghe API
    const apiListener = async (res) => {
        const url = res.url();
        if (url.includes('product_offer') || url.includes('get_product_list')) {
            try {
                const json = await res.json();
                const list = json.data?.list || json.data?.nodes || [];
                list.forEach(p => {
                    if (p.item_id || p.itemid) {
                        products.push({ 
                            id: p.item_id || p.itemid, 
                            shopid: p.shop_id || p.shopid, 
                            name: p.name || p.item_name 
                        });
                    }
                });
            } catch (e) {}
        }
    };

    page.on('response', apiListener);

    try {
        await page.goto('https://shopee.vn/portal/affiliate/offer/product_offer', { waitUntil: 'networkidle2' });
        
        // Cuộn trang để kích hoạt API load dữ liệu
        log(io, 'info', 'Đang cuộn trang để tải dữ liệu...');
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                let distance = 100;
                let timer = setInterval(() => {
                    let scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if(totalHeight >= scrollHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
            });
        });

        await wait(5000); // Đợi API trả về hết
        page.off('response', apiListener);

        // Loại bỏ trùng lặp
        products = Array.from(new Set(products.map(p => p.id)))
            .map(id => products.find(p => p.id === id));

        if (products.length === 0) {
            log(io, 'warning', 'Không tìm thấy sản phẩm. Đang chụp ảnh màn hình debug...');
            await page.screenshot({ path: path.join(__dirname, 'debug-empty.png') });
            log(io, 'info', 'Hãy kiểm tra file debug-empty.png xem trang có bị kẹt không.');
        } else {
            log(io, 'success', `Tìm thấy ${products.length} sản phẩm.`);
            // Chạy loop xử lý sản phẩm như cũ của bạn ở đây...
        }

    } catch (e) {
        log(io, 'error', `Lỗi quét sản phẩm: ${e.message}`);
    }

    isRunning = false;
    io.emit('bot_finished');
}

function stopLoop(io) {
    isRunning = false;
    log(io, 'warning', 'Bot đã dừng.');
}

module.exports = { loginShopee, startLoop, stopLoop };
