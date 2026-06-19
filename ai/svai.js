require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Groq = require("groq-sdk");
const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const simpleGit = require('simple-git');

const app = express();

// --- BẮT BUỘC CÓ DÒNG NÀY Ở ĐẦU ---
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const git = simpleGit('C:\\Users\\ok\\fund');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || "dummy");

// --- HÀM TỰ DỌN DẸP ---
const sanitizeCode = (raw) => {
    let code = raw.replace(/```javascript/g, '').replace(/```/g, '').trim();
    // Chặn AI "chat chit" ngay từ bước đầu
    const bannedStarts = ["Không", "Tôi", "Đây", "Dưới đây", "Xin", "Để"];
    if (bannedStarts.some(word => code.startsWith(word))) {
        throw new Error("AI returned chat text instead of code.");
    }
    return code;
};

// --- HÀM GỌI AI ---
async function askAI(prompt, errorMsg = "") {
    const systemPrompt = `Viết code Node.js cho: ${prompt}. CHỈ TRẢ VỀ CODE. KHÔNG CHAT. ${errorMsg ? 'Sửa lỗi này: ' + errorMsg : ''}`;
    try {
        const chat = await groq.chat.completions.create({
            messages: [{ role: "user", content: systemPrompt }],
            model: "llama-3.3-70b-versatile",
        });
        return sanitizeCode(chat.choices[0].message.content);
    } catch (e) {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const res = await model.generateContent(systemPrompt);
        return sanitizeCode(res.response.text());
    }
}

// --- VÒNG LẶP CHÍNH ---
async function startLoop(appName, request, attempt = 1) {
    const folder = path.join('C:\\Users\\ok\\fund\\product', appName);
    const filePath = path.join(folder, 'index.js');
    fs.ensureDirSync(folder);

    console.log(`🛠 [Lần ${attempt}] Đang xử lý: ${appName}`);
    
    try {
        const code = await askAI(request, attempt > 1 ? "Lỗi lần trước: " + appName : "");
        fs.writeFileSync(filePath, code);

        // Kiểm tra nhanh trước khi chạy
        if (code.length < 10) throw new Error("Code quá ngắn hoặc rỗng");

        console.log("▶️ [Test] Đang chạy thử...");
        execSync(`node "${filePath}"`, { timeout: 3000 });
        
        // Thành công thì Push
        console.log("✅ [Success] Code OK!");
        const lockFile = path.join('C:\\Users\\ok\\fund', '.git', 'index.lock');
        if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
        
        await git.add('./*');
        await git.commit(`Bot ${appName} Ready`);
        await git.push('origin', 'main');
        return { status: "Success" };

    } catch (e) {
        console.error(`❌ [Error]: ${e.message}`);
        if (attempt < 3) return startLoop(appName, request, attempt + 1);
        return { status: "Failed", error: e.message };
    }
}

// --- API ENDPOINT AN TOÀN ---
app.post('/api/create-bot', async (req, res) => {
    // Check an toàn: Nếu body không có dữ liệu, trả lỗi 400 thay vì crash
    if (!req.body || !req.body.appName || !req.body.request) {
        return res.status(400).json({ error: "Invalid request payload. Must include appName and request." });
    }
    
    try {
        const { appName, request } = req.body;
        const result = await startLoop(appName, request);
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(7777, () => console.log('🚀 Server đã chạy. Port 7777'));
