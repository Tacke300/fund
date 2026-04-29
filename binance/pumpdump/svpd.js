import WebSocket from 'ws';
import express from 'express';
import fetch from 'node-fetch';

const PORT = 9000;
const app = express();

let coinData = {};
let clients = [];

// 1. Khởi tạo danh sách cặp tiền
async function init() {
    try {
        const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
        const data = await res.json();
        data.forEach(item => {
            if (item.symbol.endsWith('USDT')) {
                coinData[item.symbol] = {
                    s: item.symbol,
                    p: parseFloat(item.price),
                    h: [{ p: parseFloat(item.price), t: Date.now() }],
                    c1: "0.00", c5: "0.00", c15: "0.00"
                };
            }
        });
        console.log("✅ Đã nạp " + Object.keys(coinData).length + " coin.");
    } catch (e) { console.log("Lỗi nạp data: " + e.message); }
}

// 2. Tính biến động chuẩn 3 khung
function calc(symbol, min) {
    const coin = coinData[symbol];
    if (!coin || coin.h.length < 2) return "0.00";
    const now = Date.now();
    const target = now - (min * 60000);
    let startP = coin.h[0].p;
    for (let i = coin.h.length - 1; i >= 0; i--) {
        if (coin.h[i].t <= target) { startP = coin.h[i].p; break; }
    }
    return (((coin.p - startP) / startP) * 100).toFixed(2);
}

// 3. Luồng WebSocket đẩy giá (Không dùng Buffer để tránh lag)
function startStream() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.on('message', (data) => {
        try {
            const tickers = JSON.parse(data);
            const now = Date.now();
            
            tickers.forEach(t => {
                if (coinData[t.s]) {
                    const price = parseFloat(t.c);
                    coinData[t.s].p = price;
                    coinData[t.s].h.push({ p: price, t: now });
                    if (coinData[t.s].h.length > 1000) coinData[t.s].h.shift();

                    // Cập nhật 3 khung ngay lập tức
                    coinData[t.s].c1 = calc(t.s, 1);
                    coinData[t.s].c5 = calc(t.s, 5);
                    coinData[t.s].c15 = calc(t.s, 15);
                }
            });

            // Gửi Top 10 con biến động nhất xuống Client
            const payload = Object.values(coinData)
                .sort((a, b) => Math.abs(b.c1) - Math.abs(a.c1))
                .slice(0, 10)
                .map(c => ({ s: c.s, p: c.p, c1: c.c1, c5: c.c5, c15: c.c15 }));

            clients.forEach(c => c.write(`data: ${JSON.stringify(payload)}\n\n`));
        } catch (e) {}
    });
    ws.on('close', () => setTimeout(startStream, 2000));
}

app.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    clients.push(res);
    req.on('close', () => clients = clients.filter(c => c !== res));
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0b0e11; color: white; font-family: 'Consolas', monospace; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        tr { border-bottom: 1px solid #1e2329; height: 50px; }
    </style></head>
    <body class="p-4">
        <div class="max-w-4xl mx-auto bg-[#1e2329] p-6 rounded-xl border border-yellow-600/30">
            <h1 class="text-yellow-500 font-black italic mb-4">LUFFY 3-FRAME REALTIME</h1>
            <table class="w-full text-sm">
                <thead>
                    <tr class="text-gray-500 text-left text-[10px] uppercase">
                        <th class="p-2">Coin</th><th>Price</th>
                        <th class="text-right">1M%</th><th class="text-right">5M%</th><th class="text-right">15M%</th>
                    </tr>
                </thead>
                <tbody id="list"></tbody>
            </table>
        </div>
        <script>
            const es = new EventSource('/stream');
            let last = {};
            es.onmessage = (e) => {
                const data = JSON.parse(e.data);
                if (!data.length) return;
                document.getElementById('list').innerHTML = data.map(c => {
                    const color = c.p > (last[c.s] || 0) ? 'text-green-400' : 'text-red-400';
                    last[c.s] = c.p;
                    return \`<tr>
                        <td class="p-2 font-bold">\${c.s}</td>
                        <td class="font-bold \${color}">\${c.p.toFixed(4)}</td>
                        <td class="text-right font-black \${c.c1>=0?'up':'down'}">\${c.c1}%</td>
                        <td class="text-right font-bold \${c.c5>=0?'up':'down'}">\${c.c5}%</td>
                        <td class="text-right font-bold \${c.c15>=0?'up':'down'}">\${c.c15}%</td>
                    </tr>\`;
                }).join('');
            };
        </script>
    </body></html>`);
});

(async () => {
    await init();
    startStream();
    app.listen(PORT, '0.0.0.0', () => console.log('🚀 Luffy V6: http://localhost:9000/gui'));
})();
