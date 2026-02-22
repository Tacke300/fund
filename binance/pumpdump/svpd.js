import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';

const app = express();
const port = 9000;
const HISTORY_FILE = './history_db.json';

let coinData = {}; 
let historyMap = new Map(); 

// Hàm gọi API Binance lấy nến lịch sử
async function fetchKlines(symbol) {
    return new Promise((resolve) => {
        https.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=16`, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve([]); }
            });
        }).on('error', () => resolve([]));
    });
}

// Khởi tạo dữ liệu nến cho toàn sàn
async function initData() {
    console.log("🚀 Đang nạp dữ liệu nến 15 phút đầu tiên...");
    try {
        https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', async () => {
                const info = JSON.parse(data);
                const symbols = info.symbols.filter(s => s.quoteAsset === 'USDT').map(s => s.symbol);
                
                // Lấy 100 mã đầu tiên để tránh bị ban IP do request quá nhiều
                for (let s of symbols.slice(0, 150)) {
                    const klines = await fetchKlines(s);
                    if (Array.isArray(klines)) {
                        coinData[s] = {
                            symbol: s,
                            prices: klines.map(k => ({ p: parseFloat(k[4]), t: parseInt(k[0]) }))
                        };
                    }
                }
                console.log("✅ Đã sẵn sàng phục vụ Bot!");
                initWS();
            });
        });
    } catch (e) { console.log("Lỗi khởi tạo:", e); }
}

if (fs.existsSync(HISTORY_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(HISTORY_FILE));
        data.forEach(h => historyMap.set(h.symbol, h));
    } catch (e) { console.log("Khởi tạo database mới"); }
}

setInterval(() => {
    const dataToSave = Array.from(historyMap.values());
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(dataToSave.slice(-1000))); 
}, 30000);

function calculateChange(priceArray, minutes) {
    if (!priceArray || priceArray.length < 2) return 0;
    const now = priceArray[priceArray.length - 1].t;
    const targetTime = now - minutes * 60 * 1000;
    const startPriceObj = priceArray.find(item => item.t >= targetTime);
    if (!startPriceObj) return 0;
    return parseFloat(((priceArray[priceArray.length - 1].p - startPriceObj.p) / startPriceObj.p * 100).toFixed(2));
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => {
            const s = t.s; 
            const p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            
            const limit = now - 16 * 60 * 1000;
            coinData[s].prices = coinData[s].prices.filter(item => item.t > limit);

            const c1 = calculateChange(coinData[s].prices, 1);
            const c5 = calculateChange(coinData[s].prices, 5);
            const c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, p };

            if (Math.abs(c1) >= 5 || Math.abs(c5) >= 5 || Math.abs(c15) >= 5) {
                let hist = historyMap.get(s);
                if (!hist) {
                    hist = { symbol: s, startTime: now, lastUpdate: now, max1: c1, max5: c5, max15: c15 };
                } else {
                    if (Math.abs(c1) > Math.abs(hist.max1)) hist.max1 = c1;
                    if (Math.abs(c5) > Math.abs(hist.max5)) hist.max5 = c5;
                    if (Math.abs(c15) > Math.abs(hist.max15)) hist.max15 = c15;
                    hist.lastUpdate = now;
                }
                historyMap.set(s, hist);
            }
        });
    });
    ws.on('error', () => setTimeout(initWS, 5000));
    ws.on('close', () => setTimeout(initWS, 5000));
}

// API QUAN TRỌNG CHO BOT
app.get('/api/live', (req, res) => {
    const data = Object.values(coinData)
        .filter(v => v.live)
        .map(v => ({ symbol: v.symbol, ...v.live }))
        .sort((a, b) => Math.max(Math.abs(b.c1), Math.abs(b.c5)) - Math.max(Math.abs(a.c1), Math.abs(a.c5)));
    res.json(data);
});

app.get('/api/data', (req, res) => {
    const live = Object.values(coinData)
        .filter(v => v.live)
        .map(v => ({ symbol: v.symbol, ...v.live }))
        .sort((a, b) => Math.max(Math.abs(b.c1), Math.abs(b.c5)) - Math.max(Math.abs(a.c1), Math.abs(a.c5)))
        .slice(0, 50);
    const history = Array.from(historyMap.values()).sort((a, b) => b.startTime - a.startTime).slice(0, 50);
    res.json({ live, history });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server chạy tại: http://192.168.1.3:${port}`);
    initData();
});
