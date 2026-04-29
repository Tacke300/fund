/**
 * LUFFY ENGINE ULTRA PRO - VERSION: 100% REALTIME TICKER
 * Trạng thái: Bản đầy đủ - Fix lỗi đứng im - Nhảy số liên tục từng giây
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

// Cấu hình mặc định
let currentTP = 0.5, currentSL = 10.0, currentMinVol = 2.0, tradeMode = 'FOLLOW';

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
 * 1. TÍNH TOÁN BIẾN ĐỘNG (ÉP NHẢY SỐ)
 */
function calculateChange(symbol, min) {
    const data = coinData[symbol];
    if (!data || data.prices.length < 2) return 0;
    
    const now = Date.now();
    const targetTime = now - (min * 60000);
    
    // Tìm giá cũ nhất khớp với mốc thời gian, nếu không thấy lấy giá đầu tiên của mảng
    let startPrice = data.prices[0].p;
    for (let i = data.prices.length - 1; i >= 0; i--) {
        if (data.prices[i].t <= targetTime) {
            startPrice = data.prices[i].p;
            break;
        }
    }
    
    const currentPrice = data.prices[data.prices.length - 1].p;
    return parseFloat((((currentPrice - startPrice) / startPrice) * 100).toFixed(2));
}

/**
 * 2. PRELOAD DỮ LIỆU TỐC ĐỘ CAO (TẮT WARM LOG RÁC)
 */
async function preloadHistory(symbol) {
    try {
        const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=30`);
        const data = await res.json();
        if (!Array.isArray(data)) return false;
        
        coinData[symbol] = {
            symbol,
            prices: data.map(k => ({ p: parseFloat(k[4]), t: parseInt(k[0]) })),
            snapPrice: parseFloat(data[data.length - 1][4])
        };
        return true;
    } catch (e) { return false; }
}

async function preloadAll() {
    console.log('⏳ [1/2] Đang quét danh sách Future...');
    const res = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
    const info = await res.json();
    const allFutures = info.symbols.filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING').map(s => s.symbol);
    
    let success = 0;
    const batchSize = 50;
    for (let i = 0; i < allFutures.length; i += batchSize) {
        const batch = allFutures.slice(i, i + batchSize);
        await Promise.all(batch.map(sym => preloadHistory(sym)));
        success += batch.length;
        process.stdout.write(`\r🚀 Tiến trình nạp data: ${Math.round((success/allFutures.length)*100)}% | Thành công: ${success}/${allFutures.length}`);
    }
    console.log('\n✅ Nạp dữ liệu hoàn tất!');
}

/**
 * 3. WEBSOCKET - NHẬN TIN LÀ CẬP NHẬT NGAY
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
                if (coinData[s].prices.length > 1200) coinData[s].prices.shift();

                // Quét lệnh Pending để tính PnL real-time
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
        status: { total: coins.length, ready: coins.filter(c => c.prices.length > 5).length }
    });
});

// --- GUI: HOÀN CHỈNH VÀ NHẢY REAL-TIME ---
app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Luffy Engine Realtime</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;700&display=swap');
        body { background: #0b0e11; color: #eaecef; font-family: 'Chakra Petch', sans-serif; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .glow-up { text-shadow: 0 0 10px #0ecb81; }
        .glow-down { text-shadow: 0 0 10px #f6465d; }
        .luffy-watermark { position: fixed; bottom: -20px; right: -20px; opacity: 0.1; width: 300px; pointer-events: none; }
    </style></head>
    <body class="p-4">
        <img src="https://i.pinimg.com/originals/85/33/c2/8533c24d45543ef688f2f2526e38600f.png" class="luffy-watermark">
        
        <div class="max-w-5xl mx-auto">
            <div class="flex justify-between items-center mb-6 bg-card p-4 rounded-xl shadow-2xl">
                <div>
                    <h1 class="text-2xl font-black text-yellow-500 italic">LUFFY <span class="text-white">ENGINE</span></h1>
                    <p id="sysStatus" class="text-[10px] text-gray-500 font-mono uppercase tracking-widest"></p>
                </div>
                <div class="text-right">
                    <div id="clock" class="text-xl font-bold">00:00:00</div>
                    <div class="text-[10px] text-green-500">WS CONNECTED</div>
                </div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div class="lg:col-span-2 bg-card rounded-xl p-4">
                    <h2 class="text-xs font-bold text-gray-400 mb-4 border-b border-gray-700 pb-2 uppercase italic">Top Volatility (Real-time)</h2>
                    <table class="w-full text-sm">
                        <thead>
                            <tr class="text-gray-500 text-[10px] uppercase">
                                <th class="text-left pb-2">Pair</th>
                                <th class="text-left pb-2">Live Price</th>
                                <th class="text-center pb-2">1M%</th>
                                <th class="text-center pb-2">5M%</th>
                                <th class="text-center pb-2">15M%</th>
                            </tr>
                        </thead>
                        <tbody id="marketBody"></tbody>
                    </table>
                </div>

                <div class="bg-card rounded-xl p-4 border-t-4 border-yellow-500">
                    <h2 class="text-xs font-bold text-yellow-500 mb-4 border-b border-gray-700 pb-2 uppercase">Active Positions</h2>
                    <div id="pendingBody" class="space-y-3"></div>
                </div>
            </div>
        </div>

        <script>
            let prevPrices = {};
            async function update() {
                try {
                    const res = await fetch('/api/data');
                    const d = await res.json();
                    
                    document.getElementById('sysStatus').innerText = "Nodes: " + d.status.total + " | Ready: " + d.status.ready;
                    document.getElementById('clock').innerText = new Date().toLocaleTimeString();
                    
                    // Render Market
                    document.getElementById('marketBody').innerHTML = d.live.map(m => {
                        const pDiff = prevPrices[m.symbol] ? m.currentPrice - prevPrices[m.symbol] : 0;
                        const glowClass = pDiff > 0 ? 'glow-up' : (pDiff < 0 ? 'glow-down' : '');
                        prevPrices[m.symbol] = m.currentPrice;
                        
                        return \`
                        <tr class="border-b border-gray-800/50 hover:bg-gray-800/30 transition">
                            <td class="py-3 font-bold text-white">\${m.symbol}</td>
                            <td class="font-mono \${glowClass} transition-all duration-300">\${m.currentPrice.toFixed(4)}</td>
                            <td class="text-center font-bold \${m.c1>=0?'up':'down'}">\${m.c1}%</td>
                            <td class="text-center font-bold \${m.c5>=0?'up':'down'}">\${m.c5}%</td>
                            <td class="text-center font-bold \${m.c15>=0?'up':'down'}">\${m.c15}%</td>
                        </tr>\`;
                    }).join('');

                    // Render Pending
                    document.getElementById('pendingBody').innerHTML = d.pending.length ? d.pending.map(p => {
                        const lp = d.allPrices[p.symbol] || p.avgPrice;
                        const roi = (p.type==='LONG'?(lp-p.avgPrice)/p.avgPrice:(p.avgPrice-lp)/p.avgPrice)*100*20;
                        return \`
                        <div class="bg-[#0b0e11] p-3 rounded-lg border border-gray-800">
                            <div class="flex justify-between text-[11px] font-bold">
                                <span>\${p.symbol}</span>
                                <span class="\${p.type==='LONG'?'up':'down'}">\${p.type} x20</span>
                            </div>
                            <div class="flex justify-between items-end mt-1">
                                <span class="text-[10px] text-gray-500">ROI%</span>
                                <span class="text-lg font-black \${roi>=0?'up':'down'}">\${roi.toFixed(2)}%</span>
                            </div>
                        </div>\`;
                    }).join('') : '<div class="text-center py-10 text-gray-600 text-xs italic">Waiting for signal...</div>';

                } catch(e) {}
            }
            // Update tốc độ cao để cảm nhận real-time
            setInterval(update, 800);
        </script>
    </body></html>`);
});

// --- KHỞI CHẠY ---
app.listen(PORT, '0.0.0.0', async () => { 
    await preloadAll(); 
    initWS(); 
    console.log(`\n🔥 Dashboard Online: http://localhost:${PORT}/gui`); 
});
