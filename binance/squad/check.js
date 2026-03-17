import { chromium } from 'playwright';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = 8886;
const userDataDir = path.join(__dirname, 'test_session');

// Hàm Log chi tiết
function logTest(message, data = "") {
    const time = new Date().toLocaleTimeString();
    console.log(`[${time}] ${message}`);
    if (data) console.error(data);
}

app.get('/', (req, res) => {
    res.send(`
        <body style="background:#222;color:#fff;text-align:center;padding:50px;">
            <h1>TEST HIỆN CHROME</h1>
            <button style="padding:20px;background:orange;cursor:pointer;" onclick="location.href='/open'">BẤM ĐỂ MỞ CHROME</button>
            <p id="msg"></p>
        </body>
    `);
});

app.get('/open', async (req, res) => {
    logTest("--- BẮT ĐẦU TEST MỞ CHROME ---");
    
    // Kiểm tra đường dẫn Chrome xịn
    const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const exists = fs.existsSync(chromePath);
    logTest(`Kiểm tra file exe: ${exists ? "TÌM THẤY" : "KHÔNG THẤY"}`);

    try {
        logTest("Đang gọi lệnh chromium.launchPersistentContext...");
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false, // Ép hiện
            executablePath: exists ? chromePath : undefined,
            args: [
                '--start-maximized',
                '--no-sandbox',
                '--disable-setuid-sandbox'
            ]
        });

        // Kiểm tra xem thực tế có phải đang chạy ẩn không (Playwright nội bộ)
        const isHeadless = context.browser() ? false : true; 
        if (isHeadless) {
            logTest("⚠️ CẢNH BÁO: Bot đang bị ép chạy ẩn (Headless Mode) bởi hệ thống!");
        } else {
            logTest("✅ Lệnh Headless: false đã được gửi thành công.");
        }

        const page = await context.newPage();
        logTest("Đang điều hướng tới Google.com...");
        await page.goto('https://www.google.com');
        
        res.json({ msg: "Đã thực hiện xong lệnh mở! Kiểm tra màn hình của ông." });
    } catch (err) {
        logTest("❌ LỖI KHI MỞ CHROME:", err.message);
        // Kiểm tra các lỗi phổ biến
        if (err.message.includes("used by another process")) {
            logTest("👉 Nguyên nhân: Folder 'test_session' đang bị một Chrome khác chiếm dụng.");
        }
        res.status(500).json({ error: err.message });
    }
});

app.listen(port, '0.0.0.0', () => {
    console.clear();
    console.log("========================================");
    console.log(`BOT TEST PORT: ${port}`);
    console.log(`Truy cập: http://localhost:${port}`);
    console.log("========================================");
});
