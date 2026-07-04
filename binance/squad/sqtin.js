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

// Nạp lịch sử chống trùng bài viết
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

// =========================================================================
// HỆ THỐNG BIG DATA: CÀO 5000+ TIN VÀ TRÍCH XUẤT 1 TIN ĐỘC BẢN CHƯA TỪNG ĐĂNG
// =========================================================================
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

    addLog("⚡ Đang kích hoạt cào dữ liệu quy mô lớn từ hệ thống 500+ nguồn tin...");
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

    // Loại bỏ tin trống hoặc lặp nội dung thô trong phiên
    let cleanPool = Array.from(new Set(allCollectedItems.filter(t => t.length > 10)));
    addLog(`📥 Tổng số lượng tin thô quét được trong pool: ${cleanPool.length} tin.`);

    // Xáo trộn ngẫu nhiên toàn bộ pool tin thô
    cleanPool.sort(() => 0.5 - Math.random());

    // CHỦ CHỐT: Duyệt qua pool và tìm ra ĐÚNG 1 TIN ĐẦU TIÊN hoàn toàn chưa dính dáng đến lịch sử bài đăng cũ
    for (const rawTitle of cleanPool) {
        const normalizedRaw = rawTitle.toLowerCase();
        
        let isMatchOld = false;
        for (const oldTitle of postedTitles) {
            // Nếu tiêu đề tin thô chứa tiêu đề bài viết cũ, hoặc bài viết cũ bao hàm từ khóa của tin thô -> bỏ qua
            if (oldTitle.includes(normalizedRaw) || normalizedRaw.includes(oldTitle)) {
                isMatchOld = true;
                break;
            }
        }

        if (!isMatchOld) {
            // Tìm thấy tin độc bản! Trả về làm nguyên liệu duy nhất cho AI viết bài
            return rawTitle;
        }
    }

    return null;
}

// Hàm gọi AI xử lý tin tức chính luận độc quyền từ 1 nguồn tin duy nhất
async function fetchCryptoContentFromAI() {
    if (!GROQ_API_KEY) {
        addLog("❌ Lỗi: Chưa cấu hình GROQ_API_KEY trong file grok.json");
        return null;
    }

    // Lấy ĐÚNG 1 TIN GỐC độc nhất chưa từng được khai thác
    const targetNews = await fetchSingleUniqueNews(); 
    if (!targetNews) {
        addLog("⚠️ Toàn bộ pool tin tức bị trùng hoặc không tìm thấy tin mới phù hợp. Bỏ qua lượt.");
        return null;
    }

    addLog(`🎯 Nguyên liệu độc bản được chọn cho lượt này: "${targetNews}"`);

    const prompt = `Bạn là Tổng biên tập của một tòa soạn tài chính quốc tế theo phong cách Reuters, Bloomberg và CNBC.
Nhiệm vụ của bạn là dựa vào ĐÚNG MỘT DÒNG TIN TỨC ĐẦU VÀO dưới đây để triển khai thành MỘT BÀI BÁO TIẾNG VIỆT phân tích hoàn chỉnh.

====================
TIN TỨC GỐC DUY NHẤT:
- ${targetNews}
====================

YÊU CẦU BẮT BUỘC VỀ NỘI DUNG:
1. Bạn phải bám sát chủ đề của tin tức gốc duy nhất được cung cấp ở trên để triển khai bài báo. Tuyệt đối KHÔNG được viết sang chủ đề khác (ví dụ: Tin gốc nói về Solana thì bài báo phải về Solana, không được viết về Fed hay Bitcoin).
2. Tuyệt đối KHÔNG được bịa thêm các dữ liệu cứng ngoài tin gốc: không tự ý thêm các con số phần trăm, số tiền cụ thể, ngày tháng cụ thể, tên nhân vật hoặc tên tổ chức mới nếu chúng không xuất hiện trong dòng tin tức gốc.
3. Nếu dòng tin gốc quá ngắn gọn, bạn được phép mở rộng bài viết bằng cách đưa ra các phân tích mang tính logic chung, phân tách các diễn biến và tác động tiềm năng một cách khách quan. Với những phần thiếu dữ liệu số liệu cụ thể, bắt buộc ghi rõ: "Hiện chưa có thêm số liệu xác nhận chi tiết từ nguồn cung cấp."
4. Văn phong chuẩn mực quốc tế: khách quan, chuyên nghiệp, không cảm xúc, không giật gân, không câu view, không dùng ngôi thứ nhất (tôi/mình), không ghi lời khuyên đầu tư.

====================
YÊU CẦU ĐỊNH DẠNG JSON (TRẢ VỀ RAW JSON, KHÔNG BỌC TRONG \`\`\`json VÀ KHÔNG CHỨA TEXT NGOÀI JSON):
{
  "title": "[Tiêu đề báo từ 45-80 ký tự, cấu trúc khách quan kiểu Reuters, phản ánh trực diện nội dung chính của tin gốc]",
  "coin_symbol": "BTC",
  "content": "[Toàn bộ nội dung bài báo, độ dài từ 800-1500 ký tự]"
}

⚠️ QUY ĐỊNH KHẮT KHE VỀ TRƯỜNG "content":
- Cấu trúc nội dung bắt buộc phải hiển thị đủ 4 phần: Tóm tắt sự kiện, Diễn biến chính, Phân tích tác động (tới Bitcoin, Ethereum, Altcoin, Thị trường tài chính), Kết luận.
- Phải chia bài thành nhiều đoạn văn ngắn, phân tách giữa các mục/các đoạn bằng chuỗi ký tự "\\n\\n". Tuyệt đối không bấm phím Enter bên trong chuỗi text.
- Chỉ sử dụng tối đa duy nhất 1 emoji phù hợp đặt ở đầu mỗi mục lớn.
- TUYỆT ĐỐI KHÔNG SỬ DỤNG định dạng Markdown: Không dùng dấu sao bôi đậm (**), không viết ký tự tiêu đề (#), không dùng các dấu gạch đầu dòng hay chấm tròn (-, *, •).`;

    try {
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" },
            messages: [
                { 
                    role: "system", 
                    content: `An international financial editor. Your highest priority is factual accuracy. Focus purely on the single provided news topic. Never invent hard data or numbers. Use only the supplied source material. Return raw valid JSON only. Layout constraints: NO markdown formatting, NO bolding (**), NO physical newlines inside strings.` 
                },
                { role: "user", content: prompt }
            ],
            temperature: 0.15,
            top_p: 0.2,
            frequency_penalty: 0.3, 
            presence_penalty: 0
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

// Hàm vận hành cốt lõi của Bot
async function runJob() {
    if (postCount >= 50) return;

    addLog(`🔄 Hệ thống bắt đầu quét dữ liệu và biên tập tin tức tài chính quốc tế...`);
    
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
        addLog(`⚠️ AI tạo tiêu đề xào nấu trùng bài cũ [${news.title}]. Hủy lượt đăng để bảo vệ hệ thống.`);
        return; 
    }

    let postText = `📰 ${news.title.toUpperCase()}\n\n${news.content}\n\n`;
    if (postText.length > 1900) postText = postText.substring(0, 1900);

    const coinSymbol = news.coin_symbol ? news.coin_symbol.trim().toUpperCase().replace('$', '') : 'BTC';
    const finalPost = `${postText}$${coinSymbol} #FinancialUpdate`.substring(0, 1995);

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

// Hệ thống giao diện điều khiển và thiết lập Cron định kỳ
app.get('/', (req, res) => res.send(`
    <!DOCTYPE html><html><body style="background:#111; color:#0f0; font-family:monospace; padding:20px;">
    <h1>Tòa Soạn Báo Điện Tử Quốc Tế AI (Độc Bản Hóa Tin Tức) - Port ${PORT}</h1>
    <button onclick="fetch('/start')" style="padding:10px; background:#222; color:#0f0; border:1px solid #0f0; cursor:pointer;">START BOT</button> 
    <button onclick="fetch('/stop')" style="padding:10px; background:#222; color:#f00; border:1px solid #f00; cursor:pointer;">STOP BOT</button> 
    <button onclick="fetch('/test')" style="padding:10px; background:#222; color:#ff0; border:1px solid #ff0; cursor:pointer;">TEST XUẤT BẢN NGAY</button>
    <div id="l" style="background:#000; padding:10px; height:450px; overflow-y:scroll; margin-top:20px; border:1px dashed #0f0;"></div>
    <script>setInterval(()=>{fetch('/logs').then=r=>r.json()).then(d=>{document.getElementById('l').innerHTML=d.join('<br>')})},2000);</script>
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
