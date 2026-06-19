const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const os = require('os');
const { exec } = require('child_process');
const app = express();
const port = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Cấu hình phục vụ file tĩnh: Frontend nằm ở thư mục ../frontend so với vị trí file server.js
app.use(express.static(path.join(__dirname, '../frontend')));

// Routes cho trang chủ
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Hàm Backup Git
const autoBackup = () => {
    console.log("Đang thực hiện backup...");
    exec('git add . && git commit -m "Auto backup system update" && git push', (err, stdout, stderr) => {
        if (err) {
            console.error("Git Backup Error:", stderr);
            return;
        }
        console.log("Backup thành công:", stdout);
    });
};

// Khởi tạo cấu trúc thư mục tự động
const dirs = [
    'products/videos', 'products/images', 'products/audio', 
    'products/background', 'products/subtitles', 'products/projects', 
    'products/temp', 'logs'
];

// Tạo các thư mục trong thư mục gốc dự án (my-ai-app/)
dirs.forEach(dir => {
    const dirPath = path.join(__dirname, '../', dir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
});

// API Endpoints
app.get('/api/system', (req, res) => {
    res.json({
        cpu: os.loadavg()[0] * 10,
        ram: ((os.totalmem() - os.freemem()) / os.totalmem()) * 100,
        gpu: 45,
        disk: 20
    });
});

app.post('/api/analyze', async (req, res) => {
    const { script } = req.body;
    // Logic gọi service (Ví dụ: dùng module kichban đã tạo trước đó)
    const result = { 
        success: true, 
        scenes: [{title: "Scene 1", content: script.substring(0, 50)}] 
    };
    
    // Backup dự án
    fs.writeFileSync(path.join(__dirname, '../products/projects', `proj_${Date.now()}.json`), JSON.stringify(result));
    autoBackup();
    
    res.json(result);
});

app.post('/api/render', async (req, res) => {
    // Gọi vid service tại đây
    const result = { status: "success", file: "video_output.mp4" };
    autoBackup();
    res.json(result);
});

// Khởi động server
app.listen(port, () => {
    console.log(`Server đang chạy tại: http://localhost:${port}`);
});
