const express = require('express');
const cors = require('cors');
const app = express();
const { generateScript } = require('./services/kichban');
const { processVideo } = require('./services/vid');
const { generateVoice } = require('./services/audio');

app.use(cors());
app.use(express.json());

app.post('/api/analyze', async (req, res) => {
    const script = await generateScript(req.body.script);
    res.json({ success: true, data: script });
});

app.post('/api/render', async (req, res) => {
    processVideo();
    res.json({ message: "Rendering started" });
});

app.listen(3000, () => console.log('Backend running on port 3000'));
