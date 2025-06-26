// File: listtop.js (VPS1 Data Provider)

import WebSocket from 'ws';
import http from 'http'; // SỬ DỤNG HTTP cho server của VPS1
import https from 'https'; // SỬ DỤNG HTTPS để gọi ra Binance API
import express from 'express';
import { URL } from 'url';

const app = express();
const port = 9000; // Port VPS1 sẽ lắng nghe

const BINANCE_FAPI_BASE_URL = 'https://fapi.binance.com';
const BINANCE_WS_URL = 'wss://fstream.binance.com/stream?streams=';

const WINDOW_MINUTES = 60; // Số phút dữ liệu nến được lưu trữ và tính toán
let coinData = {};
let topRankedCoinsForApi = []; // Dữ liệu được tối ưu cho API trả về
let allSymbols = [];
let wsClient = null;
let vps1DataStatus = "initializing"; // 'initializing', 'running_symbols_fetched', 'running_data_available', 'error_binance_symbols', 'error_binance_data', 'running_no_data_to_fetch_initially', 'running_no_initial_data_ranked'

function logVps1(message) {
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
        const req = https.request(options, (res) => {
            let data = '';
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
    const maxRetries = 5;
    const retryDelay = 7000; // 7 giây
    try {
        logVps1(`Attempting to get symbols from Binance (attempt ${retryCount + 1}/${maxRetries + 1})...`);
        const data = await httpsGetJson(`${BINANCE_FAPI_BASE_URL}/fapi/v1/exchangeInfo`);
        if (!data || !data.symbols || !Array.isArray(data.symbols)) {
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
        if (allSymbols.length > 0 && vps1DataStatus === "running_symbols_fetched") {
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
            const klinesData = await httpsGetJson(`${BINANCE_FAPI_BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=1m&endTime=${now}&limit=${WINDOW_MINUTES}`);
            if (klinesData && klinesData.length > 0) {
                // Sắp xếp nến: nến cũ nhất ở đầu (index 0), nến mới nhất ở cuối
                coinData[symbol].prices = klinesData.map(k => parseFloat(k[4])); // Chỉ lấy giá đóng cửa
                if (coinData[symbol].prices.length > 0) {
                    coinData[symbol].currentPrice = coinData[symbol].prices[coinData[symbol].prices.length - 1]; // Giá hiện tại là giá đóng của nến cuối cùng
                    coinData[symbol].priceXMinAgo = coinData[symbol].prices[0]; // Giá X phút trước là giá đóng của nến đầu tiên
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
                await new Promise(resolve => setTimeout(resolve, 10000));
                await fetchInitialHistoricalData([symbol]); // Retry for this specific symbol
            } else {
                logVps1(`Error fetching historical data for ${symbol}: ${errorMsg}.`);
            }
        }
        await new Promise(resolve => setTimeout(resolve, 350)); // Delay giữa các request
    }
    logVps1("Initial historical data fetching process complete.");
    if (fetchedAnyData) {
        calculateAndRank(); // Tính toán và xếp hạng ngay sau khi có dữ liệu
        if (vps1DataStatus !== "error_binance_symbols") vps1DataStatus = "running_data_available";
    } else if (vps1DataStatus === "running_symbols_fetched" && allSymbols.length > 0) {
        vps1DataStatus = "running_no_initial_data_ranked";
        logVps1("No historical data could be ranked after fetching, though symbols are available.");
    }
}

function connectToBinanceWebSocket(symbolsToStream) {
    if (wsClient && (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING)) {
        logVps1("Closing existing WebSocket before reconnecting.");
        wsClient.removeAllListeners();
        wsClient.terminate();
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

                if (coinData[symbol] && klineData.x) { // Chỉ cập nhật khi nến đã đóng (klineData.x === true)
                    const closePrice = parseFloat(klineData.c);
                    const openTime = parseInt(klineData.t); // Thời gian mở nến

                    // Đảm bảo không xử lý lại cùng một nến
                    if (openTime > (coinData[symbol].klineOpenTime || 0)) {
                        coinData[symbol].prices.push(closePrice);
                        if (coinData[symbol].prices.length > WINDOW_MINUTES) {
                            coinData[symbol].prices.shift(); // Bỏ nến cũ nhất
                        }
                        coinData[symbol].currentPrice = closePrice; // Giá hiện tại là giá đóng của nến vừa đóng
                        coinData[symbol].priceXMinAgo = coinData[symbol].prices[0]; // Giá X phút trước là nến đầu tiên trong mảng
                        coinData[symbol].lastUpdate = Date.now();
                        coinData[symbol].klineOpenTime = openTime; // Lưu thời gian mở của nến mới nhất
                        // Không gọi calculateAndRank() ở đây, để interval xử lý
                    }
                }
            }
        } catch (error) {
            logVps1(`Error processing WebSocket message: ${error.message}. Data: ${data.toString().substring(0,100)}`);
        }
    });

    wsClient.on('error', (error) => logVps1(`WebSocket error: ${error.message}`));

    wsClient.on('close', (code, reason) => {
        logVps1(`WebSocket closed. Code: ${code}, Reason: ${reason ? reason.toString().substring(0,100) : 'N/A'}. Reconnecting in 5s...`);
        setTimeout(() => connectToBinanceWebSocket(allSymbols), 5000);
    });
}

function calculateAndRank() {
    const rankedForApiOutput = [];
    let hasValidDataForRanking = false;

    for (const symbol in coinData) {
        const data = coinData[symbol];
        // Cần ít nhất WINDOW_MINUTES - 5 nến để có thể tính toán đáng tin cậy
        if (data.prices && data.prices.length >= (WINDOW_MINUTES - 5) && data.priceXMinAgo && data.currentPrice && data.priceXMinAgo > 0) {
            const change = ((data.currentPrice - data.priceXMinAgo) / data.priceXMinAgo) * 100;

            const coinEntryForApi = {
                symbol: data.symbol,
                changePercent: parseFloat(change.toFixed(2)),
                currentPrice: data.currentPrice,
                priceXMinAgo: data.priceXMinAgo,
                candles: data.prices.length, // Số lượng nến hiện có
                lastUpdate: data.lastUpdate ? new Date(data.lastUpdate).toISOString() : null
            };
            rankedForApiOutput.push(coinEntryForApi);
            hasValidDataForRanking = true;
        }
    }

    rankedForApiOutput.sort((a, b) => (b.changePercent || -Infinity) - (a.changePercent || -Infinity));
    topRankedCoinsForApi = rankedForApiOutput.slice(0, 20); // Giữ top 20 cho API

    if (hasValidDataForRanking) {
        // logVps1(`Ranked ${topRankedCoinsForApi.length} coins. Top: ${topRankedCoinsForApi[0]?.symbol} (${topRankedCoinsForApi[0]?.changePercent}%)`);
        if (vps1DataStatus !== "error_binance_symbols") vps1DataStatus = "running_data_available";
    } else if (vps1DataStatus === "running_symbols_fetched" || vps1DataStatus === "running_no_initial_data_ranked") {
        // Giữ nguyên status nếu đã fetch symbols nhưng chưa rank được gì, hoặc chưa có đủ nến
        // logVps1("No coins met ranking criteria in this cycle or not enough candles yet.");
    }
}

async function periodicallyUpdateSymbolList() {
    logVps1("Periodically checking and updating symbol list...");
    const newSymbols = await getAllFuturesSymbols();

    if (vps1DataStatus === "error_binance_symbols") {
        logVps1("Failed to fetch new symbols in periodic update, API remains in error state for symbols.");
        return;
    }
     if (newSymbols.length === 0 && allSymbols.length > 0) { // Chỉ cảnh báo nếu trước đó đã có symbols
        logVps1("Periodic update fetched 0 symbols. This might be an issue. Keeping old list for safety.");
        return;
    }

    const addedSymbols = newSymbols.filter(s => !allSymbols.includes(s));
    const removedSymbols = allSymbols.filter(s => !newSymbols.includes(s));

    let listChanged = false;
    if (addedSymbols.length > 0) {
        logVps1(`Detected ${addedSymbols.length} new symbols: ${addedSymbols.join(', ')}. Fetching their initial data.`);
        allSymbols.push(...addedSymbols); // Thêm vào danh sách tổng trước
        await fetchInitialHistoricalData(addedSymbols); // Fetch dữ liệu cho coin mới
        listChanged = true;
    }
    if (removedSymbols.length > 0) {
         logVps1(`Detected ${removedSymbols.length} removed symbols: ${removedSymbols.join(', ')}. Removing their data.`);
         removedSymbols.forEach(s => {
             delete coinData[s];
             allSymbols = allSymbols.filter(sym => sym !== s);
         });
         listChanged = true;
    }

    if (listChanged) {
        logVps1(`Symbol list updated. Total symbols: ${allSymbols.length}. Reconnecting WebSocket and re-ranking.`);
        connectToBinanceWebSocket(allSymbols); // Kết nối lại WebSocket với danh sách mới
        calculateAndRank(); // Tính toán lại xếp hạng
    } else {
        logVps1("No changes in symbol list.");
    }
    logVps1("Symbol list check complete.");
}

async function main() {
    logVps1("VPS1 Data Provider is starting...");
    allSymbols = await getAllFuturesSymbols();

    if (vps1DataStatus === "error_binance_symbols" || allSymbols.length === 0) {
        logVps1("CRITICAL: Could not fetch initial symbols or no symbols available. API will serve error/empty status until symbols are fetched.");
        // vps1DataStatus đã được đặt trong getAllFuturesSymbols
    } else {
        await fetchInitialHistoricalData([...allSymbols]); // Fetch dữ liệu ban đầu cho tất cả symbols
        connectToBinanceWebSocket([...allSymbols]); // Kết nối WebSocket
        calculateAndRank(); // Gọi 1 lần sau khi có dữ liệu ban đầu
    }

    setInterval(calculateAndRank, 15 * 1000); // Cập nhật xếp hạng mỗi 15 giây
    setInterval(periodicallyUpdateSymbolList, 1 * 60 * 60 * 1000); // Cập nhật danh sách symbols mỗi 1 giờ

    app.get('/', (req, res) => {
        let responsePayload = { status: vps1DataStatus, message: "", data: [] };

        switch (vps1DataStatus) {
            case "running_data_available":
                if (topRankedCoinsForApi.length > 0) {
                    responsePayload.message = `Top ${topRankedCoinsForApi.length} coins data. Last rank update interval: 15s.`;
                    responsePayload.data = topRankedCoinsForApi;
                } else {
                    responsePayload.status = "initializing"; // Hoặc một status mới như "running_data_momentarily_unavailable"
                    responsePayload.message = "VPS1: Data is available but no coins met ranking criteria in the last cycle. Waiting for next calculation.";
                }
                break;
            case "error_binance_symbols":
                responsePayload.message = topRankedCoinsForApi[0]?.error_message || "VPS1: Failed to initialize symbols from Binance after multiple retries.";
                // data đã được đặt là [{error_message: ...}] trong getAllFuturesSymbols
                responsePayload.data = topRankedCoinsForApi;
                break;
            case "initializing":
            case "running_symbols_fetched":
            case "running_no_initial_data_ranked":
            case "running_no_data_to_fetch_initially":
                responsePayload.message = "VPS1: Data is being prepared or no coins have met ranking criteria yet (e.g., waiting for enough candles). Please try again shortly.";
                break;
            default: // Các trường hợp lỗi chung khác hoặc status không xác định
                responsePayload.status = "error";
                responsePayload.message = "VPS1: An unspecified error occurred or system state is unknown.";
                break;
        }
        res.status(200).json(responsePayload);
    });

    http.createServer(app).listen(port, '0.0.0.0', () => {
        logVps1(`Server (HTTP) is running on port ${port}`);
        logVps1(`JSON data served at: http://<YOUR_VPS1_IP>:${port}/`);
    });
}

main().catch(error => {
    logVps1(`CRITICAL UNHANDLED ERROR IN MAIN: ${error.message} ${error.stack}`);
    process.exit(1); // Thoát nếu có lỗi nghiêm trọng không xử lý được trong main
});
