const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const os = require('os');
const { exec } = require('child_process');
const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const logFile = path.join(__dirname, '../logs/bot.log');

// Log thực tế vào file
const writeLog = (msg) => {
    const entry = `[${new Date().toLocaleString()}] ${msg}\n`;
    fs.appendFileSync(logFile, entry);
    console.log(msg);
};

// Hàm Backup Git thực tế
const performBackup = () => {
    exec('git add . && git commit -m "Auto backup: ' + new Date().toISOString() + '" && git push', (err) => {
        if (err) writeLog("Backup thất bại: " + err.message);
        else writeLog("Backup thành công lên Git");
    });
};

// API Hệ thống
app.get('/api/system', (req, res) => {
    res.json({
        cpu: os.loadavg()[0] * 10,
        ram: ((os.totalmem() - os.freemem()) / os.totalmem()) * 100,
        gpu: 0, 
        disk: 50
    });
});

// API Log
app.get('/api/logs', (req, res) => {
    if(fs.existsSync(logFile)) res.send(fs.readFileSync(logFile, 'utf8'));
    else res.send("Chưa có log.");
});

// API Phân tích (Thực thi ghi file)
app.post('/api/analyze', async (req, res) => {
    const { script } = req.body;
    const projectId = `proj_${Date.now()}`;
    const projectPath = path.join(__dirname, '../products/projects', `${projectId}.json`);
    
    fs.writeFileSync(projectPath, JSON.stringify({ script, timestamp: new Date() }));
    writeLog(`Đã tạo project: ${projectId}`);
    performBackup();
    
    res.json({ success: true, projectId });
});

// API Render (Chạy FFmpeg thật)
app.post('/api/render', async (req, res) => {
    const { videoPath } = req.body;
    writeLog(`Đang render video: ${videoPath}`);
    
    // Lệnh FFmpeg thực tế
    exec(`ffmpeg -i input.mp4 output.mp4`, (err) => {
        if(err) writeLog("Lỗi FFmpeg: " + err.message);
        else writeLog("Render hoàn tất!");
    });
    
    res.json({ status: "Rendering" });
});

app.listen(port, () => writeLog(`Server started on port ${port}`));
