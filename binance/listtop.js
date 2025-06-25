import WebSocket from 'ws';
import http from 'http'; // SỬ DỤNG HTTP
import express from 'express';
import { URL } from 'url';

const app = express();
const port = 9000; // Port cho VPS1

const BINANCE_FAPI_BASE_URL = 'https://fapi.binance.com'; // Vẫn dùng HTTPS để gọi Binance
const BINANCE_WS_URL = 'wss://fstream.binance.com/stream?streams=';

const WINDOW_MINUTES = 60;
let coinData = {};
// Không cần topRankedCoinsHtml nữa nếu chỉ phục vụ JSON
let topRankedCoinsJson = [];
let allSymbols = [];
let wsClient = null;

// Hàm httpsGetJson để gọi API Binance (vẫn dùng https cho Binance)
function httpsGetJson(urlString) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(urlString);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        };
        const req = https.request(options, (res) => { // Vẫn là https ở đây
            let data = '';
            if (res.statusCode < 200 || res.statusCode >= 300) {
                return reject(new Error(`Request Failed. Status Code: ${res.statusCode} for ${urlString}`));
            }
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', (error) => reject(error));
        req.end();
    });
}

async function getAllFuturesSymbols() {
    try {
        const data = await httpsGetJson(`${BINANCE_FAPI_BASE_URL}/fapi/v1/exchangeInfo`);
        const symbols = data.symbols
            .filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
            .map(s => s.symbol);
        console.log(`[VPS1] Lấy được ${symbols.length} đồng coin USDT-M Futures.`);
        return symbols;
    } catch (error) {
        console.error("[VPS1] Lỗi khi lấy danh sách symbols:", error.message);
        return [];
    }
}

async function fetchInitialHistoricalData(symbols) {
    console.log("[VPS1] Đang tải dữ liệu lịch sử ban đầu...");
    const now = Date.now();
    for (const symbol of symbols) {
        if (!coinData[symbol]) {
            coinData[symbol] = {
                symbol: symbol, prices: [], changePercent: null, currentPrice: null,
                priceXMinAgo: null, lastUpdate: 0, klineOpenTime: 0
            };
        }
        try {
            const klinesData = await httpsGetJson(`${BINANCE_FAPI_BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=1m&endTime=${now}&limit=${WINDOW_MINUTES}`);
            if (klinesData && klinesData.length > 0) {
                coinData[symbol].prices = klinesData.map(k => parseFloat(k[4])).reverse();
                if (coinData[symbol].prices.length > 0) {
                    coinData[symbol].currentPrice = coinData[symbol].prices[coinData[symbol].prices.length - 1];
                    coinData[symbol].priceXMinAgo = coinData[symbol].prices[0];
                }
            }
        } catch (error) {
            const errorData = error.message.includes('Request Failed. Status Code:') ? error.message : null;
            if (errorData && (errorData.includes('400') || errorData.includes('404'))) {
                delete coinData[symbol];
                allSymbols = allSymbols.filter(s => s !== symbol);
            } else if (errorData && errorData.includes('429')) {
                console.warn(`[VPS1] Bị rate limit khi lấy lịch sử cho ${symbol}. Sẽ thử lại sau.`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                const index = symbols.indexOf(symbol);
                if (index > -1) await fetchInitialHistoricalData([symbol]);
            } else {
                console.warn(`[VPS1] Lỗi khi lấy dữ liệu lịch sử cho ${symbol}: ${error.message}.`);
            }
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    console.log("[VPS1] Tải dữ liệu lịch sử ban đầu hoàn tất.");
    calculateAndRank();
}

function connectToBinanceWebSocket(symbols) {
    if (wsClient && (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING)) {
        wsClient.close();
    }
    if (symbols.length === 0) return;
    const streams = symbols.map(s => `${s.toLowerCase()}@kline_1m`).join('/');
    const url = `${BINANCE_WS_URL}${streams}`;
    console.log(`[VPS1] Đang kết nối WebSocket tới: ${streams.substring(0,100)}... (${symbols.length} streams)`);
    wsClient = new WebSocket(url);
    wsClient.on('open', () => console.log('[VPS1] Kết nối WebSocket thành công!'));
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
            console.error('[VPS1] Lỗi xử lý message từ WebSocket:', error);
        }
    });
    wsClient.on('error', (error) => console.error('[VPS1] Lỗi WebSocket:', error.message));
    wsClient.on('close', (code, reason) => {
        console.log(`[VPS1] WebSocket đã đóng. Code: ${code}, Reason: ${reason ? reason.toString() : 'N/A'}. Thử kết nối lại sau 5 giây...`);
        setTimeout(() => connectToBinanceWebSocket(allSymbols), 5000);
    });
}

function calculateAndRank() {
    const ranked = [];
    for (const symbol in coinData) {
        const data = coinData[symbol];
        if (data.prices.length >= WINDOW_MINUTES - 5 && data.priceXMinAgo && data.currentPrice && data.priceXMinAgo > 0) {
            const change = ((data.currentPrice - data.priceXMinAgo) / data.priceXMinAgo) * 100;
            data.changePercent = parseFloat(change.toFixed(2));
            ranked.push({
                symbol: data.symbol,
                changePercent: data.changePercent,
                currentPrice: data.currentPrice,
                priceXMinAgo: data.priceXMinAgo,
                candles: data.prices.length
            });
        }
    }
    ranked.sort((a, b) => b.changePercent - a.changePercent);
    topRankedCoinsJson = ranked.slice(0, 20);
    // console.log(`[VPS1] Cập nhật top ${topRankedCoinsJson.length} coins. Top 1: ${topRankedCoinsJson.length > 0 ? topRankedCoinsJson[0].symbol : 'N/A'}`);
}

async function periodicallyUpdateSymbolList() {
    console.log("[VPS1] Đang kiểm tra và cập nhật danh sách symbol...");
    const newSymbols = await getAllFuturesSymbols();
    const addedSymbols = newSymbols.filter(s => !allSymbols.includes(s));
    const removedSymbols = allSymbols.filter(s => !newSymbols.includes(s));
    if (addedSymbols.length > 0) {
        console.log(`[VPS1] Phát hiện ${addedSymbols.length} symbol mới: ${addedSymbols.join(', ')}`);
        allSymbols = newSymbols;
        await fetchInitialHistoricalData(addedSymbols);
        connectToBinanceWebSocket(allSymbols);
    }
    if (removedSymbols.length > 0) {
         console.log(`[VPS1] Phát hiện ${removedSymbols.length} symbol bị loại bỏ: ${removedSymbols.join(', ')}`);
         removedSymbols.forEach(s => delete coinData[s]);
         allSymbols = newSymbols;
         connectToBinanceWebSocket(allSymbols);
    }
    console.log("[VPS1] Kiểm tra danh sách symbol hoàn tất.");
}

async function main() {
    allSymbols = await getAllFuturesSymbols();
    if (allSymbols.length === 0) {
        topRankedCoinsJson = [{ error: "Không thể lấy danh sách symbol từ Binance." }];
        // Endpoint phục vụ JSON tại root path
        app.get('/', (req, res) => res.status(500).json(topRankedCoinsJson));
        http.createServer(app).listen(port, '0.0.0.0', () => { // SỬ DỤNG HTTP SERVER
            console.log(`[VPS1] Server Data Provider (HTTP) đang chạy tại http://<IP_CUA_VPS1>:${port} với lỗi.`);
        });
        return;
    }
    await fetchInitialHistoricalData(allSymbols);
    connectToBinanceWebSocket(allSymbols);

    setInterval(calculateAndRank, 15 * 1000);
    setInterval(periodicallyUpdateSymbolList, 6 * 60 * 60 * 1000);

    // Endpoint chính phục vụ JSON tại root path
    app.get('/', (req, res) => {
        if (topRankedCoinsJson.length > 0 && !topRankedCoinsJson[0].error) {
            res.json(topRankedCoinsJson);
        } else if (topRankedCoinsJson.length > 0 && topRankedCoinsJson[0].error) {
             res.status(500).json(topRankedCoinsJson);
        } else {
            res.status(200).json({ message: "Đang khởi tạo dữ liệu, vui lòng thử lại sau giây lát." });
        }
    });

    // Tạo HTTP server và lắng nghe
    http.createServer(app).listen(port, '0.0.0.0', () => { // SỬ DỤNG HTTP SERVER
        console.log(`[VPS1] Server Data Provider (HTTP) đang chạy tại http://<IP_CUA_VPS1>:${port}`);
        console.log(`[VPS1] Dữ liệu JSON được phục vụ tại: http://<IP_CUA_VPS1>:${port}/`);
    });
}

main().catch(console.error);
