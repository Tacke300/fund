require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Groq = require("groq-sdk");
const { exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const simpleGit = require('simple-git');

const app = express();
app.use(express.json());

const git = simpleGit('C:\\Users\\ok\\fund');
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || "dummy");
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || "dummy" });

async function askAI(prompt, isFixing = false, errorMsg = "") {
    const systemPrompt = isFixing 
        ? `Code bị lỗi: ${errorMsg}. Hãy sửa code và trả về code mới, không giải thích.`
        : `Viết code Node.js cho: ${prompt}. Chỉ trả về code, không giải thích.`;

    // ƯU TIÊN GROQ TRƯỚC
    console.log("🤖 [AI] Đang gọi Groq (Ưu tiên 1)...");
    try {
        const chat = await groq.chat.completions.create({
            messages: [{ role: "user", content: systemPrompt }],
            model: "llama-3.3-70b-versatile",
        });
        console.log("✅ [AI] Groq phản hồi thành công.");
        return chat.choices[0].message.content;
    } catch (e) {
        console.warn("⚠️ [AI] Groq lỗi, chuyển sang Gemini (Dự phòng)...");
        try {
            const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
            const result = await model.generateContent(systemPrompt);
            console.log("✅ [AI] Gemini phản hồi thành công.");
            return result.response.text();
        } catch (err) {
            console.error("❌ [AI] Cả hai đều tạch!");
            throw new Error("AI không phản hồi");
        }
    }
}

async function gitCommitPush(message) {
    console.log(`📡 [Git] Đang commit: ${message}...`);
    try {
        await git.add('./*');
        await git.commit(message);
        await git.push('origin', 'main');
        console.log(`✅ [Git] Đã đẩy lên GitHub.`);
    } catch (e) { console.error("❌ [Git] Lỗi:", e.message); }
}

async function runAndFix(appName, code, attempt = 1) {
    const filePath = path.join('C:\\Users\\ok\\fund\\product', appName, 'index.js');
    fs.ensureDirSync(path.dirname(filePath));
    
    console.log(`💾 [File] Đang lưu code vào: ${filePath}`);
    const cleanCode = code.split('```javascript').join('').split('
```').join('').trim();
    fs.writeFileSync(filePath, cleanCode);
    
    await gitCommitPush(`Bot ${appName} - Lần thử ${attempt}`);

    console.log(`▶️ [Run] Đang khởi chạy file... (Lần ${attempt})`);
    
    return new Promise((resolve) => {
        exec(`node ${filePath}`, { timeout: 15000 }, async (error, stdout, stderr) => {
            if (!error) {
                console.log(`✅ [Success] Bot ${appName} chạy ổn định!`);
                resolve({ status: "Success" });
            } else {
                console.error(`❌ [Error] Bot bị crash:`, stderr);
                if (attempt < 3) {
                    console.log("🛠 [Fix] Đang yêu cầu AI sửa lỗi...");
                    const fixedCode = await askAI(appName, true, stderr);
                    resolve(await runAndFix(appName, fixedCode, attempt + 1));
                } else {
                    console.error("⛔ [Stop] Đã sửa 3 lần vẫn lỗi. Bot vô dụng.");
                    resolve({ status: "Failed", error: stderr });
                }
            }
        });
    });
}

app.post('/api/create-bot', async (req, res) => {
    const { appName, request } = req.body;
    console.log(`\n🚀 [Request] Nhận yêu cầu: ${appName}`);
    try {
        const rawCode = await askAI(request);
        const result = await runAndFix(appName, rawCode);
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(7777, () => console.log('🚀 Server đã chạy. Port 7777'));
