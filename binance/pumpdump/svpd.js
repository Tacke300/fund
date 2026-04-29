import WebSocket from 'ws';
import express from 'express';
import fetch from 'node-fetch';

const PORT = 9000;
const app = express();

let coinData = {};
let clients = [];

/**
 * 1. KHỞI TẠO SNAPSHOT GIÁ (REST)
 */
async function init() {
    console.log('⏳ Đang nạp dữ liệu Binance...');
    const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
    const data = await res.json();
    data.forEach(item => {
        if (item.symbol.endsWith('USDT')) {
            coinData[item.symbol] = {
                s: item.symbol,
                p: parseFloat(item.price),
                h: [{ p: parseFloat(item.price), t: Date.now() }],
                c: "0.00"
            };
        }
    });
    console.log('✅ Sẵn sàng.');
}

/**
 * 2. LUỒNG GIÁ SIÊU TỐC (WS) - ĐẨY THẲNG XUỐNG MÀN HÌNH
 */
function startStream() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        let updates = [];

        tickers.forEach(t => {
            let coin = coinData[t.s];
            if (coin) {
                const newPrice = parseFloat(t.c);
                coin.p = newPrice;
                coin.h.push({ p: newPrice, t: now });
                if (coin.h.length > 200) coin.h.shift();

                // Tính biến động dựa trên giá cũ nhất trong 200 ticks gần nhất
                const startPoint = coin.h[0];
                coin.c = (((newPrice - startPoint.p) / startPoint.p) * 100).toFixed(2);
                updates.push({ s: coin.s, p: coin.p, c: coin.c });
            }
        });

        // CHỈ LẤY 10 CON BIẾN ĐỘNG MẠNH NHẤT ĐỂ ĐẢM BẢO TỐC ĐỘ 1S
        const payload = JSON.stringify(updates.sort((a,b) => Math.abs(b.c) - Math.abs(a.c)).slice(0, 10));
        clients.forEach(client => client.write(`data: ${payload}\n\n`));
    });
    ws.on('close', () => setTimeout(startStream, 3000));
}

// Đường ống SSE
app.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    clients.push(res);
    req.on('close', () => clients = clients.filter(c => c !== res));
});

/**
 * 3. GUI LUFFY BABY - CHỈ 10 COIN - NHẢY LIÊN TỤC
 */
app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0b0e11; color: white; font-family: 'Consolas', monospace; overflow: hidden; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        tr { border-bottom: 1px solid #1e2329; height: 55px; }
        .luffy-bg { position: fixed; bottom: -20px; right: -20px; width: 300px; opacity: 0.15; pointer-events: none; }
    </style></head>
    <body class="p-6">
        <img src="https://i.pinimg.com/originals/85/33/c2/8533c24d45543ef688f2f2526e38600f.png" class="luffy-bg">
        <div class="max-w-2xl mx-auto bg-[#1e2329] p-6 rounded-2xl shadow-2xl border border-yellow-500/20">
            <div class="flex justify-between items-center mb-6">
                <h1 class="text-2xl font-black text-yellow-500 italic">LUFFY <span class="text-white">TOP 10</span></h1>
                <div id="status" class="text-green-500 font-bold text-xs uppercase animate-pulse">● Live Stream</div>
            </div>
            <table class="w-full">
                <thead>
                    <tr class="text-gray-500 text-xs uppercase text-left">
                        <th class="pb-4">Coin</th><th class="pb-4">Price</th><th class="pb-4 text-right">Change%</th>
                    </tr>
                </thead>
                <tbody id="list"></tbody>
            </table>
        </div>
        <script>
            const eventSource = new EventSource('/stream');
            let prev = {};
            eventSource.onmessage = (e) => {
                const data = JSON.parse(e.data);
                const list = document.getElementById('list');
                list.innerHTML = data.map(c => {
                    const color = c.p > (prev[c.s] || 0) ? 'text-green-400' : 'text-red-400';
                    prev[c.s] = c.p;
                    return \`<tr class="font-bold">
                        <td class="text-lg">\${c.s}</td>
                        <td class="text-xl font-mono \${color}">\${c.p.toFixed(4)}</td>
                        <td class="text-right text-xl \${c.c >= 0 ? 'up' : 'down'}">\${c.c}%</td>
                    </tr>\`;
                }).join('');
            };
        </script>
    </body></html>`);
});

(async () => {
    await init();
    startStream();
    app.listen(PORT, '0.0.0.0', () => console.log('🚀 Link: http://localhost:9000/gui'));
})();
