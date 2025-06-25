import WebSocket from 'ws';
import https from 'https';
import express from 'express';
import { URL } from 'url';

const app = express();
const port = 9000; // Port cho VPS1

const BINANCE_FAPI_BASE_URL = 'https://fapi.binance.com';
const BINANCE_WS_URL = 'wss://fstream.binance.com/stream?streams=';

const WINDOW_MINUTES = 60;
let coinData = {};
let topRankedCoinsHtml = "<h1>Đang khởi tạo và tải dữ liệu...</h1>";
let topRankedCoinsJson = []; // Dữ liệu JSON cho API
let allSymbols = [];
let wsClient = null;

function httpsGetJson(urlString) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(urlString);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        };
        const req = https.request(options, (res) => {
            let data = '';
            if (res.statusCode < 200 || res.statusCode >= 300) {
                return reject(new Error(`Request Failed. Status Code: ${res.statusCode} for ${urlString}`));
            }
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
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
        console.log(`Lấy được ${symbols.length} đồng coin USDT-M Futures.`);
        return symbols;
    } catch (error) {
        console.error("Lỗi khi lấy danh sách symbols:", error.message);
        return [];
    }
}

async function fetchInitialHistoricalData(symbols) {
    console.log("Đang tải dữ liệu lịch sử ban đầu...");
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
                coinData[symbol].prices = klinesData.map(k => parseFloat(k[4])).reverse(); // Giá đóng cửa
                if (coinData[symbol].prices.length > 0) {
                    coinData[symbol].currentPrice = coinData[symbol].prices[coinData[symbol].prices.length - 1]; // Giá gần nhất
                    coinData[symbol].priceXMinAgo = coinData[symbol].prices[0]; // Giá WINDOW_MINUTES phút trước
                }
            }
        } catch (error) {
            const errorData = error.message.includes('Request Failed. Status Code:') ? error.message : null;
            if (errorData && (errorData.includes('400') || errorData.includes('404'))) {
                delete coinData[symbol];
                allSymbols = allSymbols.filter(s => s !== symbol);
            } else if (errorData && errorData.includes('429')) {
                console.warn(`Bị rate limit khi lấy lịch sử cho ${symbol}. Sẽ thử lại sau.`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                const index = symbols.indexOf(symbol);
                if (index > -1) await fetchInitialHistoricalData([symbol]);
            } else {
                console.warn(`Lỗi khi lấy dữ liệu lịch sử cho ${symbol}: ${error.message}.`);
            }
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    console.log("Tải dữ liệu lịch sử ban đầu hoàn tất.");
    calculateAndRank(); // Tính toán lần đầu
}

function connectToBinanceWebSocket(symbols) {
    if (wsClient && (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING)) {
        wsClient.close();
    }
    if (symbols.length === 0) return;
    const streams = symbols.map(s => `${s.toLowerCase()}@kline_1m`).join('/');
    const url = `${BINANCE_WS_URL}${streams}`;
    console.log(`Đang kết nối WebSocket tới: ${streams.substring(0,100)}... (${symbols.length} streams)`);
    wsClient = new WebSocket(url);
    wsClient.on('open', () => console.log('Kết nối WebSocket thành công!'));
    wsClient.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            if (message.data && message.data.e === 'kline') {
                const klineData = message.data.k;
                const symbol = klineData.s;
                if (coinData[symbol] && klineData.x) { // kline đã đóng
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
            console.error('Lỗi xử lý message từ WebSocket:', error);
        }
    });
    wsClient.on('error', (error) => console.error('Lỗi WebSocket:', error.message));
    wsClient.on('close', (code, reason) => {
        console.log(`WebSocket đã đóng. Code: ${code}, Reason: ${reason ? reason.toString() : 'N/A'}. Thử kết nối lại sau 5 giây...`);
        setTimeout(() => connectToBinanceWebSocket(allSymbols), 5000);
    });
}

function calculateAndRank() {
    // console.log("Đang tính toán và xếp hạng..."); // Log này có thể hơi nhiều nếu chạy 15s/lần
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
    generateHtml(topRankedCoinsJson); // HTML vẫn dùng top 20
    if (topRankedCoinsJson.length > 0) {
        // console.log(`Cập nhật top ${topRankedCoinsJson.length} coins. Top 1: ${topRankedCoinsJson[0].symbol} (${topRankedCoinsJson[0].changePercent}%)`);
    }
}

function generateHtml(coins) {
    let html = `
        <html><head><title>Top Coin Biến Động (USDT-M)</title><meta http-equiv="refresh" content="30">
        <style>body{font-family:Arial,sans-serif;margin:20px;background-color:#f4f4f4;color:#333}h1{text-align:center;color:#1a1a1a}table{width:80%;margin:20px auto;border-collapse:collapse;box-shadow:0 0 10px rgba(0,0,0,0.1);background-color:#fff}th,td{border:1px solid #ddd;padding:12px;text-align:left}th{background-color:#f0b90b;color:#333}tr:nth-child(even){background-color:#f9f9f9}.positive{color:green}.negative{color:red}.timestamp{text-align:center;font-size:0.9em;color:#777;margin-top:20px}</style></head>
        <body><h1>Top ${coins.length} Coin Biến Động Mạnh Nhất (${WINDOW_MINUTES} phút)</h1><table><thead><tr><th>#</th><th>Symbol</th><th>Giá hiện tại</th><th>Giá ${WINDOW_MINUTES}p trước</th><th>% Thay đổi</th><th>Số nến 1m</th></tr></thead><tbody>`;
    if (coins.length > 0) {
        coins.forEach((coin, index) => {
            const changeClass = coin.changePercent > 0 ? 'positive' : (coin.changePercent < 0 ? 'negative' : '');
            html += `<tr><td>${index + 1}</td><td>${coin.symbol}</td><td>${coin.currentPrice !== null ? coin.currentPrice.toFixed(4) : 'N/A'}</td><td>${coin.priceXMinAgo !== null ? coin.priceXMinAgo.toFixed(4) : 'N/A'}</td><td class="${changeClass}">${coin.changePercent !== null ? coin.changePercent + '%' : 'N/A'}</td><td>${coin.candles}</td></tr>`;
        });
    } else {
        html += `<tr><td colspan="6" style="text-align:center;">Không có dữ liệu hoặc đang chờ cập nhật...</td></tr>`;
    }
    html += `</tbody></table><div class="timestamp">Cập nhật lúc: ${new Date().toLocaleTimeString('vi-VN')}</div></body></html>`;
    topRankedCoinsHtml = html;
}

async function periodicallyUpdateSymbolList() {
    console.log("Đang kiểm tra và cập nhật danh sách symbol...");
    const newSymbols = await getAllFuturesSymbols();
    const addedSymbols = newSymbols.filter(s => !allSymbols.includes(s));
    const removedSymbols = allSymbols.filter(s => !newSymbols.includes(s));
    if (addedSymbols.length > 0) {
        console.log(`Phát hiện ${addedSymbols.length} symbol mới: ${addedSymbols.join(', ')}`);
        allSymbols = newSymbols;
        await fetchInitialHistoricalData(addedSymbols);
        connectToBinanceWebSocket(allSymbols);
    }
    if (removedSymbols.length > 0) {
         console.log(`Phát hiện ${removedSymbols.length} symbol bị loại bỏ: ${removedSymbols.join(', ')}`);
         removedSymbols.forEach(s => delete coinData[s]);
         allSymbols = newSymbols;
         connectToBinanceWebSocket(allSymbols);
    }
    console.log("Kiểm tra danh sách symbol hoàn tất.");
}

async function main() {
    allSymbols = await getAllFuturesSymbols();
    if (allSymbols.length === 0) {
        topRankedCoinsHtml = "<h1>Lỗi: Không thể lấy danh sách symbol từ Binance.</h1>";
        topRankedCoinsJson = [{ error: "Không thể lấy danh sách symbol từ Binance." }];
        app.get('/', (req, res) => res.send(topRankedCoinsHtml));
        app.get('/api/top-coins', (req, res) => res.status(500).json(topRankedCoinsJson));
        app.listen(port, '0.0.0.0', () => console.log(`Server VPS1 đang chạy tại http://<IP_CUA_VPS1>:${port} với lỗi.`));
        return;
    }
    await fetchInitialHistoricalData(allSymbols);
    connectToBinanceWebSocket(allSymbols);
    // calculateAndRank(); // Đã gọi trong fetchInitialHistoricalData

    setInterval(calculateAndRank, 15 * 1000); // Cập nhật JSON và HTML mỗi 15 giây
    setInterval(periodicallyUpdateSymbolList, 6 * 60 * 60 * 1000); // 6 tiếng 1 lần

    app.get('/', (req, res) => res.send(topRankedCoinsHtml));
    app.get('/api/top-coins', (req, res) => {
        if (topRankedCoinsJson.length > 0 && !topRankedCoinsJson[0].error) {
            res.json(topRankedCoinsJson);
        } else if (topRankedCoinsJson.length > 0 && topRankedCoinsJson[0].error) {
             res.status(500).json(topRankedCoinsJson);
        }
        else {
            res.status(200).json({ message: "Đang khởi tạo dữ liệu, vui lòng thử lại sau giây lát." });
        }
    });
    app.listen(port, '0.0.0.0', () => {
        console.log(`Server VPS1 (Data Provider) đang chạy tại http://<IP_CUA_VPS1>:${port}`);
        console.log(`API Top Coins: http://<IP_CUA_VPS1>:${port}/api/top-coins`);
    });
}

main().catch(console.error);
