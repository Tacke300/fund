const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 1111;

http.createServer((req, res) => {
    fs.readFile(path.join(__dirname, 'admin.html'), (err, data) => {
        if (err) {
            res.writeHead(500);
            return res.end('Khong tim thay file admin.html');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
    });
}).listen(PORT, () => {
    console.log(`Moncey Admin dang chay tai: http://localhost:${PORT}`);
});
