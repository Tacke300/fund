// js/severdata.js

const express = require('express');
const path = require('path'); // << THÊM DÒNG NÀY
const db = require('./database.js');
const bcrypt = require('bcrypt');
const cors = require('cors');

const app = express();
const PORT = 80

// Middlewares
app.use(cors());
app.use(express.json());

// --- PHẦN SỬA ĐỔI QUAN TRỌNG ---
// Thay vì tìm thư mục 'public', chúng ta sẽ phục vụ file từ 2 nơi:

// 1. Phục vụ các file từ thư mục gốc của dự án (ví dụ: ~/fund)
//    path.join(__dirname, '..') sẽ trỏ từ '~/fund/js' ra thư mục cha là '~/fund'
app.use(express.static(path.join(__dirname, '..')));

// 2. Phục vụ các file từ thư mục 'html' (ví dụ: ~/fund/html)
app.use(express.static(path.join(__dirname, '..', 'html')));
// ------------------------------------

const saltRounds = 10;

// === API ENDPOINTS (Không thay đổi) ===

// 1. Endpoint để đăng ký
app.post('/register', (req, res) => {
    // ... code đăng ký giữ nguyên ...
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: "Username and password are required." });
    }

    bcrypt.hash(password, saltRounds, (err, hash) => {
        if (err) {
            return res.status(500).json({ message: "Error hashing password." });
        }

        const sql = `INSERT INTO users (username, password) VALUES (?, ?)`;
        db.run(sql, [username, hash], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    return res.status(409).json({ message: "Username already exists." });
                }
                return res.status(500).json({ message: "Database error.", error: err.message });
            }
            res.status(201).json({ message: "User registered successfully!", userId: this.lastID });
        });
    });
});

// 2. Endpoint để đăng nhập
app.post('/login', (req, res) => {
    // ... code đăng nhập giữ nguyên ...
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: "Username and password are required." });
    }

    const sql = `SELECT * FROM users WHERE username = ?`;
    db.get(sql, [username], (err, user) => {
        if (err) {
            return res.status(500).json({ message: "Database error." });
        }
        if (!user) {
            return res.status(401).json({ message: "Invalid credentials." });
        }

        bcrypt.compare(password, user.password, (err, result) => {
            if (result) {
                res.status(200).json({ message: "Login successful!" });
            } else {
                res.status(401).json({ message: "Invalid credentials." });
            }
        });
    });
});

// Khởi động server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
