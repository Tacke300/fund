// index.js
// PHIÊN BẢN 2.0 - TỐI ƯU HÓA: Chỉ lấy danh sách coin 1 lần duy nhất

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
        headers: { 'X-BX-APIKEY': bingxApiKey, 'User-Agent': 'Node/BingX-Funding-Optimized-v2.0' },
        timeout: 15000
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    // Kiểm tra phản hồi lỗi rate limit trước khi parse
                    if (data.includes("error code: 1015")) {
                        return reject(new Error('Lỗi Rate Limit từ BingX (error code: 1015).'));
                    }
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

// === LẤY DANH SÁCH COIN (Chỉ chạy 1 lần) ===
async function fetchAndCacheSymbolList() {
    console.log("[Thiết lập] Lần đầu khởi động, bắt đầu lấy danh sách symbols từ Spot và Futures...");
    try {
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

        const spotSymbols = new Set(spotContracts.symbols.map(c => c.symbol));
        const futuresSymbols = new Set(futuresContracts.map(c => c.symbol));
        
        console.log(`[Thông tin] Tìm thấy ${spotSymbols.size} symbol trên Spot và ${futuresSymbols.size} symbol trên Futures.`);

        const intersection = [];
        for (const symbol of futuresSymbols) {
            if (spotSymbols.has(symbol)) {
                intersection.push(symbol);
            }
        }
        
        console.log(`[Thành công] Đã xác định và lưu trữ ${intersection.length} symbol chung. Sẽ không lấy lại danh sách này nữa.`);
        return intersection; // Trả về danh sách đã lọc

    } catch (e) {
        console.error("[Lỗi nghiêm trọng] Không thể lấy danh sách symbols từ BingX. Bot sẽ tự động thử lại sau 1 phút.", e.message);
        return []; // Trả về mảng rỗng nếu lỗi
    }
}


// === LẤY GIÁ VÀ TÍNH TOÁN (Đã sửa lỗi) ===
async function fetchFundingEstimate(symbol) {
    try {
        const [spotData, futuresData] = await Promise.all([
            apiRequest('/openApi/spot/v1/ticker/price', { symbol }), // Endpoint ĐÚNG
            apiRequest('/openApi/swap/v2/quote/ticker', { symbol })
        ]);

        if (!Array.isArray(spotData) || spotData.length === 0 || typeof spotData[0].price === 'undefined') {
            throw new Error('Dữ liệu Spot trả về không hợp lệ');
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

// === STATE & REFRESH (ĐÃ TỐI ƯU HÓA) ===
let latestFunding = { ts: null, data: [], errors: [] };
let symbolsToProcess = []; // Biến toàn cục để cache danh sách coin

async function refreshAll() {
    console.log(`\n[${new Date().toISOString()}] Bắt đầu chu trình cập nhật...`);
    
    if (symbolsToProcess.length === 0) {
        console.warn("[Cảnh báo] Danh sách symbol đang trống. Bot sẽ không fetch giá.");
        return;
    }

    console.log(`[Tiến hành] Sử dụng danh sách đã lưu trữ, fetch dữ liệu cho ${symbolsToProcess.length} symbol...`);
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


// === KHỞI ĐỘNG SERVER ===
async function startServer() {
    // Bước 1: Lấy và cache danh sách coin. Thử lại nếu thất bại.
    while (symbolsToProcess.length === 0) {
        symbolsToProcess = await fetchAndCacheSymbolList();
        if (symbolsToProcess.length === 0) {
            await new Promise(resolve => setTimeout(resolve, 60 * 1000)); // Đợi 1 phút rồi thử lại
        }
    }

    // Bước 2: Khi đã có danh sách, khởi động server và chu trình refresh
    server.listen(PORT, () => {
        console.log(`Server ước tính funding đang chạy tại: http://localhost:${PORT}/api/funding-estimate`);
        // Chạy lần đầu ngay khi khởi động
        refreshAll();
        // Lặp lại sau mỗi 5 phút
        setInterval(refreshAll, 5 * 60 * 1000);
    });
}

startServer();
