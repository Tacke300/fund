const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

// ĐỊNH VỊ FFMEG TRÊN WINDOWS
if (process.platform === 'win32') {
    const defaultPath = 'C:\\ffmpeg\\ffmpeg.exe';
    const subBinPath = 'C:\\ffmpeg\\bin\\ffmpeg.exe';
    if (fs.existsSync(defaultPath)) ffmpeg.setFfmpegPath(defaultPath);
    else if (fs.existsSync(subBinPath)) ffmpeg.setFfmpegPath(subBinPath);
    else ffmpeg.setFfmpegPath('ffmpeg');
}

module.exports = {
    render: (data, outputName, onProgress) => {
        return new Promise((resolve, reject) => {
            const videoDir = path.join(__dirname, '../../product/videos');
            if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

            const outputPath = path.join(videoDir, outputName);

            // 1. TẠO FILE ẢNH NỀN ĐEN TẠM THỜI (Để thay thế lavfi)
            const tempImgPath = path.join(__dirname, 'temp_black.jpg');
            if (!fs.existsSync(tempImgPath)) {
                // Tạo 1 pixel ảnh màu đen định dạng base64 chuẩn mã hóa JPEG
                const blackPixelBase64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
                fs.writeFileSync(tempImgPath, Buffer.from(blackPixelBase64, 'base64'));
            }

            // 2. Bảng ánh xạ độ phân giải từ Frontend
            const resMap = {
                '320': '480x320',
                '720': '1280x720',
                '1080': '1920x1080',
                '2k': '2560x1440',
                '4k': '3840x2160'
            };

            const rawRes = String(data.resOption).toLowerCase().replace('p', '');
            const resolution = resMap[rawRes] || '1280x720';
            const [width, height] = resolution.split('x');

            console.log(`[FFmpeg] Khởi chạy Render không lavfi | Độ phân giải: ${resolution}`);

            // 3. Sử dụng file ảnh làm đầu vào thay vì thiết bị ảo
            ffmpeg()
                .input(tempImgPath)
                .loop(5) // Tạo video dài 5 giây từ ảnh lặp lại
                .outputOptions([
                    `-scale2ref=w=${width}:h=${height}[bg][txt]`, // Ép kích thước ảnh giãn ra theo cấu hình chọn
                    '-pix_fmt yuv420p',
                    '-r 25' // FPS chuẩn cho video
                ])
                // Bộ lọc chèn text (Dùng định dạng scale độc lập tránh lỗi kích thước)
                .videoFilters([
                    `scale=${width}:${height}`,
                    `drawtext=text='${data.watermark || 'AI Bot'}':x=w*mod(t/5\\,1):y=h/2:fontsize=h/15:fontcolor=white`
                ])
                .output(outputPath)
                .on('progress', (p) => {
                    if (p.percent) onProgress(Math.floor(p.percent));
                })
                .on('end', () => {
                    console.log(`[FFmpeg] Hoàn thành: ${outputName}`);
                    resolve(outputName);
                })
                .on('error', (err) => {
                    console.error(`[FFmpeg Lỗi]: ${err.message}`);
                    reject(err);
                })
                .run();
        });
    }
};
