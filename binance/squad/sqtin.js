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

// Trạng thái xoay tua 4 thể loại đan xen: 'NEWS_CRYPTO' -> 'NEWS_POLITICS' -> 'FUNNY_STORY' -> 'SAD_STORY'
let currentType = 'NEWS_CRYPTO'; 

const TITLE_FILE = path.resolve('./posted_titles.json');
let postedTitles = new Set();

// Tự động nạp lại lịch sử chống trùng từ file JSON vĩnh viễn khi chạy bot
try {
    if (fs.existsSync(TITLE_FILE)) {
        const savedTitles = JSON.parse(fs.readFileSync(TITLE_FILE, 'utf8'));
        postedTitles = new Set(savedTitles.map(t => t.trim().toLowerCase()));
        console.log(`💾 Hệ thống khôi phục: Khóa trùng thành công ${postedTitles.size} bài viết từ quá khứ.`);
    }
} catch (e) {
    console.error("❌ Không thể đọc file lưu trữ tiêu đề:", e.message);
}

function saveTitleToFile(newTitle) {
    try {
        postedTitles.add(newTitle.trim().toLowerCase());
        const titlesArray = Array.from(postedTitles);
        fs.writeFileSync(TITLE_FILE, JSON.stringify(titlesArray, null, 2), 'utf8');
    } catch (e) {
        console.error("❌ Lỗi lưu tiêu đề xuống file JSON:", e.message);
    }
}

// Bộ hashtag ngẫu nhiên gồm 500 từ khóa crypto phổ biến
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
    <h1>Bot AI Báo Chí Đan Xen 4 Nhóm - ${isRunning ? 'RUNNING' : 'STOPPED'}</h1>
    <div>
        <button onclick="fetch('/start').then(()=>location.reload())" style="padding:15px; background:green; color:white; cursor:pointer;">START</button>
        <button onclick="fetch('/stop').then(()=>location.reload())" style="padding:15px; background:red; color:white; cursor:pointer;">STOP</button>
        <button onclick="fetch('/test').then(()=>location.reload())" style="padding:15px; background:yellow; color:black; cursor:pointer;">TEST TIẾP THEO</button>
    </div>
    <p>Đã đăng hôm nay: ${postCount}/50 | Luồng bài tiếp theo: <b style="color:#fff;">${currentType}</b> | Bộ nhớ chống trùng vĩnh viễn: ${postedTitles.size}</p>
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

// Xoay tua vòng tròn 4 thể loại bài đăng
function rotateContentType() {
    if (currentType === 'NEWS_CRYPTO') {
        currentType = 'NEWS_POLITICS';
    } else if (currentType === 'NEWS_POLITICS') {
        currentType = 'FUNNY_STORY';
    } else if (currentType === 'FUNNY_STORY') {
        currentType = 'SAD_STORY';
    } else {
        currentType = 'NEWS_CRYPTO';
    }
}

async function fetchCryptoContentFromAI(type) {
    if (!GROQ_API_KEY) {
        addLog("❌ Thiếu API Key trong grok.json!");
        return null;
    }

    const excludedTitles = Array.from(postedTitles).slice(-15).join('\n');
    const randomSeed = Math.floor(Math.random() * 10000);

    let dynamicPrompt = "";
    if (type === 'NEWS_CRYPTO') {
        dynamicPrompt = `Viết một bài báo nóng luận bàn về tin tức chấn động, HOT nhất thị trường Crypto trong 24 giờ qua. Yêu cầu hành văn sắc sảo, chuyên sâu như một phóng viên tài chính quốc tế chuyên nghiệp.`;
    } else if (type === 'NEWS_POLITICS') {
        dynamicPrompt = `Viết một bài phân tích báo chí chính luận bàn về tin tức chính trị thế giới, diễn biến chiến sự/xung đột kinh tế, động thái của các nguyên thủ toàn cầu (như Donald Trump, CZ, FED, phố Wall...). Khai thác sâu khía cạnh những biến động này tác động ngầm thế nào đến dòng tiền vĩ mô và crypto.`;
    } else if (type === 'FUNNY_STORY') {
        dynamicPrompt = `Sáng tác một bài viết mang văn phong tự sự báo chí/phóng sự, ghi lại câu chuyện tréo ngoe đầy hài hước, châm biếm, dở khóc dở cười của một tay chơi/trader crypto trên thị trường. Câu chuyện phải mang tính độc bản, bối cảnh đặc sắc. Mã hạt giống: ${randomSeed}.`;
    } else if (type === 'SAD_STORY') {
        dynamicPrompt = `Sáng tác một bài viết dạng phóng sự tâm sự, lột tả câu chuyện buồn cay đắng, những góc khuất, bi kịch hay bài học xương máu có thật/gợi ý trong giới trading (cháy tài khoản, áp lực nợ nần, sai lầm tâm lý). Lối viết sâu sắc chạm đáy cảm xúc người đọc. Mã hạt giống: ${randomSeed}.`;
    }

    const prompt = `Bạn là một nhà báo kỳ cựu kiêm nhà phân tích kinh tế chính trị lỗi lạc.
${dynamicPrompt}

⚠️ CẤM TUYỆT ĐỐI SỬ DỤNG LẠI HOẶC TRÙNG LẶP Ý TƯỞNG VỚI CÁC TIÊU ĐỀ SAU:
${excludedTitles || "Không có"}

Yêu cầu trả về một JSON object có định dạng cấu trúc nghiêm ngặt (không bọc markdown \`\`\`json).
Nội dung của "content" phải nằm trọn vẹn trong một cặp dấu ngoặc kép duy nhất. Không được xuống dòng thực tế bên trong chuỗi json, nếu muốn xuống dòng hãy dùng ký tự "\\n\\n".

CẤU TRÚC MẪU BẮT BUỘC KHÔNG ĐƯỢC SAI LỆCH:
{
  "title": "Tiêu đề bài báo mang phong cách giật gân, chấn động, sâu sắc hoặc sốc đánh mạnh vào tâm lý người đọc (dưới 80 ký tự)",
  "coin_symbol": "BTC",
  "content": "Dòng mở đầu bài báo sắc bén đầy cuốn hút.\\n\\n📢 Ý chính thứ nhất bắt đầu tại đây với icon đầu dòng để phân rõ luận điểm.\\n\\n📉 Ý chính thứ hai phân tích sâu về số liệu và bài học thực tế liên quan."
}

⚠️ QUY ĐỊNH VỀ NỘI DUNG VÀ ĐỊNH DẠNG:
1. "content" phải viết theo dạng BÀI BÁO PHÓNG SỰ chi tiết, đầy đủ thông tin bằng Tiếng Việt.
2. Các đoạn văn trong "content" phải được phân tách rõ ràng bằng ký tự "\\n\\n", TUYỆT ĐỐI không viết dính liền tù tì thành một cục.
3. CHỈ sử dụng icon cảm xúc (emoji) ở đầu mỗi ý chính, luận điểm lớn hoặc tiêu đề phụ bên trong (tối đa 3-4 icon toàn bài). Tuyệt đối KHÔNG chèn icon tràn lan ở mọi dòng.
4. Không chèn các chữ thừa thãi như 'Tiêu đề' hay 'Nội dung' vào phần text.
5. TỔNG KÝ TỰ CỦA TRƯỜNG "title" + "content" KHÔNG VƯỢT QUÁ 1900 KÝ TỰ.`;

    try {
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: "You are an elite journalist. You must output raw JSON only. Ensure the 'content' field is a single, valid JSON-escaped string enclosed in double quotes with no literal newlines." },
                { role: "user", content: prompt }
            ],
            temperature: 0.82
        }, {
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 25000
        });

        const rawText = response.data.choices[0].message.content.trim();
        return JSON.parse(rawText);

    } catch (e) {
        if (e instanceof SyntaxError) {
            addLog(`⚠️ AI trả về JSON lỗi cấu trúc chuỗi. Bỏ qua lượt này để tránh nghẽn hệ thống.`);
        } else {
            console.error(e.response?.data || e.message);
            addLog(`❌ Lỗi kết nối Groq [${type}]: ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
        }
        return null;
    }
}

async function runJob() {
    if (postCount >= 50) {
        addLog(`📢 Đã đạt giới hạn tối đa 50 bài đăng của ngày hôm nay. Đang chờ reset lúc 7h sáng.`);
        return;
    }

    const typeToFetch = currentType;
    addLog(`--- Hệ thống đang khởi tạo bài viết nhóm: [${typeToFetch}] ---`);
    
    const news = await fetchCryptoContentFromAI(typeToFetch);
    if (!news || !news.title || !news.content) return;

    const cleanTitle = news.title.trim().toLowerCase();
    
    // Kiểm tra trùng khớp tiêu đề tuyệt đối (Lớp RAM + File JSON)
    if (postedTitles.has(cleanTitle)) {
        addLog(`⚠️ Phát hiện tiêu đề bị trùng lặp: [${news.title}]. Huỷ đăng, đang kích hoạt đệ quy tìm bài khác...`);
        return await runJob(); 
    }

    // Thiết lập cấu trúc hiển thị sạch: Tiêu đề in hoa bôi đậm + Nội dung phóng sự báo chí phân đoạn xuống dòng
    let postText = `🚨 **${news.title.toUpperCase()}**\n\n${news.content}\n\n`;

    if (postText.length > 1900) {
        postText = postText.substring(0, 1900);
    }

    // Xử lý gắn định dạng Hashtag cuối bài
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
            // Đồng bộ hoá lưu file chống trùng vĩnh viễn
            saveTitleToFile(cleanTitle);
            
            postCount++;
            addLog(`✅ Xuất bản [${typeToFetch}] thành công (${postCount}/50): ${news.title.substring(0, 30)}...`);
            
            // Xoay luồng sang nhóm bài tiếp theo sau khi đăng thành công
            rotateContentType();
        } else {
            addLog(`❌ API Binance từ chối bài viết: ${JSON.stringify(response.data)}`);
        }
    } catch (e) {
        addLog(`❌ Lỗi kết nối hệ thống Binance API: ${e.message}`);
    }
}

// ROUTERS ĐIỀU KHIỂN WEB UI
app.get('/', (req, res) => res.send(renderHTML()));
app.get('/logs', (req, res) => res.json(logs));
app.get('/start', (req, res) => { isRunning = true; addLog("Bật hệ thống bot xoay tua 4 luồng"); runJob(); res.send("OK"); });
app.get('/stop', (req, res) => { isRunning = false; addLog("Tắt bot điều hướng"); res.send("OK"); });
app.get('/test', async (req, res) => { addLog("Chạy kiểm tra thủ công lượt tiếp theo..."); await runJob(); res.send("OK"); });

// Định kỳ kích hoạt gửi bài mỗi 15 phút
cron.schedule('*/15 * * * *', async () => {
    if (isRunning && postCount < 50) await runJob();
});

// Khóa thời gian tự động reset giới hạn bài đăng vào lúc đúng 07:00 Sáng hàng ngày
cron.schedule('0 7 * * *', () => {
    postCount = 0;
    addLog("⏰ Chu kỳ mới! Hệ thống đã tự động reset hạn ngạch đăng bài (0/50).");
});

app.listen(PORT, () => console.log('Hệ thống bot tin tức báo chí đang chạy tại cổng: ' + PORT));
