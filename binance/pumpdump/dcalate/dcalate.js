import express from 'express';
import fs from 'fs';
import https from 'https';
import path from 'path';

const app = express();
app.use(express.json());

const PORT = 9888;
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

// --- CRAWLER VỚI TIẾN TRÌNH CHI TIẾT ---
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
                const req = https.get(url, res => {
                    let d = ''; res.on('data', c => d += c); res.on('end', () => { try { r(JSON.parse(d)); } catch(e){ r([]); } });
                });
                req.on('error', () => r([]));
                req.setTimeout(5000, () => { req.destroy(); r([]); });
            });

            if (!klines || klines.length === 0) break;
            existing = [...klines, ...existing];
            lastTs = klines[0][0] - 1;
            crawlStatus.totalDownloaded += klines.length;
            fs.writeFileSync(filePath, JSON.stringify(existing));
            if (!crawlStatus.isCrawling) return;
            await new Promise(r => setTimeout(r, 30));
        }
    }
    crawlStatus.isCrawling = false;
}

// --- LOGIC TÍNH TOÁN SIÊU TỐC ---
app.post('/api/analyze', (req, res) => {
    const { range, marginValue, maxGrids, stepSize, tpPercent, mode, userLeverage } = req.body;
    const endTs = Date.now();
    const startTs = endTs - (parseInt(range) * 24 * 60 * 60 * 1000);
    
    let results = [];
    let totalPnlAll = 0;

    allSymbols.forEach(item => {
        const filePath = path.join(DATA_DIR, `${item.symbol}.json`);
        if (!fs.existsSync(filePath)) return;
        
        const rawContent = fs.readFileSync(filePath);
        const allData = JSON.parse(rawContent);
        
        // Lọc nhanh theo thời gian
        const data = allData.filter(k => k[0] >= startTs && k[0] <= endTs);
        if (data.length === 0) return;

        const exchangeMax = symbolMaxLeverage[item.symbol] || 20;
        const finalLev = Math.min(userLeverage, exchangeMax);
        
        // CÔNG THỨC: Vốn gốc = margin * lev * số lưới dca
        const capitalGoc = marginValue * finalLev * maxGrids;

        let pos = null, sClosedPnl = 0, sWinCount = 0;

        for (let i = 0; i < data.length; i++) {
            const k = data[i];
            const high = parseFloat(k[2]), low = parseFloat(k[3]), close = parseFloat(k[4]), time = k[0];
            
            if (!pos) {
                pos = { entry: close, gridsCount: 1, tsOpen: time };
            } else {
                const avg = pos.entry;
                const pnlFactor = mode === 'LONG' ? (high - avg) / avg : (avg - low) / avg;
                
                if (pnlFactor * 100 >= tpPercent) {
                    // PNL = (Giá trị vị thế) * % lợi nhuận mục tiêu
                    const positionValue = pos.gridsCount * marginValue * finalLev;
                    const winPnl = positionValue * (tpPercent / 100);
                    
                    sClosedPnl += winPnl;
                    sWinCount++;
                    pos = null;
                } else if (pos.gridsCount < maxGrids) {
                    const lastP = avg; // Giả định DCA theo bước giá cố định từ entry trung bình hoặc entry gần nhất
                    const gap = mode === 'LONG' ? (lastP - low) / lastP : (high - lastP) / lastP;
                    if (gap * 100 >= stepSize) {
                        const newEntry = lastP * (mode === 'LONG' ? 1-(stepSize/100) : 1+(stepSize/100));
                        pos.gridsCount++;
                        pos.entry = ((avg * (pos.gridsCount - 1)) + newEntry) / pos.gridsCount;
                    }
                }
            }
        }

        if (sWinCount > 0) {
            totalPnlAll += sClosedPnl;
            results.push({ 
                symbol: item.symbol, 
                closedCount: sWinCount, 
                maxLev: finalLev, 
                totalClosedPnl: sClosedPnl, 
                capitalGoc: capitalGoc,
                totalAsset: capitalGoc + sClosedPnl,
                totalRoi: (sClosedPnl / capitalGoc) * 100 
            });
        }
    });

    res.json({ active: results.sort((a,b)=>b.totalClosedPnl - a.totalClosedPnl), totalPnlAll });
});

app.get('/api/status', (req, res) => {
    const elapsed = (Date.now() - crawlStatus.startTime) / 1000;
    const rate = crawlStatus.totalDownloaded / (elapsed || 1);
    const remainingCount = Math.max(0, crawlStatus.totalNeeded - crawlStatus.totalDownloaded);
    const remainingSeconds = remainingCount / (rate || 1);
    res.json({ 
        ...crawlStatus, 
        remainingMinutes: Math.ceil(remainingSeconds / 60),
        totalLoadedMB: (JSON.stringify(crawlStatus).length / 1024).toFixed(2)
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Ultra 9888</title><script src="https://cdn.tailwindcss.com"></script>
    <style>
        body{background:#0b0e11;color:#eaecef;font-family:monospace;padding:15px}
        .matrix-card { background: #161a1e; border: 1px solid #2b3139; border-radius: 8px; }
        .luffy-input { background: #000; border: 1px solid #333; color: #f0b90b; padding: 10px; border-radius: 6px; font-size: 13px; }
        th { background: #1e2329; color: #848e9c; font-size: 11px; padding: 15px 10px; border-bottom: 2px solid #0b0e11; }
        .progress-fill { height: 100%; background: #f0b90b; transition: 0.5s; box-shadow: 0 0 20px #f0b90b; }
    </style></head><body>
        
        <div class="fixed top-0 left-0 w-full h-1 bg-gray-800"><div id="pBar" class="progress-fill w-0"></div></div>

        <div class="matrix-card p-6 mb-4 flex flex-wrap items-end gap-5">
            <div class="mr-auto">
                <h1 class="text-3xl font-black text-yellow-500 italic uppercase">Luffy <span class="text-white">9888</span></h1>
                <div id="crawlDetail" class="text-[10px] text-gray-500 mt-2 font-bold uppercase tracking-widest">System Booting...</div>
            </div>
            <div class="flex gap-3 bg-black/50 p-3 rounded-xl border border-white/5">
                <select id="range" class="luffy-input"><option value="1">1 DAY</option><option value="7">7 DAYS</option><option value="30" selected>30 DAYS</option><option value="90">90 DAYS</option></select>
                <select id="userLev" class="luffy-input text-white font-bold"><option value="20">X20</option><option value="50">X50</option><option value="100">X100</option><option value="125" selected>X125</option></select>
                <input id="mg" value="10" placeholder="Margin" class="luffy-input w-24 text-center">
                <input id="gr" value="5" placeholder="DCA" class="luffy-input w-20 text-center">
                <button onclick="run()" id="btnRun" class="bg-yellow-500 hover:bg-yellow-400 text-black font-black px-12 py-3 rounded-lg transition-all active:scale-95">ANALYZE</button>
            </div>
        </div>

        <div class="grid grid-cols-4 gap-4 mb-4">
            <div class="matrix-card p-5 border-t-4 border-yellow-500"><div class="text-gray-500 text-[10px] font-bold">DATA LOADED</div><div id="loadPct" class="font-black text-2xl">0%</div></div>
            <div class="matrix-card p-5 border-t-4 border-green-500"><div class="text-gray-500 text-[10px] font-bold">TOTAL NET PNL</div><div id="statClosedPnl" class="font-black text-2xl text-green-400">0$</div></div>
            <div class="matrix-card p-5 border-t-4 border-blue-500"><div class="text-gray-500 text-[10px] font-bold">REMAINING NẾN</div><div id="statRemainNen" class="font-black text-2xl text-blue-400">0</div></div>
            <div class="matrix-card p-5 border-t-4 border-purple-500"><div class="text-gray-500 text-[10px] font-bold">EST. TIME</div><div id="statRemainTime" class="font-black text-2xl text-purple-400">0 Mins</div></div>
        </div>

        <div class="matrix-card overflow-hidden shadow-2xl">
            <table class="w-full text-left text-[13px]">
                <thead><tr>
                    <th class="text-center">#</th>
                    <th>SYMBOL</th>
                    <th class="text-center">WIN ROUNDS</th>
                    <th class="text-center">LEV</th>
                    <th class="text-right">VỐN GỐC (POS VALUE)</th>
                    <th class="text-right">PNL TỔNG</th>
                    <th class="text-right">VỐN + PNL</th>
                    <th class="text-center pr-6">ROI %</th>
                </tr></thead>
                <tbody id="activeBody" class="divide-y divide-white/5"></tbody>
            </table>
        </div>

        <script>
            async function run(){
                const btn = document.getElementById('btnRun');
                btn.innerText = 'PROCESSING...'; btn.disabled = true;
                try {
                    const res = await fetch('/api/analyze', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            range: document.getElementById('range').value,
                            marginValue: Number(document.getElementById('mg').value),
                            maxGrids: Number(document.getElementById('gr').value),
                            stepSize: 1.5, tpPercent: 1.0, mode: 'LONG',
                            userLeverage: Number(document.getElementById('userLev').value)
                        })
                    });
                    const d = await res.json();
                    document.getElementById('statClosedPnl').innerText = d.totalPnlAll.toFixed(2) + '$';
                    
                    document.getElementById('activeBody').innerHTML = d.active.map((p, i) => \`
                        <tr class="hover:bg-white/[0.02]">
                            <td class="p-4 text-center text-gray-600">\${i+1}</td>
                            <td class="font-bold text-yellow-500 uppercase">\${p.symbol}</td>
                            <td class="text-center font-bold text-blue-400">\${p.closedCount}</td>
                            <td class="text-center text-purple-400 font-bold">x\${p.maxLev}</td>
                            <td class="text-right text-gray-400">\${p.capitalGoc.toLocaleString()}$</td>
                            <td class="text-right font-bold text-green-400">\${p.totalClosedPnl.toFixed(2)}$</td>
                            <td class="text-right font-bold text-white">\${p.totalAsset.toFixed(2)}$</td>
                            <td class="text-center pr-6 font-black \${p.totalRoi>=0?'text-emerald-400':'text-red-400'}">\${p.totalRoi.toFixed(2)}%</td>
                        </tr>\`).join('');
                } finally {
                    btn.innerText = 'ANALYZE'; btn.disabled = false;
                }
            }

            async function updateStatus(){
                try {
                    const res = await fetch('/api/status'); const d = await res.json();
                    const pct = (d.totalDownloaded / d.totalNeeded * 100).toFixed(2);
                    document.getElementById('pBar').style.width = pct + '%';
                    document.getElementById('loadPct').innerText = pct + '%';
                    document.getElementById('statRemainTime').innerText = d.remainingMinutes + ' Mins';
                    document.getElementById('statRemainNen').innerText = (d.totalNeeded - d.totalDownloaded).toLocaleString();
                    document.getElementById('crawlDetail').innerText = \`[ \${d.totalDownloaded.toLocaleString()} / \${d.totalNeeded.toLocaleString()} ] CANDLES FETCHED\`;
                } catch(e){}
            }
            setInterval(updateStatus, 2000);
        </script>
    </body></html>`);
});

initSymbols().then(async () => {
    await fetchActualLeverage();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`LUFFY ULTRA 9888 LIVE: http://localhost:9888/gui`);
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
