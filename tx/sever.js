const express = require('express');
const app = express();
const port = 3002;

let forcedResult = null; // null = không ép, 't' = Tài, 'x' = Xỉu

app.use(express.urlencoded({ extended: true }));

// API cho bot
app.get('/get-result', (req, res) => {
    if (forcedResult) {
        res.json({ force: true, result: forcedResult });
        forcedResult = null; // dùng xong thì reset
    } else {
        res.json({ force: false });
    }
});

// Trang admin
app.get('/', (req, res) => {
    res.send(`
        <h1>Điều khiển kết quả</h1>
        <form method="POST" action="/set">
            <select name="result">
                <option value="">-- Random --</option>
                <option value="t">Tài (11-17)</option>
                <option value="x">Xỉu (4-10)</option>
            </select>
            <button type="submit">Lưu</button>
        </form>
        <p>Kết quả đang ép: ${forcedResult || '(Random)'}</p>
    `);
});

// Lưu kết quả
app.post('/set', (req, res) => {
    const val = req.body.result;
    if (val === 't' || val === 'x') {
        forcedResult = val;
    } else {
        forcedResult = null;
    }
    res.redirect('/');
});

app.listen(port, () => {
    console.log(`Server điều khiển chạy tại http://localhost:${port}`);
});
