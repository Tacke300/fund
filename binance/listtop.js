import WebSocket from 'ws';
import http from 'http'; // Sử dụng module http cho server
import https from 'https'; // Vẫn cần https để gọi ra Binance API
import express from 'express';
import { URL } from 'url';

const app = express();
const port = 9000; // Port bạn dùng cho VPS1

const BINANCE_FAPI_BASE_URL = 'https://fapi.binance.com';
const BINANCE_WS_URL = 'wss://fstream.binance.com/stream?streams=';

const WINDOW_MINUTES = 60;
let coinData = {};
let top10CoinsHtml = "<h1>Đang khởi tạo và tải dữ liệu...</h1>"; // Giữ lại HTML
let topRankedCoinsForApi = []; // Dữ liệu JSON riêng cho API mới
let allSymbols = [];
let wsClient = null;
let vps1DataStatus = "initializing"; // 'initializing', 'running', 'error_binance_connection'

function logVps1(message) {
    console.log(`[VPS1_PROVIDER] ${new Date().toISOString()} - ${message}`);
}

// Hàm helper để thực hiện GET request bằng module 'https' (cho Binance)
function httpsGetJson(urlString) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(urlString);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'NodeJS-Client/1.0' },
            timeout: 15000 // 15 giây timeout
        };
        // logVps1(`HTTPS GET: ${urlString}`);
        const req = https.request(options, (res) => {
            let data = '';
            // logVps1(`HTTPS Response Status from ${urlString}: ${res.statusCode}`);
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    logVps1(`HTTPS Error Body from ${urlString} (status ${res.statusCode}): ${data.substring(0, 200)}`);
                    reject(new Error(`Request Failed. Status Code: ${res.statusCode} for ${urlString}`));
                });
                return;
            }
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    logVps1(`HTTPS JSON Parse Error from ${urlString}: ${e.message}. Data: ${data.substring(0,200)}`);
                    reject(e);
                }
            });
        });
        req.on('error', (error) => {
            logVps1(`HTTPS Network Error for ${urlString}: ${error.message}`);
            reject(error);
        });
        req.on('timeout', () => {
            req.destroy();
            logVps1(`HTTPS Timeout for ${urlString}`);
            reject(new Error(`Request to ${urlString} timed out.`));
        });
        req.end();
    });
}

async function getAllFuturesSymbols(retryCount = 0) {
    const maxRetries = 3;
    const retryDelay = 5000; // 5 giây
    try {
        logVps1(`Attempting to get symbols from Binance (attempt ${retryCount + 1})...`);
        const data = await httpsGetJson(`${BINANCE_FAPI_BASE_URL}/fapi/v1/exchangeInfo`);
        if (!data || !data.symbols) {
            throw new Error("Invalid exchangeInfo data or missing symbols array.");
        }
        const symbols = data.symbols
            .filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
            .map(s => s.symbol);
        logVps1(`Successfully fetched ${symbols.length} USDT-M Futures symbols.`);
        vps1DataStatus = "running_symbols_fetched";
        return symbols;
    } catch (error) {
        logVps1(`Error fetching symbols (attempt ${retryCount + 1}): ${error.message}`);
        if (retryCount < maxRetries) {
            logVps1(`Retrying to fetch symbols in ${retryDelay / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            return getAllFuturesSymbols(retryCount + 1);
        } else {
            logVps1(`Failed to fetch symbols after ${maxRetries + 1} attempts.`);
            vps1DataStatus = "error_binance_symbols";
            topRankedCoinsForApi = [{ error_message: "VPS1: Could not fetch symbols from Binance." }]; // Cập nhật cho API
            return [];
        }
    }
}

async function fetchInitialHistoricalData(symbolsToFetch) {
    if (!symbolsToFetch || symbolsToFetch.length === 0) {
        logVps1("No symbols provided to fetch historical data.");
        return;
    }
    logVps1(`Fetching initial historical data for ${symbolsToFetch.length} symbols...`);
    const now = Date.now();

    for (const symbol of symbolsToFetch) {
        if (!coinData[symbol]) {
            coinData[symbol] = {
                symbol: symbol, prices: [], changePercent: null, currentPrice: null,
                priceXMinAgo: null, lastUpdate: 0, klineOpenTime: 0
            };
        }
        try {
            // logVps1(`Fetching klines for ${symbol}...`);
            const klinesData = await httpsGetJson(`${BINANCE_FAPI_BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=1m&endTime=${now}&limit=${WINDOW_MINUTES}`);
            if (klinesData && klinesData.length > 0) {
                coinData[symbol].prices = klinesData.map(k => parseFloat(k[4])).reverse();
                if (coinData[symbol].prices.length > 0) {
                    coinData[symbol].currentPrice = coinData[symbol].prices[coinData[symbol].prices.length - 1];
                    coinData[symbol].priceXMinAgo = coinData[symbol].prices[0];
                }
            }
        } catch (error) {
            const errorMsg = error.message || "Unknown error";
            if (errorMsg.includes('400') || errorMsg.includes('404')) {
                logVps1(`Symbol ${symbol} seems invalid or no data (400/404). Removing.`);
                delete coinData[symbol];
                allSymbols = allSymbols.filter(s => s !== symbol); // Cập nhật lại allSymbols
            } else if (errorMsg.includes('429')) {
                logVps1(`Rate limited while fetching klines for ${symbol}. Will retry this symbol later.`);
                await new Promise(resolve => setTimeout(resolve, 7000)); // Chờ lâu hơn chút
                await fetchInitialHistoricalData([symbol]); // Thử lại chỉ cho symbol này
            } else {
                logVps1(`Error fetching historical data for ${symbol}: ${errorMsg}.`);
            }
        }
        await new Promise(resolve => setTimeout(resolve, 300)); // Tăng nhẹ delay giữa các symbol
    }
    logVps1("Initial historical data fetching complete.");
    if (symbolsToFetch.length > 0) calculateAndRank(); // Tính toán nếu có dữ liệu mới
}

function connectToBinanceWebSocket(symbolsToStream) {
    if (wsClient && (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING)) {
        logVps1("Closing existing WebSocket connection before reconnecting.");
        wsClient.close();
    }
    if (!symbolsToStream || symbolsToStream.length === 0) {
        logVps1("No symbols to stream via WebSocket.");
        return;
    }
    const streams = symbolsToStream.map(s => `${s.toLowerCase()}@kline_1m`).join('/');
    const url = `${BINANCE_WS_URL}${streams}`;
    logVps1(`Connecting to WebSocket for ${symbolsToStream.length} streams (e.g., ${streams.substring(0,100)}...).`);
    wsClient = new WebSocket(url);
    wsClient.on('open', () => logVps1('WebSocket connection successful!'));
    wsClient.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            if (message.data && message.data.e === 'kline') {
                const klineData = message.data.k;
                const symbol = klineData.s;
                if (coinData[symbol] && klineData.x) { // kline is closed
                    const closePrice = parseFloat(klineData.c);
                    const openTime = parseInt(klineData.t);
                    if (openTime > (coinData[symbol].klineOpenTime || 0)) {
                        coinData[symbol].prices.push(closePrice);
                        if (coinData[symbol].prices.length > WINDOW_MINUTES) {
                            coinData[symbol].prices.shift();
                        }
                        coinData[symbol].currentPrice = closePrice;
                        coinData[symbol].priceXMinAgo = coinData[symbol].prices[0];
                        coinData[symbol].lastUpdate = Date.now();
                        coinData[symbol].klineOpenTime = openTime;
                    }
                }
            }
        } catch (error) {
            logVps1(`Error processing WebSocket message: ${error.message}`);
        }
    });
    wsClient.on('error', (error) => logVps1(`WebSocket error: ${error.message}`));
    wsClient.on('close', (code, reason) => {
        logVps1(`WebSocket closed. Code: ${code}, Reason: ${reason ? reason.toString() : 'N/A'}. Reconnecting in 5s...`);
        setTimeout(() => connectToBinanceWebSocket(allSymbols), 5000); // Luôn dùng allSymbols để kết nối lại
    });
}

function calculateAndRank() {
    const rankedForHtml = [];
    const rankedForApi = [];

    for (const symbol in coinData) {
        const data = coinData[symbol];
        if (data.prices.length >= WINDOW_MINUTES - 5 && data.priceXMinAgo && data.currentPrice && data.priceXMinAgo > 0) {
            const change = ((data.currentPrice - data.priceXMinAgo) / data.priceXMinAgo) * 100;
            data.changePercent = parseFloat(change.toFixed(2));
            
            const coinEntry = {
                symbol: data.symbol,
                changePercent: data.changePercent,
                currentPrice: data.currentPrice,
                priceXMinAgo: data.priceXMinAgo,
                candles: data.prices.length
            };
            rankedForHtml.push(data); // Cho HTML, cần cả mảng prices
            rankedForApi.push(coinEntry); // Cho API, chỉ cần thông tin tổng hợp
        }
    }

    rankedForHtml.sort((a, b) => (b.changePercent || -Infinity) - (a.changePercent || -Infinity));
    rankedForApi.sort((a, b) => (b.changePercent || -Infinity) - (a.changePercent || -Infinity));
    
    top10CoinsHtml = generateHtml(rankedForHtml.slice(0, 20)); // HTML vẫn dùng top 20 từ data đầy đủ
    topRankedCoinsForApi = rankedForApi.slice(0, 20); // API cũng dùng top 20

    if (topRankedCoinsForApi.length > 0) {
        // logVps1(`Updated top coins. API Top 1: ${topRankedCoinsForApi[0].symbol} (${topRankedCoinsForApi[0].changePercent}%)`);
        vps1DataStatus = "running_data_available";
    } else if (vps1DataStatus === "running_symbols_fetched") { // Nếu đã fetch symbols nhưng chưa có data rank
        vps1DataStatus = "running_no_ranked_data";
    }
}

function generateHtml(coinsToDisplay) { // coinsToDisplay là mảng đã được sort và slice
    let html = `
        <html><head><title>Top Coin Biến Động (USDT-M)</title><meta http-equiv="refresh" content="30">
        <style>body{font-family:Arial,sans-serif;margin:20px;background-color:#f4f4f4;color:#333}h1{text-align:center;color:#1a1a1a}table{width:80%;margin:20px auto;border-collapse:collapse;box-shadow:0 0 10px rgba(0,0,0,0.1);background-color:#fff}th,td{border:1px solid #ddd;padding:12px;text-align:left}th{background-color:#f0b90b;color:#333}tr:nth-child(even){background-color:#f9f9f9}.positive{color:green}.negative{color:red}.timestamp{text-align:center;font-size:0.9em;color:#777;margin-top:20px}</style></head>
        <body><h1>Top ${coinsToDisplay.length} Coin Biến Động Mạnh Nhất (${WINDOW_MINUTES} phút)</h1><table><thead><tr><th>#</th><th>Symbol</th><th>Giá hiện tại</th><th>Giá ${WINDOW_MINUTES}p trước</th><th>% Thay đổi</th><th>Số nến 1m</th></tr></thead><tbody>`;
    if (coinsToDisplay.length > 0) {
        coinsToDisplay.forEach((coin, index) => {
            const changeClass = coin.changePercent > 0 ? 'positive' : (coin.changePercent < 0 ? 'negative' : '');
            html += `<tr><td>${index + 1}</td><td>${coin.symbol}</td><td>${coin.currentPrice !== null ? coin.currentPrice.toFixed(4) : 'N/A'}</td><td>${coin.priceXMinAgo !== null ? coin.priceXMinAgo.toFixed(4) : 'N/A'}</td><td class="${changeClass}">${coin.changePercent !== null ? coin.changePercent + '%' : 'N/A'}</td><td>${coin.prices.length}</td></tr>`;
        });
    } else {
        html += `<tr><td colspan="6" style="text-align:center;">Không có dữ liệu hoặc đang chờ cập nhật...</td></tr>`;
    }
    html += `</tbody></table><div class="timestamp">Cập nhật lúc: ${new Date().toLocaleTimeString('vi-VN')}</div></body></html>`;
    return html; // Trả về HTML string
}

async function periodicallyUpdateSymbolList() {
    logVps1("Periodically checking and updating symbol list...");
    const newSymbols = await getAllFuturesSymbols();
    if (newSymbols.length === 0 && allSymbols.length > 0) { // Nếu không lấy được symbols mới và trước đó đã có
        logVps1("Failed to fetch new symbols, keeping the old list for now.");
        // Không thay đổi allSymbols hoặc kết nối lại WebSocket vội
        return;
    }
    if (newSymbols.length === 0 && allSymbols.length === 0) { // Vẫn không lấy được
         logVps1("Still unable to fetch symbols.");
         return;
    }

    const addedSymbols = newSymbols.filter(s => !allSymbols.includes(s));
    const removedSymbols = allSymbols.filter(s => !newSymbols.includes(s));

    let listChanged = false;
    if (addedSymbols.length > 0) {
        logVps1(`Detected ${addedSymbols.length} new symbols: ${addedSymbols.join(', ')}`);
        await fetchInitialHistoricalData(addedSymbols); // Fetch data cho symbol mới
        listChanged = true;
    }
    if (removedSymbols.length > 0) {
         logVps1(`Detected ${removedSymbols.length} removed symbols: ${removedSymbols.join(', ')}`);
         removedSymbols.forEach(s => delete coinData[s]);
         listChanged = true;
    }

    if (listChanged) {
        allSymbols = newSymbols; // Cập nhật danh sách allSymbols
        connectToBinanceWebSocket(allSymbols); // Kết nối lại WebSocket với danh sách mới
        calculateAndRank(); // Tính toán lại ngay
    }
    logVps1("Symbol list check complete.");
}

async function main() {
    logVps1("VPS1 Data Provider is starting...");
    allSymbols = await getAllFuturesSymbols(); // Hàm này đã có retry và cập nhật vps1DataStatus

    if (vps1DataStatus === "error_binance_symbols" || allSymbols.length === 0) {
        logVps1("Critical error: Could not fetch initial symbols from Binance. API will serve error status.");
        // Endpoint phục vụ JSON tại /data/top-coins
        app.get('/data/top-coins', (req, res) => {
             res.status(200).json({ status: "error", message: "VPS1: Failed to initialize symbols from Binance.", data: [] });
        });
        // Endpoint phục vụ HTML tại /
        app.get('/', (req, res) => {
            res.send("<h1>Lỗi: Không thể lấy danh sách symbol từ Binance để khởi tạo.</h1>");
        });

    } else {
        await fetchInitialHistoricalData(allSymbols);
        connectToBinanceWebSocket(allSymbols);
        calculateAndRank(); // Gọi một lần sau khi có dữ liệu ban đầu

        setInterval(calculateAndRank, 15 * 1000);
        setInterval(periodicallyUpdateSymbolList, 1 * 60 * 60 * 1000); // Check symbol list mỗi giờ

        // Endpoint phục vụ HTML tại /
        app.get('/', (req, res) => {
            res.send(top10CoinsHtml); // top10CoinsHtml được cập nhật trong calculateAndRank
        });
        
        // Endpoint MỚI phục vụ JSON tại /data/top-coins
        app.get('/data/top-coins', (req, res) => {
            if (vps1DataStatus === "running_data_available" && topRankedCoinsForApi.length > 0) {
                res.status(200).json({ status: "success", message: "Top coins data.", data: topRankedCoinsForApi });
            } else if (vps1DataStatus === "running_no_ranked_data" || vps1DataStatus === "running_symbols_fetched") {
                res.status(200).json({ status: "initializing", message: "VPS1: Data is being prepared, please try again.", data: [] });
            } else { // Bao gồm error_binance_symbols hoặc initializing ban đầu
                res.status(200).json({ status: "error", message: "VPS1: Error or no data available.", data: topRankedCoinsForApi });
            }
        });
    }
    
    // Tạo HTTP server và lắng nghe
    http.createServer(app).listen(port, '0.0.0.0', () => {
        logVps1(`Server (HTTP) is running at http://<YOUR_VPS1_IP>:${port}`);
        logVps1(`HTML view at: http://<YOUR_VPS1_IP>:${port}/`);
        logVps1(`JSON API at: http://<YOUR_VPS1_IP>:${port}`);
    });
}

main().catch(error => {
    logVps1(`Unhandled error in main: ${error.message}`);
    process.exit(1); // Thoát nếu có lỗi nghiêm trọng không xử lý được ở main
});
