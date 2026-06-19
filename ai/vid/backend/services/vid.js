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

                // 1. Sinh Audio từ text
                const cleanText = data.script.replace(/Tiêu đề:.*?\n/g, '').trim();
                const gtts = new gTTS(cleanText || "Xin chào", 'vi');
                
                await new Promise((res, rej) => {
                    gtts.save(audioPath, (err) => {
                        if (err) rej(err);
                        else res();
                    });
                });

                // Cấu hình kích thước khung hình
                const resMap = { '320': '480x320', '720': '1280x720', '1080': '1920x1080' };
                const rawRes = String(data.resOption || '720').replace('p', '');
                const targetRes = resMap[rawRes] || '1280x720';
                const [wStr, hStr] = targetRes.split('x');

                const fontPath = "C\\\\:/Windows/Fonts/arial.ttf"; 
                const wmText = data.watermark || 'Tacke300 Bot';
                const opacity = data.wmOpacity || '0.15'; // Độ mờ nhận từ UI
                const styleMode = data.wmStyle || 'all';  // Kiểu chạy nhận từ UI

                // Khởi tạo mảng bộ lọc video
                let filters = [
                    `scale=${wStr}:${hStr}:force_original_aspect_ratio=decrease,pad=${wStr}:${hStr}:(w-iw)/2:(h-ih)/2:black`
                ];

                // Phân tích logic chọn hiệu ứng của người dùng
                if (styleMode === 'all' || styleMode === 'zigzag') {
                    // Chữ chạy chéo zigzag toàn màn hình
                    filters.push(`drawtext=fontfile='${fontPath}':text='${wmText}':x='(w-tw)/2+((w-tw)/2)*sin(t)':y='(h-th)/2+((h-th)/2)*cos(t)':fontsize=h/18:fontcolor=white@${opacity}`);
                }
                
                if (styleMode === 'all' || styleMode === 'bottom') {
                    // Chữ quét hàng ngang liên tục ở sát cạnh đáy video
                    filters.push(`drawtext=fontfile='${fontPath}':text='${wmText}':x='mod(t*90\\,w)':y='h-th-20':fontsize=h/24:fontcolor=white@${opacity}`);
                }

                console.log(`[Engine] Đang xử lý bộ lọc Watermark dạng [${styleMode}] với độ mờ [${opacity}]`);

                // 2. Tiến hành build lệnh và ghép luồng
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
                    .videoFilters(filters)
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
