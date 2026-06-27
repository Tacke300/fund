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

// Đọc API Key Groq từ file grok.json (Key có dạng gsk_...)
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
    <h1>Bot News Groq Pro - ${isRunning ? 'RUNNING' : 'STOPPED'}</h1>
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

async function fetchCryptoNewsFromAI() {
    if (!GROQ_API_KEY) {
        addLog("❌ Thiếu API Key trong grok.json!");
        return null;
    }

    // Giới hạn 10 tiêu đề gần nhất theo đóng góp của bạn để tránh quá tải Prompt
    const excludedTitles = Array.from(postedTitles).slice(-10).join('\n');

    const prompt = `Bạn là một chuyên gia tổng hợp tin tức crypto. Hãy tìm và tổng hợp 1 bài viết HOT nhất về thị trường crypto trong 24 giờ qua. Chỉ lấy các tin đang được cộng đồng quan tâm mạnh.
Ưu tiên nguồn: Binance, CoinDesk, Cointelegraph, The Block, Decrypt, Wu Blockchain, Lookonchain, Arkham.

⚠️ KHÔNG LẤY TIN TRÙNG HOẶC TƯƠNG TỰ CÁC TIÊU ĐỀ SAU:
${excludedTitles || "Không có"}

Yêu cầu trả về JSON object chứa đúng cấu trúc:
{
  "title": "Tiêu đề tiếng Việt dưới 80 ký tự",
  "content": "📰 Tiêu đề: ...\\n📌 Tóm tắt: ...\\n📈 Đánh giá tác động: ...\\n🪙 Coin ảnh hưởng: ...\\n🔥 Mức độ hot: 1-10\\n💥 Khả năng ảnh hưởng giá: Thấp/Trung bình/Cao\\n🔗 Link nguồn: ...\\n\\nTop tin quan trọng nhất hôm nay:...\\nTâm lý chung:...\\nSự kiện 7 ngày tới:..."
}
Nội dung bằng Tiếng Việt, tổng ký tự không vượt quá 1800 ký tự.`;

    try {
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama-3.3-70b-versatile", // Cập nhật model đời mới nhất của Groq
            response_format: {
                type: "json_object" // Ép Groq trả về JSON thuần chuẩn xác
            },
            messages: [
                { role: "system", content: "You are a helpful assistant that outputs only strict raw JSON object." },
                { role: "user", content: prompt }
            ],
            temperature: 0.5
        }, {
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        const rawText = response.data.choices[0].message.content.trim();
        return JSON.parse(rawText);

    } catch (e) {
        // In chi tiết lỗi 400 từ Groq ra Console và Log Web đúng như bạn yêu cầu
        console.error("--- CHI TIẾT LỖI GROQ ---");
        console.error(e.response?.data);
        console.error("-------------------------");
        
        const errorDetail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        addLog(`❌ Groq Error 400: ${errorDetail}`);
        return null;
    }
}

async function runJob() {
    if (postCount >= 60) return;

    addLog(`--- Đang gọi Groq AI lấy tin tức... ---`);
    
    const news = await fetchCryptoNewsFromAI();
    if (!news || !news.title || !news.content) {
        return; // Dừng lại vì lỗi đã được fetchCryptoNewsFromAI log ra cụ thể
    }

    const cleanTitle = news.title.trim().toLowerCase();
    if (postedTitles.has(cleanTitle)) {
        addLog(`⚠️ Trùng bài cũ: [${news.title}]. Đang yêu cầu AI tìm bài khác...`);
        return await runJob(); // Đệ quy tìm bài mới
    }

    const fullPost = `${news.content}\n\n#Crypto #Bitcoin #Trading #Binance`;
    const safePost = fullPost.substring(0, 1990); // Đảm bảo luôn dưới 2000 ký tự

    const payload = {
        title: news.title.substring(0, 80),
        bodyTextOnly: safePost,
        symbolList: [{ symbol: "BTCUSDT", type: "FUTURES" }]
    };

    try {
        const response = await axios.post(SQUAD_ENDPOINT, payload, { 
            headers: { "X-Square-OpenAPI-Key": SQUAD_API_KEY, "Content-Type": "application/json" },
            timeout: 5000 
        });

        if (response.data.success || response.data.code === 0) {
            postedTitles.add(cleanTitle);
            postCount++;
            addLog(`✅ Đăng thành công ${postCount}/60: ${news.title.substring(0, 30)}...`);
        } else {
            addLog(`❌ Binance API Reject: ${JSON.stringify(response.data)}`);
        }
    } catch (e) {
        addLog(`❌ Lỗi post Binance Square: ${e.message}`);
    }
}

app.get('/', (req, res) => res.send(renderHTML()));
app.get('/logs', (req, res) => res.json(logs));
app.get('/start', (req, res) => { isRunning = true; addLog("Bật bot"); runJob(); res.send("OK"); });
app.get('/stop', (req, res) => { isRunning = false; addLog("Tắt bot"); res.send("OK"); });
app.get('/test', async (req, res) => { addLog("Test thủ công..."); await runJob(); res.send("OK"); });

cron.schedule('*/15 * * * *', async () => {
    if (isRunning && postCount < 60) await runJob();
});

app.listen(PORT, () => console.log('Server running on port ' + PORT));
