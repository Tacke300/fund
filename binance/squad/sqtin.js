import express from 'express';
import Parser from 'rss-parser';
import { GoogleGenAI } from "@google/genai"; 
import cron from 'node-cron';
import axios from 'axios';

const app = express();
const PORT = 9999;
const parser = new Parser();

// --- CẤU HÌNH ---
// Dán Key AQ... hoặc AIza... của bạn vào đây
const GEMINI_API_KEY = "AQ.Ab8RN6IdfdFuQKAUzG1lXWovDaL4h-5CWSilIEB2CXrMRlMQJQ"; 
const SQUAD_API_KEY = "8d794c11cc794c958c2c65924c54f2dd";
const SQUAD_ENDPOINT = "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add";

// Khởi tạo client với SDK mới
const ai = new GoogleGenAI({
    apiKey: GEMINI_API_KEY
});

let isRunning = false;
let postCount = 0;
let lastReset = new Date().toDateString();

const RSS_SOURCES = [
    'https://rss.app/feeds/politics-world.xml',
    'https://news.google.com/rss/search?q=world+politics',
    'https://cointelegraph.com/rss',
    'https://www.coindesk.com/arc/outboundfeeds/rss/',
    'https://cryptopotato.com/feed/'
];

const htmlControl = `
<!DOCTYPE html><html><body style="font-family: sans-serif; padding: 20px;">
<h1>News Bot Binance Control</h1>
<button onclick="fetch('/start').then(() => alert('Started'))" style="padding:10px 20px; background:green; color:white; border:none; cursor:pointer;">START</button>
<button onclick="fetch('/stop').then(() => alert('Stopped'))" style="padding:10px 20px; background:red; color:white; border:none; cursor:pointer;">STOP</button>
<p>Status: ${isRunning ? 'ON' : 'OFF'} | Đã đăng: ${postCount}/50</p>
</body></html>`;

async function generateArticle(title, content) {
    const prompt = `Viết 1 bài đăng ngắn gọn (dưới 500 ký tự) về tin tức này: ${title} - ${content}`;
    
    // Sử dụng model mới qua SDK mới
    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt
    });

    return response.text;
}

async function postToSquad(content) {
    try {
        await axios.post(SQUAD_ENDPOINT, {
            content: content
        }, {
            headers: {
                // Đảm bảo điền header xác thực của Binance tại đây
            }
        });
        console.log("Đăng bài thành công");
    } catch (e) {
        console.error("Lỗi đăng bài:", e.response ? e.response.data : e.message);
    }
}

cron.schedule('*/15 * * * *', async () => {
    if (!isRunning) return;
    if (new Date().toDateString() !== lastReset) { postCount = 0; lastReset = new Date().toDateString(); }
    if (postCount >= 50) return;

    try {
        const source = RSS_SOURCES[Math.floor(Math.random() * RSS_SOURCES.length)];
        const feed = await parser.parseURL(source);
        const item = feed.items[0];
        const article = await generateArticle(item.title, item.contentSnippet);
        
        await postToSquad(article);
        postCount++;
        console.log(`Đã đăng bài ${postCount}/50`);
    } catch (e) { console.error("Lỗi bot:", e); }
});

app.get('/', (req, res) => res.send(htmlControl));
app.get('/start', (req, res) => { isRunning = true; res.send("OK"); });
app.get('/stop', (req, res) => { isRunning = false; res.send("OK"); });

app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
