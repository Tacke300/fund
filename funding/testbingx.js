// index.js
// Tự tính funding estimate - Phiên bản cuối cùng, sửa lỗi ký và tăng độ ổn định

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URLSearchParams } = require("url");
const { WebSocketServer } = require("ws");
// Đảm bảo bạn có file config.js với API key và secret
const { bingxApiKey, bingxApiSecret } = require("./config.js");

const HOST = "open-api.bingx.com";
const PORT = 1997;

const TARGET_COINS = [
    "LPT-USDT",
    "BTC-USDT",
    "ETH-USDT",
    "SOL-USDT",
    "BIO-USDT",
    "CAT-USDT",  // Sẽ báo lỗi không tồn tại, đây là hành vi đúng
    "WAVE-USDT", // Sẽ báo lỗi không tồn tại, đây là hành vi đúng
];

// === HÀM KÝ HMAC-SHA256 (Không đổi) ===
function sign(queryString, secret) {
    return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

// === HÀM GỌI API TRUNG TÂM (ĐÃ SỬA LỖI VÀ THÊM RECVWINDOW) ===
async function apiRequest(path, params = {}) {
    // 1. Gộp tất cả các tham số (symbol) với các tham số bắt buộc (timestamp, recvWindow)
    const allParams = {
        ...params,
        timestamp: Date.now(),
        recvWindow: 5000 // Thêm recvWindow để tránh lỗi do lệch thời gian
    };

    // 2. Tạo query string từ TẤT CẢ các tham số trên
    const queryString = new URLSearchParams(allParams).toString();

    // 3. Ký trên query string đầy đủ đó
    const signature = sign(queryString, bingxApiSecret);

    // 4. Tạo URL cuối cùng để gửi đi
    const fullPath = `${path}?${queryString}&signature=${signature}`;

    const options = {
        hostname: HOST,
        path: fullPath,
        method: 'GET',
        headers: {
            'X-BX-APIKEY': bingxApiKey,
            'User-Agent': 'Node/BingX-Funding-Final-Fix'
        },
        timeout: 10000
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.code !== 0) {
                        return reject(new Error(`BingX API error: ${json.msg || JSON.stringify(json)}`));
                    }
                    resolve(json.data);
                } catch (e) {
                    reject(new Error(`Lỗi parse JSON: ${data}`));
                }
            });
        });
        req.on('error', (e) => reject(new Error(`Lỗi Request: ${e.message}`)));
        req.on('timeout', () => { req.destroy(); reject(new Error('Request Timeout')); });
        req.end();
    });
}

// === LẤY GIÁ VÀ TÍNH TOÁN (Không thay đổi) ===
async function fetchFundingEstimate(symbol) {
    try {
        const [spotData, futuresData] = await Promise.all([
            apiRequest('/openApi/spot/v1/ticker/24hr', { symbol }),
            apiRequest('/openApi/swap/v2/quote/ticker', { symbol })
        ]);

        const spotPrice = parseFloat(spotData.lastPrice);
        const futuresPrice = parseFloat(futuresData[0].lastPrice);
        
        if (isNaN(spotPrice) || isNaN(futuresPrice)) {
            throw new Error("Dữ liệu giá không hợp lệ sau khi parse.");
        }

        const fundingEstimate = (futuresPrice - spotPrice) / spotPrice;

        return {
            symbol,
            spot: spotPrice,
            futures: futuresPrice,
            fundingEstimate,
            fundingEstimatePercent: `${(fundingEstimate * 100).toFixed(6)}%`,
            ts: new Date().toISOString(),
        };

    } catch (e) {
        return { symbol, error: e.message };
    }
}

// === STATE & REFRESH (Không thay đổi) ===
let latestFunding = { ts: null, data: [] };

async function refreshAll() {
    console.log(`\n[${new Date().toISOString()}] Bắt đầu cập nhật dữ liệu...`);
    const promises = TARGET_COINS.map(symbol => fetchFundingEstimate(symbol));
    const results = await Promise.all(promises);

    for (const result of results) {
        if (!result.error) {
            console.log(`[Thành công] ${result.symbol}: Ước tính = ${result.fundingEstimatePercent} (Spot: ${result.spot}, Futures: ${result.futures})`);
        } else {
            console.log(`[Thất bại] ${result.symbol}: ${result.error}`);
        }
    }

    latestFunding = { ts: new Date().toISOString(), data: results };
    broadcast({ type: "update", data: latestFunding });
    console.log(`Cập nhật hoàn tất.`);
}

// === HTTP + WS SERVER (Không thay đổi) ===
const server = http.createServer((req, res) => {
    if (req.url === "/api/funding-estimate" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(latestFunding, null, 2));
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
server.listen(PORT, async () => {
    console.log(`Server ước tính funding đang chạy tại: http://localhost:${PORT}/api/funding-estimate`);
    await refreshAll();
    setInterval(refreshAll, 60 * 1000);
});
