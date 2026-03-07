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

if (fs.existsSync(LEVERAGE_FILE)) try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){}

// --- CRAWLER ROUND-ROBIN (MỚI -> CŨ) ---
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
    const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;
    const stopTs = Date.now() - TWO_YEARS_MS;
    crawlStatus.totalNeeded = allSymbols.length * 1051200;

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
                await new Promise(r => setTimeout(r, 100));
            }
        }
        if (!hasData) break;
    }
}

// --- LOGIC PHÂN TÍCH (BACKTEST) ---
app.post('/api/analyze', (req, res) => {
    const { range, month, year, marginValue, maxGrids, stepSize, tpPercent, mode } = req.body;
    let startTs, endTs = Date.now();
    if (range === 'custom') {
        startTs = new Date(year, month - 1, 1).getTime();
        endTs = new Date(year, month, 1).getTime();
    } else {
        startTs = endTs - (parseInt(range) * 24 * 60 * 60 * 1000);
    }

    let results = [];
    let levStats = {};

    allSymbols.forEach(item => {
        const filePath = path.join(DATA_DIR, `${item.symbol}.json`);
        if (!fs.existsSync(filePath)) return;
        const data = JSON.parse(fs.readFileSync(filePath)).filter(k => k[0] >= startTs && k[0] <= endTs);
        if (data.length === 0) return;

        const maxLev = symbolMaxLeverage[item.symbol] || 20;
        let pos = null, sPnl = 0, sWin = 0, totalGridsMatched = 0, history = [];

        for (const k of data) {
            const high = parseFloat(k[2]), low = parseFloat(k[3]), close = parseFloat(k[4]), time = k[0];
            if (!pos) {
                pos = { entry: close, qty: marginValue, grids: [{price: close, time}], tsOpen: time };
            } else {
                const avg = pos.entry;
                const pnlFactor = mode === 'LONG' ? (high - avg) / avg : (avg - low) / avg;
                if (pnlFactor * 100 >= tpPercent) {
                    const winPnl = (avg * (tpPercent/100)) * (pos.grids.length * marginValue * maxLev / avg);
                    sPnl += winPnl; sWin++; 
                    totalGridsMatched += pos.grids.length;
                    history.push({ pnl: winPnl, gridsCount: pos.grids.length, tsClose: time, avgPrice: avg, details: [...pos.grids] });
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
        if (sWin > 0) {
            const capital = marginValue * maxGrids;
            const roi = (sPnl / capital) * 100;
            results.push({ symbol: item.symbol, maxLev, sWin, totalGridsMatched, sPnl, roi, history });
            
            if (!levStats[maxLev]) levStats[maxLev] = { pnl: 0, count: 0 };
            levStats[maxLev].pnl += sPnl;
            levStats[maxLev].count++;
        }
    });

    res.json({ results, levStats, totalPnl: results.reduce((a,b)=>a+b.sPnl,0) });
});

app.get('/api/status', (req, res) => res.json(crawlStatus));

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Matrix Offline Pro</title><script src="https://cdn.tailwindcss.com"></script>
    <style>
        body{background:#0b0e11;color:#eaecef;font-family:monospace;padding:15px}
        .matrix-card { background: #1e2329; border: 1px solid #333; border-radius: 4px; }
        .luffy-input { background: #000; border: 1px solid #333; color: #f0b90b; padding: 5px; border-radius: 4px; font-size: 11px; }
        .modal { display: none; position: fixed; z-index: 100; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); }
        .modal-content { background: #1e2329; margin: 2% auto; padding: 20px; border: 1px solid #f0b90b; width: 90%; max-width: 1000px; border-radius: 8px; }
        .round-card { background: #161a1e; border: 1px solid #333; padding: 10px; border-radius: 4px; cursor: pointer; }
        .progress-container { width: 100%; background: #000; height: 6px; border-radius: 3px; margin-bottom: 15px; border: 1px solid #333; }
        .progress-bar { height: 100%; background: linear-gradient(90deg, #f0b90b, #ff8c00); width: 0%; transition: 0.5s; box-shadow: 0 0 10px #f0b90b; }
    </style></head><body>

        <div class="progress-container"><div id="mainProgress" class="progress-bar"></div></div>

        <div id="gridModal" class="modal" onclick="this.style.display='none'"><div class="modal-content" onclick="event.stopPropagation()">
            <div class="flex justify-between items-center mb-4"><h2 id="modalTitle" class="text-xl font-black text-yellow-500 uppercase italic"></h2><button onclick="document.getElementById('gridModal').style.display='none'" class="text-2xl">✕</button></div>
            <div id="roundsList" class="grid grid-cols-1 md:grid-cols-3 gap-3 max-h-[70vh] overflow-y-auto"></div>
        </div></div>

        <div class="matrix-card p-4 mb-4 flex flex-wrap items-end gap-3 border-yellow-500/30">
            <div class="flex items-center gap-3 mr-auto">
                <img src="https://i.imgur.com/8m5Tj6L.png" class="w-10 h-10 rounded-full border border-yellow-500">
                <h1 class="text-lg font-black text-yellow-500 italic">LUFFY OFFLINE <span class="text-white">PRO</span></h1>
            </div>
            <div class="flex gap-2">
                <button class="luffy-input px-3" onclick="setRange('1',this)">1D</button>
                <button class="luffy-input px-3" onclick="setRange('7',this)">7D</button>
                <button class="luffy-input px-3 bg-yellow-500/10 border-yellow-500" onclick="setRange('30',this)">30D</button>
                <button class="luffy-input px-3" onclick="setRange('custom',this)">MONTH</button>
            </div>
            <div id="customTime" class="flex gap-2 opacity-30 pointer-events-none">
                <select id="m" class="luffy-input"><option value="3">Tháng 3</option><option value="2">Tháng 2</option></select>
                <select id="y" class="luffy-input"><option>2026</option><option>2025</option></select>
            </div>
            <div class="flex gap-2">
                <input id="mg" value="10" class="luffy-input w-16 text-center" placeholder="Margin">
                <input id="gr" value="5" class="luffy-input w-12 text-center" placeholder="DCA">
                <input id="ss" value="1.5" class="luffy-input w-12 text-center" placeholder="Gap%">
                <input id="tp" value="1.0" class="luffy-input w-12 text-center" placeholder="TP%">
            </div>
            <button onclick="runAnalyze()" class="bg-yellow-500 text-black font-black px-6 py-2 rounded hover:scale-105 transition-all">PHÂN TÍCH</button>
        </div>

        <div id="levStats" class="flex gap-2 mb-4 overflow-x-auto pb-2"></div>

        <div class="matrix-card overflow-hidden shadow-2xl">
            <table class="w-full text-left text-[11px]">
                <thead class="bg-black text-gray-500 uppercase"><tr>
                    <th class="p-3 text-center">STT</th>
                    <th class="p-3">SYMBOL</th>
                    <th class="text-center">MAX LEV</th>
                    <th class="text-center">SỐ WIN</th>
                    <th class="text-center">KHỚP TỔNG</th>
                    <th class="text-right">PNL ($)</th>
                    <th class="text-center pr-4">ROI TỔNG</th>
                </tr></thead>
                <tbody id="resultBody" class="divide-y divide-gray-800"></tbody>
            </table>
        </div>

        <script>
            let range = '30', currentData = [];
            function setRange(v, b){
                range = v; 
                document.querySelectorAll('button').forEach(x => x.classList.remove('border-yellow-500'));
                b.classList.add('border-yellow-500');
                document.getElementById('customTime').style.opacity = v==='custom'?'1':'0.3';
                document.getElementById('customTime').style.pointerEvents = v==='custom'?'auto':'none';
            }

            async function runAnalyze(){
                const btn = event.target; btn.innerText = "RUNNING...";
                const res = await fetch('/api/analyze', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        range, month: document.getElementById('m').value, year: document.getElementById('y').value,
                        marginValue: Number(document.getElementById('mg').value), maxGrids: Number(document.getElementById('gr').value),
                        stepSize: Number(document.getElementById('ss').value), tpPercent: Number(document.getElementById('tp').value), mode: 'LONG'
                    })
                });
                const d = await res.json();
                currentData = d.results.sort((a,b)=>b.sPnl - a.sPnl);
                
                document.getElementById('resultBody').innerHTML = currentData.map((r, i) => \`
                    <tr class="hover:bg-white/5 cursor-pointer" onclick="showHistory('\${r.symbol}')">
                        <td class="p-3 text-gray-500 text-center">\${i+1}</td>
                        <td class="font-bold text-yellow-500">\${r.symbol}</td>
                        <td class="text-center text-purple-400 font-bold">x\${r.maxLev}</td>
                        <td class="text-center text-blue-400 font-bold">\${r.sWin}</td>
                        <td class="text-center text-orange-400 font-bold">\${r.totalGridsMatched}</td>
                        <td class="text-right font-bold text-green-400">\${r.sPnl.toFixed(2)}$</td>
                        <td class="text-center pr-4 font-bold text-emerald-400">\${r.roi.toFixed(1)}%</td>
                    </tr>\`).join('');

                document.getElementById('levStats').innerHTML = Object.entries(d.levStats).map(([lev, val]) => \`
                    <div class="bg-[#1e2329] p-2 border border-gray-800 rounded min-w-[100px] text-center">
                        <div class="text-[8px] text-gray-500 font-black uppercase">LEV x\${lev}</div>
                        <div class="text-yellow-500 font-bold text-sm">\${val.pnl.toFixed(1)}$</div>
                        <div class="text-[9px] text-gray-400">\${val.count} Coins</div>
                    </div>\`).join('');
                btn.innerText = "PHÂN TÍCH";
            }

            function showHistory(symbol){
                const coin = currentData.find(c => c.symbol === symbol);
                document.getElementById('modalTitle').innerText = symbol + " - Lịch sử vòng đánh";
                document.getElementById('roundsList').innerHTML = coin.history.reverse().map((h, i) => \`
                    <div class="round-card border-l-4 border-l-green-500">
                        <div class="flex justify-between font-black text-xs text-white mb-2">
                            <span>VÒNG #\${coin.history.length - i}</span>
                            <span class="text-green-400">+\${h.pnl.toFixed(2)}$</span>
                        </div>
                        <div class="text-[9px] text-gray-500 flex justify-between mb-2">
                            <span>ENTRY: \${h.avgPrice.toFixed(4)}</span>
                            <span>\${new Date(h.tsClose).toLocaleTimeString()}</span>
                        </div>
                        <div class="flex gap-1 flex-wrap">
                            \${h.details.map((g, idx) => \`<span class="bg-black text-[8px] px-1 text-gray-400">#\${idx+1}: \${g.price.toFixed(4)}</span>\`).join('')}
                        </div>
                    </div>\`).join('');
                document.getElementById('gridModal').style.display = 'block';
            }

            async function updateProgress(){
                const res = await fetch('/api/status');
                const d = await res.json();
                const pct = (d.totalDownloaded / d.totalNeeded * 100).toFixed(2);
                document.getElementById('mainProgress').style.width = pct + '%';
            }
            setInterval(updateProgress, 2000);
        </script>
    </body></html>`);
});

async function initSymbols() {
    return new Promise((resolve) => {
        https.get('https://fapi.binance.com/fapi/v1/ticker/price', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const prices = JSON.parse(data);
                    allSymbols = prices.filter(p => p.symbol.endsWith('USDT')).map(p => ({ symbol: p.symbol, price: parseFloat(p.price) })).sort((a,b)=>b.price - a.price);
                } catch(e) {} resolve();
            });
        }).on('error', () => resolve());
    });
}

initSymbols().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`PRO Analytics: http://localhost:${PORT}/gui`);
        startCrawler();
    });
});
