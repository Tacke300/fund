const express = require('express');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/products', express.static(path.join(__dirname, '../products')));

// Ghi log chi tiết
const logStream = fs.createWriteStream(path.join(__dirname, '../logs/bot.log'), { flags: 'a' });
const writeLog = (msg) => {
    const entry = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
    logStream.write(entry);
};

app.post('/api/render', (req, res) => {
    const { script, style, resolution, watermark } = req.body;
    const jobId = `job_${Date.now()}`;
    
    writeLog(`Bắt đầu job ${jobId} | Resolution: ${resolution} | Style: ${style}`);
    
    // Câu lệnh FFmpeg thực tế với Watermark chạy chéo
    // watermark: { text: "Copyright", pos: "diagonal" }
    const cmd = `ffmpeg -i input.mp4 -vf "drawtext=text='${watermark.text}':x=w*mod(t/5,1):y=h*mod(t/5,1):fontsize=24:fontcolor=white" -s ${resolution} products/videos/${jobId}.mp4`;

    const process = spawn('ffmpeg', ['-i', 'input.mp4', '-vf', `drawtext=text='${watermark.text}':x=w*mod(t/5,1):y=h*mod(t/5,1)`, `products/videos/${jobId}.mp4`]);

    process.stderr.on('data', (data) => writeLog(`FFMPEG: ${data}`));
    process.on('close', (code) => {
        writeLog(`Job ${jobId} hoàn tất với mã: ${code}`);
    });

    res.json({ jobId, status: 'started' });
});

app.get('/api/logs', (req, res) => {
    res.send(fs.readFileSync(path.join(__dirname, '../logs/bot.log'), 'utf8'));
});

app.listen(3000, () => console.log('Server running on 3000'));
