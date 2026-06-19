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
            const dummyImgPath = path.join(__dirname, `bg_${timestamp}.jpg`);
            
            try {
                const videoDir = path.join(__dirname, '../../product/videos');
                if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
                const outputPath = path.join(videoDir, outputName);

                // 1. TẠO GIỌNG ĐỌC TỪ KỊCH BẢN (Xóa tiêu đề nếu có)
                const cleanText = data.script.replace(/Tiêu đề:.*?\n/g, '').trim();
                const gtts = new gTTS(cleanText || "Xin chào", 'vi');
                
                await new Promise((res, rej) => {
                    gtts.save(audioPath, (err) => {
                        if (err) rej(err);
                        else res();
                    });
                });

                // 2. TẠO ẢNH NỀN TẠM THỜI ĐỂ ÉP LUỒNG VIDEO (FIX LỖI ĐEN XÌ & GIỚI HẠN 5 GIÂY)
                const resMap = { '320': '480x320', '720': '1280x720', '1080': '1920x1080' };
                const rawRes = String(data.resOption || '720').replace('p', '');
                const [width, height] = (resMap[rawRes] || '1280x720').split('x');

                // Tạo 1 file ảnh đen chuẩn kích thước bằng FFmpeg trước
                await new Promise((res, rej) => {
                    ffmpeg()
                        .input(`color=c=0x111116:s=${width}x${height}`)
                        .inputFormat('lavfi')
                        .frames(1)
                        .output(dummyImgPath)
                        .on('end', res)
                        .on('error', rej)
                        .run();
                });

                console.log(`[FFmpeg] Khởi chạy Render liên tục theo trục Audio | ${width}x${height}`);

                // 3. MIX ẢNH NỀN LẶP LẠI VÀO AUDIO GỐC
                ffmpeg()
                    .input(dummyImgPath)
                    .loop() // Vòng lặp vô hạn ảnh nền cho đến khi hết audio
                    .input(audioPath)
                    .outputOptions([
                        '-c:v libx264',      // Bộ mã hóa H.264 tương thích mọi thiết bị di động
                        '-tune stillimage',  // Tối ưu hóa nén cho dạng ảnh tĩnh có tiếng
                        '-pix_fmt yuv420p',  // Ép bảng màu chuẩn Mobile (Sửa lỗi màn hình đen trên Safari/Chrome Mobile)
                        '-c:a aac',          // Mã hóa âm thanh chuẩn AAC
                        '-b:a 128k',         // Băng thông âm thanh cố định giúp mở thanh Volume
                        '-shortest'          // Cắt video ngay khi audio kết thúc (Độ dài chuẩn theo câu chuyện)
                    ])
                    .videoFilters([
                        `drawtext=text='${data.watermark || 'AI Bot'}':x=w-tw-20:y=20:fontsize=h/22:fontcolor=white@0.6`,
                        `drawtext=text='Style\\: ${data.style || 'Default'}':x=20:y=h-40:fontsize=h/26:fontcolor=yellow@0.8`
                    ])
                    .output(outputPath)
                    .on('progress', (p) => {
                        if (p.percent) onProgress(Math.floor(p.percent));
                    })
                    .on('end', () => {
                        // Dọn dẹp tài nguyên rác sau khi render xong
                        try { fs.unlinkSync(audioPath); } catch (e) {}
                        try { fs.unlinkSync(dummyImgPath); } catch (e) {}
                        resolve(outputName);
                    })
                    .on('error', (err) => {
                        try { fs.unlinkSync(audioPath); } catch (e) {}
                        try { fs.unlinkSync(dummyImgPath); } catch (e) {}
                        reject(err);
                    })
                    .run();

            } catch (err) {
                try { fs.unlinkSync(audioPath); } catch (e) {}
                try { fs.unlinkSync(dummyImgPath); } catch (e) {}
                reject(err);
            }
        });
    }
};
