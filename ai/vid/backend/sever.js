const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const os = require('os');
const { exec } = require('child_process');
const app = express();
const port = 3000;

// Services
const kichban = require('./services/kichban');
const audio = require('./services/audio');
const music = require('./services/audiobackground');
const vid = require('./services/vid');

app.use(cors());
app.use(express.json());

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

// Cấu trúc thư mục
const dirs = [
    'products/videos', 'products/images', 'products/audio', 
    'products/background', 'products/subtitles', 'products/projects', 
    'products/temp', 'logs'
];

dirs.forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// API Routes
app.get('/api/system', (req, res) => {
    res.json({
        cpu: os.loadavg()[0] * 10,
        ram: ((os.totalmem() - os.freemem()) / os.totalmem()) * 100,
        gpu: 45,
        disk: 20
    });
});

app.post('/api/analyze', async (req, res) => {
    const result = await kichban.parse(req.body.script);
    // Lưu project và backup
    fs.writeFileSync(path.join('products/projects', `proj_${Date.now()}.json`), JSON.stringify(result));
    autoBackup();
    res.json(result);
});

app.post('/api/generate-audio', async (req, res) => {
    const result = await audio.create(req.body);
    autoBackup();
    res.json(result);
});

app.post('/api/render', async (req, res) => {
    const result = await vid.renderFinal(req.body);
    autoBackup();
    res.json(result);
});

app.listen(port, () => console.log(`Server running on port ${port}`));
