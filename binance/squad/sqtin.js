import express from 'express';
import Parser from 'rss-parser';
import { GoogleGenerativeAI } from "@google/generative-ai";
import cron from 'node-cron';

const app = express();
const PORT = 9999;
const parser = new Parser();
const genAI = new GoogleGenerativeAI("AQ.Ab8RN6IdfdFuQKAUzG1lXWovDaL4h-5CWSilIEB2CXrMRlMQJQ");

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

// Giao diện điều khiển HTML
const htmlControl = `
<!DOCTYPE html><html><body style="font-family: sans-serif; padding: 20px;">
<h1>News Bot Control Panel</h1>
<button onclick="fetch('/start').then(() => alert('Bot Started'))" style="padding:10px 20px; background:green; color:white; border:none; cursor:pointer;">START</button>
<button onclick="fetch('/stop').then(() => alert('Bot Stopped'))" style="padding:10px 20px; background:red; color:white; border:none; cursor:pointer;">STOP</button>
<button onclick="fetch('/test').then(r => r.text()).then(t => alert(t))" style="padding:10px 20px; background:blue; color:white; border:none;">TEST BÀI BÁO</button>
<p>Status: Bot ${isRunning ? 'ON' : 'OFF'} | Posts today: ${postCount}/50</p>
</body></html>`;

// Logic tạo bài báo (Prompt được tối ưu để tuân thủ strict constraint)
async function generateArticle(title, content) {
    const prompt = `
    Bạn là một phóng viên tài chính cao cấp. Hãy viết một bài báo phân tích thị trường dựa trên tin tức này.
    
    YÊU CẦU CẤU TRÚC:
    1. Tiêu đề: Giật gân, chuyên nghiệp.
    2. Sapo: Tóm tắt tin tức trong 2 câu.
    3. Thân bài: Ít nhất 4 đoạn văn phân tích sâu, dùng giọng văn chuyên gia, khách quan.
    4. Kết luận: Dự báo ngắn hạn.
    
    RÀNG BUỘC TUYỆT ĐỐI:
    - BẮT BUỘC chỉ được dùng ĐÚNG 1 ký hiệu coin duy nhất có tiền tố $ (Ví dụ: $BTC).
    - BẮT BUỘC chỉ được dùng ĐÚNG 3 hashtag ở cuối bài (Ví dụ: #crypto #finance #trading).
    - Cấm tuyệt đối không dùng thêm bất kỳ $ hay # nào khác trong bài viết.
    - Mỗi đoạn văn phải bắt đầu bằng 1 icon ngẫu nhiên.
    - Bài viết phải dài từ 300 - 500 từ.
    
    Tin tức gốc: ${title} - ${content}
    `;

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(prompt);
    return result.response.text();
}

// Cron Job: 15 phút 1 lần
cron.schedule('*/15 * * * *', async () => {
    if (!isRunning) return;
    if (new Date().toDateString() !== lastReset) { postCount = 0; lastReset = new Date().toDateString(); }
    if (postCount >= 50) return;

    try {
        const source = RSS_SOURCES[Math.floor(Math.random() * RSS_SOURCES.length)];
        const feed = await parser.parseURL(source);
        const item = feed.items[0];
        const article = await generateArticle(item.title, item.contentSnippet);
        
        console.log("--- BÀI BÁO MỚI ---");
        console.log(article);
        // Gửi qua SQUAD API ở đây...
        
        postCount++;
    } catch (e) { console.error(e); }
});

// Routing
app.get('/', (req, res) => res.send(htmlControl));
app.get('/start', (req, res) => { isRunning = true; res.send("OK"); });
app.get('/stop', (req, res) => { isRunning = false; res.send("OK"); });
app.get('/test', async (req, res) => {
    const article = await generateArticle("Bitcoin Halving Impact", "Bitcoin halving occurred, supply drops, demand stays.");
    res.send(article);
});

app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
