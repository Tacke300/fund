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
                // 1. KIỂM TRA THƯ MỤC LƯU TRỮ
                if (!fs.existsSync(videoDir)) {
                    fs.mkdirSync(videoDir, { recursive: true });
                }

                console.log(`[Engine] Đang bóc tách kịch bản đa tầng và kiểm tra văn bản...`);
                let allDialogues = [];

                // CỨU CÁNH 1: Bọc try-catch chống sập nếu module kichban.js xử lý văn bản lỗi
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
                    console.log(`[Engine Cảnh Báo] Phân tích cấu trúc thất bại, hệ thống tự động chuyển về đọc thô toàn bộ.`);
                }

                // CỨU CÁNH 2: Nếu không lọc được câu thoại nào, ép toàn bộ văn bản đầu vào làm 1 câu duy nhất
                if (allDialogues.length === 0) {
                    const fallbackText = data.script && data.script.trim() !== "" ? data.script : "Nội dung video trống.";
                    allDialogues.push({ content: fallbackText, pauseAfter: 1.5 });
                }

                // 2. XỬ LÝ AUDIO & FAKE GIỌNG (CLONE VOICE)
                const isCloneMode = data.voiceMode === 'clone' && data.uploadedAudioPath && fs.existsSync(data.uploadedAudioPath);

                if (isCloneMode) {
                    console.log(`[Core AI Voice] Khởi chạy Clone Audio: Lấy file tải lên làm lõi âm thanh.`);
                    fs.copyFileSync(data.uploadedAudioPath, finalAudioPath);
                } else {
                    // Xử lý đọc giọng AI mặc định
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
                    // Chống sập nếu không sinh được file MP3 nào
                    if (paddedFiles.length === 0) {
                        throw new Error("Không thể chuyển đổi văn bản thành âm thanh.");
                    }

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

                // 3. XỬ LÝ ẢNH NỀN & BỐI CẢNH
                const imagePool = data.uploadedImages || [];
                let activeBackground = defaultBgPath;

                if (imagePool.length > 0 && fs.existsSync(imagePool[0].filePath)) {
                    activeBackground = imagePool[0].filePath;
                }

                // CỨU CÁNH 3: Nếu ảnh bị mất, tự động tạo nền ĐEN thay vì để FFmpeg sập
                let isSolidBg = false;
                if (!fs.existsSync(activeBackground)) {
                    console.log(`[Engine] Không tìm thấy ảnh bối cảnh thật, tự động tạo phông nền đen thay thế.`);
                    isSolidBg = true;
                }

                // 4. CẤU HÌNH THÔNG SỐ RENDER
                const wStr = data.targetWidth || 1280;
                const hStr = data.targetHeight || 720;
                const fpsVal = data.fps || 30;
                const aBitrate = data.audioBitrate || '320k';
                const wmText = data.watermark || '';
                const opacity = data.wmOpacity || '0.15'; 

                let videoFilters = [
                    `scale=${wStr}:${hStr}:force_original_aspect_ratio=decrease`,
                    `pad=${wStr}:${hStr}:(w-iw)/2:(h-ih)/2:black`
                ];

                // CỨU CÁNH 4: Fix cứng đường dẫn Font Windows bằng chuỗi Replace để trị dứt điểm Code 4294967274
                if (wmText.trim() !== '') {
                    const fontPath = "C:/Windows/Fonts/arial.ttf".replace(/:/g, '\\\\:');
                    videoFilters.push(`drawtext=fontfile='${fontPath}':text='${wmText}':x='(w-tw)/2+((w-tw)/2)*sin(t/2)':y='(h-th)/2+((h-th)/2)*cos(t/2)':fontsize=h/18:fontcolor=white@${opacity}`);
                }

                // 5. CHẠY FFMPEG LÕI
                const cmd = ffmpeg();

                // Đưa -loop 1 vào chuẩn inputOptions thay vì loop() để tránh lỗi Invalid Argument với file MP4
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
                        '-shortest' // Chỉ dừng lại khi Audio chạy xong
                    ])
                    .videoFilters(videoFilters)
                    .output(outputPath)
                    .on('progress', (progress) => {
                        if (progress.percent) onProgress(Math.floor(progress.percent));
                    })
                    .on('end', () => {
                        tempAudioFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                        try { fs.unlinkSync(finalAudioPath); } catch (e) {}
                        console.log(`[Thành công] Đoạn phim đã xuất bản mã hóa hoàn tất.`);
                        resolve(outputName);
                    })
                    .on('error', (err) => {
                        tempAudioFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                        try { fs.unlinkSync(finalAudioPath); } catch (e) {}
                        reject(err);
                    })
                    .run();

            } catch (err) {
                tempAudioFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                try { fs.unlinkSync(finalAudioPath); } catch (e) {}
                reject(err);
            }
        });
    }
};
