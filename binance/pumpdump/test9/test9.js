const PORT = 9063;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 
let activeConfigs = []; // Danh sách các cấu hình đang "Chạy" (Quét lệnh mới)

// Logic xử lý hàng đợi 350ms như bản gốc của ông
let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    const task = actionQueue.shift();
    task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

function fPrice(p) {
    if (!p || p === 0) return "0.0000";
    let s = p.toFixed(20);
    let match = s.match(/^-?\d+\.0*[1-9]/);
    if (!match) return p.toFixed(4);
    let index = match[0].length;
    return parseFloat(p).toFixed(index - match[0].indexOf('.') + 3);
}

if (fs.existsSync(LEVERAGE_FILE)) { try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){} }
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(HISTORY_FILE));
        savedData.forEach(h => historyMap.set(`${h.symbol}_${h.startTime}_${h.confTag}`, h));
    } catch (e) {}
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => {
            const s = t.s, p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 300) coinData[s].prices.shift();
            
            const c1 = calculateChange(coinData[s].prices, 1), c5 = calculateChange(coinData[s].prices, 5), c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };
            
            // LOGIC CHỐT LỆNH & DCA (Luôn chạy cho dù có STOP cấu hình hay không)
            const pends = Array.from(historyMap.values()).filter(h => h.symbol === s && h.status === 'PENDING');
            pends.forEach(pending => {
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
                const currentRoi = (pending.type === 'LONG' ? diffAvg : -diffAvg) * (pending.maxLev || 20);
                if (!pending.maxNegativeRoi || currentRoi < pending.maxNegativeRoi) pending.maxNegativeRoi = currentRoi;

                const win = pending.type === 'LONG' ? diffAvg >= pending.tpTarget : diffAvg <= -pending.tpTarget; 
                if (win) {
                    pending.status = 'WIN'; pending.finalPrice = p; pending.endTime = now;
                    pending.pnlPercent = (pending.type === 'LONG' ? diffAvg : -diffAvg);
                    lastTradeClosed[`${s}_${pending.confTag}`] = now; 
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(Array.from(historyMap.values()))); 
                    return;
                }
                
                const totalDiff = ((p - pending.snapPrice) / pending.snapPrice) * 100;
                const triggerDCA = pending.type === 'LONG' ? totalDiff <= -((pending.dcaCount + 1) * pending.slTarget) : totalDiff >= ((pending.dcaCount + 1) * pending.slTarget);
                if (triggerDCA && !actionQueue.find(q => q.id === `${s}_${pending.confTag}`)) {
                    actionQueue.push({ id: `${s}_${pending.confTag}`, action: () => {
                        const newAvg = ((pending.avgPrice * (pending.dcaCount + 1)) + p) / (pending.dcaCount + 2);
                        pending.dcaHistory.push({ t: Date.now(), p: p, avg: newAvg });
                        pending.avgPrice = newAvg; pending.dcaCount++;
                    }});
                }
            });

            // LOGIC VÀO LỆNH MỚI (Chỉ chạy cho cấu hình trong activeConfigs)
            activeConfigs.forEach(conf => {
                const tag = `${conf.vol}%-${conf.mode}`;
                const maxVol = Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15));
                const isBusy = Array.from(historyMap.values()).some(h => h.status === 'PENDING' && h.confTag === tag);
                
                if (!isBusy && maxVol >= conf.vol && !(lastTradeClosed[`${s}_${tag}`] && (now - lastTradeClosed[`${s}_${tag}`] < COOLDOWN_MINUTES * 60000))) {
                    if (!actionQueue.find(q => q.id === `${s}_${tag}`)) {
                        actionQueue.push({ id: `${s}_${tag}`, action: () => {
                            let type = conf.mode === 'REVERSE' ? (c1 >= 0 ? 'SHORT' : 'LONG') : (c1 >= 0 ? 'LONG' : 'SHORT');
                            historyMap.set(`${s}_${now}_${tag}`, { 
                                symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, status: 'PENDING', 
                                maxLev: symbolMaxLeverage[s] || 20, tpTarget: conf.tp, slTarget: conf.sl, dcaCount: 0, 
                                maxNegativeRoi: 0, dcaHistory: [{t: now, p, avg: p}], confTag: tag 
                            });
                        }});
                    }
                }
            });
        });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

app.get('/api/config', (req, res) => { activeConfigs = JSON.parse(req.query.activeConfigs || '[]'); res.sendStatus(200); });
app.get('/api/data', (req, res) => {
    const all = Array.from(historyMap.values());
    res.json({ 
        allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])), 
        live: Object.entries(coinData).filter(([_, v]) => v.live).map(([s, v]) => ({ symbol: s, ...v.live })).sort((a,b) => Math.abs(b.c1) - Math.abs(a.c1)),
        pending: all.filter(h => h.status === 'PENDING'), 
        history: all.filter(h => h.status !== 'PENDING') 
    });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Luffy Pro Multi-Engine</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: sans-serif; font-size: 11px; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:rgba(0,0,0,0.95); align-items:center; justify-content:center; }
        .config-btn { border: 1px solid #30363d; padding: 6px; border-radius: 4px; cursor: pointer; text-align: center; font-weight: bold; }
        .config-btn.active { border-color: #fcd535; background: rgba(252, 213, 53, 0.1); color: #fcd535; }
        th { color: #848e9c; text-transform: uppercase; font-size: 9px; padding: 8px; border-bottom: 1px solid #2b3139; }
        td { padding: 8px; border-bottom: 1px solid #2b3139; }
    </style></head><body>

    <div id="setup" class="p-4 bg-card m-2 rounded border border-yellow-500/20">
        <div class="grid grid-cols-4 gap-2 mb-4">
            <input id="balanceInp" type="number" value="1000" class="bg-[#0b0e11] border border-zinc-700 p-2 rounded text-yellow-500 font-bold">
            <input id="marginInp" type="text" value="10%" class="bg-[#0b0e11] border border-zinc-700 p-2 rounded text-yellow-500 font-bold">
            <input id="tpInp" type="number" step="0.1" value="0.5" class="bg-[#0b0e11] border border-zinc-700 p-2 rounded">
            <input id="slInp" type="number" step="0.1" value="10.0" class="bg-[#0b0e11] border border-zinc-700 p-2 rounded">
        </div>
        <div id="gridBtn" class="grid grid-cols-4 md:grid-cols-8 gap-1 mb-4"></div>
        <button onclick="start()" class="w-full bg-[#fcd535] text-black py-3 rounded font-black uppercase italic shadow-lg shadow-yellow-500/20">KHỞI CHẠY HỆ THỐNG LUFFY</button>
    </div>

    <div id="activeHeader" class="hidden p-4 flex justify-between items-center border-b border-zinc-800">
        <div class="text-xl font-black italic">BINANCE <span class="text-[#fcd535]">LUFFY MULTI</span></div>
        <button onclick="stop()" class="border border-red-500 text-red-500 px-4 py-1 rounded font-bold text-xs uppercase hover:bg-red-500 hover:text-white">Dừng quét (Sửa cấu hình)</button>
    </div>

    <div id="mainPopup" class="modal"><div class="bg-card p-6 rounded w-11/12 max-h-[90vh] overflow-y-auto relative border border-yellow-500/50"><button onclick="closePopup()" class="absolute top-2 right-4 text-3xl">&times;</button><div id="popupTitle" class="text-yellow-500 font-black mb-6 uppercase text-xl italic border-b border-zinc-700 pb-2"></div><div id="popupBody"></div></div></div>

    <div class="p-2 overflow-x-auto"><table class="w-full text-left bg-card rounded">
        <thead class="bg-[#2b3139]">
            <tr><th>Cấu hình</th><th>Balance Thực</th><th>PnL Win ($)</th><th>PnL Treo ($)</th><th>Vị thế (Mở)</th></tr>
        </thead>
        <tbody id="boardBody"></tbody>
    </table></div>

    <script>
    let state = JSON.parse(localStorage.getItem('luffy_multi_state') || '{}'), lastRaw = null;
    const modes = ['LONG', 'SHORT', 'FOLLOW', 'REVERSE'];
    const grid = document.getElementById('gridBtn');
    
    function fPrice(p) { return p ? parseFloat(p).toFixed(4) : "0.0000"; }

    for(let v=1; v<=10; v++) { modes.forEach(m => {
        const d = document.createElement('div'); d.className = 'config-btn'; d.innerText = v+'%-'+m;
        d.onclick = () => d.classList.toggle('active'); grid.appendChild(d);
    });}

    function start() {
        const configs = [];
        document.querySelectorAll('.config-btn.active').forEach(el => {
            const [v, m] = el.innerText.split('%-');
            configs.push({ vol: parseFloat(v), mode: m, tp: parseFloat(document.getElementById('tpInp').value), sl: parseFloat(document.getElementById('slInp').value) });
        });
        localStorage.setItem('luffy_multi_state', JSON.stringify({ running: true, initialBal: parseFloat(document.getElementById('balanceInp').value), margin: document.getElementById('marginInp').value, configs }));
        fetch('/api/config?activeConfigs=' + encodeURIComponent(JSON.stringify(configs))).then(() => location.reload());
    }

    function stop() { if(confirm('Dừng quét lệnh mới? (Các lệnh đang chạy vẫn sẽ tiếp tục)')) { let s = JSON.parse(localStorage.getItem('luffy_multi_state')); s.running = false; localStorage.setItem('luffy_multi_state', JSON.stringify(s)); location.reload(); } }
    function closePopup() { document.getElementById('mainPopup').style.display = 'none'; }

    function openPopup(tag) {
        const conf = state.configs.find(c => (c.vol+'%-'+c.mode) === tag);
        document.getElementById('mainPopup').style.display = 'flex';
        document.getElementById('popupTitle').innerText = tag;
        
        const pends = lastRaw.pending.filter(h => h.confTag === tag);
        const hists = lastRaw.history.filter(h => h.confTag === tag).sort((a,b)=>b.endTime-a.endTime).slice(0,50);
        
        let html = \`
            <div class="grid grid-cols-4 gap-4 mb-8 bg-[#0b0e11] p-4 rounded border border-zinc-800">
                <div><div class="text-[9px] text-gray-500">VOL ENTRY</div><div class="text-white font-bold">\${conf.vol}%</div></div>
                <div><div class="text-[9px] text-gray-500">CHẾ ĐỘ</div><div class="text-yellow-500 font-bold">\${conf.mode}</div></div>
                <div><div class="text-[9px] text-gray-500">TP TARGET</div><div class="text-green-500 font-bold">\${conf.tp}%</div></div>
                <div><div class="text-[9px] text-gray-500">DCA STEP</div><div class="text-red-500 font-bold">\${conf.sl}%</div></div>
            </div>
            
            <div class="mb-8">
                <div class="text-white font-black italic uppercase mb-3 flex items-center"><span class="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></span> Vị thế đang mở</div>
                <table class="w-full text-[10px]">
                    <thead><tr><th>Pair</th><th>DCA</th><th>Margin</th><th>Target</th><th>Entry/Live</th><th>Avg Price</th><th class="text-right">PnL (ROI%)</th></tr></thead>
                    <tbody>\${pends.map(p => {
                        let lp = lastRaw.allPrices[p.symbol] || p.avgPrice;
                        let mVal = state.margin.includes('%') ? (state.initialBal * parseFloat(state.margin)/100) : parseFloat(state.margin);
                        let totalM = mVal * (p.dcaCount + 1);
                        let roi = (p.type === 'LONG' ? (lp-p.avgPrice)/p.avgPrice : (p.avgPrice-lp)/p.avgPrice) * 100 * 20;
                        let pnl = totalM * roi / 100;
                        return \`<tr>
                            <td class="font-bold text-white">\${p.symbol} <span class="text-[8px] px-1 \${p.type==='LONG'?'bg-green-600':'bg-red-600'} rounded">\${p.type}</span></td>
                            <td class="text-yellow-500 font-bold">\${p.dcaCount}</td>
                            <td>\${totalM.toFixed(1)}</td>
                            <td class="text-yellow-500/70">T: \${fPrice(p.type==='LONG'?p.avgPrice*(1+p.tpTarget/100):p.avgPrice*(1-p.tpTarget/100))}</td>
                            <td>\${fPrice(p.snapPrice)}<br><b class="text-green-400">\${fPrice(lp)}</b></td>
                            <td class="text-yellow-500 font-bold">\${fPrice(p.avgPrice)}</td>
                            <td class="text-right font-bold \${pnl>=0?'up':'down'}">\${pnl.toFixed(2)}<br>\${roi.toFixed(1)}%</td>
                        </tr>\`;
                    }).join('') || '<tr><td colspan="7" class="text-center py-4 text-gray-600 italic">Đang quét tín hiệu...</td></tr>'}</tbody>
                </table>
            </div>

            <div>
                <div class="text-white font-black italic uppercase mb-3">Nhật ký giao dịch chi tiết</div>
                <table class="w-full text-[9px]">
                    <thead><tr><th>Pair/Vol</th><th>DCA</th><th>Margin</th><th>Entry/Out</th><th>Avg Price</th><th>MaxDD</th><th>PnL Net</th></tr></thead>
                    <tbody>\${hists.map(h => \`
                        <tr>
                            <td><b class="text-white">\${h.symbol}</b> <br> <span class="\${h.type==='LONG'?'up':'down'} font-bold">\${h.type}</span></td>
                            <td class="text-yellow-500 font-bold">\${h.dcaCount}</td>
                            <td>\${((state.margin.includes('%')?state.initialBal*parseFloat(state.margin)/100:parseFloat(state.margin))*(h.dcaCount+1)).toFixed(1)}</td>
                            <td>\${fPrice(h.snapPrice)}<br><b class="text-white">\${fPrice(h.finalPrice)}</b></td>
                            <td class="text-yellow-500 font-bold">\${fPrice(h.avgPrice)}</td>
                            <td class="down font-bold">\${h.maxNegativeRoi.toFixed(1)}%</td>
                            <td class="up font-bold">+\${h.pnlPercent.toFixed(2)}%</td>
                        </tr>
                    \`).join('') || '<tr><td colspan="7" class="text-center py-4 text-gray-600 italic">Chưa có dữ liệu</td></tr>'}</tbody>
                </table>
            </div>
        \`;
        document.getElementById('popupBody').innerHTML = html;
    }

    if(state.running) {
        document.getElementById('setup').classList.add('hidden');
        document.getElementById('activeHeader').classList.remove('hidden');
        state.configs.forEach(conf => {
            const tag = conf.vol + '%-' + conf.mode;
            const tr = document.createElement('tr'); tr.onclick = () => openPopup(tag); tr.className = 'cursor-pointer hover:bg-zinc-800 transition-all';
            tr.innerHTML = \`<td class="font-black text-yellow-500 italic">\${tag}</td><td id="bal-\${tag}" class="font-bold text-white">0.00</td><td id="winp-\${tag}" class="up font-bold">0.00</td><td id="livep-\${tag}" class="font-bold">0.00</td><td id="count-\${tag}" class="font-black text-white text-lg">0</td>\`;
            document.getElementById('boardBody').appendChild(tr);
        });
    }

    async function update() {
        try {
            const res = await fetch('/api/data'); lastRaw = await res.json();
            state.configs.forEach(conf => {
                const tag = conf.vol + '%-' + conf.mode;
                let bal = state.initialBal, winSum = 0, liveSum = 0;
                let hist = lastRaw.history.filter(h => h.confTag === tag);
                hist.forEach(h => {
                    let m = state.margin.includes('%') ? (bal * parseFloat(state.margin) / 100) : parseFloat(state.margin);
                    winSum += (m * (h.dcaCount + 1) * 20 * (h.pnlPercent/100));
                    bal += (m * (h.dcaCount + 1) * 20 * (h.pnlPercent/100));
                });
                const pends = lastRaw.pending.filter(h => h.confTag === tag);
                pends.forEach(p => {
                    let lp = lastRaw.allPrices[p.symbol] || p.avgPrice;
                    let m = state.margin.includes('%') ? (bal * parseFloat(state.margin) / 100) : parseFloat(state.margin);
                    liveSum += (m * (p.dcaCount + 1)) * ((p.type === 'LONG' ? (lp-p.avgPrice)/p.avgPrice : (p.avgPrice-lp)/p.avgPrice) * 100 * 20) / 100;
                });
                if(document.getElementById('bal-'+tag)) {
                    document.getElementById('bal-'+tag).innerText = (bal + liveSum).toFixed(2);
                    document.getElementById('winp-'+tag).innerText = winSum.toFixed(2);
                    document.getElementById('livep-'+tag).innerText = liveSum.toFixed(2);
                    document.getElementById('livep-'+tag).className = liveSum >= 0 ? 'up font-bold' : 'down font-bold';
                    document.getElementById('count-'+tag).innerText = pends.length;
                }
            });
        } catch(e){}
    }
    setInterval(update, 1000);
    if(state.running) fetch('/api/config?activeConfigs=' + encodeURIComponent(JSON.stringify(state.configs)));
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Expert Board: http://localhost:${PORT}/gui`); });
