require('dotenv').config();
const express = require('express');
const Groq = require("groq-sdk");
const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const simpleGit = require('simple-git');

const app = express();
app.use(express.json({ limit: '50mb' }));

const git = simpleGit('C:\\Users\\ok\\fund');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Hàm làm sạch code (chỉ lấy code, loại bỏ chat nhảm)
function cleanCode(raw) {
    let code = raw.replace(/```javascript/g, '').replace(/```/g, '').trim();
    // Bỏ qua nếu AI cố tình chat
    const bannedStarts = ["Không", "Tôi", "Đây", "Dưới đây", "Xin", "Để"];
    if (bannedStarts.some(word => code.startsWith(word))) {
        throw new Error("AI trả lời chat, không phải code.");
    }
    return code;
}

async function askGroq(prompt, errorMsg = "") {
    const systemPrompt = `Viết code Node.js cho: ${prompt}. CHỈ TRẢ VỀ CODE, KHÔNG CHAT. ${errorMsg ? 'Sửa lỗi này: ' + errorMsg : ''}`;
    
    console.log(`🤖 [Groq] Đang gửi request...`);
    const chat = await groq.chat.completions.create({
        messages: [{ role: "user", content: systemPrompt }],
        model: "llama-3.3-70b-versatile",
    });
    
    return cleanCode(chat.choices[0].message.content);
}

async function startLoop(appName, request, attempt = 1) {
    const folder = path.join('C:\\Users\\ok\\fund\\product', appName);
    const filePath = path.join(folder, 'index.js');
    fs.ensureDirSync(folder);

    console.log(`🛠 [Lần ${attempt}] Đang chạy Groq...`);
    
    try {
        const code = await askGroq(request, attempt > 1 ? "Lỗi lần trước: " + appName : "");
        fs.writeFileSync(filePath, code);

        console.log("▶️ [Test] Đang chạy bot...");
        // Timeout 5s, nếu quá 5s chưa xong hoặc lỗi thì ném exception
        execSync(`node "${filePath}"`, { timeout: 5000 });
        
        console.log("✅ [Success] Code OK!");
        
        // Dọn Git Lock và Push
        const lockFile = path.join('C:\\Users\\ok\\fund', '.git', 'index.lock');
        if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
        
        await git.add('./*');
        await git.commit(`Bot ${appName} Auto-Fix`);
        await git.push('origin', 'main');
        return { status: "Success" };

    } catch (e) {
        console.error(`❌ [Lỗi]: ${e.message}`);
        // Nếu lỗi, thử lại tới 3 lần
        if (attempt < 3) return startLoop(appName, request, attempt + 1);
        return { status: "Failed", error: e.message };
    }
}

app.post('/api/create-bot', async (req, res) => {
    const { appName, request } = req.body;
    if (!appName || !request) return res.status(400).send("Thiếu thông tin");
    
    const result = await startLoop(appName, request);
    res.json(result);
});

app.listen(7777, () => console.log('🚀 Server Groq-Only đã chạy trên port 7777'));
