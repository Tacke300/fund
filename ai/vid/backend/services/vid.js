const { exec } = require('child_process');

module.exports = {
    // Đây là hàm sẽ chạy thực tế lệnh render
    runFFmpeg: (config) => {
        return new Promise((resolve, reject) => {
            // Lệnh mẫu: Ghép ảnh, nhạc và chèn logo
            // FFmpeg command này có thể thay đổi tùy thuộc vào mục đích
            const cmd = `ffmpeg -loop 1 -i scene.png -i audio.mp3 -i logo.png -filter_complex "[0:v][2:v]overlay=10:10" -c:v libx264 -t 10 output.mp4`;
            
            exec(cmd, (error, stdout, stderr) => {
                if (error) reject(stderr);
                resolve(stdout);
            });
        });
    }
};
