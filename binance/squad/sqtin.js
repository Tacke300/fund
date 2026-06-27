import express from 'express';
import axios from 'axios';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = 9999;

const SQUAD_API_KEY = "8d794c11cc794c958c2c65924c54f2dd";
const SQUAD_ENDPOINT = "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add";

let isRunning = false;
let postCount = 0;
let logs = [];
const postedTitles = new Set();

// Đọc API Key Groq/Grok từ file grok.json
let GROQ_API_KEY = "";
try {
    const grokConfig = JSON.parse(fs.readFileSync(path.resolve('./grok.json'), 'utf8'));
    GROQ_API_KEY = grokConfig.apiKey;
} catch (error) {
    console.error("❌ Không thể đọc file grok.json hoặc thiếu apiKey!");
}

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
    <h1>Bot News Grok Pro - ${isRunning ? 'RUNNING' : 'STOPPED'}</h1>
    <div>
        <button onclick="fetch('/start').then(()=>location.reload())" style="padding:15px; background:green; color:white; cursor:pointer;">START</button>
        <button onclick="fetch('/stop').then(()=>location.reload())" style="padding:15px; background:red; color:white; cursor:pointer;">STOP</button>
        <button onclick="fetch('/test').then(()=>location.reload())" style="padding:15px; background:yellow; color:black; cursor:pointer;">TEST NGAY</button>
    </div>
    <p>Đã đăng: ${postCount}/60 | Tiêu đề đã lưu: ${postedTitles.size}</p>
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

// Hàm gọi API của Groq/Grok để lấy tin tức dạng JSON để dễ quản lý trùng lặp
async function fetchCryptoNewsFromAI() {
    if (!GROQ_API_KEY) {
        addLog("❌ Thiếu API Key trong grok.json!");
        return null;
    }

    // Gửi danh sách các tiêu đề đã đăng để AI chủ động bỏ qua và tìm tin mới
    const excludedTitles = Array.from(postedTitles).slice(-20).join(', ');

    const prompt = `Bạn là một chuyên gia tổng hợp tin tức crypto. Hãy tìm và tổng hợp 1 bài viết HOT nhất về thị trường crypto trong 24 giờ qua. Chỉ lấy các tin đang được cộng đồng quan tâm mạnh (nhiều lượt xem, chia sẻ hoặc được nhiều nguồn uy tín đồng loạt đưa tin).
Ưu tiên nguồn: Binance, CoinDesk, Cointelegraph, The Block, Decrypt, Wu Blockchain, Lookonchain, Arkham, X (Twitter) của các dự án và KOL uy tín.

⚠️ LƯU Ý QUAN TRỌNG: Không lấy các tin có tiêu đề gần giống hoặc trùng với danh sách sau: [${excludedTitles}]

Hãy trả về kết quả dưới dạng cấu trúc JSON nghiêm ngặt (không bao gồm markdown \`\`\`json ... \`\`\`, chỉ trả về text JSON thuần):
{
  "title": "Tiêu đề tiếng Việt ngắn gọn dưới 80 ký tự",
  "content": "Nội dung bài viết theo đúng cấu trúc sau:\\n📰 Tiêu đề: ...\\n📌 Tóm tắt: ...\\n📈 Đánh giá tác động: Tích cực / Tiêu cực / Trung lập\\n🪙 Coin hoặc dự án bị ảnh hưởng: ...\\n🔥 Mức độ hot: 1-10\\n💥 Khả năng ảnh hưởng đến giá: Thấp / Trung bình / Cao\\n🔗 Link nguồn gốc: ...\\n\\nTop tin quan trọng nhất hôm nay:...\\nTâm lý chung của thị trường:...\\nSự kiện sắp diễn ra trong 7 ngày tới:..."
}

Yêu cầu về nội dung trong phần "content":
- Loại bỏ tin đồn chưa được xác thực, bài quảng cáo và nội dung clickbait.
- Trình bày toàn bộ bằng Tiếng Việt.
- TỔNG ĐỘ DÀI TOÀN BỘ PHẦN NỘI DUNG (bao gồm tiêu đề, tóm tắt và hashtag) TUYỆT ĐỐI KHÔNG VƯỢT QUÁ 1800 ký tự để đảm bảo an toàn không quá tải hệ thống.`;

    try {
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama3-70b-8192", // Bạn có thể đổi sang model khác của Groq/Grok nếu thích
            messages: [
                { role: "system", content: "You are a helpful assistant that outputs only strict raw JSON." },
                { role: "user", content: prompt }
            ],
            temperature: 0.7
        }, {
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });

        const rawText = response.data.choices[0].message.content.trim();
        // Parse kết quả JSON
        const newsData = JSON.parse(rawText);
        return newsData;

    } catch (e) {
        addLog(`❌ Lỗi gọi AI Groq: ${e.message}`);
        return null;
    }
}

async function runJob() {
    if (postCount >= 60) {
        addLog("📢 Đã đạt giới hạn 60 bài đăng hôm nay.");
        return;
    }

    addLog(`--- Đang yêu cầu AI Grok tìm tin hot... ---`);
    
    const news = await fetchCryptoNewsFromAI();
    if (!news || !news.title || !news.content) {
        addLog("❌ Không nhận được dữ liệu hợp lệ từ AI.");
        return;
    }

    // Chuẩn hóa tiêu đề để check trùng lặp thực tế
    const cleanTitle = news.title.trim().toLowerCase();

    if (postedTitles.has(cleanTitle)) {
        addLog(`⚠️ Trùng bài cũ: [${news.title}]. Đang thử lại lượt khác...`);
        // Gọi lại đệ quy để tìm bài mới hoàn toàn
        return await runJob();
    }

    // Gom thành bài viết hoàn chỉnh có kèm hashtag
    const fullPost = `${news.content}\n\n#Crypto #Bitcoin #Trading #Binance`;

    // Giới hạn nghiêm ngặt tổng độ dài toàn bài <= 2000 ký tự theo yêu cầu
    if (fullPost.length > 2000) {
        addLog("⚠️ Bài viết của AI vượt quá 2000 ký tự. Đang băm bớt...");
    }
    const safePost = fullPost.substring(0, 1990);

    const payload = {
        title: news.title.substring(0, 80),
        bodyTextOnly: safePost,
        symbolList: [{ symbol: "BTCUSDT", type: "FUTURES" }]
    };

    try {
        const response = await axios.post(SQUAD_ENDPOINT, payload, { 
            headers: { 
                "X-Square-OpenAPI-Key": SQUAD_API_KEY, 
                "Content-Type": "application/json" 
            },
            timeout: 5000 
        });

        if (response.data.success || response.data.code === 0 || response.data.message === 'success') {
            postedTitles.add(cleanTitle);
            postCount++;
            addLog(`✅ Đăng thành công ${postCount}/60: ${news.title.substring(0, 30)}...`);
        } else {
            addLog(`❌ Binance API từ chối: ${JSON.stringify(response.data)}`);
        }
    } catch (e) {
        addLog(`❌ Lỗi khi đăng bài lên Binance Square: ${e.message}`);
    }
}

// Routes điều khiển
app.get('/', (req, res) => res.send(renderHTML()));
app.get('/logs', (req, res) => res.json(logs));
app.get('/start', (req, res) => { isRunning = true; addLog("Bật bot"); runJob(); res.send("OK"); });
app.get('/stop', (req, res) => { isRunning = false; addLog("Tắt bot"); res.send("OK"); });
app.get('/test', async (req, res) => { addLog("Chạy thử thủ công..."); await runJob(); res.send("OK"); });

// Thay đổi định kỳ chạy mỗi 15 phút theo yêu cầu mới của bạn
cron.schedule('*/15 * * * *', async () => {
    if (isRunning && postCount < 60) {
        await runJob();
    }
});

app.listen(PORT, () => console.log('Server AI News running on port ' + PORT));
