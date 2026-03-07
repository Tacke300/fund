import express from 'express';
import fs from 'fs';
import https from 'https';
import path from 'path';

const app = express();
app.use(express.json());

const PORT = 9008;
const DATA_DIR = './candle_data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

let allSymbols = []; // Sẽ chứa {symbol, price}
let crawlStatus = {
    currentSymbol: 'Đang khởi tạo...',
    downloadedCount: 0,
    totalNeeded: 1051200, // 2 năm
    completedSymbols: 0,
    totalSymbols: 0,
    isCrawling: false
};

// --- HỆ THỐNG CRAWLER ƯU TIÊN GIÁ CAO ---

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

    // Sắp xếp symbols theo giá từ cao xuống thấp
    const sortedSymbols = allSymbols.sort((a, b) => b.price - a.price);

    for (const item of sortedSymbols) {
        const symbol = item.symbol;
        crawlStatus.currentSymbol = symbol;
        crawlStatus.downloadedCount = 0;
        const filePath = path.join(DATA_DIR, `${symbol}.json`);
        
        let existingData = [];
        let lastTimestamp = now;

        if (fs.existsSync(filePath)) {
            try {
                existingData = JSON.parse(fs.readFileSync(filePath));
                if (existingData.length > 0) {
                    lastTimestamp = existingData[0][0] - 1;
                    crawlStatus.downloadedCount = existingData.length;
                }
            } catch (e) { existingData = []; }
        }

        if (lastTimestamp <= stopTs) {
            crawlStatus.completedSymbols++;
            continue;
        }

        while (lastTimestamp > stopTs) {
            const klines = await fetchKlines(symbol, lastTimestamp);
            if (!klines || klines.length === 0) break;
            existingData = [...klines, ...existingData];
            fs.writeFileSync(filePath, JSON.stringify(existingData));
            lastTimestamp = klines[0][0] - 1;
            crawlStatus.downloadedCount = existingData.length;
            await new Promise(r => setTimeout(r, 150));
        }
        crawlStatus.completedSymbols++;
    }
    crawlStatus.isCrawling = false;
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
                    const futuSymbols = prices.filter(p => p.symbol.endsWith('USDT'));
                    allSymbols = futuSymbols.map(p => ({ symbol: p.symbol, price: parseFloat(p.price) }));
                    crawlStatus.totalSymbols = allSymbols.length;
                } catch(e) {}
                resolve();
            });
        }).on('error', () => resolve());
    });
}

app.get('/api/status', (req, res) => res.json(crawlStatus));

app.post('/api/analyze', (req, res) => {
    const { range, month, year, marginValue, maxGrids, stepSize, tpPercent } = req.body;
    let startTs, endTs = Date.now();

    if (range === 'custom') {
        startTs = new Date(year, month - 1, 1).getTime();
        endTs = new Date(year, month, 1).getTime();
    } else {
        const days = parseInt(range);
        startTs = endTs - (days * 24 * 60 * 60 * 1000);
    }

    let totalPnl = 0;
    let results = [];

    allSymbols.forEach(item => {
        const symbol = item.symbol;
        const filePath = path.join(DATA_DIR, `${symbol}.json`);
        if (!fs.existsSync(filePath)) return;

        const data = JSON.parse(fs.readFileSync(filePath)).filter(k => k[0] >= startTs && k[0] <= endTs);
        if (data.length === 0) return;

        let pos = null, sPnl = 0, sWin = 0;
        for (const k of data) {
            const high = parseFloat(k[2]), low = parseFloat(k[3]), close = parseFloat(k[4]);
            if (!pos) {
                pos = { entry: close, qty: marginValue, count: 1 };
            } else {
                const avg = pos.entry; 
                if (((high - avg) / avg) * 100 >= tpPercent) {
                    sPnl += (avg * (tpPercent/100)) * (pos.qty * 20 / avg);
                    sWin++; pos = null;
                } else if (pos.count < maxGrids && ((avg - low) / avg) * 100 >= stepSize) {
                    pos.count++;
                }
            }
        }
        if (sWin > 0) {
            totalPnl += sPnl;
            results.push({ symbol, pnl: sPnl, trades: sWin });
        }
    });
    res.json({ totalPnl, results });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Matrix Final</title><script src="https://cdn.tailwindcss.com"></script>
    <style>
        body{background:#0b0e11;color:#eaecef;font-family:monospace;overflow-x:hidden}
        .matrix-border { border: 1px solid #333; background: #1e2329; border-radius: 8px; }
        .progress-bg { background: #000; height: 12px; border-radius: 6px; overflow: hidden; border: 1px solid #444; position: relative; }
        .progress-bar { height: 100%; background: linear-gradient(90deg, #f0b90b, #ff8c00); transition: 0.4s; box-shadow: 0 0 10px #f0b90b; }
        .luffy-input { background: #000; border: 1px solid #333; color: #f0b90b; padding: 6px; border-radius: 4px; font-weight: bold; }
        .btn-range { background: #161a1e; border: 1px solid #333; padding: 5px 12px; border-radius: 4px; transition: 0.2s; cursor: pointer; }
        .btn-range:hover, .btn-range.active { border-color: #f0b90b; color: #f0b90b; background: #000; }
        .luffy-main-btn { background: linear-gradient(180deg, #f0b90b 0%, #ca9600 100%); color: #000; font-weight: 900; box-shadow: 0 4px 15px rgba(240,185,11,0.3); }
    </style></head><body class="p-4 text-[12px]">
        
        <div class="matrix-border p-5 mb-5 border-yellow-500/30">
            <div class="flex justify-between items-center mb-4">
                <div class="flex items-center gap-4">
                    <img src="https://i.imgur.com/8m5Tj6L.png" class="w-14 h-14 rounded-full border-2 border-yellow-500 shadow-lg shadow-yellow-500/40">
                    <div>
                        <h1 class="text-2xl font-black text-yellow-500 tracking-tighter uppercase italic">Luffy Matrix <span class="text-white">Price-Priority Crawler</span></h1>
                        <p class="text-[9px] text-gray-500">DỮ LIỆU NGOẠI TUYẾN - ƯU TIÊN COIN GIÁ CAO ĐẾN THẤP</p>
                    </div>
                </div>
                <div class="text-right">
                    <div id="coinName" class="text-xl font-black text-white italic">BTCUSDT</div>
                    <div id="coinDetail" class="text-[10px] text-gray-400 font-bold">0 / 1,051,200 nến</div>
                </div>
            </div>
            <div class="progress-bg mb-3"><div id="coinProgress" class="progress-bar" style="width: 0%"></div></div>
            <div class="flex justify-between text-[10px] font-bold">
                <div class="text-gray-500">TỔNG CẶP: <span id="totalCoin" class="text-white">0</span></div>
                <div class="text-gray-500">HOÀN THÀNH: <span id="doneCoin" class="text-green-500">0</span></div>
            </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-5">
            <div class="matrix-border p-5 col-span-3">
                <div class="flex flex-wrap gap-2 mb-4">
                    <button class="btn-range" onclick="setRange('1', this)">1 NGÀY</button>
                    <button class="btn-range" onclick="setRange('7', this)">7 NGÀY</button>
                    <button class="btn-range active" onclick="setRange('30', this)">30 NGÀY</button>
                    <button class="btn-range" onclick="setRange('90', this)">3 THÁNG</button>
                    <button class="btn-range" onclick="setRange('365', this)">1 NĂM</button>
                    <button class="btn-range" onclick="setRange('custom', this)">TÙY CHỌN THÁNG</button>
                </div>

                <div class="grid grid-cols-4 gap-4 items-end">
                    <div id="customTime" class="flex gap-2 opacity-30 pointer-events-none">
                        <div class="w-1/2 text-[10px] text-gray-500">THÁNG<select id="m" class="luffy-input w-full mt-1">\${[1,2,3,4,5,6,7,8,9,10,11,12].map(m=>\`<option value="\${m}">Tháng \${m}</option>\`).join('')}</select></div>
                        <div class="w-1/2 text-[10px] text-gray-500">NĂM<select id="y" class="luffy-input w-full mt-1"><option>2026</option><option>2025</option><option>2024</option></select></div>
                    </div>
                    <div><label class="text-[10px] text-gray-500 uppercase">Margin ($)</label><input id="mg" value="10" class="luffy-input w-full mt-1"></div>
                    <div><label class="text-[10px] text-gray-500 uppercase">DCA/TP %</label><div class="flex gap-1 mt-1"><input id="ss" value="1.2" class="luffy-input w-1/2 text-center"><input id="tp" value="1.0" class="luffy-input w-1/2 text-center"></div></div>
                    <button onclick="run()" id="btnRun" class="luffy-main-btn py-3 rounded uppercase text-[13px]">Bắt đầu phân tích</button>
                </div>
            </div>
            <div class="matrix-border p-5 text-center flex flex-col justify-center border-green-500/20">
                <div class="text-gray-500 text-[10px] font-bold uppercase mb-2 tracking-widest">Lợi nhuận ước tính</div>
                <div id="totalPnl" class="text-4xl font-black text-green-400 drop-shadow-[0_0_10px_rgba(74,222,128,0.3)]">0.00$</div>
            </div>
        </div>

        <div class="matrix-border overflow-hidden">
            <table class="w-full text-left">
                <thead class="bg-black text-gray-500 uppercase text-[10px]"><tr>
                    <th class="p-4">Cặp Coin</th>
                    <th class="text-center">Số vòng thắng</th>
                    <th class="text-right pr-8">Lợi nhuận ($)</th>
                </tr></thead>
                <tbody id="tbody" class="divide-y divide-gray-800"></tbody>
            </table>
        </div>

        <script>
            let currentRange = '30';
            function setRange(val, btn) {
                currentRange = val;
                document.querySelectorAll('.btn-range').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById('customTime').style.opacity = val === 'custom' ? '1' : '0.3';
                document.getElementById('customTime').style.pointerEvents = val === 'custom' ? 'auto' : 'none';
            }

            async function refresh() {
                const r = await fetch('/api/status');
                const d = await r.json();
                document.getElementById('coinName').innerText = d.currentSymbol;
                document.getElementById('coinDetail').innerText = d.downloadedCount.toLocaleString() + ' / ' + d.totalNeeded.toLocaleString() + ' nến';
                document.getElementById('coinProgress').style.width = (d.downloadedCount / d.totalNeeded * 100) + '%';
                document.getElementById('totalCoin').innerText = d.totalSymbols;
                document.getElementById('doneCoin').innerText = d.completedSymbols;
            }
            setInterval(refresh, 1000);

            async function run() {
                const btn = document.getElementById('btnRun');
                btn.innerText = "ĐANG TÍNH TOÁN...";
                const res = await fetch('/api/analyze', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        range: currentRange, month: document.getElementById('m').value, year: document.getElementById('y').value,
                        marginValue: Number(document.getElementById('mg').value), maxGrids: 5,
                        stepSize: Number(document.getElementById('ss').value), tpPercent: Number(document.getElementById('tp').value)
                    })
                });
                const d = await res.json();
                document.getElementById('totalPnl').innerText = d.totalPnl.toFixed(2) + '$';
                document.getElementById('tbody').innerHTML = d.results.sort((a,b)=>b.pnl-a.pnl).map(x => \`
                    <tr class="hover:bg-white/5 transition-colors">
                        <td class="p-4 font-black text-yellow-500">\${x.symbol}</td>
                        <td class="text-center text-blue-400 font-bold">\${x.trades}</td>
                        <td class="text-right font-black text-green-400 pr-8">\${x.pnl.toFixed(2)}$</td>
                    </tr>
                \`).join('');
                btn.innerText = "Bắt đầu phân tích";
            }
        </script>
    </body></html>`);
});

initSymbols().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server: http://localhost:${PORT}/gui`);
        startCrawler();
    });
});
