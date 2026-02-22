import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';

const app = express();
const port = 9000;
const HISTORY_FILE = './history_db.json';

let coinData = {}; 
let historyMap = new Map(); 

async function callPublicAPI(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    return new Promise((res, rej) => {
        https.get(`https://fapi.binance.com${path}${qs ? '?' + qs : ''}`, (r) => {
            let d = ''; r.on('data', chunk => d += chunk);
            r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
        }).on('error', rej);
    });
}

async function fetchInitialHistory() {
    console.log("🔄 Đang nạp nến lịch sử nhanh...");
    try {
        const info = await callPublicAPI('/fapi/v1/exchangeInfo');
        const symbols = info.symbols
            .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING')
            .map(s => s.symbol).slice(0, 180); // Lấy top 180 cặp chính

        for (const s of symbols) {
            try {
                // Lấy 20 nến 1m để tính đủ c1, c5, c15
                const klines = await callPublicAPI('/fapi/v1/klines', { symbol: s, interval: '1m', limit: 20 });
                const now = Date.now();
                if (Array.isArray(klines)) {
                    coinData[s] = {
                        symbol: s,
                        prices: klines.map((k, i) => ({ p: parseFloat(k[4]), t: now - (20 - i) * 60000 }))
                    };
                }
            } catch (e) { continue; }
        }
        console.log(`✅ Đã sẵn sàng dữ liệu cho ${Object.keys(coinData).length} mã.`);
    } catch (e) { console.log("❌ Lỗi nạp lịch sử."); }
}

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
            if (!coinData[s]) return;
            const p = parseFloat(t.c);
            coinData[s].prices.push({ p, t: now });
            
            // Giữ lại 30 phút dữ liệu để tính toán (tránh tràn RAM)
            if (coinData[s].prices.length > 200) coinData[s].prices.shift();

            const c1 = calculateChange(coinData[s].prices, 1);
            const c5 = calculateChange(coinData[s].prices, 5);
            const c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
        });
    });
    ws.on('close', () => setTimeout(initWS, 2000));
}

app.get('/api/live', (req, res) => {
    const data = Object.values(coinData)
        .filter(v => v.live)
        .map(v => ({ symbol: v.symbol, ...v.live }))
        .sort((a, b) => Math.max(Math.abs(b.c1), Math.abs(b.c5)) - Math.max(Math.abs(a.c1), Math.abs(a.c5)));
    res.json(data);
});

app.listen(port, '0.0.0.0', async () => {
    console.log(`🚀 PIRATE SERVER RUNNING ON PORT ${port}`);
    await fetchInitialHistory();
    initWS();
});
