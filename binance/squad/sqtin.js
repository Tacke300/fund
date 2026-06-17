import express from 'express';
import Parser from 'rss-parser';
import axios from 'axios';
import cron from 'node-cron';
import * as cheerio from 'cheerio'; // Thư viện mới để cào nội dung

const app = express();
const PORT = 9999;
const parser = new Parser();

const SQUAD_API_KEY = "8d794c11cc794c958c2c65924c54f2dd";
const SQUAD_ENDPOINT = "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add";

const RSS_SOURCES = [
    'https://cointelegraph.com/rss', 'https://www.coindesk.com/arc/outboundfeeds/rss/',
    'https://cryptopotato.com/feed/', 'https://decrypt.co/feed',
    'http://feeds.reuters.com/Reuters/PoliticsNews', 'https://feeds.bloomberg.com/markets/news.rss',
    'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10001147',
    'https://blockworks.co/feed', 'https://www.investing.com/rss/news.rss',
    'https://feeds.bbci.co.uk/news/world/rss.xml'
];

const ICONS = ["📈", "🚀", "💡", "🛡️", "💎", "✅", "⚡", "🔥", "📊", "🌐", "🧠", "✨", "🎯", "🔔", "⭐"];
const SENSITIVE_KEYWORDS = [/gambling/gi, /casino/gi, /betting/gi, /sex/gi, /porn/gi, /violence/gi, /war/gi, /killing/gi, /god/gi, /religion/gi, /politics/gi, /illegal/gi, /scam/gi, /pump/gi, /dump/gi, /attack/gi, /bloody/gi, /hate/gi];

let isRunning = false;
let postCount = 0;
let logs = [];
let futuresList = ["BTC", "ETH"];
const postedTitles = new Set();

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] ${msg}`;
    logs.unshift(entry);
    if (logs.length > 50) logs.pop();
    console.log(entry);
}

// Hàm cào full nội dung từ link
async function getFullArticleContent(url) {
    try {
        const { data } = await axios.get(url, { timeout: 10000 });
        const $ = cheerio.load(data);
        
        // Loại bỏ các phần không cần thiết
        $('script, style, nav, footer, header, .ads, .sidebar').remove();
        
        // Lấy text từ các thẻ p (thường là thân bài)
        let content = '';
        $('p').each((i, el) => {
            content += $(el).text() + '\n\n';
        });
        
        return content.trim();
    } catch (e) {
        return null;
    }
}

function cleanContent(text) {
    let clean = text
        .replace(/(https?:\/\/[^\s]+)/gi, '') // Xóa link
        .replace(/(www\.[^\s]+)/gi, '')
        .replace(/\+?\d{8,15}/g, '') // Xóa số đt
        .replace(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/gi, '');

    SENSITIVE_KEYWORDS.forEach(reg => { clean = clean.replace(reg, 'Crypto'); });
    
    // Thêm icon dày đặc
    const lines = clean.split('\n').filter(line => line.trim().length > 20);
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
    if (postCount >= 60) return;

    addLog(`--- Quét nguồn (${postCount + 1}/60) ---`);
    for (const source of RSS_SOURCES) {
        try {
            const feed = await parser.parseURL(source);
            if (!feed.items?.length) continue;
            const item = feed.items[0];
            
            if (postedTitles.has(item.title)) continue;

            // Lấy full nội dung từ link
            const fullRawText = await getFullArticleContent(item.link);
            if (!fullRawText) continue;

            const randomCoin = futuresList[Math.floor(Math.random() * futuresList.length)];
            const cleanBody = cleanContent(fullRawText);
            
            // Giới hạn độ dài text gửi lên Binance (để tránh lỗi API)
            const finalContent = `$${randomCoin}\n\n${cleanBody.substring(0, 5000)}\n\n#Crypto #Bitcoin #Trading #Binance #Market`;

            const response = await axios.post(SQUAD_ENDPOINT, {
                bodyTextOnly: finalContent,
                symbolList: [{ symbol: `${randomCoin}USDT`, type: "FUTURES" }]
            }, { 
                headers: { "X-Square-OpenAPI-Key": SQUAD_API_KEY, "Content-Type": "application/json" } 
            });

            if (response.data.success) {
                postedTitles.add(item.title);
                postCount++;
                addLog(`✅ Đăng ${postCount}/60: ${randomCoin} | ${item.title.substring(0, 15)}...`);
                return; 
            }
        } catch (e) { addLog(`❌ Lỗi ${source}: ${e.message}`); }
    }
}

// Reset 7h15 sáng
cron.schedule('15 7 * * *', () => {
    postCount = 0;
    postedTitles.clear();
    addLog("🌅 Reset giới hạn ngày mới.");
});

// Chạy mỗi 25 phút
cron.schedule('*/25 * * * *', async () => {
    if (isRunning) await runJob();
});

const htmlControl = `
<!DOCTYPE html><html><body style="background:#121212; color:#0f0; font-family:monospace; padding:20px;">
<h1>Bot News Pro - Full Text Edition</h1>
<button onclick="fetch('/start').then(()=>location.reload())">START</button>
<button onclick="fetch('/stop').then(()=>location.reload())">STOP</button>
<p>Status: ${isRunning ? 'ON' : 'OFF'} | Đã đăng: ${postCount}/60</p>
<div id="logs" style="background:#000; height:300px; overflow-y:scroll;"></div>
<script>setInterval(()=>{fetch('/logs').then(r=>r.json()).then(d=>document.getElementById('logs').innerHTML=d.join('<br>'))}, 2000);</script>
</body></html>`;

app.get('/', (req, res) => res.send(htmlControl));
app.get('/logs', (req, res) => res.json(logs));
app.get('/start', (req, res) => { isRunning = true; addLog("Bật"); res.send("OK"); });
app.get('/stop', (req, res) => { isRunning = false; addLog("Tắt"); res.send("OK"); });
app.listen(PORT, () => console.log('Bot chạy port ' + PORT));
