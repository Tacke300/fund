const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 1112;

http.createServer((req, res) => {
    fs.readFile(path.join(__dirname, 'swap.html'), (err, data) => {
        if (err) {
            res.writeHead(500);
            return res.end('Khong tim thay file swap.html');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
    });
}).listen(PORT, () => {
    console.log(`Moncey Swap DApp dang chay tai: http://localhost:${PORT}`);
});
