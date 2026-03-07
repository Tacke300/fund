import express from 'express';
import fs from 'fs';
import https from 'https';
import path from 'path';

const app = express();
app.use(express.json());

const PORT = 9009;
const DATA_DIR = './candle_data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

let allSymbols = [];
let symbolStats = {}; // Lưu trạng thái tải của từng coin
let crawlStatus = { isCrawling: false, totalDownloaded: 0 };

// --- HỆ THỐNG CRAWLER QUÉT DIỆN RỘNG (ROUND-ROBIN) ---

async function fetchKlines(symbol, endTime) {
    return new Promise((resolve) => {
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&endTime=${endTime}&limit=1000`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve([]); }
            });
        }).on('error', () => resolve([]));
    });
}

async function startCrawler() {
    if (crawlStatus.isCrawling) return;
    crawlStatus.isCrawling = true;

    const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const stopTs = now - TWO_YEARS_MS;

    // Khởi tạo trạng thái cho từng symbol từ file nếu có
    allSymbols.forEach(s => {
        const filePath = path.join(DATA_DIR, `${s.symbol}.json`);
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath));
            symbolStats[s.symbol] = {
                lastTs: data.length > 0 ? data[0][0] - 1 : now,
                count: data.length,
                status: 'Ready'
            };
        } else {
            symbolStats[s.symbol] = { lastTs: now, count: 0, status: 'Waiting' };
        }
    });

    // Vòng lặp vô tận quét mỗi coin một ít
    while (crawlStatus.isCrawling) {
        let hasMoreData = false;
        
        for (const item of allSymbols) {
            const symbol = item.symbol;
            const stat = symbolStats[symbol];

            if (stat.lastTs > stopTs) {
                stat.status = 'Downloading...';
                const klines = await fetchKlines(symbol, stat.lastTs);
                
                if (klines && klines.length > 0) {
                    const filePath = path.join(DATA_DIR, `${symbol}.json`);
                    let existingData = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath)) : [];
                    
                    // Nối dữ liệu mới vào đầu (càng cũ càng nằm trên)
                    existingData = [...klines, ...existingData];
                    fs.writeFileSync(filePath, JSON.stringify(existingData));
                    
                    stat.lastTs = klines[0][0] - 1;
                    stat.count = existingData.length;
                    crawlStatus.totalDownloaded += klines.length;
                    hasMoreData = true;
                } else {
                    stat.status = 'Completed/Error';
                }
                // Nghỉ cực ngắn giữa các coin để mượt mà
                await new Promise(r => setTimeout(r, 50));
            } else {
                stat.status = 'Done (2Y)';
            }
        }
        
        if (!hasMoreData) {
            console.log("Đã tải xong 2 năm cho tất cả coin.");
            break; 
        }
    }
}

// --- API & GIAO DIỆN ---

async function initSymbols() {
    return new Promise((resolve) => {
        https.get('https://fapi.binance.com/fapi/v1/ticker/price', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const prices = JSON.parse(data);
                    allSymbols = prices
                        .filter(p => p.symbol.endsWith('USDT'))
                        .map(p => ({ symbol: p.symbol, price: parseFloat(p.price) }))
                        .sort((a,b) => b.price - a.price);
                } catch(e) {}
                resolve();
            });
        }).on('error', () => resolve());
    });
}

app.get('/api/status', (req, res) => res.json({ crawlStatus, symbolStats, allSymbols }));

app.post('/api/analyze', (req, res) => {
    const { range, month, year, marginValue, maxGrids, stepSize, tpPercent } = req.body;
    let startTs, endTs = Date.now();
    if (range === 'custom') {
        startTs = new Date(year, month - 1, 1).getTime();
        endTs = new Date(year, month, 1).getTime();
    } else {
        startTs = endTs - (parseInt(range) * 24 * 60 * 60 * 1000);
    }

    let results = [];
    allSymbols.forEach(item => {
        const filePath = path.join(DATA_DIR, `${item.symbol}.json`);
        if (!fs.existsSync(filePath)) return;
        const data = JSON.parse(fs.readFileSync(filePath)).filter(k => k[0] >= startTs && k[0] <= endTs);
        if (data.length === 0) return;

        let pos = null, sPnl = 0, sWin = 0;
        for (const k of data) {
            const high = parseFloat(k[2]), low = parseFloat(k[3]), close = parseFloat(k[4]);
            if (!pos) { pos = { entry: close, qty: marginValue, count: 1 }; } 
            else {
                const avg = pos.entry; 
                if (((high - avg) / avg) * 100 >= tpPercent) {
                    sPnl += (avg * (tpPercent/100)) * (pos.qty * 20 / avg);
                    sWin++; pos = null;
                } else if (pos.count < maxGrids && ((avg - low) / avg) * 100 >= stepSize) {
                    pos.count++;
                }
            }
        }
        if (sWin > 0) results.push({ symbol: item.symbol, pnl: sPnl, trades: sWin });
    });
    res.json({ results, totalPnl: results.reduce((a,b) => a + b.pnl, 0) });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Matrix Round-Robin</title><script src="https://cdn.tailwindcss.com"></script>
    <style>
        body{background:#0b0e11;color:#eaecef;font-family:monospace;overflow:hidden}
        .sidebar { width: 300px; background: #161a1e; border-right: 1px solid #333; height: 100vh; overflow-y: auto; }
        .main-content { flex: 1; height: 100vh; overflow-y: auto; padding: 20px; }
        .luffy-card { background: #1e2329; border: 1px solid #333; border-radius: 4px; padding: 15px; }
        .symbol-item { border-bottom: 1px solid #2b3139; padding: 8px 12px; font-size: 11px; }
        .luffy-input { background: #000; border: 1px solid #333; color: #f0b90b; padding: 5px; border-radius: 4px; }
        .btn-active { border-color: #f0b90b !important; color: #f0b90b !important; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #333; }
    </style></head><body class="flex">
        
        <div class="sidebar">
            <div class="p-4 border-b border-gray-800 bg-[#1e2329] sticky top-0">
                <h2 class="text-yellow-500 font-black italic">SYMBOL LIST</h2>
                <div class="text-[9px] text-gray-500 uppercase">Trạng thái cập nhật nến 1m</div>
            </div>
            <div id="symbolList"></div>
        </div>

        <div class="main-content">
            <div class="luffy-card mb-5 flex justify-between items-center border-yellow-500/30">
                <div class="flex items-center gap-4">
                    <img src="https://i.imgur.com/8m5Tj6L.png" class="w-12 h-12 rounded-full border border-yellow-500">
                    <div>
                        <h1 class="text-xl font-black text-yellow-500 italic">LUFFY MATRIX <span class="text-white">ANALYTICS</span></h1>
                        <p class="text-[10px] text-gray-500">DỮ LIỆU ĐỔ VỀ THEO VÒNG (ROUND-ROBIN)</p>
                    </div>
                </div>
                <div class="text-right">
                    <div class="text-[10px] text-gray-500 uppercase">Tổng nến đã tải</div>
                    <div id="totalNen" class="text-2xl font-black text-white">0</div>
                </div>
            </div>

            <div class="grid grid-cols-4 gap-4 mb-5">
                <div class="luffy-card col-span-3">
                    <div class="flex gap-2 mb-4">
                        <button class="luffy-input px-3 text-[10px]" onclick="setRange('1',this)">1D</button>
                        <button class="luffy-input px-3 text-[10px]" onclick="setRange('7',this)">7D</button>
                        <button class="luffy-input px-3 text-[10px] btn-active" onclick="setRange('30',this)">30D</button>
                        <button class="luffy-input px-3 text-[10px]" onclick="setRange('custom',this)">THÁNG CŨ</button>
                        <div id="customGroup" class="flex gap-2 opacity-30 pointer-events-none ml-auto">
                             <select id="m" class="luffy-input text-[10px]"><option value="1">Tháng 1</option><option value="2">Tháng 2</option><option value="3">Tháng 3</option></select>
                             <select id="y" class="luffy-input text-[10px]"><option>2026</option><option>2025</option></select>
                        </div>
                    </div>
                    <div class="grid grid-cols-3 gap-4">
                        <div><label class="text-[9px] text-gray-500">MARGIN/DCA</label><div class="flex gap-1 mt-1"><input id="mg" value="10" class="luffy-input w-1/2 text-center"><input id="gr" value="5" class="luffy-input w-1/2 text-center"></div></div>
                        <div><label class="text-[9px] text-gray-500">GAP/TP %</label><div class="flex gap-1 mt-1"><input id="ss" value="1.5" class="luffy-input w-1/2 text-center"><input id="tp" value="1.0" class="luffy-input w-1/2 text-center"></div></div>
                        <button onclick="run()" class="bg-yellow-500 text-black font-black rounded uppercase hover:bg-yellow-400">Phân tích ngay</button>
                    </div>
                </div>
                <div class="luffy-card text-center flex flex-col justify-center">
                    <div class="text-gray-500 text-[10px] font-bold">PNL ƯỚC TÍNH</div>
                    <div id="totalPnl" class="text-3xl font-black text-green-400">0.00$</div>
                </div>
            </div>

            <div class="luffy-card p-0 overflow-hidden">
                <table class="w-full text-left text-[11px]">
                    <thead class="bg-black text-gray-500 uppercase"><tr><th class="p-3">Coin</th><th class="text-center">Win Rounds</th><th class="text-right pr-6">Profit</th></tr></thead>
                    <tbody id="tbody" class="divide-y divide-gray-800"></tbody>
                </table>
            </div>
        </div>

        <script>
            let range = '30';
            function setRange(v, b) {
                range = v; 
                document.querySelectorAll('button').forEach(x => x.classList.remove('btn-active'));
                b.classList.add('btn-active');
                document.getElementById('customGroup').style.opacity = v==='custom'?'1':'0.3';
                document.getElementById('customGroup').style.pointerEvents = v==='custom'?'auto':'none';
            }

            async function updateSidebar() {
                const r = await fetch('/api/status');
                const d = await r.json();
                document.getElementById('totalNen').innerText = d.crawlStatus.totalDownloaded.toLocaleString();
                document.getElementById('symbolList').innerHTML = d.allSymbols.map(s => {
                    const st = d.symbolStats[s.symbol] || {};
                    const color = st.status?.includes('Down') ? 'text-yellow-500' : (st.status?.includes('Done') ? 'text-green-500' : 'text-gray-500');
                    return \`<div class="symbol-item flex justify-between">
                        <span class="font-bold">\${s.symbol}</span>
                        <span class="\${color} text-[9px] uppercase">\${st.count?.toLocaleString() || 0} nến</span>
                    </div>\`;
                }).join('');
            }
            setInterval(updateSidebar, 2000);

            async function run() {
                const res = await fetch('/api/analyze', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        range, month: document.getElementById('m').value, year: document.getElementById('y').value,
                        marginValue: Number(document.getElementById('mg').value), maxGrids: Number(document.getElementById('gr').value),
                        stepSize: Number(document.getElementById('ss').value), tpPercent: Number(document.getElementById('tp').value)
                    })
                });
                const d = await res.json();
                document.getElementById('totalPnl').innerText = d.totalPnl.toFixed(2) + '$';
                document.getElementById('tbody').innerHTML = d.results.sort((a,b)=>b.pnl-a.pnl).map(x => \`
                    <tr class="hover:bg-white/5"><td class="p-3 font-bold text-yellow-500">\${x.symbol}</td><td class="text-center text-blue-400">\${x.trades}</td><td class="text-right font-bold text-green-400 pr-6">\${x.pnl.toFixed(2)}$</td></tr>
                \`).join('');
            }
        </script>
    </body></html>`);
});

initSymbols().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Live: http://localhost:${PORT}/gui`);
        startCrawler();
    });
});
