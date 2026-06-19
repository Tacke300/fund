const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

// ==========================================
// ĐỊNH VỊ FFMEG TRÊN WINDOWS (CHỐNG LỖI ENOENT)
// ==========================================
if (process.platform === 'win32') {
    const defaultPath = 'C:\\ffmpeg\\ffmpeg.exe';
    const subBinPath = 'C:\\ffmpeg\\bin\\ffmpeg.exe';

    if (fs.existsSync(defaultPath)) {
        ffmpeg.setFfmpegPath(defaultPath);
    } else if (fs.existsSync(subBinPath)) {
        ffmpeg.setFfmpegPath(subBinPath);
    } else {
        // Nếu không tìm thấy ở cả 2 nơi, gọi lệnh toàn cục từ hệ thống
        ffmpeg.setFfmpegPath('ffmpeg');
    }
}

module.exports = {
    render: (data, outputName, onProgress) => {
        return new Promise((resolve, reject) => {
            // 1. Tự động tạo thư mục đầu ra: product/videos
            const videoDir = path.join(__dirname, '../../product/videos');
            if (!fs.existsSync(videoDir)) {
                fs.mkdirSync(videoDir, { recursive: true });
            }

            const outputPath = path.join(videoDir, outputName);

            // 2. Bảng ánh xạ độ phân giải từ Frontend truyền lên
            const resMap = {
                '320': '480x320',
                '720': '1280x720',
                '1080': '1920x1080',
                '2k': '2560x1440',
                '4k': '3840x2160'
            };

            // Chuẩn hóa dữ liệu nhận được (ví dụ "720p" hay "720" đều hiểu)
            const rawRes = String(data.resOption).toLowerCase().replace('p', '');
            const resolution = resMap[rawRes] || '1280x720'; // Mặc định 720p nếu lỗi

            console.log(`[FFmpeg] Khởi chạy Render | Độ phân giải: ${resolution} | File: ${outputName}`);

            // 3. Thực thi render video bằng FFmpeg
            ffmpeg()
                // Tạo luồng video nền đen với độ phân giải động, thời lượng 5 giây
                .input(`color=c=black:s=${resolution}:d=5`)
                .inputFormat('lavfi')
                
                // Bộ lọc chèn Watermark: Tự động co giãn cỡ chữ (fontsize = chiều cao / 15) theo độ phân giải để không bị quá bé ở màn hình 4K
                .videoFilters(`drawtext=text='${data.watermark || 'AI Bot'}':x=w*mod(t/5\\,1):y=h/2:fontsize=h/15:fontcolor=white`)
                
                .output(outputPath)
                .on('progress', (p) => {
                    if (p.percent) {
                        // Bắn % tiến độ ngược lại cho hàm callback của server.js
                        onProgress(Math.floor(p.percent));
                    }
                })
                .on('end', () => {
                    console.log(`[FFmpeg] Hoàn thành render file: ${outputName}`);
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
