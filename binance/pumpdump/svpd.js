/**
 * LUFFY ENGINE ULTRA PRO - FULL VERSION
 * Trạng thái: Không rút gọn - Tắt log chi tiết - Real-time nhảy số ngay
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

let currentTP = 0.5, currentSL = 10.0, currentMinVol = 2.0, tradeMode = 'FOLLOW';

// --- DATABASE INIT ---
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
 * 1. PRELOAD DỮ LIỆU TỐC ĐỘ CAO (TẮT LOG CHI TIẾT)
 */
async function preloadHistory(symbol) {
    try {
        const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=20`);
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error("Dữ liệu không hợp lệ");
        
        coinData[symbol] = {
            symbol,
            prices: data.map(k => ({ p: parseFloat(k[4]), t: parseInt(k[0]) })),
            live: { c1: 0, c5: 0, c15: 0, currentPrice: parseFloat(data[data.length-1][4]) }
        };
        return true;
    } catch (e) {
        return false;
    }
}

async function preloadAll() {
    console.log('⏳ [1/3] Đang lấy danh sách cặp giao dịch...');
    try {
        const res = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
        const info = await res.json();
        const allFutures = info.symbols
            .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING')
            .map(s => s.symbol);

        console.log(`⏳ [2/3] Bắt đầu nạp data cho ${allFutures.length} cặp...`);
        let success = 0;
        let fail = 0;
        const batchSize = 40;

        for (let i = 0; i < allFutures.length; i += batchSize) {
            const batch = allFutures.slice(i, i + batchSize);
            const results = await Promise.all(batch.map(sym => preloadHistory(sym)));
            results.forEach(r => r ? success++ : fail++);
            
            // Log tiến trình trên 1 dòng
            const percent = Math.round(((i + batch.length) / allFutures.length) * 100);
            process.stdout.write(`\r🚀 Tiến trình: ${percent}% | Thành công: ${success} | Thất bại: ${fail}`);
        }
        console.log('\n✅ [3/3] Nạp dữ liệu hoàn tất!');
    } catch (e) {
        console.log('\n❌ Thất bại: Không thể kết nối API Binance. Lý do: ' + e.message);
    }
}

// --- TÍNH TOÁN BIẾN ĐỘNG ---
function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    const targetTime = now - (min * 60000);
    let start = pArr[0];
    for (let i = pArr.length - 1; i >= 0; i--) {
        if (pArr[i].t <= targetTime) { start = pArr[i]; break; }
    }
    const latest = pArr[pArr.length - 1];
    return parseFloat((((latest.p - start.p) / start.p) * 100).toFixed(2));
}

/**
 * 2. WEBSOCKET ENGINE (DỮ LIỆU THỰC)
 */
function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    
    ws.on('open', () => console.log('🔥 [WS] Đã kết nối luồng dữ liệu toàn sàn.'));
    
    ws.on('message', (data) => {
        try {
            const tickers = JSON.parse(data);
            const now = Date.now();
            tickers.forEach(t => {
                const s = t.s; const p = parseFloat(t.c);
                if (!coinData[s]) return;

                coinData[s].prices.push({ p, t: now });
                if (coinData[s].prices.length > 500) coinData[s].prices.shift();

                const c1 = calculateChange(coinData[s].prices, 1);
                const c5 = calculateChange(coinData[s].prices, 5);
                const c15 = calculateChange(coinData[s].prices, 15);
                coinData[s].live = { c1, c5, c15, currentPrice: p };

                // Logic kiểm tra lệnh Pending (PNL)
                const pending = pendingMap.get(s);
                if (pending && pending.status === 'PENDING') {
                    const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                    const roi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * 20;
                    if (roi >= pending.tpTarget * 20) {
                        pending.status = 'WIN';
                        pending.endTime = now;
                        pendingMap.delete(s);
                        fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
                    } else if (roi <= -pending.slTarget * 20) {
                        pending.status = 'LOSS';
                        pending.endTime = now;
                        pendingMap.delete(s);
                        fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values())));
                    }
                }
            });
        } catch (e) {}
    });

    ws.on('error', (e) => console.log('❌ [WS] Lỗi: ' + e.message));
    ws.on('close', () => {
        console.log('⚠️ [WS] Mất kết nối. Đang thử lại sau 5 giây...');
        setTimeout(initWS, 5000);
    });
}

// --- API ROUTES ---
app.get('/api/config', (req, res) => {
    currentTP = parseFloat(req.query.tp); currentSL = parseFloat(req.query.sl);
    currentMinVol = parseFloat(req.query.vol); tradeMode = req.query.mode;
    res.sendStatus(200);
});

app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    const coins = Object.values(coinData);
    res.json({ 
        allPrices: Object.fromEntries(coins.map(v => [v.symbol, v.live.currentPrice])),
        live: coins.filter(v => v.live).map(v => ({ symbol: v.symbol, ...v.live })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1)).slice(0, 15), 
        pending: all.filter(h => h.status === 'PENDING'),
        history: all.filter(h => h.status !== 'PENDING').sort((a,b)=>b.endTime-a.endTime).slice(0, 20),
        status: { total: coins.length, ready: coins.filter(c => c.prices.length >= 10).length }
    });
});

// --- DASHBOARD HTML ---
app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Luffy Trading Bot</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .luffy-img { position: fixed; bottom: 0; right: 0; width: 250px; opacity: 0.2; pointer-events: none; }
    </style></head>
    <body class="p-4">
        <img src="https://i.pinimg.com/originals/85/33/c2/8533c24d45543ef688f2f2526e38600f.png" class="luffy-img">
        
        <div class="max-w-4xl mx-auto">
            <div class="flex justify-between items-center mb-4 bg-card p-4 rounded-lg">
                <h1 class="text-xl font-bold text-yellow-500 italic">LUFFY BABY ENGINE v2.0</h1>
                <div id="sysStatus" class="text-xs text-gray-400">Đang đồng bộ...</div>
            </div>

            <div class="bg-card p-4 rounded-lg mb-4">
                <div class="text-xs font-bold text-gray-500 mb-2 uppercase">Biến động mạnh nhất</div>
                <table class="w-full text-sm">
                    <thead class="text-gray-400 border-b border-gray-700">
                        <tr><th class="text-left py-2">Cặp</th><th class="text-left">Giá</th><th class="text-center">1M</th><th class="text-center">5M</th><th class="text-center">15M</th></tr>
                    </thead>
                    <tbody id="marketBody"></tbody>
                </table>
            </div>

            <div class="bg-card p-4 rounded-lg border-l-4 border-yellow-500 mb-4">
                <div class="text-xs font-bold text-yellow-500 mb-2 uppercase">Lệnh đang chạy</div>
                <table class="w-full text-sm">
                    <tbody id="pendingBody"></tbody>
                </table>
            </div>
        </div>

        <script>
            async function update() {
                try {
                    const res = await fetch('/api/data');
                    const d = await res.json();
                    
                    document.getElementById('sysStatus').innerText = "ONLINE | Coins: " + d.status.total;
                    
                    // Render Market
                    document.getElementById('marketBody').innerHTML = d.live.map(m => \`
                        <tr class="border-b border-gray-800/50">
                            <td class="py-2 font-bold">\${m.symbol}</td>
                            <td class="text-yellow-500">\${m.currentPrice.toFixed(4)}</td>
                            <td class="text-center \${m.c1>=0?'up':'down'}">\${m.c1}%</td>
                            <td class="text-center \${m.c5>=0?'up':'down'}">\${m.c5}%</td>
                            <td class="text-center \${m.c15>=0?'up':'down'}">\${m.c15}%</td>
                        </tr>
                    \`).join('');

                    // Render Pending
                    document.getElementById('pendingBody').innerHTML = d.pending.length ? d.pending.map(p => {
                        const lp = d.allPrices[p.symbol] || p.avgPrice;
                        const roi = (p.type==='LONG'?(lp-p.avgPrice)/p.avgPrice:(p.avgPrice-lp)/p.avgPrice)*100*20;
                        return \`<tr><td class="py-2">\${p.symbol} (\${p.type})</td><td class="text-right \${roi>=0?'up':'down'} font-bold">\${roi.toFixed(2)}%</td></tr>\`;
                    }).join('') : '<tr><td class="text-gray-600 text-center py-4">Chưa có lệnh nào được mở</td></tr>';
                } catch(e) {}
            }
            setInterval(update, 1000);
        </script>
    </body></html>`);
});

// --- START SERVER ---
app.listen(PORT, '0.0.0.0', async () => { 
    await preloadAll(); 
    initWS(); 
    console.log(`\n🔥 Dashboard: http://localhost:${PORT}/gui`); 
});
