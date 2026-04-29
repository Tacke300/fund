import WebSocket from 'ws';
import express from 'express';
import fetch from 'node-fetch';

const PORT = 9000;
const app = express();

// Bộ nhớ đệm siêu tốc
let priceCache = new Map();
let lastUpdate = Date.now();

/**
 * 1. KHỞI TẠO DỮ LIỆU BAN ĐẦU
 */
async function initData() {
    console.log('⏳ Đang kết nối sàn Binance...');
    const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
    const data = await res.json();
    data.forEach(item => {
        if (item.symbol.endsWith('USDT')) {
            priceCache.set(item.symbol, {
                s: item.symbol,
                p: parseFloat(item.price),
                h: [{ p: parseFloat(item.price), t: Date.now() }],
                c: "0.00"
            });
        }
    });
    console.log(`✅ Đã nạp ${priceCache.size} cặp tiền.`);
}

/**
 * 2. WEBSOCKET STREAM - GIÁ NHẢY TỪNG MILI GIÂY
 */
function startStream() {
    // Stream toàn bộ miniTicker của Binance Future
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');

    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        
        tickers.forEach(t => {
            let coin = priceCache.get(t.s);
            if (coin) {
                const newPrice = parseFloat(t.c);
                coin.p = newPrice;
                coin.h.push({ p: newPrice, t: now });

                // Giữ lịch sử ngắn (2 phút) để tính biến động nhanh, tránh nặng RAM
                if (coin.h.length > 200) coin.h.shift();

                // Tính % biến động ngay lập tức (Realtime Calculation)
                const startPoint = coin.h[0];
                coin.c = (((newPrice - startPoint.p) / startPoint.p) * 100).toFixed(2);
            }
        });
    });

    ws.on('error', () => setTimeout(startStream, 3000));
    ws.on('close', () => setTimeout(startStream, 3000));
}

/**
 * 3. API TỐC ĐỘ CAO
 */
app.get('/api/live', (req, res) => {
    // Lấy Top 30 con đang biến động mạnh nhất để hiển thị
    const sorted = Array.from(priceCache.values())
        .sort((a, b) => Math.abs(b.c) - Math.abs(a.c))
        .slice(0, 30);
    res.json(sorted);
});

/**
 * 4. GIAO DIỆN "GAME ENGINE" - NHẢY GIÁ LIÊN TỤC
 */
app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0b0e11; color: white; font-family: 'Consolas', monospace; overflow: hidden; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .price-cell { transition: color 0.1s ease-in; }
        tr { border-bottom: 1px solid #1e2329; }
    </style></head>
    <body class="p-4">
        <div class="max-w-4xl mx-auto bg-[#1e2329] rounded-lg p-4 shadow-2xl border border-gray-800">
            <div class="flex justify-between items-center mb-4 border-b border-gray-700 pb-2">
                <h1 class="text-yellow-500 font-black italic">LUFFY 1S-ENGINE</h1>
                <div id="fps" class="text-[10px] text-gray-500">SYNCING...</div>
            </div>
            <table class="w-full text-left">
                <thead>
                    <tr class="text-gray-500 text-[10px] uppercase">
                        <th class="p-2">Cặp Tiền</th>
                        <th>Giá Hiện Tại</th>
                        <th class="text-right">Biến Động (Realtime)</th>
                    </tr>
                </thead>
                <tbody id="list"></tbody>
            </table>
        </div>

        <script>
            let lastPrices = {};

            async function render() {
                try {
                    const r = await fetch('/api/live');
                    const data = await r.json();
                    const container = document.getElementById('list');
                    const fps = document.getElementById('fps');
                    
                    let html = '';
                    data.forEach(c => {
                        const oldP = lastPrices[c.s] || c.p;
                        const pClass = c.p > oldP ? 'text-green-400' : (c.p < oldP ? 'text-red-400' : 'text-yellow-400');
                        lastPrices[c.s] = c.p;

                        html += \`<tr>
                            <td class="p-2 font-bold">\${c.s}</td>
                            <td class="font-mono font-bold \${pClass}">\${c.p.toFixed(4)}</td>
                            <td class="text-right font-black \${c.c >= 0 ? 'up' : 'down'}">\${c.c}%</td>
                        </tr>\`;
                    });
                    container.innerHTML = html;
                    fps.innerText = 'LAST UPDATE: ' + new Date().toLocaleTimeString();
                } catch(e) {}
            }

            // ĐẶT 800ms ĐỂ GIÁ NHẢY LIÊN TỤC MÀ KHÔNG TREO CHROME
            setInterval(render, 800);
        </script>
    </body></html>`);
});

// CHẠY HỆ THỐNG
(async () => {
    await initData();
    startStream();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🚀 LUFFY ENGINE LIVE TẠI: http://localhost:${PORT}/gui`);
    });
})();
