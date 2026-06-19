const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const gTTS = require('gtts');
const kichban = require('./kichban'); // Gọi file kịch bản để xử lý đồng bộ

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
            
            // Danh sách lưu các file audio tạm thời để dọn dẹp
            let tempAudioFiles = []; 
            const finalAudioPath = path.join(__dirname, `final_audio_${timestamp}.mp3`);

            try {
                if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

                // 1. CHẠY PHÂN TÍCH VĂN BẢN THÀNH KỊCH BẢN CHI TIẾT
                console.log(`[Engine] Đang phân tích cú pháp để xử lý ngắt nghỉ...`);
                const scriptStructure = kichban.analyze(data.script);
                
                // Thu thập tất cả các câu thoại nhỏ từ các Scene
                let allDialogues = [];
                scriptStructure.scenes.forEach(scene => {
                    allDialogues = allDialogues.concat(scene.dialogues);
                });

                console.log(`[Engine] Tìm thấy ${allDialogues.length} phân đoạn thoại. Bắt đầu sinh giọng đọc từng câu...`);

                // 2. SINH AUDIO CHO TỪNG CÂU VÀ THÊM KHOẢNG NGẮT NGHỈ (PAUSE)
                for (let i = 0; i < allDialogues.length; i++) {
                    const dlg = allDialogues[i];
                    const rawAudioPart = path.join(__dirname, `part_raw_${i}_${timestamp}.mp3`);
                    const paddedAudioPart = path.join(__dirname, `part_pad_${i}_${timestamp}.mp3`);
                    
                    // Tạo giọng chuẩn cho câu đó
                    const gtts = new gTTS(dlg.content, 'vi');
                    await new Promise((res, rej) => {
                        gtts.save(rawAudioPart, (err) => { if (err) rej(err); else res(); });
                    });
                    tempAudioFiles.push(rawAudioPart);

                    // Ép FFmpeg chèn thêm khoảng lặng (pauseAfter) vào cuối file audio này
                    const pauseSeconds = dlg.pauseAfter || 1.0;
                    await new Promise((res, rej) => {
                        ffmpeg(rawAudioPart)
                            // Sử dụng bộ lọc filter_complex để tạo khoảng lặng (apad) đúng theo số giây cấu hình kịch bản
                            .outputOptions([
                                `-af apad=pad_len=${Math.floor(pauseSeconds * 44100)}` 
                            ])
                            .output(paddedAudioPart)
                            .on('end', res)
                            .on('error', rej)
                            .run();
                    });
                    tempAudioFiles.push(paddedAudioPart);
                }

                // 3. GỘP TẤT CẢ CÁC FILE AUDIO ĐÃ CÓ NGẮT NGHỈ THÀNH FILE TỔNG
                console.log(`[Engine] Đang nối chuỗi âm thanh ngắt nghỉ...`);
                const concatListPath = path.join(__dirname, `list_${timestamp}.txt`);
                // Lọc ra các file đã được chèn khoảng lặng để nối
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

                // 4. TIẾN HÀNH RENDER PHIM MIX VỚI WATERMARK ĐỘNG
                const resMap = { '320': '480x320', '720': '1280x720', '1080': '1920x1080' };
                const rawRes = String(data.resOption || '720').replace('p', '');
                const targetRes = resMap[rawRes] || '1280x720';
                const [wStr, hStr] = targetRes.split('x');

                const fontPath = "C\\\\:/Windows/Fonts/arial.ttf"; 
                const wmText = data.watermark || 'Tacke300 Bot';
                const opacity = data.wmOpacity || '0.15'; 
                const styleMode = data.wmStyle || 'all';  

                let filters = [`scale=${wStr}:${hStr}:force_original_aspect_ratio=decrease,pad=${wStr}:${hStr}:(w-iw)/2:(h-ih)/2:black`];

                if (styleMode === 'all' || styleMode === 'zigzag') {
                    filters.push(`drawtext=fontfile='${fontPath}':text='${wmText}':x='(w-tw)/2+((w-tw)/2)*sin(t)':y='(h-th)/2+((h-th)/2)*cos(t)':fontsize=h/18:fontcolor=white@${opacity}`);
                }
                if (styleMode === 'all' || styleMode === 'bottom') {
                    filters.push(`drawtext=fontfile='${fontPath}':text='${wmText}':x='mod(t*90\\,w)':y='h-th-20':fontsize=h/24:fontcolor=white@${opacity}`);
                }

                console.log(`[FFmpeg] Đang đóng gói Video tổng hợp...`);

                ffmpeg()
                    .input(defaultBgPath)
                    .loop() 
                    .input(finalAudioPath)
                    .outputOptions([
                        '-c:v libx264',
                        '-tune stillimage',
                        '-pix_fmt yuv420p',
                        '-c:a aac',
                        '-b:a 128k',
                        '-shortest'
                    ])
                    .videoFilters(filters)
                    .output(outputPath)
                    .on('progress', (p) => {
                        if (p.percent) onProgress(Math.floor(p.percent));
                    })
                    .on('end', () => {
                        // Dọn dẹp toàn bộ file rác tạm thời trong RAM/Ổ cứng
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
