/**
 * LUFFY ENGINE - BẢN FULL GIỮ NGUYÊN LOGIC GỐC
 * TRẠNG THÁI: FIX LAG - NHẢY BIẾN ĐỘNG REALTIME TỪNG GIÂY
 */

const PORT = 9000;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import fetch from 'node-fetch';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let pendingMap = new Map(); 
let symbolMaxLeverage = {}; 

// Cấu hình trading gốc của mày
let currentTP = 0.5, currentSL = 10.0, currentMinVol = 2.0, tradeMode = 'FOLLOW';

// --- DATABASE INIT (GIỮ NGUYÊN) ---
if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
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
 * 1. FIX HÀM TÍNH BIẾN ĐỘNG - LẤY GIÁ GẦN NHẤT ĐỂ NHẢY SỐ NGAY
 */
function calculateChange(symbol, min) {
    const data = coinData[symbol];
    if (!data || data.prices.length < 2) return "0.00";
    
    const now = Date.now();
    const targetTime = now - (min * 60000);
    
    // Tìm giá gần nhất với mốc thời gian target
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
 * 2. PRELOAD (TẮT WARM LOG - CHỈ HIỆN TIẾN TRÌNH)
 */
async function preloadHistory(symbol) {
    try {
        const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=30`);
        const data = await res.json();
        coinData[symbol] = {
            symbol,
            prices: data.map(k => ({ p: parseFloat(k[4]), t: parseInt(k[0]) }))
        };
        return true;
    } catch (e) { return false; }
}

async function preloadAll() {
    console.log('⏳ Đang quét danh sách Future...');
    const res = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
    const info = await res.json();
    const allFutures = info.symbols.filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING').map(s => s.symbol);
    
    let success = 0;
    const batchSize = 40;
    for (let i = 0; i < allFutures.length; i += batchSize) {
        const batch = allFutures.slice(i, i + batchSize);
        await Promise.all(batch.map(sym => preloadHistory(sym)));
        success += batch.length;
        process.stdout.write(`\r🚀 Tiến trình: ${Math.round((success/allFutures.length)*100)}% | Thành công: ${success}`);
    }
    console.log('\n✅ Nạp dữ liệu hoàn tất!');
}

/**
 * 3. WEBSOCKET LUỒNG GIÁ (CẬP NHẬT LIÊN TỤC)
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

                // Thêm giá mới vào mảng
                coinData[s].prices.push({ p, t: now });
                if (coinData[s].prices.length > 1000) coinData[s].prices.shift();

                // Logic kiểm tra lệnh Pending (PNL) - Giữ nguyên của mày
                const pending = pendingMap.get(s);
                if (pending && pending.status === 'PENDING') {
                    const diff = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                    const roi = (pending.type === 'LONG' ? diff : -diff) * 20;
                    if (roi >= currentTP * 20 || roi <= -currentSL * 20) {
                        pending.status = roi >= 0 ? 'WIN' : 'LOSS';
                        pending.endTime = now;
                        pendingMap.delete(s);
                        fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
                    }
                }
            });
        } catch (e) {}
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

// --- API ---
app.get('/api/data', (req, res) => {
    const coins = Object.values(coinData);
    const live = coins.map(c => ({
        symbol: c.symbol,
        currentPrice: c.prices[c.prices.length - 1].p,
        c1: calculateChange(c.symbol, 1),
        c5: calculateChange(c.symbol, 5),
        c15: calculateChange(c.symbol, 15)
    })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1)).slice(0, 20);

    res.json({
        live,
        allPrices: Object.fromEntries(coins.map(v => [v.symbol, v.prices[v.prices.length - 1].p])),
        pending: Array.from(historyMap.values()).filter(h => h.status === 'PENDING'),
    });
});

// --- GUI: DASHBOARD LUFFY NHẢY SỐ TỪNG GIÂY ---
app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Luffy Trading Bot</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        /* Hiệu ứng nháy khi giá nhảy */
        .price-flash { animation: flash 0.3s ease-out; }
        @keyframes flash { from { background: rgba(255,255,255,0.1); } to { background: transparent; } }
        .luffy-img { position: fixed; bottom: 0; right: 0; width: 250px; opacity: 0.2; pointer-events: none; }
    </style></head>
    <body class="p-4">
        <img src="https://i.pinimg.com/originals/85/33/c2/8533c24d45543ef688f2f2526e38600f.png" class="luffy-img">
        
        <div class="max-w-4xl mx-auto">
            <div class="flex justify-between items-center mb-4 bg-card p-4 rounded-lg">
                <h1 class="text-xl font-bold text-yellow-500 italic uppercase">Luffy Baby Realtime</h1>
                <div id="clock" class="text-xs font-mono text-gray-500"></div>
            </div>

            <div class="bg-card p-4 rounded-lg mb-4">
                <table class="w-full text-sm">
                    <thead>
                        <tr class="text-gray-500 border-b border-gray-700 text-[10px] uppercase">
                            <th class="text-left py-2">Cặp Tiền</th><th class="text-left">Giá Live</th>
                            <th class="text-center">1M%</th><th class="text-center">5M%</th><th class="text-center">15M%</th>
                        </tr>
                    </thead>
                    <tbody id="marketBody"></tbody>
                </table>
            </div>

            <div class="bg-card p-4 rounded-lg border-l-4 border-yellow-500">
                <div class="text-[10px] font-bold text-yellow-500 mb-2 uppercase">Lệnh Đang Chạy</div>
                <div id="pendingBody" class="space-y-2"></div>
            </div>
        </div>

        <script>
            let lastPrices = {};
            async function update() {
                try {
                    const res = await fetch('/api/data');
                    const d = await res.json();
                    document.getElementById('clock').innerText = new Date().toLocaleTimeString();
                    
                    const body = document.getElementById('marketBody');
                    body.innerHTML = d.live.map(m => {
                        const hasChanged = lastPrices[m.symbol] !== m.currentPrice;
                        const flash = hasChanged ? 'price-flash' : '';
                        lastPrices[m.symbol] = m.currentPrice;

                        return \`
                        <tr class="border-b border-gray-800/50 \${flash}">
                            <td class="py-3 font-bold">\${m.symbol}</td>
                            <td class="text-yellow-400 font-mono font-bold">\${m.currentPrice.toFixed(4)}</td>
                            <td class="text-center font-bold \${m.c1>=0?'up':'down'}">\${m.c1}%</td>
                            <td class="text-center font-bold \${m.c5>=0?'up':'down'}">\${m.c5}%</td>
                            <td class="text-center font-bold \${m.c15>=0?'up':'down'}">\${m.c15}%</td>
                        </tr>\`;
                    }).join('');

                    document.getElementById('pendingBody').innerHTML = d.pending.length ? d.pending.map(p => {
                        const lp = d.allPrices[p.symbol] || p.avgPrice;
                        const roi = (p.type==='LONG'?(lp-p.avgPrice)/p.avgPrice:(p.avgPrice-lp)/p.avgPrice)*100*20;
                        return \`<div class="flex justify-between items-center bg-black/20 p-2 rounded">
                            <span class="font-bold">\${p.symbol} (\${p.type})</span>
                            <span class="font-black \${roi>=0?'up':'down'}">\${roi.toFixed(2)}%</span>
                        </div>\`;
                    }).join('') : '<div class="text-gray-600 text-center py-4 text-xs italic">Không có lệnh</div>';
                } catch(e) {}
            }
            // Gọi refresh mỗi 800ms để mượt mà nhất
            setInterval(update, 800);
        </script>
    </body></html>`);
});

// --- START ---
app.listen(PORT, '0.0.0.0', async () => { 
    await preloadAll(); 
    initWS(); 
    console.log(`\n🔥 Dashboard: http://localhost:${PORT}/gui`); 
});
