import WebSocket from 'ws'; // Vẫn cần 'ws' cho WebSocket client
import https from 'https';   // Module 'https' tích hợp sẵn của Node.js
import express from 'express';
import { URL } from 'url'; // Để parse URL dễ dàng hơn

const app = express();
const port = 9000;

const BINANCE_FAPI_BASE_URL = 'https://fapi.binance.com';
const BINANCE_WS_URL = 'wss://fstream.binance.com/stream?streams=';

const WINDOW_MINUTES = 60;
let coinData = {};
let top10CoinsHtml = "<h1>Đang khởi tạo và tải dữ liệu...</h1>";
let allSymbols = [];
let wsClient = null;

// Hàm helper để thực hiện GET request bằng module 'https'
function httpsGetJson(urlString) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(urlString);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            if (res.statusCode < 200 || res.statusCode >= 300) {
                // Thêm log để biết response trả về
                // console.error(`HTTPS GET request to ${urlString} failed with status: ${res.statusCode}`);
                // res.on('data', chunk => data += chunk);
                // res.on('end', () => console.error('Response body on error:', data));
                return reject(new Error(`Request Failed. Status Code: ${res.statusCode} for ${urlString}`));
            }

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

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
                symbol: symbol,
                prices: [],
                changePercent: null,
                currentPrice: null,
                priceXMinAgo: null,
                lastUpdate: 0,
                klineOpenTime: 0
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
            // Xử lý lỗi tương tự như trước
            const errorData = error.message.includes('Request Failed. Status Code:') ? error.message : null;
            if (errorData && errorData.includes('400')) { // Giả định lỗi 400 là do ReduceOnly hoặc symbol không hợp lệ
                // console.warn(`Lỗi 400 khi lấy lịch sử cho ${symbol}: ${error.message}. Có thể là coin mới hoặc không hỗ trợ.`);
                delete coinData[symbol];
                allSymbols = allSymbols.filter(s => s !== symbol);
            } else if (errorData && errorData.includes('429')) {
                console.warn(`Bị rate limit khi lấy lịch sử cho ${symbol}. Sẽ thử lại sau.`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                const index = symbols.indexOf(symbol);
                if (index > -1) await fetchInitialHistoricalData([symbol]); // Thử lại
            } else {
                console.warn(`Lỗi khi lấy dữ liệu lịch sử cho ${symbol}: ${error.message}.`);
            }
        }
        await new Promise(resolve => setTimeout(resolve, 200)); // Tăng delay một chút vì 'https' có thể không tối ưu bằng axios
    }
    console.log("Tải dữ liệu lịch sử ban đầu hoàn tất.");
    calculateAndRank();
}

// Các hàm connectToBinanceWebSocket, calculateAndRank, generateHtml, periodicallyUpdateSymbolList, main giữ nguyên như phiên bản ES Module trước
// vì chúng không trực tiếp dùng axios.
// Chỉ cần đảm bảo các hàm gọi API (getAllFuturesSymbols, fetchInitialHistoricalData) đã được sửa.

function connectToBinanceWebSocket(symbols) {
    if (wsClient && (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING)) {
        console.log("WebSocket đã kết nối hoặc đang kết nối. Đóng kết nối cũ.");
        wsClient.close();
    }

    if (symbols.length === 0) {
        console.log("Không có symbol nào để theo dõi qua WebSocket.");
        return;
    }

    const streams = symbols.map(s => `${s.toLowerCase()}@kline_1m`).join('/');
    const url = `${BINANCE_WS_URL}${streams}`;
    console.log(`Đang kết nối WebSocket tới: ${streams.substring(0,100)}... (${symbols.length} streams)`);

    wsClient = new WebSocket(url);

    wsClient.on('open', () => {
        console.log('Kết nối WebSocket thành công!');
    });

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
            console.error('Lỗi xử lý message từ WebSocket:', error);
        }
    });

    wsClient.on('error', (error) => {
        console.error('Lỗi WebSocket:', error.message);
    });

    wsClient.on('close', (code, reason) => {
        console.log(`WebSocket đã đóng. Code: ${code}, Reason: ${reason ? reason.toString() : 'N/A'}`);
        console.log('Đang thử kết nối lại WebSocket sau 5 giây...');
        setTimeout(() => connectToBinanceWebSocket(allSymbols), 5000);
    });
}

function calculateAndRank() {
    console.log("Đang tính toán và xếp hạng...");
    const rankedCoins = [];
    for (const symbol in coinData) {
        const data = coinData[symbol];
        if (data.prices.length >= 2 && data.priceXMinAgo && data.currentPrice && data.priceXMinAgo > 0) {
            const change = ((data.currentPrice - data.priceXMinAgo) / data.priceXMinAgo) * 100;
            data.changePercent = parseFloat(change.toFixed(2));
            rankedCoins.push(data);
        } else {
            data.changePercent = null;
        }
    }

    rankedCoins.sort((a, b) => {
        if (b.changePercent === null) return -1;
        if (a.changePercent === null) return 1;
        return b.changePercent - a.changePercent;
    });

    const top10 = rankedCoins.slice(0, 20);
    generateHtml(top10);
}

function generateHtml(coins) {
    let html = `
        <html>
            <head>
                <title>Top 10 Coin Biến Động (USDT-M Futures Binance)</title>
                <meta http-equiv="refresh" content="60">
                <style>
                    body { font-family: Arial, sans-serif; margin: 20px; background-color: #f4f4f4; color: #333; }
                    h1 { text-align: center; color: #1a1a1a; }
                    table { width: 80%; margin: 20px auto; border-collapse: collapse; box-shadow: 0 0 10px rgba(0,0,0,0.1); background-color: #fff; }
                    th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
                    th { background-color: #f0b90b; color: #333; }
                    tr:nth-child(even) { background-color: #f9f9f9; }
                    .positive { color: green; }
                    .negative { color: red; }
                    .timestamp { text-align: center; font-size: 0.9em; color: #777; margin-top: 20px;}
                </style>
            </head>
            <body>
                <h1>Top 20 Coin Biến Động Mạnh Nhất (${WINDOW_MINUTES} phút gần nhất)</h1>
                <table>
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>Symbol</th>
                            <th>Giá hiện tại</th>
                            <th>Giá ${WINDOW_MINUTES}p trước (hoặc cũ nhất)</th>
                            <th>% Thay đổi</th>
                            <th>Số nến 1m (max ${WINDOW_MINUTES})</th>
                        </tr>
                    </thead>
                    <tbody>
    `;
    if (coins.length > 0) {
        coins.forEach((coin, index) => {
            const changeClass = coin.changePercent > 0 ? 'positive' : (coin.changePercent < 0 ? 'negative' : '');
            html += `
                <tr>
                    <td>${index + 1}</td>
                    <td>${coin.symbol}</td>
                    <td>${coin.currentPrice !== null ? coin.currentPrice.toFixed(4) : 'N/A'}</td>
                    <td>${coin.priceXMinAgo !== null ? coin.priceXMinAgo.toFixed(4) : 'N/A'}</td>
                    <td class="${changeClass}">${coin.changePercent !== null ? coin.changePercent + '%' : 'N/A'}</td>
                    <td>${coin.prices.length}</td>
                </tr>
            `;
        });
    } else {
        html += `<tr><td colspan="6" style="text-align:center;">Không có dữ liệu hoặc đang chờ cập nhật...</td></tr>`;
    }
    html += `
                    </tbody>
                </table>
                <div class="timestamp">Cập nhật lúc: ${new Date().toLocaleTimeString('vi-VN')}</div>
            </body>
        </html>
    `;
    top10CoinsHtml = html;
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
         console.log(`Phát hiện ${removedSymbols.length} symbol bị loại bỏ (hiếm): ${removedSymbols.join(', ')}`);
         removedSymbols.forEach(s => delete coinData[s]);
         allSymbols = newSymbols;
         connectToBinanceWebSocket(allSymbols);
    }
    console.log("Kiểm tra danh sách symbol hoàn tất.");
}

async function main() {
    allSymbols = await getAllFuturesSymbols();
    if (allSymbols.length === 0) {
        top10CoinsHtml = "<h1>Lỗi: Không thể lấy danh sách symbol từ Binance. Vui lòng kiểm tra lại.</h1>";
        app.get('/', (req, res) => res.send(top10CoinsHtml));
        app.listen(port, () => {
            console.log(`Server đang chạy tại http://localhost:${port} với lỗi.`);
        });
        return;
    }

    await fetchInitialHistoricalData(allSymbols);
    connectToBinanceWebSocket(allSymbols);

    setInterval(calculateAndRank, 60 * 1000);
    setInterval(periodicallyUpdateSymbolList, 6 * 60 * 60 * 1000);

    app.get('/', (req, res) => {
        res.send(top10CoinsHtml);
    });

    app.listen(port, () => {
        console.log(`Server đang chạy tại http://localhost:${port}`);
        console.log(`Truy cập để xem top 10 coin biến động.`);
    });
}

main().catch(console.error);
