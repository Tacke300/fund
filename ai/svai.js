const express = require('express');
const { OpenAI } = require('openai');
const { execSync, exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname)); // Cho phép load index.html và các file tĩnh

const BASE_DIR = path.join(__dirname);
const openai = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: "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" });

// Route chính để load giao diện
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// API Chat thường
app.post('/api/chat', async (req, res) => {
    const { message, fileContent } = req.body;
    try {
        const completion = await openai.chat.completions.create({
            model: "anthropic/claude-3.5-sonnet",
            messages: [{ role: "user", content: `${message} ${fileContent ? `\n[File]: ${fileContent}` : ""}` }]
        });
        res.json({ reply: completion.choices[0].message.content });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API Tạo Bot (Workflow)
app.post('/api/create-bot', async (req, res) => {
    const { appName, request } = req.body;
    const testDir = path.join(BASE_DIR, 'test', appName, 'test_1');
    fs.ensureDirSync(testDir);
    
    // Cài môi trường
    fs.writeJsonSync(path.join(testDir, 'package.json'), { name: "bot", version: "1.0.0" });
    try { execSync('npm install axios ccxt', { cwd: testDir, stdio: 'ignore' }); } catch(e){}

    // Coder AI
    const coderRes = await openai.chat.completions.create({
        model: "anthropic/claude-3.5-sonnet",
        messages: [{ role: "system", content: "Viết code Node.js hoàn chỉnh." }, { role: "user", content: request }]
    });
    const code = coderRes.choices[0].message.content.replace(/```javascript|```/g, "").trim();
    fs.writeFileSync(path.join(testDir, 'index.js'), code);

    // Tester
    exec(`node index.js`, { cwd: testDir, timeout: 5000 }, (error) => {
        if (!error) {
            fs.copySync(testDir, path.join(BASE_DIR, 'product', appName));
            res.json({ status: "Success", path: `product/${appName}` });
        } else {
            res.status(500).json({ error: "Code lỗi, hãy kiểm tra lại yêu cầu." });
        }
    });
});

app.listen(7777, () => console.log('Server Pro Max running on port 7777'));
