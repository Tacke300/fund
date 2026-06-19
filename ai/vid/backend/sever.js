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

// Hàm ghi log chi tiết
const logAction = (action, details) => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ACTION: ${action} | DETAILS: ${JSON.stringify(details)}\n`;
    fs.appendFileSync(path.join(__dirname, '../logs/bot.log'), logMessage);
    console.log(logMessage);
};

// API lấy Log
app.get('/api/logs', (req, res) => {
    const logData = fs.readFileSync(path.join(__dirname, '../logs/bot.log'), 'utf8');
    res.send(logData);
});

// API Hệ thống (Dashboard)
app.get('/api/system', (req, res) => {
    const stats = {
        cpu: os.loadavg()[0] * 10,
        ram: ((os.totalmem() - os.freemem()) / os.totalmem()) * 100,
        gpu: 45,
        disk: 25
    };
    res.json(stats);
});

app.post('/api/analyze', async (req, res) => {
    const { script } = req.body;
    logAction('ANALYZE_SCRIPT', { scriptLength: script.length });
    
    // Giả lập xử lý
    const result = { scenes: [{title: "Scene 1", content: "AI bắt đầu phân tích..."}] };
    res.json(result);
});

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
