/**
 * LUFFY ENGINE ULTIMATE - REALTIME SMOOTH VERSION
 * Trạng thái: Fix lỗi linh tinh - Giá nhảy cực mượt - Tắt warm log
 */

const PORT = 9000;
import WebSocket from 'ws';
import express from 'express';
import fetch from 'node-fetch';

const app = express();
let coinData = new Map(); // Dùng Map để truy xuất nhanh hơn object

// --- 1. HÀM TÍNH BIẾN ĐỘNG SIÊU NHANH ---
function getChange(prices, minutes) {
    if (prices.length < 2) return "0.00";
    const now = Date.now();
    const target = now - (minutes * 60000);
    
    let startPrice = prices[0].p;
    for (let i = prices.length - 1; i >= 0; i--) {
        if (prices[i].t <= target) {
            startPrice = prices[i].p;
            break;
        }
    }
    const lastPrice = prices[prices.length - 1].p;
    return (((lastPrice - startPrice) / startPrice) * 100).toFixed(2);
}

// --- 2. NẠP DATA BAN ĐẦU (TẮT LOG CHI TIẾT) ---
async function preloadAll() {
    try {
        const res = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
        const info = await res.json();
        const symbols = info.symbols
            .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING')
            .map(s => s.symbol);

        console.log(`⏳ Đang nạp \${symbols.length} cặp tiền...`);
        
        let count = 0;
        for (const sym of symbols) {
            const kRes = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=\${sym}&interval=1m&limit=30`);
            const kData = await kRes.json();
            
            if (Array.isArray(kData)) {
                coinData.set(sym, {
                    s: sym,
                    p: parseFloat(kData[kData.length - 1][4]),
                    history: kData.map(k => ({ p: parseFloat(k[4]), t: parseInt(k[0]) })),
                    c1: "0.00", c5: "0.00", c15: "0.00"
                });
            }
            count++;
            if (count % 50 === 0) {
                process.stdout.write(`\r🚀 Tiến trình: \${Math.round((count/symbols.length)*100)}% | Đã xong: \${count}`);
            }
        }
        console.log('\n✅ Dữ liệu đã sẵn sàng!');
    } catch (e) {
        console.log('\n❌ Lỗi khởi tạo: ' + e.message);
    }
}

// --- 3. WEBSOCKET LUỒNG GIÁ ---
function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    
    ws.on('message', (data) => {
        try {
            const tickers = JSON.parse(data);
            const now = Date.now();
            
            tickers.forEach(t => {
                const item = coinData.get(t.s);
                if (item) {
                    const price = parseFloat(t.c);
                    item.p = price;
                    item.history.push({ p: price, t: now });
                    
                    // Giới hạn bộ nhớ: chỉ giữ 1500 bản ghi/coin
                    if (item.history.length > 1500) item.history.shift();
                    
                    // Tính luôn biến động để API chỉ việc lấy ra
                    item.c1 = getChange(item.history, 1);
                    item.c5 = getChange(item.history, 5);
                    item.c15 = getChange(item.history, 15);
                }
            });
        } catch (e) {}
    });

    ws.on('close', () => setTimeout(initWS, 5000));
}

// --- 4. API DỮ LIỆU ---
app.get('/api/live', (req, res) => {
    const data = Array.from(coinData.values())
        .sort((a, b) => Math.abs(b.c1) - Math.abs(a.c1))
        .slice(0, 20); // Top 20 biến động nhất
    res.json(data);
});

// --- 5. GIAO DIỆN SIÊU MƯỢT ---
app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Luffy Smooth Realtime</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0b0e11; color: white; font-family: 'Inter', sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border-bottom: 1px solid #2b3139; transition: all 0.2s; }
        .price-up { background: rgba(14, 203, 129, 0.15) !important; }
        .price-down { background: rgba(246, 70, 93, 0.15) !important; }
    </style></head>
    <body class="p-6">
        <div class="max-w-4xl mx-auto">
            <div class="flex justify-between items-center mb-6 border-b border-gray-800 pb-4">
                <h1 class="text-2xl font-black text-yellow-500 italic">LUFFY BABY <span class="text-white text-sm not-italic font-normal">v3.0 SMOOTH</span></h1>
                <div id="status" class="text-xs font-mono text-gray-500 italic">SYNCING...</div>
            </div>

            <div class="overflow-hidden rounded-xl border border-gray-800 shadow-2xl">
                <table class="w-full text-sm">
                    <thead class="bg-[#2b3139] text-gray-400">
                        <tr>
                            <th class="p-4 text-left">SYMBOL</th>
                            <th class="p-4 text-left">PRICE</th>
                            <th class="p-4 text-right">1M</th>
                            <th class="p-4 text-right">5M</th>
                            <th class="p-4 text-right">15M</th>
                        </tr>
                    </thead>
                    <tbody id="list"></tbody>
                </table>
            </div>
        </div>

        <script>
            let oldData = {};
            async function update() {
                try {
                    const r = await fetch('/api/live');
                    const data = await r.json();
                    const container = document.getElementById('list');
                    document.getElementById('status').innerText = 'LIVE | ' + new Date().toLocaleTimeString();

                    container.innerHTML = data.map(coin => {
                        let flashClass = '';
                        if (oldData[coin.s]) {
                            if (coin.p > oldData[coin.s]) flashClass = 'price-up';
                            else if (coin.p < oldData[coin.s]) flashClass = 'price-down';
                        }
                        oldData[coin.s] = coin.p;

                        return \`
                        <tr class="bg-card \${flashClass}">
                            <td class="p-4 font-bold text-gray-200">\${coin.s}</td>
                            <td class="p-4 font-mono text-yellow-400 font-bold">\${coin.p.toFixed(4)}</td>
                            <td class="p-4 text-right font-black \${coin.c1 >= 0 ? 'up' : 'down'}">\${coin.c1}%</td>
                            <td class="p-4 text-right font-bold \${coin.c5 >= 0 ? 'up' : 'down'}">\${coin.c5}%</td>
                            <td class="p-4 text-right font-bold \${coin.c15 >= 0 ? 'up' : 'down'}">\${coin.c15}%</td>
                        </tr>\`;
                    }).join('');
                } catch (e) {}
            }
            
            // Chạy cập nhật liên tục mỗi 800ms để đảm bảo mượt mà không quá tải
            setInterval(update, 800);
        </script>
    </body></html>`);
});

app.listen(PORT, '0.0.0.0', async () => {
    await preloadAll();
    initWS();
    console.log(`\n🔥 Dashboard Online: http://localhost:\${PORT}/gui`);
});
