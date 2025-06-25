// File: listtop.js (hoặc tên file của VPS1 Data Provider)

import WebSocket from 'ws';
import http from 'http'; // SỬ DỤNG HTTP cho server của VPS1
import https from 'https'; // SỬ DỤNG HTTPS để gọi ra Binance API
import express from 'express';
import { URL } from 'url';

const app = express();
const port = 9000;

const BINANCE_FAPI_BASE_URL = 'https://fapi.binance.com';
const BINANCE_WS_URL = 'wss://fstream.binance.com/stream?streams=';

const WINDOW_MINUTES = 60;
let coinData = {};
let topRankedCoinsForApi = []; // Chỉ cần dữ liệu cho API
let allSymbols = [];
let wsClient = null;
let vps1DataStatus = "initializing"; // 'initializing', 'running_symbols_fetched', 'running_data_available', 'error_binance_symbols', 'error_binance_data'

function logVps1(message) {
    // Đảm bảo múi giờ đúng cho log
    const now = new Date();
    const offset = 7 * 60 * 60 * 1000; // Offset cho GMT+7
    const localTime = new Date(now.getTime() + offset);
    const timestamp = localTime.toISOString().replace('T', ' ').substring(0, 23);
    console.log(`[VPS1_DP] ${timestamp} - ${message}`);
}

function httpsGetJson(urlString) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(urlString);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'NodeJS-Client/1.0-VPS1' },
            timeout: 20000 // Tăng timeout lên 20 giây
        };
        // logVps1(`HTTPS GET: ${urlString}`);
        const req = https.request(options, (res) => {
            let data = '';
            // logVps1(`HTTPS Response Status from ${urlString}: ${res.statusCode}`);
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    logVps1(`HTTPS Error Body from ${urlString} (status ${res.statusCode}): ${data.substring(0, 300)}`);
                    reject(new Error(`Request Failed. Status Code: ${res.statusCode} for ${urlString}. Body: ${data.substring(0,200)}`));
                });
                return;
            }
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    logVps1(`HTTPS JSON Parse Error from ${urlString}: ${e.message}. Data: ${data.substring(0,300)}`);
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
            reject(new Error(`Request to ${urlString} timed out after ${options.timeout/1000}s`));
        });
        req.end();
    });
}

async function getAllFuturesSymbols(retryCount = 0) {
    const maxRetries = 5; // Tăng số lần thử
    const retryDelay = 7000; // 7 giây
    try {
        logVps1(`Attempting to get symbols from Binance (attempt ${retryCount + 1}/${maxRetries + 1})...`);
        const data = await httpsGetJson(`${BINANCE_FAPI_BASE_URL}/fapi/v1/exchangeInfo`);
        if (!data || !data.symbols || !Array.isArray(data.symbols)) { // Kiểm tra kỹ hơn
            throw new Error("Invalid exchangeInfo data or missing/invalid symbols array.");
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
            logVps1(`Failed to fetch symbols after ${maxRetries + 1} attempts. API will serve error state.`);
            vps1DataStatus = "error_binance_symbols";
            topRankedCoinsForApi = [{ error_message: "VPS1: Could not fetch symbols from Binance after multiple retries." }];
            return [];
        }
    }
}

async function fetchInitialHistoricalData(symbolsToFetch) {
    if (!symbolsToFetch || symbolsToFetch.length === 0) {
        logVps1("No symbols provided to fetch historical data. Skipping.");
        if (allSymbols.length > 0 && vps1DataStatus === "running_symbols_fetched") { // Nếu đã có symbols nhưng không có gì để fetch tiếp
             vps1DataStatus = "running_no_data_to_fetch_initially";
        }
        return;
    }
    logVps1(`Fetching initial historical data for ${symbolsToFetch.length} symbols...`);
    const now = Date.now();
    let fetchedAnyData = false;

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
                    fetchedAnyData = true;
                }
            } else {
                logVps1(`No klines data returned for ${symbol}.`);
            }
        } catch (error) {
            const errorMsg = error.message || "Unknown error";
            if (errorMsg.includes('400') || errorMsg.includes('404') || errorMsg.toLowerCase().includes("invalid symbol")) {
                logVps1(`Symbol ${symbol} invalid or no data (400/404/Invalid). Removing.`);
                delete coinData[symbol];
                allSymbols = allSymbols.filter(s => s !== symbol);
            } else if (errorMsg.includes('429')) {
                logVps1(`Rate limited for ${symbol}. Will retry this symbol later.`);
                await new Promise(resolve => setTimeout(resolve, 10000)); // Chờ lâu hơn
                await fetchInitialHistoricalData([symbol]);
            } else {
                logVps1(`Error fetching historical data for ${symbol}: ${errorMsg}.`);
            }
        }
        await new Promise(resolve => setTimeout(resolve, 350)); // Tăng nhẹ delay
    }
    logVps1("Initial historical data fetching process complete.");
    if (fetchedAnyData) {
        calculateAndRank();
        if (vps1DataStatus !== "error_binance_symbols") vps1DataStatus = "running_data_available";
    } else if (vps1DataStatus === "running_symbols_fetched") {
        vps1DataStatus = "running_no_initial_data_ranked";
        logVps1("No historical data could be ranked after fetching.");
    }
}

function connectToBinanceWebSocket(symbolsToStream) {
    if (wsClient && (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING)) {
        logVps1("Closing existing WebSocket before reconnecting.");
        wsClient.removeAllListeners();
        wsClient.terminate(); // Đóng ngay lập tức
        wsClient = null;
    }
    if (!symbolsToStream || symbolsToStream.length === 0) {
        logVps1("No symbols to stream via WebSocket. WebSocket not started.");
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
                if (coinData[symbol] && klineData.x) {
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
        logVps1(`WebSocket closed. Code: ${code}, Reason: ${reason ? reason.toString().substring(0,100) : 'N/A'}. Reconnecting in 5s...`);
        setTimeout(() => connectToBinanceWebSocket(allSymbols), 5000);
    });
}

function calculateAndRank() {
    const rankedForApi = [];
    let hasValidData = false;
    for (const symbol in coinData) {
        const data = coinData[symbol];
        if (data.prices && data.prices.length >= WINDOW_MINUTES - 10 && data.priceXMinAgo && data.currentPrice && data.priceXMinAgo > 0) { // Nới lỏng điều kiện nến một chút
            const change = ((data.currentPrice - data.priceXMinAgo) / data.priceXMinAgo) * 100;
            
            const coinEntry = {
                symbol: data.symbol,
                changePercent: parseFloat(change.toFixed(2)),
                currentPrice: data.currentPrice,
                priceXMinAgo: data.priceXMinAgo,
                candles: data.prices.length
            };
            rankedForApi.push(coinEntry);
            hasValidData = true;
        }
    }
    rankedForApi.sort((a, b) => (b.changePercent || -Infinity) - (a.changePercent || -Infinity));
    topRankedCoinsForApi = rankedForApi.slice(0, 20);

    if (hasValidData) {
        // logVps1(`Ranked ${topRankedCoinsForApi.length} coins. Top: ${topRankedCoinsForApi[0]?.symbol} (${topRankedCoinsForApi[0]?.changePercent}%)`);
        if (vps1DataStatus !== "error_binance_symbols") vps1DataStatus = "running_data_available";
    } else if (vps1DataStatus === "running_symbols_fetched" || vps1DataStatus === "running_no_initial_data_ranked") {
        // Giữ nguyên status nếu đã fetch symbols nhưng chưa rank được gì
        // logVps1("No coins met ranking criteria in this cycle.");
    }
}

async function periodicallyUpdateSymbolList() {
    logVps1("Periodically checking and updating symbol list...");
    const newSymbols = await getAllFuturesSymbols(); // Hàm này đã có retry

    if (vps1DataStatus === "error_binance_symbols") {
        logVps1("Failed to fetch new symbols in periodic update, API remains in error state for symbols.");
        // Không làm gì thêm nếu không lấy được symbols mới và đang ở trạng thái lỗi symbols
        return;
    }
     if (newSymbols.length === 0) {
        logVps1("Periodic update fetched 0 symbols. This might be an issue. Keeping old list for safety.");
        return; // Không thay đổi gì nếu API trả về 0 symbols sau khi đã có symbols trước đó
    }


    const addedSymbols = newSymbols.filter(s => !allSymbols.includes(s));
    const removedSymbols = allSymbols.filter(s => !newSymbols.includes(s));

    let listChanged = false;
    if (addedSymbols.length > 0) {
        logVps1(`Detected ${addedSymbols.length} new symbols: ${addedSymbols.join(', ')}`);
        await fetchInitialHistoricalData(addedSymbols);
        listChanged = true;
    }
    if (removedSymbols.length > 0) {
         logVps1(`Detected ${removedSymbols.length} removed symbols: ${removedSymbols.join(', ')}`);
         removedSymbols.forEach(s => delete coinData[s]);
         listChanged = true;
    }

    if (listChanged) {
        allSymbols = [...newSymbols]; // Tạo một bản sao mới của mảng
        connectToBinanceWebSocket(allSymbols);
        calculateAndRank();
    } else {
        logVps1("No changes in symbol list.");
    }
    logVps1("Symbol list check complete.");
}

async function main() {
    logVps1("VPS1 Data Provider is starting...");
    allSymbols = await getAllFuturesSymbols(); // Đã có retry

    if (vps1DataStatus === "error_binance_symbols" || allSymbols.length === 0) {
        logVps1("CRITICAL: Could not fetch initial symbols. API will serve error status.");
    } else {
        await fetchInitialHistoricalData([...allSymbols]); // Truyền bản sao để tránh thay đổi allSymbols khi đang lặp
        connectToBinanceWebSocket([...allSymbols]);
        calculateAndRank(); // Gọi 1 lần sau khi có dữ liệu
    }

    setInterval(calculateAndRank, 15 * 1000); // 15 giây
    setInterval(periodicallyUpdateSymbolList, 1 * 60 * 60 * 1000); // 1 giờ

    // Endpoint phục vụ JSON tại root path `/`
    app.get('/', (req, res) => {
        if (vps1DataStatus === "running_data_available" && topRankedCoinsForApi.length > 0) {
            res.status(200).json({ status: "success", message: "Top coins data.", data: topRankedCoinsForApi });
        } else if (vps1DataStatus === "error_binance_symbols") {
             res.status(200).json({ status: "error", message: topRankedCoinsForApi[0]?.error_message || "VPS1: Failed to initialize symbols from Binance.", data: [] });
        } else if (vps1DataStatus === "initializing" || vps1DataStatus === "running_symbols_fetched" || vps1DataStatus === "running_no_initial_data_ranked" || vps1DataStatus === "running_no_data_to_fetch_initially") {
            res.status(200).json({ status: "initializing", message: "VPS1: Data is being prepared or no coins met ranking criteria yet, please try again.", data: [] });
        } else { // Trường hợp lỗi chung khác
            res.status(200).json({ status: "error", message: "VPS1: An unspecified error occurred or no data available.", data: [] });
        }
    });
    
    http.createServer(app).listen(port, '0.0.0.0', () => {
        logVps1(`Server (HTTP) is running at http://<YOUR_VPS1_IP>:${port}`);
        logVps1(`JSON data served at: http://<YOUR_VPS1_IP>:${port}/`);
    });
}

main().catch(error => {
    logVps1(`CRITICAL UNHANDLED ERROR IN MAIN: ${error.message} ${error.stack}`);
    process.exit(1);
});
