
const fs = require('fs');
const https = require('https');
const { execSync } = require('child_process');

console.log("==> 1. Đang dọn dẹp thư mục cũ...");
if (fs.existsSync('C:\\ffmpeg')) {
    try { execSync('rmdir /s /q C:\\ffmpeg'); } catch(e){}
}
fs.mkdirSync('C:\\ffmpeg', { recursive: true });

console.log("==> 2. Đang tải bản FFmpeg di động siêu nhẹ (7mb)...");
// Sử dụng bản build exe trực tiếp từ build uy tín chống nghẽn mạng
const file = fs.createWriteStream("C:\\ffmpeg\\ffmpeg.exe");
https.get("https://raw.githubusercontent.com/eugeneware/ffmpeg-static/master/bin/win32/x64/ffmpeg.exe", function(response) {
    response.pipe(file);
    file.on('finish', function() {
        file.close();
        console.log("==> ✅ ĐÃ TẢI XONG! File FFmpeg hiện tại nằm tại: C:\\ffmpeg\\ffmpeg.exe");
        
        // Kiểm tra xem file chạy được không
        try {
            const version = execSync('C:\\ffmpeg\\ffmpeg.exe -version').toString().split('\n')[0];
            console.log("==> Kiểm tra hệ thống thành công:", version);
        } catch(err) {
            console.log("==> Lỗi thực thi file:", err.message);
        }
    });
});
