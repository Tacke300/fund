const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

let taskLogs = {}; // Lưu log theo từng Job ID

app.post('/api/render', (req, res) => {
    const { script, voice, type, resOption, watermark } = req.body;
    const jobId = `job_${Date.now()}`;
    taskLogs[jobId] = { status: 'Processing', logs: [], progress: 0 };

    console.log(`[${jobId}] Bắt đầu Render: ${type} - ${resOption}`);
    taskLogs[jobId].logs.push("Khởi tạo hệ thống...");

    // Lệnh FFmpeg thật - Chú ý: bạn cần file 'input.mp4' ở thư mục gốc
    const ffmpeg = spawn('ffmpeg', [
        '-i', 'input.mp4',
        '-vf', `drawtext=text='${watermark}':x=10:y=10:fontsize=24:fontcolor=white,scale=${resOption}`,
        '-y', `products/videos/${jobId}.mp4`
    ]);

    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        taskLogs[jobId].logs.push(msg);
        console.log(`[${jobId}] FFmpeg: ${msg}`);
    });

    ffmpeg.on('close', (code) => {
        taskLogs[jobId].status = code === 0 ? 'Done' : 'Error';
        taskLogs[jobId].logs.push(`Kết thúc với mã: ${code}`);
    });

    res.json({ jobId });
});

app.get('/api/status/:id', (req, res) => {
    res.json(taskLogs[req.params.id] || { status: 'Not Found' });
});

app.listen(3000, () => console.log('Server chạy trên cổng 3000'));
