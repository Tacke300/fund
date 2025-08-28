// index.js
// PHIÊN BẢN CUỐI CÙNG - Dùng đúng API công khai, không cần API Key, xử lý lỗi vững chắc

const http = require("http");
const https = require("https");
const { WebSocketServer } = require("ws");

const PORT = 1997;

const TARGET_COINS = [
    "LPT-USDT",
    "BTC-USDT",
    "ETH-USDT",
    "SOL-USDT",
    "BIO-USDT",
    // Các symbol dưới đây có thể không tồn tại trên sàn, chương trình sẽ báo lỗi và bỏ qua
    "CAT-USDT",
    "WAVE-USDT",
];

// === HÀM GỌI API CÔNG KHAI - Đơn giản và ổn định ===
function publicApiGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Node/BingX-Funding-Correct-Version' } }, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const json = JSON.parse(data);
                        if (json.code !== 0) {
                            return reject(new Error(`API trả về lỗi: ${json.msg || 'Unknown Error'}`));
                        }
                        resolve(json.data);
                    } catch (e) {
                        reject(new Error(`Lỗi parse JSON từ phản hồi API: ${data}`));
                    }
                } else {
                    reject(new Error(`Lỗi HTTP ${res.statusCode}`));
                }
            });
        }).on('error', (e) => reject(new Error(`Lỗi kết nối mạng: ${e.message}`)));
    });
}

// === LẤY GIÁ VÀ TÍNH TOÁN - Xử lý lỗi để không bao giờ crash ===
async function fetchFundingEstimate(symbol) {
    const spotUrl = `https://open-api.bingx.com/openApi/spot/v1/ticker/24hr?symbol=${symbol}`;
    const futuresUrl = `https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${symbol}`;

    try {
        // Gọi cả 2 API song song để tiết kiệm thời gian
        const [spotData, futuresData] = await Promise.all([
            publicApiGet(spotUrl),
            publicApiGet(futuresUrl)
        ]);
        
        // --- BƯỚC KIỂM TRA DỮ LIỆU QUAN TRỌNG NHẤT ĐỂ TRÁNH CRASH ---
        if (!spotData || typeof spotData.lastPrice === 'undefined') {
            throw new Error('Dữ liệu Spot trả về không hợp lệ hoặc không tìm thấy');
        }
        if (!Array.isArray(futuresData) || futuresData.length === 0 || typeof futuresData[0].lastPrice === 'undefined') {
            throw new Error('Dữ liệu Futures trả về không hợp lệ hoặc không tìm thấy');
        }

        const spotPrice = parseFloat(spotData.lastPrice);
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
        // Nếu có bất kỳ lỗi nào xảy ra ở trên, chương trình sẽ không crash mà trả về thông báo lỗi
        return { symbol, error: e.message };
    }
}

// === STATE & REFRESH (Không thay đổi) ===
let latestFunding = { ts: null, data: [] };

async function refreshAll() {
    console.log(`\n[${new Date().toISOString()}] Bắt đầu cập nhật dữ liệu...`);
    const results = await Promise.all(TARGET_COINS.map(symbol => fetchFundingEstimate(symbol)));

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
