// index.js
// Tự tính funding estimate bằng cách lấy giá Spot & Futures qua API đã xác thực (ĐÃ SỬA LỖI KÝ)

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URLSearchParams } = require("url");
const { WebSocketServer } = require("ws");
const { bingxApiKey, bingxApiSecret } = require("./config.js");

const HOST = "open-api.bingx.com";
const PORT = 1997;

// === DANH SÁCH COIN YÊU CẦU ===
const TARGET_COINS = [
    "LPT-USDT",
    "BTC-USDT",
    "ETH-USDT",
    "SOL-USDT",
    "CAT-USDT", // Sẽ báo lỗi không tồn tại, đây là hành vi đúng
    "BIO-USDT",
    "WAVE-USDT", // Sẽ báo lỗi không tồn tại, đây là hành vi đúng
];

// === HÀM KÝ HMAC-SHA256 ===
function sign(queryString, secret) {
    return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

// === HÀM GỌI API TRUNG TÂM (ĐÃ SỬA LỖI) ===
async function apiRequest(path, params = {}) {
    // ---- SỬA LỖI TẠI ĐÂY ----
    // 1. Gộp tất cả các tham số (bao gồm cả symbol) và timestamp VÀO NHAU
    const allParams = { ...params, timestamp: Date.now() };

    // 2. Tạo query string từ TẤT CẢ tham số
    const queryString = new URLSearchParams(allParams).toString();

    // 3. Ký trên query string đầy đủ này
    const signature = sign(queryString, bingxApiSecret);

    // 4. Tạo URL cuối cùng để gửi đi
    const fullPath = `${path}?${queryString}&signature=${signature}`;

    const options = {
        hostname: HOST,
        path: fullPath,
        method: 'GET',
        headers: {
            'X-BX-APIKEY': bingxApiKey,
            'User-Agent': 'Node/BingX-Funding-Calculator-V4-Fixed'
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
                    // API của BingX trả về code != 0 khi có lỗi
                    if (json.code !== 0) {
                        return reject(new Error(`BingX API error: ${JSON.stringify(json)}`));
                    }
                    resolve(json.data);
                } catch (e) {
                    reject(new Error(`Lỗi parse JSON: ${data}`));
                }
            });
        });

        req.on('error', (e) => reject(new Error(`Lỗi Request: ${e.message}`)));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request Timeout'));
        });
        req.end();
    });
}

// === LẤY GIÁ VÀ TÍNH TOÁN FUNDING ESTIMATE (Không thay đổi) ===
async function fetchFundingEstimate(symbol) {
    try {
        const [spotData, futuresData] = await Promise.all([
            apiRequest('/openApi/spot/v1/ticker/24hr', { symbol }),
            apiRequest('/openApi/swap/v2/quote/ticker', { symbol })
        ]);

        if (!spotData || !spotData.lastPrice) {
            throw new Error('Dữ liệu Spot không hợp lệ hoặc không tìm thấy');
        }
        const spotPrice = parseFloat(spotData.lastPrice);

        if (!Array.isArray(futuresData) || futuresData.length === 0 || !futuresData[0].lastPrice) {
            throw new Error('Dữ liệu Futures không hợp lệ hoặc không tìm thấy');
        }
        const futuresPrice = parseFloat(futuresData[0].lastPrice);
        
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
        // Trả về lỗi chi tiết từ API
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
    console.log("[WebSocket] Client đã kết nối.");
    ws.send(JSON.stringify({ type: "snapshot", data: latestFunding }));
    ws.on('close', () => console.log('[WebSocket] Client đã ngắt kết nối.'));
});

server.listen(PORT, async () => {
    console.log(`Server ước tính funding đang chạy tại: http://localhost:${PORT}/api/funding-estimate`);
    await refreshAll();
    setInterval(refreshAll, 60 * 1000);
});
