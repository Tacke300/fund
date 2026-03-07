import express from 'express';
import fs from 'fs';
import https from 'https';
import path from 'path';

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = 8888;
const DATA_DIR = './candle_data';
const LEVERAGE_FILE = './leverage_cache.json';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

let allSymbols = [];
let symbolMaxLeverage = {}; 
let crawlStatus = { isCrawling: false, totalDownloaded: 0, totalNeeded: 0, startTime: Date.now() };

if (fs.existsSync(LEVERAGE_FILE)) {
    try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){}
}

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
                    }
                } catch (e) {} resolve();
            });
        }).on('error', () => resolve());
    });
}

async function startCrawler() {
    if (crawlStatus.isCrawling) return;
    crawlStatus.isCrawling = true;
    crawlStatus.startTime = Date.now();
    const stopTs = Date.now() - (2 * 365 * 24 * 60 * 60 * 1000);
    crawlStatus.totalNeeded = allSymbols.length * 1051200; 

    for (const s of allSymbols) {
        const filePath = path.join(DATA_DIR, `${s.symbol}.json`);
        let existing = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath)) : [];
        let lastTs = existing.length > 0 ? existing[0][0] - 1 : Date.now();

        while (lastTs > stopTs) {
            const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${s.symbol}&interval=1m&endTime=${lastTs}&limit=1000`;
            const klines = await new Promise(r => {
                https.get(url, res => {
                    let d = ''; res.on('data', c => d += c); res.on('end', () => { try { r(JSON.parse(d)); } catch(e){ r([]); } });
                }).on('error', () => r([]));
            });
            if (!klines || klines.length === 0) break;
            existing = [...klines, ...existing];
            lastTs = klines[0][0] - 1;
            crawlStatus.totalDownloaded += klines.length;
            fs.writeFileSync(filePath, JSON.stringify(existing));
            await new Promise(r => setTimeout(r, 20));
        }
    }
}

// --- XỬ LÝ TÍNH TOÁN (TỐI ƯU CHỐNG LAG) ---
app.post('/api/analyze', async (req, res) => {
    const { range, month, year, marginValue, maxGrids, stepSize, tpPercent, mode, userLeverage } = req.body;
    const endTs = Date.now();
    let startTs;
    if (range === 'custom') {
        startTs = new Date(year, month - 1, 1).getTime();
    } else {
        startTs = endTs - (parseInt(range) * 24 * 60 * 60 * 1000);
    }
    
    let results = [];
    let historyAll = [];

    // Sử dụng for...of và await để giải phóng Event Loop giúp bot không bị lag
    for (const item of allSymbols) {
        const filePath = path.join(DATA_DIR, `${item.symbol}.json`);
        if (!fs.existsSync(filePath)) continue;
        
        const data = JSON.parse(fs.readFileSync(filePath)).filter(k => k[0] >= startTs && k[0] <= endTs);
        if (data.length === 0) continue;

        const exchangeMax = symbolMaxLeverage[item.symbol] || 20;
        const finalLev = Math.min(userLeverage, exchangeMax);
        const capitalGoc = marginValue * finalLev * maxGrids;

        let pos = null, sClosedPnl = 0, sWinCount = 0, sHistory = [];

        for (let i = 0; i < data.length; i++) {
            const k = data[i];
            const high = parseFloat(k[2]), low = parseFloat(k[3]), close = parseFloat(k[4]), time = k[0];
            
            if (!pos) {
                pos = { entry: close, gridsCount: 1, tsOpen: time };
            } else {
                const avg = pos.entry;
                const pnlFactor = mode === 'LONG' ? (high - avg) / avg : (avg - low) / avg;
                
                if (pnlFactor * 100 >= tpPercent) {
                    const winPnl = (pos.gridsCount * marginValue * finalLev) * (tpPercent / 100);
                    sClosedPnl += winPnl;
                    sWinCount++;
                    const round = { symbol: item.symbol, pnl: winPnl, grids: pos.gridsCount, tsClose: time, lev: finalLev };
                    sHistory.push(round);
                    historyAll.push(round);
                    pos = null;
                } else if (pos.gridsCount < maxGrids) {
                    const gap = mode === 'LONG' ? (avg - low) / avg : (high - avg) / avg;
                    if (gap * 100 >= stepSize) {
                        const newEntry = avg * (mode === 'LONG' ? 1-(stepSize/100) : 1+(stepSize/100));
                        pos.gridsCount++;
                        pos.entry = ((avg * (pos.gridsCount - 1)) + newEntry) / pos.gridsCount;
                    }
                }
            }
        }

        if (sWinCount > 0) {
            results.push({ 
                symbol: item.symbol, 
                closedCount: sWinCount, 
                maxLev: finalLev, 
                totalClosedPnl: sClosedPnl, 
                capitalGoc: capitalGoc,
                totalAsset: capitalGoc + sClosedPnl,
                totalRoi: (sClosedPnl / capitalGoc) * 100,
                history: sHistory
            });
        }
        // Cho phép Node.js xử lý các request khác giữa chừng (Chống Lag)
        await new Promise(resolve => setImmediate(resolve));
    }

    res.json({ active: results.sort((a,b)=>b.totalClosedPnl - a.totalClosedPnl), stats: { totalPnl: historyAll.reduce((a,b)=>a+b.pnl,0), totalWins: historyAll.length } });
});

app.get('/api/status', (req, res) => {
    const elapsed = (Date.now() - crawlStatus.startTime) / 1000;
    const rate = crawlStatus.totalDownloaded / (elapsed || 1);
    const remain = Math.max(0, crawlStatus.totalNeeded - crawlStatus.totalDownloaded);
    res.json({ ...crawlStatus, remainNen: remain, remainMin: Math.ceil(remain / rate / 60) || 0 });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Ultra 9888</title><script src="https://cdn.tailwindcss.com"></script>
    <style>
        body{background:#0b0e11;color:#eaecef;font-family:monospace;padding:10px}
        .matrix-card { background: #181c20; border: 1px solid #2b3139; border-radius: 8px; }
        .luffy-input { background: #000; border: 1px solid #333; color: #f0b90b; padding: 6px 10px; border-radius: 4px; font-size: 12px; }
        .modal { display: none; position: fixed; z-index: 100; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); backdrop-filter: blur(4px); }
        .modal-content { background: #1e2329; margin: 5% auto; padding: 20px; border: 1px solid #f0b90b; width: 80%; max-height: 80vh; overflow-y: auto; border-radius: 8px; }
        th { background: #1e2329; color: #848e9c; font-size: 10px; padding: 12px 8px; border-bottom: 2px solid #0b0e11; }
        .p-fill { height: 100%; background: #f0b90b; transition: 0.5s; box-shadow: 0 0 10px #f0b90b; }
    </style></head><body>
        
        <div class="fixed top-0 left-0 w-full h-1 bg-gray-900 z-50"><div id="pBar" class="p-fill w-0"></div></div>

        <div id="gridModal" class="modal" onclick="this.style.display='none'"><div class="modal-content" onclick="event.stopPropagation()">
            <div class="flex justify-between mb-4"><h2 id="modalTitle" class="text-xl font-bold text-yellow-500"></h2><button onclick="document.getElementById('gridModal').style.display='none'">✕</button></div>
            <div id="roundsList" class="grid grid-cols-1 md:grid-cols-4 gap-3"></div>
        </div></div>

        <div class="matrix-card p-4 mb-3 border-b-2 border-yellow-500/20">
            <div class="flex flex-wrap items-center gap-3 mb-4">
                <h1 class="text-xl font-black text-yellow-500 italic mr-auto tracking-tighter">LUFFY 9888 <span class="text-white">ULTRA MAX</span></h1>
                <div class="flex gap-2">
                    <select id="range" class="luffy-input"><option value="1">1 DAY</option><option value="7">7 DAYS</option><option value="30" selected>30 DAYS</option><option value="custom">CUSTOM</option></select>
                    <select id="m" class="luffy-input"><option value="3">THÁNG 3</option><option value="2">THÁNG 2</option></select>
                    <select id="y" class="luffy-input"><option value="2026">2026</option><option value="2025">2025</option></select>
                    <select id="mode" class="luffy-input text-green-500"><option value="LONG">LONG MODE</option><option value="SHORT">SHORT MODE</option></select>
                </div>
            </div>
            <div class="flex flex-wrap gap-3 items-center bg-black/30 p-3 rounded-lg">
                <div class="flex flex-col"><label class="text-[9px] text-gray-500">USER LEV</label><select id="userLev" class="luffy-input"><option value="20">x20</option><option value="50">x50</option><option value="100">x100</option><option value="125" selected>x125</option><option value="150">x150</option></select></div>
                <div class="flex flex-col"><label class="text-[9px] text-gray-500">MARGIN ($)</label><input id="mg" value="10" class="luffy-input w-20"></div>
                <div class="flex flex-col"><label class="text-[9px] text-gray-500">MAX DCA</label><input id="gr" value="5" class="luffy-input w-16"></div>
                <div class="flex flex-col"><label class="text-[9px] text-gray-500">STEP (%)</label><input id="ss" value="1.5" class="luffy-input w-16"></div>
                <div class="flex flex-col"><label class="text-[9px] text-gray-500">TP (%)</label><input id="tp" value="1.0" class="luffy-input w-16"></div>
                <button onclick="run()" id="btnRun" class="bg-yellow-500 hover:bg-yellow-400 text-black font-black px-10 py-2 rounded mt-auto h-[35px]">ANALYZE</button>
            </div>
        </div>

        <div class="grid grid-cols-4 gap-2 mb-3">
            <div class="matrix-card p-3"><div class="text-gray-500 text-[9px]">TIẾN TRÌNH</div><div id="loadPct" class="font-bold text-lg">0%</div></div>
            <div class="matrix-card p-3"><div class="text-gray-500 text-[9px]">CÒN LẠI</div><div id="statRem" class="font-bold text-lg text-blue-400">0 NẾN</div></div>
            <div class="matrix-card p-3"><div class="text-gray-500 text-[9px]">TỔNG PNL</div><div id="statPnl" class="font-bold text-lg text-green-400">0$</div></div>
            <div class="matrix-card p-3"><div class="text-gray-500 text-[9px]">THỜI GIAN</div><div id="statTime" class="font-bold text-lg text-purple-400">0 Mins</div></div>
        </div>

        <div class="matrix-card overflow-hidden">
            <table class="w-full text-left text-[11px]">
                <thead><tr>
                    <th class="text-center w-10">#</th>
                    <th>COIN</th>
                    <th class="text-center">WINS</th>
                    <th class="text-center">LEV</th>
                    <th class="text-right">VỐN GỐC (POS)</th>
                    <th class="text-right">PNL TỔNG</th>
                    <th class="text-right">VỐN + PNL</th>
                    <th class="text-center pr-4">ROI %</th>
                </tr></thead>
                <tbody id="activeBody" class="divide-y divide-gray-800"></tbody>
            </table>
        </div>

        <script>
            let detailData = {};
            async function run(){
                const btn = document.getElementById('btnRun'); btn.innerText = 'WAIT...'; btn.disabled = true;
                const res = await fetch('/api/analyze', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        range: document.getElementById('range').value, month: document.getElementById('m').value, year: document.getElementById('y').value,
                        marginValue: Number(document.getElementById('mg').value), maxGrids: Number(document.getElementById('gr').value),
                        stepSize: Number(document.getElementById('ss').value), tpPercent: Number(document.getElementById('tp').value), 
                        mode: document.getElementById('mode').value, userLeverage: Number(document.getElementById('userLev').value)
                    })
                });
                const d = await res.json();
                document.getElementById('statPnl').innerText = d.stats.totalPnl.toFixed(2) + '$';
                
                document.getElementById('activeBody').innerHTML = d.active.map((p, i) => {
                    detailData[p.symbol] = p.history;
                    return \`
                    <tr class="hover:bg-white/5 cursor-pointer" onclick="showHistory('\${p.symbol}')">
                        <td class="p-3 text-center text-gray-600">\${i+1}</td>
                        <td class="font-bold text-yellow-500">\${p.symbol}</td>
                        <td class="text-center text-blue-400 font-bold">\${p.closedCount}</td>
                        <td class="text-center text-purple-400">x\${p.maxLev}</td>
                        <td class="text-right text-gray-400">\${p.capitalGoc.toLocaleString()}$</td>
                        <td class="text-right font-bold text-green-400">\${p.totalClosedPnl.toFixed(2)}$</td>
                        <td class="text-right font-bold text-white">\${p.totalAsset.toFixed(2)}$</td>
                        <td class="text-center pr-4 font-black \${p.totalRoi>=0?'text-emerald-400':'text-red-400'}">\${p.totalRoi.toFixed(2)}%</td>
                    </tr>\`;
                }).join('');
                btn.innerText = 'ANALYZE'; btn.disabled = false;
            }

            function showHistory(symbol){
                const h = detailData[symbol];
                document.getElementById('modalTitle').innerText = symbol + " HISTORY";
                document.getElementById('roundsList').innerHTML = h.map((r, i) => \`
                    <div class="matrix-card p-2 border-l-2 border-green-500 text-[10px]">
                        <div class="flex justify-between font-bold text-yellow-500 mb-1"><span>#\${i+1}</span><span>+\${r.pnl.toFixed(2)}$</span></div>
                        <div class="text-gray-500">DCA: \${r.grids} | LEV: x\${r.lev}</div>
                    </div>\`).join('');
                document.getElementById('gridModal').style.display = 'block';
            }

            async function updateStatus(){
                try {
                    const res = await fetch('/api/status'); const d = await res.json();
                    const pct = (d.totalDownloaded / d.totalNeeded * 100).toFixed(2);
                    document.getElementById('pBar').style.width = pct + '%';
                    document.getElementById('loadPct').innerText = pct + '%';
                    document.getElementById('statRem').innerText = d.remainNen.toLocaleString() + ' NẾN';
                    document.getElementById('statTime').innerText = d.remainMin + ' MINS';
                } catch(e){}
            }
            setInterval(updateStatus, 3000);
        </script>
    </body></html>`);
});

initSymbols().then(async () => {
    await fetchActualLeverage();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`LUFFY ULTRA MAX 9888 LIVE: http://localhost:9888/gui`);
        startCrawler();
    });
});

async function initSymbols() {
    return new Promise((resolve) => {
        https.get('https://fapi.binance.com/fapi/v1/ticker/price', (res) => {
            let data = ''; res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const prices = JSON.parse(data);
                    allSymbols = prices.filter(p => p.symbol.endsWith('USDT')).map(p => ({ symbol: p.symbol }));
                } catch(e) {} resolve();
            });
        }).on('error', () => resolve());
    });
}
