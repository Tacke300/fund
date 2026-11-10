import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    console.log(`Moncey Swap dang chay tai: http://localhost:${PORT}`);
});
