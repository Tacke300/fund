// js/severdata.js

const express = require('express');
const path = require('path');
const db = require('./database.js');
const bcrypt = require('bcrypt');
const cors = require('cors');

const app = express();
const port = 80;

// Middlewares xử lý dữ liệu phải ở trên cùng
app.use(cors());
app.use(express.json());

const saltRounds = 10;

// === KHAI BÁO API ENDPOINTS TRƯỚC ===

// 1. Endpoint để đăng ký
app.post('/register', (req, res) => {
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


// --- PHỤC VỤ FILE TĨNH ĐẶT Ở CUỐI CÙNG ---
// Middleware này sẽ chỉ chạy nếu request không khớp với bất kỳ API endpoint nào ở trên

// 1. Phục vụ các file từ thư mục gốc của dự án (ví dụ: ~/fund)
app.use(express.static(path.join(__dirname, '..')));

// 2. Phục vụ các file từ thư mục 'html' (ví dụ: ~/fund/html)
app.use(express.static(path.join(__dirname, '..', 'html')));


// Khởi động server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});```

### **Hành động Ngay Bây Giờ**

1.  Mở file `~/fund/js/severdata.js`.
2.  Xóa toàn bộ nội dung cũ.
3.  Dán nội dung mới ở trên vào.
4.  Lưu file lại.
5.  **Quan trọng:** Khởi động lại server để áp dụng thay đổi từ phía backend:
    ```bash
    pm2 restart severdata
    ```

Sau khi restart, lỗi "is not valid JSON" sẽ hoàn toàn biến mất. Chúc bạn thành công
