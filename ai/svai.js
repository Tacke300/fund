require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Groq = require("groq-sdk");
const { exec, execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const simpleGit = require('simple-git');

const app = express();
const git = simpleGit('C:\\Users\\ok\\fund');
const MAX_ATTEMPTS = 5;

// --- DỌN DẸP GIT LOCK (Sửa bệnh cũ) ---
function cleanGitLock() {
    const lock = path.join('C:\\Users\\ok\\fund', '.git', 'index.lock');
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
}

// --- AI AGENT - XỬ LÝ KỊCH BẢN ---
async function askAI(prompt, errorLog = "") {
    const systemInstruction = `
    Bạn là Senior Developer.
    Nhiệm vụ: Viết hoặc Sửa code Node.js.
    Quy tắc:
    1. Trả về RAW CODE (không markdown, không giải thích).
    2. Nếu có lỗi trước đó: ${errorLog ? "Code cũ bị lỗi: " + errorLog + ". Hãy phân tích lỗi và sửa ngay." : "Tạo mới."}
    3. Tự động kiểm tra import. Nếu thiếu thư viện, hãy comment: // INSTALL: <package_name>
    `;

    const model = new Groq({ apiKey: process.env.GROQ_API_KEY }).chat.completions;
    try {
        const completion = await model.create({
            messages: [{ role: "system", content: systemInstruction }, { role: "user", content: prompt }],
            model: "llama-3.3-70b-versatile",
        });
        return completion.choices[0].message.content.replace(/```javascript/g, '').replace(/```/g, '').trim();
    } catch (e) {
        // Fallback Gemini
        const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
        const res = await genAI.getGenerativeModel({ model: "gemini-2.0-flash" }).generateContent(systemInstruction + prompt);
        return res.response.text().replace(/```javascript/g, '').replace(/```/g, '').trim();
    }
}

// --- ENGINE: TỰ CÀI ĐẶT & CHẠY THỬ ---
async function runDevCycle(appName, request, attempt = 1, lastError = "") {
    const workDir = path.join('C:\\Users\\ok\\fund\\product', appName);
    const filePath = path.join(workDir, 'index.js');
    fs.ensureDirSync(workDir);

    console.log(`\n🤖 [Vòng lặp ${attempt}/${MAX_ATTEMPTS}] Đang xử lý: ${appName}...`);
    
    // 1. Lấy code
    const code = await askAI(request, lastError);
    fs.writeFileSync(filePath, code);

    // 2. Tự cài thư viện
    const installMatch = code.match(/\/\/\s*INSTALL:\s*(.*)/);
    if (installMatch) {
        console.log(`📦 [Dependencies] Phát hiện cần cài: ${installMatch[1]}`);
        try { execSync(`npm install ${installMatch[1]}`, { cwd: workDir, stdio: 'ignore' }); } catch(e) {}
    }

    // 3. Chạy thử và bắt lỗi
    console.log(`▶️ [Execution] Đang test bot...`);
    return new Promise((resolve) => {
        const proc = exec(`node index.js`, { cwd: workDir });
        let logs = "";
        proc.stdout.on('data', (d) => logs += d);
        proc.stderr.on('data', (d) => logs += d);

        // Chờ 5s để xem bot có chết yểu không
        const timer = setTimeout(() => {
            proc.kill(); // Dừng bot sau 5s test
            console.log("✅ [Passed] Bot chạy ổn định!");
            resolve({ status: "OK", logs });
        }, 5000);

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0 && attempt < MAX_ATTEMPTS) {
                console.error(`❌ [Failed] Code bị lỗi, đang tự sửa (lỗi: ${logs.substring(0, 50)}...)`);
                resolve(runDevCycle(appName, request, attempt + 1, logs));
            } else if (code !== 0) {
                resolve({ status: "Failed", error: "Vượt quá số lần sửa lỗi" });
            }
        });
    });
}

// --- ROUTE CHÍNH ---
app.post('/api/create-bot', async (req, res) => {
    const { appName, request } = req.body;
    try {
        const result = await runDevCycle(appName, request);
        
        if (result.status === "OK") {
            cleanGitLock();
            await git.add('./*');
            await git.commit(`Deploy bot: ${appName}`);
            await git.push('origin', 'main');
            res.json({ status: "Success", message: "Bot đã deploy!" });
        } else {
            res.status(500).json(result);
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(7777, () => console.log('🚀 Agent Developer đã khởi động.'));
