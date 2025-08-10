const express = require('express');
const fetch = require('node-fetch');
const app = express();
const port = 3000;

app.use(express.static('public'));

// API random hoặc lấy từ server
app.get('/play', async (req, res) => {
    try {
        // Hỏi server
        const serverRes = await fetch('http://localhost:4000/get-result');
        const serverData = await serverRes.json();

        let d1, d2, d3, sum, result;

        if (serverData.force) {
            // Server ép kết quả
            result = serverData.result;
            ({ d1, d2, d3, sum } = generateDice(result));
        } else {
            // Random bình thường
            d1 = rnd();
            d2 = rnd();
            d3 = rnd();
            sum = d1 + d2 + d3;
            result = (sum >= 11 && sum <= 17) ? 't' : 'x';
        }

        res.json({ d1, d2, d3, sum, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function rnd() {
    return Math.floor(Math.random() * 6) + 1;
}

function generateDice(target) {
    while (true) {
        let d1 = rnd();
        let d2 = rnd();
        let d3 = rnd();
        let sum = d1 + d2 + d3;
        if (target === 't' && sum >= 11 && sum <= 17) return { d1, d2, d3, sum };
        if (target === 'x' && sum >= 4 && sum <= 10) return { d1, d2, d3, sum };
    }
}

app.listen(port, () => {
    console.log(`BOT chạy tại http://localhost:${port}`);
});
