const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Import dịch vụ render video đã fix ở bước trước
const vidService = require('./services/vid');

const app = express();
const PORT = 3000;

// Cấu hình Middleware
app.use(cors());
app.use(express.json());

// Tự động tạo thư mục product/videos để lưu trữ và phục vụ static file
const productDir = path.join(__dirname, '../product');
const videoDir = path.join(productDir, 'videos');
if (!fs.existsSync(videoDir)) {
    fs.mkdirSync(videoDir, { recursive: true });
}

// Cấu hình định tuyến tĩnh (Static) để Frontend có thể xem và tải video trực tiếp
app.use('/product', express.static(productDir));
// Phục vụ giao diện frontend (nếu index.html nằm ở thư mục frontend bên cạnh backend)
app.use(express.static(path.join(__dirname, '../frontend')));

// Khởi tạo biến lưu trữ log tiến độ render real-time
let renderLogs = "Hệ thống sẵn sàng...";

// ==========================================
// 1. API PHÂN TÍCH KỊCH BẢN (ANALYZE)
// ==========================================
app.post('/api/analyze', (req, res) => {
    try {
        const { script } = req.body;
        if (!script) {
            return res.status(400).json({ error: "Chưa nhập nội dung kịch bản!" });
        }

        // Tách kịch bản thành từng dòng (loại bỏ dòng trống) để phân cảnh
        const scenes = script.split('\n')
                             .map(line => line.trim())
                             .filter(line => line.length > 0);

        console.log(`[Server] Phân tích kịch bản thành công: ${scenes.length} cảnh.`);
        return res.json({ scenes });
    } catch (err) {
        console.error("[Server Lỗi Analyze]:", err.message);
        return res.status(500).json({ error: "Lỗi hệ thống khi phân tích kịch bản." });
    }
});

// ==========================================
// 2. API KHỞI CHẠY RENDER VIDEO (RENDER)
// ==========================================
app.post('/api/render', async (req, res) => {
    const data = req.body;
    const outputName = `video_${Date.now()}.mp4`;
    
    renderLogs = `[${new Date().toLocaleTimeString()}] Bắt đầu tiến trình tạo video...\n`;
    console.log("[Server] Nhận yêu cầu render với cấu hình:", data);

    try {
        // Gọi tầng dịch vụ FFmpeg thực thi render (Không chặn luồng chính của Express)
        await vidService.render(data, outputName, (percent) => {
            renderLogs = `[${new Date().toLocaleTimeString()}] Đang render... Tiến độ: ${percent}%\n`;
        });

        renderLogs += `[${new Date().toLocaleTimeString()}] Hoàn thành xuất sắc! File: ${outputName}\n`;
        
        // Trả về URL dạng static chuẩn để thẻ <video> phía frontend chạy được luôn
        return res.json({
            status: 'Success',
            videoUrl: `/product/videos/${outputName}`,
            fileName: outputName
        });

    } catch (error) {
        // Bắt mọi lỗi từ FFmpeg (ví dụ: mất file exe, sai cấu hình) để không bị sập app
        renderLogs += `[LỖI CHÍ MẠNG]: ${error.message}\n`;
        console.error("[Server Lỗi Render]:", error.message);
        
        // Trả về lỗi 500 có cấu trúc để Frontend hiển thị lên màn hình, không bị treo fetch
        return res.status(500).json({
            status: 'Error',
            error: error.message
        });
    }
});

// ==========================================
// 3. API ĐỌC TIẾN ĐỘ REAL-TIME (LOGS POLLING)
// ==========================================
app.get('/api/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    return res.send(renderLogs);
});

// Kích hoạt lắng nghe cổng
app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`🚀 Server AI Video đang chạy mượt mà tại cổng: ${PORT}`);
    console.log(` Thư mục lưu sản phẩm: ${videoDir}`);
    console.log(`==================================================`);
});
