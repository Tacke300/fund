import express from 'express';
import fs from 'fs';
import https from 'https';
import path from 'path';

const app = express();
app.use(express.json());

const PORT = 8888;
const DATA_DIR = './candle_data';
const LEVERAGE_FILE = './leverage_cache.json';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

let allSymbols = [];
let symbolMaxLeverage = {}; 
let crawlStatus = { isCrawling: false, totalDownloaded: 0, totalNeeded: 0 };

// Tải cache đòn bẩy nếu có
if (fs.existsSync(LEVERAGE_FILE)) {
    try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){}
}

// --- LẤY TỐI ĐA ĐÒN BẨY TỪ BINANCE (CHỈ CHẠY 1 LẦN) ---
async function fetchActualLeverage() {
    return new Promise((resolve) => {
        https.get('https://fapi.binance.com/fapi/v1/leverageBracket', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const brackets = JSON.parse(data);
                    if (Array.isArray(brackets)) {
                        brackets.forEach(item => {
                            symbolMaxLeverage[item.symbol] = item.brackets[0].initialLeverage;
                        });
                        fs.writeFileSync(LEVERAGE_FILE, JSON.stringify(symbolMaxLeverage));
                        console.log("✅ Đã cập nhật Leverage Cache từ Binance.");
                    }
                } catch (e) {} resolve();
            });
        }).on('error', () => resolve());
    });
}

async function fetchKlines(symbol, endTime) {
    return new Promise((resolve) => {
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&endTime=${endTime}&limit=1000`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve([]); } });
        }).on('error', () => resolve([]));
    });
}

async function startCrawler() {
    if (crawlStatus.isCrawling) return;
    crawlStatus.isCrawling = true;
    const stopTs = Date.now() - (2 * 365 * 24 * 60 * 60 * 1000);
    crawlStatus.totalNeeded = allSymbols.length * 1000000;

    while (crawlStatus.isCrawling) {
        let hasData = false;
        for (const s of allSymbols) {
            const filePath = path.join(DATA_DIR, `${s.symbol}.json`);
            let existing = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath)) : [];
            let lastTs = existing.length > 0 ? existing[0][0] - 1 : Date.now();

            if (lastTs > stopTs) {
                const klines = await fetchKlines(s.symbol, lastTs);
                if (klines && klines.length > 0) {
                    existing = [...klines, ...existing];
                    fs.writeFileSync(filePath, JSON.stringify(existing));
                    crawlStatus.totalDownloaded += klines.length;
                    hasData = true;
                }
                await new Promise(r => setTimeout(r, 50));
            }
        }
        if (!hasData) break;
    }
}

// --- ANALYZE VỚI LOGIC CHỌN ĐÒN BẨY ---
app.post('/api/analyze', (req, res) => {
    const { range, month, year, marginValue, maxGrids, stepSize, tpPercent, mode, userLeverage } = req.body;
    let endTs = Date.now();
    let startTs = range === 'custom' ? new Date(year, month - 1, 1).getTime() : endTs - (parseInt(range) * 24 * 60 * 60 * 1000);
    
    let results = [];
    let historyAll = [];
    let levStats = {};
    let pnlToday = 0, pnl7d = 0;
    const cutoffToday = new Date().setHours(7,0,0,0);
    const cutoff7d = Date.now() - (7 * 24 * 60 * 60 * 1000);

    allSymbols.forEach(item => {
        const filePath = path.join(DATA_DIR, `${item.symbol}.json`);
        if (!fs.existsSync(filePath)) return;
        const data = JSON.parse(fs.readFileSync(filePath)).filter(k => k[0] >= startTs && k[0] <= endTs);
        if (data.length === 0) return;

        // Logic Leverage: Lấy Min(User chọn, Sàn cho phép)
        const exchangeMax = symbolMaxLeverage[item.symbol] || 20;
        const finalLev = Math.min(userLeverage, exchangeMax);

        let pos = null, sClosedPnl = 0, sWinCount = 0, sHistory = [];

        for (const k of data) {
            const high = parseFloat(k[2]), low = parseFloat(k[3]), close = parseFloat(k[4]), time = k[0];
            if (!pos) {
                pos = { entry: close, grids: [{price: close, time}], tsOpen: time };
            } else {
                const avg = pos.entry;
                const pnlFactor = mode === 'LONG' ? (high - avg) / avg : (avg - low) / avg;
                if (pnlFactor * 100 >= tpPercent) {
                    const winPnl = (avg * (tpPercent/100)) * (pos.grids.length * marginValue * finalLev / avg);
                    sClosedPnl += winPnl; sWinCount++;
                    const round = { symbol: item.symbol, pnl: winPnl, gridsCount: pos.grids.length, tsClose: time, avgPrice: avg, closePrice: close, details: [...pos.grids], lev: finalLev, totalMargin: pos.grids.length * marginValue };
                    sHistory.push(round);
                    historyAll.push(round);
                    if (time >= cutoffToday) pnlToday += winPnl;
                    if (time >= cutoff7d) pnl7d += winPnl;
                    pos = null;
                } else if (pos.grids.length < maxGrids) {
                    const lastP = pos.grids[pos.grids.length-1].price;
                    const gap = mode === 'LONG' ? (lastP - low) / lastP : (high - lastP) / lastP;
                    if (gap * 100 >= stepSize) {
                        pos.grids.push({ price: lastP * (mode === 'LONG' ? 1-(stepSize/100) : 1+(stepSize/100)), time });
                    }
                }
            }
        }

        if (sWinCount > 0) {
            const capital = marginValue * maxGrids;
            results.push({ symbol: item.symbol, closedCount: sWinCount, maxLev: finalLev, grids: { length: 0 }, totalClosedPnl: sClosedPnl, totalRoi: (sClosedPnl / capital) * 100 });
            
            if (!levStats[finalLev]) levStats[finalLev] = { totalPnl: 0, count: 0 };
            levStats[finalLev].totalPnl += sClosedPnl;
            levStats[finalLev].count++;
        }
    });

    res.json({ active: results, history: historyAll, levStats, stats: { today: pnlToday, d7: pnl7d, closedPnl: historyAll.reduce((a,b)=>a+b.pnl,0), totalGridsMatched: historyAll.reduce((a,b)=>a+b.gridsCount,0) } });
});

app.get('/api/status', (req, res) => res.json(crawlStatus));

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Matrix 8888</title><script src="https://cdn.tailwindcss.com"></script>
    <style>
        body{background:#0b0e11;color:#eaecef;font-family:monospace;padding:10px}
        .matrix-card { background: #1e2329; border: 1px solid #333; border-radius: 4px; }
        .luffy-input { background: #000; border: 1px solid #444; color: #f0b90b; padding: 6px; border-radius: 4px; font-size: 11px; }
        .modal { display: none; position: fixed; z-index: 100; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); }
        .modal-content { background: #1e2329; margin: 2% auto; padding: 20px; border: 1px solid #f0b90b; width: 95%; max-width: 1100px; border-radius: 8px; }
        .progress-bar { height: 4px; background: #f0b90b; width: 0%; transition: 0.5s; position: fixed; top: 0; left: 0; }
    </style></head><body>
        <div id="mainProgress" class="progress-bar"></div>
        
        <div id="gridModal" class="modal" onclick="this.style.display='none'"><div class="modal-content" onclick="event.stopPropagation()">
            <div class="flex justify-between items-center mb-4"><h2 id="modalTitle" class="text-xl font-black text-yellow-500"></h2><button onclick="document.getElementById('gridModal').style.display='none'" class="text-2xl">✕</button></div>
            <div id="roundsList" class="grid grid-cols-1 md:grid-cols-3 gap-3 max-h-[70vh] overflow-y-auto"></div>
        </div></div>

        <div class="matrix-card p-4 mb-2 flex flex-wrap items-end gap-3 border-yellow-500/20">
            <div class="flex items-center gap-3 mr-auto"><h1 class="text-lg font-black text-yellow-500 italic uppercase">Luffy Matrix <span class="text-white">8888</span></h1></div>
            <div class="flex gap-1">
                <button class="luffy-input px-3" onclick="setRange('1',this)">1D</button>
                <button class="luffy-input px-3 border-yellow-500 text-yellow-500" onclick="setRange('30',this)">30D</button>
                <select id="m" class="luffy-input"><option value="3">Tháng 3</option><option value="2">Tháng 2</option></select>
                <select id="userLev" class="luffy-input font-bold text-white bg-blue-900">
                    <option value="10">Set Lev x10</option><option value="20" selected>Set Lev x20</option><option value="25">Set Lev x25</option>
                    <option value="50">Set Lev x50</option><option value="75">Set Lev x75</option><option value="100">Set Lev x100</option><option value="150">Set Lev x150</option>
                </select>
            </div>
            <div class="flex gap-1">
                <input id="mg" value="10" class="luffy-input w-16 text-center">
                <input id="gr" value="5" class="luffy-input w-12 text-center">
                <input id="ss" value="1.5" class="luffy-input w-12 text-center">
                <input id="tp" value="1.0" class="luffy-input w-12 text-center">
            </div>
            <button onclick="run()" class="bg-yellow-500 text-black font-black px-8 py-2 rounded hover:scale-105 transition-all">PHÂN TÍCH</button>
        </div>

        <div id="levStats" class="grid grid-cols-4 md:grid-cols-10 gap-1 mb-2"></div>

        <div class="grid grid-cols-4 gap-1 mb-2">
            <div class="matrix-card p-2 text-center"><div class="text-gray-500 text-[8px]">HÔM NAY</div><div id="pnlToday" class="font-bold text-green-400 text-lg">0$</div></div>
            <div class="matrix-card p-2 text-center"><div class="text-gray-500 text-[8px]">7 NGÀY</div><div id="pnl7d" class="font-bold text-green-500 text-lg">0$</div></div>
            <div class="matrix-card p-2 text-center"><div class="text-gray-500 text-[8px]">ĐÃ CHỐT TỔNG</div><div id="statClosedPnl" class="font-bold text-yellow-500 text-lg">0$</div></div>
            <div class="matrix-card p-2 text-center"><div class="text-gray-500 text-[8px]">DỮ LIỆU TẢI</div><div id="loadPct" class="font-bold text-white text-lg">0%</div></div>
        </div>

        <div class="matrix-card overflow-hidden">
            <table class="w-full text-left text-[11px]">
                <thead class="bg-black"><tr>
                    <th class="p-2 text-center">STT</th>
                    <th>COIN</th>
                    <th class="text-center">VÒNG WIN</th>
                    <th class="text-center">LEV SỬ DỤNG</th>
                    <th class="text-right">TỔNG PNL ($)</th>
                    <th class="text-center pr-4">ROI %</th>
                </tr></thead>
                <tbody id="activeBody" class="divide-y divide-gray-800"></tbody>
            </table>
        </div>

        <script>
            let rawData = [], historyData = [];
            async function run(){
                const res = await fetch('/api/analyze', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        range: '30', month: document.getElementById('m').value, year: '2026',
                        marginValue: Number(document.getElementById('mg').value), maxGrids: Number(document.getElementById('gr').value),
                        stepSize: Number(document.getElementById('ss').value), tpPercent: Number(document.getElementById('tp').value), 
                        mode: 'LONG', userLeverage: Number(document.getElementById('userLev').value)
                    })
                });
                const d = await res.json();
                rawData = d.active.sort((a,b)=>b.totalClosedPnl - a.totalClosedPnl);
                historyData = d.history;
                document.getElementById('pnlToday').innerText = d.stats.today.toFixed(2) + '$';
                document.getElementById('pnl7d').innerText = d.stats.d7.toFixed(2) + '$';
                document.getElementById('statClosedPnl').innerText = d.stats.closedPnl.toFixed(2) + '$';
                
                document.getElementById('activeBody').innerHTML = rawData.map((p, i) => \`
                    <tr class="hover:bg-white/5 cursor-pointer" onclick="showHistory('\${p.symbol}')">
                        <td class="p-2 text-center text-gray-500">\${i+1}</td>
                        <td class="font-bold text-yellow-500">\${p.symbol}</td>
                        <td class="text-center text-blue-400">\${p.closedCount}</td>
                        <td class="text-center text-purple-400">x\${p.maxLev}</td>
                        <td class="text-right font-bold text-green-400">\${p.totalClosedPnl.toFixed(2)}$</td>
                        <td class="text-center font-bold text-emerald-400">\${p.totalRoi.toFixed(1)}%</td>
                    </tr>\`).join('');
            }

            function showHistory(symbol){
                const rounds = historyData.filter(h => h.symbol === symbol).reverse();
                document.getElementById('modalTitle').innerText = symbol + " HISTORY";
                document.getElementById('roundsList').innerHTML = rounds.map((r, i) => \`
                    <div class="matrix-card p-2 border-l-2 border-green-500 text-[10px]">
                        <div class="flex justify-between mb-1"><span class="font-bold text-yellow-500">VÒNG #\${rounds.length - i}</span><span class="text-green-400">+\${r.pnl.toFixed(2)}$</span></div>
                        <div class="text-gray-500">LEV: x\${r.lev} | DCA: \${r.gridsCount}</div>
                    </div>\`).join('');
                document.getElementById('gridModal').style.display = "block";
            }

            async function updateStatus(){
                const res = await fetch('/api/status'); const d = await res.json();
                const pct = (d.totalDownloaded / d.totalNeeded * 100).toFixed(1);
                document.getElementById('mainProgress').style.width = pct + '%';
                document.getElementById('loadPct').innerText = pct + '%';
            }
            setInterval(updateStatus, 2000);
        </script>
    </body></html>`);
});

initSymbols().then(async () => {
    await fetchActualLeverage(); // Lấy max lev từ sàn trước khi chạy
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Luffy 8888 Live: http://localhost:8888/gui`);
        startCrawler();
    });
});

async function initSymbols() {
    return new Promise((resolve) => {
        https.get('https://fapi.binance.com/fapi/v1/ticker/price', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const prices = JSON.parse(data);
                    allSymbols = prices.filter(p => p.symbol.endsWith('USDT')).map(p => ({ symbol: p.symbol }));
                } catch(e) {} resolve();
            });
        }).on('error', () => resolve());
    });
}
