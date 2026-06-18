const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');

const app = express();
app.use(express.json());

// Cấu hình OpenRouter với Key của bạn
const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: "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"
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/api/run', async (req, res) => {
    const { workName } = req.body;
    
    // Xử lý quyền Git
    try { execSync(`git config --global --add safe.directory C:/Users/ok/fund`); } catch(e) {}

    (async () => {
        const testDir = path.join(__dirname, 'ai', 'test', workName);
        const productDir = path.join(__dirname, 'ai', 'product', workName);
        if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
        if (!fs.existsSync(productDir)) fs.mkdirSync(productDir, { recursive: true });

        let version = 0;
        let isFinished = false;
        let lastError = "Chưa có lỗi.";

        while (!isFinished) {
            try { execSync('git pull'); } catch (e) { console.log("Git pull error (kiểm tra dung lượng ổ đĩa)"); }
            version++;
            const fileName = `test_${String(version).padStart(2, '0')}.js`;
            const filePath = path.join(testDir, fileName);

            const prompt = `Nhiệm vụ: ${workName}. Lỗi gần nhất: ${lastError}. Viết code Node.js hoàn chỉnh vào file ${fileName}. Bắt đầu file bằng comment ghi rõ lỗi cũ và cách khắc phục. Nếu code chạy tốt, chỉ trả về từ khóa "DONE". Không giải thích thêm.`;

            // Gọi OpenRouter thay vì Google AI
            const completion = await openai.chat.completions.create({
                model: "anthropic/claude-3.5-sonnet",
                messages: [{ role: "user", content: prompt }]
            });

            const code = completion.choices[0].message.content.replace(/```javascript/g, '').replace(/```/g, '').trim();

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

    res.json({ message: "Quy trình đã bắt đầu, theo dõi log ở PM2." });
});

app.listen(7777, () => console.log('Server running on 7777'));
