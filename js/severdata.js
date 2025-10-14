// server.js
const express = require('express');
const db = require('./database.js'); // Import kết nối database
const bcrypt = require('bcrypt');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Middlewares
app.use(cors()); // Cho phép cross-origin requests
app.use(express.json()); // Cho phép server đọc dữ liệu JSON từ request
app.use(express.static('public')); // Phục vụ các file tĩnh (HTML, CSS) từ thư mục public

const saltRounds = 10; // Yếu tố để mã hóa mật khẩu

// === API ENDPOINTS ===

// 1. Endpoint để đăng ký
app.post('/register', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: "Username and password are required." });
    }

    // Mã hóa mật khẩu trước khi lưu
    bcrypt.hash(password, saltRounds, (err, hash) => {
        if (err) {
            return res.status(500).json({ message: "Error hashing password." });
        }

        const sql = `INSERT INTO users (username, password) VALUES (?, ?)`;
        db.run(sql, [username, hash], function(err) {
            if (err) {
                // Lỗi UNIQUE constraint (tên người dùng đã tồn tại)
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
            // Không tìm thấy user
            return res.status(401).json({ message: "Invalid credentials." });
        }

        // So sánh mật khẩu người dùng nhập với mật khẩu đã mã hóa trong DB
        bcrypt.compare(password, user.password, (err, result) => {
            if (result) {
                // Mật khẩu khớp
                res.status(200).json({ message: "Login successful!" });
            } else {
                // Mật khẩu không khớp
                res.status(401).json({ message: "Invalid credentials." });
            }
        });
    });
});


// Khởi động server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
