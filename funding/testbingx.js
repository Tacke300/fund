// index.js
// PHIÊN BẢN HOÀN THIỆN - Tự động lọc coin hợp lệ trước khi fetch

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URLSearchParams } = require("url");
const { WebSocketServer } = require("ws");
// Đảm bảo bạn có file config.js với API key và secret
const { bingxApiKey, bingxApiSecret } = require("./config.js");

const HOST = "open-api.bingx.com";
const PORT = 1997;

// DANH SÁCH COIN BẠN MUỐN THEO DÕI (Cứ điền thoải mái, code sẽ tự lọc)
const TARGET_COINS = [
    "LPT-USDT",
    "BTC-USDT",
    "ETH-USDT",
    "SOL-USDT",
    "BIO-USDT",
    "CAT-USDT",  // Coin này không tồn tại, sẽ bị tự động loại bỏ
    "WAVE-USDT", // Coin này không tồn tại, sẽ bị tự động loại bỏ
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
        headers: { 'X-BX-APIKEY': bingxApiKey, 'User-Agent': 'Node/BingX-Funding-Pro' },
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
    // Endpoint này không cần tham số nào khác ngoài timestamp
    const contracts = await apiRequest('/openApi/swap/v2/quote/contracts');
    if (!Array.isArray(contracts)) {
        throw new Error('Không thể lấy danh sách contracts hợp lệ.');
    }
    // Trả về một Set để kiểm tra sự tồn tại nhanh hơn (O(1))
    return new Set(contracts.map(c => c.symbol));
}

// === LẤY GIÁ VÀ TÍNH TOÁN (Không đổi) ===
async function fetchFundingEstimate(symbol) {
    try {
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
        return { symbol, error: e.message };
    }
}

// === STATE & REFRESH (Đã được nâng cấp) ===
let latestFunding = { ts: null, data: [], notFound: [] };

async function refreshAll() {
    console.log(`\n[${new Date().toISOString()}] Bắt đầu chu trình cập nhật...`);
    
    let validSymbols;
    try {
        // Bước 1: Lấy danh sách TẤT CẢ coin hợp lệ trên sàn
        validSymbols = await fetchAllValidContracts();
        console.log(`[Thông tin] Tìm thấy ${validSymbols.size} symbol hợp lệ trên BingX.`);
    } catch (e) {
        console.error("[Lỗi nghiêm trọng] Không thể lấy danh sách contracts từ BingX. Hủy bỏ chu trình.", e.message);
        return; // Dừng lại nếu không lấy được danh sách
    }

    // Bước 2: Lọc danh sách TARGET_COINS của bạn, chỉ giữ lại những coin thực sự tồn tại
    const symbolsToFetch = [];
    const notFoundSymbols = [];
    TARGET_COINS.forEach(symbol => {
        if (validSymbols.has(symbol)) {
            symbolsToFetch.push(symbol);
        } else {
            notFoundSymbols.push(symbol);
        }
    });

    if (notFoundSymbols.length > 0) {
        console.warn(`[Cảnh báo] Các symbol sau không tồn tại và đã được bỏ qua: ${notFoundSymbols.join(', ')}`);
    }

    // Bước 3: Chỉ fetch dữ liệu cho các coin hợp lệ đã được lọc
    console.log(`[Tiến hành] Fetch dữ liệu cho ${symbolsToFetch.length} symbol hợp lệ...`);
    const results = await Promise.all(symbolsToFetch.map(symbol => fetchFundingEstimate(symbol)));

    for (const result of results) {
        if (!result.error) {
            console.log(`[Thành công] ${result.symbol}: Ước tính = ${result.fundingEstimatePercent}`);
        } else {
            // Lỗi ở bước này thường là do API tạm thời trục trặc, không phải do symbol sai
            console.log(`[Thất bại] ${result.symbol}: ${result.error}`);
        }
    }
    
    // Cập nhật trạng thái cuối cùng, bao gồm cả các symbol không tìm thấy
    latestFunding = { 
        ts: new Date().toISOString(), 
        data: results, 
        notFound: notFoundSymbols 
    };
    broadcast({ type: "update", data: latestFunding });
    console.log(`Cập nhật hoàn tất.`);
}


// === HTTP + WS SERVER (Không thay đổi) ===
const server = http.createServer((req, res) => {
    // Đổi tên endpoint cho rõ ràng hơn
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
    setInterval(refreshAll, 5 * 60 * 1000); // Tăng thời gian refresh lên 5 phút để giảm tải
});
