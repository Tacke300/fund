const WebSocket = require('ws');
const axios = require('axios');
const express = require('express');

const app = express();
const port = 3000;

const BINANCE_FAPI_URL = 'https://fapi.binance.com';
const BINANCE_WS_URL = 'wss://fstream.binance.com/stream?streams=';

const WINDOW_MINUTES = 30; // Số phút để tính biến động
let coinData = {}; // { SYMBOL: { symbol: 'BTCUSDT', prices: [price1, price2,...], changePercent: 0, currentPrice: 0, price30MinAgo: 0, lastUpdate: timestamp }}
let top10CoinsHtml = "<h1>Đang khởi tạo và tải dữ liệu...</h1>";
let allSymbols = [];
let wsClient = null;

// 1. Lấy danh sách các đồng coin USDT-M Futures
async function getAllFuturesSymbols() {
    try {
        const response = await axios.get(`${BINANCE_FAPI_URL}/fapi/v1/exchangeInfo`);
        const symbols = response.data.symbols
            .filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
            .map(s => s.symbol);
        console.log(`Lấy được ${symbols.length} đồng coin USDT-M Futures.`);
        return symbols;
    } catch (error) {
        console.error("Lỗi khi lấy danh sách symbols:", error.message);
        return [];
    }
}

// 2. Lấy dữ liệu lịch sử ban đầu cho mỗi coin
async function fetchInitialHistoricalData(symbols) {
    console.log("Đang tải dữ liệu lịch sử ban đầu...");
    const now = Date.now();

    for (const symbol of symbols) {
        if (!coinData[symbol]) { // Khởi tạo nếu chưa có
            coinData[symbol] = {
                symbol: symbol,
                prices: [], // Mảng lưu trữ giá đóng cửa của WINDOW_MINUTES nến 1m gần nhất
                changePercent: null,
                currentPrice: null,
                priceXMinAgo: null,
                lastUpdate: 0,
                klineOpenTime: 0 // Thời gian mở của nến 1m gần nhất từ WS
            };
        }

        try {
            // Lấy tối đa WINDOW_MINUTES nến 1 phút gần nhất
            const response = await axios.get(`${BINANCE_FAPI_URL}/fapi/v1/klines`, {
                params: {
                    symbol: symbol,
                    interval: '1m',
                    endTime: now,
                    limit: WINDOW_MINUTES
                }
            });
            const klines = response.data; // [[openTime, open, high, low, close, ...], ...]
            if (klines && klines.length > 0) {
                // Sắp xếp lại klines theo thời gian tăng dần (API trả về giảm dần theo endTime)
                // và chỉ lấy giá đóng cửa
                coinData[symbol].prices = klines.map(k => parseFloat(k[4])).reverse();
                if (coinData[symbol].prices.length > 0) {
                    coinData[symbol].currentPrice = coinData[symbol].prices[coinData[symbol].prices.length - 1];
                    coinData[symbol].priceXMinAgo = coinData[symbol].prices[0]; // Nến cũ nhất trong cửa sổ
                }
            }
            // console.log(`Tải xong lịch sử cho ${symbol}, có ${coinData[symbol].prices.length} nến.`);
        } catch (error) {
            // Bỏ qua lỗi cho các coin mới chưa có đủ dữ liệu, hoặc lỗi mạng tạm thời
            // console.warn(`Lỗi khi lấy dữ liệu lịch sử cho ${symbol}: ${error.message}. Có thể là coin mới.`);
            if (error.response && error.response.status === 400 && error.response.data && error.response.data.msg === "ReduceOnly Order is not supported for this symbol.") {
                // console.log(`Bỏ qua symbol ${symbol} do không hỗ trợ (ReduceOnly).`);
                delete coinData[symbol]; // Xóa symbol không hợp lệ
                allSymbols = allSymbols.filter(s => s !== symbol);
            } else if (error.response && error.response.status === 429) {
                console.warn(`Bị rate limit khi lấy lịch sử cho ${symbol}. Sẽ thử lại sau.`);
                await new Promise(resolve => setTimeout(resolve, 5000)); // Chờ 5s
                 // Thử lại cho symbol này
                const index = symbols.indexOf(symbol);
                if (index > -1) await fetchInitialHistoricalData([symbol]);

            } else {
                console.warn(`Lỗi khi lấy dữ liệu lịch sử cho ${symbol}: ${error.message}.`);
            }
        }
        await new Promise(resolve => setTimeout(resolve, 150)); // Delay nhỏ để tránh rate limit
    }
    console.log("Tải dữ liệu lịch sử ban đầu hoàn tất.");
    calculateAndRank(); // Tính toán lần đầu sau khi có dữ liệu lịch sử
}


// 3. Kết nối WebSocket
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

                if (coinData[symbol] && klineData.x) { // klineData.x === true nghĩa là nến đã đóng
                    const closePrice = parseFloat(klineData.c);
                    const openTime = parseInt(klineData.t);

                    // Chỉ cập nhật nếu là nến mới (khác với nến cuối cùng đã lưu)
                    if (openTime > (coinData[symbol].klineOpenTime || 0)) {
                        coinData[symbol].prices.push(closePrice);
                        if (coinData[symbol].prices.length > WINDOW_MINUTES) {
                            coinData[symbol].prices.shift(); // Giữ cửa sổ 30 nến
                        }
                        coinData[symbol].currentPrice = closePrice;
                        coinData[symbol].priceXMinAgo = coinData[symbol].prices[0]; // Nến cũ nhất trong cửa sổ
                        coinData[symbol].lastUpdate = Date.now();
                        coinData[symbol].klineOpenTime = openTime;
                        // console.log(`Cập nhật ${symbol}: ${closePrice}, Nến cũ nhất: ${coinData[symbol].priceXMinAgo}, Số nến: ${coinData[symbol].prices.length}`);
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
        setTimeout(() => connectToBinanceWebSocket(allSymbols), 5000); // Thử kết nối lại
    });
}

// 5. Tính toán biến động và sắp xếp
function calculateAndRank() {
    console.log("Đang tính toán và xếp hạng...");
    const rankedCoins = [];
    for (const symbol in coinData) {
        const data = coinData[symbol];
        // Cần ít nhất 2 nến để tính biến động, và giá phải hợp lệ
        if (data.prices.length >= 2 && data.priceXMinAgo && data.currentPrice && data.priceXMinAgo > 0) {
            const change = ((data.currentPrice - data.priceXMinAgo) / data.priceXMinAgo) * 100;
            data.changePercent = parseFloat(change.toFixed(2)); // Làm tròn 2 chữ số thập phân
            rankedCoins.push(data);
        } else {
            data.changePercent = null; // Không đủ dữ liệu
        }
    }

    rankedCoins.sort((a, b) => {
        if (b.changePercent === null) return -1; // Đẩy null xuống cuối
        if (a.changePercent === null) return 1;
        return b.changePercent - a.changePercent; // Sắp xếp giảm dần
    });

    const top10 = rankedCoins.slice(0, 10);
    generateHtml(top10);
    // console.log("Top 10:", top10.map(c => `${c.symbol}: ${c.changePercent}%`));
}

// 6. Tạo HTML
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
                <h1>Top 10 Coin Biến Động Mạnh Nhất (${WINDOW_MINUTES} phút gần nhất)</h1>
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

// Hàm cập nhật định kỳ danh sách symbol (ví dụ: mỗi 6 giờ)
async function periodicallyUpdateSymbolList() {
    console.log("Đang kiểm tra và cập nhật danh sách symbol...");
    const newSymbols = await getAllFuturesSymbols();
    const addedSymbols = newSymbols.filter(s => !allSymbols.includes(s));
    const removedSymbols = allSymbols.filter(s => !newSymbols.includes(s)); // Hiếm khi xảy ra với perpetual

    if (addedSymbols.length > 0) {
        console.log(`Phát hiện ${addedSymbols.length} symbol mới: ${addedSymbols.join(', ')}`);
        allSymbols = newSymbols; // Cập nhật danh sách tổng
        await fetchInitialHistoricalData(addedSymbols); // Tải dữ liệu lịch sử cho symbol mới
        connectToBinanceWebSocket(allSymbols); // Kết nối lại WS với danh sách symbol mới
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

    await fetchInitialHistoricalData(allSymbols); // Tải dữ liệu ban đầu
    connectToBinanceWebSocket(allSymbols);       // Kết nối WebSocket

    // Tính toán và cập nhật HTML mỗi phút
    setInterval(calculateAndRank, 60 * 1000);

    // Cập nhật danh sách symbol mỗi 6 tiếng để bắt coin mới list
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
