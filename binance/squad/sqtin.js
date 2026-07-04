import express from 'express';
import axios from 'axios';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import Parser from 'rss-parser';

const app = express();
const PORT = 9999;
const parser = new Parser();

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

// Hàm lấy tin tức thực tế thời gian thực từ Google News RSS
async function fetchRealNews() {
    try {
        const url = 'https://news.google.com/rss/search?q=crypto+bitcoin+fed+economy+finance&hl=en-US&gl=US&ceid=US:en';
        const feed = await parser.parseURL(url);
        
        const items = feed.items.slice(0, 5).map(item => `- ${item.title} (${item.pubDate})`).join('\n');
        return items || null;
    } catch (e) {
        console.error("❌ Lỗi khi lấy tin tức thực tế từ RSS:", e.message);
        return null;
    }
}

// Hàm gọi AI xử lý tin tức
async function fetchCryptoContentFromAI() {
    if (!GROQ_API_KEY) {
        addLog("❌ Lỗi: Chưa cấu hình GROQ_API_KEY trong file grok.json");
        return null;
    }

    const realNewsData = await fetchRealNews(); 
    if (!realNewsData) {
        addLog("❌ Không lấy được dữ liệu RSS sạch từ nguồn cấp. Bỏ qua lượt đăng lần này.");
        return null;
    }

    // Lấy 20 tiêu đề gần nhất làm mẫu cấm trùng
    const excludedTitles = Array.from(postedTitles).slice(-20).join('\n');

    const prompt = `Bạn là Tổng biên tập của một tòa soạn tài chính quốc tế theo phong cách Reuters, Bloomberg và CNBC.
Nhiệm vụ của bạn là viết MỘT BÀI BÁO TIẾNG VIỆT hoàn chỉnh chỉ dựa trên dữ liệu tin tức được cung cấp dưới đây.

====================
DỮ LIỆU GỐC:
${realNewsData}
====================

⚠️ DANH SÁCH TIÊU ĐỀ ĐÃ XUẤT BẢN TRƯỚC ĐÂY (TUYỆT ĐỐI CẤM TRÙNG LẶP HOẶC XÀO NẤU LẠI Ý TƯỞNG):
${excludedTitles || "Không có"}

YÊU CẦU BẮT BUỘC CHỐNG TRÙNG LẶP:
- Kiểm tra kỹ danh sách tiêu đề đã xuất bản ở trên. Nếu dữ liệu gốc tuần này trùng lặp nội dung hoặc ý tưởng với các bài đã đăng, hoặc tiêu đề bạn định viết có ý nghĩa tương tự (chỉ khác vài từ hoặc đảo thứ tự), bạn BẮT BUỘC phải trả về "SKIP". Không cố xào lại bài cũ.

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
            frequency_penalty: 0.3, // Tăng nhẹ để AI tránh lặp lại các cấu trúc từ cũ
            presence_penalty: 0
        }, {
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 25000
        });

        const rawText = response.data.choices[0].message.content.trim();
        const news = JSON.parse(rawText);

        if (news.title === "SKIP") {
            addLog(`⚠️ AI áp dụng bộ lọc: SKIP lượt này do trùng lặp ý tưởng hoặc thiếu dữ liệu tin tức.`);
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
    
    // FIX BIẾN CHỐNG TRÙNG THÔNG MINH HƠN: 
    // Kiểm tra trùng lặp tuyệt đối hoặc tiêu đề mới chứa toàn bộ từ khóa chính của tiêu đề cũ
    let isDuplicated = postedTitles.has(cleanTitle);
    
    if (!isDuplicated) {
        // Kiểm tra xem tiêu đề mới có phải là biến thể xào nấu (chứa các từ khóa cốt lõi của bài viết trước) hay không
        for (const oldTitle of postedTitles) {
            if (oldTitle.includes(cleanTitle) || cleanTitle.includes(oldTitle)) {
                isDuplicated = true;
                break;
            }
        }
    }

    if (isDuplicated) {
        // SỬA QUAN TRỌNG: Bỏ đệ quy "return await runJob()". 
        // Khi phát hiện trùng, hủy ngay lập tức phiên làm việc hiện tại để bảo vệ hệ thống khỏi vòng lặp vô hạn.
        addLog(`⚠️ Phát hiện tiêu đề hoặc nội dung xào nấu trùng bài cũ [${news.title}]. Hủy lượt đăng này để tránh spam.`);
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
    <h1>Tòa Soạn Báo Điện Tử Quốc Tế AI (Anti-Loop & Anti-Spam) - Port ${PORT}</h1>
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
