const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

app.use(express.json());
let currentStatus = { task: "Idle", step: "Waiting...", progress: 0 };

const updateStatus = (task, step, progress) => {
    currentStatus = { task, step, progress };
    fs.writeFileSync('status.json', JSON.stringify(currentStatus));
};

app.get('/api/status', (req, res) => res.json(currentStatus));

app.post('/api/run', async (req, res) => {
    const { workName } = req.body;
    updateStatus(workName, "Initializing...", 10);
    
    // Logic vòng lặp chạy nền (không block res)
    (async () => {
        try {
            updateStatus(workName, "Git Pulling...", 20);
            execSync('git pull');
            
            // Giả lập vòng lặp AI
            updateStatus(workName, "AI Architecting...", 50);
            // ... (Code logic AI như cũ ở đây) ...
            
            updateStatus(workName, "Deploying via PM2...", 90);
            updateStatus(workName, "Completed", 100);
        } catch (e) {
            updateStatus(workName, "Error: " + e.message, 0);
        }
    })();

    res.json({ message: "Started" });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(7777, () => console.log('Engine running on 7777'));
