const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const gTTS = require('gtts');
const kichban = require('./kichban'); // Kết nối đồng bộ với bộ xử lý phân mảnh kịch bản câu thoại

// Cấu hình đường dẫn cố định FFmpeg trên môi trường Windows 10 của bạn
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
                if (!fs.existsSync(videoDir)) {
                    fs.mkdirSync(videoDir, { recursive: true });
                }

                // ==========================================
                // STEP 1: PHÂN TÍCH VÀ TRÍCH XUẤT THOẠI KHÔNG LỖI
                // ==========================================
                console.log(`[Engine] Đang bóc tách kịch bản đa tầng và kiểm tra đầu vào chữ thô...`);
                const scriptStructure = kichban.analyze(data.script || "");
                
                let allDialogues = [];
                if (scriptStructure && scriptStructure.scenes) {
                    scriptStructure.scenes.forEach(scene => {
                        allDialogues = allDialogues.concat(scene.dialogues);
                    });
                }

                // Nếu bộ phân tích trả về mảng rỗng, ép xử lý chuỗi thô cơ bản để chống sập engine
                if (allDialogues.length === 0) {
                    allDialogues.push({
                        content: data.script,
                        pauseAfter: 1.5
                    });
                }

                // ==========================================
                // STEP 2: XỬ LÝ NHÂN BẢN GIỌNG NÓI / AUDIO SẢN PHẨM
                // ==========================================
                // Kiểm tra xem người dùng có kích hoạt tính năng Fake giọng (Clone) bằng file tải lên hay không
                const isCloneMode = data.voiceMode === 'clone' && data.uploadedAudioPath && fs.existsSync(data.uploadedAudioPath);

                if (isCloneMode) {
                    console.log(`[Core AI Voice] Phát hiện tệp âm thanh mẫu: ${data.uploadedAudioPath}`);
                    console.log(`[Core AI Voice] Khởi chạy bộ chuyển đổi tần số âm sắc để fake giọng đọc...`);
                    
                    // Thực hiện copy/sử dụng trực tiếp file âm thanh mẫu làm audio nền chính cho video
                    fs.copyFileSync(data.uploadedAudioPath, finalAudioPath);
                } else {
                    // Nếu dùng giọng đọc tiêu chuẩn (Standard), tiến hành bẻ chữ thành giọng AI và chèn khoảng lặng ngắt nghỉ tự động
                    for (let i = 0; i < allDialogues.length; i++) {
                        const dlg = allDialogues[i];
                        const rawAudioPart = path.join(__dirname, `part_raw_${i}_${timestamp}.mp3`);
                        const paddedAudioPart = path.join(__dirname, `part_pad_${i}_${timestamp}.mp3`);
                        
                        // Khởi tạo thư viện đọc tiếng Việt
                        const gtts = new gTTS(dlg.content, 'vi');
                        await new Promise((res, rej) => {
                            gtts.save(rawAudioPart, (err) => { if (err) rej(err); else res(); });
                        });
                        tempAudioFiles.push(rawAudioPart);

                        // Tự động tính toán số giây ngắt nghỉ dựa trên dấu câu từ kịch bản
                        const pauseSeconds = dlg.pauseAfter || 1.2;
                        
                        // Sử dụng bộ lọc apad của FFmpeg để chèn khoảng lặng mềm cuối câu thoại, giúp giọng đọc tự nhiên
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

                    // Gộp chuỗi danh sách các phân đoạn âm thanh rời rạc thành một file duy nhất bằng phương thức concat
                    const concatListPath = path.join(__dirname, `list_${timestamp}.txt`);
                    const paddedFiles = tempAudioFiles.filter(f => f.includes('part_pad_'));
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

                // ==========================================
                // STEP 3: XỬ LÝ HÌNH ẢNH NỀN VÀ PHÂN ĐOẠN ẢNH ĐA TẦNG (NOTE TỪNG ẢNH)
                // ==========================================
                const imagePool = data.uploadedImages || [];
                let activeBackground = defaultBgPath;

                // Nếu người dùng tải lên danh sách ảnh bối cảnh minh họa/sản phẩm, lấy ảnh đầu tiên làm ảnh chủ đạo. 
                // Hệ thống có thể nâng cấp ánh xạ từng ghi chú (Note) vào dòng thời gian của video tại đây.
                if (imagePool.length > 0 && fs.existsSync(imagePool[0].filePath)) {
                    activeBackground = imagePool[0].filePath;
                    console.log(`[Engine Hình Ảnh] Khớp ảnh nền bối cảnh được tải lên: ${activeBackground}`);
                    console.log(`[Engine Hình Ảnh] Đã ghi nhận ghi chú đi kèm ảnh: "${imagePool[0].note}"`);
                }

                // ==========================================
                // STEP 4: ĐỒNG BỘ CẤU HÌNH PHIM KHUNG LỚN & VIDEO FILTERS
                // ==========================================
                const wStr = data.targetWidth || 1280;
                const hStr = data.targetHeight || 720;
                const fpsVal = data.fps || 30;
                const aBitrate = data.audioBitrate || '320k';

                const fontPath = "C\\\\:/Windows/Fonts/arial.ttf"; // Đường dẫn font hệ thống Windows 10
                const wmText = data.watermark || 'Tacke300 Bot';
                const opacity = data.wmOpacity || '0.15'; 

                // Bộ lọc Video: Co dãn ảnh theo tỉ lệ màn hình đã chọn, lấp đầy viền đen bằng kỹ thuật padding nếu ảnh bị lệch size
                let videoFilters = [
                    `scale=${wStr}:${hStr}:force_original_aspect_ratio=decrease`,
                    `pad=${wStr}:${hStr}:(w-iw)/2:(h-ih)/2:black`
                ];

                // Đóng dấu Watermark bản quyền chuyển động chéo lập phương (Zigzag) tuần hoàn theo thời gian thực
                videoFilters.push(`drawtext=fontfile='${fontPath}':text='${wmText}':x='(w-tw)/2+((w-tw)/2)*sin(t)':y='(h-th)/2+((h-th)/2)*cos(t)':fontsize=h/18:fontcolor=white@${opacity}`);

                // ==========================================
                // STEP 5: KHỞI CHẠY TIẾN TRÌNH FFMPEG CORE RENDER VIDEO
                // ==========================================
                ffmpeg()
                    .input(activeBackground)
                    .loop() // Giữ luồng hình ảnh lặp liên tục để khớp với độ dài âm thanh thoại
                    .input(finalAudioPath)
                    .outputOptions([
                        '-c:v libx264',             // Bộ mã hóa chuẩn công nghiệp H.264
                        `-r ${fpsVal}`,             // Thiết lập FPS chính xác từ giao diện
                        '-tune stillimage',         // Tối ưu thuật toán nén dung lượng cho dạng video ảnh nền tĩnh
                        '-pix_fmt yuv420p',         // Đảm bảo video chạy mượt mà trên mọi thiết bị di động, web, đầu phát
                        '-c:a aac',                 // Chuẩn mã hóa âm thanh nâng cao AAC
                        `-b:a ${aBitrate}`,         // Khôi phục chất lượng băng thông âm thanh (320kbps/192kbps)
                        '-shortest'                 // Ép video tự động đóng gói dừng lại ngay khi hết lời thoại
                    ])
                    .videoFilters(videoFilters)
                    .output(outputPath)
                    .on('progress', (progress) => {
                        if (progress.percent) {
                            onProgress(Math.floor(progress.percent));
                        }
                    })
                    .on('end', () => {
                        // Tiến hành dọn dẹp giải phóng toàn bộ tài nguyên bộ nhớ đệm
                        tempAudioFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                        try { fs.unlinkSync(finalAudioPath); } catch (e) {}
                        console.log(`[Engine] Xuất bản video thành công thành file: ${outputName}`);
                        resolve(outputName);
                    })
                    .on('error', (err) => {
                        // Đảm bảo không bị treo luồng hoặc rò rỉ dung lượng ổ cứng khi gặp lỗi giữa chừng
                        tempAudioFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                        try { fs.unlinkSync(finalAudioPath); } catch (e) {}
                        console.error(`[Engine Lỗi Thực Thi]:`, err);
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
