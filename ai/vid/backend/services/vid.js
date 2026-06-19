const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

// BẮT BUỘC: Fix lỗi "Cannot find ffmpeg" trên Windows 10
// Nếu thư mục ffmpeg của bạn nằm ở ổ khác, hãy sửa lại đường dẫn này cho đúng
if (process.platform === 'win32') {
    ffmpeg.setFfmpegPath('C:\\ffmpeg\\bin\\ffmpeg.exe');
}

module.exports = {
    render: (data, outputName, onProgress) => {
        return new Promise((resolve, reject) => {
            // 1. Tự động tạo thư mục product/videos (Đúng tên thư mục dự án của bạn)
            const videoDir = path.join(__dirname, '../../product/videos');
            if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

            const outputPath = path.join(videoDir, outputName);

            // 2. Bản đồ quy đổi chất lượng video sang Resolution chuẩn
            const resMap = {
                '320': '480x320',
                '720': '1280x720',
                '1080': '1920x1080',
                '2k': '2560x1440',
                '4k': '3840x2160'
            };

            // Nhận diện dữ liệu frontend truyền về (mặc định lấy 720p nếu truyền sai)
            const rawRes = String(data.resOption).toLowerCase().replace('p', ''); 
            const resolution = resMap[rawRes] || data.resOption || '1280x720';

            console.log(`[FFmpeg Engine] Bắt đầu render cấu hình: ${resolution}`);

            // 3. Thực thi FFmpeg sinh video thực tế
            ffmpeg()
                .input(`color=c=black:s=${resolution}:d=5`) // Tạo nền đen theo độ phân giải đã chọn
                .inputFormat('lavfi')
                .videoFilters(`drawtext=text='${data.watermark || 'AI Bot'}':x=w*mod(t/5\\,1):y=h/2:fontsize=h/15:fontcolor=white`) 
                // fontsize=h/15 tự động co giãn kích thước chữ watermark theo độ phân giải video, tránh việc 4K chữ quá bé
                .output(outputPath)
                .on('progress', (p) => {
                    if (p.percent) onProgress(Math.floor(p.percent));
                })
                .on('end', () => {
                    console.log(`[FFmpeg Engine] Hoàn thành. File lưu tại: ${outputPath}`);
                    resolve(outputName);
                })
                .on('error', (err) => {
                    console.error(`[FFmpeg Engine] Gặp lỗi:`, err.message);
                    reject(err);
                })
                .run();
        });
    }
};
