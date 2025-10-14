const express = require('express');
const path = require('path');
const db = require('./database.js');
const cors = require('cors');
const fs = require('fs').promises;
const { exec } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);
const app = express();
const port = 3000;

let backupTimeout;
const DEBOUNCE_DELAY = 10000;

async function backupAndCommit() {
    const sourcePath = path.join(__dirname, 'user.db');
    const backupPath = path.join(__dirname, 'backup.db');
    const repoPath = path.join(__dirname, '..');

    console.log('Bắt đầu quá trình sao lưu và commit...');
    try {
        await fs.copyFile(sourcePath, backupPath);
        console.log('Đã sao chép user.db -> backup.db');

        const gitAddCmd = `git -C "${repoPath}" add "${backupPath}"`;
        const gitCommitCmd = `git -C "${repoPath}" commit -m "Auto-backup database: ${new Date().toISOString()}"`;
        const gitPushCmd = `git -C "${repoPath}" push`;

        console.log('Thực hiện git add...');
        await execPromise(gitAddCmd);

        console.log('Thực hiện git commit...');
        try {
            await execPromise(gitCommitCmd);
        } catch (commitError) {
            if (commitError.stdout.includes('nothing to commit')) {
                console.log('Không có thay đổi trong backup.db để commit.');
                return;
            }
            throw commitError;
        }
        
        console.log('Thực hiện git push...');
        await execPromise(gitPushCmd);

        console.log('Hoàn tất sao lưu và đẩy lên Git thành công!');
    } catch (error) {
        console.error('Đã xảy ra lỗi trong quá trình sao lưu và commit:', error.stderr || error.stdout || error);
    }
}

function runWithBackup(sql, params, callback) {
    db.run(sql, params, function(err) {
        if (callback) {
            callback.call(this, err);
        }
        if (!err) {
            console.log('Phát hiện thay đổi CSDL, đặt lại bộ đếm thời gian sao lưu...');
            clearTimeout(backupTimeout);
            backupTimeout = setTimeout(backupAndCommit, DEBOUNCE_DELAY);
        }
    });
}

app.use(cors());
app.use(express.json());

app.post('/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: "Username and password are required." });
    }
    const sql = `INSERT INTO users (username, password) VALUES (?, ?)`;
    runWithBackup(sql, [username, password], function(err) {
        if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(409).json({ message: "Username already exists." });
            }
            return res.status(500).json({ message: "Database error.", error: err.message });
        }
        res.status(201).json({ message: "User registered successfully!", userId: this.lastID });
    });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: "Username and password are required." });
    }
    const sql = `SELECT * FROM users WHERE username = ?`;
    db.get(sql, [username], (err, user) => {
        if (err) return res.status(500).json({ message: "Database error." });
        if (!user) return res.status(401).json({ message: "Invalid credentials." });
        if (password === user.password) {
            res.status(200).json({ message: "Login successful!" });
        } else {
            res.status(401).json({ message: "Invalid credentials." });
        }
    });
});

app.use(express.static(path.join(__dirname, '..')));
app.use(express.static(path.join(__dirname, '..', 'html')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'html', 'reg-log.html'));
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});```
