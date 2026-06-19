require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Groq = require("groq-sdk");
const fs = require('fs-extra');
const path = require('path');
const simpleGit = require('simple-git');

const app = express();
app.use(express.json());

const git = simpleGit();
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || "dummy");
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || "dummy" });

async function getCodeFromAI(prompt) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const result = await model.generateContent("Viết code Node.js cho: " + prompt + ". Chỉ trả về code.");
        return result.response.text();
    } catch (e) {
        console.error("Gemini failed, trying Groq");
        const chat = await groq.chat.completions.create({
            messages: [{ role: "user", content: "Viết code Node.js cho: " + prompt + ". Chỉ trả về code." }],
            model: "llama-3.3-70b-versatile",
        });
        return chat.choices[0].message.content;
    }
}

app.post('/api/create-bot', async (req, res) => {
    const { appName, request } = req.body;
    const testDir = path.join(__dirname, 'product', appName);
    fs.ensureDirSync(testDir);
    
    try {
        let rawCode = await getCodeFromAI(request);
        let cleanCode = rawCode.split('```javascript').join('').split('```').join('').trim();
        fs.writeFileSync(path.join(testDir, 'index.js'), cleanCode);
        
        // Push lên GitHub
        await git.add('./*');
        await git.commit('Auto-update: ' + appName);
        await git.push('origin', 'main');
        
        res.json({ status: "Success", message: "Đã lưu và push lên GitHub" });
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    }
});

app.listen(7777, () => console.log('🚀 Server đã chạy, GitHub sync sẵn sàng.'));
