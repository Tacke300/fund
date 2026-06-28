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
let currentType = 'NEWS_CRYPTO'; 

const TITLE_FILE = path.resolve('./posted_titles.json');
let postedTitles = new Set();

// Nạp lịch sử chống trùng vĩnh viễn
try {
    if (fs.existsSync(TITLE_FILE)) {
        const savedTitles = JSON.parse(fs.readFileSync(TITLE_FILE, 'utf8'));
        postedTitles = new Set(savedTitles.map(t => t.trim().toLowerCase()));
        console.log(`💾 Hệ thống khôi phục: Khóa trùng thành công ${postedTitles.size} bài viết.`);
    }
} catch (e) { console.error("❌ Lỗi nạp file chống trùng:", e.message); }

function saveTitleToFile(newTitle) {
    try {
        postedTitles.add(newTitle.trim().toLowerCase());
        fs.writeFileSync(TITLE_FILE, JSON.stringify(Array.from(postedTitles), null, 2), 'utf8');
    } catch (e) { console.error("❌ Lỗi lưu file JSON:", e.message); }
}

let GROQ_API_KEY = "";
try {
    const grokConfig = JSON.parse(fs.readFileSync(path.resolve('./grok.json'), 'utf8'));
    GROQ_API_KEY = grokConfig.apiKey;
} catch (error) { console.error("❌ Thiếu apiKey trong grok.json!"); }

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] ${msg}`;
    logs.unshift(entry);
    if (logs.length > 50) logs.pop();
    console.log(entry);
}

// HÀM LẤY TIN TỨC THỰC TẾ TỪ CÁC NGUỒN BÁO LỚN QUA RSS (Thời gian thực)
async function fetchRealNews(type) {
    try {
        let url = '';
        if (type === 'NEWS_CRYPTO') {
            // Lấy tin tức Crypto thế giới
            url = 'https://news.google.com/rss/search?q=crypto+bitcoin+binance&hl=en-US&gl=US&ceid=US:en';
        } else if (type === 'NEWS_POLITICS') {
            // Lấy tin tức chính trị, xung đột vũ trang, kinh tế vĩ mô, Trump, chiến sự
            url = 'https://news.google.com/rss/search?q=war+politics+trump+economy+fed&hl=en-US&gl=US&ceid=US:en';
        }
        
        const feed = await parser.parseURL(url);
        // Lấy ngẫu nhiên 3-5 tiêu đề tin tức thực tế đang diễn ra từ các báo quốc tế để làm nguyên liệu
        const items = feed.items.slice(0, 5).map(item => `- ${item.title} (${item.pubDate})`).join('\n');
        return items || "Không tìm thấy dữ liệu tin tức mới.";
    } catch (e) {
        console.error("❌ Lỗi khi lấy tin tức thực tế từ RSS:", e.message);
        return "Dòng tiền vĩ mô biến động, Donald Trump đưa ra chính sách kinh tế mới, căng thẳng địa chính trị leo thang.";
    }
}

async function fetchCryptoContentFromAI(type) {
    if (!GROQ_API_KEY) return null;

    const excludedTitles = Array.from(postedTitles).slice(-15).join('\n');
    let dynamicPrompt = "";
    
    if (type === 'NEWS_CRYPTO' || type === 'NEWS_POLITICS') {
        // LẤY TIN THỰC TẾ TỪ BÁO CHÍ
        const realNewsData = await fetchRealNews(type);
        
        dynamicPrompt = `Bạn là một Tổng biên tập báo điện tử tài chính-chính trị quốc tế. Hãy viết một BÀI BÁO PHÂN TÍCH CHÍNH LUẬN dựa trên các dữ liệu tin tức thực tế vừa được cập nhật từ hệ thống báo chí sau đây:
${realNewsData}

Yêu cầu cực kỳ khắt khe:
- Tuyệt đối KHÔNG ĐƯỢC tự bịa ra sự kiện chính trị hoặc số liệu không có thật. Phải bám sát vào các thông tin chiến sự, chính sách kinh tế của Trump, FED, hoặc biến động crypto từ dữ liệu báo chí trên.
- Văn phong chính luận, sắc sảo, dùng các thuật ngữ kinh tế vĩ mô chuyên sâu (Thanh khoản, dòng tiền xương tủy, thế cục địa chính trị, phòng hộ rủi ro,...). Viết chi tiết, đa chiều đúng chuẩn một bài báo điện tử lớn. KHÔNG viết văn vớ vẩn hay tóm tắt hời hợt.`;
    } else {
        // THẢ XÍCH CHO AI TỰ BỊA TRUYỆN TÂM SỰ TRADER
        const randomSeed = Math.floor(Math.random() * 99999);
        const storyMood = type === 'FUNNY_STORY' ? 'hài hước, châm biếm, dở khóc dở cười' : 'đượm buồn, cay đắng, lột tả bi kịch và sai lầm xương máu';
        
        dynamicPrompt = `Sáng tác ngẫu nhiên một câu chuyện dựa trên mã hạt giống độc bản: #STORY-${randomSeed}.
Yêu cầu: Hãy đóng vai một trader thực thụ và viết một bài viết mang văn phong "Tâm sự - Trải lòng - Ký sự đời trader". 
- Bạn được phép TỰ BỊA RA HOÀN TOÀN tình huống truyện (ví dụ: gồng lỗ cháy tài khoản, được người yêu cứu net, cài nhầm bot DCA, áp lực nợ nần, tâm lý FOMO nhảy cầu...).
- Lối viết phải cực kỳ CHÂN THẬT, ĐỜI THƯỜNG, xưng "mình/tôi". Khai thác sâu vào diễn biến tâm lý, những đoạn độc thoại nội tâm thắt lòng hoặc những pha xử lý đi vào lòng đất. 
- Người đọc đọc vào phải thấy bóng dáng của chính họ trong đó, thấy sự thấm thía chứ không phải những lời khuyên lý thuyết sáo rỗng.`;
    }

    const prompt = `Yêu cầu viết bài bằng Tiếng Việt dựa trên định hướng chuyên sâu sau:
${dynamicPrompt}

⚠️ DANH SÁCH TIÊU ĐỀ ĐÃ XUẤT BẢN TRƯỚC ĐÂY (CẤM TRÙNG LẶP Ý TƯỞNG):
${excludedTitles || "Không có"}

Yêu cầu trả về cấu trúc JSON chuẩn xác (không bọc trong \`\`\`json):
{
  "title": "Tiêu đề bài báo/bài viết mang phong cách giật gân, chấn động, lột tả bản chất hoặc cực kỳ sâu sắc, kích thích click (Dưới 80 ký tự)",
  "coin_symbol": "BTC",
  "content": "Nội dung bài viết hoàn chỉnh."
}

⚠️ QUY ĐỊNH BẮT BUỘC VỀ ĐỊNH DẠNG VĂN BẢN TRONG "content":
1. BẮT BUỘC MỖI DÒNG / MỖI Ý CHÍNH PHẢI XUỐNG DÒNG RÕ RÀNG bằng ký tự "\\n\\n". Tuyệt đối không viết dính liền tù tì thành một cục text.
2. CHỈ sử dụng duy nhất 1 icon cảm xúc (emoji) phù hợp đặt ở đầu dòng của các luận điểm, ý chính lớn hoặc tiêu đề phụ bên trong bài. Tuyệt đối KHÔNG chèn icon tràn lan ở mọi dòng nhỏ.
3. Trường "content" phải là chuỗi JSON hợp lệ, nằm trọn trong cặp dấu ngoặc kép và không chứa ký tự xuống dòng vật lý làm vỡ cấu trúc JSON.
4. Tổng số ký tự (title + content) KHÔNG VƯỢT QUÁ 1900 KÝ TỰ.`;

    try {
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: "You are an elite journalist and expert storyteller. Output raw, valid JSON only. Ensure the content string is properly JSON-escaped with no literal newlines." },
                { role: "user", content: prompt }
            ],
            temperature: type.includes('NEWS') ? 0.65 : 0.88 // Tin tức cần chính xác (temp thấp), Truyện cần bay bổng chân thật (temp cao)
        }, {
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 25000
        });

        const rawText = response.data.choices[0].message.content.trim();
        return JSON.parse(rawText);
    } catch (e) {
        if (e instanceof SyntaxError) {
            addLog(`⚠️ Cấu trúc JSON bị lỗi chuỗi văn bản. Hệ thống bỏ qua lượt này.`);
        } else {
            addLog(`❌ Lỗi hệ thống AI: ${e.message}`);
        }
        return null;
    }
}

async function runJob() {
    if (postCount >= 50) return;

    const typeToFetch = currentType;
    addLog(`🔄 Hệ thống đang biên tập bài viết nhóm: [${typeToFetch}]...`);
    
    const news = await fetchCryptoContentFromAI(typeToFetch);
    if (!news || !news.title || !news.content) return;

    const cleanTitle = news.title.trim().toLowerCase();
    if (postedTitles.has(cleanTitle)) {
        addLog(`⚠️ Trùng tiêu đề bài viết cũ, đang tự động biên tập lại bài khác...`);
        return await runJob(); 
    }

    // Thiết lập hiển thị sạch lên Binance Square: Tiêu đề in hoa bôi đậm + Nội dung phân dòng
    let postText = `📰 **${news.title.toUpperCase()}**\n\n${news.content}\n\n`;
    if (postText.length > 1900) postText = postText.substring(0, 1900);

    const coinSymbol = news.coin_symbol ? news.coin_symbol.trim().toUpperCase().replace('$', '') : 'BTC';
    const finalPost = `${postText}$${coinSymbol} #CryptoUpdate`.substring(0, 1995);

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
            addLog(`✅ Đã xuất bản thành công bài [${typeToFetch}]: ${news.title}`);
            
            // Xoay tua vòng tròn 4 luồng
            if (currentType === 'NEWS_CRYPTO') currentType = 'NEWS_POLITICS';
            else if (currentType === 'NEWS_POLITICS') currentType = 'FUNNY_STORY';
            else if (currentType === 'FUNNY_STORY') currentType = 'SAD_STORY';
            else currentType = 'NEWS_CRYPTO';
        } else {
            addLog(`❌ Binance API từ chối bài: ${JSON.stringify(response.data)}`);
        }
    } catch (e) { addLog(`❌ Lỗi kết nối API Binance: ${e.message}`); }
}

// ROUTERS VÀ CRON ĐIỀU KHIỂN
app.get('/', (req, res) => res.send(`
    <!DOCTYPE html><html><body style="background:#111; color:#0f0; font-family:monospace; padding:20px;">
    <h1>Tòa Soạn Báo Điện Tử Đa Năng AI - Port ${PORT}</h1>
    <button onclick="fetch('/start')">START BOT</button> <button onclick="fetch('/stop')">STOP BOT</button> <button onclick="fetch('/test')">TEST GỬI BÀI NGAY</button>
    <div id="l" style="background:#000; padding:10px; height:400px; overflow-y:scroll; margin-top:20px;"></div>
    <script>setInterval(()=>{fetch('/logs').then(r=>r.json()).then(d=>{document.getElementById('l').innerHTML=d.join('<br>')})},2000);</script>
    </body></html>
`));
app.get('/logs', (req, res) => res.json(logs));
app.get('/start', (req, res) => { isRunning = true; runJob(); res.send("OK"); });
app.get('/stop', (req, res) => { isRunning = false; res.send("OK"); });
app.get('/test', async (req, res) => { await runJob(); res.send("OK"); });

cron.schedule('*/15 * * * *', async () => { if (isRunning) await runJob(); });
cron.schedule('0 7 * * *', () => { postCount = 0; });

app.listen(PORT, () => console.log('Hệ thống đang hoạt động tại cổng: ' + PORT));
