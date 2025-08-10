const express = require('express');
const path = require('path');
const app = express();
const port = 4000;

let forcedResult = null; // null = random, 't' = tài, 'x' = xỉu

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// API cho bot lấy kết quả
app.get('/get-result', (req, res) => {
    if (forcedResult) {
        res.json({ force: true, result: forcedResult });
        forcedResult = null; // reset sau khi BOT lấy xong
    } else {
        res.json({ force: false });
    }
});

// API để lưu kết quả từ form
app.post('/set-result', (req, res) => {
    const val = req.body.result;
    if (val === 't' || val === 'x') {
        forcedResult = val;
    } else {
        forcedResult = null;
    }
    res.redirect('/');
});

app.listen(port, () => {
    console.log(`Server HTML chạy tại http://localhost:${port}`);
});
