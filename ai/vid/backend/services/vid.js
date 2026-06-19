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
            const timestamp = Date.now();
            const audioPath = path.join(__dirname, `audio_${timestamp}.mp3`);
            const defaultBgPath = path.join(__dirname, '../../product/default_bg.jpg');

            try {
                const videoDir = path.join(__dirname, '../../product/videos');
                if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
                const outputPath = path.join(videoDir, outputName);

                // 1. TẠO GIỌNG ĐỌC TỪ KỊCH BẢN
                const cleanText = data.script.replace(/Tiêu đề:.*?\n/g, '').trim();
                const gtts = new gTTS(cleanText || "Xin chào", 'vi');
                
                await new Promise((res, rej) => {
                    gtts.save(audioPath, (err) => {
                        if (err) rej(err);
                        else res();
                    });
                });

                // KIỂM TRA ẢNH NỀN THỰC TẾ
                if (!fs.existsSync(defaultBgPath)) {
                    console.log("[Cảnh báo] Chưa tìm thấy ảnh nền thực tế, hệ thống sẽ dùng ảnh tạm thời.");
                    const base64BlackDot = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
                    fs.writeFileSync(defaultBgPath, Buffer.from(base64BlackDot, 'base64'));
                }

                // Cấu hình độ phân giải đầu ra
                const resMap = { '320': '480x320', '720': '1280x720', '1080': '1920x1080' };
                const rawRes = String(data.resOption || '720').replace('p', '');
                const targetRes = resMap[rawRes] || '1280x720';
                const [wStr, hStr] = targetRes.split('x');

                console.log(`[FFmpeg] Khởi chạy Render hình ảnh thực tế | Cấu hình: ${targetRes}`);

                // 2. MIX PHÔNG NỀN THỰC TẾ + AUDIO TRUYỆN
                ffmpeg()
                    .input(defaultBgPath)
                    .loop() 
                    .input(audioPath)
                    .outputOptions([
                        '-c:v libx264',
                        '-tune stillimage',
                        '-pix_fmt yuv420p',
                        '-c:a aac',
                        '-b:a 128k',
                        '-shortest'
                    ])
                    .videoFilters([
                        // Ép kích thước ảnh nền fit khít góc màn hình video, chống lỗi đen màn hình
                        `scale=${wStr}:${hStr}:force_original_aspect_ratio=decrease,pad=${wStr}:${hStr}:(w-iw)/2:(h-ih)/2:black`,
                        `drawtext=text='${data.watermark || 'AI Bot'}':x=w-tw-20:y=20:fontsize=h/22:fontcolor=white@0.7`,
                        `drawtext=text='Style\\: ${data.style || 'Default'}':x=20:y=h-40:fontsize=h/26:fontcolor=yellow@0.9`
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
                try { fs.unlinkSync(audioPath); } catch (e) {}
                reject(err);
            }
        });
    }
};
