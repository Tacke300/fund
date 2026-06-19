const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const gTTS = require('gtts');
const kichban = require('./kichban'); // Gọi chính xác module kịch bản vừa tạo

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
                if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

                // SỬA LỖI VĂN BẢN ĐẦU VÀO: Lấy chuỗi chữ thô từ data.script và nạp vào bộ phân tích
                console.log(`[Engine] Tiến hành phân tích cấu trúc ngắt nghỉ & bẻ nhỏ câu thoại...`);
                const scriptStructure = kichban.analyze(data.script || "");
                
                let allDialogues = [];
                scriptStructure.scenes.forEach(scene => {
                    allDialogues = allDialogues.concat(scene.dialogues);
                });

                if (allDialogues.length === 0) {
                    throw new Error("Không thể trích xuất các phân đoạn thoại hợp lệ từ kịch bản đầu vào.");
                }

                // 2. SINH AUDIO CHO TỪNG PHÂN ĐOẠN ĐÃ CHIA NHỎ
                for (let i = 0; i < allDialogues.length; i++) {
                    const dlg = allDialogues[i];
                    const rawAudioPart = path.join(__dirname, `part_raw_${i}_${timestamp}.mp3`);
                    const paddedAudioPart = path.join(__dirname, `part_pad_${i}_${timestamp}.mp3`);
                    
                    // Gọi thư viện gtts (Có thể mở rộng xử lý biến data.voice từ UI tại đây)
                    const gtts = new gTTS(dlg.content, 'vi');
                    await new Promise((res, rej) => {
                        gtts.save(rawAudioPart, (err) => { if (err) rej(err); else res(); });
                    });
                    tempAudioFiles.push(rawAudioPart);

                    // Ép ngắt nghỉ theo thời gian tính toán tự động từ dấu câu (pauseAfter)
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

                // 3. GỘP CÁC FILE THOẠI ĐÃ CHÈN KHOẢNG LẶNG NGẮT NGHỈ
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

                // 4. BIẾN CẤU HÌNH KHUNG HÌNH VÀ VIDEO FILTERS (ĐÃ FIX KHUNG LỚN)
                const wStr = data.targetWidth || 1280;
                const hStr = data.targetHeight || 720;
                const fpsVal = data.fps || 30;
                const aBitrate = data.audioBitrate || '320k';

                const fontPath = "C\\\\:/Windows/Fonts/arial.ttf"; 
                const wmText = data.watermark || 'Tacke300 Bot';
                const opacity = data.wmOpacity || '0.15'; 
                const styleMode = data.wmStyle || 'all';  

                let filters = [`scale=${wStr}:${hStr}:force_original_aspect_ratio=decrease,pad=${wStr}:${hStr}:(w-iw)/2:(h-ih)/2:black`];

                if (styleMode === 'all' || styleMode === 'zigzag') {
                    filters.push(`drawtext=fontfile='${fontPath}':text='${wmText}':x='(w-tw)/2+((w-tw)/2)*sin(t)':y='(h-th)/2+((h-th)/2)*cos(t)':fontsize=h/18:fontcolor=white@${opacity}`);
                }

                ffmpeg()
                    .input(defaultBgPath)
                    .loop() 
                    .input(finalAudioPath)
                    .outputOptions([
                        '-c:v libx264',
                        `-r ${fpsVal}`,
                        '-tune stillimage',
                        '-pix_fmt yuv420p',
                        '-c:a aac',
                        `-b:a ${aBitrate}`,
                        '-shortest'
                    ])
                    .videoFilters(filters)
                    .output(outputPath)
                    .on('progress', (p) => {
                        if (p.percent) onProgress(Math.floor(p.percent));
                    })
                    .on('end', () => {
                        tempAudioFiles.forEach(f => { try{fs.unlinkSync(f)}catch(e){} });
                        try { fs.unlinkSync(finalAudioPath); } catch (e) {}
                        resolve(outputName);
                    })
                    .on('error', (err) => {
                        tempAudioFiles.forEach(f => { try{fs.unlinkSync(f)}catch(e){} });
                        try { fs.unlinkSync(finalAudioPath); } catch (e) {}
                        reject(err);
                    })
                    .run();

            } catch (err) {
                tempAudioFiles.forEach(f => { try{fs.unlinkSync(f)}catch(e){} });
                try { fs.unlinkSync(finalAudioPath); } catch (e) {}
                reject(err);
            }
        });
    }
};
