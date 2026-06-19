const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

// ÉP CỨNG ĐƯỜNG DẪN FFMEG TRÊN WINDOWS
if (process.platform === 'win32') {
    ffmpeg.setFfmpegPath('C:\\ffmpeg\\ffmpeg.exe');
}

module.exports = {
    render: (data, outputName, onProgress) => {
        return new Promise((resolve, reject) => {
            const videoDir = path.join(__dirname, '../../product/videos');
            if (!fs.existsSync(videoDir)) {
                fs.mkdirSync(videoDir, { recursive: true });
            }

            const outputPath = path.join(videoDir, outputName);

            // 1. TẠO FILE ẢNH NỀN ĐEN TẠM THỜI
            const tempImgPath = path.join(__dirname, 'temp_black.jpg');
            if (!fs.existsSync(tempImgPath)) {
                const blackPixelBase64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
                fs.writeFileSync(tempImgPath, Buffer.from(blackPixelBase64, 'base64'));
            }

            // 2. BẢNG ÁNH XẠ ĐỘ PHÂN GIẢI ĐỘNG
            const resMap = {
                '320': '480x320',
                '720': '1280x720',
                '1080': '1920x1080',
                '2k': '2560x1440',
                '4k': '3840x2160'
            };

            const rawRes = String(data.resOption || data.resolution).toLowerCase().replace('p', '');
            const resolution = resMap[rawRes] || '1280x720';
            const [width, height] = resolution.split('x');

            console.log(`[FFmpeg] Khởi chạy Render sạch | Độ phân giải: ${resolution} | File: ${outputName}`);

            // 3. THỰC THI XỬ LÝ VIDEO
            ffmpeg()
                .input(tempImgPath)
                .loop(5) // Thời lượng video mặc định: 5 giây
                .outputOptions([
                    '-pix_fmt yuv420p',
                    '-r 25'
                ])
                .videoFilters([
                    `scale=${width}:${height}`,
                    `drawtext=text='${data.watermark || 'AI Bot'}':x=w*mod(t/5\\,1):y=h/2:fontsize=h/15:fontcolor=white`
                ])
                .output(outputPath)
                .on('progress', (p) => {
                    if (p.percent) {
                        onProgress(Math.floor(p.percent));
                    }
                })
                .on('end', () => {
                    console.log(`[FFmpeg] Hoàn thành xuất sắc: ${outputName}`);
                    // Dọn dẹp file ảnh tạm
                    try { fs.unlinkSync(tempImgPath); } catch(e) {}
                    resolve(outputName);
                })
                .on('error', (err) => {
                    console.error(`[FFmpeg Lỗi]: ${err.message}`);
                    try { fs.unlinkSync(tempImgPath); } catch(e) {}
                    reject(err);
                })
                .run();
        });
    }
};
