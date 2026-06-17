import express from 'express';
import Parser from 'rss-parser';
import { GoogleGenAI } from "@google/genai";
import cron from 'node-cron';
import axios from 'axios';

const app = express();
const PORT = 9999;
const parser = new Parser();

// --- CẤU HÌNH (Dán key trực tiếp vào đây) ---
const GEMINI_API_KEY = "AQ.Ab8RN6KAh_MstQunwe1COZTghlbnvdLDTOJdFw8n7Mg3FymFNQ";
const SQUAD_API_KEY = "8d794c11cc794c958c2c65924c54f2dd";
const SQUAD_ENDPOINT = "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add";

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

let isRunning = false;
let postCount = 0;
let lastReset = new Date().toDateString();

const RSS_SOURCES = [
    'https://news.google.com/rss/search?q=world+politics',
    'https://cointelegraph.com/rss',
    'https://www.coindesk.com/arc/outboundfeeds/rss/',
    'https://cryptopotato.com/feed/'
];

// --- GIAO DIỆN ĐIỀU KHIỂN ---
const htmlControl = `
<!DOCTYPE html><html><body style="font-family: sans-serif; padding: 20px; background: #121212; color: #eee;">
<h1>Bot Control Center</h1>
<div style="margin: 20px 0;">
    <button onclick="fetch('/start').then(() => location.reload())" style="padding:10px 20px; cursor:pointer; background:green; color:white; border:none;">START</button>
    <button onclick="fetch('/stop').then(() => location.reload())" style="padding:10px 20px; cursor:pointer; background:red; color:white; border:none;">STOP</button>
    <button onclick="fetch('/test').then(r => r.text()).then(alert)" style="padding:10px 20px; cursor:pointer; background:blue; color:white; border:none;">TEST</button>
</div>
<p>Trạng thái: <b>${isRunning ? 'ON' : 'OFF'}</b> | Đã đăng: ${postCount}/50</p>
</body></html>`;

// --- QUY TRÌNH 1: GEMINI 1.5 ---
async function generateArticle(title, content) {
    try {
        const response = await ai.models.generateContent({
            model: "gemini-1.5-flash",
            contents: `Viết 1 bài báo phân tích thị trường dựa trên tin tức: ${title} - ${content}.
            YÊU CẦU: 300-500 từ, có Tiêu đề, Sapo, Phân tích, Kết luận. 
            Mỗi đoạn bắt đầu bằng emoji. 
            Dùng 1 từ chứa '$' và 3 hashtag ở cuối.`
        });
        return response.text;
    } catch (e) {
        console.error("❌ Lỗi Gemini:", e.message);
        throw e;
    }
}

// --- QUY TRÌNH 2: POST SQUAD ---
async function postToSquad(content) {
    try {
        await axios.post(SQUAD_ENDPOINT, { content, apiKey: SQUAD_API_KEY }, {
            timeout: 15000,
            headers: { 'Content-Type': 'application/json' }
        });
        return true;
    } catch (e) {
        console.error("❌ Lỗi Squad:", e.response?.data || e.message);
        return false;
    }
}

// --- LOGIC CHÍNH ---
async function runJob() {
    console.log("--- Bắt đầu vòng lặp ---");
    for (const source of RSS_SOURCES) {
        try {
            const feed = await parser.parseURL(source);
            if (!feed.items?.length) continue;
            
            const article = await generateArticle(feed.items[0].title, feed.items[0].contentSnippet);
            const success = await postToSquad(article);
            
            if (success) {
                postCount++;
                console.log(`✅ Đã đăng bài từ ${source}. Tổng: ${postCount}`);
                break; 
            }
        } catch (e) { console.error(`Lỗi feed ${source}:`, e.message); }
    }
}

// --- ROUTES ---
app.get('/', (req, res) => res.send(htmlControl));
app.get('/start', (req, res) => { isRunning = true; res.send("OK"); });
app.get('/stop', (req, res) => { isRunning = false; res.send("OK"); });
app.get('/test', async (req, res) => { await runJob(); res.send("Check logs!"); });

// --- CRON ---
cron.schedule('*/15 * * * *', async () => {
    if (!isRunning || postCount >= 50) return;
    if (new Date().toDateString() !== lastReset) { postCount = 0; lastReset = new Date().toDateString(); }
    await runJob();
});

app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
