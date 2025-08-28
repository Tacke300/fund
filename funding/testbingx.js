// index.js
// PHIÊN BẢN SẢN XUẤT - Cập nhật danh sách coin theo yêu cầu

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URLSearchParams } = require("url");
const { WebSocketServer } = require("ws");
// Đảm bảo bạn có file config.js với API key và secret
const { bingxApiKey, bingxApiSecret } = require("./config.js");

const HOST = "open-api.bingx.com";
const PORT = 1997;

// DANH SÁCH COIN MỚI THEO YÊU CẦU CỦA BẠN
const SYMBOLS_TO_FETCH = [
    "RLC-USDT",
    "BIO-USDT",
    "WAVE-USDT",
    "CRO-USDT"
];

// === HÀM KÝ HMAC-SHA256 (Chuẩn) ===
function sign(queryString, secret) {
    return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

// === HÀM GỌI API TRUNG TÂM (Chuẩn) ===
async function apiRequest(path, params = {}) {
    const allParams = { ...params, timestamp: Date.now() };
    const queryString = new URLSearchParams(allParams).toString();
    const signature = sign(queryString, bingxApiSecret);
    const fullPath = `${path}?${queryString}&signature=${signature}`;

    const options = {
        hostname: HOST,
        path: fullPath,
        method: 'GET',
        headers: { 'X-BX-APIKEY': bingxApiKey, 'User-Agent': 'Node/BingX-Funding-Production-v1.1' },
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
                    resolve(json.data);
                } catch (e) { reject(new Error(`Lỗi parse JSON: ${data}`)); }
            });
        });
        req.on('error', (e) => reject(new Error(`Lỗi Request: ${e.message}`)));
        req.on('timeout', () => { req.destroy(); reject(new Error('Request Timeout')); });
        req.end();
    });
}

// === LẤY GIÁ VÀ TÍNH TOÁN (Đã ổn định) ===
async function fetchFundingEstimate(symbol) {
    try {
        const [spotData, futuresData] = await Promise.all([
            apiRequest('/openApi/spot/v1/ticker/price', { symbol }),
            apiRequest('/openApi/swap/v2/quote/ticker', { symbol })
        ]);

        let spotPrice;
        if (
            Array.isArray(spotData) && spotData.length > 0 &&
            Array.isArray(spotData[0].trades) && spotData[0].trades.length > 0 &&
            spotData[0].trades[0].price
        ) {
            spotPrice = parseFloat(spotData[0].trades[0].price);
        } else {
            throw new Error('Cấu trúc dữ liệu Spot không hợp lệ');
        }

        let futuresPrice;
        if (futuresData && typeof futuresData === 'object' && !Array.isArray(futuresData) && futuresData.lastPrice) {
            futuresPrice = parseFloat(futuresData.lastPrice);
        } else {
            throw new Error('Cấu trúc dữ liệu Futures không hợp lệ');
        }

        const fundingEstimate = (futuresPrice - spotPrice) / spotPrice;

        return {
            symbol, spot: spotPrice, futures: futuresPrice, fundingEstimate,
            fundingEstimatePercent: `${(fundingEstimate * 100).toFixed(6)}%`,
            ts: new Date().toISOString(),
        };
    } catch (e) {
        return { symbol, error: e.message };
    }
}

// === STATE & REFRESH (Không đổi) ===
let latestFunding = { ts: null, data: [], errors: [] };

async function refreshAll() {
    console.log(`\n[${new Date().toISOString()}] Bắt đầu chu trình cập nhật...`);
    
    console.log(`[Tiến hành] Fetch dữ liệu cho ${SYMBOLS_TO_FETCH.length} symbol đã chọn: ${SYMBOLS_TO_FETCH.join(', ')}`);
    const results = await Promise.all(SYMBOLS_TO_FETCH.map(symbol => fetchFundingEstimate(symbol)));
    
    results.forEach(result => {
        if (result.error) {
            console.log(`[Thất bại] ${result.symbol}: ${result.error}`);
        } else {
            console.log(`[Thành công] ${result.symbol}: Ước tính = ${result.fundingEstimatePercent}`);
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

// === HTTP + WS SERVER (Không đổi) ===
const server = http.createServer((req, res) => {
    if (req.url === "/api/funding-estimate" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        const sortedData = {
            ...latestFunding,
            data: latestFunding.data.sort((a, b) => b.fundingEstimate - a.fundingEstimate)
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
    console.log(`Server ước tính funding đang chạy tại: http://localhost:${PORT}/api/funding-estimate`);
    await refreshAll();
    setInterval(refreshAll, 5 * 60 * 1000);
});
