// database.js
const sqlite3 = require('sqlite3').verbose();

// Tạo hoặc kết nối đến file user.db
const db = new sqlite3.Database('./user.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error("Error when creating the database", err.message);
    } else {
        console.log("Database connected successfully.");
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
                console.error("Error creating table", err.message);
            } else {
                console.log("Table 'users' is ready.");
            }
        });
    }
});

module.exports = db;
