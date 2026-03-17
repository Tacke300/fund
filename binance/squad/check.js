import { chromium } from 'playwright';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = 8885;
const userDataDir = path.join(__dirname, 'test_session_auto');

// --- HÀM TỰ DỌN DẸP HỆ THỐNG ---
function autoCleanup() {
    console.log("🧹 ĐANG TỰ ĐỘNG DỌN DẸP HỆ THỐNG...");
    try {
        // 1. Giết các tiến trình Chrome/Node đang chạy ngầm để giải phóng file/cổng
        if (process.platform === 'win32') {
            try { execSync('taskkill /F /IM chrome.exe /T 2>nul || exit 0'); } catch (e) {}
            // Không kill chính node.exe đang chạy bản thân nó, chỉ kill các bản cũ nếu cần
        }

        // 2. Xóa sạch folder session cũ
        if (fs.existsSync(userDataDir)) {
            fs.rmSync(userDataDir, { recursive: true, force: true });
            console.log(`✅ Đã xóa folder cũ: ${userDataDir}`);
        }
    } catch (err) {
        console.log("⚠️ Lỗi khi dọn dẹp (có thể file đang bị khóa):", err.message);
    }
}

// Chạy dọn dẹp ngay khi khởi động
autoCleanup();

app.get('/', (req, res) => {
    res.send(`
        <body style="background:#111;color:#00ff00;text-align:center;padding:50px;font-family:monospace;">
            <h1>SYSTEM AUTO-CLEAN READY</h1>
            <p>Trạng thái: Đã dọn sạch session cũ</p>
            <button style="padding:20px;background:#00ff00;color:#000;font-weight:bold;cursor:pointer;" 
                    onclick="location.href='/open'">BẤM ĐỂ MỞ CHROME THẬT</button>
        </body>
    `);
});

app.get('/open', async (req, res) => {
    console.log("\n--- [BẮT ĐẦU MỞ CHROME] ---");
    
    const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    
    try {
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false, // ÉP HIỆN
            executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
            args: [
                '--start-maximized',
                '--no-sandbox',
                '--disable-blink-features=AutomationControlled'
            ]
        });

        const page = await context.newPage();
        console.log("🚀 Đang truy cập Google.com...");
        await page.goto('https://www.google.com', { timeout: 60000 });
        
        console.log("✅ Chrome đã mở thành công và hiện trên màn hình.");
        res.json({ msg: "Chrome đã mở thành công!" });

    } catch (err) {
        console.log("\n❌ LỖI LOG CHI TIẾT ĐÂY ÔNG GIÁO:");
        console.error(err); // In toàn bộ cục lỗi (stack trace) ra terminal
        res.status(500).json({ 
            error: err.message,
            stack: err.stack 
        });
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`\n========================================`);
    console.log(`SERVER LIVE: http://localhost:${port}`);
    console.log(`FOLDER SESSION: ${userDataDir}`);
    console.log(`========================================\n`);
});
