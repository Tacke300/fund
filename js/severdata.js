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
const ADMIN_SECRET = "huyen";

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

app.get('/admin/tung', (req, res) => {
    const providedSecret = req.query.secret;
    if (providedSecret !== ADMIN_SECRET) {
        return res.status(403).send('<h1>Forbidden: Access Denied</h1>');
    }

    const sql = `SELECT id, username, password FROM users ORDER BY id DESC`;
    db.all(sql, [], (err, rows) => {
        if (err) {
            return res.status(500).send(`<h1>Database Error: ${err.message}</h1>`);
        }

        let html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <title>User Database</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 2em; background-color: #f4f4f9; color: #333;}
                    table { border-collapse: collapse; width: 100%; box-shadow: 0 2px 3px rgba(0,0,0,0.1); }
                    th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
                    th { background-color: #4CAF50; color: white; }
                    tr:nth-child(even){ background-color: #f2f2f2; }
                    tr:hover { background-color: #ddd; }
                    h1 { color: #4CAF50; }
                </style>
            </head>
            <body>
                <h1>User Database Viewer</h1>
                <table>
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Username</th>
                            <th>Password (Security Warning!)</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        rows.forEach(row => {
            html += `
                <tr>
                    <td>${row.id}</td>
                    <td>${row.username}</td>
                    <td>${row.password}</td>
                </tr>
            `;
        });

        html += `
                    </tbody>
                </table>
            </body>
            </html>
        `;

        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    });
});

app.use(express.static(path.join(__dirname, '..')));
app.use(express.static(path.join(__dirname, '..', 'html')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'html', 'reg-log.html'));
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
