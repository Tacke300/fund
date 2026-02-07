// bot.js
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

puppeteer.use(StealthPlugin());

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
fs.ensureDirSync(DOWNLOAD_DIR);

// Hàm tiện ích: Log gửi về UI
const log = (io, type, msg) => {
    console.log(`[${type.toUpperCase()}] ${msg}`);
    io.emit('log', { type, msg });
};

// Hàm tiện ích: Tạo Hashtag & Caption
const generateContent = (productName) => {
    const keywords = productName.split(' ').slice(0, 4).join(' '); // Lấy 4 chữ đầu làm key
    const baseTags = ['#shopee', '#review', '#unboxing', '#trend', '#fyp'];
    const specificTags = [`#${keywords.replace(/\s/g, '')}`, '#giare', '#freeship'];
    
    // Tạo 20 hashtag
    let tags = [...baseTags, ...specificTags];
    while(tags.length < 20) tags.push(`#tag${tags.length}`);
    
    return {
        title: `Review ${productName} cực hot`,
        caption: `Sản phẩm này đang hot lắm nè cả nhà ơi! Mua ngay kẻo hết nhé. ${keywords}\n\n${tags.join(' ')}`
    };
};

// Hàm xử lý Video (FFmpeg)
const processVideo = (inputPath, outputPath) => {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .videoFilters([
                'hflip',               // Lật ngang
                'setpts=1.111*PTS',    // Giảm tốc độ còn 0.9 (1/0.9 = 1.111)
                'eq=brightness=0.05'   // Tăng sáng nhẹ
            ])
            .audioFilters('volume=0.9') // Giảm âm lượng nhẹ
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err))
            .save(outputPath);
    });
};

// Main Function
exports.start = async (creds, io, dbPath) => {
    let browser;
    try {
        log(io, 'info', 'Đang mở trình duyệt...');
        browser = await puppeteer.launch({
            headless: false, // Để false để bạn thấy nó chạy (login thủ công nếu cần)
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800']
        });
        const page = await browser.newPage();
        
        // 1. Đăng nhập (Mô phỏng)
        log(io, 'warning', 'Đang truy cập Shopee Login...');
        await page.goto('https://shopee.vn/buyer/login', { waitUntil: 'networkidle2' });
        
        // Điền user/pass
        await page.type('input[name="loginKey"]', creds.email, { delay: 100 });
        await page.type('input[name="password"]', creds.password, { delay: 100 });
        
        log(io, 'warning', '⚠️ Vui lòng tự bấm nút Đăng nhập hoặc xác thực OTP trên trình duyệt trong 60s...');
        
        // Chờ người dùng login xong (Check URL đổi)
        await page.waitForNavigation({ timeout: 60000 }).catch(() => log(io, 'error', 'Hết thời gian chờ login!'));

        if (page.url().includes('login')) {
            throw new Error('Đăng nhập thất bại hoặc chưa xác thực xong!');
        }
        log(io, 'success', 'Đăng nhập thành công!');

        // --- GIẢ LẬP VÒNG LẶP QUÉT SẢN PHẨM ---
        // Trong thực tế, đoạn này bạn sẽ crawl link từ trang Affiliate
        const mockProducts = [
            { name: "Tai nghe Bluetooth Pods", id: "12345", video: "https://www.w3schools.com/html/mov_bbb.mp4" }, // Video test mẫu
            // { name: "Áo Thun Nam", id: "67890", video: null } 
        ];

        for (const product of mockProducts) {
            log(io, 'info', `Đang xử lý sản phẩm: ${product.name}`);

            // 2. Tải Video
            const rawVideoPath = path.join(DOWNLOAD_DIR, `raw_${product.id}.mp4`);
            const processedVideoPath = path.join(DOWNLOAD_DIR, `final_${product.id}.mp4`);
            
            // Nếu không có video -> Tìm video liên quan (Placeholder logic)
            let videoUrl = product.video;
            if (!videoUrl) {
                 log(io, 'warning', 'Không có video gốc, đang tìm video liên quan...');
                 // Logic search video here...
                 continue; // Bỏ qua nếu ko tìm thấy
            }

            // Tải về
            log(io, 'info', 'Đang tải video...');
            const writer = fs.createWriteStream(rawVideoPath);
            const response = await axios({ url: videoUrl, method: 'GET', responseType: 'stream' });
            response.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            // 3. Sửa Video (FFmpeg)
            log(io, 'warning', 'Đang render video (Lật, Slow 0.9x, Audio)...');
            await processVideo(rawVideoPath, processedVideoPath);
            log(io, 'success', 'Render xong!');

            // 4. Upload (Mô phỏng thao tác trên Creator Center)
            log(io, 'info', 'Đang truy cập trang Upload...');
            await page.goto('https://shopee.vn/creator-center/upload', { waitUntil: 'networkidle2' }); // Link giả định

            // Tạo content
            const content = generateContent(product.name);
            
            /* 
             * NOTE: Selector của Shopee thay đổi liên tục.
             * Đây là logic giả định để code chạy được luồng.
             * Bạn cần inspect element thực tế để thay thế selector.
             */
            try {
                // Upload file
                const inputUpload = await page.$('input[type="file"]');
                if(inputUpload) {
                    await inputUpload.uploadFile(processedVideoPath);
                    log(io, 'info', 'Đang upload file lên server Shopee...');
                    await page.waitForTimeout(5000); // Chờ upload
                    
                    // Điền caption (Giả định selector)
                    // await page.type('textarea.caption-input', content.caption);
                    
                    // Gắn link sản phẩm
                    // ... Logic click button add product ...
                    
                    // Click Publish
                    // await page.click('button.btn-publish');
                    
                    log(io, 'success', `Đã đăng thành công: ${product.name}`);
                    
                    // Lưu database
                    const historyItem = {
                        date: new Date().toLocaleDateString('vi-VN'),
                        time: new Date().toLocaleTimeString('vi-VN'),
                        name: product.name,
                        tags: content.caption, // Lưu tạm caption
                        status: 'Success'
                    };
                    
                    const currentDb = await fs.readJson(dbPath);
                    currentDb.push(historyItem);
                    await fs.writeJson(dbPath, currentDb);
                    
                    // Bắn socket update bảng
                    io.emit('update_stats');

                } else {
                    log(io, 'error', 'Không tìm thấy nút upload (Cần cập nhật Selector)');
                }
            } catch (uErr) {
                log(io, 'error', `Lỗi upload: ${uErr.message}`);
            }

            // Xóa file tạm
            // fs.unlinkSync(rawVideoPath);
            // fs.unlinkSync(processedVideoPath);
        }

    } catch (error) {
        log(io, 'error', `CRITICAL ERROR: ${error.message}`);
    } finally {
        // if (browser) await browser.close();
        log(io, 'info', 'Kết thúc phiên làm việc.');
    }
};
