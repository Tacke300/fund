// index.js
// PHIÊN BẢN CUỐI CÙNG v1.1 - Sửa lỗi Endpoint API Spot

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URLSearchParams } = require("url");
const { WebSocketServer } = require("ws");
// Đảm bảo bạn có file config.js với API key và secret
const { bingxApiKey, bingxApiSecret } = require("./config.js");

const HOST = "open-api.bingx.com";
const PORT = 1997;

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
        headers: { 'X-BX-APIKEY': bingxApiKey, 'User-Agent': 'Node/BingX-Funding-Auto-v1.1' },
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

// === Lấy danh sách tất cả các contract hợp lệ từ BingX ===
async function fetchAllValidContracts() {
    console.log("[Thông tin] Đang lấy danh sách symbols hợp lệ từ Spot và Futures...");
    const [spotContracts, futuresContracts] = await Promise.all([
        apiRequest('/openApi/spot/v1/common/symbols'),
        apiRequest('/openApi/swap/v2/quote/contracts')
    ]);

    if (!spotContracts || !Array.isArray(spotContracts.symbols)) {
        throw new Error('Không thể lấy danh sách symbols hợp lệ từ Spot.');
    }
    if (!Array.isArray(futuresContracts)) {
        throw new Error('Không thể lấy danh sách contracts hợp lệ từ Futures.');
    }

    return {
        spot: new Set(spotContracts.symbols.map(c => c.symbol)),
        futures: new Set(futuresContracts.map(c => c.symbol))
    };
}

// === LẤY GIÁ VÀ TÍNH TOÁN (ĐÃ SỬA LỖI) ===
async function fetchFundingEstimate(symbol) {
    try {
        // SỬA LỖI: Endpoint lấy giá Spot đã được sửa từ 'quote/price' thành 'ticker/price'
        const [spotData, futuresData] = await Promise.all([
            apiRequest('/openApi/spot/v1/ticker/price', { symbol }), // <-- ĐÂY LÀ DÒNG ĐÃ SỬA
            apiRequest('/openApi/swap/v2/quote/ticker', { symbol })
        ]);

        if (!Array.isArray(spotData) || spotData.length === 0 || typeof spotData[0].price === 'undefined') {
            throw new Error('Dữ liệu Spot trả về không hợp lệ từ /ticker/price');
        }
        if (!Array.isArray(futuresData) || futuresData.length === 0 || typeof futuresData[0].lastPrice === 'undefined') {
            throw new Error('Dữ liệu Futures trả về không hợp lệ');
        }

        const spotPrice = parseFloat(spotData[0].price);
        const futuresPrice = parseFloat(futuresData[0].lastPrice);
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

// === STATE & REFRESH (TỰ ĐỘNG HOÀN TOÀN) ===
let latestFunding = { ts: null, data: [], errors: [] };
let symbolsToProcess = [];

async function refreshAll() {
    console.log(`\n[${new Date().toISOString()}] Bắt đầu chu trình cập nhật...`);

    if (symbolsToProcess.length === 0) {
        try {
            const validSymbols = await fetchAllValidContracts();
            console.log(`[Thông tin] Tìm thấy ${validSymbols.spot.size} symbol trên Spot và ${validSymbols.futures.size} symbol trên Futures.`);

            const intersection = [];
            for (const symbol of validSymbols.futures) {
                if (validSymbols.spot.has(symbol)) {
                    intersection.push(symbol);
                }
            }
            
            symbolsToProcess = intersection;
            console.log(`[Thiết lập] Đã xác định được ${symbolsToProcess.length} symbol chung để theo dõi.`);

        } catch (e) {
            console.error("[Lỗi nghiêm trọng] Không thể lấy danh sách symbols từ BingX. Thử lại sau 5 phút.", e.message);
            return;
        }
    }
    
    if (symbolsToProcess.length === 0) {
        console.warn("[Cảnh báo] Không tìm thấy symbol chung nào giữa Spot và Futures.");
        return;
    }

    console.log(`[Tiến hành] Fetch dữ liệu cho ${symbolsToProcess.length} symbol...`);
    const results = await Promise.all(symbolsToProcess.map(symbol => fetchFundingEstimate(symbol)));
    
    const successfulResults = [];
    const errorResults = [];

    results.forEach(result => {
        if (result.error) {
            errorResults.push(result);
        } else {
            successfulResults.push(result);
        }
    });

    if (successfulResults.length > 0) {
        console.log(`[Thành công] Lấy dữ liệu thành công cho ${successfulResults.length} / ${symbolsToProcess.length} symbol.`);
        // Log một ví dụ thành công
        console.log(`[Ví dụ] ${successfulResults[0].symbol}: ${successfulResults[0].fundingEstimatePercent}`);
    }
    if (errorResults.length > 0) {
        console.warn(`[Thất bại] Có lỗi khi lấy dữ liệu cho ${errorResults.length} symbol. Ví dụ: ${errorResults[0].symbol} - ${errorResults[0].error}`);
    }

    latestFunding = {
        ts: new Date().toISOString(),
        data: successfulResults,
        errors: errorResults
    };

    broadcast({ type: "update", data: latestFunding });
    console.log(`Cập nhật hoàn tất.`);
}

// === HTTP + WS SERVER (Không thay đổi) ===
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

server.listen(PORT, async () => {
    console.log(`Server ước tính funding đang chạy tại: http://localhost:${PORT}/api/funding-estimate`);
    await refreshAll();
    setInterval(refreshAll, 5 * 60 * 1000);
});
