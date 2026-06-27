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

// Trạng thái xoay tua: 'NEWS' -> 'FUNNY_STORY' -> 'SAD_STORY'
let currentType = 'NEWS'; 

const TITLE_FILE = path.resolve('./posted_titles.json');
let postedTitles = new Set();

// Tự động load lại các tiêu đề cũ đã đăng từ file JSON khi bật Bot
try {
    if (fs.existsSync(TITLE_FILE)) {
        const savedTitles = JSON.parse(fs.readFileSync(TITLE_FILE, 'utf8'));
        postedTitles = new Set(savedTitles.map(t => t.trim().toLowerCase()));
        console.log(`💾 Đã khôi phục thành công ${postedTitles.size} tiêu đề cũ từ file để chống trùng.`);
    }
} catch (e) {
    console.error("❌ Không thể đọc file lưu trữ tiêu đề:", e.message);
}

// Hàm ghi đè tiêu đề mới vào file để lưu trữ vĩnh viễn
function saveTitleToFile(newTitle) {
    try {
        postedTitles.add(newTitle.trim().toLowerCase());
        const titlesArray = Array.from(postedTitles);
        fs.writeFileSync(TITLE_FILE, JSON.stringify(titlesArray, null, 2), 'utf8');
    } catch (e) {
        console.error("❌ Lỗi lưu tiêu đề vào file JSON:", e.message);
    }
}

const CRYPTO_HASHTAGS = [
    "#Crypto", "#Bitcoin", "#Ethereum", "#Trading", "#Binance", "#DeFi", "#NFT", "#Web3", "#Altcoin", "#Blockchain",
    "#Solana", "#Layer2", "#BullMarket", "#BearMarket", "#Halving", "#WhaleAlert", "#CryptoNews", "#MarketUpdate", "#TechnicalAnalysis", "#Hodl",
    "#Airdrop", "#Staking", "#Launchpad", "#Memecoin", "#RWA", "#AI", "#GameFi", "#Metaverse", "#Arbitrum", "#Optimism",
    "#Polygon", "#Avalanche", "#Cardano", "#Ripple", "#Polkadot", "#Chainlink", "#Uniswap", "#Sui", "#Aptos", "#Sei",
    "#BNB", "#BTC", "#ETH", "#SOL", "#XRP", "#ADA", "#DOT", "#LINK", "#UNI", "#DOGE", "#SHIB", "#PEPE", "#WIF", "#FLOKI"
];
while(CRYPTO_HASHTAGS.length < 500) {
    CRYPTO_HASHTAGS.push(`#CryptoKeyword${CRYPTO_HASHTAGS.length}`);
}

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
    <h1>Bot AI Content Chống Trùng Tuyệt Đối - ${isRunning ? 'RUNNING' : 'STOPPED'}</h1>
    <div>
        <button onclick="fetch('/start').then(()=>location.reload())" style="padding:15px; background:green; color:white; cursor:pointer;">START</button>
        <button onclick="fetch('/stop').then(()=>location.reload())" style="padding:15px; background:red; color:white; cursor:pointer;">STOP</button>
        <button onclick="fetch('/test').then(()=>location.reload())" style="padding:15px; background:yellow; color:black; cursor:pointer;">TEST TIẾP THEO</button>
    </div>
    <p>Đã đăng hôm nay: ${postCount}/50 | Loại bài tiếp theo: <b>${currentType}</b> | Tổng tiêu đề đã khóa trùng: ${postedTitles.size}</p>
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

function rotateContentType() {
    if (currentType === 'NEWS') {
        currentType = 'FUNNY_STORY';
    } else if (currentType === 'FUNNY_STORY') {
        currentType = 'SAD_STORY';
    } else {
        currentType = 'NEWS';
    }
}

async function fetchCryptoContentFromAI(type) {
    if (!GROQ_API_KEY) {
        addLog("❌ Thiếu API Key trong grok.json!");
        return null;
    }

    // Lấy 15 tiêu đề gần nhất gửi lên làm mẫu "cấm trùng"
    const excludedTitles = Array.from(postedTitles).slice(-15).join('\n');
    
    // Tạo seed ngẫu nhiên dựa trên timestamp để AI không bị lặp thuật toán tư duy
    const randomSeed = Math.floor(Math.random() * 10000);

    let dynamicPrompt = "";
    if (type === 'NEWS') {
        dynamicPrompt = `Tìm và viết bài về 1 tin tức HOT nhất, mới nhất về thị trường Crypto trong 24 giờ qua. Yêu cầu viết sâu, khai thác góc nhìn chi tiết (không tóm tắt ngắn ngủi vài câu).`;
    } else if (type === 'FUNNY_STORY') {
        dynamicPrompt = `Sáng tác 1 câu chuyện hài hước, dở khóc dở cười ngẫu nhiên của một trader (ví dụ về: ngủ quên mất lệnh, trade nhầm bằng tiền cưới vợ, fomo coin hệ động vật...). Đổi mới hoàn toàn cốt truyện, nhân vật, bối cảnh so với các mô-típ thông thường. Mã giống: ${randomSeed}.`;
    } else if (type === 'SAD_STORY') {
        dynamicPrompt = `Sáng tác 1 câu chuyện buồn, bài học xương máu sâu sắc của một trader (ví dụ về: cháy tài khoản ngày cận tết, bị hack ví do ấn link lạ, trầm cảm mùa downtrend...). Tập trung mô tả tâm lý nhân vật thật sâu sắc, chạm lòng người. Mã giống: ${randomSeed}.`;
    }

    const prompt = `Bạn là một chuyên gia sáng tạo nội dung độc nhất trong giới Crypto. 
${dynamicPrompt}

⚠️ TUYỆT ĐỐI KHÔNG TRÙNG NỘI DUNG HOẶC TƯƠNG TỰ CÁC TIÊU ĐỀ ĐÃ VIẾT SAU:
${excludedTitles || "Không có"}

Yêu cầu trả về một JSON object chứa đúng cấu trúc sau (không kèm markdown):
{
  "title": "Tiêu đề tiếng Việt ngắn gọn dưới 80 ký tự thể hiện đúng nội dung bài",
  "coin_symbol": "Tên viết tắt đồng coin liên quan nhất (ví dụ: BTC, ETH, SOL, MEME...)",
  "content": "Nội dung bài viết hoàn chỉnh bằng Tiếng Việt. Mỗi đoạn hoặc ý đầu dòng BẮT BUỘC phải bắt đầu bằng một icon cảm xúc (emoji) phù hợp. Trình bày liền mạch, chi tiết đầy đủ câu chuyện/tin tức, không viết tóm tắt vài dòng ngắn ngủi. Không chèn chữ 'Tiêu đề' hay 'Nội dung' vào đây."
}

⚠️ LƯU Ý QUAN TRỌNG:
- TỔNG ĐỘ DÀI CỦA TRƯỜNG "title" CỘNG VỚI "content" TUYỆT ĐỐI KHÔNG ĐƯỢC VƯỢT QUÁ 1900 KÝ TỰ.`;

    try {
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: "You are a professional crypto writer that outputs only strict raw JSON." },
                { role: "user", content: prompt }
            ],
            temperature: 0.85 // Tăng độ sáng tạo lên 0.85 để AI đổi mới văn phong liên tục, tránh lặp ý
        }, {
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 20000
        });

        const rawText = response.data.choices[0].message.content.trim();
        return JSON.parse(rawText);

    } catch (e) {
        console.error(e.response?.data || e.message);
        addLog(`❌ Groq Error [${type}]: ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
        return null;
    }
}

async function runJob() {
    if (postCount >= 50) {
        addLog(`📢 Đã đạt giới hạn tối đa 50 bài trong hôm nay. Chờ reset vào 7h sáng.`);
        return;
    }

    const typeToFetch = currentType;
    addLog(`--- Đang gọi Groq AI tạo bài thuộc nhóm: [${typeToFetch}] ---`);
    
    const news = await fetchCryptoContentFromAI(typeToFetch);
    if (!news || !news.title || !news.content) return;

    const cleanTitle = news.title.trim().toLowerCase();
    
    // KIỂM TRA TRÙNG TUYỆT ĐỐI (So khớp tiêu đề trong Set)
    if (postedTitles.has(cleanTitle)) {
        addLog(`⚠️ AI sinh bài trùng tiêu đề cũ: [${news.title}]. Chặn đăng và yêu cầu lượt khác ngay lập tức...`);
        return await runJob(); // Vòng lặp an toàn bắt buộc tìm bài mới
    }

    let postText = `**${news.title.toUpperCase()}**\n\n${news.content}\n\n`;
    if (postText.length > 1900) {
        postText = postText.substring(0, 1900);
    }

    const randomHashtag = CRYPTO_HASHTAGS[Math.floor(Math.random() * CRYPTO_HASHTAGS.length)];
    const coinSymbol = news.coin_symbol ? news.coin_symbol.trim().toUpperCase().replace('$', '') : 'BTC';
    const coinHashtag = `$${coinSymbol}`;

    const finalPost = `${postText}${coinHashtag} ${randomHashtag}`.substring(0, 1995);

    const payload = {
        title: news.title.substring(0, 80),
        bodyTextOnly: finalPost,
        symbolList: [{ symbol: `${coinSymbol}USDT`, type: "FUTURES" }]
    };

    try {
        const response = await axios.post(SQUAD_ENDPOINT, payload, { 
            headers: { "X-Square-OpenAPI-Key": SQUAD_API_KEY, "Content-Type": "application/json" },
            timeout: 5000 
        });

        if (response.data.success || response.data.code === 0) {
            // Đăng thành công -> Lưu ngay vào Set() RAM và ghi thẳng xuống file JSON vĩnh viễn
            saveTitleToFile(cleanTitle);
            
            postCount++;
            addLog(`✅ Đăng bài [${typeToFetch}] thành công (${postCount}/50): ${news.title.substring(0, 25)}...`);
            
            rotateContentType();
        } else {
            addLog(`❌ Binance Square từ chối: ${JSON.stringify(response.data)}`);
        }
    } catch (e) {
        addLog(`❌ Lỗi kết nối API Binance: ${e.message}`);
    }
}

app.get('/', (req, res) => res.send(renderHTML()));
app.get('/logs', (req, res) => res.json(logs));
app.get('/start', (req, res) => { isRunning = true; addLog("Bật bot xoay tua"); runJob(); res.send("OK"); });
app.get('/stop', (req, res) => { isRunning = false; addLog("Tắt bot"); res.send("OK"); });
app.get('/test', async (req, res) => { addLog("Chạy thử lượt này..."); await runJob(); res.send("OK"); });

cron.schedule('*/15 * * * *', async () => {
    if (isRunning && postCount < 50) await runJob();
});

cron.schedule('0 7 * * *', () => {
    postCount = 0;
    addLog("⏰ Đã tới 7:00 sáng! Reset hạn ngạch về 0/50 bài cho ngày mới.");
});

app.listen(PORT, () => console.log('Server running on port ' + PORT));
