const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

async function runAgent(workName) {
    const testDir = `./ai/test/${workName}`;
    const productDir = `./ai/product/${workName}`;
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

    let version = 1;
    let isFinished = false;
    let lastCode = "";
    let lastError = "";

    while (!isFinished) {
        execSync('git pull');
        const fileName = `test_${String(version).padStart(2, '0')}.js`;
        const filePath = path.join(testDir, fileName);

        const prompt = `Bạn là Senior Dev. Nhiệm vụ: ${workName}. 
        Lịch sử lỗi: ${lastError}. 
        Hãy viết code vào file ${fileName}. 
        Ghi chú lại lỗi cũ đã sửa thế nào ở đầu file. 
        Nếu còn lỗi hãy tiếp tục. Nếu đã hoàn hảo, trả về từ khóa "DONE".`;

        const response = await model.generateContent(prompt);
        const code = response.response.text();

        if (code.includes("DONE")) {
            // Deploy sang product
            if (!fs.existsSync(productDir)) fs.mkdirSync(productDir, { recursive: true });
            fs.writeFileSync(path.join(productDir, "index.js"), lastCode);
            execSync(`pm2 start ${path.join(productDir, "index.js")} --name ${workName}`);
            isFinished = true;
            console.log("🚀 Sản phẩm hoàn thiện đã deploy!");
        } else {
            lastCode = code;
            fs.writeFileSync(filePath, code);
            try {
                execSync(`node ${filePath}`);
                lastError = "Không có lỗi (Code chạy tốt)";
                version++;
            } catch (e) {
                lastError = e.stderr.toString();
                console.log(`❌ Lỗi tại ${fileName}, đang sửa...`);
            }
        }
    }
}
