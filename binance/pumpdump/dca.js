import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';

const app = express();
app.use(express.json());

const STATE_FILE = './bot_state.json';
const PORT = 9009;

let botState = { 
    running: false, startTime: null, totalBalance: 1000, marginValue: 10, marginType: '$',
    maxGrids: 5, stepSize: 1.0, multiplier: 2.0, tpPercent: 1.0, mode: 'LONG', 
    closedPnl: 0, totalClosedGrids: 0 
};

let activePositions = {}; 
let marketPrices = {};
let allSymbols = [];
let symbolMaxLev = {};

if (fs.existsSync(STATE_FILE)) botState = JSON.parse(fs.readFileSync(STATE_FILE));
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(botState));

async function fetchSymbols() {
    return new Promise((resolve) => {
        https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const info = JSON.parse(data);
                    info.symbols.forEach(s => {
                        if (s.status === 'TRADING' && s.quoteAsset === 'USDT') {
                            allSymbols.push(s.symbol);
                            symbolMaxLev[s.symbol] = s.leverageBrackets?.[0]?.initialLeverage || 20;
                        }
                    });
                    console.log(`Đã tải ${allSymbols.length} coin.`);
                    resolve();
                } catch(e) { resolve(); }
            });
        });
    });
}

function startNewGrid(symbol, price) {
    if (!botState.running) return;
    const margin = botState.marginType === '$' ? botState.marginValue : (botState.totalBalance * botState.marginValue / 100);
    activePositions[symbol] = {
        symbol, side: botState.mode, maxLev: symbolMaxLev[symbol] || 20,
        grids: [{ price, qty: margin, time: Date.now() }],
        status: 'RUNNING'
    };
}

function processGridLogic(symbol, currentPrice) {
    const pos = activePositions[symbol];
    const totalMargin = pos.grids.reduce((sum, g) => sum + g.qty, 0);
    const avgPrice = pos.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
    const priceDiffPct = pos.side === 'LONG' ? (currentPrice - avgPrice) / avgPrice : (avgPrice - currentPrice) / avgPrice;

    if (priceDiffPct * 100 >= botState.tpPercent) {
        const pnl = totalMargin * (priceDiffPct * pos.maxLev);
        botState.closedPnl += pnl;
        botState.totalClosedGrids += pos.grids.length;
        delete activePositions[symbol];
        saveState();
        return;
    }

    if (pos.grids.length < botState.maxGrids) {
        const lastEntry = pos.grids[pos.grids.length - 1].price;
        const gap = pos.side === 'LONG' ? (lastEntry - currentPrice) / lastEntry : (currentPrice - lastEntry) / lastEntry;
        if (gap * 100 >= botState.stepSize) {
            pos.grids.push({ price: currentPrice, qty: pos.grids[pos.grids.length - 1].qty * botState.multiplier, time: Date.now() });
        }
    }
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        tickers.forEach(t => {
            marketPrices[t.s] = parseFloat(t.c);
            if (botState.running) {
                if (activePositions[t.s]) processGridLogic(t.s, marketPrices[t.s]);
                else if (allSymbols.includes(t.s)) startNewGrid(t.s, marketPrices[t.s]);
            }
        });
    });
}

app.get('/api/data', (req, res) => {
    const marginPerCoin = botState.marginType === '$' ? botState.marginValue : (botState.totalBalance * botState.marginValue / 100);
    const activeData = Object.values(activePositions).map(p => {
        const totalMargin = p.grids.reduce((sum, g) => sum + g.qty, 0);
        const avgPrice = p.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
        const roi = p.side === 'LONG' ? ((marketPrices[p.symbol] - avgPrice) / avgPrice) * 100 : ((avgPrice - marketPrices[p.symbol]) / avgPrice) * 100;
        return { ...p, avgPrice, totalMargin, currentGrid: p.grids.length, roi: roi * p.maxLev, pnl: totalMargin * (roi/100) * p.maxLev, currentPrice: marketPrices[p.symbol] };
    });
    const activeCap = activeData.length * marginPerCoin;
    res.json({ state: botState, active: activeData, activeCapital: activeCap });
});

app.post('/api/control', (req, res) => { 
    if (req.body.running && !botState.running) botState.startTime = Date.now();
    botState = { ...botState, ...req.body }; 
    saveState(); 
    res.json({ status: 'ok' }); 
});

app.post('/api/reset', (req, res) => { 
    activePositions = {}; botState.closedPnl = 0; botState.totalClosedGrids = 0; botState.startTime = botState.running ? Date.now() : null;
    saveState(); res.json({ status: 'ok' }); 
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Matrix Analytics</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace}th{cursor:pointer;background:#161a1e;padding:12px 8px}tr:hover{background:#2b3139}.stat-box{background:#1e2329;border:1px solid #2b3139;padding:12px;border-radius:8px}</style>
    </head><body class="p-4 text-[11px]">
        
        <div class="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
            <div class="stat-box text-center"><div class="text-gray-500">THỜI GIAN CHẠY</div><div id="uptime" class="text-yellow-500 font-bold text-sm">-</div></div>
            <div class="stat-box text-center"><div class="text-gray-500 font-bold text-blue-400">TỔNG COIN ĐANG CHẠY</div><div id="statCoins" class="text-xl font-bold">0</div></div>
            <div class="stat-box text-center"><div class="text-gray-500">LƯỚI (CHỐT/TREO)</div><div id="statGrids" class="text-purple-400 font-bold">0</div></div>
            <div class="stat-box text-center"><div class="text-gray-500">PNL ĐÃ CHỐT</div><div id="statClosedPnl" class="text-green-500 font-bold">0.00$</div></div>
            <div class="stat-box text-center"><div class="text-gray-500">PNL TẠM TÍNH</div><div id="statUnrealized" class="font-bold">0.00$</div></div>
            <div class="stat-box text-center border-t-2 border-yellow-500"><div class="text-gray-500">TỔNG ROI % (DANH MỤC)</div><div id="statTotalRoi" class="text-xl font-bold">0.00%</div><div id="statCap" class="text-[9px] text-gray-500"></div></div>
        </div>

        <div class="bg-[#1e2329] p-4 rounded-lg mb-4 border border-gray-800 grid grid-cols-2 md:grid-cols-7 gap-3">
            <div>VỐN/COIN ($)<input id="totalBalance" type="number" value="${botState.totalBalance}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>MARGIN<div class="flex"><input id="marginValue" type="number" value="${botState.marginValue}" class="w-full bg-black text-yellow-500 p-1 rounded"><select id="marginType" class="bg-black"><option value="$"> $ </option><option value="%"> % </option></select></div></div>
            <div>DCA MAX<input id="maxGrids" type="number" value="${botState.maxGrids}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>KHOẢNG CÁCH (%)<input id="stepSize" type="number" value="${botState.stepSize}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>TP (%) GIÁ TB<input id="tpPercent" type="number" value="${botState.tpPercent}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>MODE<select id="mode" class="w-full bg-black p-1 rounded"><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></div>
            <div class="flex gap-1 items-end"><button onclick="sendCtrl(true)" class="bg-green-600 p-1 rounded font-bold flex-1 h-8">START</button><button onclick="sendCtrl(false)" class="bg-red-600 p-1 rounded font-bold flex-1 h-8">STOP</button><button onclick="resetAll()" class="bg-gray-700 p-1 rounded h-8 px-2">RESET</button></div>
        </div>

        <div class="bg-[#1e2329] rounded-lg overflow-hidden border border-gray-800">
            <table class="w-full text-left">
                <thead><tr>
                    <th class="p-2" onclick="setSort('symbol')">SYMBOL ↕</th>
                    <th onclick="setSort('currentPrice')">GIÁ HIỆN TẠI ↕</th>
                    <th onclick="setSort('currentGrid')">SỐ LƯỚI ↕</th>
                    <th onclick="setSort('maxLev')">MAX LEV ↕</th>
                    <th onclick="setSort('roi')">ROI ↕</th>
                    <th onclick="setSort('pnl')">PNL ($) ↕</th>
                </tr></thead>
                <tbody id="activeBody"></tbody>
            </table>
        </div>

        <div id="modal" class="fixed inset-0 bg-black/95 hidden flex items-center justify-center p-4 z-50">
            <div class="bg-[#161a1e] p-6 rounded-lg w-full max-w-xl border border-yellow-500">
                <div class="flex justify-between items-center mb-4 text-lg font-bold text-yellow-500"><span id="mTitle"></span><button onclick="closeModal()" class="text-2xl">&times;</button></div>
                <div id="mContent" class="space-y-2"></div>
            </div>
        </div>

        <script>
            let sortKey = 'pnl'; let sortDir = -1; let rawData = [];
            function setSort(key) { if(sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = -1; } render(); }
            
            async function sendCtrl(run){
                const body = { running:run, totalBalance:Number(document.getElementById('totalBalance').value), marginValue:Number(document.getElementById('marginValue').value), marginType:document.getElementById('marginType').value, maxGrids:Number(document.getElementById('maxGrids').value), stepSize:Number(document.getElementById('stepSize').value), tpPercent:Number(document.getElementById('tpPercent').value), mode:document.getElementById('mode').value, multiplier: 2.0 };
                await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
            }
            async function resetAll(){ if(confirm('Reset toàn bộ thống kê?')) await fetch('/api/reset',{method:'POST'}); }

            function render() {
                const sorted = [...rawData].sort((a,b) => {
                    let valA = a[sortKey], valB = b[sortKey];
                    return typeof valA === 'string' ? (sortDir === 1 ? valA.localeCompare(valB) : valB.localeCompare(valA)) : (valA - valB) * sortDir;
                });
                document.getElementById('activeBody').innerHTML = sorted.map(p => \`
                <tr onclick="openDetail('\${p.symbol}')" class="cursor-pointer border-b border-gray-800">
                    <td class="p-2 font-bold text-yellow-500">\${p.symbol}</td>
                    <td>\${p.currentPrice.toFixed(4)}</td>
                    <td>\${p.currentGrid}/\${window.botState.maxGrids}</td>
                    <td class="text-gray-500">\${p.maxLev}x</td>
                    <td class="\${p.roi>=0?'text-green-500':'text-red-500'}">\${p.roi.toFixed(2)}%</td>
                    <td class="\${p.pnl>=0?'text-green-500 font-bold':'text-red-500 font-bold'}">\${p.pnl.toFixed(2)}$</td>
                </tr>\`).join('');
            }

            function updateStats(state, active, activeCap) {
                const unrealized = active.reduce((s, p) => s + p.pnl, 0);
                const totalPnl = state.closedPnl + unrealized;
                const totalRoi = activeCap > 0 ? (totalPnl / activeCap) * 100 : 0;
                
                document.getElementById('statCoins').innerText = active.length;
                document.getElementById('statGrids').innerText = \`\${state.totalClosedGrids} chốt / \${active.reduce((s,p)=>s+p.currentGrid,0)} treo\`;
                document.getElementById('statClosedPnl').innerText = state.closedPnl.toFixed(2) + '$';
                document.getElementById('statUnrealized').innerText = unrealized.toFixed(2) + '$';
                document.getElementById('statUnrealized').className = unrealized >= 0 ? 'text-green-400 font-bold' : 'text-red-400 font-bold';
                document.getElementById('statTotalRoi').innerText = totalRoi.toFixed(2) + '%';
                document.getElementById('statTotalRoi').className = \`text-xl font-bold \${totalRoi >= 0 ? 'text-green-500' : 'text-red-500'}\`;
                document.getElementById('statCap').innerText = "Vốn thực tế: " + activeCap.toLocaleString() + "$";

                if(state.startTime) {
                    const diff = Math.floor((Date.now() - state.startTime) / 1000);
                    const h = Math.floor(diff/3600), m = Math.floor((diff%3600)/60), s = diff%60;
                    document.getElementById('uptime').innerText = \`\${h}h \${m}m \${s}s\`;
                }
            }

            function openDetail(symbol) {
                const p = rawData.find(x => x.symbol === symbol); if(!p) return;
                document.getElementById('mTitle').innerText = symbol + " (DCA History)";
                document.getElementById('mContent').innerHTML = p.grids.map((g,i) => \`
                <div class="flex justify-between border-b border-gray-800 pb-2">
                    <span>LỆNH \${i+1}</span><span>Giá: \${g.price.toFixed(4)}</span><span class="text-yellow-500">\${g.qty.toFixed(1)}$</span>
                </div>\`).join('') + \`<div class="mt-4 text-sm font-bold">Giá trung bình: \${p.avgPrice.toFixed(4)}</div><div class="text-gray-500 text-[10px]">Nhấn bên ngoài để đóng</div>\`;
                document.getElementById('modal').classList.remove('hidden');
            }
            function closeModal() { document.getElementById('modal').classList.add('hidden'); }

            async function update(){
                try {
                    const res = await fetch('/api/data'); const d = await res.json();
                    rawData = d.active; window.botState = d.state;
                    render(); updateStats(d.state, d.active, d.activeCapital);
                } catch(e){}
            }
            setInterval(update, 1500);
        </script>
    </body></html>`);
});

fetchSymbols().then(() => {
    initWS();
    app.listen(PORT, '0.0.0.0', () => console.log(`BOT DCA MATRIX ACTIVE: http://localhost:${PORT}/gui`));
});
