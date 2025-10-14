const express = require('express');
const path = require('path');
const db = require('./database.js');
// const bcrypt = require('bcrypt'); // <-- Không cần dùng nữa, có thể xóa dòng này
const cors = require('cors');

const app = express();
const port = 3000;

// 1. MIDDLEWARE CƠ BẢN
app.use(cors());
app.use(express.json());

// const saltRounds = 10; // <-- Không cần dùng nữa

// 2. CÁC API ENDPOINT
app.post('/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: "Username and password are required." });
    }

    // --- THAY ĐỔI Ở ĐÂY ---
    // Chúng ta không dùng bcrypt.hash nữa mà lưu trực tiếp mật khẩu
    const sql = `INSERT INTO users (username, password) VALUES (?, ?)`;
    // Thay vì dùng "hash", chúng ta dùng trực tiếp biến "password"
    db.run(sql, [username, password], function(err) {
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

        // --- THAY ĐỔI Ở ĐÂY ---
        // Thay vì dùng bcrypt.compare, chúng ta so sánh trực tiếp 2 chuỗi văn bản
        if (password === user.password) {
            res.status(200).json({ message: "Login successful!" });
        } else {
            res.status(401).json({ message: "Invalid credentials." });
        }
    });
});


// 3. PHỤC VỤ FILE TĨNH
app.use(express.static(path.join(__dirname, '..')));
app.use(express.static(path.join(__dirname, '..', 'html')));


// 4. ROUTE TRANG CHỦ
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'html', 'reg-log.html'));
});


// 5. KHỞI ĐỘNG SERVER
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
