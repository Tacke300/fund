import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
app.use(express.json());

const STATE_FILE = './bot_state.json';
const HISTORY_FILE = './bot_history.json';
const PORT = 9009;

// --- BIẾN TOÀN CỤC ---
let botState = { 
    running: false, initialBal: 1000, marginPerGrid: 10, 
    maxGrids: 5, stepSize: 1.0, multiplier: 2.0, 
    tpRoi: 2.0, slRoi: 10.0, mode: 'LONG', maxConcurrentCoins: 10 
};
let activePositions = {}; 
let history = [];
let marketPrices = {};
let symbolMaxLev = {};

// Load dữ liệu
if (fs.existsSync(STATE_FILE)) botState = JSON.parse(fs.readFileSync(STATE_FILE));
if (fs.existsSync(HISTORY_FILE)) history = JSON.parse(fs.readFileSync(HISTORY_FILE));

function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(botState)); }
function saveHistory() { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history)); }

// --- LOGIC GIAO DỊCH ---
function startNewGrid(symbol, price) {
    if (Object.keys(activePositions).length >= botState.maxConcurrentCoins) return;
    const lev = symbolMaxLev[symbol] || 20;
    activePositions[symbol] = {
        symbol, side: botState.mode, maxLev: lev,
        grids: [{ price, qty: botState.marginPerGrid, time: Date.now() }],
        status: 'RUNNING'
    };
}

function processGridLogic(symbol, currentPrice) {
    const pos = activePositions[symbol];
    const totalMargin = pos.grids.reduce((sum, g) => sum + g.qty, 0);
    const avgPrice = pos.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
    const priceDiff = pos.side === 'LONG' ? (currentPrice - avgPrice) / avgPrice : (avgPrice - currentPrice) / avgPrice;
    const currentROI = priceDiff * pos.maxLev * 100;

    // Chốt lời hoặc Cắt lỗ
    if (currentROI >= botState.tpRoi || currentROI <= -botState.slRoi) {
        const pnl = totalMargin * (currentROI / 100);
        history.push({ ...pos, endTime: Date.now(), finalPrice: currentPrice, avgPrice, totalMargin, pnl, roi: currentROI, gridCount: pos.grids.length });
        delete activePositions[symbol];
        saveHistory();
        return;
    }

    // Thực hiện DCA thêm lưới
    if (pos.grids.length < botState.maxGrids) {
        const lastEntry = pos.grids[pos.grids.length - 1].price;
        const gap = pos.side === 'LONG' ? (lastEntry - currentPrice) / lastEntry : (currentPrice - lastEntry) / lastEntry;
        if (gap * 100 >= botState.stepSize) {
            const nextMargin = pos.grids[pos.grids.length - 1].qty * botState.multiplier;
            pos.grids.push({ price: currentPrice, qty: nextMargin, time: Date.now() });
        }
    }
}

// --- KẾT NỐI BINANCE ---
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

// --- API ---
app.get('/api/data', (req, res) => {
    const activeData = Object.values(activePositions).map(p => {
        const totalMargin = p.grids.reduce((sum, g) => sum + g.qty, 0);
        const avgPrice = p.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
        const diff = p.side === 'LONG' ? (marketPrices[p.symbol] - avgPrice) / avgPrice : (avgPrice - marketPrices[p.symbol]) / avgPrice;
        return { ...p, avgPrice, totalMargin, currentGrid: p.grids.length, roi: diff * p.maxLev * 100, pnl: totalMargin * (diff * p.maxLev) };
    });
    res.json({ state: botState, active: activeData, history: history.slice(-20).reverse(), marketPrices });
});

app.post('/api/control', (req, res) => { 
    botState = { ...botState, ...req.body }; 
    saveState(); 
    res.json({ status: 'ok' }); 
});

app.post('/api/reset', (req, res) => { 
    activePositions = {}; history = []; 
    saveHistory(); 
    res.json({ status: 'Reset Done' }); 
});

// --- GIAO DIỆN GUI ---
app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Grid Engine</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace}.bg-card{background:#1e2329;border:1px solid #2b3139}input,select{background:#000;border:1px solid #333;color:#f0b90b;padding:4px 8px;border-radius:4px;width:100%}</style>
    </head><body class="p-4">
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div class="bg-card p-4 rounded-lg col-span-3">
                <h2 class="text-yellow-500 font-bold mb-4 uppercase text-xs">Cấu hình lưới (DCA Settings)</h2>
                <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
                    <div><label class="text-[10px] text-gray-400">MARGIN LỆNH 1 ($)</label><input id="marginPerGrid" type="number" value="${botState.marginPerGrid}"></div>
                    <div><label class="text-[10px] text-gray-400">MAX GRIDS (DCA)</label><input id="maxGrids" type="number" value="${botState.maxGrids}"></div>
                    <div><label class="text-[10px] text-gray-400">KHOẢNG CÁCH (%)</label><input id="stepSize" type="number" value="${botState.stepSize}"></div>
                    <div><label class="text-[10px] text-gray-400">NHÂN VỐN (X)</label><input id="multiplier" type="number" value="${botState.multiplier}"></div>
                    <div><label class="text-[10px] text-gray-400">MAX COIN CHẠY</label><input id="maxConcurrentCoins" type="number" value="${botState.maxConcurrentCoins}"></div>
                    <div><label class="text-[10px] text-gray-400">TP ROI (%)</label><input id="tpRoi" type="number" value="${botState.tpRoi}"></div>
                    <div><label class="text-[10px] text-gray-400">SL ROI (%)</label><input id="slRoi" type="number" value="${botState.slRoi}"></div>
                    <div><label class="text-[10px] text-gray-400">CHẾ ĐỘ</label><select id="mode"><option value="LONG" ${botState.mode==='LONG'?'selected':''}>LONG</option><option value="SHORT" ${botState.mode==='SHORT'?'selected':''}>SHORT</option></select></div>
                    <div class="flex items-end gap-1"><button onclick="sendCtrl(true)" class="bg-green-600 p-2 rounded font-bold w-full text-xs">START</button><button onclick="sendCtrl(false)" class="bg-red-600 p-2 rounded font-bold w-full text-xs">STOP</button></div>
                    <div class="flex items-end"><button onclick="resetAll()" class="bg-gray-700 p-2 rounded font-bold w-full text-xs">RESET DATA</button></div>
                </div>
            </div>
            <div class="bg-card p-4 rounded-lg flex flex-col justify-center text-center">
                <div class="text-[10px] text-gray-400">TỔNG PNL</div>
                <div id="totalPnl" class="text-3xl font-bold text-green-500">0.00</div>
            </div>
        </div>

        <div class="grid grid-cols-3 gap-4 mb-6">
            <div class="bg-card p-4 rounded text-center border-b-2 border-yellow-500"><div class="text-xs text-gray-500">BTCUSDT</div><div id="p-BTCUSDT" class="text-xl font-bold">---</div></div>
            <div class="bg-card p-4 rounded text-center border-b-2 border-blue-500"><div class="text-xs text-gray-500">ETHUSDT</div><div id="p-ETHUSDT" class="text-xl font-bold">---</div></div>
            <div class="bg-card p-4 rounded text-center border-b-2 border-orange-500"><div class="text-xs text-gray-500">BNBUSDT</div><div id="p-BNBUSDT" class="text-xl font-bold">---</div></div>
        </div>

        <section class="bg-card rounded-lg mb-6 overflow-hidden">
            <div class="p-2 bg-black/20 text-[10px] font-bold uppercase">Positions Running</div>
            <table class="w-full text-[11px] text-left">
                <thead class="text-gray-500"><tr><th class="p-2">Symbol</th><th>Side</th><th>Grids</th><th>Entry</th><th>Price</th><th>ROI</th><th>PnL</th></tr></thead>
                <tbody id="activeBody"></tbody>
            </table>
        </section>

        <section class="bg-card rounded-lg overflow-hidden">
            <div class="p-2 bg-black/20 text-[10px] font-bold uppercase">Trade History</div>
            <table class="w-full text-[10px] text-left">
                <thead class="text-gray-500"><tr><th class="p-2">Time</th><th>Symbol</th><th>Grids</th><th>Margin</th><th>ROI</th><th>PnL</th></tr></thead>
                <tbody id="historyBody"></tbody>
            </table>
        </section>

        <script>
            async function sendCtrl(run){
                const body = { running:run, marginPerGrid:Number(document.getElementById('marginPerGrid').value), maxGrids:Number(document.getElementById('maxGrids').value), stepSize:Number(document.getElementById('stepSize').value), multiplier:Number(document.getElementById('multiplier').value), tpRoi:Number(document.getElementById('tpRoi').value), slRoi:Number(document.getElementById('slRoi').value), mode:document.getElementById('mode').value, maxConcurrentCoins:Number(document.getElementById('maxConcurrentCoins').value) };
                await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
            }
            async function resetAll(){ if(confirm('Xóa sạch dữ liệu?')) await fetch('/api/reset',{method:'POST'}); }
            async function update(){
                const res = await fetch('/api/data'); const d = await res.json();
                ['BTCUSDT','ETHUSDT','BNBUSDT'].forEach(s => { document.getElementById('p-'+s).innerText = d.marketPrices[s]?.toFixed(2) || '---'; });
                document.getElementById('activeBody').innerHTML = d.active.map(p => \`<tr><td class="p-2 font-bold">\${p.symbol}</td><td class="\${p.side==='LONG'?'text-green-500':'text-red-500'}">\${p.side}</td><td>\${p.currentGrid}/\${d.state.maxGrids}</td><td>\${p.avgPrice.toFixed(4)}</td><td>\${d.marketPrices[p.symbol]?.toFixed(4)}</td><td class="\${p.roi>=0?'text-green-500':'text-red-500'}">\${p.roi.toFixed(2)}%</td><td class="\${p.pnl>=0?'text-green-500':'text-red-500'} font-bold">\${p.pnl.toFixed(2)}</td></tr>\`).join('');
                document.getElementById('historyBody').innerHTML = d.history.map(h => \`<tr><td class="p-2 text-gray-500">\${new Date(h.endTime).toLocaleTimeString()}</td><td>\${h.symbol}</td><td>\${h.gridCount}</td><td>\${h.totalMargin.toFixed(2)}</td><td class="\${h.roi>=0?'text-green-500':'text-red-500'}">\${h.roi.toFixed(2)}%</td><td class="\${h.pnl>=0?'text-green-500':'text-red-500'} font-bold">\${h.pnl.toFixed(2)}</td></tr>\`).join('');
                const total = d.history.reduce((s,h)=>s+h.pnl,0); document.getElementById('totalPnl').innerText = total.toFixed(2);
                document.getElementById('totalPnl').className = total >= 0 ? "text-3xl font-bold text-green-500" : "text-3xl font-bold text-red-500";
            }
            setInterval(update, 1000);
        </script>
    </body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log(`Dashboard: http://localhost:${PORT}/gui`); });
