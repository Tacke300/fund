require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const { exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const openai = new OpenAI({ 
    baseURL: "https://openrouter.ai/api/v1", 
    apiKey: process.env.OPENROUTER_API_KEY 
});

// Danh sách các model miễn phí dự phòng
const FREE_MODELS = [
    "google/gemini-2.0-flash-exp:free",
    "meta-llama/llama-3.1-8b-instruct:free",
    "qwen/qwen-2.5-7b-instruct:free"
];

// Hàm tự động gọi AI với cơ chế chuyển đổi model nếu lỗi
async function callAIWithFallback(messages, index = 0) {
    if (index >= FREE_MODELS.length) throw new Error("Tất cả model miễn phí đều đang bận!");
    
    try {
        console.log(`🤖 Đang dùng model: ${FREE_MODELS[index]}`);
        const completion = await openai.chat.completions.create({
            model: FREE_MODELS[index],
            messages: messages
        });
        return completion.choices[0].message.content;
    } catch (err) {
        console.warn(`⚠️ Model ${FREE_MODELS[index]} lỗi, đang chuyển sang model tiếp theo...`);
        return await callAIWithFallback(messages, index + 1);
    }
}

app.post('/api/create-bot', async (req, res) => {
    const { appName, request } = req.body;
    const testDir = path.join(__dirname, 'test', appName);
    fs.ensureDirSync(testDir);
    
    try {
        console.log(`\n🚀 [START] Tạo bot: ${appName}`);
        
        // Coder với cơ chế fallback
        const code = await callAIWithFallback([{ role: "user", content: `Viết code Node.js cho: ${request}. Chỉ trả về code.` }]);
        const cleanCode = code.replace(/```javascript|```/g, "").trim();
        fs.writeFileSync(path.join(testDir, 'index.js'), cleanCode);
        console.log(`✅ [CODER] Đã xong.`);

        // Tester
        console.log(`🧪 [TESTER] Chạy thử...`);
        exec(`node index.js`, { cwd: testDir, timeout: 5000 }, (error, stdout, stderr) => {
            if (error) {
                console.error(`❌ [TESTER] Lỗi: ${stderr}`);
                return res.status(500).json({ error: "Code lỗi" });
            }
            fs.copySync(testDir, path.join(__dirname, 'product', appName));
            res.json({ status: "Success", message: "Bot đã sẵn sàng!" });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(7777, () => console.log('🚀 Server Pro Max chạy tại http://localhost:7777'));
