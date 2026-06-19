const express = require('express');
const app = express();
const kichban = require('./services/kichban');
const audio = require('./services/audio');
const vid = require('./services/vid');

app.use(express.json());
app.use(express.static('../frontend'));

// API Phân tích
app.post('/api/analyze', (req, res) => {
    const scenes = kichban.xuLy(req.body.script);
    res.json({ scenes });
});

// API Render
app.post('/api/render', async (req, res) => {
    const { script, watermark } = req.body;
    try {
        const audioFile = await audio.taoFile(script);
        await vid.render(audioFile, `final_${Date.now()}.mp4`, watermark, (percent) => {
            console.log(`Render progress: ${percent}%`);
        });
        res.json({ status: 'Success' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(3000, () => console.log('Server live: http://localhost:3000'));
