// index.js
// Tự tính funding estimate bằng cách lấy giá Spot & Futures (Sửa lỗi triệt để - Không cần API Key)

const http = require("http");
const https = require("https");
const { WebSocketServer } = require("ws");

const PORT = 1997;

// === DANH SÁCH COIN YÊU CẦU ===
const TARGET_COINS = [
    "LPT-USDT",
    "BTC-USDT",
    "ETH-USDT",
    "SOL-USDT",
    "BIO-USDT",
    "CAT-USDT",  // Sẽ báo lỗi không tồn tại, đây là hành vi đúng
    "WAVE-USDT", // Sẽ báo lỗi không tồn tại, đây là hành vi đúng
];

// === HÀM GỌI API CÔNG KHAI (KHÔNG CẦN KÝ) ===
function publicApiGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Node/BingX-Funding-Public-API' } }, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const json = JSON.parse(data);
                        if (json.code !== 0) {
                            return reject(new Error(`BingX API error: ${json.msg || JSON.stringify(json)}`));
                        }
                        resolve(json.data);
                    } catch (e) {
                        reject(new Error(`Lỗi parse JSON: ${data}`));
                    }
                } else {
                    reject(new Error(`Lỗi HTTP ${res.statusCode} ${res.statusMessage}`));
                }
            });
        }).on('error', (e) => reject(new Error(`Lỗi Request: ${e.message}`)));
    });
}

// === LẤY GIÁ VÀ TÍNH TOÁN FUNDING ESTIMATE ===
async function fetchFundingEstimate(symbol) {
    try {
        // Tạo URL đầy đủ cho cả hai request
        const spotUrl = `https://open-api.bingx.com/openApi/spot/v1/ticker/24hr?symbol=${symbol}`;
        const futuresUrl = `https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${symbol}`;

        const [spotData, futuresData] = await Promise.all([
            publicApiGet(spotUrl).catch(err => { throw new Error(`Lỗi lấy giá Spot: ${err.message}`) }),
            publicApiGet(futuresUrl).catch(err => { throw new Error(`Lỗi lấy giá Futures: ${err.message}`) })
        ]);

        // Xử lý dữ liệu Spot (response là một object)
        if (!spotData || typeof spotData.lastPrice === 'undefined') {
            throw new Error('Dữ liệu Spot trả về không hợp lệ');
        }
        const spotPrice = parseFloat(spotData.lastPrice);

        // Xử lý dữ liệu Futures (response là một array)
        if (!Array.isArray(futuresData) || futuresData.length === 0 || typeof futuresData[0].lastPrice === 'undefined') {
            throw new Error('Dữ liệu Futures trả về không hợp lệ');
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
        return { symbol, error: e.message };
    }
}

// === STATE & REFRESH (Giữ nguyên) ===
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

// === HTTP + WS SERVER (Giữ nguyên) ===
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
