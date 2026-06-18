const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// CỐ GẮNG YÊU CẦU MODULE BẰNG ĐƯỜNG DẪN TUYỆT ĐỐI (Tránh lỗi tìm kiếm module)
const OpenAI = require(path.join(__dirname, 'node_modules', 'openai'));

const app = express();
app.use(express.json());

const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: "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"
});

app.post('/api/run', async (req, res) => {
    const { workName } = req.body;
    
    // Chạy bất đồng bộ để tránh treo tiến trình chính
    process.nextTick(async () => {
        try {
            const testDir = path.join(__dirname, 'ai', 'test', workName);
            if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

            // Thay vì git pull toàn bộ, chỉ pull nếu cần hoặc bỏ qua nếu đã pull ở master process
            // Tránh việc 5000 bot cùng pull một lúc gây nghẽn I/O
            
            const prompt = `Viết code Node.js cho: ${workName}. Nếu xong ghi DONE.`;
            const completion = await openai.chat.completions.create({
                model: "anthropic/claude-3.5-sonnet",
                messages: [{ role: "user", content: prompt }]
            });

            const code = completion.choices[0].message.content.replace(/```/g, '').trim();
            fs.writeFileSync(path.join(testDir, 'index.js'), code);
            
            // Dùng lệnh trực tiếp thay vì qua nhiều lớp shell
            execSync(`pm2 start ${path.join(testDir, 'index.js')} --name ${workName}`);
        } catch (e) {
            console.error("Bot Error:", e.message);
        }
    });

    res.json({ status: "Processing" });
});

app.listen(7777);
