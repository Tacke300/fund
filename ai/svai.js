const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

app.use(express.json());

// Phục vụ giao diện
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/api/run', async (req, res) => {
    const { workName } = req.body;
    
    // Tự động cấp quyền thư mục cho Git ngay khi bắt đầu
    try {
        const repoPath = 'C:/Users/ok/fund';
        execSync(`git config --global --add safe.directory ${repoPath}`);
    } catch (e) {
        // Bỏ qua nếu đã cấu hình
    }

    // Chạy tiến trình trong nền
    (async () => {
        const testDir = path.join(__dirname, 'ai', 'test', workName);
        const productDir = path.join(__dirname, 'ai', 'product', workName);
        if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
        if (!fs.existsSync(productDir)) fs.mkdirSync(productDir, { recursive: true });

        let version = 0;
        let isFinished = false;
        let lastError = "Chưa có lỗi.";

        while (!isFinished) {
            try {
                execSync('git pull');
            } catch (e) {
                console.error("Git pull failed, continuing...");
            }

            version++;
            const fileName = `test_${String(version).padStart(2, '0')}.js`;
            const filePath = path.join(testDir, fileName);

            const prompt = `Nhiệm vụ: ${workName}. Lỗi cũ: ${lastError}. Viết code vào file ${fileName}. Nếu thành công trả về DONE.`;
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
    })();

    res.json({ message: "Workflow đã khởi tạo thành công!" });
});

app.listen(7777, () => console.log('Server running on 7777'));
