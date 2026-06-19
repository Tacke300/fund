require('dotenv').config();
const express = require('express');
const Groq = require("groq-sdk");
const { exec, execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const simpleGit = require('simple-git');

const app = express();
app.use(express.json({ limit: '50mb' }));

const git = simpleGit('C:\\Users\\ok\\fund');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// --- CÔNG CỤ TỰ HÀNH ---
function cleanGitLock() {
    const lock = path.join('C:\\Users\\ok\\fund', '.git', 'index.lock');
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
}

// Lọc code thông minh: Ưu tiên Markdown, nếu không có thì quét dấu hiệu JS
function extractCode(content) {
    // 1. Tìm block markdown
    const blockMatch = content.match(/```(?:javascript|js|node)?\s*([\s\S]*?)
```/i);
    if (blockMatch) return blockMatch[1].trim();
    
    // 2. Nếu không có block, quét từ khóa (require, const, let, function)
    const codeKeywords = ['require(', 'const ', 'let ', 'var ', 'function ', 'import ', 'console.log', 'axios'];
    if (codeKeywords.some(kw => content.includes(kw))) {
        return content.trim(); // Trả về nguyên văn nếu nó trông giống code
    }
    
    throw new Error("KHÔNG TÌM THẤY CODE TRONG CÂU TRẢ LỜI");
}

// Xóa khai báo biến trùng lặp (Fix lỗi Identifier already declared)
function sanitizeDeclarations(code) {
    const lines = code.split('\n');
    const seen = new Set();
    return lines.filter(line => {
        const match = line.match(/(?:const|let|var)\s+([a-zA-Z0-9_]+)/);
        if (match) {
            if (seen.has(match[2])) return false;
            seen.add(match[2]);
        }
        return true;
    }).join('\n');
}

// --- CORE AI ---
async function askGroq(prompt, errorContext = "") {
    const systemPrompt = `Viết code Node.js cho: ${prompt}. ${errorContext ? 'LỖI CẦN SỬA: ' + errorContext : ''}
    QUY TẮC: Trả về code. Không cần giải thích nhiều. Nếu cần cài thư viện, hãy để comment // INSTALL: package1, package2 ở đầu.`;

    console.log(`🤖 [Groq] Đang yêu cầu...`);
    const chat = await groq.chat.completions.create({
        messages: [{ role: "user", content: systemPrompt }],
        model: "llama-3.3-70b-versatile",
    });
    
    return sanitizeDeclarations(extractCode(chat.choices[0].message.content));
}

// --- VÒNG LẶP SỬA LỖI (SELF-HEALING) ---
async function buildBot(appName, request, attempt = 1, lastError = "") {
    const folder = path.join('C:\\Users\\ok\\fund\\product', appName);
    const filePath = path.join(folder, 'index.js');
    fs.ensureDirSync(folder);

    try {
        console.log(`🛠 [Lần ${attempt}] Đang xử lý ${appName}...`);
        const rawCode = await askGroq(request, lastError);
        fs.writeFileSync(filePath, rawCode);

        // Cài thư viện tự động
        const installMatch = rawCode.match(/\/\/\s*INSTALL:\s*(.*)/);
        if (installMatch) {
            console.log(`📦 [Dependencies] Đang cài: ${installMatch[1]}`);
            execSync(`npm install ${installMatch[1]}`, { cwd: folder, stdio: 'ignore' });
        }

        console.log(`▶️ [Test] Đang chạy thử...`);
        // Test nhanh 5s
        execSync(`node "${filePath}"`, { timeout: 5000 });
        
        console.log("✅ [Success] Chạy ổn định!");
        cleanGitLock();
        await git.add('./*');
        await git.commit(`Deploy ${appName} V${attempt}`);
        await git.push('origin', 'main');
        return { status: "Success" };

    } catch (e) {
        console.error(`❌ [Lỗi]: ${e.message.substring(0, 50)}...`);
        if (attempt < 5) return buildBot(appName, request, attempt + 1, e.message);
        return { status: "Failed", error: e.message };
    }
}

// --- API ---
app.post('/api/create-bot', async (req, res) => {
    const { appName, request } = req.body;
    if (!appName || !request) return res.status(400).send("Thiếu dữ liệu");
    
    // Chạy bất đồng bộ để không treo server
    buildBot(appName, request).then(result => console.log("Final Result:", result));
    res.json({ status: "Processing", message: "Đang tự động viết và chạy bot..." });
});

app.listen(7777, () => console.log('🚀 Server Săn Code đã chạy (Port 7777)'));
