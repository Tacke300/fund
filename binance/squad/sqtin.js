import express from 'express';
import Parser from 'rss-parser';
import { GoogleGenAI } from "@google/genai";
import cron from 'node-cron';
import axios from 'axios';

const app = express();
const PORT = 9999;
const parser = new Parser();

// --- CẤU HÌNH ---
const GEMINI_API_KEY = "AQ.Ab8RN6IdfdFuQKAUzG1lXWovDaL4h-5CWSilIEB2CXrMRlMQJQ";
const SQUAD_API_KEY = "8d794c11cc794c958c2c65924c54f2dd";
const SQUAD_ENDPOINT = "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add";

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

// Giao diện
const htmlControl = `
<!DOCTYPE html><html><body style="font-family: sans-serif; padding: 20px;">
<h1>News Bot Squad Control</h1>
<button onclick="fetch('/start').then(() => location.reload())" style="padding:10px 20px; background:green; color:white; border:none; cursor:pointer;">START</button>
<button onclick="fetch('/stop').then(() => location.reload())" style="padding:10px 20px; background:red; color:white; border:none; cursor:pointer;">STOP</button>
<button onclick="fetch('/test').then(r => r.text()).then(alert)" style="padding:10px 20px; background:blue; color:white; border:none; cursor:pointer;">TEST NHANH</button>
<p>Status: ${isRunning ? 'ON' : 'OFF'} | Đã đăng: ${postCount}/50</p>
</body></html>`;

// --- QUY TRÌNH 1: TẠO BÀI ---
async function generateArticle(title, content) {
    console.log(`[Quy trình 1] Đang gọi Gemini...`);
    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: `Viết 1 bài báo phân tích thị trường dựa trên tin tức này.
        YÊU CẦU: 300-500 từ, cấu trúc Tiêu đề, Sapo, Phân tích, Kết luận.
        Mỗi đoạn văn bắt đầu bằng emoji.
        Chỉ dùng ĐÚNG 1 từ có ký tự '$' và ĐÚNG 3 hashtag ở cuối.
        Tin gốc: ${title} - ${content}`
    });
    return response.text;
}

// --- QUY TRÌNH 2: ĐĂNG BÀI ---
async function postToSquad(content) {
    console.log("[Quy trình 2] Đang gửi bài...");
    try {
        await axios.post(SQUAD_ENDPOINT, {
            content: content,
            apiKey: SQUAD_API_KEY
        }, {
            timeout: 15000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log("Đăng Squad thành công");
        return true;
    } catch (e) {
        console.error("Lỗi đăng Squad:", e.response ? e.response.data : e.message);
        return false;
    }
}

// LOGIC CHẠY CHÍNH
async function runJob() {
    try {
        const source = RSS_SOURCES[Math.floor(Math.random() * RSS_SOURCES.length)];
        const feed = await parser.parseURL(source);
        const item = feed.items[0];
        
        const article = await generateArticle(item.title, item.contentSnippet);
        const success = await postToSquad(article);
        
        if (success) {
            postCount++;
            console.log(`Đã đăng bài ${postCount}/50`);
        }
    } catch (e) { console.error("Lỗi bot:", e); }
}

// ROUTING
app.get('/', (req, res) => res.send(htmlControl));
app.get('/start', (req, res) => { isRunning = true; res.send("OK"); });
app.get('/stop', (req, res) => { isRunning = false; res.send("OK"); });
app.get('/test', async (req, res) => {
    await runJob();
    res.send("Đã chạy xong 1 vòng. Kiểm tra log ngay!");
});

// CRON
cron.schedule('*/15 * * * *', async () => {
    if (!isRunning || postCount >= 50) return;
    if (new Date().toDateString() !== lastReset) { postCount = 0; lastReset = new Date().toDateString(); }
    await runJob();
});

app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
