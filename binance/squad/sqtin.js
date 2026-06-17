import express from 'express';
import Parser from 'rss-parser';
import axios from 'axios';
import cron from 'node-cron';

const app = express();
const PORT = 9999;
const parser = new Parser();

// --- CẤU HÌNH ---
const SQUAD_API_KEY = "8d794c11cc794c958c2c65924c54f2dd";
const SQUAD_ENDPOINT = "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add";

const RSS_SOURCES = [
    'https://cointelegraph.com/rss',
    'https://www.coindesk.com/arc/outboundfeeds/rss/',
    'https://cryptopotato.com/feed/'
];

const TAG_POOL = ["Crypto", "Bitcoin", "Trading", "Blockchain", "Binance", "DeFi", "Web3", "NFT", "AI"];

let isRunning = false;
let postCount = 0;
let logs = [];
let futuresList = ["BTC", "ETH"];

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    logs.unshift(`[${time}] ${msg}`);
    if (logs.length > 50) logs.pop();
    console.log(`[${time}] ${msg}`);
}

async function updateFuturesList() {
    try {
        const res = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
        futuresList = res.data.symbols.filter(s => s.symbol.endsWith('USDT')).map(s => s.symbol.replace('USDT', ''));
        addLog(`Đã tải ${futuresList.length} cặp coin.`);
    } catch (e) { addLog("Lỗi lấy danh sách coin!"); }
}
updateFuturesList();

async function runJob() {
    addLog("--- Bắt đầu quy trình quét ---");
    for (const source of RSS_SOURCES) {
        try {
            const feed = await parser.parseURL(source);
            if (!feed.items?.length) continue;

            const item = feed.items[0];
            const randomCoin = futuresList[Math.floor(Math.random() * futuresList.length)];
            const randomTags = [...TAG_POOL].sort(() => 0.5 - Math.random()).slice(0, 6);
            
            // Định dạng nội dung
            const content = `$${randomCoin}\n\n${item.title}\n\n${item.contentSnippet || ""}\n\n#${randomTags.join(' #')}\n\nNguồn: ${source}`;

            addLog(`Đang gửi bài: ${item.title.substring(0, 20)}...`);

            // --- ĐÂY LÀ CẤU TRÚC BẠN YÊU CẦU ---
            const response = await axios.post(SQUAD_ENDPOINT, {
                bodyTextOnly: content,
                symbolList: [{ symbol: `${randomCoin}USDT`, type: "FUTURES" }]
            }, { 
                headers: { 
                    "X-Square-OpenAPI-Key": SQUAD_API_KEY,
                    "Content-Type": "application/json"
                } 
            });

            addLog(`Kết quả: THÀNH CÔNG`);
            postCount++;
            break; 
        } catch (e) { 
            const err = e.response?.data?.message || e.message;
            addLog(`❌ LỖI: ${err}`);
        }
    }
}

const htmlControl = `
<!DOCTYPE html><html><body style="background:#1a1a1a; color:#00ff00; font-family:monospace; padding:20px;">
<h1>Bot Squad Control</h1>
<button onclick="fetch('/start').then(()=>location.reload())">START</button>
<button onclick="fetch('/stop').then(()=>location.reload())">STOP</button>
<button onclick="fetch('/test').then(()=>alert('Đã chạy test'))">TEST NGAY</button>
<p>Status: ${isRunning ? 'RUNNING' : 'OFF'} | Đã đăng: ${postCount}</p>
<div id="logs" style="background:#000; padding:10px; height:400px; overflow-y:scroll;"></div>
<script>
    setInterval(() => {
        fetch('/logs').then(r => r.json()).then(data => {
            document.getElementById('logs').innerHTML = data.join('<br>');
        });
    }, 2000);
</script>
</body></html>`;

app.get('/', (req, res) => res.send(htmlControl));
app.get('/logs', (req, res) => res.json(logs));
app.get('/start', (req, res) => { isRunning = true; addLog("Bot ĐÃ BẬT"); res.send("OK"); });
app.get('/stop', (req, res) => { isRunning = false; addLog("Bot ĐÃ TẮT"); res.send("OK"); });
app.get('/test', async (req, res) => { await runJob(); res.send("OK"); });

cron.schedule('*/15 * * * *', async () => {
    if (isRunning && postCount < 50) await runJob();
});

app.listen(PORT, () => console.log('Server running on port ' + PORT));
