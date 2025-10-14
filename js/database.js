const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./user.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        return console.error("Lỗi khi kết nối đến CSDL", err.message);
    }
    console.log("Kết nối CSDL thành công.");

    db.serialize(() => {
        // Bước 1: Luôn tạo bảng nếu nó chưa tồn tại với cấu trúc cơ bản nhất
        const createTableSql = `
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password TEXT NOT NULL
            );
        `;
        db.run(createTableSql, (err) => {
            if (err) return console.error("Lỗi khi tạo bảng 'users'", err.message);
            console.log("Bảng 'users' đã sẵn sàng.");

            // Bước 2: Bắt đầu quá trình "Migration" (Thêm cột nếu thiếu)
            const columnsToAdd = [
                { name: 'binance_apikey', type: 'TEXT' },
                { name: 'binance_secret', type: 'TEXT' },
                { name: 'binance_password', type: 'TEXT' },
                { name: 'bitget_apikey', type: 'TEXT' },
                { name: 'bitget_secret', type: 'TEXT' },
                { name: 'bitget_password', type: 'TEXT' },
                { name: 'okx_apikey', type: 'TEXT' },
                { name: 'okx_secret', type: 'TEXT' },
                { name: 'okx_password', type: 'TEXT' },
                { name: 'kucoin_apikey', type: 'TEXT' },
                { name: 'kucoin_secret', type: 'TEXT' },
                { name: 'kucoin_password', type: 'TEXT' },
                { name: 'total_pnl', type: 'REAL' }, // REAL dùng cho số có dấu phẩy
                { name: 'usdt', type: 'REAL' }
            ];

            // Lấy thông tin các cột hiện có của bảng 'users'
            db.all("PRAGMA table_info(users)", (err, existingColumns) => {
                if (err) return console.error("Lỗi khi lấy thông tin bảng", err.message);

                const existingColumnNames = existingColumns.map(col => col.name);

                // Lặp qua các cột chúng ta muốn thêm
                columnsToAdd.forEach(column => {
                    // Nếu cột chưa tồn tại, thì thêm nó vào
                    if (!existingColumnNames.includes(column.name)) {
                        const addColumnSql = `ALTER TABLE users ADD COLUMN ${column.name} ${column.type}`;
                        db.run(addColumnSql, (err) => {
                            if (err) {
                                console.error(`Lỗi khi thêm cột '${column.name}':`, err.message);
                            } else {
                                console.log(`Đã thêm cột '${column.name}' vào bảng 'users'.`);
                            }
                        });
                    }
                });
            });
        });
    });
});

module.exports = db;
