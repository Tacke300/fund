const express = require('express');
const { OpenAI } = require('openai');
const { execSync, exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

const app = express();
app.use(express.json());

const BASE_DIR = 'C:\\Users\\ok\\fund\\ai';
const openai = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: "SK_CUA_BAN" });

// Hàm cài đặt môi trường cho mỗi bản test
function prepareTestEnv(testDir) {
    // 1. Tạo package.json cho bản test
    const pkg = { name: "bot-test", version: "1.0.0", main: "index.js" };
    fs.writeJsonSync(path.join(testDir, 'package.json'), pkg);
    
    // 2. Cài sẵn các thư viện hay dùng để bot không bị lỗi "Module not found"
    // Bạn có thể thêm bất cứ thư viện nào bot hay dùng vào đây
    console.log(`Đang cài môi trường cho: ${testDir}...`);
    try {
        execSync('npm install axios ccxt dotenv node-telegram-bot-api', { cwd: testDir, stdio: 'ignore' });
    } catch (e) {
        // Bỏ qua lỗi nếu không cài được
    }
}

app.post('/api/create-bot', async (req, res) => {
    const { appName, request } = req.body;
    let code = "";
    let lastError = "";

    for (let i = 1; i <= 5; i++) {
        const testDir = path.join(BASE_DIR, 'test', appName, `test_${i}`);
        fs.ensureDirSync(testDir);
        
        // Cài môi trường
        prepareTestEnv(testDir);

        // 1. Coder (AI)
        const coderRes = await openai.chat.completions.create({
            model: "anthropic/claude-3.5-sonnet",
            messages: [
                { role: "system", content: "Bạn là Senior Dev. Viết code bot Node.js. Chỉ trả về code sạch, dùng các thư viện phổ biến (axios, ccxt,...) nếu cần." },
                { role: "user", content: `Yêu cầu: ${request}. ${lastError ? `Lỗi cũ: ${lastError}. Sửa đi.` : ""}` }
            ]
        });
        code = coderRes.choices[0].message.content.replace(/```javascript|```/g, "").trim();
        fs.writeFileSync(path.join(testDir, 'index.js'), code);

        // 2. Tester (Chạy thử)
        const testResult = await new Promise((resolve) => {
            exec(`node index.js`, { cwd: testDir, timeout: 5000 }, (error, stdout, stderr) => {
                if (error) resolve({ success: false, error: stderr || error.message });
                else resolve({ success: true });
            });
        });

        // 3. Xử lý kết quả
        if (testResult.success) {
            const prodDir = path.join(BASE_DIR, 'product', appName);
            fs.copySync(testDir, prodDir);
            return res.json({ status: "Success", version: `test_${i}`, path: prodDir });
        } else {
            lastError = testResult.error;
            console.log(`Test ${i} thất bại: ${lastError}`);
        }
    }
    res.status(500).json({ error: "Thất bại sau 5 lần thử." });
});

app.listen(7777, () => console.log('System Pro Max đã sẵn sàng!'));
