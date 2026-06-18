const { GoogleGenerativeAI } = require('@google/generative-ai');
const { execSync } = require('child_process');
const fs = require('fs');
const simpleGit = require('simple-git');

const git = simpleGit();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

async function autonomousLoop(taskDescription) {
    let currentCode = "// Bắt đầu dự án mới...";
    let errorLog = "";
    let isSuccess = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 5;

    console.log(`🚀 Bắt đầu task: ${taskDescription}`);

    while (!isSuccess && attempts < MAX_ATTEMPTS) {
        attempts++;
        console.log(`--- Vòng lặp ${attempts} ---`);

        // Prompt gửi cho AI
        const prompt = `
        Bạn là một Senior Node.js Developer. 
        Nhiệm vụ: ${taskDescription}
        Code hiện tại: 
        ${currentCode}
        Lỗi gần nhất (nếu có): 
        ${errorLog}
        
        Yêu cầu: Viết hoặc sửa lại code trong file 'tool.js'. 
        Trả về code hoàn chỉnh duy nhất trong định dạng Markdown code block. 
        Không giải thích thêm.`;

        const result = await model.generateContent(prompt);
        const rawResponse = result.response.text();
        currentCode = rawResponse.replace(/```javascript/g, '').replace(/```/g, '').trim();

        // Ghi code vào file
        fs.writeFileSync('tool.js', currentCode);

        // Chạy test
        try {
            console.log("Đang chạy test...");
            execSync('node tool.js', { stdio: 'inherit' });
            isSuccess = true;
            console.log("✅ Code đã chạy thành công!");
        } catch (err) {
            errorLog = err.message;
            console.log("❌ Phát hiện lỗi, đang phân tích và sửa...");
        }
    }

    if (isSuccess) {
        await git.add(['tool.js']);
        await git.commit(`feat: Tự động hoàn thành task: ${taskDescription}`);
        // await git.push(); // Mở comment nếu muốn tự động push
        console.log("🎉 Hoàn tất và đã commit lên GitHub.");
    } else {
        console.log("⚠️ Không thể hoàn thành sau nhiều lần thử. Vui lòng kiểm tra lại thủ công.");
    }
}

// Chạy thử
autonomousLoop("Viết một đoạn code lấy giá BTC từ Binance API và log ra console");
