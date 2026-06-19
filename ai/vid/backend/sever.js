const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const vidService = require('./services/vid');
const kichbanService = require('./services/kichban');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const productDir = path.join(__dirname, '../product');
const videoDir = path.join(productDir, 'videos');
const dbPath = path.join(__dirname, 'database.json');

if (!fs.existsSync(videoDir)) {
    fs.mkdirSync(videoDir, { recursive: true });
}

if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify({ videos: [] }, null, 2));
}

app.use('/product', express.static(productDir));
app.use(express.static(path.join(__dirname, '../frontend')));

let renderLogs = "Hệ thống sẵn sàng...";

const readDB = () => JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const writeDB = (data) => fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');

// API LẤY DANH SÁCH VIDEO CHỐNG MẤT DỮ LIỆU KHI F5
app.get('/api/videos', (req, res) => {
    try {
        const db = readDB();
        const files = fs.readdirSync(videoDir).filter(file => file.endsWith('.mp4'));
        const dataList = files.map(file => {
            const meta = db.videos.find(v => v.fileName === file) || {};
            return {
                fileName: file,
                videoUrl: `/product/videos/${file}`,
                title: meta.title || "Video Khung Hình Custom"
            };
        });
        return res.json({ status: 'Success', data: dataList });
    } catch (err) {
        return res.status(500).json({ status: 'Error', error: err.message });
    }
});

// API PHÂN TÍCH
app.post('/api/analyze', (req, res) => {
    try {
        const { script } = req.body;
        if (!script) return res.status(400).json({ status: 'Error', error: "Trống kịch bản" });
        const result = kichbanService.analyze(script);
        return res.json({ status: 'Success', data: result });
    } catch (err) {
        return res.status(500).json({ status: 'Error', error: err.message });
    }
});

// API RENDER VIDEO KHUNG ĐỒNG BỘ
app.post('/api/render', async (req, res) => {
    const data = req.body;
    const outputName = `video_${Date.now()}.mp4`;
    renderLogs = `[${new Date().toLocaleTimeString()}] Khởi chạy tiến trình render cấu hình lớn...\n`;

    // Phân tích kích thước khung hình từ tham số aspectRatio (Ví dụ: 16:9-720, 9:16-1080)
    const ratioData = data.aspectRatio || '16:9-720';
    const [ratio, resTarget] = ratioData.split('-');
    
    let w = 1280, h = 720;
    if (ratio === '16:9') {
        w = resTarget === '1080' ? 1920 : 1280;
        h = resTarget === '1080' ? 1080 : 720;
    } else if (ratio === '9:16') {
        w = resTarget === '1080' ? 1080 : 720;
        h = resTarget === '1080' ? 1920 : 1280;
    } else if (ratio === '1:1') {
        w = 1080; h = 1080;
    }

    // Ép ngược thông số độ phân giải sạch vào object dữ liệu dịch vụ
    data.targetWidth = w;
    data.targetHeight = h;
    data.fps = data.fps || 30;
    data.audioBitrate = data.audioBitrate || '320k'; // Cấu hình mồi 320k

    try {
        await vidService.render(data, outputName, (percent) => {
            renderLogs = `[${new Date().toLocaleTimeString()}] Đang xử lý Video [Kích thước ${w}x${h} | Audio: ${data.audioBitrate}]... Tiến độ: ${percent}%\n`;
        });

        // Ghi nhận lịch sử vào DB để khi tải lại trang không bị trắng giao diện
        const db = readDB();
        db.videos.push({ fileName: outputName, title: data.script.substring(0, 30) });
        writeDB(db);

        renderLogs += `[${new Date().toLocaleTimeString()}] Xuất bản Video thành công rực rỡ!\n`;
        
        // Kích hoạt tiến trình sao lưu tự động lên Github kho lưu trữ của bạn
        autoGitPush(`Render-backup: ${outputName} (${w}x${h})`);

        return res.json({
            status: 'Success',
            videoUrl: `/product/videos/${outputName}`,
            fileName: outputName
        });
    } catch (error) {
        renderLogs += `[Engine Lỗi]: ${error.message}\n`;
        return res.status(500).json({ status: 'Error', error: error.message });
    }
});

app.get('/api/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    return res.send(renderLogs);
});

function autoGitPush(msg) {
    const rootDir = path.join(__dirname, '../../');
    exec(`git add . && git commit -m "${msg}" && git push`, { cwd: rootDir }, (err) => {
        if (!err) renderLogs += `[Git System] Đồng bộ đám mây GitHub hoàn tất an toàn.\n`;
    });
}

app.listen(PORT, () => {
    console.log(`🚀 Engine Server đang chạy tại cổng: ${PORT}`);
});
