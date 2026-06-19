require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const { exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// Kiểm tra API Key
if (!process.env.OPENROUTER_API_KEY) {
    console.error("❌ LỖI: Chưa có API Key trong file .env");
    process.exit(1);
}

const openai = new OpenAI({ 
    baseURL: "https://openrouter.ai/api/v1", 
    apiKey: process.env.OPENROUTER_API_KEY 
});

app.post('/api/create-bot', async (req, res) => {
    const { appName, request } = req.body;
    const testDir = path.join(__dirname, 'test', appName);
    fs.ensureDirSync(testDir);
    
    console.log(`\n🚀 Bắt đầu workflow cho: ${appName}`);

    try {
        // Coder
        console.log(`🛠 [1/3] AI Coder đang viết code...`);
        const completion = await openai.chat.completions.create({
            model: "openai/gpt-4o-mini",
            messages: [{ role: "user", content: `Viết code Node.js cho yêu cầu: ${request}. Chỉ trả về code.` }]
        });
        const code = completion.choices[0].message.content.replace(/```javascript|```/g, "").trim();
        fs.writeFileSync(path.join(testDir, 'index.js'), code);

        // Reviewer
        console.log(`🔍 [2/3] Reviewer đang kiểm tra...`);
        // Code review logic tại đây...

        // Tester
        console.log(`🧪 [3/3] Tester đang chạy test...`);
        exec(`node index.js`, { cwd: testDir, timeout: 5000 }, (error, stdout, stderr) => {
            if (error) {
                console.log(`❌ Lỗi Test: ${stderr}`);
                return res.status(500).json({ error: "Code lỗi khi chạy" });
            }
            fs.copySync(testDir, path.join(__dirname, 'product', appName));
            console.log(`✅ Hoàn tất! Bot lưu tại: product/${appName}`);
            res.json({ status: "Success" });
        });
    } catch (e) {
        console.error(`🚨 Lỗi AI: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

app.listen(7777, () => console.log('🚀 Server chạy tại http://localhost:7777'));
