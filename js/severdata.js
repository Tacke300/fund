const express = require('express');
const path = require('path');
const db = require('./database.js');
const cors = require('cors');
const fs = require('fs').promises; // Sử dụng fs.promises để xử lý bất đồng bộ
const { exec } = require('child_process'); // Để thực thi lệnh shell
const util = require('util'); // Để "promisify" hàm exec

const execPromise = util.promisify(exec); // Chuyển exec thành dạng Promise

const app = express();
const port = 3000;

// BIẾN TOÀN CỤC CHO DEBOUNCING
let backupTimeout;
const DEBOUNCE_DELAY = 10000; // Chờ 10 giây sau thay đổi cuối cùng

// HÀM SAO LƯU VÀ ĐẨY LÊN GIT
async function backupAndCommit() {
    const sourcePath = path.join(__dirname, 'user.db');
    const backupPath = path.join(__dirname, 'backup.db');
    // Đường dẫn đến thư mục gốc của repo Git (đi ngược lên một cấp từ /js)
    const repoPath = path.join(__dirname, '..');

    console.log('Bắt đầu quá trình sao lưu và commit...');

    try {
        // 1. Sao chép file
        await fs.copyFile(sourcePath, backupPath);
        console.log('Đã sao chép user.db -> backup.db');

        // 2. Chạy các lệnh Git
        // Sử dụng cờ -C để chỉ định thư mục làm việc cho Git, và đặt đường dẫn trong dấu ngoặc kép để xử lý các trường hợp có dấu cách
        const gitAddCmd = `git -C "${repoPath}" add "${backupPath}"`;
        const gitCommitCmd = `git -C "${repoPath}" commit -m "Auto-backup database: ${new Date().toISOString()}"`;
        const gitPushCmd = `git -C "${repoPath}" push`;

        console.log('Thực hiện git add...');
        await execPromise(gitAddCmd);

        console.log('Thực hiện git commit...');
        // commit có thể thất bại nếu không có gì thay đổi, chúng ta cần bắt lỗi này một cách nhẹ nhàng
        try {
            await execPromise(gitCommitCmd);
        } catch (commitError) {
            // Nếu lỗi là do không có gì để commit, thì bỏ qua và tiếp tục
            if (commitError.stdout.includes('nothing to commit')) {
                console.log('Không có thay đổi trong backup.db để commit.');
                return; // Dừng hàm lại vì không cần push
            }
            // Nếu là lỗi khác, thì ném lỗi đó ra để khối catch bên ngoài xử lý
            throw commitError;
        }
        
        console.log('Thực hiện git push...');
        await execPromise(gitPushCmd);

        console.log('Hoàn tất sao lưu và đẩy lên Git thành công!');

    } catch (error) {
        // Ghi lại lỗi chi tiết hơn từ stderr (standard error) của tiến trình
        console.error('Đã xảy ra lỗi trong quá trình sao lưu và commit:', error.stderr || error.stdout || error);
    }
}

// HÀM WRAPPER ĐỂ GỌI DB.RUN VÀ KÍCH HOẠT SAO LƯU
function runWithBackup(sql, params, callback) {
    db.run(sql, params, function(err) {
        // Gọi callback gốc (nếu có) để trả về response cho client
        if (callback) {
            callback.call(this, err);
        }

        // Nếu việc ghi vào CSDL thành công, kích hoạt cơ chế debounce
        if (!err) {
            console.log('Phát hiện thay đổi CSDL, đặt lại bộ đếm thời gian sao lưu...');
            clearTimeout(backupTimeout); // Hủy bỏ timer cũ nếu có
            backupTimeout = setTimeout(backupAndCommit, DEBOUNCE_DELAY); // Đặt một timer mới
        }
    });
}


// --- CẤU HÌNH EXPRESS SERVER ---

// 1. MIDDLEWARE CƠ BẢN
app.use(cors());
app.use(express.json());


// 2. CÁC API ENDPOINT
app.post('/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: "Username and password are required." });
    }

    const sql = `INSERT INTO users (username, password) VALUES (?, ?)`;

    // SỬ DỤNG HÀM WRAPPER MỚI THAY VÌ db.run gốc
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

// Endpoint login không cần thay đổi vì nó chỉ đọc dữ liệu
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: "Username and password are required." });
    }
    const sql = `SELECT * FROM users WHERE username = ?`;
    db.get(sql, [username], (err, user) => {
        if (err) return res.status(500).json({ message: "Database error." });
        if (!user) return res.status(401).json({ message: "Invalid credentials." });

        // So sánh mật khẩu văn bản thường
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
