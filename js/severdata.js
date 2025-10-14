const express = require('express');
const path = require('path');
const db = require('./database.js');
const bcrypt = require('bcrypt');
const cors = require('cors');

const app = express();
const port = 80;

// BƯỚC 1: Các middleware xử lý dữ liệu luôn ở trên cùng
app.use(cors());
app.use(express.json());

const saltRounds = 10;

// BƯỚC 2: Định nghĩa các API ENDPOINT ngay sau đó (ƯU TIÊN CAO NHẤT)

// Endpoint để đăng ký
app.post('/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: "Username and password are required." });
    }
    bcrypt.hash(password, saltRounds, (err, hash) => {
        if (err) return res.status(500).json({ message: "Error hashing password." });
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

// Endpoint để đăng nhập
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: "Username and password are required." });
    }
    const sql = `SELECT * FROM users WHERE username = ?`;
    db.get(sql, [username], (err, user) => {
        if (err) return res.status(500).json({ message: "Database error." });
        if (!user) return res.status(401).json({ message: "Invalid credentials." });
        bcrypt.compare(password, user.password, (err, result) => {
            if (result) {
                res.status(200).json({ message: "Login successful!" });
            } else {
                res.status(401).json({ message: "Invalid credentials." });
            }
        });
    });
});

// BƯỚC 3: Định nghĩa rõ ràng trang chủ (landing page)
// Khi người dùng vào thẳng domain (http://yourdomain.com), server sẽ gửi file này.
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
});


// BƯỚC 4: Phục vụ các file tĩnh khác (CSS, fundingbot.html...) - ĐẶT Ở CUỐI CÙNG
// Server sẽ tìm các file này trong thư mục gốc 'fund'
app.use(express.static(path.join(__dirname, '..')));


// Khởi động server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
