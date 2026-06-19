const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const gTTS = require('gtts'); // Dùng Google TTS để tạo giọng thật
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/products', express.static(path.join(__dirname, '../products')));

let tasks = [];

// API Tạo Voice Thật
app.post('/api/generate-voice', (req, res) => {
    const { text, voiceId } = req.body; // voiceId từ 1-20
    const filePath = `products/audio/voice_${Date.now()}.mp3`;
    
    // gTTS tạo file .mp3 thật từ văn bản
    const gtts = new gTTS(text, 'vi');
    gtts.save(filePath, (err) => {
        if(err) res.status(500).send("Lỗi tạo giọng");
        else res.json({ path: filePath });
    });
});

// API Render Video Thật
app.post('/api/render', (req, res) => {
    const { script, voicePath, type, resolution, watermark } = req.body;
    const jobId = `job_${Date.now()}`;
    
    tasks.push({ id: jobId, status: 'Processing' });

    // Lệnh FFmpeg thật: Overlay watermark + Encode video
    const output = `products/videos/${jobId}.mp4`;
    const ffmpeg = spawn('ffmpeg', [
        '-i', 'input.mp4', // Bạn cần file nguồn input.mp4 ở thư mục gốc
        '-vf', `drawtext=text='${watermark}':x=10:y=10:fontsize=24:fontcolor=white,scale=${resolution.split('x')[0]}:-1`,
        '-c:a', 'copy',
        output
    ]);

    ffmpeg.on('close', () => {
        const task = tasks.find(t => t.id === jobId);
        if(task) task.status = 'Done';
    });

    res.json({ jobId });
});

app.get('/api/tasks', (req, res) => res.json(tasks));

app.listen(3000, () => console.log('Server chạy tại http://localhost:3000'));
