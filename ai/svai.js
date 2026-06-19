require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Groq = require("groq-sdk");
const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const simpleGit = require('simple-git');

const app = express();
app.use(express.json());

const git = simpleGit('C:\\Users\\ok\\fund');
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || "dummy");
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || "dummy" });

// 1. Dọn Git Lock để không bị treo
function cleanGitLock() {
    const lockFile = path.join('C:\\Users\\ok\\fund', '.git', 'index.lock');
    if (fs.existsSync(lockFile)) {
        console.log("🧹 [Git] Đã tìm thấy index.lock, đang xóa...");
        fs.unlinkSync(lockFile);
    }
}

// 2. Lọc sạch code (Cực gắt)
function sanitizeCode(raw) {
    let clean = raw.replace(/```javascript/g, '').replace(/```/g, '');
    // Nếu AI vẫn chèn văn bản, chỉ lấy đoạn có code (thường là bắt đầu bằng require hoặc import)
    const startIdx = clean.search(/(require|import|const|let|var)/);
    if (startIdx !== -1) clean = clean.substring(startIdx);
    return clean.trim();
}

async function askAI(prompt, errorMsg = "") {
    const systemPrompt = errorMsg 
        ? `Lỗi code: ${errorMsg}. Sửa code này. Chỉ trả về CODE, không nói chuyện, không giải thích.`
        : `Viết code Node.js cho: ${prompt}. Chỉ trả về code, tuyệt đối không chèn văn bản vào file.`;

    console.log(`🤖 [AI] Đang gọi Groq...`);
    try {
        const chat = await groq.chat.completions.create({
            messages: [{ role: "user", content: systemPrompt }],
            model: "llama-3.3-70b-versatile",
        });
        return sanitizeCode(chat.choices[0].message.content);
    } catch (e) {
        console.error("❌ [AI] Groq lỗi, thử Gemini...");
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const res = await model.generateContent(systemPrompt);
        return sanitizeCode(res.response.text());
    }
}

async function runTest(filePath) {
    try {
        console.log("▶️ [Test] Đang chạy thử...");
        // Dùng execSync để test nhanh
        execSync(`node "${filePath}"`, { timeout: 5000 });
        return { success: true };
    } catch (e) {
        return { success: false, error: e.stderr ? e.stderr.toString() : e.message };
    }
}

async function startLoop(appName, request, attempt = 1) {
    const filePath = path.join('C:\\Users\\ok\\fund\\product', appName, 'index.js');
    fs.ensureDirSync(path.dirname(filePath));

    console.log(`🛠 [Lần ${attempt}] Đang nhờ AI tạo/sửa code...`);
    const code = await askAI(request, attempt > 1 ? "Code cũ bị lỗi" : "");
    fs.writeFileSync(filePath, code);

    const testResult = await runTest(filePath);

    if (testResult.success) {
        console.log("✅ [Success] Code chạy OK!");
        cleanGitLock();
        await git.add('./*');
        await git.commit(`Fixed Bot ${appName} - Lần ${attempt}`);
        await git.push('origin', 'main');
        return { status: "Success", attempt };
    } else {
        console.log(`❌ [Error] Code lỗi: ${testResult.error.substring(0, 50)}...`);
        if (attempt < 4) return startLoop(appName, request, attempt + 1);
        return { status: "Failed", error: testResult.error };
    }
}

app.post('/api/create-bot', async (req, res) => {
    const { appName, request } = req.body;
    try {
        const result = await startLoop(appName, request);
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(7777, () => console.log('🚀 Server đã sẵn sàng.'));
