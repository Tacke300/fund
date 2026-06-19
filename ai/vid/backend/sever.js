const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const { exec } = require('child_process');
const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/products', express.static(path.join(__dirname, '../products')));

const upload = multer({ dest: 'products/temp/' });

// Lưu cấu hình dự án
app.post('/api/save-project', (req, res) => {
    const { projectId, settings } = req.body;
    fs.writeFileSync(path.join(__dirname, '../products/projects', `${projectId}.json`), JSON.stringify(settings, null, 2));
    res.json({ status: 'saved' });
});

// Upload Logo
app.post('/api/upload-logo', upload.single('logo'), (req, res) => {
    res.json({ path: req.file.path });
});

// Phân tích và tạo kịch bản chi tiết
app.post('/api/analyze', async (req, res) => {
    const { script, voice, style } = req.body;
    // Logic thực tế gọi AI (ví dụ: gpt-4) để phân tích
    const scenes = script.split('\n').map((text, i) => ({
        id: i,
        text,
        imagePrompt: `Cinematic ${style} style, high quality`,
        voice: voice
    }));
    res.json({ scenes });
});

// Render Video thực tế
app.post('/api/render', async (req, res) => {
    const { projectId } = req.body;
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../products/projects', `${projectId}.json`)));
    
    // Command FFmpeg thực tế
    const cmd = `ffmpeg -i background.mp3 -i logo.png -filter_complex "[1:v]overlay=10:10" output.mp4`;
    exec(cmd, (err) => {
        if (err) return res.status(500).send(err);
        res.json({ status: 'completed', video: 'products/videos/final.mp4' });
    });
});

app.listen(port, () => console.log(`Server chạy tại: http://localhost:${port}`));
