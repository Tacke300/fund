/**
 * LUFFY ENGINE SUPER FAST - 100% REALTIME TICKER
 * Trạng thái: Bản FULL - Nhảy số từng giây - Chống đứng hình
 */

const PORT = 9000;
import WebSocket from 'ws';
import express from 'express';
import fetch from 'node-fetch';
import compression from 'compression';

const app = express();
app.use(compression()); // Nén dữ liệu để truyền tải siêu tốc

let coinData = {}; 

// --- 1. PRELOAD DỮ LIỆU BAN ĐẦU ---
async function preloadHistory(symbol) {
    try {
        const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=20`);
        const data = await res.json();
        if (!Array.isArray(data)) return;
        
        coinData[symbol] = {
            s: symbol,
            p: parseFloat(data[data.length-1][4]), // Giá hiện tại
            h: data.map(k => ({ p: parseFloat(k[4]), t: parseInt(k[0]) })), // Lịch sử
            c1: "0.00", c5: "0.00", c15: "0.00"
        };
    } catch (e) {}
}

async function preloadAll() {
    console.log('⏳ Đang nạp danh sách Future...');
    const res = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
    const info = await res.json();
    const symbols = info.symbols.filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING').map(s => s.symbol);
    
    const batchSize = 50;
    for (let i = 0; i < symbols.length; i += batchSize) {
        await Promise.all(symbols.slice(i, i + batchSize).map(s => preloadHistory(s)));
        process.stdout.write(`\r🚀 Loading: \${Math.round((i/symbols.length)*100)}%`);
    }
    console.log('\n✅ Data Ready!');
}

// --- 2. TÍNH BIẾN ĐỘNG TRỰC TIẾP ---
function updateChanges(s) {
    const data = coinData[s];
    if (!data || data.h.length < 2) return;
    const now = Date.now();
    const calc = (min) => {
        const target = now - (min * 60000);
        let startP = data.h[0].p;
        for (let i = data.h.length - 1; i >= 0; i--) {
            if (data.h[i].t <= target) { startP = data.h[i].p; break; }
        }
        return (((data.p - startP) / startP) * 100).toFixed(2);
    };
    data.c1 = calc(1); data.c5 = calc(5); data.c15 = calc(15);
}

// --- 3. WEBSOCKET - NHẬN LÀ NHẢY ---
function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.on('message', (msg) => {
        const tickers = JSON.parse(msg);
        const now = Date.now();
        tickers.forEach(t => {
            if (coinData[t.s]) {
                coinData[t.s].p = parseFloat(t.c);
                coinData[t.s].h.push({ p: coinData[t.s].p, t: now });
                if (coinData[t.s].h.length > 1000) coinData[s].h.shift();
                updateChanges(t.s); // Tính toán ngay tại luồng WS
            }
        });
    });
    ws.on('close', () => setTimeout(initWS, 3000));
}

// --- 4. API SIÊU NHẸ ---
app.get('/api/fast', (req, res) => {
    // Chỉ gửi top 20 biến động để giảm tải băng thông
    const fastData = Object.values(coinData)
        .sort((a, b) => Math.abs(b.c1) - Math.abs(a.c1))
        .slice(0, 20)
        .map(c => ({ s: c.s, p: c.p, c1: c.c1, c5: c.c5, c15: c.c15 }));
    res.json(fastData);
});

// --- 5. GUI REALTIME CỰC MẠNH ---
app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0b0e11; color: white; font-family: 'Segoe UI', sans-serif; overflow-x: hidden; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .row-update { animation: flash 0.4s ease-out; }
        @keyframes flash { from { background: rgba(255,255,255,0.1); } to { background: transparent; } }
    </style></head>
    <body class="p-4">
        <div class="max-w-4xl mx-auto">
            <div class="flex justify-between mb-4 border-b border-gray-800 pb-2">
                <h1 class="text-yellow-500 font-bold italic">LUFFY REALTIME V3</h1>
                <div id="delay" class="text-[10px] text-gray-500 font-mono">MS: --</div>
            </div>
            <div class="bg-[#1e2329] rounded shadow-xl overflow-hidden">
                <table class="w-full text-sm">
                    <thead class="bg-[#2b3139] text-gray-400">
                        <tr>
                            <th class="text-left p-3">PAIR</th>
                            <th class="text-left p-3">PRICE</th>
                            <th class="text-center p-3">1M%</th>
                            <th class="text-center p-3">5M%</th>
                            <th class="text-center p-3">15M%</th>
                        </tr>
                    </thead>
                    <tbody id="mainList"></tbody>
                </table>
            </div>
        </div>
        <script>
            let lastPrices = {};
            async function tick() {
                const start = Date.now();
                try {
                    const res = await fetch('/api/fast');
                    const data = await res.json();
                    const container = document.getElementById('mainList');
                    
                    let html = '';
                    data.forEach(item => {
                        const hasChanged = lastPrices[item.s] !== item.p;
                        const flashClass = hasChanged ? 'row-update' : '';
                        lastPrices[item.s] = item.p;

                        html += \`
                        <tr class="border-b border-gray-800 \${flashClass}">
                            <td class="p-3 font-bold">\${item.s}</td>
                            <td class="p-3 font-mono text-yellow-400">\${item.p.toFixed(4)}</td>
                            <td class="p-3 text-center font-bold \${item.c1>=0?'up':'down'}">\${item.c1}%</td>
                            <td class="p-3 text-center font-bold \${item.c5>=0?'up':'down'}">\${item.c5}%</td>
                            <td class="p-3 text-center font-bold \${item.c15>=0?'up':'down'}">\${item.c15}%</td>
                        </tr>\`;
                    });
                    container.innerHTML = html;
                    document.getElementById('delay').innerText = "DELAY: " + (Date.now() - start) + "ms";
                } catch(e) {}
            }
            // Chạy vòng lặp cực nhanh 500ms (0.5 giây/lần)
            setInterval(tick, 500);
        </script>
    </body></html>`);
});

app.listen(PORT, '0.0.0.0', async () => {
    await preloadAll();
    initWS();
    console.log(`\n🚀 Luffy Engine Live: http://localhost:\${PORT}/gui`);
});
