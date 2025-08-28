// index.js
// PHIÊN BẢN SẢN XUẤT - Nâng cấp logic tự tính Funding Rate

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URLSearchParams } = require("url");
const { WebSocketServer } = require("ws");
// Đảm bảo bạn có file config.js với API key và secret
const { bingxApiKey, bingxApiSecret } = require("./config.js");

const HOST = "open-api.bingx.com";
const PORT = 1997;

const SYMBOLS_TO_FETCH = [
    "RLC-USDT",
    "BIO-USDT",
    "WAVE-USDT",
    "CRO-USDT",
"TREE-USDT",
    "SPK-USDT"

];

// === HÀM KÝ HMAC-SHA256 (Không đổi) ===
function sign(queryString, secret) {
    return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

// === HÀM GỌI API TRUNG TÂM (Không đổi) ===
async function apiRequest(path, params = {}) {
    const allParams = { ...params, timestamp: Date.now() };
    const queryString = new URLSearchParams(allParams).toString();
    const signature = sign(queryString, bingxApiSecret);
    const fullPath = `${path}?${queryString}&signature=${signature}`;

    const options = {
        hostname: HOST,
        path: fullPath,
        method: 'GET',
        headers: { 'X-BX-APIKEY': bingxApiKey, 'User-Agent': 'Node/BingX-Funding-SelfCalc-v2.0' },
        timeout: 15000
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.code !== 0) {
                        return reject(new Error(`API trả về lỗi: ${json.msg || JSON.stringify(json)}`));
                    }
                     // Endpoint price trả về một mảng, ta lấy phần tử đầu tiên
                    resolve(Array.isArray(json.data) ? json.data[0] : json.data);
                } catch (e) { reject(new Error(`Lỗi parse JSON: ${data}`)); }
            });
        });
        req.on('error', (e) => reject(new Error(`Lỗi Request: ${e.message}`)));
        req.on('timeout', () => { req.destroy(); reject(new Error('Request Timeout')); });
        req.end();
    });
}

// === HÀM MỚI: TỰ TÍNH PREMIUM INDEX (Cách tiếp cận tốt nhất) ===
async function calculateInstantaneousPremium(symbol) {
    try {
        // Gọi API duy nhất để lấy cả Index Price và Mark Price
        const priceData = await apiRequest('/openApi/swap/v2/quote/price', { symbol });

        if (!priceData || !priceData.indexPrice || !priceData.markPrice) {
            throw new Error('Dữ liệu giá trả về không hợp lệ (thiếu indexPrice hoặc markPrice)');
        }

        const indexPrice = parseFloat(priceData.indexPrice);
        const markPrice = parseFloat(priceData.markPrice);
        
        if (indexPrice === 0) {
            throw new Error('Index Price bằng 0, không thể chia');
        }

        // Áp dụng công thức tính Premium Index đã cải tiến
        const premiumIndex = (markPrice - indexPrice) / indexPrice;

        return {
            symbol,
            markPrice,
            indexPrice,
            premiumIndex, // Đây là kết quả tự tính của chúng ta
            premiumIndexPercent: `${(premiumIndex * 100).toFixed(6)}%`,
            ts: new Date().toISOString(),
        };
    } catch (e) {
        return { symbol, error: e.message };
    }
}


// === STATE & REFRESH (Cập nhật để dùng hàm tự tính mới) ===
let latestFunding = { ts: null, data: [], errors: [] };

async function refreshAll() {
    console.log(`\n[${new Date().toISOString()}] Bắt đầu chu trình cập nhật...`);
    
    console.log(`[Tiến hành] Tự tính Premium Index cho ${SYMBOLS_TO_FETCH.length} symbol: ${SYMBOLS_TO_FETCH.join(', ')}`);
    const results = await Promise.all(SYMBOLS_TO_FETCH.map(symbol => calculateInstantaneousPremium(symbol)));
    
    results.forEach(result => {
        if (result.error) {
            console.log(`[Thất bại] ${result.symbol}: ${result.error}`);
        } else {
            console.log(`[Thành công] ${result.symbol}: Premium Index = ${result.premiumIndexPercent}`);
        }
    });

    latestFunding = {
        ts: new Date().toISOString(),
        data: results.filter(r => !r.error),
        errors: results.filter(r => r.error)
    };

    broadcast({ type: "update", data: latestFunding });
    console.log(`Cập nhật hoàn tất.`);
}

// === HTTP + WS SERVER (Cập nhật để sắp xếp theo premiumIndex) ===
const server = http.createServer((req, res) => {
    if (req.url === "/api/funding-estimate" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        const sortedData = {
            ...latestFunding,
            data: latestFunding.data.sort((a, b) => b.premiumIndex - a.premiumIndex)
        };
        res.end(JSON.stringify(sortedData, null, 2));
        return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
});
const wss = new WebSocketServer({ noServer: true });
function broadcast(msgObj) {
    const data = JSON.stringify(msgObj);
    for (const client of wss.clients) if (client.readyState === 1) client.send(data);
}
server.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    else socket.destroy();
});
wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "snapshot", data: latestFunding }));
});

// === KHỞI ĐỘNG SERVER (Không đổi) ===
server.listen(PORT, async () => {
    console.log(`Server tự tính funding đang chạy tại: http://localhost:${PORT}/api/funding-estimate`);
    await refreshAll();
    // Premium Index biến động liên tục, refresh 5 phút là hợp lý
    setInterval(refreshAll, 5 * 60 * 1000); 
});
