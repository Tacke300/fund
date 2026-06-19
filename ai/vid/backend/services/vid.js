const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const gTTS = require('gtts');
const kichban = require('./kichban');

// Cố định đường dẫn FFmpeg cho Windows 10
if (process.platform === 'win32') {
    ffmpeg.setFfmpegPath('C:\\ffmpeg\\ffmpeg.exe');
}

module.exports = {
    render: (data, outputName, onProgress) => {
        return new Promise(async (resolve, reject) => {
            const timestamp = Date.now();
            const videoDir = path.join(__dirname, '../../product/videos');
            const defaultBgPath = path.join(__dirname, '../../product/default_bg.jpg');
            const outputPath = path.join(videoDir, outputName);
            
            let tempAudioFiles = []; 
            const finalAudioPath = path.join(__dirname, `final_audio_${timestamp}.mp3`);

            try {
                // 1. KIỂM TRA THƯ MỤC
                if (!fs.existsSync(videoDir)) {
                    fs.mkdirSync(videoDir, { recursive: true });
                }

                console.log(`[Engine] Bắt đầu phân tích văn bản và chuẩn bị dữ liệu render...`);
                let allDialogues = [];

                try {
                    const scriptStructure = kichban.analyze(data.script || "");
                    if (scriptStructure && scriptStructure.scenes) {
                        scriptStructure.scenes.forEach(scene => {
                            if (scene.dialogues && scene.dialogues.length > 0) {
                                allDialogues = allDialogues.concat(scene.dialogues);
                            }
                        });
                    }
                } catch (err) {
                    console.log(`[Engine] Cấu trúc phức tạp lỗi, ép chuyển sang chế độ đọc thô.`);
                }

                if (allDialogues.length === 0) {
                    const fallbackText = (data.script && data.script.trim() !== "") ? data.script : "Nội dung video trống.";
                    allDialogues.push({ content: fallbackText, pauseAfter: 1.5 });
                }

                // 2. XỬ LÝ AUDIO (CLONE HOẶC AI)
                const isCloneMode = data.voiceMode === 'clone' && data.uploadedAudioPath && fs.existsSync(data.uploadedAudioPath);

                if (isCloneMode) {
                    console.log(`[Core AI Voice] Sử dụng file âm thanh tải lên để làm Voice nền.`);
                    fs.copyFileSync(data.uploadedAudioPath, finalAudioPath);
                } else {
                    for (let i = 0; i < allDialogues.length; i++) {
                        const dlg = allDialogues[i];
                        if (!dlg.content || dlg.content.trim() === '') continue;

                        const rawAudioPart = path.join(__dirname, `part_raw_${i}_${timestamp}.mp3`);
                        const paddedAudioPart = path.join(__dirname, `part_pad_${i}_${timestamp}.mp3`);
                        
                        const gtts = new gTTS(dlg.content, 'vi');
                        await new Promise((res, rej) => {
                            gtts.save(rawAudioPart, (err) => err ? rej(err) : res());
                        });
                        tempAudioFiles.push(rawAudioPart);

                        const pauseSeconds = dlg.pauseAfter || 1.2;
                        await new Promise((res, rej) => {
                            ffmpeg(rawAudioPart)
                                .outputOptions([`-af apad=pad_len=${Math.floor(pauseSeconds * 44100)}`])
                                .output(paddedAudioPart)
                                .on('end', res)
                                .on('error', rej)
                                .run();
                        });
                        tempAudioFiles.push(paddedAudioPart);
                    }

                    const paddedFiles = tempAudioFiles.filter(f => f.includes('part_pad_'));
                    if (paddedFiles.length === 0) throw new Error("Không thể trích xuất âm thanh.");

                    const concatListPath = path.join(__dirname, `list_${timestamp}.txt`);
                    const listContent = paddedFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
                    fs.writeFileSync(concatListPath, listContent);

                    await new Promise((res, rej) => {
                        ffmpeg()
                            .input(concatListPath)
                            .inputOptions(['-f concat', '-safe 0'])
                            .outputOptions(['-c copy'])
                            .output(finalAudioPath)
                            .on('end', res)
                            .on('error', rej)
                            .run();
                    });
                    fs.unlinkSync(concatListPath);
                }

                // Đảm bảo audio có tồn tại
                if (!fs.existsSync(finalAudioPath)) throw new Error("File audio cuối không tồn tại.");

                // 3. XỬ LÝ ẢNH NỀN
                const imagePool = data.uploadedImages || [];
                let activeBackground = defaultBgPath;

                if (imagePool.length > 0 && fs.existsSync(imagePool[0].filePath)) {
                    activeBackground = imagePool[0].filePath;
                }

                let isSolidBg = false;
                if (!fs.existsSync(activeBackground)) {
                    isSolidBg = true;
                    console.log(`[Engine] Dùng nền đen an toàn vì không thấy ảnh.`);
                }

                // 4. FIX TRIỆT ĐỂ LỖI KÍCH THƯỚC & FILTERS
                // Ép kiểu số nguyên để đảm bảo không bị lỗi chuỗi
                const wStr = parseInt(data.targetWidth || 1280);
                const hStr = parseInt(data.targetHeight || 720);
                const fpsVal = parseInt(data.fps || 30);
                const aBitrate = data.audioBitrate || '320k';

                // FIX: Dùng trunc() để chống tọa độ lẻ pixel (nguyên nhân chính gây Code 4294967274)
                let videoFilters = [
                    `scale=${wStr}:${hStr}:force_original_aspect_ratio=decrease`,
                    `pad=${wStr}:${hStr}:trunc((ow-iw)/2):trunc((oh-ih)/2):black`
                ];

                const wmText = data.watermark || '';
                const opacity = data.wmOpacity || '0.15'; 
                
                if (wmText.trim() !== '') {
                    // FIX: Đường dẫn font an toàn cho Windows FFmpeg (C\:/ thay vì C:/)
                    const safeFontPath = 'C\\:/Windows/Fonts/arial.ttf';
                    videoFilters.push(`drawtext=fontfile='${safeFontPath}':text='${wmText}':x='(w-tw)/2+((w-tw)/2)*sin(t/2)':y='(h-th)/2+((h-th)/2)*cos(t/2)':fontsize=h/18:fontcolor=white@${opacity}`);
                }

                // 5. CHẠY FFMPEG
                const cmd = ffmpeg();

                if (isSolidBg) {
                    cmd.input(`color=c=black:s=${wStr}x${hStr}:r=${fpsVal}`).inputFormat('lavfi');
                } else {
                    cmd.input(activeBackground).inputOptions(['-loop', '1', '-framerate', fpsVal.toString()]);
                }

                cmd.input(finalAudioPath)
                    .outputOptions([
                        '-c:v libx264',
                        `-r ${fpsVal}`,
                        '-tune stillimage',
                        '-pix_fmt yuv420p',
                        '-c:a aac',
                        `-b:a ${aBitrate}`,
                        '-shortest'
                    ])
                    .videoFilters(videoFilters)
                    .output(outputPath)
                    .on('start', (commandLine) => {
                        // LOG NÀY RẤT QUAN TRỌNG: Sẽ in ra lệnh FFmpeg gốc để dễ chẩn đoán nếu còn lỗi
                        console.log(`[FFmpeg Core Lệnh Thực Thi]:\n${commandLine}\n`);
                    })
                    .on('progress', (progress) => {
                        if (progress.percent) onProgress(Math.floor(progress.percent));
                    })
                    .on('end', () => {
                        tempAudioFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                        try { fs.unlinkSync(finalAudioPath); } catch (e) {}
                        console.log(`[Thành công] Video render thành công: ${outputName}`);
                        resolve(outputName);
                    })
                    .on('error', (err) => {
                        tempAudioFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                        try { fs.unlinkSync(finalAudioPath); } catch (e) {}
                        console.error(`[Engine Lỗi Thực Thi]:`, err.message);
                        reject(err);
                    })
                    .run();

            } catch (err) {
                tempAudioFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                try { fs.unlinkSync(finalAudioPath); } catch (e) {}
                console.error(`[Engine Lỗi Catch]:`, err.message);
                reject(err);
            }
        });
    }
};
