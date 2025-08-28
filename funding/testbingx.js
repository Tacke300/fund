// index.js
// Ước tính Funding Rate hiện tại từ Spot/Futures trên BingX
// HTTP:  GET http://localhost:1997/api/funding-estimate
// WS:    ws://localhost:1997/ws

const http = require("http");
const https = require("https");
const { WebSocketServer } = require("ws");

const PORT = 1997;

// DANH SÁCH SYMBOL muốn tính
const TARGET_COINS = [
    "LPT-USDT",
    "BTC-USDT", // Thêm một vài cặp phổ biến để kiểm tra
    "ETH-USDT",
    "SOL-USDT",
    // "BIO-USDT", // Lưu ý: Một vài symbol có thể không tồn tại trên cả spot và futures
    // "CAT-USDT",
    // "WAVE-USDT",
];

// === HTTPS GET helper ===
function httpGet(url) {
    return new Promise((resolve, reject) => {
        https
            .get(url, { headers: { "User-Agent": "Node/BingX-Funding-V2" } }, (res) => {
                let buf = "";
                res.on("data", (c) => (buf += c));
                res.on("end", () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(JSON.parse(buf));
                        } catch (e) {
                            reject(new Error("Failed to parse JSON response"));
                        }
                    } else {
                        reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage}`));
                    }
                });
            })
            .on("error", reject);
    });
}

// === Tính funding estimate ===
async function fetchFundingEstimate(symbol) {
    try {
        // --- ĐÃ THAY ĐỔI API ENDPOINT CHO SPOT ---
        // Lấy giá Spot từ API v1 của BingX Spot
        const spotJson = await httpGet(`https://open-api.bingx.com/openApi/spot/v1/ticker/24hr?symbol=${symbol}`);
        if (spotJson.code !== 0 || !spotJson.data || !spotJson.data.lastPrice) {
            throw new Error(`Spot not found or API error: ${spotJson.msg || 'No data'}`);
        }
        const S = parseFloat(spotJson.data.lastPrice);

        // --- ĐÃ THAY ĐỔI API ENDPOINT CHO FUTURES ---
        // Lấy giá Futures từ API v2 của BingX Swap
        const futuJson = await httpGet(`https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${symbol}`);
        if (futuJson.code !== 0 || !futuJson.data || futuJson.data.length === 0) {
            throw new Error(`Futures not found or API error: ${futuJson.msg || 'No data'}`);
        }
        const F = parseFloat(futuJson.data[0].lastPrice);
        
        // Tính toán funding rate ước tính
        const rate = (F - S) / S;

        return {
            symbol,
            spot: S,
            futures: F,
            fundingEstimate: rate,
            ts: new Date().toISOString(),
        };

    } catch (e) {
        return { symbol, error: e.message };
    }
}

// === STATE (Trạng thái) ===
let latestFunding = { ts: null, data: [] };

// === Cập nhật tất cả symbol ===
async function refreshAll() {
    console.log(`\n[${new Date().toISOString()}] Refreshing all symbols...`);
    const out = [];
    // Sử dụng Promise.all để fetch song song, tăng tốc độ
    const promises = TARGET_COINS.map(s => fetchFundingEstimate(s));
    const results = await Promise.all(promises);

    for (const d of results) {
        out.push(d);
        if (!d.error) {
            console.log(`[FundingEstimate] ${d.symbol}: rate=${(d.fundingEstimate * 100).toFixed(6)}% (Spot: ${d.spot}, Futures: ${d.futures})`);
        } else {
            console.log(`[FundingError] ${d.symbol}: ${d.error}`);
        }
    }
    latestFunding = { ts: new Date().toISOString(), data: out };
    broadcast({ type: "update", data: latestFunding });
}


// === HTTP + WS server (Không thay đổi) ===
const server = http.createServer((req, res) => {
    if (req.url === "/api/funding-estimate" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(latestFunding, null, 2));
        return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
});

const wss = new WebSocketServer({ noServer: true });
function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
        if (client.readyState === 1) client.send(data);
    }
}

server.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws") {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
        });
    } else {
        socket.destroy();
    }
});

wss.on("connection", (ws) => {
    console.log("[WebSocket] Client connected");
    ws.send(JSON.stringify({ type: "snapshot", data: latestFunding }));
    ws.on('close', () => console.log('[WebSocket] Client disconnected'));
});

server.listen(PORT, async () => {
    console.log(`Funding estimate server running: http://localhost:${PORT}/api/funding-estimate`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
    await refreshAll();
    setInterval(refreshAll, 60 * 1000); // Cập nhật mỗi 60 giây
});
