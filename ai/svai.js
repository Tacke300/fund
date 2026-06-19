require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const { exec, execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const openai = new OpenAI({ 
    baseURL: "https://openrouter.ai/api/v1", 
    apiKey: process.env.OPENROUTER_API_KEY 
});

const BASE_DIR = __dirname;
const MODEL = "openai/gpt-4o-mini"; // Model ổn định nhất

// Route chính
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/api/create-bot', async (req, res) => {
    const { appName, request } = req.body;
    const testDir = path.join(BASE_DIR, 'test', appName, `test_${Date.now()}`);
    
    console.log(`\n🚀 [SYSTEM] Bắt đầu workflow cho bot: ${appName}`);
    fs.ensureDirSync(testDir);

    try {
        // BƯỚC 1: CODER
        console.log(`🛠 [CODER] Đang tạo source code cho yêu cầu: "${request}"`);
        const coderRes = await openai.chat.completions.create({
            model: MODEL,
            messages: [{ role: "system", content: "Viết code Node.js hoàn chỉnh, không kèm giải thích." }, { role: "user", content: request }]
        });
        const code = coderRes.choices[0].message.content.replace(/```javascript|```/g, "").trim();
        fs.writeFileSync(path.join(testDir, 'index.js'), code);
        console.log(`✅ [CODER] Code đã được ghi vào ${testDir}/index.js`);

        // BƯỚC 2: REVIEWER
        console.log(`🔍 [REVIEWER] Đang kiểm tra logic code...`);
        const revRes = await openai.chat.completions.create({
            model: MODEL,
            messages: [{ role: "system", content: "Nếu code an toàn trả về 'OK', nếu không trả về lỗi." }, { role: "user", content: code }]
        });
        if (!revRes.choices[0].message.content.includes("OK")) {
            throw new Error("Reviewer từ chối code: " + revRes.choices[0].message.content);
        }
        console.log(`✅ [REVIEWER] Code đạt chuẩn.`);

        // BƯỚC 3: TESTER
        console.log(`🧪 [TESTER] Bắt đầu chạy test (timeout 5s)...`);
        exec(`node index.js`, { cwd: testDir, timeout: 5000 }, (error, stdout, stderr) => {
            if (error) {
                console.error(`❌ [TESTER] Lỗi thực thi: ${stderr || error.message}`);
                return res.status(500).json({ status: "Fail", error: "Test thất bại" });
            }
            
            // THÀNH CÔNG
            console.log(`🎉 [SUCCESS] Test pass! Đang đóng gói sản phẩm.`);
            const prodDir = path.join(BASE_DIR, 'product', appName);
            fs.ensureDirSync(prodDir);
            fs.copySync(testDir, prodDir);
            
            res.json({ status: "Success", path: `product/${appName}` });
        });

    } catch (e) {
        console.error(`🚨 [CRITICAL ERROR] ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

app.listen(7777, () => console.log('🚀 Server Pro Max đang chạy tại port 7777'));
