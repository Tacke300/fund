const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

module.exports = {
    render: (data, outputName, onProgress) => {
        return new Promise((resolve, reject) => {
            // 1. Tự động tạo thư mục products/videos nếu chưa có
            const videoDir = path.join(__dirname, '../../products/videos');
            if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

            const outputPath = path.join(videoDir, outputName);

            // 2. FFmpeg: Tự tạo video nền đen dài 5 giây + độ phân giải bạn chọn + chữ chạy
            const resolution = data.resOption || '1280x720';
            
            ffmpeg()
                .input(`color=c=black:s=${resolution}:d=5`)
                .inputFormat('lavfi')
                .videoFilters(`drawtext=text='${data.watermark}':x=w*mod(t/5\\,1):y=h/2:fontsize=50:fontcolor=white`)
                .output(outputPath)
                .on('progress', (p) => {
                    // Trả % tiến độ về server.js
                    if (p.percent) onProgress(Math.floor(p.percent));
                })
                .on('end', () => resolve(outputName))
                .on('error', (err) => reject(err))
                .run();
        });
    }
};
