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

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function getCodeFromAI(prompt) {
    // 1. Thử dùng Google Gemini trước
    try {
        console.log("🤖 Đang thử Google Gemini...");
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const result = await model.generateContent(`Viết code Node.js cho: ${prompt}. Chỉ trả về code.`);
        return result.response.text();
    } catch (e) {
        console.warn("⚠️ Gemini lỗi, chuyển sang Groq Llama 3...");
        // 2. Nếu Gemini lỗi, dùng Groq
        const chatCompletion = await groq.chat.completions.create({
            messages: [{ role: "user", content: `Viết code Node.js cho: ${prompt}. Chỉ trả về code.` }],
            model: "llama-3.3-70b-versatile",
        });
        return chatCompletion.choices[0].message.content;
    }
}

app.post('/api/create-bot', async (req, res) => {
    const { appName, request } = req.body;
    const testDir = path.join(__dirname, 'test', appName);
    fs.ensureDirSync(testDir);
    
    try {
        const rawCode = await getCodeFromAI(request);
        const code = rawCode.replace(/```javascript|
```/g, "").trim();
        fs.writeFileSync(path.join(testDir, 'index.js'), code);

        exec(`node index.js`, { cwd: testDir, timeout: 5000 }, (error, stdout, stderr) => {
            if (error) return res.status(500).json({ error: "Code lỗi runtime" });
            fs.copySync(testDir, path.join(__dirname, 'product', appName));
            res.json({ status: "Success", path: `product/${appName}` });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(7777, () => console.log('🚀 Server kiếm tiền chạy tại http://localhost:7777'));
