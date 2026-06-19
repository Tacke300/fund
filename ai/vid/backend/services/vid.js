const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const gTTS = require('gtts');

if (process.platform === 'win32') {
    ffmpeg.setFfmpegPath('C:\\ffmpeg\\ffmpeg.exe');
}

module.exports = {
    render: (data, outputName, onProgress) => {
        return new Promise(async (resolve, reject) => {
            try {
                const videoDir = path.join(__dirname, '../../product/videos');
                if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
                const outputPath = path.join(videoDir, outputName);

                // 1. TẠO GIỌNG ĐỌC AI (AUDIO CHUẨN)
                const audioPath = path.join(__dirname, `audio_${Date.now()}.mp3`);
                const cleanText = data.script.replace(/Tiêu đề:.*?\n/g, '').trim();
                
                const gtts = new gTTS(cleanText || "Xin chào", 'vi');
                await new Promise((res, rej) => {
                    gtts.save(audioPath, (err) => {
                        if (err) rej(err);
                        else res();
                    });
                });

                // 2. CẤU HÌNH ĐỘ PHÂN GIẢI
                const resMap = { '320': '480x320', '720': '1280x720', '1080': '1920x1080' };
                const rawRes = String(data.resOption || '720').replace('p', '');
                const [width, height] = (resMap[rawRes] || '1280x720').split('x');

                console.log(`[FFmpeg] Khởi chạy Render Thực tế | ${width}x${height} | Audio sống`);

                // 3. RENDER VIDEO KẾT HỢP HÌNH NỀN HOẠT HỌA + TIẾNG
                ffmpeg()
                    .input(`color=c=black:s=${width}x${height}:r=25`) // Tạo luồng video gốc thay vì ảnh tĩnh hỏng
                    .inputFormat('lavfi') 
                    .input(audioPath)
                    // Ép hệ thống dùng bộ sinh cấu trúc gốc của bản build 8.1.1
                    .outputOptions([
                        '-pix_fmt yuv420p',
                        '-c:v libx264',
                        '-c:a aac',
                        '-shortest' // Tự động kết thúc video khi giọng đọc chạy hết
                    ])
                    .videoFilters([
                        `drawtext=text='${data.watermark || 'AI Bot'}':x=w-tw-20:y=20:fontsize=h/20:fontcolor=white@0.5`,
                        `drawtext=text='Style\\: ${data.style || 'Default'}':x=20:y=h-40:fontsize=h/25:fontcolor=yellow`
                    ])
                    .output(outputPath)
                    .on('progress', (p) => {
                        if (p.percent) onProgress(Math.floor(p.percent));
                    })
                    .on('end', () => {
                        try { fs.unlinkSync(audioPath); } catch (e) {}
                        resolve(outputName);
                    })
                    .on('error', (err) => {
                        try { fs.unlinkSync(audioPath); } catch (e) {}
                        reject(err);
                    })
                    .run();

            } catch (err) {
                reject(err);
            }
        });
    }
};
