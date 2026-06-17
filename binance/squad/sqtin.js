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

async function getFullContent(url) {
    try {
        const { data } = await axios.get(url, { timeout: 10000 });
        const $ = cheerio.load(data);
        $('script, style, nav, footer, header, .ads, .sidebar').remove();
        let content = '';
        $('p').each((i, el) => {
            let text = $(el).text().trim();
            if (text.length > 20) content += text + '\n\n';
        });
        return content;
    } catch (e) { return null; }
}

function cleanContent(text) {
    let clean = text.replace(/<[^>]*>/g, '').replace(/(https?:\/\/[^\s]+)/gi, '').replace(/\+?\d{8,15}/g, '');
    SENSITIVE_KEYWORDS.forEach(reg => { clean = clean.replace(reg, 'Crypto'); });
    return clean;
}

async function runJob() {
    if (postCount >= 60) {
        addLog("🛑 Đủ 60 bài. Đợi reset.");
        return;
    }

    addLog(`--- Bắt đầu quét... ---`);
    for (const source of RSS_SOURCES) {
        try {
            const feed = await parser.parseURL(source);
            if (!feed.items?.length) continue;
            const item = feed.items[0];
            
            if (postedTitles.has(item.title)) continue;

            const content = await getFullContent(item.link);
            if (!content || content.length < 300) continue; 

            const cleanBody = cleanContent(content);
            const randomIcon = ICONS[Math.floor(Math.random() * ICONS.length)];
            
            // Xây dựng nội dung: Tiêu đề + Nội dung
            // Giới hạn cứng tổng 1900 ký tự để chừa chỗ cho Hashtags
            const fullPost = `${randomIcon} **${item.title.toUpperCase()}**\n\n${cleanBody.substring(0, 1500)}\n\n#Crypto #Bitcoin #Trading #Binance`;

            const payload = {
                title: item.title.substring(0, 80),
                bodyTextOnly: fullPost,
                symbolList: [{ symbol: "BTCUSDT", type: "FUTURES" }]
            };

            const response = await axios.post(SQUAD_ENDPOINT, payload, { 
                headers: { "X-Square-OpenAPI-Key": SQUAD_API_KEY, "Content-Type": "application/json" } 
            });

            if (response.data.success) {
                postedTitles.add(item.title);
                postCount++;
                addLog(`✅ Thành công ${postCount}/60: ${item.title.substring(0, 15)}...`);
                return; 
            } else {
                addLog(`⚠️ API báo lỗi: ${JSON.stringify(response.data.message || response.data)}`);
            }
        } catch (e) { addLog(`❌ Lỗi RSS: ${e.message}`); }
    }
}

const htmlControl = `
<!DOCTYPE html><html><body style="background:#121212; color:#0f0; font-family:monospace; padding:20px;">
<h1>Bot News Pro</h1>
<div>
    <button onclick="fetch('/start').then(()=>location.reload())" style="padding:15px; background:green; color:white; cursor:pointer;">START</button>
    <button onclick="fetch('/stop').then(()=>location.reload())" style="padding:15px; background:red; color:white; cursor:pointer;">STOP</button>
    <button onclick="fetch('/test').then(()=>alert('Đang test...'))" style="padding:15px; background:yellow; color:black; cursor:pointer; font-weight:bold;">TEST NGAY</button>
</div>
<p>Status: ${isRunning ? 'ON' : 'OFF'} | Đã đăng: ${postCount}/60</p>
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
app.get('/start', (req, res) => { isRunning = true; addLog("Bot đã BẬT"); runJob(); res.send("OK"); });
app.get('/stop', (req, res) => { isRunning = false; addLog("Bot đã TẮT"); res.send("OK"); });
app.get('/test', async (req, res) => { await runJob(); res.send("OK"); });

cron.schedule('*/25 * * * *', async () => {
    if (isRunning && postCount < 60) await runJob();
});

cron.schedule('15 7 * * *', () => { 
    postCount = 0; 
    postedTitles.clear(); 
    addLog("🌅 Reset ngày mới!"); 
});

app.listen(PORT, () => console.log('Server running on port ' + PORT));
