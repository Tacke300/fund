const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

app.post('/api/analyze', (req, res) => {
    const { script } = req.body;
    // Chia kịch bản thành các đoạn dựa trên dấu xuống dòng
    const scenes = script.split('\n').filter(line => line.trim() !== '');
    res.json({ scenes });
});

app.post('/api/render', (req, res) => {
    const { scenes, voice, resOption, watermark } = req.body;
    const jobId = `job_${Date.now()}`;
    
    // Command FFmpeg thật
    const args = [
        '-i', 'input.mp4',
        '-vf', `drawtext=text='${watermark}':x=10:y=10:fontsize=30,scale=${resOption.split('x')[0]}:-1`,
        `products/videos/${jobId}.mp4`
    ];

    const child = spawn('ffmpeg', args);
    child.stderr.on('data', (data) => {
        // Log tiến độ từ FFmpeg gửi về Frontend
        console.log(`Tiến độ ${jobId}: ${data}`);
    });

    res.json({ jobId, status: 'Đang render...' });
});

app.listen(3000, () => console.log('Server chạy cổng 3000'));
