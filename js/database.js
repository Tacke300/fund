// database.js
const sqlite3 = require('sqlite3').verbose();

// Tạo hoặc kết nối đến tệp user.db
const db = new sqlite3.Database('./user.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error("Lỗi khi tạo cơ sở dữ liệu", err.message);
    } else {
        console.log("Kết nối cơ sở dữ liệu thành công.");
        // Lệnh SQL để tạo bảng users nếu nó chưa tồn tại
        const createTableSql = `
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password TEXT NOT NULL
            );
        `;
        db.run(createTableSql, (err) => {
            if (err) {
                console.error("Lỗi khi tạo bảng", err.message);
            } else {
                console.log("Bảng 'users' đã sẵn sàng.");
            }
        });
    }
});

// Hàm để lấy và hiển thị mật khẩu của người dùng
function getUserPassword(username) {
    const sql = `SELECT password FROM users WHERE username = ?`;
    db.get(sql, [username], (err, row) => {
        if (err) {
            return console.error("Lỗi khi truy vấn người dùng:", err.message);
        }
        if (row) {
            console.log(`Mật khẩu cho người dùng '${username}' là: ${row.password}`);
        } else {
            console.log(`Không tìm thấy người dùng có tên '${username}'.`);
        }
    });
}

// Ví dụ về cách chèn người dùng mới
const insertSql = `INSERT INTO users (username, password) VALUES (?, ?)`;
db.run(insertSql, ['user', 'password123'], function(err) {
    if (err) {
        // Lỗi này sẽ xảy ra nếu bạn chạy lại file vì username là duy nhất
        return console.error("Lỗi khi chèn người dùng:", err.message);
    }
    console.log(`Một hàng đã được chèn với rowid ${this.lastID}`);
    // Gọi hàm để hiển thị mật khẩu sau khi chèn
    getUserPassword('user');
});

module.exports = db;
