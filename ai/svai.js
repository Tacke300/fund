const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/api/run', async (req, res) => {
    const { workName } = req.body;
    const testDir = path.join(__dirname, 'ai', 'test', workName);
    const productDir = path.join(__dirname, 'ai', 'product', workName);
    
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
    if (!fs.existsSync(productDir)) fs.mkdirSync(productDir, { recursive: true });

    let version = 0;
    let isFinished = false;
    let lastError = "Chưa có lỗi.";

    while (!isFinished) {
        execSync('git pull');
        version++;
        const fileName = `test_${String(version).padStart(2, '0')}.js`;
        const filePath = path.join(testDir, fileName);

        const prompt = `Nhiệm vụ: ${workName}. Lỗi gần nhất: ${lastError}. Viết code vào file ${fileName}. Bắt đầu file bằng comment ghi lỗi cũ và cách khắc phục. Nếu code chạy tốt, trả về từ khóa "DONE".`;
        const result = await model.generateContent(prompt);
        const code = result.response.text().replace(/```javascript/g, '').replace(/```/g, '').trim();

        if (code.includes("DONE")) {
            const finalPath = path.join(productDir, 'index.js');
            fs.writeFileSync(finalPath, fs.readFileSync(path.join(testDir, `test_${String(version - 1).padStart(2, '0')}.js`)));
            try { execSync(`pm2 delete ${workName}`); } catch(e) {}
            execSync(`pm2 start ${finalPath} --name ${workName}`);
            isFinished = true;
        } else {
            fs.writeFileSync(filePath, code);
            try {
                execSync(`node ${filePath}`);
                lastError = "Chạy tốt";
            } catch (e) {
                lastError = e.stderr.toString();
            }
        }
    }
    res.json({ message: "Hoàn tất triển khai" });
});

app.listen(7777, () => console.log('Server running on port 7777'));
