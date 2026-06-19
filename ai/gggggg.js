// File: test-simple.js
const { OpenAI } = require('openai');

const openai = new OpenAI({ 
    baseURL: "https://openrouter.ai/api/v1", 
    apiKey: "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" // Dán thẳng key vào đây để thử (nhớ xoá sau khi test)
});

async function main() {
    try {
        const completion = await openai.chat.completions.create({
            model: "google/gemini-2.0-flash-exp:free",
            messages: [{ role: "user", content: "hi" }]
        });
        console.log("✅ KẾT NỐI THÀNH CÔNG!");
    } catch (err) {
        console.error("❌ LỖI VẪN TỒN TẠI:", err.error.message);
    }
}
main();
