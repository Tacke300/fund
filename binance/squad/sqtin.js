import express from 'express';
import axios from 'axios';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import Parser from 'rss-parser';

const app = express();
const PORT = 9999;
const parser = new Parser({
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeout: 5000
});

const SQUAD_API_KEY = "8d794c11cc794c958c2c65924c54f2dd";
const SQUAD_ENDPOINT = "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add";

let isRunning = false;
let postCount = 0;
let logs = [];

const TITLE_FILE = path.resolve('./posted_titles.json');
let postedTitles = new Set();

// Nạp lịch sử chống trùng
try {
    if (fs.existsSync(TITLE_FILE)) {
        const savedTitles = JSON.parse(fs.readFileSync(TITLE_FILE, 'utf8'));
        postedTitles = new Set(savedTitles.map(t => t.trim().toLowerCase()));
        console.log(`💾 Hệ thống khôi phục: Khóa trùng thành công ${postedTitles.size} bài viết.`);
    }
} catch (e) { 
    console.error("❌ Lỗi nạp file chống trùng:", e.message); 
}

function saveTitleToFile(newTitle) {
    try {
        postedTitles.add(newTitle.trim().toLowerCase());
        fs.writeFileSync(TITLE_FILE, JSON.stringify(Array.from(postedTitles), null, 2), 'utf8');
    } catch (e) { 
        console.error("❌ Lỗi lưu file JSON:", e.message); 
    }
}

let GROQ_API_KEY = "";
try {
    const grokConfig = JSON.parse(fs.readFileSync(path.resolve('./grok.json'), 'utf8'));
    GROQ_API_KEY = grokConfig.apiKey;
} catch (error) { 
    console.error("❌ Thiếu apiKey trong grok.json!"); 
}

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] ${msg}`;
    logs.unshift(entry);
    if (logs.length > 50) logs.pop();
    console.log(entry);
}

// Cào tin tức và trích xuất 1 tin độc bản chưa từng đăng
async function fetchSingleUniqueNews() {
    const RSS_HUBS = [
        'https://cryptopanic.com/news/rss/',
        'https://cointelegraph.com/rss',
        'https://www.coindesk.com/arc/outboundfeed/rss/',
        'https://bitcoinmagazine.com/.rss/full/',
        'https://cryptoslate.com/feed/',
        'https://www.newsbtc.com/feed/',
        'https://finance.yahoo.com/news/rssindex',
        'https://www.cnbc.com/id/10000664/device/rss/rss.html',
        'https://www.cnbc.com/id/15839076/device/rss/rss.html',
        'https://www.investing.com/rss/news.rss',
        'https://www.marketwatch.com/rss/topstories'
    ];

    const SEARCH_MATRICES = [
        'crypto+regulation+sec+binance+etf',
        'bitcoin+halving+miner+microstrategy',
        'fed+powell+fomc+inflation+cpi+interest',
        'ethereum+vitalik+layer2+arbitrum+base',
        'solana+memecoin+dex+volume+raydium',
        'whale+liquidation+dump+pump+hack',
        'ai+web3+nvidia+render+tokenomics',
        'usdt+usdc+tether+stablecoin+depeg',
        'stocks+nasdaq+gold+dxy+macro',
        'asia+china+hk+crypto+policy+stimulus'
    ];

    addLog("⚡ Đang cào dữ liệu từ hệ thống nguồn tin...");
    let allCollectedItems = [];

    const hubPromises = RSS_HUBS.map(async (url) => {
        try {
            const feed = await parser.parseURL(url);
            return feed.items.map(item => item.title ? item.title.trim() : '');
        } catch (e) { return []; }
    });

    const shuffledMatrices = SEARCH_MATRICES.sort(() => 0.5 - Math.random()).slice(0, 4);
    const matrixPromises = shuffledMatrices.map(async (keyword) => {
        try {
            const url = `https://news.google.com/rss/search?q=${keyword}&hl=en-US&gl=US&ceid=US:en`;
            const feed = await parser.parseURL(url);
            return feed.items.map(item => item.title ? item.title.trim() : '');
        } catch (e) { return []; }
    });

    const results = await Promise.all([...hubPromises, ...matrixPromises]);
    for (const list of results) { allCollectedItems.push(...list); }

    let cleanPool = Array.from(new Set(allCollectedItems.filter(t => t.length > 10)));
    cleanPool.sort(() => 0.5 - Math.random());

    for (const rawTitle of cleanPool) {
        const normalizedRaw = rawTitle.toLowerCase();
        let isMatchOld = false;
        for (const oldTitle of postedTitles) {
            if (oldTitle.includes(normalizedRaw) || normalizedRaw.includes(oldTitle)) {
                isMatchOld = true;
                break;
            }
        }
        if (!isMatchOld) return rawTitle;
    }
    return null;
}

// Gọi AI xử lý tin tức - CHI TIẾT ĐÚNG TRỌNG TÂM, ĐẠT 2000 KÝ TỰ
async function fetchCryptoContentFromAI() {
    if (!GROQ_API_KEY) return null;

    const targetNews = await fetchSingleUniqueNews(); 
    if (!targetNews) {
        addLog("⚠️ Pool tin tức bị trùng hoặc không có tin mới. Bỏ qua lượt.");
        return null;
    }

    addLog(`🎯 Tin gốc nhận được: "${targetNews}"`);

    // CẢI TIẾN PROMPT: Ép độ dài chi tiết nhưng KHÔNG CHO PHÉP nói tào lao ngoài chủ đề
    const prompt = `Bạn là phóng viên điều tra tài chính cao cấp của hãng thông tấn quốc tế Reuters và Bloomberg.
Nhiệm vụ của bạn là dựa vào dòng tin tức tiếng Anh dưới đây để triển khai thành một bài báo tiếng Việt tường thuật chi tiết, sâu sắc.

====================
TIN GỐC BẮT BUỘC:
- ${targetNews}
====================

QUY ĐỊNH VỀ NỘI DUNG VÀ ĐỘ DÀI (BẮT BUỘC):
1. Bài viết phải xoay quanh 100% chủ đề của dòng tin gốc. Tuyệt đối KHÔNG viết lan man sang phân tích vĩ mô, KHÔNG tự bịa ra các dự đoán giá tài sản tương lai vô căn cứ, KHÔNG đưa ra lời khuyên đầu tư sáo rỗng. Dẹp bỏ kiểu viết mông lung "điều này tạo ra một hiệu ứng tích cực... nhưng cũng cần xem xét...".
2. Để bài viết dài dặn, bạn hãy tập trung TƯỜNG THUẬT CHI TIẾT bản chất của sự kiện: Ai là người thực hiện, bối cảnh diễn ra là gì, các bên liên quan đã có động thái phản ứng hay tuyên bố cụ thể như thế nào, cấu trúc logic của sự việc đó diễn biến ra sao. Hãy dùng câu chữ chuyên nghiệp, lập luận chặt chẽ để kéo dài nội dung dựa trên nền tảng của tin gốc.
3. Trường "content" phải được viết dài, chi tiết, phân tách thành 3 đến 4 đoạn văn bằng chuỗi ký tự "\\n\\n". Tuyệt đối không viết dăm ba câu ngắn ngủi. Bạn phải viết làm sao để tổng độ dài của trường "content" đạt từ 1600 đến 1800 ký tự (để khi kết hợp với tiêu đề và tag sẽ đạt tổng 2000 ký tự).
4. KHÔNG SỬ DỤNG các định dạng Markdown (như bôi đậm **, dấu gạch đầu dòng -, chấm tròn, hoặc ký tự #). KHÔNG bấm phím Enter vật lý xuống dòng trong chuỗi văn bản của "content". KHÔNG sử dụng emoji.

====================
YÊU CẦU ĐỊNH DẠNG JSON (TRẢ VỀ RAW JSON, KHÔNG BỌC TRONG \`\`\`json VÀ KHÔNG CHỨA TEXT NGOÀI JSON):
{
  "title": "[Tiêu đề báo từ 45-80 ký tự, cấu trúc nghiêm túc, phản ánh trực diện nội dung chính của tin gốc]",
  "coin_symbol": "BTC",
  "content": "[Văn bản nội dung tường thuật chi tiết, dài từ 1600-1800 ký tự, chia thành các đoạn văn rõ ràng bằng chuỗi \\n\\n, bám sát 100% thực tế sự kiện tin gốc]"
}`;

    try {
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" },
            messages: [
                { 
                    role: "system", 
                    content: `You are a financial journalist. Tightly expand and investigate the single provided news topic in Vietnamese. Write a long, detailed narrative report (1600-1800 characters) focusing strictly on the event itself. No generic filler, no prediction. No markdown. Return raw valid JSON only.` 
                },
                { role: "user", content: prompt }
            ],
            temperature: 0.2, // Tăng nhẹ một chút để AI có không gian sử dụng từ ngữ tường thuật chi tiết
            top_p: 0.3,
            frequency_penalty: 0.2, 
            presence_penalty: 0.1
        }, {
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 25000
        });

        const rawText = response.data.choices[0].message.content.trim();
        return JSON.parse(rawText);
    } catch (e) {
        addLog(`❌ Lỗi hệ thống AI hoặc lỗi cú pháp: ${e.message}`);
        return null;
    }
}

// Vận hành cốt lõi của Bot
async function runJob() {
    if (postCount >= 50) return;

    addLog(`🔄 Hệ thống bắt đầu quét dữ liệu và biên tập tin bài chi tiết...`);
    
    const news = await fetchCryptoContentFromAI();
    if (!news || !news.title || !news.content) return;

    const cleanTitle = news.title.trim().toLowerCase();
    
    let isDuplicated = postedTitles.has(cleanTitle);
    if (!isDuplicated) {
        for (const oldTitle of postedTitles) {
            if (oldTitle.includes(cleanTitle) || cleanTitle.includes(oldTitle)) {
                isDuplicated = true;
                break;
            }
        }
    }

    if (isDuplicated) {
        addLog(`⚠️ Tiêu đề trùng bài cũ [${news.title}]. Hủy lượt.`);
        return; 
    }

    // Thiết lập format bài viết chuẩn chỉnh dài dặn để gửi đi
    let postText = `📰 ${news.title.toUpperCase()}\n\n${news.content}\n\n`;

    const coinSymbol = news.coin_symbol ? news.coin_symbol.trim().toUpperCase().replace('$', '') : 'BTC';
    
    // Gộp tổng thể bao gồm Tiêu đề + Nội dung + Thẻ Tag để ép độ dài chuẩn xác
    let finalPost = `${postText}$${coinSymbol} #FinancialUpdate #CryptoNews #MarketReport`;
    
    // Khống chế trần của Binance API (tối đa 1995 ký tự)
    if (finalPost.length > 1995) {
        finalPost = finalPost.substring(0, 1990) + "...";
    }

    addLog(`📊 Tổng độ dài bài viết chuẩn bị đăng: ${finalPost.length} ký tự.`);

    const payload = {
        title: news.title.substring(0, 80),
        bodyTextOnly: finalPost,
        symbolList: [{ symbol: `${coinSymbol}USDT`, type: "FUTURES" }]
    };

    try {
        const response = await axios.post(SQUAD_ENDPOINT, payload, { 
            headers: { "X-Square-OpenAPI-Key": SQUAD_API_KEY, "Content-Type": "application/json" },
            timeout: 6000 
        });

        if (response.data.success || response.data.code === 0) {
            saveTitleToFile(cleanTitle);
            postCount++;
            addLog(`✅ Xuất bản bài báo thành công: ${news.title}`);
        } else {
            addLog(`❌ Binance Square từ chối tin đăng: ${JSON.stringify(response.data)}`);
        }
    } catch (e) { 
        addLog(`❌ Lỗi kết nối đầu ra API Binance: ${e.message}`); 
    }
}

// Hệ thống giao diện điều khiển
app.get('/', (req, res) => res.send(`
    <!DOCTYPE html><html><body style="background:#111; color:#0f0; font-family:monospace; padding:20px;">
    <h1>Tòa Soạn Tin Tức AI (Tường Thuật Chi Tiết ~2000 Ký Tự) - Port ${PORT}</h1>
    <button onclick="fetch('/start')" style="padding:10px; background:#222; color:#0f0; border:1px solid #0f0; cursor:pointer;">START BOT</button> 
    <button onclick="fetch('/stop')" style="padding:10px; background:#222; color:#f00; border:1px solid #f00; cursor:pointer;">STOP BOT</button> 
    <button onclick="fetch('/test')" style="padding:10px; background:#222; color:#ff0; border:1px solid #ff0; cursor:pointer;">TEST XUẤT BẢN NGAY</button>
    <div id="l" style="background:#000; padding:10px; height:450px; overflow-y:scroll; margin-top:20px; border:1px dashed #0f0;"></div>
    <script>setInterval(()=>{fetch('/logs').then(r=>r.json()).then(d=>{document.getElementById('l').innerHTML=d.join('<br>')})},2000);</script>
    </body></html>
`));

app.get('/logs', (req, res) => res.json(logs));
app.get('/start', (req, res) => { isRunning = true; runJob(); res.send("BOT STARTED"); });
app.get('/stop', (req, res) => { isRunning = false; res.send("BOT STOPPED"); });
app.get('/test', async (req, res) => { await runJob(); res.send("TEST RUN COMPLETED"); });

cron.schedule('*/15 * * * *', async () => { 
    if (isRunning) await runJob(); 
});

cron.schedule('0 7 * * *', () => { 
    postCount = 0; 
});

app.listen(PORT, () => console.log('Hệ thống tòa soạn báo AI vận hành ổn định tại cổng: ' + PORT));
