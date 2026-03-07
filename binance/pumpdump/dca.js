import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';

const app = express();
app.use(express.json());

const STATE_FILE = './bot_state.json';
const HISTORY_FILE = './bot_history.json';
const PORT = 9009;

let botState = { 
    running: false, 
    totalBalance: 1000,     // Tổng vốn để tính %
    marginValue: 10,        // Giá trị nhập vào
    marginType: '$',        // $ hoặc %
    maxGrids: 5, 
    stepSize: 1.0, 
    multiplier: 2.0, 
    tpPercent: 1.0,         // Chốt lời theo % giá
    mode: 'LONG' 
};

let activePositions = {}; 
let history = [];
let marketPrices = {};

if (fs.existsSync(STATE_FILE)) botState = JSON.parse(fs.readFileSync(STATE_FILE));
if (fs.existsSync(HISTORY_FILE)) history = JSON.parse(fs.readFileSync(HISTORY_FILE));

const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(botState));
const saveHistory = () => fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));

// Tính toán số tiền Margin thực tế cho mỗi coin
const getActualMargin = () => {
    if (botState.marginType === '$') return botState.marginValue;
    return (botState.totalBalance * botState.marginValue) / 100;
};

function startNewGrid(symbol, price) {
    const margin = getActualMargin();
    activePositions[symbol] = {
        symbol, side: botState.mode,
        grids: [{ price, qty: margin, time: Date.now() }],
        status: 'RUNNING'
    };
}

function processGridLogic(symbol, currentPrice) {
    const pos = activePositions[symbol];
    const totalMargin = pos.grids.reduce((sum, g) => sum + g.qty, 0);
    const avgPrice = pos.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
    
    // 1. TÍNH TOÁN CHỐT LỜI THEO % GIÁ TRUNG BÌNH
    const priceDiffPct = pos.side === 'LONG' 
        ? (currentPrice - avgPrice) / avgPrice 
        : (avgPrice - currentPrice) / avgPrice;

    if (priceDiffPct * 100 >= botState.tpPercent) {
        const pnl = totalMargin * priceDiffPct * 20; // Giả định đòn bẩy 20x để tính PnL ước tính
        history.push({ ...pos, endTime: Date.now(), finalPrice: currentPrice, avgPrice, totalMargin, pnl, roi: priceDiffPct * 100 * 20, gridCount: pos.grids.length });
        delete activePositions[symbol];
        saveHistory();
        return;
    }

    // 2. THỰC HIỆN DCA THEO KHOẢNG CÁCH GIÁ
    if (pos.grids.length < botState.maxGrids) {
        const lastEntry = pos.grids[pos.grids.length - 1].price;
        const gap = pos.side === 'LONG' ? (lastEntry - currentPrice) / lastEntry : (currentPrice - lastEntry) / lastEntry;
        if (gap * 100 >= botState.stepSize) {
            const nextMargin = pos.grids[pos.grids.length - 1].qty * botState.multiplier;
            pos.grids.push({ price: currentPrice, qty: nextMargin, time: Date.now() });
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
                else startNewGrid(t.s, marketPrices[t.s]);
            }
        });
    });
}

// API
app.get('/api/data', (req, res) => {
    const activeData = Object.values(activePositions).map(p => {
        const totalMargin = p.grids.reduce((sum, g) => sum + g.qty, 0);
        const avgPrice = p.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
        const roi = posSideROI(p.side, avgPrice, marketPrices[p.symbol]);
        return { ...p, avgPrice, totalMargin, currentGrid: p.grids.length, roi: roi };
    });
    res.json({ state: botState, active: activeData, history: history.slice(-30).reverse(), marketPrices });
});

function posSideROI(side, avg, current) {
    if (!current) return 0;
    return side === 'LONG' ? ((current - avg) / avg) * 100 : ((avg - current) / avg) * 100;
}

app.post('/api/control', (req, res) => { botState = { ...botState, ...req.body }; saveState(); res.json({ status: 'ok' }); });
app.post('/api/reset', (req, res) => { activePositions = {}; history = []; saveHistory(); res.json({ status: 'ok' }); });

// --- GIAO DIỆN ---
app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>DCA Grid All Coins</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace}.bg-card{background:#1e2329;border:1px solid #2b3139}input,select{background:#000;border:1px solid #333;color:#f0b90b;padding:4px;border-radius:4px;width:100%}</style>
    </head><body class="p-4">
        <div class="bg-card p-4 rounded-lg mb-6">
            <h2 class="text-yellow-500 font-bold mb-4 uppercase text-xs">Cấu Hình Lưới Toàn Sàn</h2>
            <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
                <div><label class="text-[10px] text-gray-400">TỔNG VỐN ($)</label><input id="totalBalance" type="number" value="${botState.totalBalance}"></div>
                <div><label class="text-[10px] text-gray-400">MARGIN MỖI COIN</label>
                    <div class="flex gap-1"><input id="marginValue" type="number" value="${botState.marginValue}"><select id="marginType" class="w-16"><option value="$" ${botState.marginType==='$'?'selected':''}>$</option><option value="%" ${botState.marginType==='%'?'selected':''}>%</option></select></div>
                </div>
                <div><label class="text-[10px] text-gray-400">MAX DCA LƯỚI</label><input id="maxGrids" type="number" value="${botState.maxGrids}"></div>
                <div><label class="text-[10px] text-gray-400">KHOẢNG CÁCH (%)</label><input id="stepSize" type="number" value="${botState.stepSize}"></div>
                <div><label class="text-[10px] text-gray-400">NHÂN VỐN (X)</label><input id="multiplier" type="number" value="${botState.multiplier}"></div>
                <div><label class="text-[10px] text-gray-400">TP (%) GIÁ TB</label><input id="tpPercent" type="number" value="${botState.tpPercent}"></div>
                <div><label class="text-[10px] text-gray-400">CHẾ ĐỘ</label><select id="mode"><option value="LONG" ${botState.mode==='LONG'?'selected':''}>LONG</option><option value="SHORT" ${botState.mode==='SHORT'?'selected':''}>SHORT</option></select></div>
            </div>
            <div class="flex gap-2 mt-4"><button onclick="sendCtrl(true)" class="bg-green-600 p-2 rounded font-bold flex-1">START ENGINE</button><button onclick="sendCtrl(false)" class="bg-red-600 p-2 rounded font-bold flex-1">STOP</button><button onclick="resetAll()" class="bg-gray-700 p-2 rounded font-bold px-6">RESET</button></div>
        </div>

        <div class="grid grid-cols-3 gap-4 mb-6">
            <div class="bg-card p-3 rounded text-center"><div class="text-[10px] text-gray-500">BTC</div><div id="p-BTCUSDT" class="text-xl font-bold">---</div></div>
            <div class="bg-card p-3 rounded text-center"><div class="text-[10px] text-gray-500">ETH</div><div id="p-ETHUSDT" class="text-xl font-bold">---</div></div>
            <div class="bg-card p-3 rounded text-center"><div class="text-[10px] text-gray-500">BNB</div><div id="p-BNBUSDT" class="text-xl font-bold">---</div></div>
        </div>

        <section class="bg-card rounded-lg overflow-hidden mb-6">
            <table class="w-full text-[11px] text-left">
                <thead class="bg-black/40"><tr><th class="p-2">Symbol</th><th>Side</th><th>Grids</th><th>Entry Avg</th><th>Price</th><th>ROI %</th></tr></thead>
                <tbody id="activeBody"></tbody>
            </table>
        </section>

        <section class="bg-card rounded-lg overflow-hidden">
            <div class="p-2 bg-black/40 text-[10px] font-bold uppercase">Lịch sử chốt lời</div>
            <div id="historyList" class="p-2 space-y-1 max-h-60 overflow-y-auto"></div>
        </section>

        <script>
            async function sendCtrl(run){
                const body = { running:run, totalBalance:Number(document.getElementById('totalBalance').value), marginValue:Number(document.getElementById('marginValue').value), marginType:document.getElementById('marginType').value, maxGrids:Number(document.getElementById('maxGrids').value), stepSize:Number(document.getElementById('stepSize').value), multiplier:Number(document.getElementById('multiplier').value), tpPercent:Number(document.getElementById('tpPercent').value), mode:document.getElementById('mode').value };
                await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
            }
            async function resetAll(){ if(confirm('Reset?')) await fetch('/api/reset',{method:'POST'}); }
            async function update(){
                const res = await fetch('/api/data'); const d = await res.json();
                ['BTCUSDT','ETHUSDT','BNBUSDT'].forEach(s => { const p = d.marketPrices[s]; const el = document.getElementById('p-'+s); if(p) el.innerText = p.toFixed(2); });
                document.getElementById('activeBody').innerHTML = d.active.map(p => \`<tr class="border-b border-gray-800"><td class="p-2 font-bold">\${p.symbol}</td><td class="\${p.side==='LONG'?'text-green-500':'text-red-500'}">\${p.side}</td><td>\${p.currentGrid}/\${d.state.maxGrids}</td><td>\${p.avgPrice.toFixed(4)}</td><td>\${(d.marketPrices[p.symbol]||0).toFixed(4)}</td><td class="\${p.roi>=0?'text-green-500':'text-red-500'} font-bold">\${p.roi.toFixed(2)}%</td></tr>\`).join('');
                document.getElementById('historyList').innerHTML = d.history.map(h => \`<div class="flex justify-between text-[10px] border-b border-gray-800 pb-1"><span>\${h.symbol} (\${h.gridCount} Lưới)</span><span class="text-green-500">+\${h.pnl.toFixed(2)}$ (\${h.roi.toFixed(1)}%)</span></div>\`).join('');
            }
            setInterval(update, 1000);
        </script>
    </body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`http://localhost:${PORT}/gui`); });
