const PORT = 9063;
const HISTORY_FILE = './history_db.json';
const LEVERAGE_FILE = './leverage_cache.json';
const COOLDOWN_MINUTES = 15; 

import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
let coinData = {}; 
let historyMap = new Map(); 
let symbolMaxLeverage = {}; 
let lastTradeClosed = {}; 
let activeConfigs = []; 

let actionQueue = [];
async function processQueue() {
    if (actionQueue.length === 0) return;
    const task = actionQueue.shift();
    task.action();
    setTimeout(processQueue, 350); 
}
setInterval(processQueue, 50);

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
            
            // Xử lý lệnh PENDING
            const pends = Array.from(historyMap.values()).filter(h => h.symbol === s && h.status === 'PENDING');
            pends.forEach(pending => {
                const diffAvg = ((p - pending.avgPrice) / pending.avgPrice) * 100;
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
                        pending.avgPrice = ((pending.avgPrice * (pending.dcaCount + 1)) + p) / (pending.dcaCount + 2);
                        pending.dcaCount++;
                    }});
                }
            });

            // Quét Entry
            activeConfigs.forEach(conf => {
                const tag = `${conf.vol}%-${conf.mode}`;
                const maxVol = Math.max(Math.abs(c1), Math.abs(c5), Math.abs(c15));
                const isBusy = Array.from(historyMap.values()).some(h => h.status === 'PENDING' && h.confTag === tag);
                
                if (!isBusy && maxVol >= conf.vol && !(lastTradeClosed[`${s}_${tag}`] && (now - lastTradeClosed[`${s}_${tag}`] < COOLDOWN_MINUTES * 60000))) {
                    if (!actionQueue.find(q => q.id === `${s}_${tag}`)) {
                        actionQueue.push({ id: `${s}_${tag}`, action: () => {
                            let type = conf.mode;
                            if(conf.mode === 'FOLLOW') type = c1 >= 0 ? 'LONG' : 'SHORT';
                            if(conf.mode === 'REVERSE') type = c1 >= 0 ? 'SHORT' : 'LONG';
                            historyMap.set(`${s}_${now}_${tag}`, { 
                                symbol: s, startTime: now, snapPrice: p, avgPrice: p, type, status: 'PENDING', 
                                maxLev: symbolMaxLeverage[s] || 20, tpTarget: conf.tp, slTarget: conf.sl, dcaCount: 0, confTag: tag 
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
    res.json({ allPrices: Object.fromEntries(Object.entries(coinData).map(([s, v]) => [s, v.live.currentPrice])), pending: all.filter(h => h.status === 'PENDING'), history: all.filter(h => h.status !== 'PENDING') });
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Luffy Ultimate Multi-Bot</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: 'IBM Plex Sans', sans-serif; font-size: 11px; }
        .bg-card { background: #1e2329; border: 1px solid #30363d; }
        .up { color: #0ecb81; } .down { color: #f6465d; }
        .config-btn { border: 1px solid #30363d; padding: 4px; border-radius: 4px; cursor: pointer; text-align: center; font-weight: bold; }
        .config-btn.active { border-color: #fcd535; background: rgba(252, 213, 53, 0.1); color: #fcd535; }
        .modal { display:none; position:fixed; z-index:1000; left:0; top:0; width:100%; height:100%; background:rgba(0,0,0,0.95); align-items:center; justify-content:center; }
        .table-mini th { font-size: 9px; color: #848e9c; text-transform: uppercase; padding: 4px; }
        .table-mini td { padding: 4px; border-bottom: 1px solid #2b3139; }
    </style></head><body>

    <div id="setup" class="p-4 bg-card m-2 rounded border border-yellow-900/30">
        <div class="grid grid-cols-4 gap-2 mb-4">
            <div><label class="text-[9px] text-gray-500 uppercase">Vốn/Bản</label><input id="balanceInp" type="number" value="1000" class="w-full bg-[#0b0e11] border border-zinc-700 p-2 rounded text-yellow-500 font-bold"></div>
            <div><label class="text-[9px] text-gray-500 uppercase">Margin</label><input id="marginInp" type="text" value="10%" class="w-full bg-[#0b0e11] border border-zinc-700 p-2 rounded text-yellow-500 font-bold"></div>
            <div><label class="text-[9px] text-gray-500 uppercase">TP (%)</label><input id="tpInp" type="number" step="0.1" value="0.5" class="w-full bg-[#0b0e11] border border-zinc-700 p-2 rounded"></div>
            <div><label class="text-[9px] text-gray-500 uppercase">DCA (%)</label><input id="slInp" type="number" step="0.1" value="10.0" class="w-full bg-[#0b0e11] border border-zinc-700 p-2 rounded"></div>
        </div>
        <div id="gridBtn" class="grid grid-cols-4 md:grid-cols-8 gap-1 mb-4"></div>
        <div class="flex gap-2">
            <button onclick="selectAll(true)" class="flex-1 bg-zinc-800 text-gray-300 py-2 rounded text-[10px] font-bold">CHỌN TẤT CẢ</button>
            <button onclick="start()" class="flex-[3] bg-[#fcd535] text-black py-2 rounded font-black uppercase italic shadow-lg shadow-yellow-500/20">KHỞI CHẠY HỆ THỐNG LUFFY</button>
        </div>
    </div>

    <div id="mainPopup" class="modal"><div class="bg-card p-6 rounded-lg w-11/12 max-h-[90vh] overflow-y-auto relative border border-yellow-500/50"><button onclick="closePopup()" class="absolute top-2 right-4 text-3xl text-gray-500 hover:text-white">&times;</button><div id="popupTitle" class="text-yellow-500 font-black mb-6 uppercase text-xl italic tracking-widest border-b border-zinc-700 pb-2"></div><div id="popupBody"></div></div></div>

    <div id="monitor" class="p-2">
        <div class="bg-[#1e2329] rounded overflow-hidden border border-zinc-800">
            <table class="w-full text-left">
                <thead class="bg-[#2b3139] text-gray-400 uppercase text-[9px] tracking-tighter">
                    <tr>
                        <th class="p-3 w-20">Cấu hình</th>
                        <th>Balance (Real)</th>
                        <th>PnL Win</th>
                        <th>PnL Treo</th>
                        <th>Lệnh (W/O)</th>
                        <th class="w-24">Performance</th>
                    </tr>
                </thead>
                <tbody id="boardBody"></tbody>
            </table>
        </div>
    </div>

    <script>
    let charts = {}, state = JSON.parse(localStorage.getItem('luffy_multi_state') || '{}'), lastRaw = null;
    const modes = ['LONG', 'SHORT', 'FOLLOW', 'REVERSE'];
    const grid = document.getElementById('gridBtn');
    
    for(let v=1; v<=10; v++) { modes.forEach(m => {
        const d = document.createElement('div'); d.className = 'config-btn'; d.innerText = v+'%-'+m;
        d.onclick = () => d.classList.toggle('active'); grid.appendChild(d);
    });}

    function selectAll(v) { document.querySelectorAll('.config-btn').forEach(el => v ? el.classList.add('active') : el.classList.remove('active')); }

    function start() {
        const configs = [];
        document.querySelectorAll('.config-btn.active').forEach(el => {
            const [v, m] = el.innerText.split('%-');
            configs.push({ vol: parseFloat(v), mode: m, tp: parseFloat(document.getElementById('tpInp').value), sl: parseFloat(document.getElementById('slInp').value) });
        });
        if(!configs.length) return alert('Dmm chọn cấu hình đã!');
        localStorage.setItem('luffy_multi_state', JSON.stringify({ running: true, initialBal: parseFloat(document.getElementById('balanceInp').value), margin: document.getElementById('marginInp').value, configs }));
        fetch('/api/config?activeConfigs=' + encodeURIComponent(JSON.stringify(configs))).then(() => location.reload());
    }

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
                <div class="flex justify-between items-center mb-3 border-l-4 border-yellow-500 pl-2">
                    <div class="text-white font-black italic uppercase">Vị thế đang mở (\${pends.length})</div>
                </div>
                <table class="w-full table-mini">
                    <thead><tr><th>Cặp Coin</th><th>Lệnh</th><th>Giá Entry</th><th>Giá Hiện Tại</th><th>ROI %</th><th>DCA</th><th>PnL ($)</th></tr></thead>
                    <tbody>\${pends.map(p => {
                        let lp = lastRaw.allPrices[p.symbol] || p.avgPrice;
                        let mNum = parseFloat(state.margin);
                        let roi = (p.type === 'LONG' ? (lp-p.avgPrice)/p.avgPrice : (p.avgPrice-lp)/p.avgPrice) * 100 * 20;
                        let pnl = (state.initialBal * mNum / 100) * (p.dcaCount+1) * roi / 100;
                        return \`<tr>
                            <td class="font-bold text-white">\${p.symbol}</td>
                            <td class="\${p.type==='LONG'?'up':'down'} font-bold">\${p.type}</td>
                            <td>\${p.avgPrice.toFixed(5)}</td>
                            <td>\${lp.toFixed(5)}</td>
                            <td class="\${roi>=0?'up':'down'} font-black">\${roi.toFixed(2)}%</td>
                            <td class="text-center">\${p.dcaCount}</td>
                            <td class="\${pnl>=0?'up':'down'} font-bold">\${pnl.toFixed(2)}</td>
                        </tr>\`;
                    }).join('') || '<tr><td colspan="7" class="text-center py-4 text-gray-600 italic">Đang quét tín hiệu...</td></tr>'}</tbody>
                </table>
            </div>

            <div>
                <div class="flex justify-between items-center mb-3 border-l-4 border-green-500 pl-2">
                    <div class="text-white font-black italic uppercase">Nhật ký chốt lời (50 lệnh gần nhất)</div>
                </div>
                <table class="w-full table-mini">
                    <thead><tr><th>Cặp Coin</th><th>Thời gian</th><th>Giá chốt</th><th>Kết quả</th><th>PnL Net (%)</th></tr></thead>
                    <tbody>\${hists.map(h => \`
                        <tr>
                            <td>\${h.symbol}</td>
                            <td class="text-gray-500">\${new Date(h.endTime).toLocaleString()}</td>
                            <td>\${h.finalPrice.toFixed(5)}</td>
                            <td class="up font-bold">WIN</td>
                            <td class="up font-bold">+\${h.pnlPercent.toFixed(2)}%</td>
                        </tr>
                    \`).join('') || '<tr><td colspan="5" class="text-center py-4 text-gray-600 italic">Chưa có dữ liệu giao dịch</td></tr>'}</tbody>
                </table>
            </div>
        \`;
        document.getElementById('popupBody').innerHTML = html;
    }

    if(state.running) {
        document.getElementById('setup').classList.add('hidden');
        state.configs.forEach(conf => {
            const tag = conf.vol + '%-' + conf.mode;
            const tr = document.createElement('tr'); tr.onclick = () => openPopup(tag); tr.className = 'cursor-pointer hover:bg-[#2b3139] transition-all border-b border-zinc-800/50';
            tr.innerHTML = \`
                <td class="p-3 font-black text-yellow-500 italic">\${tag}</td>
                <td id="bal-\${tag}" class="font-bold text-white">0.00</td>
                <td id="winp-\${tag}" class="up font-bold">0.00</td>
                <td id="livep-\${tag}" class="font-bold">0.00</td>
                <td id="count-\${tag}" class="text-gray-400">0 / 0</td>
                <td class="p-1"><canvas id="chart-\${tag}" height="35"></canvas></td>
            \`;
            document.getElementById('boardBody').appendChild(tr);
            charts[tag] = new Chart(document.getElementById('chart-'+tag).getContext('2d'), { type: 'line', data: { labels: Array(30).fill(''), datasets: [{ data: [], borderColor: '#fcd535', borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: 'rgba(252, 213, 53, 0.05)' }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } }, animation: false } });
        });
    }

    async function update() {
        if(!state.running) return;
        try {
            const res = await fetch('/api/data'); lastRaw = await res.json();
            const mNum = parseFloat(state.margin);

            state.configs.forEach(conf => {
                const tag = conf.vol + '%-' + conf.mode;
                let bal = state.initialBal, winSum = 0, winCount = 0, liveSum = 0;
                let hist = lastRaw.history.filter(h => h.confTag === tag).sort((a,b)=>a.endTime-b.endTime);
                let cPoints = [];

                hist.forEach(h => {
                    let m = state.margin.includes('%') ? (bal * mNum / 100) : mNum;
                    let net = (m * (h.dcaCount + 1) * 20 * (h.pnlPercent/100));
                    bal += net; winSum += net; winCount++;
                    cPoints.push(bal);
                });

                const pends = lastRaw.pending.filter(h => h.confTag === tag);
                pends.forEach(p => {
                    let lp = lastRaw.allPrices[p.symbol] || p.avgPrice;
                    let m = state.margin.includes('%') ? (bal * mNum / 100) : mNum;
                    liveSum += (m * (p.dcaCount + 1)) * ((p.type === 'LONG' ? (lp-p.avgPrice)/p.avgPrice : (p.avgPrice-lp)/p.avgPrice) * 100 * 20) / 100;
                });

                document.getElementById('bal-'+tag).innerText = (bal + liveSum).toFixed(2);
                document.getElementById('winp-'+tag).innerText = '+' + winSum.toFixed(2);
                document.getElementById('livep-'+tag).innerText = liveSum.toFixed(2);
                document.getElementById('livep-'+tag).className = liveSum >= 0 ? 'up font-bold' : 'down font-bold';
                document.getElementById('count-'+tag).innerHTML = \`<span class="up font-bold">\${winCount}</span> / <span class="text-yellow-500 font-bold">\${pends.length}</span>\`;
                
                if(charts[tag]) {
                    charts[tag].data.datasets[0].data = cPoints.slice(-30);
                    charts[tag].update();
                }
            });
        } catch(e){}
    }
    if(state.running) { fetch('/api/config?activeConfigs=' + encodeURIComponent(JSON.stringify(state.configs))); setInterval(update, 1200); }
    function stop() { if(confirm('Dừng toàn bộ hệ thống?')) { localStorage.removeItem('luffy_multi_state'); location.reload(); } }
    </script></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Expert Board: http://localhost:${PORT}/gui`); });
