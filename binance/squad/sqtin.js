import express from 'express';
import Parser from 'rss-parser';
import axios from 'axios';
import cron from 'node-cron';
import * as cheerio from 'cheerio';

const app = express();
const PORT = 9999;

// Cấu hình Parser với timeout cực nhanh
const parser = new Parser({
    timeout: 5000, 
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
});

const SQUAD_API_KEY = "8d794c11cc794c958c2c65924c54f2dd";
const SQUAD_ENDPOINT = "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add";

// Chỉ giữ những nguồn chạy ổn định nhất
const RSS_SOURCES = [
    'https://cointelegraph.com/rss',
    'https://www.coindesk.com/arc/outboundfeeds/rss/',
    'https://cryptopotato.com/feed/',
    'https://decrypt.co/feed',
    'https://blockworks.co/feed',
    'https://www.investing.com/rss/news.rss'
];

let isRunning = false;
let postCount = 0;
let logs = [];
const postedTitles = new Set();
const blacklistedSources = new Set(); // Danh sách nguồn "cút"

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] ${msg}`;
    logs.unshift(entry);
    if (logs.length > 50) logs.pop();
    console.log(entry);
}

function renderHTML() {
    return `
    <!DOCTYPE html><html><body style="background:#121212; color:#0f0; font-family:monospace; padding:20px;">
    <h1>Bot News Pro - ${isRunning ? 'RUNNING' : 'STOPPED'}</h1>
    <div>
        <button onclick="fetch('/start').then(()=>location.reload())" style="padding:15px; background:green; color:white; cursor:pointer;">START</button>
        <button onclick="fetch('/stop').then(()=>location.reload())" style="padding:15px; background:red; color:white; cursor:pointer;">STOP</button>
        <button onclick="fetch('/test').then(()=>location.reload())" style="padding:15px; background:yellow; color:black; cursor:pointer;">TEST NGAY</button>
    </div>
    <p>Đã đăng: ${postCount}/60 | Nguồn lỗi bị cấm: ${blacklistedSources.size}</p>
    <div id="logs" style="background:#000; border:1px solid #333; height:400px; overflow-y:scroll; padding:10px;"></div>
    <script>
        setInterval(() => {
            fetch('/logs').then(r => r.json()).then(data => {
                document.getElementById('logs').innerHTML = data.join('<br><hr>');
            });
        }, 2000);
    </script>
    </body></html>`;
}

async function getFullContent(url) {
    try {
        const { data } = await axios.get(url, { 
            timeout: 5000, // Timeout cào web 5s
            headers: { 'User-Agent': 'Mozilla/5.0' } 
        });
        const $ = cheerio.load(data);
        $('script, style, nav, footer, header, .ads, .sidebar').remove();
        let content = '';
        $('p').each((i, el) => {
            let text = $(el).text().trim();
            if (text.length > 30) content += text + '\n\n';
        });
        return content;
    } catch (e) { return null; }
}

async function runJob() {
    if (postCount >= 60) return;

    addLog(`--- Quét nhanh... ---`);
    for (const source of RSS_SOURCES) {
        if (blacklistedSources.has(source)) continue; // Bỏ qua nguồn đã cấm

        try {
            const feed = await parser.parseURL(source);
            if (!feed.items?.length) continue;
            
            const item = feed.items.find(i => !postedTitles.has(i.title));
            if (!item) continue;

            const content = await getFullContent(item.link);
            if (!content || content.length < 500) continue;

            const fullPost = `**${item.title.toUpperCase()}**\n\n${content.substring(0, 1800)}\n\n#Crypto #Bitcoin #Trading #Binance`;
            
            const payload = {
                title: item.title.substring(0, 80),
                bodyTextOnly: fullPost,
                symbolList: [{ symbol: "BTCUSDT", type: "FUTURES" }]
            };

            const response = await axios.post(SQUAD_ENDPOINT, payload, { 
                headers: { "X-Square-OpenAPI-Key": SQUAD_API_KEY, "Content-Type": "application/json" },
                timeout: 5000 
            });

            if (response.data.success) {
                postedTitles.add(item.title);
                postCount++;
                addLog(`✅ Đăng ${postCount}/60: ${item.title.substring(0, 15)}...`);
                return; 
            }
        } catch (e) { 
            addLog(`❌ CẤM ${source.split('/')[2]}: ${e.message}`); 
            blacklistedSources.add(source); // Cho cút
        }
    }
}

app.get('/', (req, res) => res.send(renderHTML()));
app.get('/logs', (req, res) => res.json(logs));
app.get('/start', (req, res) => { isRunning = true; addLog("Bật bot"); runJob(); res.send("OK"); });
app.get('/stop', (req, res) => { isRunning = false; addLog("Tắt bot"); res.send("OK"); });
app.get('/test', async (req, res) => { await runJob(); res.send("OK"); });

cron.schedule('*/25 * * * *', async () => {
    if (isRunning && postCount < 60) await runJob();
});

app.listen(PORT, () => console.log('Server running on port ' + PORT));
