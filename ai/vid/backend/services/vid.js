const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const gTTS = require('gtts');
const axios = require('axios');

if (process.platform === 'win32') {
    ffmpeg.setFfmpegPath('C:\\ffmpeg\\ffmpeg.exe');
}

// Bộ máy tự động phân tích kịch bản thành Prompt
function autoExtractCharacter(script) {
    let basePrompt = "1 person, cinematic lighting, highly detailed face, masterpiece, 8k resolution, photorealistic, depth of field";
    let extra = [];
    const text = script.toLowerCase();

    if (text.includes("cô gái") || text.includes("nữ") || text.includes("bà")) extra.push("female, woman");
    if (text.includes("chàng trai") || text.includes("nam") || text.includes("ông")) extra.push("male, man");
    if (text.includes("trẻ")) extra.push("young");
    if (text.includes("già")) extra.push("old");
    if (text.includes("buồn")) extra.push("sad expression");
    if (text.includes("vui") || text.includes("cười")) extra.push("happy, smiling");
    if (text.includes("tức giận")) extra.push("angry expression");

    const matchColor = text.match(/(áo|váy|quần) (đỏ|xanh|vàng|đen|trắng|hồng)/);
    if (matchColor) extra.push(`wearing ${matchColor[2]} clothes`);

    if (extra.length > 0) {
        return `${extra.join(", ")}, ${basePrompt}`;
    }
    return basePrompt;
}

async function generateCinematicCharacter(scriptText, savePath, w, h) {
    try {
        const prompt = autoExtractCharacter(scriptText);
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&nologo=true`;
        
        const response = await axios({ url, method: 'GET', responseType: 'stream', timeout: 30000 });
        return new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(savePath);
            response.data.pipe(writer);
            writer.on('finish', () => resolve(savePath));
            writer.on('error', (err) => reject(new Error(`Lỗi ghi file ảnh: ${err.message}`)));
        });
    } catch (err) {
        throw new Error(`Lỗi AI tạo ảnh: ${err.message}`);
    }
}

module.exports = {
    render: (data, outputName) => {
        return new Promise(async (resolve, reject) => {
            const timestamp = Date.now();
            let tempFilesToCleanup = [];
            
            try {
                let wStr = 1920, hStr = 1080;
                switch (data.resolution) {
                    case '360': wStr = 640; hStr = 360; break;
                    case '720': wStr = 1280; hStr = 720; break;
                    case '1080': wStr = 1920; hStr = 1080; break;
                    case '2k': wStr = 2560; hStr = 1440; break;
                    case '4k': wStr = 3840; hStr = 2160; break;
                }
                
                const fpsVal = parseInt(data.fps) || 30;
                const aBitrate = data.audioBitrate || '320k';
                const scriptContent = (data.script || "").trim();

                if (!scriptContent && data.voiceMode !== 'clone') {
                    throw new Error("Kịch bản trống! Vui lòng nhập nội dung để hệ thống tự tạo nhân vật.");
                }

                const charDir = path.join(__dirname, '../../product/characters', `auto_char_${timestamp}`);
                if (!fs.existsSync(charDir)) fs.mkdirSync(charDir, { recursive: true });
                
                const videoDir = path.join(__dirname, '../../product/videos');
                if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
                
                const outputPath = path.join(videoDir, outputName);
                const finalAudioPath = path.join(__dirname, `final_audio_${timestamp}.mp3`);
                const activeCharacterPath = path.join(charDir, 'avatar_cinematic.png');

                // 1. Tự động đọc kịch bản & Tự vẽ nhân vật
                await generateCinematicCharacter(scriptContent, activeCharacterPath, wStr, hStr);

                // 2. Xử lý Âm thanh
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

                // 3. Render bằng FFmpeg
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
                    `-vf scale=${wStr}:${hStr}:force_original_aspect_ratio=increase,crop=${wStr}:${hStr}`
                ])
                .output(outputPath)
                .on('end', () => {
                    tempFilesToCleanup.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                    resolve(outputName);
                })
                .on('error', (err, stdout, stderr) => {
                    tempFilesToCleanup.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                    reject(new Error(`Lỗi FFmpeg: ${err.message}`));
                })
                .run();

            } catch (err) {
                tempFilesToCleanup.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                reject(err); 
            }
        });
    }
};
