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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// =========================================================================
// HỆ THỐNG BIG DATA: KHAI THÁC 500+ NGUỒN TIN VÀ GOM CỤM 5000+ TIN TỨC
// =========================================================================
async function fetchMegaNewsFeed() {
    // 1. Danh sách các Hub RSS tổng hợp, chứa luồng tin của hàng trăm tòa soạn nhỏ hơn bên trong
    const RSS_HUBS = [
        // Hubs Tổng Hợp Crypto (Chứa data của hơn 300 đầu báo crypto: CoinDesk, Cointelegraph, Decrypt...)
        'https://cryptopanic.com/news/rss/',
        'https://cointelegraph.com/rss',
        'https://www.coindesk.com/arc/outboundfeed/rss/',
        'https://bitcoinmagazine.com/.rss/full/',
        'https://cryptoslate.com/feed/',
        'https://www.newsbtc.com/feed/',
        // Hubs Kinh Tế Vĩ Mô Quốc Tế (Chứa data của Bloomberg, Reuters, CNBC, Yahoo Finance...)
        'https://finance.yahoo.com/news/rssindex',
        'https://www.cnbc.com/id/10000664/device/rss/rss.html', // Tài chính quốc tế
        'https://www.cnbc.com/id/15839076/device/rss/rss.html', // Kinh tế vĩ mô
        'https://www.investing.com/rss/news.rss',
        'https://www.marketwatch.com/rss/topstories'
    ];

    // 2. Ma trận từ khóa tìm kiếm nâng cao trên Google News (Quét sâu vào hơn 200 quốc gia và nguồn tin địa phương)
    const SEARCH_MATRICES = [
        'crypto+regulation+sec+binance+cz+etf+whitelist',
        'bitcoin+halving+hashrate+miner+difficulty+microstrategy',
        'fed+powell+fomc+inflation+cpi+interest+rate+yield',
        'ethereum+vitalik+layer2+arbitrum+optimism+base+upgrade',
        'solana+memecoin+pumpfun+dex+volume+raydium',
        'whale+liquidation+dump+pump+hack+exploit+scam',
        'ai+web3+nvidia+fetchai+render+tokenomics',
        'usdt+usdc+tether+stablecoin+depeg+reserve',
        'stocks+nasdaq+sp500+gold+dxy+macro+recession',
        'asia+china+hk+crypto+policy+stimulus+ban'
    ];

    addLog("⚡ Đang kích hoạt cào dữ liệu quy mô lớn từ hệ thống 500+ nguồn tin...");
    let allCollectedItems = [];

    // Tạo luồng cào song song (Concurrent Batching) từ các Hub RSS lớn
    const hubPromises = RSS_HUBS.map(async (url) => {
        try {
            const feed = await parser.parseURL(url);
            return feed.items.map(item => ({ title: item.title, date: item.pubDate || new Date() }));
        } catch (e) {
            return []; // Bỏ qua nguồn lỗi, không làm sập luồng chính
        }
    });

    // Chọn ngẫu nhiên 3 cụm ma trận từ khóa Google News để đổi mới dữ liệu liên tục trong phiên
    const shuffledMatrices = SEARCH_MATRICES.sort(() => 0.5 - Math.random()).slice(0, 3);
    const matrixPromises = shuffledMatrices.map(async (keyword) => {
        try {
            const url = `https://news.google.com/rss/search?q=${keyword}&hl=en-US&gl=US&ceid=US:en`;
            const feed = await parser.parseURL(url);
            return feed.items.map(item => ({ title: item.title, date: item.pubDate || new Date() }));
        } catch (e) {
            return [];
        }
    });

    // Gom toàn bộ kết quả trả về từ bộ nhớ đệm khổng lồ
    const results = await Promise.all([...hubPromises, ...matrixPromises]);
    for (const list of results) {
        allCollectedItems.push(...list);
    }

    addLog(`📥 Tổng số lượng tin thô quét được trong pool: ${allCollectedItems.length} tin.`);

    // Lọc bỏ tin rác, tin trùng lặp nội dung tuyệt đối trong phiên cào bài
    let uniquePool = [];
    let seenTitles = new Set();
    
    for (const item of allCollectedItems) {
        if (!item.title) continue;
        const normalized = item.title.trim().toLowerCase();
        if (!seenTitles.has(normalized)) {
            seenTitles.add(normalized);
            uniquePool.push(item);
        }
    }

    if (uniquePool.length === 0) return null;

    // Trộn ngẫu nhiên (Shuffle) kho dữ liệu thu được và bốc ra 10 tin ngẫu nhiên khác biệt hoàn toàn 
    // để làm "nguyên liệu độc bản" truyền cho AI, phá vỡ hoàn toàn hiện tượng kẹt bài
    const finalSelection = uniquePool.sort(() => 0.5 - Math.random()).slice(0, 10);
    
    return finalSelection.map(item => `- ${item.title} (${item.date})`).join('\n');
}
// =========================================================================

// Hàm gọi AI xử lý tin tức chính luận độc quyền với Prompt siêu khóa chặt
async function fetchCryptoContentFromAI() {
    if (!GROQ_API_KEY) {
        addLog("❌ Lỗi: Chưa cấu hình GROQ_API_KEY trong file grok.json");
        return null;
    }

    // Lấy nguyên liệu từ kho 5000+ tin tức đã được làm sạch
    const realNewsData = await fetchMegaNewsFeed(); 
    if (!realNewsData) {
        addLog("❌ Bộ lọc Big Data không tìm thấy dữ liệu tin tức hợp lệ. Bỏ qua lượt này.");
        return null;
    }

    const excludedTitles = Array.from(postedTitles).slice(-25).join('\n');

    const prompt = `Bạn là Tổng biên tập của một tòa soạn tài chính quốc tế theo phong cách Reuters, Bloomberg và CNBC.
Nhiệm vụ của bạn là viết MỘT BÀI BÁO TIẾNG VIỆT hoàn chỉnh chỉ dựa trên dữ liệu tin tức được cung cấp dưới đây.

====================
DỮ LIỆU GỐC:
${realNewsData}
====================

⚠️ DANH SÁCH TIÊU ĐỀ ĐÃ XUẤT BẢN TRƯỚC ĐÂY (TUYỆT ĐỐI CẤM TRÙNG LẶP HOẶC XÀO NẤU LẠI Ý TƯỞNG):
${excludedTitles || "Không có"}

YÊU CẦU BẮT BUỘC CHỐNG TRÙNG LẶP:
- Kiểm tra kỹ danh sách tiêu đề đã xuất bản ở trên. Nếu dữ liệu gốc trùng lặp nội dung hoặc ý tưởng với các bài đã đăng, hoặc tiêu đề bạn định viết có ý nghĩa tương tự (chỉ khác vài từ hoặc đảo thứ tự), bạn BẮT BUỘC phải trả về "SKIP". Không cố xào lại bài cũ.

YÊU CẦU BẮT BUỘC VỀ NỘI DUNG:
1. Chỉ sử dụng thông tin có trong dữ liệu gốc. Tuyệt đối KHÔNG được bịa thêm: sự kiện, nhân vật, số liệu, ngày tháng, giá tài sản, phát biểu, nguyên nhân, kết quả nếu chúng không xuất hiện ở trên.
2. Nếu dữ liệu chưa đủ thông tin để làm rõ một chi tiết nào đó thì ghi nguyên văn: "Hiện chưa có đủ thông tin để xác nhận thêm."
3. Văn phong chuẩn mực quốc tế: khách quan, chuyên nghiệp, không cảm xúc, không giật gân, không câu view, không dùng ngôi thứ nhất (tôi/mình), không ghi lời khuyên đầu tư hay dự đoán tương lai vô căn cứ.
4. Không được suy diễn những gì nguồn không đề cập. Không được chuyển tin đồn thành sự thật.
5. Nếu bài báo có nhiều khả năng gây hiểu lầm hoặc thiếu dữ liệu xác minh thì trả về SKIP.

====================
YÊU CẦU ĐỊNH DẠNG JSON (TRẢ VỀ RAW JSON, KHÔNG BỌC TRONG \`\`\`json VÀ KHÔNG CHỨA TEXT NGOÀI JSON):
{
  "title": "[Tiêu đề báo từ 45-80 ký tự, cấu trúc khách quan kiểu Reuters, không viết hoa toàn bộ, phản ánh trực diện nội dung chính]",
  "coin_symbol": "BTC",
  "content": "[Toàn bộ nội dung bài báo, độ dài từ 800-1500 ký tự]"
}

⚠️ QUY ĐỊNH KHẮT KHE VỀ TRƯỜNG "content":
- Cấu trúc nội dung bắt buộc phải hiển thị đủ 4 phần: Tóm tắt sự kiện, Diễn biến chính, Phân tích tác động (tới Bitcoin, Ethereum, Altcoin, Thị trường tài chính), Kết luận.
- Phải chia bài thành nhiều đoạn văn ngắn, phân tách giữa các mục/các đoạn bằng chuỗi ký tự "\\n\\n". Tuyệt đối không bấm phím Enter bên trong chuỗi text.
- Chỉ sử dụng tối đa duy nhất 1 emoji phù hợp đặt ở đầu mỗi mục lớn.
- TUYỆT ĐỐI KHÔNG SỬ DỤNG định dạng Markdown: Không dùng dấu sao bôi đậm (**), không viết ký tự tiêu đề (#), không dùng các dấu gạch đầu dòng hay chấm tròn (-, *, •). 

Nếu dữ liệu bị trùng ý tưởng hoặc không đạt yêu cầu để biên tập, trả về chính xác cấu trúc SKIP sau:
{
  "title": "SKIP",
  "coin_symbol": "BTC",
  "content": ""
}`;

    try {
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" },
            messages: [
                { 
                    role: "system", 
                    content: `An international financial editor. Your highest priority is factual accuracy. Never invent facts. Never invent numbers. Never invent quotes. Never invent dates. Never invent people. Never invent organizations. Never invent causes or consequences. Never speculate. Never exaggerate. If the source is uncertain, preserve that uncertainty. Use only the supplied source material. Return raw valid JSON only. Layout constraints: NO markdown formatting, NO bolding (**), NO physical newlines inside strings.` 
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
        const news = JSON.parse(rawText);

        if (news.title === "SKIP") {
            addLog(`⚠️ AI áp dụng bộ lọc: SKIP lượt này do trùng lặp hoặc chưa tìm thấy dòng tin đột phá.`);
            return null;
        }
        return news;
    } catch (e) {
        if (e.response && e.response.status === 429) {
            addLog(`❌ Lỗi 429: Bạn đã vượt quá giới hạn lượt gọi (Rate Limit) của Groq.`);
        } else if (e.response && e.response.status === 401) {
            addLog(`❌ Lỗi 401: API Key trong file grok.json KHÔNG HỢP LỆ hoặc đã hết hạn.`);
        } else if (e instanceof SyntaxError) {
            addLog(`⚠️ Lỗi phân tách cú pháp JSON từ dữ liệu phản hồi của AI.`);
        } else {
            addLog(`❌ Lỗi kết nối hệ thống AI: ${e.message}`);
        }
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
        addLog(`⚠️ Phát hiện tiêu đề hoặc nội dung trùng bài cũ [${news.title}]. Hủy lượt đăng này để bảo vệ chống spam.`);
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
    <h1>Tòa Soạn Báo Điện Tử Quốc Tế AI (Hệ Thống Big Data 500+ Nguồn) - Port ${PORT}</h1>
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
