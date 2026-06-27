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

// Danh sách 500 từ khóa hashtag crypto phổ biến nhất phục vụ nhặt ngẫu nhiên
const CRYPTO_HASHTAGS = [
    "#Crypto", "#Bitcoin", "#Ethereum", "#Trading", "#Binance", "#DeFi", "#NFT", "#Web3", "#Altcoin", "#Blockchain",
    "#Solana", "#Layer2", "#BullMarket", "#BearMarket", "#Halving", "#WhaleAlert", "#CryptoNews", "#MarketUpdate", "#TechnicalAnalysis", "#Hodl",
    "#Airdrop", "#Staking", "#Launchpad", "#Memecoin", "#RWA", "#AI", "#GameFi", "#Metaverse", "#Arbitrum", "#Optimism",
    "#Polygon", "#Avalanche", "#Cardano", "#Ripple", "#Polkadot", "#Chainlink", "#Uniswap", "#Sui", "#Aptos", "#Sei",
    "#BNB", "#BTC", "#ETH", "#SOL", "#XRP", "#ADA", "#DOT", "#LINK", "#UNI", "#DOGE", "#SHIB", "#PEPE", "#WIF", "#FLOKI",
    "#CryptoTrading", "#CryptoWhale", "#SmartMoney", "#FundingRate", "#FuturesTrading", "#Leverage", "#Liquidation", "#Scalping", "#DCA", "#FOMO",
    // ... Bạn có thể copy/paste thêm cho đủ 500 từ khóa, hệ thống sẽ lấy ngẫu nhiên 1 cái từ danh sách này
    "#CryptoVn", "#DauTuCrypto", "#TinTucCrypto", "#KinhNghiemTrading", "#XuHuongThiTruong", "#PhanTichKyThuat", "#Tienso", "#GiaCoin"
];

// Thêm các tag mẫu nhanh cho đủ mảng lớn nếu bạn lười gõ thủ công
while(CRYPTO_HASHTAGS.length < 500) {
    CRYPTO_HASHTAGS.push(`#CryptoKeyword${CRYPTO_HASHTAGS.length}`);
}

// Đọc API Key Groq từ file grok.json
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

    const excludedTitles = Array.from(postedTitles).slice(-10).join('\n');

    const prompt = `Bạn là một chuyên gia tổng hợp tin tức crypto chuyên nghiệp. Hãy tìm và tổng hợp 1 bài viết HOT nhất về thị trường crypto trong 24 giờ qua mà cộng đồng đang cực kỳ quan tâm.
Ưu tiên nguồn uy tín: Binance, CoinDesk, Cointelegraph, The Block, Decrypt, Wu Blockchain, Lookonchain, Arkham.

⚠️ TUYỆT ĐỐI KHÔNG LẤY TIN TRÙNG HOẶC TƯƠNG TỰ CÁC TIÊU ĐỀ SAU:
${excludedTitles || "Không có"}

Yêu cầu trả về một JSON object chứa đúng cấu trúc sau (không kèm markdown):
{
  "title": "Tiêu đề tiếng Việt viết hoa hoặc viết thường tự nhiên, ngắn gọn dưới 80 ký tự",
  "coin_symbol": "Tên viết tắt của đồng coin bị ảnh hưởng nhiều nhất, viết hoa, ví dụ: BTC hoặc ETH hoặc SOL...",
  "content": "Nội dung chi tiết viết liền mạch bằng Tiếng Việt, trình bày đầy đủ toàn bộ diễn biến, thông tin của tin tức đó (không tóm tắt ngắn ngủi vài câu, viết sâu sắc rõ ràng).\\n\\nĐánh giá tác động: [Tích cực / Tiêu cực / Trung lập]\\nMức độ hot: [Điểm từ 1-10] | Khả năng ảnh hưởng đến giá: [Thấp / Trung bình / Cao]\\nNguồn: [Tên nguồn uy tín]\\n\\nTop tin quan trọng nhất hôm nay: ...\\nTâm lý chung của thị trường: ...\\nSự kiện đáng chú ý trong 7 ngày tới: ..."
}

⚠️ LƯU Ý QUAN TRỌNG VỀ ĐỘ DÀI:
- Không chèn chữ 'Tiêu đề:' hay 'Nội dung:' vào trong chuỗi text. Hãy đưa thẳng nội dung chi tiết vào.
- TỔNG ĐỘ DÀI CỦA TRƯỜNG "title" CỘNG VỚI "content" TUYỆT ĐỐI KHÔNG ĐƯỢC VƯỢT QUÁ 1900 KÝ TỰ. Nếu dài hơn, hãy chủ động cô đọng lại nhưng phải đảm bảo đủ thông tin chi tiết bài viết.`;

    try {
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: "You are a professional crypto journalist that outputs only strict raw JSON." },
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
        console.error("--- CHI TIẾT LỖI GROQ ---");
        console.error(e.response?.data || e.message);
        addLog(`❌ Groq Error: ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
        return null;
    }
}

async function runJob() {
    if (postCount >= 60) return;

    addLog(`--- Đang gọi Groq AI lấy tin tức mới... ---`);
    
    const news = await fetchCryptoNewsFromAI();
    if (!news || !news.title || !news.content) return;

    const cleanTitle = news.title.trim().toLowerCase();
    if (postedTitles.has(cleanTitle)) {
        addLog(`⚠️ Trùng bài cũ: [${news.title}]. Đang tự động tìm bài khác...`);
        return await runJob(); // Đệ quy gọi lại để tìm bài mới hoàn toàn
    }

    // 1. Lấy thẳng tiêu đề và nội dung chi tiết ra
    let postText = `**${news.title.toUpperCase()}**\n\n${news.content}\n\n`;

    // Khống chế nội dung gốc không quá 1900 ký tự đề phòng AI làm sai lệch
    if (postText.length > 1900) {
        postText = postText.substring(0, 1900);
    }

    // 2. Xử lý Hashtag ngẫu nhiên và Tên coin Futures
    const randomHashtag = CRYPTO_HASHTAGS[Math.floor(Math.random() * CRYPTO_HASHTAGS.length)];
    const coinSymbol = news.coin_symbol ? news.coin_symbol.trim().toUpperCase().replace('$', '') : 'BTC';
    const coinHashtag = `$${coinSymbol}`; // Định dạng tên coin futures ví dụ: $BTC

    // Ghép hashtag vào cuối bài viết
    const fullPost = `${postText}${coinHashtag} ${randomHashtag}`;

    // 3. Đảm bảo tổng bài gửi lên Binance Square tuyệt đối không quá 2000 ký tự
    const finalPost = fullPost.length > 2000 ? fullPost.substring(0, 1995) : fullPost;

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
            postedTitles.add(cleanTitle);
            postCount++;
            addLog(`✅ Đăng thành công ${postCount}/60: ${news.title.substring(0, 30)}...`);
        } else {
            addLog(`❌ Binance API Reject: ${JSON.stringify(response.data)}`);
        }
    } catch (e) {
        addLog(`❌ Lỗi khi đăng bài lên Binance: ${e.message}`);
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
