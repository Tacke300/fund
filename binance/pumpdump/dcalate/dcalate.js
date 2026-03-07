import express from 'express';
import fs from 'fs';
import https from 'https';
import path from 'path';

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = 8889;
const DATA_DIR = './candle_data';
const LEVERAGE_FILE = './leverage_cache.json';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

let allSymbols = [];
let symbolMaxLeverage = {}; 
let logs = []; // Lưu log tạm thời để đẩy lên giao diện
let crawlStatus = { isCrawling: false, totalDownloaded: 0, totalNeeded: 0, currentSymbol: 'Idle' };

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    logs.push(`[${time}] ${msg}`);
    if (logs.length > 50) logs.shift();
    console.log(`[${time}] ${msg}`);
}

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
                        brackets.forEach(item => { symbolMaxLeverage[item.symbol] = item.brackets[0].initialLeverage; });
                        fs.writeFileSync(LEVERAGE_FILE, JSON.stringify(symbolMaxLeverage));
                        addLog("Đã cập nhật bộ nhớ đệm Leverage từ Binance.");
                    }
                } catch (e) {} resolve();
            });
        }).on('error', () => resolve());
    });
}

async function startCrawler() {
    if (crawlStatus.isCrawling) return;
    crawlStatus.isCrawling = true;
    const stopTs = Date.now() - (2 * 365 * 24 * 60 * 60 * 1000);
    crawlStatus.totalNeeded = allSymbols.length * 1051200; 

    for (const s of allSymbols) {
        crawlStatus.currentSymbol = s.symbol;
        const filePath = path.join(DATA_DIR, `${s.symbol}.json`);
        let existing = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath)) : [];
        let lastTs = existing.length > 0 ? existing[0][0] - 1 : Date.now();

        if (lastTs > stopTs) {
            addLog(`Đang tải dữ liệu: ${s.symbol}...`);
            const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${s.symbol}&interval=1m&endTime=${lastTs}&limit=1000`;
            const klines = await new Promise(r => {
                https.get(url, res => {
                    let d = ''; res.on('data', c => d += c); res.on('end', () => { try { r(JSON.parse(d)); } catch(e){ r([]); } });
                }).on('error', () => r([]));
            });
            if (klines && klines.length > 0) {
                existing = [...klines, ...existing];
                crawlStatus.totalDownloaded += klines.length;
                fs.writeFileSync(filePath, JSON.stringify(existing));
            }
        }
        await new Promise(r => setTimeout(r, 10));
    }
    crawlStatus.isCrawling = false;
    addLog("Hoàn tất chu kỳ quét dữ liệu.");
}

app.post('/api/analyze', async (req, res) => {
    const { range, marginValue, maxGrids, stepSize, tpPercent, mode, userLeverage } = req.body;
    addLog(`Bắt đầu phân tích: ${range} ngày, Lev x${userLeverage}, DCA ${maxGrids}...`);
    
    const endTs = Date.now();
    const startTs = endTs - (parseInt(range) * 24 * 60 * 60 * 1000);
    let results = [];
    let historyAll = [];

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
                pos = { entry: close, grids: [{p: close, t: time}], tsOpen: time };
            } else {
                const avg = pos.entry;
                const pnlFactor = mode === 'LONG' ? (high - avg) / avg : (avg - low) / avg;
                
                if (pnlFactor * 100 >= tpPercent) {
                    const winPnl = (pos.grids.length * marginValue * finalLev) * (tpPercent / 100);
                    sClosedPnl += winPnl; sWinCount++;
                    sHistory.push({ pnl: winPnl, grids: pos.grids.length, time: new Date(time).toLocaleString('vi-VN'), entry: avg.toFixed(4) });
                    pos = null;
                } else if (pos.grids.length < maxGrids) {
                    const lastP = pos.grids[pos.grids.length-1].p;
                    const gap = mode === 'LONG' ? (lastP - low) / lastP : (high - lastP) / lastP;
                    if (gap * 100 >= stepSize) {
                        const newP = lastP * (mode === 'LONG' ? 1-(stepSize/100) : 1+(stepSize/100));
                        pos.grids.push({p: newP, t: time});
                        pos.entry = pos.grids.reduce((a,b)=>a+b.p, 0) / pos.grids.length;
                    }
                }
            }
        }

        if (sWinCount > 0) {
            results.push({ symbol: item.symbol, win: sWinCount, lev: finalLev, pnl: sClosedPnl, cap: capitalGoc, roi: (sClosedPnl/capitalGoc)*100, history: sHistory });
        }
        await new Promise(r => setImmediate(r));
    }
    addLog(`Phân tích xong ${results.length} cặp tiền.`);
    res.json(results.sort((a,b)=>b.pnl - a.pnl));
});

app.get('/api/status', (req, res) => res.json({ ...crawlStatus, logs }));

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Matrix 9888</title><script src="https://cdn.tailwindcss.com"></script>
    <style>
        body{background:#0b0e11;color:#eaecef;font-family:monospace;padding:15px; font-size: 13px;}
        .matrix-card { background: #181c20; border: 1px solid #2b3139; border-radius: 8px; }
        .luffy-input { background: #000; border: 1px solid #333; color: #f0b90b; padding: 8px; border-radius: 4px; }
        .log-box { background: #000; color: #00ff00; font-size: 10px; height: 120px; overflow-y: auto; padding: 10px; border: 1px solid #333; }
        .modal { display: none; position: fixed; z-index: 100; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); }
        .modal-content { background: #1e2329; margin: 2% auto; padding: 20px; width: 90%; max-height: 90vh; overflow-y: auto; border: 1px solid #f0b90b; }
    </style></head><body>
        
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div class="md:col-span-2 matrix-card p-4">
                <div class="flex items-center gap-4 mb-4">
                    <h1 class="text-2xl font-black text-yellow-500 italic">LUFFY <span class="text-white">ULTRA 9888</span></h1>
                    <div id="statusHead" class="text-[10px] text-gray-500 uppercase font-bold">Bot: Idle</div>
                </div>
                <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div class="flex flex-col"><label class="text-[9px]">RANGE</label><select id="range" class="luffy-input"><option value="1">1 DAY</option><option value="7">7 DAYS</option><option value="30" selected>30 DAYS</option></select></div>
                    <div class="flex flex-col"><label class="text-[9px]">USER LEV</label><select id="userLev" class="luffy-input"><option value="20">x20</option><option value="50">x50</option><option value="125" selected>x125</option></select></div>
                    <div class="flex flex-col"><label class="text-[9px]">MARGIN ($)</label><input id="mg" value="10" class="luffy-input"></div>
                    <div class="flex flex-col"><label class="text-[9px]">MAX DCA</label><input id="gr" value="5" class="luffy-input"></div>
                </div>
                <button onclick="run()" id="btnRun" class="w-full bg-yellow-500 text-black font-black py-3 mt-4 rounded hover:bg-yellow-400">PHÂN TÍCH HỆ THỐNG</button>
            </div>
            <div class="matrix-card p-4">
                <div class="text-yellow-500 font-bold mb-2 text-[10px]">SYSTEM LOGS</div>
                <div id="logConsole" class="log-box"></div>
            </div>
        </div>

        <div id="gridModal" class="modal" onclick="this.style.display='none'"><div class="modal-content" onclick="event.stopPropagation()">
            <div class="flex justify-between items-center mb-4"><h2 id="modalTitle" class="text-xl font-bold text-yellow-500"></h2><button onclick="document.getElementById('gridModal').style.display='none'" class="text-2xl">✕</button></div>
            <table class="w-full text-left text-xs">
                <thead class="bg-black text-gray-400"><tr><th class="p-2">THỜI GIAN</th><th class="p-2">GIÁ ENTRY TB</th><th class="p-2 text-center">LƯỚI DCA</th><th class="p-2 text-right">PNL</th></tr></thead>
                <tbody id="roundsList" class="divide-y divide-gray-800"></tbody>
            </table>
        </div></div>

        <div class="matrix-card overflow-hidden">
            <table class="w-full text-left text-[11px]">
                <thead class="bg-black text-gray-500 uppercase"><tr>
                    <th class="p-3 text-center">#</th><th>SYMBOL</th><th class="text-center">WIN ROUNDS</th><th class="text-center">MAX LEV</th><th class="text-right">VỐN GỐC (POS)</th><th class="text-right">PNL TỔNG</th><th class="text-center pr-4">ROI %</th>
                </tr></thead>
                <tbody id="activeBody" class="divide-y divide-gray-800/50"></tbody>
            </table>
        </div>

        <script>
            let fullData = [];
            async function run(){
                const btn = document.getElementById('btnRun'); btn.innerText = 'ĐANG TÍNH TOÁN...'; btn.disabled = true;
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
                fullData = await res.json();
                document.getElementById('activeBody').innerHTML = fullData.map((p, i) => \`
                    <tr class="hover:bg-white/5 cursor-pointer" onclick="showDetail(\${i})">
                        <td class="p-3 text-center text-gray-600">\${i+1}</td>
                        <td class="font-bold text-yellow-500 uppercase">\${p.symbol}</td>
                        <td class="text-center font-bold text-blue-400">\${p.win}</td>
                        <td class="text-center text-purple-400 font-bold">x\${p.lev}</td>
                        <td class="text-right text-gray-400">\${p.cap.toLocaleString()}$</td>
                        <td class="text-right font-bold text-green-400">\${p.pnl.toFixed(2)}$</td>
                        <td class="text-center pr-4 font-black text-emerald-400">\${p.roi.toFixed(2)}%</td>
                    </tr>\`).join('');
                btn.innerText = 'PHÂN TÍCH HỆ THỐNG'; btn.disabled = false;
            }

            function showDetail(index){
                const p = fullData[index];
                document.getElementById('modalTitle').innerText = p.symbol + " - BẢNG KÊ CHI TIẾT LỆNH";
                document.getElementById('roundsList').innerHTML = p.history.map(h => \`
                    <tr class="hover:bg-black/20">
                        <td class="p-2 text-gray-500">\${h.time}</td>
                        <td class="p-2 font-bold text-white">\${h.entry}</td>
                        <td class="p-2 text-center text-blue-400">\${h.grids}</td>
                        <td class="p-2 text-right text-green-400">+\${h.pnl.toFixed(2)}$</td>
                    </tr>\`).join('');
                document.getElementById('gridModal').style.display = 'block';
            }

            async function updateStatus(){
                try {
                    const res = await fetch('/api/status'); const d = await res.json();
                    document.getElementById('statusHead').innerText = "Bot: Loading " + d.currentSymbol;
                    document.getElementById('logConsole').innerHTML = d.logs.map(l => \`<div>\${l}</div>\`).reverse().join('');
                } catch(e){}
            }
            setInterval(updateStatus, 2000);
        </script>
    </body></html>`);
});

initSymbols().then(async () => {
    await fetchActualLeverage();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`LUFFY SYSTEM LIVE: http://localhost:9888/gui`);
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
