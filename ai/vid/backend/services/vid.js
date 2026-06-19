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

                // 1. TẠO GIỌNG ĐỌC (Hiện tại gtts mặc định dùng chung 1 giọng chuẩn Google tiếng Việt)
                const cleanText = data.script.replace(/Tiêu đề:.*?\n/g, '').trim();
                const gtts = new gTTS(cleanText || "Xin chào", 'vi');
                
                await new Promise((res, rej) => {
                    gtts.save(audioPath, (err) => {
                        if (err) rej(err);
                        else res();
                    });
                });

                // Kiểm tra ảnh nền mồi
                if (!fs.existsSync(defaultBgPath)) {
                    const base64BlackDot = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
                    fs.writeFileSync(defaultBgPath, Buffer.from(base64BlackDot, 'base64'));
                }

                const resMap = { '320': '480x320', '720': '1280x720', '1080': '1920x1080' };
                const rawRes = String(data.resOption || '720').replace('p', '');
                const targetRes = resMap[rawRes] || '1280x720';
                const [wStr, hStr] = targetRes.split('x');

                // SỬA LỖI ĐƯỜNG DẪN FONT TRÊN WINDOWS (Ép dùng format chuẩn hóa của FFmpeg)
                const fontPath = "C\\\\:/Windows/Fonts/arial.ttf"; 
                const wmText = data.watermark || 'Tacke300 Bot';

                console.log(`[FFmpeg] Đang render với hiệu ứng Watermark quét động chuyển động...`);

                // 2. TIẾN TRÌNH RENDER VIDEO
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
                        // Giãn ảnh nền khít khung hình
                        `scale=${wStr}:${hStr}:force_original_aspect_ratio=decrease,pad=${wStr}:${hStr}:(w-iw)/2:(h-ih)/2:black`,
                        
                        // HIỆU ỨNG CHỐNG REUP: Chữ mờ (alpha=0.15) chạy chéo zigzag khắp màn hình theo thời gian (t)
                        // Tốc độ chạy tùy biến theo hàm sin/cos tạo hiệu ứng di chuyển mượt mà ngang dọc chéo
                        `drawtext=fontfile='${fontPath}':text='${wmText}':x='(w-tw)/2+((w-tw)/2)*sin(t)':y='(h-th)/2+((h-th)/2)*cos(t)':fontsize=h/18:fontcolor=white@0.15`,
                        
                        // Thêm 1 đường chạy ngang cố định ở cạnh dưới màn hình để chặn tool crop
                        `drawtext=fontfile='${fontPath}':text='${wmText}':x='mod(t*80\\,w)':y='h-th-20':fontsize=h/25:fontcolor=white@0.12`
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
                        console.error("[FFmpeg Internal Error]:", err.message);
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
