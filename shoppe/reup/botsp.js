// bot.js
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

puppeteer.use(StealthPlugin());

// --- CẤU HÌNH ---
const COOKIE_PATH = path.join(__dirname, 'data', 'cookies.json');
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
fs.ensureDirSync(DOWNLOAD_DIR);

let browser = null;
let page = null;
let isRunning = false;

// --- TIỆN ÍCH ---
const log = (io, type, msg) => {
    const time = new Date().toLocaleTimeString('vi-VN');
    io.emit('log', { type, msg, time });
    console.log(`[${type}] ${msg}`);
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// --- XỬ LÝ VIDEO & API ---

// 1. Lấy Video Gốc từ Shopee API V4
async function getRealVideoUrl(itemid, shopid) {
    try {
        // API này công khai, không cần cookie
        const url = `https://shopee.vn/api/v4/item/get?itemid=${itemid}&shopid=${shopid}`;
        const { data } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)' }
        });
        
        if (data.data?.video_info_list?.[0]?.default_format?.url) {
            return data.data.video_info_list[0].default_format.url;
        }
        return null;
    } catch (e) { return null; }
}

// 2. Render Video (FFmpeg) - Tối ưu lách bản quyền
async function processVideo(input, output) {
    return new Promise((resolve, reject) => {
        ffmpeg(input)
            .videoFilters([
                'hflip',                // Lật gương
                'setpts=1.05*PTS',      // Giảm tốc độ 5%
                'eq=saturation=1.1',    // Tăng bão hòa màu
                'crop=iw*0.95:ih*0.95'  // Crop 5% viền
            ])
            .noAudio() // Xóa âm thanh gốc (tránh bản quyền nhạc) -> Nên ghép nhạc khác nếu muốn
            .on('end', () => resolve(output))
            .on('error', (err) => reject(err))
            .save(output);
    });
}

// 3. Tải Video
async function downloadFile(url, dest) {
    const writer = fs.createWriteStream(dest);
    const response = await axios({ url, method: 'GET', responseType: 'stream' });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

module.exports = {
    // --- LOGIC ĐĂNG NHẬP (CÓ LƯU COOKIE) ---
    login: async (creds, io) => {
        try {
            if (browser) await browser.close();
            log(io, 'info', 'Khởi tạo Browser...');
            
            browser = await puppeteer.launch({
                headless: false, // Bắt buộc False để nhập OTP
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800'],
                userDataDir: './user_data' // Lưu cache trình duyệt
            });
            page = await browser.newPage();

            // Check cookie cũ
            if (fs.existsSync(COOKIE_PATH)) {
                log(io, 'info', 'Phát hiện Cookie cũ, đang nạp...');
                const cookies = await fs.readJson(COOKIE_PATH);
                if (cookies.length > 0) await page.setCookie(...cookies);
            }

            log(io, 'warning', 'Truy cập Shopee...');
            await page.goto('https://shopee.vn/portal/affiliate', { waitUntil: 'networkidle2' });

            // Kiểm tra xem đã login chưa (nếu cookie sống)
            if (page.url().includes('login')) {
                log(io, 'warning', 'Cookie hết hạn. Đang đăng nhập lại...');
                await page.goto('https://shopee.vn/buyer/login', { waitUntil: 'networkidle2' });
                
                await page.type('input[name="loginKey"]', creds.email, { delay: 100 });
                await page.type('input[name="password"]', creds.password, { delay: 100 });
                
                log(io, 'warning', '⚠️ HÃY NHẬP OTP/CAPTCHA TRÊN TRÌNH DUYỆT (2 PHÚT)...');
                await page.waitForNavigation({ timeout: 120000 }); // Chờ người dùng login
            }

            // Lưu cookie mới
            const newCookies = await page.cookies();
            await fs.writeJson(COOKIE_PATH, newCookies);
            log(io, 'success', 'Đăng nhập thành công & Đã lưu Cookie!');
            return true;

        } catch (e) {
            log(io, 'error', `Login Lỗi: ${e.message}`);
            return false;
        }
    },

    stop: (io) => {
        isRunning = false;
        log(io, 'error', '🛑 ĐANG DỪNG TIẾN TRÌNH...');
    },

    // --- LOGIC CHẠY BOT ---
    start: async (io, dbPath) => {
        if (isRunning) return;
        isRunning = true;
        
        // 1. INTERCEPT API: Lấy list sản phẩm thật
        log(io, 'info', 'Đang quét danh sách sản phẩm (API Intercept)...');
        let productList = [];
        
        // Lắng nghe phản hồi mạng để bắt gói tin JSON
        const apiListener = async (res) => {
            const url = res.url();
            // URL API thật của Shopee (Thường chứa keyword này)
            if ((url.includes('offer/product_offer') || url.includes('offer/search')) && res.request().method() === 'GET') {
                try {
                    const json = await res.json();
                    const items = json.data?.list || [];
                    items.forEach(i => {
                        productList.push({
                            id: i.item_id,
                            shopid: i.shop_id,
                            name: i.name,
                            link: i.product_link,
                            commission: i.commission_rate
                        });
                    });
                } catch (e) {}
            }
        };
        page.on('response', apiListener);

        // Kích hoạt load trang
        await page.goto('https://shopee.vn/portal/affiliate/offer/product_offer', { waitUntil: 'networkidle2' });
        await wait(7000); // Chờ API trả về
        page.off('response', apiListener); // Tắt lắng nghe

        if (productList.length === 0) {
            log(io, 'error', 'Không bắt được sản phẩm nào. Hãy kiểm tra lại trang!');
            isRunning = false; return;
        }

        log(io, 'success', `✅ Đã lấy được ${productList.length} sản phẩm.`);

        // 2. LOOP XỬ LÝ
        const history = await fs.readJson(dbPath);
        const doneSet = new Set(history.map(h => h.id));

        for (const p of productList) {
            if (!isRunning) break;
            const uniqueId = `${p.shopid}_${p.id}`;

            if (doneSet.has(uniqueId)) {
                log(io, 'info', `⏭️ Đã làm: ${p.name.substring(0, 20)}...`);
                continue;
            }

            try {
                // A. Lấy Video
                log(io, 'info', `🔄 Xử lý: ${p.name}`);
                const videoUrl = await getRealVideoUrl(p.id, p.shopid);
                
                if (!videoUrl) {
                    log(io, 'warning', '⚠️ Sản phẩm không có video. Bỏ qua.');
                    continue;
                }

                // B. Tải & Render
                const rawPath = path.join(DOWNLOAD_DIR, `raw_${p.id}.mp4`);
                const finalPath = path.join(DOWNLOAD_DIR, `up_${p.id}.mp4`);
                
                io.emit('progress_update', { status: 'Đang tải video...', percent: 20 });
                await downloadFile(videoUrl, rawPath);
                
                io.emit('progress_update', { status: 'Đang Render FFmpeg...', percent: 50 });
                await processVideo(rawPath, finalPath);

                // C. Upload (Phần khó nhất - Sử dụng XPath text để ổn định hơn Class)
                io.emit('progress_update', { status: 'Đang Upload...', percent: 70 });
                await page.goto('https://shopee.vn/creator-center/upload', { waitUntil: 'networkidle0' });

                // 1. Upload File
                const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 15000 });
                await fileInput.uploadFile(finalPath);
                
                // Chờ thanh loading biến mất (Cần chỉnh selector thực tế nếu Shopee đổi)
                await wait(8000); 

                // 2. Điền Caption
                // Tìm ô textarea
                const captionInput = await page.waitForSelector('textarea', { timeout: 5000 }).catch(()=>null);
                if(captionInput) {
                    await captionInput.type(`${p.name}\n\n#review #shopee`, { delay: 50 });
                }

                // 3. Gắn Sản Phẩm (QUAN TRỌNG)
                log(io, 'info', 'Đang gắn Link sản phẩm...');
                // Tìm nút "Thêm sản phẩm" bằng text (XPath)
                const [addBtn] = await page.$x("//button[contains(., 'Thêm sản phẩm') or contains(., 'Add Product')]");
                if (addBtn) {
                    await addBtn.click();
                    await wait(2000);
                    
                    // Nhập ID sản phẩm vào ô tìm kiếm (Chính xác hơn nhập tên)
                    const searchInput = await page.waitForSelector('input[placeholder*="Tìm"]', {timeout: 5000});
                    // Để tìm chính xác, ta tìm theo Tên vì Portal Affliate trả về Tên chuẩn
                    if(searchInput) {
                        await searchInput.type(p.name, {delay: 50});
                        await page.keyboard.press('Enter');
                        await wait(3000);

                        // Chọn sản phẩm đầu tiên
                        const [selectBtn] = await page.$x("(//button[contains(., 'Thêm')])[1]"); 
                        if(selectBtn) await selectBtn.click();

                        // Nút Xong/Confirm
                        await wait(1000);
                        const [confirmBtn] = await page.$x("//button[contains(., 'Xác nhận') or contains(., 'OK')]");
                        if(confirmBtn) await confirmBtn.click();
                    }
                }

                // 4. Bấm Đăng (Publish)
                // log(io, 'warning', 'Đang bấm nút Đăng...');
                // const [pubBtn] = await page.$x("//button[contains(., 'Đăng') and not(@disabled)]");
                // if(pubBtn) await pubBtn.click();

                // === LƯU Ý: ĐỂ AN TOÀN, TÔI ĐỂ COMMENT DÒNG CLICK ĐĂNG ===
                // Bạn hãy bỏ comment dòng trên để nó đăng thật sau khi test ổn.
                // Hiện tại nó sẽ chỉ điền xong hết và dừng lại để bạn kiểm tra.

                log(io, 'success', `✅ Xong: ${p.name}`);
                
                // Lưu DB
                history.push({ 
                    id: uniqueId, name: p.name, 
                    time: new Date().toLocaleTimeString('vi-VN'), status: 'Done' 
                });
                await fs.writeJson(dbPath, history);
                doneSet.add(uniqueId);
                io.emit('update_stats');

                // Dọn dẹp
                fs.unlinkSync(rawPath);
                fs.unlinkSync(finalPath);

            } catch (err) {
                log(io, 'error', `Lỗi ${p.id}: ${err.message}`);
            }

            log(io, 'info', '⏳ Nghỉ 15 giây...');
            await wait(15000);
        }

        isRunning = false;
        io.emit('bot_finished');
        log(io, 'success', 'HOÀN TẤT!');
    }
};
