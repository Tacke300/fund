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

const git = simpleGit('C:\\Users\\ok\\fund'); // Đảm bảo đường dẫn này khớp với thư mục chứa .git
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || "dummy");
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || "dummy" });

// Hàm AI trung tâm
async function askAI(prompt, isFixing = false, errorMsg = "") {
    const systemPrompt = isFixing 
        ? `Mày là senior developer. Code này bị lỗi: ${errorMsg}. Hãy sửa code và trả về code mới, không giải thích.`
        : `Viết code Node.js cho: ${prompt}. Chỉ trả về code, không giải thích.`;

    try {
        console.log("🤖 Đang hỏi Gemini...");
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const result = await model.generateContent(systemPrompt);
        return result.response.text();
    } catch (e) {
        console.warn("⚠️ Gemini tạch, sang Groq...");
        const chat = await groq.chat.completions.create({
            messages: [{ role: "user", content: systemPrompt }],
            model: "llama-3.3-70b-versatile",
        });
        return chat.choices[0].message.content;
    }
}

// Hàm đẩy lên Git
async function gitCommitPush(message) {
    try {
        await git.add('./*');
        await git.commit(message);
        await git.push('origin', 'main');
        console.log(`✅ Git Push: ${message}`);
    } catch (e) { console.error("❌ Git lỗi:", e.message); }
}

// Hàm chạy và tự fix
async function runAndFix(appName, code, attempt = 1) {
    const maxRetries = 3;
    const filePath = path.join('C:\\Users\\ok\\fund\\product', appName, 'index.js');
    fs.ensureDirSync(path.dirname(filePath));
    
    // Ghi code vào file
    const cleanCode = code.split('```javascript').join('').split('```').join('').trim();
    fs.writeFileSync(filePath, cleanCode);
    await gitCommitPush(`V${attempt}: Bot ${appName}`);

    console.log(`▶️ Đang chạy thử lần ${attempt}...`);
    
    return new Promise((resolve) => {
        exec(`node ${filePath}`, { timeout: 10000 }, async (error, stdout, stderr) => {
            if (!error) {
                console.log(`✅ Chạy thành công: ${appName}`);
                resolve({ status: "Success" });
            } else if (attempt < maxRetries) {
                console.error(`❌ Lỗi runtime (Lần ${attempt}):`, stderr);
                console.log("🛠 Đang bảo AI fix lỗi...");
                const fixedCode = await askAI(appName, true, stderr);
                resolve(await runAndFix(appName, fixedCode, attempt + 1));
            } else {
                console.error("⛔ Đã quá giới hạn sửa lỗi!");
                resolve({ status: "Failed", error: stderr });
            }
        });
    });
}

app.post('/api/create-bot', async (req, res) => {
    const { appName, request } = req.body;
    console.log(`🚀 Nhận yêu cầu tạo bot: ${appName}`);
    try {
        const rawCode = await askAI(request);
        const result = await runAndFix(appName, rawCode);
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(7777, () => console.log('🚀 Server đã chạy. Port 7777'));
