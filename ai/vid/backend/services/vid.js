const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const gTTS = require('gtts');
const axios = require('axios');

// Hàm mô phỏng LLM phân tích kịch bản thành Character Bible
function analyzeScriptToBible(scriptText) {
    // Trong thực tế, bạn phải call API OpenAI/Gemini tại đây để bóc tách kịch bản.
    // Dưới đây là cấu trúc JSON Bible chuẩn mà hệ thống sẽ dùng:
    console.log("[AI Agent] Đang phân tích kịch bản và xây dựng Character Bible...");
    
    return {
        name: "nhan_vat_chinh",
        bible: {
            appearance: "full body, cinematic lighting, 8k resolution, highly detailed, photorealistic",
            age: "young adult",
            gender: "nam/nữ tùy ngữ cảnh",
            body_type: "cân đối",
            face: "sắc nét, biểu cảm chân thực",
            clothing: "trang phục phù hợp bối cảnh hiện đại",
            action: "standing naturally, expressive eyes"
        }
    };
}

// Cập nhật hàm tạo ảnh: Full màu, điện ảnh, không dùng nét chì nữa
async function generateCinematicCharacter(bibleData, savePath) {
    try {
        // Gom các thuộc tính Bible thành Prompt hoàn chỉnh
        const prompt = `${bibleData.action}, ${bibleData.appearance}, ${bibleData.clothing}, detailed face, masterpiece`;
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1920&height=1080&nologo=true`;
        
        const response = await axios({ url, method: 'GET', responseType: 'stream' });
        return new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(savePath);
            response.data.pipe(writer);
            writer.on('finish', () => resolve(savePath));
            writer.on('error', reject);
        });
    } catch (err) {
        throw err;
    }
}

module.exports = {
    render: (data, outputName) => {
        return new Promise(async (resolve, reject) => {
            const timestamp = Date.now();
            let tempFilesToCleanup = [];
            
            const scriptContent = data.script || "";
            
            // Bước 1: Xây dựng Character Bible
            const characterProfile = analyzeScriptToBible(scriptContent);
            const charDir = path.join(__dirname, '../../product/characters', characterProfile.name);
            if (!fs.existsSync(charDir)) fs.mkdirSync(charDir, { recursive: true });
            
            const videoDir = path.join(__dirname, '../../product/videos');
            if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
            
            const outputPath = path.join(videoDir, outputName);
            const finalAudioPath = path.join(__dirname, `final_audio_${timestamp}.mp3`);
            
            // Bước 2: Khởi tạo/Gọi lại hình ảnh Full Màn Hình, Có màu
            const activeCharacterPath = path.join(charDir, 'avatar_cinematic.png');
            if (!fs.existsSync(activeCharacterPath)) {
                await generateCinematicCharacter(characterProfile.bible, activeCharacterPath);
            }

            // --- CHÚ Ý PHẦN NÀY ---
            // Để có cử động "chớp mắt, đi bộ, quay đầu" như diễn viên thật,
            // Bạn bắt buộc phải ném file activeCharacterPath này lên API của Kling/Runway tại đây
            // let videoCGIPath = await callKlingVideoAPI(activeCharacterPath, "walking, looking around");
            // -----------------------

            // Bước 3: Tạo Audio (Giữ nguyên logic gTTS ghép nối)
            const gtts = new gTTS(scriptContent || "Chưa có kịch bản", 'vi');
            await new Promise((res, rej) => gtts.save(finalAudioPath, (err) => err ? rej(err) : res()));
            tempFilesToCleanup.push(finalAudioPath);

            // Bước 4: Render Video Bằng FFmpeg (Full màn hình, không rung lắc vớ vẩn)
            let wStr = 1920, hStr = 1080;
            switch (data.resolution) {
                case '1080': wStr = 1920; hStr = 1080; break;
                case '2k': wStr = 2560; hStr = 1440; break;
                case '4k': wStr = 3840; hStr = 2160; break;
            }

            const fpsVal = 30;
            const cmd = ffmpeg();

            // Nhét trực tiếp ảnh full màn hình vào làm input duy nhất
            cmd.input(activeCharacterPath).inputOptions(['-loop', '1', '-framerate', `${fpsVal}`]);
            cmd.input(finalAudioPath);

            cmd.outputOptions([
                '-map 0:v', 
                '-map 1:a', 
                '-c:v libx264', 
                `-r ${fpsVal}`, 
                '-tune stillimage', 
                '-pix_fmt yuv420p', 
                '-c:a aac', 
                `-b:a 320k`, 
                '-shortest',
                // Lệnh crop này đảm bảo ảnh lấp đầy toàn bộ màn hình 16:9 không bị viền đen
                `-vf scale=${wStr}:${hStr}:force_original_aspect_ratio=increase,crop=${wStr}:${hStr}`
            ])
            .output(outputPath)
            .on('end', () => {
                tempFilesToCleanup.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                resolve(outputName);
            })
            .on('error', (err) => {
                tempFilesToCleanup.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                reject(err);
            })
            .run();
        });
    }
};
