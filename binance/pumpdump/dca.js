import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';

const app = express();
app.use(express.json());

const STATE_FILE = './bot_state.json';
const HISTORY_FILE = './bot_history.json';
const PORT = 9009;

let botState = { 
    running: false, totalBalance: 1000, marginValue: 10, marginType: '$',
    maxGrids: 5, stepSize: 1.0, multiplier: 2.0, tpPercent: 1.0, mode: 'LONG' 
};

let activePositions = {}; 
let history = [];
let marketPrices = {};
let allSymbols = []; // Danh sách coin lấy từ Binance

// Load dữ liệu
if (fs.existsSync(STATE_FILE)) botState = JSON.parse(fs.readFileSync(STATE_FILE));
if (fs.existsSync(HISTORY_FILE)) history = JSON.parse(fs.readFileSync(HISTORY_FILE));

const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(botState));
const saveHistory = () => fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));

// Lấy danh sách toàn bộ coin Future từ Binance
async function fetchSymbols() {
    return new Promise((resolve) => {
        https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const info = JSON.parse(data);
                allSymbols = info.symbols.filter(s => s.status === 'TRADING').map(s => s.symbol);
                console.log(`Đã tải ${allSymbols.length} cặp coin Future.`);
                resolve();
            });
        });
    });
}

function startNewGrid(symbol, price) {
    if (!botState.running) return;
    const margin = botState.marginType === '$' ? botState.marginValue : (botState.totalBalance * botState.marginValue / 100);
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
    const priceDiffPct = pos.side === 'LONG' ? (currentPrice - avgPrice) / avgPrice : (avgPrice - currentPrice) / avgPrice;

    // Chốt lời
    if (priceDiffPct * 100 >= botState.tpPercent) {
        const pnl = totalMargin * priceDiffPct * 20; // PnL ước tính x20
        history.push({ ...pos, endTime: Date.now(), finalPrice: currentPrice, avgPrice, totalMargin, pnl, roi: priceDiffPct * 100 * 20, gridCount: pos.grids.length });
        delete activePositions[symbol];
        saveHistory();
        return;
    }

    // DCA
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

// API
app.get('/api/data', (req, res) => {
    const activeData = Object.values(activePositions).map(p => {
        const totalMargin = p.grids.reduce((sum, g) => sum + g.qty, 0);
        const avgPrice = p.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
        const roi = p.side === 'LONG' ? ((marketPrices[p.symbol] - avgPrice) / avgPrice) * 100 : ((avgPrice - marketPrices[p.symbol]) / avgPrice) * 100;
        return { ...p, avgPrice, totalMargin, currentGrid: p.grids.length, roi: roi * 20 };
    });
    res.json({ state: botState, active: activeData, history, marketPrices });
});

app.post('/api/control', (req, res) => { botState = { ...botState, ...req.body }; saveState(); res.json({ status: 'ok' }); });
app.post('/api/reset', (req, res) => { activePositions = {}; history = []; saveHistory(); res.json({ status: 'ok' }); });

// GIAO DIỆN
app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy DCA 9009</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace}input,select{background:#000;border:1px solid #333;color:#f0b90b;padding:4px;border-radius:4px}</style>
    </head><body class="p-4 text-xs">
        <div class="bg-[#1e2329] p-4 rounded-lg mb-4 border border-gray-800">
            <div class="grid grid-cols-2 md:grid-cols-6 gap-3">
                <div>VỐN ($)<input id="totalBalance" type="number" value="${botState.totalBalance}" class="w-full"></div>
                <div>MARGIN<div class="flex"><input id="marginValue" type="number" value="${botState.marginValue}" class="w-full"><select id="marginType"><option value="$" ${botState.marginType==='$'?'selected':''}>$</option><option value="%" ${botState.marginType==='%'?'selected':''}>%</option></select></div></div>
                <div>DCA MAX<input id="maxGrids" type="number" value="${botState.maxGrids}" class="w-full"></div>
                <div>GAP (%)<input id="stepSize" type="number" value="${botState.stepSize}" class="w-full"></div>
                <div>TP (%) GIÁ<input id="tpPercent" type="number" value="${botState.tpPercent}" class="w-full"></div>
                <div>MODE<select id="mode" class="w-full"><option value="LONG" ${botState.mode==='LONG'?'selected':''}>LONG</option><option value="SHORT" ${botState.mode==='SHORT'?'selected':''}>SHORT</option></select></div>
            </div>
            <div class="flex gap-2 mt-4"><button onclick="sendCtrl(true)" class="bg-green-600 p-2 rounded font-bold flex-1">START</button><button onclick="sendCtrl(false)" class="bg-red-600 p-2 rounded font-bold flex-1">STOP</button><button onclick="resetAll()" class="bg-gray-700 p-2 rounded px-4">RESET</button></div>
        </div>

        <div class="grid grid-cols-3 gap-2 mb-4">
            <div class="bg-[#1e2329] p-2 rounded text-center border-b-2 border-yellow-500">BTC: <span id="p-BTCUSDT">0</span></div>
            <div class="bg-[#1e2329] p-2 rounded text-center border-b-2 border-blue-500">ETH: <span id="p-ETHUSDT">0</span></div>
            <div class="bg-[#1e2329] p-2 rounded text-center border-b-2 border-orange-500">BNB: <span id="p-BNBUSDT">0</span></div>
        </div>

        <div class="bg-[#1e2329] rounded-lg mb-4 h-64 overflow-y-auto">
            <table class="w-full text-left">
                <thead class="sticky top-0 bg-black"><tr><th class="p-2">Symbol</th><th>Grids</th><th>Price Avg</th><th>ROI (20x)</th></tr></thead>
                <tbody id="activeBody"></tbody>
            </table>
        </div>

        <div class="bg-[#1e2329] rounded-lg p-2">
            <div class="flex justify-between items-center mb-2">
                <span class="font-bold">LỊCH SỬ CHỐT LỜI</span>
                <div class="flex gap-1">
                    <button onclick="setSort('pnl')" class="bg-blue-900 px-2 py-1 rounded">Sort PnL</button>
                    <button onclick="setSort('grid')" class="bg-blue-900 px-2 py-1 rounded">Sort Lưới</button>
                </div>
            </div>
            <div id="historyList" class="space-y-1 h-40 overflow-y-auto"></div>
        </div>

        <script>
            let currentSort = 'time';
            async function sendCtrl(run){
                const body = { running:run, totalBalance:Number(document.getElementById('totalBalance').value), marginValue:Number(document.getElementById('marginValue').value), marginType:document.getElementById('marginType').value, maxGrids:Number(document.getElementById('maxGrids').value), stepSize:Number(document.getElementById('stepSize').value), tpPercent:Number(document.getElementById('tpPercent').value), mode:document.getElementById('mode').value, multiplier: 2.0 };
                await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
            }
            async function resetAll(){ if(confirm('Reset?')) await fetch('/api/reset',{method:'POST'}); }
            function setSort(type){ currentSort = type; }

            async function update(){
                try {
                    const res = await fetch('/api/data'); const d = await res.json();
                    ['BTCUSDT','ETHUSDT','BNBUSDT'].forEach(s => { document.getElementById('p-'+s).innerText = d.marketPrices[s]?.toFixed(1); });
                    document.getElementById('activeBody').innerHTML = d.active.map(p => \`<tr><td class="p-2 font-bold">\${p.symbol}</td><td>\${p.currentGrid}/\${d.state.maxGrids}</td><td>\${p.avgPrice.toFixed(4)}</td><td class="\${p.roi>=0?'text-green-500':'text-red-500'}">\${p.roi.toFixed(1)}%</td></tr>\`).join('');
                    
                    let sortedHistory = [...d.history];
                    if(currentSort === 'pnl') sortedHistory.sort((a,b) => b.pnl - a.pnl);
                    else if(currentSort === 'grid') sortedHistory.sort((a,b) => b.gridCount - a.gridCount);
                    else sortedHistory.reverse();

                    document.getElementById('historyList').innerHTML = sortedHistory.map(h => \`<div class="flex justify-between border-b border-gray-800 py-1"><span>\${h.symbol} [\${h.gridCount} lưới]</span><span class="\${h.pnl>=0?'text-green-500':'text-red-500'}">+\${h.pnl.toFixed(2)}$ (\${h.roi.toFixed(1)}%)</span></div>\`).join('');
                } catch(e){}
            }
            setInterval(update, 1000);
        </script>
    </body></html>`);
});

// Chạy bot
fetchSymbols().then(() => {
    initWS();
    app.listen(PORT, '0.0.0.0', () => console.log(`Cổng: ${PORT}`));
});
