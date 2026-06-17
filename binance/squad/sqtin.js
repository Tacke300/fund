import express from 'express';
import Parser from 'rss-parser';
import axios from 'axios';
import cron from 'node-cron';
import * as cheerio from 'cheerio';

const app = express();
const PORT = 9999;
const parser = new Parser();

const SQUAD_API_KEY = "8d794c11cc794c958c2c65924c54f2dd";
const SQUAD_ENDPOINT = "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add";

const RSS_SOURCES = [
    'https://cointelegraph.com/rss', 'https://www.coindesk.com/arc/outboundfeeds/rss/',
    'https://cryptopotato.com/feed/', 'https://decrypt.co/feed',
    'https://feeds.bloomberg.com/markets/news.rss',
    'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10001147',
    'https://blockworks.co/feed', 'https://www.investing.com/rss/news.rss',
    'https://feeds.bbci.co.uk/news/world/rss.xml'
];

const ICONS = ["📈", "🚀", "💡", "🛡️", "💎", "✅", "⚡", "🔥", "📊", "🌐"];
const SENSITIVE_KEYWORDS = [/gambling/gi, /casino/gi, /betting/gi, /sex/gi, /porn/gi, /violence/gi, /war/gi, /killing/gi, /god/gi, /religion/gi, /politics/gi, /illegal/gi, /scam/gi, /pump/gi, /dump/gi, /attack/gi, /bloody/gi, /hate/gi];

let isRunning = false;
let postCount = 0;
let logs = [];
const postedTitles = new Set();

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] ${msg}`;
    logs.unshift(entry);
    if (logs.length > 50) logs.pop();
    console.log(entry);
}

async function getFullArticleContent(url) {
    try {
        const { data } = await axios.get(url, { timeout: 8000 });
        const $ = cheerio.load(data);
        $('script, style, nav, footer, header, .ads, .sidebar').remove();
        let content = '';
        $('p').each((i, el) => { content += $(el).text() + '\n'; });
        return content.trim();
    } catch (e) { return null; }
}

function cleanContent(text) {
    let clean = text.replace(/<[^>]*>/g, '').replace(/(https?:\/\/[^\s]+)/gi, '').replace(/\+?\d{8,15}/g, '');
    SENSITIVE_KEYWORDS.forEach(reg => { clean = clean.replace(reg, 'Crypto'); });
    // Giữ lại các đoạn có ý nghĩa, loại bỏ dòng thừa
    const lines = clean.split('\n').filter(line => line.trim().length > 10);
    return lines.map(line => `${ICONS[Math.floor(Math.random() * ICONS.length)]} ${line}`).join('\n\n');
}

async function runJob() {
    if (postCount >= 60) {
        addLog("🛑 Đủ 60 bài. Ngừng.");
        isRunning = false;
        return;
    }

    addLog(`--- Quét nguồn... ---`);
    for (const source of RSS_SOURCES) {
        try {
            const feed = await parser.parseURL(source);
            if (!feed.items?.length) continue;
            const item = feed.items[0];
            
            if (postedTitles.has(item.title)) continue;

            const fullRawText = await getFullArticleContent(item.link);
            if (!fullRawText || fullRawText.length < 500) continue; 

            const cleanBody = cleanContent(fullRawText);
            
            // PAYLOAD MỚI: Thêm title vào
            const payload = {
                title: item.title.substring(0, 100), // Tiêu đề bắt buộc
                bodyTextOnly: `${cleanBody.substring(0, 4000)}\n\n#Crypto #Bitcoin #Trading #Binance`,
                symbolList: [{ symbol: "BTCUSDT", type: "FUTURES" }]
            };

            addLog(`Đang gửi: ${item.title.substring(0, 15)}...`);

            const response = await axios.post(SQUAD_ENDPOINT, payload, { 
                headers: { "X-Square-OpenAPI-Key": SQUAD_API_KEY, "Content-Type": "application/json" },
                timeout: 10000
            });

            if (response.data.success) {
                postedTitles.add(item.title);
                postCount++;
                addLog(`✅ Thành công (${postCount}/60).`);
                return; 
            } else {
                addLog(`⚠️ API Lỗi: ${JSON.stringify(response.data)}`);
            }
        } catch (e) { 
            addLog(`❌ Lỗi RSS: ${e.message}`); 
        }
    }
}

const htmlControl = `
<!DOCTYPE html><html><body style="background:#121212; color:#0f0; font-family:monospace; padding:20px;">
<h1>Bot News Pro - ${isRunning ? 'ON' : 'OFF'}</h1>
<div>
    <button onclick="fetch('/start').then(()=>location.reload())" style="padding:15px; background:green; color:white; font-weight:bold; cursor:pointer;">START</button>
    <button onclick="fetch('/stop').then(()=>location.reload())" style="padding:15px; background:red; color:white; font-weight:bold; cursor:pointer;">STOP</button>
    <button onclick="fetch('/test').then(()=>alert('Đã test...'))" style="padding:15px; background:yellow; color:black; font-weight:bold; cursor:pointer;">TEST</button>
</div>
<p>Đã đăng: ${postCount}/60</p>
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
app.get('/start', (req, res) => { isRunning = true; addLog("Bật"); runJob(); res.send("OK"); });
app.get('/stop', (req, res) => { isRunning = false; addLog("Tắt"); res.send("OK"); });
app.get('/test', async (req, res) => { await runJob(); res.send("OK"); });

cron.schedule('*/25 * * * *', async () => {
    if (isRunning && postCount < 60) await runJob();
});

cron.schedule('15 7 * * *', () => { postCount = 0; postedTitles.clear(); addLog("Reset!"); });

app.listen(PORT, () => console.log('Server running on port ' + PORT));
