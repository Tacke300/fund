const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const kichban = require('./services/kichban');
const vid = require('./services/vid');

app.use(express.json());
// Cho phép trình duyệt truy cập thư mục frontend và products
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/products', express.static(path.join(__dirname, '../products')));

app.post('/api/analyze', (req, res) => {
    const scenes = kichban.xuLy(req.body.script);
    res.json({ scenes });
});

app.post('/api/render', async (req, res) => {
    const { script, voice, style, resOption, watermark } = req.body;
    const outputName = `video_${Date.now()}.mp4`;

    try {
        // Gọi service render video
        await vid.render({ resOption, watermark }, outputName, (percent) => {
            console.log(`[Tiến độ Render]: ${percent}%`);
        });
        
        // Trả về đường dẫn file sau khi xong
        res.json({ status: 'Success', videoUrl: `/products/videos/${outputName}` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(3000, () => console.log('Server chạy cổng 3000'));
