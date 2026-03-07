import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { API_KEY, SECRET_KEY } from './config.js'; // Đảm bảo file này có chứa key của bạn

const app = express();
app.use(express.json());

const STATE_FILE = './bot_state.json';
const LEVERAGE_FILE = './leverage_cache.json';
const PORT = 9009;

let botState = { 
    running: false, startTime: null, totalBalance: 1000, marginValue: 10, marginType: '$',
    maxGrids: 5, stepSize: 1.0, multiplier: 2.0, tpPercent: 1.0, mode: 'LONG', 
    closedPnl: 0, totalClosedGrids: 0 
};

let activePositions = {}; 
let marketPrices = {};
let allSymbols = [];
let symbolMaxLeverage = {}; 

// Load dữ liệu cũ
if (fs.existsSync(STATE_FILE)) {
    try { Object.assign(botState, JSON.parse(fs.readFileSync(STATE_FILE))); } catch(e){}
}
if (fs.existsSync(LEVERAGE_FILE)) {
    try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){}
}

const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(botState));

// ==========================================
// LOGIC LẤY ĐÒN BẨY THẬT TỪ BINANCE
// ==========================================
async function fetchActualLeverage() {
    return new Promise((resolve) => {
        const timestamp = Date.now();
        const query = `timestamp=${timestamp}`;
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        
        const options = {
            hostname: 'fapi.binance.com',
            path: `/fapi/v1/leverageBracket?${query}&signature=${signature}`,
            headers: { 'X-MBX-APIKEY': API_KEY }
        };

        https.get(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const brackets = JSON.parse(data);
                    if (Array.isArray(brackets)) {
                        brackets.forEach(item => {
                            if (item.brackets?.[0]) {
                                symbolMaxLeverage[item.symbol] = item.brackets[0].initialLeverage;
                                if (!allSymbols.includes(item.symbol)) allSymbols.push(item.symbol);
                            }
                        });
                        fs.writeFileSync(LEVERAGE_FILE, JSON.stringify(symbolMaxLeverage));
                        console.log(`Đã cập nhật đòn bẩy thực tế cho ${Object.keys(symbolMaxLeverage).length} coin.`);
                    }
                    resolve();
                } catch (e) { resolve(); }
            });
        }).on('error', () => resolve());
    });
}

function startNewGrid(symbol, price) {
    if (!botState.running || activePositions[symbol]) return;
    const margin = botState.marginType === '$' ? botState.marginValue : (botState.totalBalance * botState.marginValue / 100);
    
    // Sử dụng đòn bẩy thực tế từ cache, nếu không có mới dùng x20 mặc định
    const maxL = symbolMaxLeverage[symbol] || 20;

    activePositions[symbol] = {
        symbol, 
        side: botState.mode, 
        maxLev: maxL,
        grids: [{ price, qty: margin, time: Date.now() }],
    };
}

function processGridLogic(symbol, currentPrice) {
    const pos = activePositions[symbol];
    if (!pos) return;

    const totalMargin = pos.grids.reduce((sum, g) => sum + g.qty, 0);
    const avgPrice = pos.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
    const priceDiffPct = pos.side === 'LONG' ? (currentPrice - avgPrice) / avgPrice : (avgPrice - currentPrice) / avgPrice;

    // Chốt lời
    if (priceDiffPct * 100 >= botState.tpPercent) {
        const pnl = totalMargin * (priceDiffPct * pos.maxLev);
        botState.closedPnl += pnl;
        botState.totalClosedGrids += 1;
        delete activePositions[symbol];
        saveState();
        return;
    }

    // DCA thêm lưới
    if (pos.grids.length < botState.maxGrids) {
        const lastEntry = pos.grids[pos.grids.length - 1].price;
        const gap = pos.side === 'LONG' ? (lastEntry - currentPrice) / lastEntry : (currentPrice - lastEntry) / lastEntry;
        if (gap * 100 >= botState.stepSize) {
            pos.grids.push({ 
                price: currentPrice, 
                qty: pos.grids[pos.grids.length - 1].qty * botState.multiplier, 
                time: Date.now() 
            });
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

// API Giao tiếp
app.get('/api/data', (req, res) => {
    const marginPerCoin = botState.marginType === '$' ? botState.marginValue : (botState.totalBalance * botState.marginValue / 100);
    const activeData = Object.values(activePositions).map(p => {
        const totalMargin = p.grids.reduce((sum, g) => sum + g.qty, 0);
        const avgPrice = p.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
        const currentP = marketPrices[p.symbol] || 0;
        const diff = p.side === 'LONG' ? (currentP - avgPrice) / avgPrice : (avgPrice - currentP) / avgPrice;
        const roi = diff * p.maxLev * 100;
        const pnl = totalMargin * (roi / 100);
        return { ...p, avgPrice, totalMargin, currentGrid: p.grids.length, roi, pnl, currentPrice: currentP };
    });
    res.json({ state: botState, active: activeData, activeCapital: activeData.length * marginPerCoin });
});

app.post('/api/control', (req, res) => { 
    if (req.body.running && !botState.running) botState.startTime = Date.now();
    Object.assign(botState, req.body);
    saveState(); res.json({ status: 'ok' }); 
});

app.post('/api/reset', (req, res) => { 
    activePositions = {}; botState.closedPnl = 0; botState.totalClosedGrids = 0; 
    botState.startTime = botState.running ? Date.now() : null;
    saveState(); res.json({ status: 'ok' }); 
});

// GUI Web Dashboard
app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Matrix v3 - Actual Leverage</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace}th{cursor:pointer;background:#161a1e;padding:12px 8px}tr:hover{background:#2b3139}.stat-box{background:#1e2329;border:1px solid #2b3139;padding:12px;border-radius:8px}</style>
    </head><body class="p-4 text-[11px]">
        <div class="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
            <div class="stat-box text-center"><div class="text-gray-500 uppercase">Uptime</div><div id="uptime" class="text-yellow-500 font-bold text-sm">0s</div></div>
            <div class="stat-box text-center"><div class="text-gray-500 font-bold text-blue-400 uppercase">Coin chạy</div><div id="statCoins" class="text-xl font-bold">0</div></div>
            <div class="stat-box text-center"><div class="text-gray-500 uppercase">Lưới (Chốt/Treo)</div><div id="statGrids" class="text-purple-400 font-bold">0</div></div>
            <div class="stat-box text-center"><div class="text-gray-500 uppercase">PnL Chốt</div><div id="statClosedPnl" class="text-green-500 font-bold text-sm">0.00$</div></div>
            <div class="stat-box text-center"><div class="text-gray-500 uppercase">PnL Tạm tính</div><div id="statUnrealized" class="font-bold text-sm">0.00$</div></div>
            <div class="stat-box text-center border-t-2 border-yellow-500"><div class="text-gray-500 uppercase">Tổng ROI %</div><div id="statTotalRoi" class="text-xl font-bold">0.00%</div><div id="statCap" class="text-[9px] text-gray-500">Vốn: 0$</div></div>
        </div>

        <div class="bg-[#1e2329] p-4 rounded-lg mb-4 border border-gray-800 grid grid-cols-2 md:grid-cols-7 gap-3">
            <div>VỐN/COIN ($)<input id="totalBalance" type="number" value="\${botState.totalBalance}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>MARGIN<div class="flex"><input id="marginValue" type="number" value="\${botState.marginValue}" class="w-full bg-black text-yellow-500 p-1 rounded"><select id="marginType" class="bg-black"><option value="$" \${botState.marginType==='$'?'selected':''}>$</option><option value="%" \${botState.marginType==='%'?'selected':''}>%</option></select></div></div>
            <div>DCA MAX<input id="maxGrids" type="number" value="\${botState.maxGrids}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>GAP (%)<input id="stepSize" type="number" value="\${botState.stepSize}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>TP (%)<input id="tpPercent" type="number" value="\${botState.tpPercent}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>MODE<select id="mode" class="w-full bg-black p-1 rounded"><option value="LONG" \${botState.mode==='LONG'?'selected':''}>LONG</option><option value="SHORT" \${botState.mode==='SHORT'?'selected':''}>SHORT</option></select></div>
            <div class="flex gap-1 items-end"><button onclick="sendCtrl(true)" class="bg-green-600 p-1 rounded font-bold flex-1 h-8">START</button><button onclick="sendCtrl(false)" class="bg-red-600 p-1 rounded font-bold flex-1 h-8">STOP</button><button onclick="resetAll()" class="bg-gray-700 p-1 rounded h-8 px-2 uppercase">Reset</button></div>
        </div>

        <div class="bg-[#1e2329] rounded-lg border border-gray-800">
            <table class="w-full text-left">
                <thead><tr>
                    <th class="p-2" onclick="setSort('symbol')">SYMBOL ↕</th>
                    <th onclick="setSort('currentPrice')">PRICE ↕</th>
                    <th onclick="setSort('currentGrid')">GRID ↕</th>
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
                <div id="mContent" class="space-y-2 max-h-96 overflow-y-auto"></div>
            </div>
        </div>

        <script>
            let sortKey = 'pnl', sortDir = -1, rawData = [];
            function setSort(k) { if(sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = -1; } render(); }
            async function sendCtrl(run){
                const body = { running:run, totalBalance:Number(document.getElementById('totalBalance').value), marginValue:Number(document.getElementById('marginValue').value), marginType:document.getElementById('marginType').value, maxGrids:Number(document.getElementById('maxGrids').value), stepSize:Number(document.getElementById('stepSize').value), tpPercent:Number(document.getElementById('tpPercent').value), mode:document.getElementById('mode').value, multiplier: 2.0 };
                await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
            }
            async function resetAll(){ if(confirm('Reset stats?')) await fetch('/api/reset',{method:'POST'}); }
            function render() {
                const sorted = [...rawData].sort((a,b) => {
                    let vA = a[sortKey], vB = b[sortKey];
                    return typeof vA === 'string' ? (sortDir === 1 ? vA.localeCompare(vB) : vB.localeCompare(vA)) : (vA - vB) * sortDir;
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
                document.getElementById('statUnrealized').className = unrealized >= 0 ? 'text-green-400 font-bold text-sm' : 'text-red-400 font-bold text-sm';
                document.getElementById('statTotalRoi').innerText = totalRoi.toFixed(2) + '%';
                document.getElementById('statTotalRoi').className = \`text-xl font-bold \${totalRoi >= 0 ? 'text-green-500' : 'text-red-500'}\`;
                document.getElementById('statCap').innerText = "Vốn thực tế: " + activeCap.toLocaleString() + "$";
                if(state.startTime) {
                    const diff = Math.floor((Date.now() - state.startTime) / 1000);
                    const h = Math.floor(diff/3600), m = Math.floor((diff%3600)/60), s = diff%60;
                    document.getElementById('uptime').innerText = \`\${h}h \${m}m \${s}s\`;
                }
            }
            function openDetail(s) {
                const p = rawData.find(x => x.symbol === s); if(!p) return;
                document.getElementById('mTitle').innerText = s + " History";
                document.getElementById('mContent').innerHTML = p.grids.map((g,i) => \`
                <div class="flex justify-between border-b border-gray-800 pb-2 text-[10px]">
                    <span>LỆNH \${i+1}</span><span>Giá: \${g.price.toFixed(4)}</span><span class="text-yellow-500">\${g.qty.toFixed(1)}$</span>
                </div>\`).join('') + \`<div class="mt-4 text-sm font-bold text-yellow-500">Giá trung bình: \${p.avgPrice.toFixed(4)}</div>\`;
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
            setInterval(update, 1000);
        </script>
    </body></html>`);
});

// Chạy bot
fetchActualLeverage().then(() => {
    initWS();
    app.listen(PORT, '0.0.0.0', () => console.log(`Matrix Dashboard: http://localhost:${PORT}/gui`));
});
