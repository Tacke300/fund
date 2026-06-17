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

// Danh sách các hashtag hot, bot sẽ chọn random 6 cái từ đây
const TREND_TAGS = [
    "Crypto", "Bitcoin", "Trading", "Blockchain", "Altcoin", "Market", "News", "DeFi", "Web3", 
    "Binance", "Ethereum", "Bullish", "Bearish", "Investing", "DAO", "Metaverse", "NFT", 
    "Finance", "Economy", "YieldFarming", "Staking", "Wallet", "Regulation", "ETF"
];

let isRunning = false;
let postCount = 0;
let logs = []; // Lưu trữ log để hiển thị trên web
let futuresList = ["BTC", "ETH"]; // Mặc định nếu chưa load đc

// --- HÀM LOG ---
function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    logs.unshift(`[${time}] ${msg}`);
    if (logs.length > 20) logs.pop(); // Giữ 20 dòng gần nhất
    console.log(`[${time}] ${msg}`);
}

// --- TỰ ĐỘNG LẤY DANH SÁCH COIN TỪ BINANCE FUTURES ---
async function updateFuturesList() {
    try {
        const res = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
        futuresList = res.data.symbols
            .filter(s => s.symbol.endsWith('USDT'))
            .map(s => s.symbol.replace('USDT', ''));
        addLog(`Đã cập nhật ${futuresList.length} cặp coin từ Binance.`);
    } catch (e) {
        addLog("Lỗi lấy danh sách coin từ Binance!");
    }
}
updateFuturesList();

// --- QUY TRÌNH ĐĂNG BÀI ---
async function runJob() {
    addLog("Bắt đầu chu kỳ quét tin...");
    for (const source of RSS_SOURCES) {
        try {
            const feed = await parser.parseURL(source);
            if (!feed.items?.length) continue;

            const item = feed.items[0];
            const randomCoin = futuresList[Math.floor(Math.random() * futuresList.length)];
            const randomTags = [...TREND_TAGS].sort(() => 0.5 - Math.random()).slice(0, 6);

            const content = `$${randomCoin}\n\n${item.title}\n\n${item.contentSnippet || ""}\n\n#${randomTags.join(' #')}\n\nNguồn: ${source}`;

            const response = await axios.post(SQUAD_ENDPOINT, {
                content: content,
                apiKey: SQUAD_API_KEY
            }, { timeout: 15000, headers: { 'Content-Type': 'application/json' } });

            if (response.status === 200) {
                postCount++;
                addLog(`Đăng thành công: ${item.title.substring(0, 20)}... ($${randomCoin})`);
                break; // Xong 1 bài thì nghỉ
            }
        } catch (e) { 
            addLog(`Lỗi tại ${source}: ${e.message}`); 
        }
    }
}

// --- GIAO DIỆN HTML (LOG TRỰC TIẾP) ---
const htmlControl = `
<!DOCTYPE html><html><body style="background:#121212; color:white; font-family:monospace; padding:20px;">
<h1>Bot News Control</h1>
<button onclick="fetch('/start').then(()=>location.reload())">START</button>
<button onclick="fetch('/stop').then(()=>location.reload())">STOP</button>
<button onclick="fetch('/test').then(()=>alert('Đã chạy xong!'))">TEST NHANH</button>
<p>Status: ${isRunning ? 'ON' : 'OFF'} | Đã đăng: ${postCount}</p>
<div id="logs" style="background:#000; padding:10px; border:1px solid #333; height:300px; overflow-y:scroll;"></div>
<script>
    setInterval(() => {
        fetch('/logs').then(r => r.json()).then(data => {
            document.getElementById('logs').innerHTML = data.join('<br>');
        });
    }, 2000);
</script>
</body></html>`;

// --- ROUTING ---
app.get('/', (req, res) => res.send(htmlControl));
app.get('/logs', (req, res) => res.json(logs));
app.get('/start', (req, res) => { isRunning = true; addLog("Bot đã BẬT"); res.send("OK"); });
app.get('/stop', (req, res) => { isRunning = false; addLog("Bot đã TẮT"); res.send("OK"); });
app.get('/test', async (req, res) => { await runJob(); res.send("OK"); });

// --- CRON ---
cron.schedule('*/15 * * * *', async () => {
    if (isRunning && postCount < 50) await runJob();
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
