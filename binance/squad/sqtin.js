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
    'https://cryptopotato.com/feed/',
    'https://decrypt.co/feed',
    'http://feeds.reuters.com/Reuters/PoliticsNews',
    'https://feeds.bloomberg.com/markets/news.rss',
    'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10001147',
    'https://blockworks.co/feed',
    'https://www.investing.com/rss/news.rss',
    'https://feeds.bbci.co.uk/news/world/rss.xml'
];

const SENSITIVE_KEYWORDS = [/gambling/gi, /casino/gi, /betting/gi, /sex/gi, /porn/gi, /violence/gi, /war/gi, /killing/gi, /god/gi, /religion/gi, /politics/gi, /illegal/gi, /scam/gi, /pump/gi, /dump/gi, /attack/gi, /bloody/gi, /hate/gi];
const ICONS = ["📈", "🚀", "💡", "🛡️", "💎", "✅", "⚡", "🔥", "📊", "🌐"];

let isRunning = false;
let postCount = 0;
let logs = [];
let futuresList = ["BTC", "ETH"];
const postedTitles = new Set(); // Chống trùng lặp

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    logs.unshift(`[${time}] ${msg}`);
    if (logs.length > 50) logs.pop();
    console.log(`[${time}] ${msg}`);
}

function cleanContent(text) {
    let clean = text.replace(/<[^>]*>/g, '').replace(/https?:\/\/\S+/g, '');
    SENSITIVE_KEYWORDS.forEach(reg => { clean = clean.replace(reg, 'Crypto'); });
    const lines = clean.split('\n').filter(line => line.trim() !== '');
    return lines.map(line => `${ICONS[Math.floor(Math.random() * ICONS.length)]} ${line}`).join('\n\n');
}

async function updateFuturesList() {
    try {
        const res = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
        futuresList = res.data.symbols.filter(s => s.symbol.endsWith('USDT')).map(s => s.symbol.replace('USDT', ''));
    } catch (e) { addLog("Lỗi list coin!"); }
}
updateFuturesList();

async function runJob() {
    addLog("--- Bắt đầu quét 10 nguồn ---");
    for (const source of RSS_SOURCES) {
        try {
            const feed = await parser.parseURL(source);
            if (!feed.items?.length) continue;

            const item = feed.items[0];
            
            // Chống trùng lặp
            if (postedTitles.has(item.title)) {
                addLog(`Trùng tiêu đề, bỏ qua: ${item.title.substring(0, 15)}...`);
                continue;
            }

            const randomCoin = futuresList[Math.floor(Math.random() * futuresList.length)];
            const title = cleanContent(item.title);
            const snippet = cleanContent(item.contentSnippet || "");
            const fullContent = `$${randomCoin}\n\n${title}\n\n${snippet.substring(0, 200)}...\n\n#Crypto #Bitcoin #Trading #Binance #Market`;

            const response = await axios.post(SQUAD_ENDPOINT, {
                bodyTextOnly: fullContent,
                symbolList: [{ symbol: `${randomCoin}USDT`, type: "FUTURES" }]
            }, { 
                headers: { "X-Square-OpenAPI-Key": SQUAD_API_KEY, "Content-Type": "application/json" } 
            });

            if (response.data.success) {
                postedTitles.add(item.title); // Lưu vào bộ nhớ chống trùng
                if (postedTitles.size > 200) postedTitles.delete(postedTitles.values().next().value);
                addLog(`✅ Thành công: ${randomCoin} | ${item.title.substring(0, 10)}`);
                postCount++;
                return; 
            }
        } catch (e) { addLog(`❌ Lỗi ${source}: ${e.message}`); }
    }
}

const htmlControl = `
<!DOCTYPE html><html><body style="background:#121212; color:#0f0; font-family:monospace; padding:20px;">
<h1>Bot News Pro - 10 Sources</h1>
<div>
    <button onclick="fetch('/start').then(()=>location.reload())" style="padding:10px; background:green; color:white; cursor:pointer;">START & RUN</button>
    <button onclick="fetch('/stop').then(()=>location.reload())" style="padding:10px; background:red; color:white; cursor:pointer;">STOP</button>
    <button onclick="fetch('/test').then(()=>alert('Đang test...'))" style="padding:10px; background:yellow; cursor:pointer;">TEST NGAY</button>
</div>
<p>Status: ${isRunning ? 'ON' : 'OFF'} | Đã đăng: ${postCount}</p>
<div id="logs" style="background:#000; border:1px solid #333; height:400px; overflow-y:scroll; padding:10px;"></div>
<script>
    setInterval(() => {
        fetch('/logs').then(r => r.json()).then(data => {
            document.getElementById('logs').innerHTML = data.join('<br><hr>');
        });
    }, 2000);
</script>
</body></html>`;

app.get('/', (req, res) => res.send(htmlControl));
app.get('/logs', (req, res) => res.json(logs));
app.get('/start', (req, res) => { isRunning = true; addLog("Bot đã BẬT, chạy ngay..."); runJob(); res.send("OK"); });
app.get('/stop', (req, res) => { isRunning = false; addLog("Bot đã TẮT"); res.send("OK"); });
app.get('/test', async (req, res) => { await runJob(); res.send("OK"); });

cron.schedule('*/15 * * * *', async () => {
    if (isRunning && postCount < 50) await runJob();
});

app.listen(PORT, () => console.log('Server running on port ' + PORT));
