const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const gTTS = require('gtts');
const axios = require('axios');

if (process.platform === 'win32') {
    ffmpeg.setFfmpegPath('C:\\ffmpeg\\ffmpeg.exe');
}

// Hàm sinh ảnh Cinematic có màu, chuẩn aspect ratio
async function generateCinematicCharacter(charName, description, savePath, w, h) {
    try {
        const prompt = `${description}, full body, cinematic lighting, highly detailed, photorealistic`;
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&nologo=true`;
        
        const response = await axios({ url, method: 'GET', responseType: 'stream' });
        return new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(savePath);
            response.data.pipe(writer);
            writer.on('finish', () => resolve(savePath));
            writer.on('error', (err) => reject(new Error(`Lỗi tải ảnh AI: ${err.message}`)));
        });
    } catch (err) {
        throw new Error(`Lỗi kết nối tới Pollinations AI: ${err.message}`);
    }
}

module.exports = {
    render: (data, outputName) => {
        return new Promise(async (resolve, reject) => {
            const timestamp = Date.now();
            let tempFilesToCleanup = [];
            
            try {
                // Nhận toàn bộ thông số từ HTML
                const wStr = parseInt(data.targetWidth) || 1920;
                const hStr = parseInt(data.targetHeight) || 1080;
                const fpsVal = parseInt(data.fps) || 30;
                const aBitrate = data.audioBitrate || '320k';
                const charName = (data.characterName || `nv_${timestamp}`).trim();
                const charDesc = (data.characterPrompt || "").trim();
                const scriptContent = (data.script || "").trim();

                if (!scriptContent && data.voiceMode !== 'clone') {
                    throw new Error("Kịch bản trống! Vui lòng nhập nội dung.");
                }

                const charDir = path.join(__dirname, '../../product/characters', charName);
                if (!fs.existsSync(charDir)) fs.mkdirSync(charDir, { recursive: true });
                
                const videoDir = path.join(__dirname, '../../product/videos');
                if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
                
                const outputPath = path.join(videoDir, outputName);
                const finalAudioPath = path.join(__dirname, `final_audio_${timestamp}.mp3`);
                const activeCharacterPath = path.join(charDir, 'avatar_cinematic.png');

                // 1. Tạo hình ảnh nhân vật (Có màu, chuẩn kích thước)
                if (!fs.existsSync(activeCharacterPath)) {
                    if (!charDesc) {
                        throw new Error("Chưa có ảnh nhân vật và bạn cũng không nhập 'Mô tả ngoại hình' để AI vẽ.");
                    }
                    await generateCinematicCharacter(charName, charDesc, activeCharacterPath, wStr, hStr);
                }

                // 2. Tạo hoặc xử lý Âm thanh
                const isCloneMode = data.voiceMode === 'clone' && data.uploadedAudioPath && fs.existsSync(data.uploadedAudioPath);
                
                if (isCloneMode) {
                    fs.copyFileSync(data.uploadedAudioPath, finalAudioPath);
                } else {
                    const gtts = new gTTS(scriptContent, 'vi');
                    await new Promise((res, rej) => {
                        gtts.save(finalAudioPath, (err) => {
                            if (err) rej(new Error(`Lỗi tạo giọng nói (gTTS): ${err.message}`));
                            else res();
                        });
                    });
                }
                tempFilesToCleanup.push(finalAudioPath);

                // 3. Tiến hành Render bằng FFmpeg
                const cmd = ffmpeg();

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
                    `-b:a ${aBitrate}`, 
                    '-shortest',
                    // Đảm bảo ảnh phủ kín màn hình, cắt các phần thừa để không có viền đen
                    `-vf scale=${wStr}:${hStr}:force_original_aspect_ratio=increase,crop=${wStr}:${hStr}`
                ])
                .output(outputPath)
                .on('end', () => {
                    tempFilesToCleanup.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                    resolve(outputName);
                })
                .on('error', (err, stdout, stderr) => {
                    tempFilesToCleanup.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                    // Ném thẳng lỗi chi tiết của FFmpeg ra ngoài
                    reject(new Error(`Lỗi FFmpeg Render: ${err.message}\nChi tiết: ${stderr}`));
                })
                .run();

            } catch (err) {
                // Dọn dẹp nếu dính lỗi ở các bước tải ảnh/tạo voice
                tempFilesToCleanup.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                reject(err); 
            }
        });
    }
};
