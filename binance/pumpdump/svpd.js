/**
 * LUFFY ENGINE - BẢN FULL FIX ĐỨNG HÌNH & LAG
 * TRẠNG THÁI: NHẢY SỐ REALTIME - CHỐNG TRÀN RAM - BỎ CHỚP
 */

const PORT = 9000;
const HISTORY_FILE = './history_db.json';

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import fetch from 'node-fetch';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let pendingMap = new Map(); 

// --- DATABASE INIT ---
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => {
            historyMap.set(`${h.symbol}_${h.startTime}`, h);
            if (h.status === 'PENDING') pendingMap.set(h.symbol, h);
        });
    } catch (e) {}
}

/**
 * 1. TÍNH TOÁN BIẾN ĐỘNG - FIX LỖI ĐỨNG SỐ
 */
function calculateChange(symbol, min) {
    const data = coinData[symbol];
    if (!data || data.prices.length < 2) return "0.00";
    
    const now = Date.now();
    const targetTime = now - (min * 60000);
    
    let startPrice = data.prices[0].p;
    for (let i = data.prices.length - 1; i >= 0; i--) {
        if (data.prices[i].t <= targetTime) {
            startPrice = data.prices[i].p;
            break;
        }
    }
    const currentPrice = data.prices[data.prices.length - 1].p;
    return (((currentPrice - startPrice) / startPrice) * 100).toFixed(2);
}

/**
 * 2. PRELOAD DỮ LIỆU (TẮT LOG CHI TIẾT)
 */
async function preloadHistory(symbol) {
    try {
        const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=31`);
        const data = await res.json();
        coinData[symbol] = {
            symbol,
            prices: data.map(k => ({ p: parseFloat(k[4]), t: parseInt(k[0]) }))
        };
        return true;
    } catch (e) { return false; }
}

async function preloadAll() {
    console.log('⏳ Khởi động hệ thống...');
    const res = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
    const info = await res.json();
    const allFutures = info.symbols.filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING').map(s => s.symbol);
    
    let success = 0;
    const batchSize = 50;
    for (let i = 0; i < allFutures.length; i += batchSize) {
        await Promise.all(allFutures.slice(i, i + batchSize).map(sym => preloadHistory(sym)));
        success += Math.min(batchSize, allFutures.length - i);
        process.stdout.write(`\r🚀 Nạp data: ${Math.round((success/allFutures.length)*100)}%`);
    }
    console.log('\n✅ Sẵn sàng!');
}

/**
 * 3. WEBSOCKET - NHẬN GIÁ & TÍNH PNL GỐC
 */
function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.on('message', (data) => {
        try {
            const tickers = JSON.parse(data);
            const now = Date.now();
            tickers.forEach(t => {
                const s = t.s; const p = parseFloat(t.c);
                if (!coinData[s]) return;

                coinData[s].prices.push({ p, t: now });
                if (coinData[s].prices.length > 1000) coinData[s].prices.shift(); // Giới hạn bộ nhớ

                // Logic PNL gốc của mày
                const pending = pendingMap.get(s);
                if (pending && pending.status === 'PENDING') {
                    const diff = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                    const roi = (pending.type === 'LONG' ? diff : -diff) * 20;
                    // ... (Mày có thể thêm logic chốt lời ở đây nếu cần)
                }
            });
        } catch (e) {}
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

// --- API SIÊU NHẸ ---
app.get('/api/data', (req, res) => {
    const live = Object.values(coinData).map(c => ({
        s: c.symbol,
        p: c.prices[c.prices.length - 1].p,
        c1: calculateChange(c.symbol, 1),
        c5: calculateChange(c.symbol, 5),
        c15: calculateChange(c.symbol, 15)
    })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1)).slice(0, 25);

    res.json({ live, pending: Array.from(historyMap.values()).filter(h => h.status === 'PENDING') });
});

// --- GUI: REALTIME KHÔNG LAG ---
app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Luffy Engine V4</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: monospace; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
    </style></head>
    <body class="p-4">
        <div class="max-w-4xl mx-auto bg-card rounded p-4">
            <div class="flex justify-between border-b border-gray-700 pb-2 mb-4">
                <span class="text-yellow-500 font-bold font-sans italic">LUFFY BABY ENGINE</span>
                <span id="timer" class="text-gray-500"></span>
            </div>
            <table class="w-full text-[13px]">
                <thead>
                    <tr class="text-gray-500 text-left uppercase border-b border-gray-800">
                        <th class="p-2">Cặp</th><th>Giá Live</th>
                        <th class="text-center">1M%</th><th class="text-center">5M%</th><th class="text-center">15M%</th>
                    </tr>
                </thead>
                <tbody id="list"></tbody>
            </table>
        </div>

        <script>
            async function update() {
                try {
                    const res = await fetch('/api/data');
                    const d = await res.json();
                    document.getElementById('timer').innerText = new Date().toLocaleTimeString();
                    
                    const list = document.getElementById('list');
                    // Sử dụng phương pháp cộng dồn chuỗi rồi gán một lần để tránh lag DOM
                    let html = '';
                    d.live.forEach(m => {
                        html += \`
                        <tr class="border-b border-gray-800/40">
                            <td class="p-2 font-bold font-sans">\${m.s}</td>
                            <td class="text-yellow-400 font-bold">\${m.p.toFixed(4)}</td>
                            <td class="text-center font-bold \${m.c1>=0?'up':'down'}">\${m.c1}%</td>
                            <td class="text-center font-bold \${m.c5>=0?'up':'down'}">\${m.c5}%</td>
                            <td class="text-center font-bold \${m.c15>=0?'up':'down'}">\${m.c15}%</td>
                        </tr>\`;
                    });
                    list.innerHTML = html;
                } catch(e) {}
            }
            // Chạy 1 giây/lần. Đừng đặt nhanh hơn sẽ bị lag trình duyệt
            setInterval(update, 1000);
        </script>
    </body></html>`);
});

app.listen(PORT, '0.0.0.0', async () => { 
    await preloadAll(); 
    initWS(); 
    console.log(\`🚀 Link: http://localhost:\${PORT}/gui\`); 
});
