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
            
            // Tạo hẳn 1 đường dẫn ảnh nền cố định trong thư mục sản phẩm
            const bgDir = path.join(__dirname, '../../product');
            if (!fs.existsSync(bgDir)) fs.mkdirSync(bgDir, { recursive: true });
            const defaultBgPath = path.join(bgDir, 'default_bg.jpg');

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

                // 2. TẠO ẢNH NỀN TĨNH THỰC TẾ NẾU CHƯA CÓ (KHÔNG DÙNG LAVFI)
                // Nếu file default_bg.jpg chưa tồn tại, ta tạo một file ảnh JPEG 1x1 pixel siêu nhẹ để làm mồi
                if (!fs.existsSync(defaultBgPath)) {
                    // Base64 của 1 ảnh JPEG đen 1x1 pixel chuẩn
                    const base64BlackDot = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
                    fs.writeFileSync(defaultBgPath, Buffer.from(base64BlackDot, 'base64'));
                }

                // Lấy độ phân giải cấu hình
                const resMap = { '320': '480x320', '720': '1280x720', '1080': '1920x1080' };
                const rawRes = String(data.resOption || '720').replace('p', '');
                const targetRes = resMap[rawRes] || '1280x720';

                console.log(`[FFmpeg] Khởi chạy Render bằng Gốc Ảnh Tĩnh | Không dùng lavfi | Cấu hình: ${targetRes}`);

                // 3. MIX VIDEO THEO THỜI LƯỢNG AUDIO
                ffmpeg()
                    .input(defaultBgPath)
                    .loop() // Lặp ảnh nền thực tế
                    .input(audioPath)
                    .outputOptions([
                        '-c:v libx264',
                        '-tune stillimage',
                        '-pix_fmt yuv420p',
                        '-c:a aac',
                        '-b:a 128k',
                        '-shortest' // Video dài đúng bằng file Audio câu chuyện
                    ])
                    .videoFilters([
                        `scale=${targetRes.replace('x', ':')}`, // Ép ảnh 1x1 giãn ra đúng độ phân giải bạn chọn (720p/1080p)
                        `drawtext=text='${data.watermark || 'AI Bot'}':x=w-tw-20:y=20:fontsize=h/22:fontcolor=white@0.6`,
                        `drawtext=text='Style\\: ${data.style || 'Default'}':x=20:y=h-40:fontsize=h/26:fontcolor=yellow@0.8`
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
