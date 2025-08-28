// index.js
// PHIÊN BẢN HOÀN THIỆN V2 - Tự động lọc coin hợp lệ trên cả Spot và Futures

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URLSearchParams } = require("url");
const { WebSocketServer } = require("ws");
// Đảm bảo bạn có file config.js với API key và secret
const { bingxApiKey, bingxApiSecret } = require("./config.js");

const HOST = "open-api.bingx.com";
const PORT = 1997;

// DANH SÁCH COIN BẠN MUỐN THEO DÕI (Điền thoải mái, code sẽ tự lọc)
const TARGET_COINS = [
    "LPT-USDT",
    "BTC-USDT",
    "ETH-USDT",
    "SOL-USDT",
    "BIO-USDT",  // Coin này có thể chỉ có trên Futures
    "DOGE-USDT", // Coin này có trên cả 2
    "CAT-USDT",  // Coin này không tồn tại, sẽ bị loại bỏ
    "WAVE-USDT", // Coin này không tồn tại, sẽ bị loại bỏ
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
        headers: { 'X-BX-APIKEY': bingxApiKey, 'User-Agent': 'Node/BingX-Funding-Pro-V2' },
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

// === CẢI TIẾN: Lấy danh sách tất cả các contract hợp lệ từ BingX ===
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

    // Trả về một Set để kiểm tra sự tồn tại nhanh hơn (O(1))
    return {
        spot: new Set(spotContracts.symbols.map(c => c.symbol)),
        futures: new Set(futuresContracts.map(c => c.symbol))
    };
}

// === LẤY GIÁ VÀ TÍNH TOÁN (Không đổi) ===
async function fetchFundingEstimate(symbol) {
    try {
        // Cả hai lệnh gọi này giờ đây chỉ được thực hiện khi symbol đã được xác thực
        const [spotData, futuresData] = await Promise.all([
            apiRequest('/openApi/spot/v1/ticker/24hr', { symbol }),
            apiRequest('/openApi/swap/v2/quote/ticker', { symbol })
        ]);

        if (!spotData || typeof spotData.lastPrice === 'undefined') {
            throw new Error('Dữ liệu Spot trả về không hợp lệ');
        }
        if (!Array.isArray(futuresData) || futuresData.length === 0 || typeof futuresData[0].lastPrice === 'undefined') {
            throw new Error('Dữ liệu Futures trả về không hợp lệ');
        }

        const spotPrice = parseFloat(spotData.lastPrice);
        const futuresPrice = parseFloat(futuresData[0].lastPrice);
        const fundingEstimate = (futuresPrice - spotPrice) / spotPrice;

        return {
            symbol, spot: spotPrice, futures: futuresPrice, fundingEstimate,
            fundingEstimatePercent: `${(fundingEstimate * 100).toFixed(6)}%`,
            ts: new Date().toISOString(),
        };
    } catch (e) {
        // Lỗi ở đây bây giờ rất hiếm, thường là do API tạm thời lỗi chứ không phải do symbol sai
        return { symbol, error: e.message };
    }
}

// === STATE & REFRESH (Nâng cấp toàn diện) ===
let latestFunding = { ts: null, data: [], notFound: [], futuresOnly: [] };

async function refreshAll() {
    console.log(`\n[${new Date().toISOString()}] Bắt đầu chu trình cập nhật...`);
    let validSymbols;
    try {
        // Bước 1: Lấy danh sách TẤT CẢ coin hợp lệ trên cả hai sàn
        validSymbols = await fetchAllValidContracts();
        console.log(`[Thông tin] Tìm thấy ${validSymbols.spot.size} symbol trên Spot và ${validSymbols.futures.size} symbol trên Futures.`);
    } catch (e) {
        console.error("[Lỗi nghiêm trọng] Không thể lấy danh sách symbols từ BingX. Hủy bỏ chu trình.", e.message);
        return; // Dừng lại nếu không lấy được danh sách
    }

    // Bước 2: Lọc danh sách TARGET_COINS
    const symbolsToFetch = [];
    const notFoundSymbols = [];
    const futuresOnlySymbols = [];

    TARGET_COINS.forEach(symbol => {
        const isOnFutures = validSymbols.futures.has(symbol);
        const isOnSpot = validSymbols.spot.has(symbol);

        if (isOnFutures && isOnSpot) {
            symbolsToFetch.push(symbol); // Tồn tại trên cả hai -> Hợp lệ để tính funding
        } else if (isOnFutures && !isOnSpot) {
            futuresOnlySymbols.push(symbol); // Chỉ có trên Futures
        } else {
            notFoundSymbols.push(symbol); // Không tồn tại trên Futures
        }
    });

    if (notFoundSymbols.length > 0) {
        console.warn(`[Cảnh báo] Các symbol sau không tồn tại trên sàn Futures và đã được bỏ qua: ${notFoundSymbols.join(', ')}`);
    }
    if (futuresOnlySymbols.length > 0) {
        console.info(`[Thông tin] Các symbol sau chỉ có trên Futures, không có trên Spot (bỏ qua tính toán): ${futuresOnlySymbols.join(', ')}`);
    }

    // Bước 3: Chỉ fetch dữ liệu cho các coin hợp lệ (tồn tại trên cả Spot và Futures)
    console.log(`[Tiến hành] Fetch dữ liệu cho ${symbolsToFetch.length} symbol hợp lệ để tính funding...`);
    const results = await Promise.all(symbolsToFetch.map(symbol => fetchFundingEstimate(symbol)));

    for (const result of results) {
        if (!result.error) {
            console.log(`[Thành công] ${result.symbol}: Ước tính = ${result.fundingEstimatePercent}`);
        } else {
            console.log(`[Thất bại] ${result.symbol}: ${result.error}`);
        }
    }

    // Cập nhật trạng thái cuối cùng, bao gồm cả các symbol không tìm thấy và chỉ có trên futures
    latestFunding = {
        ts: new Date().toISOString(),
        data: results.filter(r => !r.error), // Chỉ lấy các kết quả thành công
        errors: results.filter(r => r.error), // Các lỗi phát sinh lúc fetch
        notFound: notFoundSymbols,
        futuresOnly: futuresOnlySymbols
    };
    
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
    setInterval(refreshAll, 5 * 60 * 1000); // 5 phút một lần
});
