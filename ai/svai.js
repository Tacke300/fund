require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Groq = require("groq-sdk");
const { exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// Khởi tạo AI Clients
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || "fallback");
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || "fallback" });

async function getCodeFromAI(prompt) {
    // 1. Thử Google Gemini trước
    try {
        console.log("🤖 Đang gọi Google Gemini...");
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const result = await model.generateContent(`Viết code Node.js cho yêu cầu sau. Chỉ trả về code, không giải thích: ${prompt}`);
        return result.response.text();
    } catch (e) {
        console.warn("⚠️ Gemini lỗi, chuyển sang Groq...");
        // 2. Dự phòng: Groq
        const chat = await groq.chat.completions.create({
            messages: [{ role: "user", content: `Viết code Node.js cho: ${prompt}. Chỉ trả về code.` }],
            model: "llama-3.3-70b-versatile",
        });
        return chat.choices[0].message.content;
    }
}

app.post('/api/create-bot', async (req, res) => {
    const { appName, request } = req.body;
    const testDir = path.join(__dirname, 'test', appName);
    fs.ensureDirSync(testDir);
    
    try {
        const rawCode = await getCodeFromAI(request);
        // Dòng này đã được gộp lại, không xuống dòng
        const cleanCode = rawCode.replace(/```javascript|
```/g, "").trim();
        fs.writeFileSync(path.join(testDir, 'index.js'), cleanCode);
        console.log("✅ Code đã được tạo thành công.");

        exec(`node index.js`, { cwd: testDir, timeout: 5000 }, (error, stdout, stderr) => {
            if (error) {
                console.error("❌ Code bị lỗi runtime:", stderr);
                return res.status(500).json({ error: "Code chạy lỗi" });
            }
            fs.copySync(testDir, path.join(__dirname, 'product', appName));
            res.json({ status: "Success", path: `product/${appName}` });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(7777, () => console.log('🚀 Server kiếm tiền đã sẵn sàng tại http://localhost:7777'));
