import express from 'express';
import Parser from 'rss-parser';
import axios from 'axios';
import cron from 'node-cron';

const app = express();
const PORT = 9999;
const parser = new Parser();

// CẤU HÌNH
const SQUAD_API_KEY = "8d794c11cc794c958c2c65924c54f2dd";
const SQUAD_ENDPOINT = "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add";

const RSS_SOURCES = [
    'https://cointelegraph.com/rss',
    'https://www.coindesk.com/arc/outboundfeeds/rss/',
    'https://cryptopotato.com/feed/'
];

// Bộ lọc từ khóa nhạy cảm (Cờ bạc, bạo lực, tôn giáo, chính trị, từ kích động)
const SENSITIVE_KEYWORDS = [
    /gambling/gi, /casino/gi, /betting/gi, /sex/gi, /porn/gi, /violence/gi, 
    /war/gi, /killing/gi, /god/gi, /religion/gi, /politics/gi, /illegal/gi, 
    /scam/gi, /pump/gi, /dump/gi, /attack/gi, /bloody/gi, /hate/gi
];

const ICONS = ["📈", "🚀", "💡", "🛡️", "💎", "✅", "⚡", "🔥", "📊"];

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

// Hàm làm sạch văn bản
function cleanContent(text) {
    // 1. Loại bỏ HTML tag và URL
    let clean = text.replace(/<[^>]*>/g, '').replace(/https?:\/\/\S+/g, '');
    
    // 2. Lọc từ nhạy cảm
    SENSITIVE_KEYWORDS.forEach(reg => {
        clean = clean.replace(reg, 'Crypto');
    });
    
    // 3. Thêm icon vào từng đoạn
    const lines = clean.split('\n').filter(line => line.trim() !== '');
    return lines.map(line => {
        const icon = ICONS[Math.floor(Math.random() * ICONS.length)];
        return `${icon} ${line}`;
    }).join('\n\n');
}

async function updateFuturesList() {
    try {
        const res = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
        futuresList = res.data.symbols.filter(s => s.symbol.endsWith('USDT')).map(s => s.symbol.replace('USDT', ''));
    } catch (e) { addLog("Lỗi lấy danh sách coin!"); }
}
updateFuturesList();

async function runJob() {
    for (const source of RSS_SOURCES) {
        try {
            const feed = await parser.parseURL(source);
            if (!feed.items?.length) continue;

            const item = feed.items[0];
            const randomCoin = futuresList[Math.floor(Math.random() * futuresList.length)];
            
            // Xử lý nội dung sạch
            const title = cleanContent(item.title);
            const snippet = cleanContent(item.contentSnippet || "");
            const fullContent = `$${randomCoin}\n\n${title}\n\n${snippet}\n\n#Crypto #Bitcoin #Trading #Binance #Blockchain #Market`;

            const response = await axios.post(SQUAD_ENDPOINT, {
                bodyTextOnly: fullContent,
                symbolList: [{ symbol: `${randomCoin}USDT`, type: "FUTURES" }]
            }, { 
                headers: { 
                    "X-Square-OpenAPI-Key": SQUAD_API_KEY,
                    "Content-Type": "application/json"
                } 
            });

            if (response.data.success) {
                addLog(`✅ Đăng thành công: ${randomCoin}`);
                postCount++;
                break; 
            }
        } catch (e) { 
            addLog(`❌ Lỗi: ${e.message}`);
        }
    }
}

// Giao diện điều khiển
const htmlControl = `
<!DOCTYPE html><html><body style="background:#121212; color:#0f0; font-family:monospace; padding:20px;">
<h1>Bot News Pro</h1>
<button onclick="fetch('/start').then(()=>location.reload())">START</button>
<button onclick="fetch('/stop').then(()=>location.reload())">STOP</button>
<p>Status: ${isRunning ? 'ON' : 'OFF'} | Đã đăng: ${postCount}</p>
<div id="logs" style="background:#000; border:1px solid #333; height:400px; overflow-y:scroll;"></div>
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
app.get('/start', (req, res) => { isRunning = true; addLog("Bot đã BẬT"); res.send("OK"); });
app.get('/stop', (req, res) => { isRunning = false; addLog("Bot đã TẮT"); res.send("OK"); });

cron.schedule('*/15 * * * *', async () => {
    if (isRunning && postCount < 50) await runJob();
});

app.listen(PORT, () => console.log('Server running on port ' + PORT));
