const express = require('express');
const path = require('path');
const { OpenAI } = require('openai');
const app = express();

app.use(express.json());
// Thay key của bạn vào đây
const openai = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: "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" });

let chatHistory = []; 

app.post('/api/chat', async (req, res) => {
    const { message, fileContent } = req.body;
    const isCode = /viết code|tạo file|lập trình|function|script|node|js/i.test(message);
    
    chatHistory.push({ role: "user", content: `${message} ${fileContent ? `\n[File uploaded]: ${fileContent}` : ""}` });
    
    try {
        const completion = await openai.chat.completions.create({
            model: "anthropic/claude-3.5-sonnet",
            messages: [{ role: "system", content: isCode ? "Bạn là Senior Dev. Chỉ trả về code, không giải thích dài dòng." : "Bạn là trợ lý thông minh." }, ...chatHistory]
        });

        const reply = completion.choices[0].message.content;
        chatHistory.push({ role: "assistant", content: reply });
        res.json({ reply, isCode });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(7777, () => console.log('Server running on 7777'));
