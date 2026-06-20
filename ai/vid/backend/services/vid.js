const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const gTTS = require('gtts');
const axios = require('axios');
const kichban = require('./kichban'); // File mock/phân tích kịch bản của bạn

// Cố định đường dẫn FFmpeg cho Windows 10
if (process.platform === 'win32') {
    ffmpeg.setFfmpegPath('C:\\ffmpeg\\ffmpeg.exe');
}

// Hàm hỗ trợ: Gọi AI tạo hình nhân vật
async function generateCharacterImage(prompt, savePath) {
    console.log(`[AI Gen] Đang tạo hình nhân vật với mô tả: ${prompt}`);
    try {
        // Tích hợp nét vẽ chì nghệ thuật làm phong cách mặc định để ảnh mượt mà và tập trung vào thiết kế nhân vật
        const encodedPrompt = encodeURIComponent(`${prompt}, pencil sketch style portrait, clear face design, character sheet, white background`);
        const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=512&height=768&nologo=true`;
        
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream'
        });

        return new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(savePath);
            response.data.pipe(writer);
            writer.on('finish', () => resolve(savePath));
            writer.on('error', reject);
        });
    } catch (err) {
        console.error(`[AI Gen Lỗi] Không thể tạo ảnh:`, err.message);
        throw err;
    }
}

module.exports = {
    render: (data, outputName, onProgress) => {
        return new Promise(async (resolve, reject) => {
            const timestamp = Date.now();
            let tempFilesToCleanup = [];
            
            // --- 1. QUẢN LÝ THƯ MỤC VÀ NHÂN VẬT ---
            const charName = data.characterName ? data.characterName.trim() : `nv_macdinh_${timestamp}`;
            const charDir = path.join(__dirname, '../../product/characters', charName);
            if (!fs.existsSync(charDir)) fs.mkdirSync(charDir, { recursive: true });
            
            const videoDir = path.join(__dirname, '../../product/videos');
            if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
            
            const outputPath = path.join(videoDir, outputName);
            const finalAudioPath = path.join(__dirname, `final_audio_${timestamp}.mp3`);
            const defaultBgPath = path.join(__dirname, '../../product/default_bg.jpg'); // Nền mặc định

            // Kiểm tra và khởi tạo ảnh nhân vật
            let activeCharacterPath = path.join(charDir, 'avatar.png');
            let hasCharacter = false;

            try {
                if (fs.existsSync(activeCharacterPath)) {
                    console.log(`[Engine] Đã tìm thấy nhân vật "${charName}" trong kho, sử dụng lại.`);
                    hasCharacter = true;
                } else if (data.characterPrompt && data.characterPrompt.trim() !== '') {
                    console.log(`[Engine] Chưa có nhân vật "${charName}". Đang kích hoạt AI tự vẽ...`);
                    await generateCharacterImage(data.characterPrompt, activeCharacterPath);
                    console.log(`[Engine] Đã lưu nhân vật mới vào kho.`);
                    hasCharacter = true;
                } else {
                    console.log(`[Engine] Không có mô tả để tạo AI, bỏ qua nhân vật.`);
                }

                // --- 2. XỬ LÝ AUDIO & KỊCH BẢN ---
                console.log(`[Engine] Chuẩn bị dữ liệu Text-to-Speech...`);
                let allDialogues = [];
                try {
                    const scriptStructure = kichban.analyze(data.script || "");
                    if (scriptStructure && scriptStructure.scenes) {
                        scriptStructure.scenes.forEach(scene => {
                            if (scene.dialogues) allDialogues = allDialogues.concat(scene.dialogues);
                        });
                    }
                } catch (err) { }

                if (allDialogues.length === 0) {
                    allDialogues.push({ content: data.script || "Xin chào, video này chưa có nội dung kịch bản.", pauseAfter: 1.5 });
                }

                const isCloneMode = data.voiceMode === 'clone' && data.uploadedAudioPath && fs.existsSync(data.uploadedAudioPath);

                if (isCloneMode) {
                    console.log(`[Core] Dùng file Clone Voice.`);
                    fs.copyFileSync(data.uploadedAudioPath, finalAudioPath);
                } else {
                    for (let i = 0; i < allDialogues.length; i++) {
                        const dlg = allDialogues[i];
                        if (!dlg.content || dlg.content.trim() === '') continue;

                        const rawAudioPart = path.join(__dirname, `part_raw_${i}_${timestamp}.mp3`);
                        const paddedAudioPart = path.join(__dirname, `part_pad_${i}_${timestamp}.mp3`);
                        
                        const gtts = new gTTS(dlg.content, 'vi');
                        await new Promise((res, rej) => gtts.save(rawAudioPart, (err) => err ? rej(err) : res()));
                        tempFilesToCleanup.push(rawAudioPart);

                        const pauseSec = dlg.pauseAfter || 1.2;
                        await new Promise((res, rej) => {
                            ffmpeg(rawAudioPart)
                                .outputOptions([`-af apad=pad_len=${Math.floor(pauseSec * 44100)}`])
                                .output(paddedAudioPart).on('end', res).on('error', rej).run();
                        });
                        tempFilesToCleanup.push(paddedAudioPart);
                    }

                    const paddedFiles = tempFilesToCleanup.filter(f => f.includes('part_pad_'));
                    if (paddedFiles.length > 0) {
                        const concatListPath = path.join(__dirname, `list_${timestamp}.txt`);
                        fs.writeFileSync(concatListPath, paddedFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
                        await new Promise((res, rej) => {
                            ffmpeg().input(concatListPath).inputOptions(['-f concat', '-safe 0'])
                                .outputOptions(['-c copy']).output(finalAudioPath)
                                .on('end', res).on('error', rej).run();
                        });
                        fs.unlinkSync(concatListPath);
                    } else {
                        throw new Error("Lỗi trích xuất Text-to-Speech.");
                    }
                }

                // --- 3. THÔNG SỐ RENDER FFMPEG ---
                const wStr = 1280;
                const hStr = 720;
                const fpsVal = 30;
                const aBitrate = '320k';

                let videoFilters = [];
                let isSolidBg = !fs.existsSync(defaultBgPath);

                // Dựng nền
                videoFilters.push(`[0:v]scale=${wStr}:${hStr}:force_original_aspect_ratio=increase,crop=${wStr}:${hStr}[bg]`);

                // Nếu có AI tạo ra nhân vật thì ghép (Overlay) vào giữa màn hình
                if (hasCharacter) {
                    videoFilters.push(`[1:v]scale=-1:${Math.floor(hStr * 0.9)}[char]`); // Nhân vật cao bằng 90% video
                    videoFilters.push(`[bg][char]overlay=(W-w)/2:H-h[vout]`); // Đặt vào chính giữa dưới cùng
                } else {
                    videoFilters.push(`[bg]copy[vout]`);
                }

                // --- 4. THỰC THI FFMPEG ---
                const cmd = ffmpeg();

                // Input 0: Nền
                if (isSolidBg) {
                    cmd.input(`color=c=black:s=${wStr}x${hStr}:r=${fpsVal}`).inputFormat('lavfi');
                } else {
                    cmd.input(defaultBgPath).inputOptions(['-loop', '1', '-framerate', `${fpsVal}`]);
                }

                // Input 1: Nhân vật (Từ AI vẽ ra)
                if (hasCharacter) {
                    cmd.input(activeCharacterPath).inputOptions(['-loop', '1', '-framerate', `${fpsVal}`]);
                } else {
                    cmd.input(`color=c=black@0.0:s=10x10:r=${fpsVal}`).inputFormat('lavfi'); // Input rỗng để tránh lỗi map
                }

                // Input 2: Audio
                cmd.input(finalAudioPath);

                cmd.outputOptions([
                    `-map [vout]`, 
                    '-map 2:a', 
                    '-c:v libx264', 
                    `-r ${fpsVal}`, 
                    '-tune stillimage', 
                    '-pix_fmt yuv420p', 
                    '-c:a aac', 
                    `-b:a ${aBitrate}`, 
                    '-shortest'
                ])
                .complexFilter(videoFilters)
                .output(outputPath)
                .on('start', (cmdLine) => console.log(`[FFmpeg Cmd]: ${cmdLine}`))
                .on('progress', (p) => { if (p.percent && typeof onProgress === 'function') onProgress(Math.floor(p.percent)); })
                .on('end', () => {
                    tempFilesToCleanup.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                    try { fs.unlinkSync(finalAudioPath); } catch (e) {}
                    console.log(`[Thành công] Lưu video tại: ${outputName}`);
                    resolve(outputName);
                })
                .on('error', (err) => {
                    tempFilesToCleanup.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                    try { fs.unlinkSync(finalAudioPath); } catch (e) {}
                    console.error(`[FFmpeg Lỗi]:`, err.message);
                    reject(err);
                })
                .run();

            } catch (err) {
                tempFilesToCleanup.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                try { fs.unlinkSync(finalAudioPath); } catch (e) {}
                console.error(`[Engine Lỗi]:`, err.message);
                reject(err);
            }
        });
    }
};
