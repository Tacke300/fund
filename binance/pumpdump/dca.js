import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { API_KEY, SECRET_KEY } from './config.js';

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
let logs = [];

function logger(msg, type = 'INFO') {
    const logEntry = `[${new Date().toLocaleTimeString()}] [${type}] ${msg}`;
    const colors = { INFO: '\x1b[36m', WIN: '\x1b[32m', DCA: '\x1b[33m', ERR: '\x1b[31m', RESET: '\x1b[0m' };
    console.log(`${colors[type] || ''}${logEntry}${colors.RESET}`);
    logs.unshift(logEntry);
    if (logs.length > 50) logs.pop();
}

// Load Data
if (fs.existsSync(STATE_FILE)) try { Object.assign(botState, JSON.parse(fs.readFileSync(STATE_FILE))); } catch(e){}
if (fs.existsSync(LEVERAGE_FILE)) try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){}

const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(botState));

// LẤY LEVERAGE TỪ BINANCE (FIXED)
async function fetchActualLeverage() {
    return new Promise((resolve) => {
        const timestamp = Date.now();
        const query = `timestamp=${timestamp}`;
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const options = {
            hostname: 'fapi.binance.com', path: `/fapi/v1/leverageBracket?${query}&signature=${signature}`,
            headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 5000
        };
        https.get(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const brackets = JSON.parse(data);
                    if (Array.isArray(brackets)) {
                        brackets.forEach(item => {
                            symbolMaxLeverage[item.symbol] = item.brackets[0].initialLeverage;
                            if (!allSymbols.includes(item.symbol)) allSymbols.push(item.symbol);
                        });
                        fs.writeFileSync(LEVERAGE_FILE, JSON.stringify(symbolMaxLeverage));
                        logger(`Đã nạp ${allSymbols.length} coin với Max Lev chuẩn Binance.`, "INFO");
                    } else throw new Error();
                    resolve();
                } catch (e) {
                    logger("API Key lỗi, sử dụng danh sách coin mặc định x20.", "ERR");
                    fallbackSymbols().then(resolve);
                }
            });
        }).on('error', () => fallbackSymbols().then(resolve));
    });
}

async function fallbackSymbols() {
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
                            if(!symbolMaxLeverage[s.symbol]) symbolMaxLeverage[s.symbol] = 20;
                        }
                    });
                } catch(e) {}
                resolve();
            });
        });
    });
}

function startNewGrid(symbol, price) {
    if (!botState.running || activePositions[symbol]) return;
    const margin = botState.marginType === '$' ? botState.marginValue : (botState.totalBalance * botState.marginValue / 100);
    const maxL = symbolMaxLeverage[symbol] || 20; // Đã ưu tiên lấy từ Binance

    activePositions[symbol] = {
        symbol, side: botState.mode, maxLev: maxL,
        grids: [{ price, qty: margin, time: Date.now() }],
    };
}

function processGridLogic(symbol, currentPrice) {
    const pos = activePositions[symbol];
    if (!pos || !currentPrice) return;
    const totalMargin = pos.grids.reduce((sum, g) => sum + g.qty, 0);
    const avgPrice = pos.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
    const diffPct = pos.side === 'LONG' ? (currentPrice - avgPrice) / avgPrice : (avgPrice - currentPrice) / avgPrice;

    if (diffPct * 100 >= botState.tpPercent) {
        const pnl = totalMargin * (diffPct * pos.maxLev);
        botState.closedPnl += pnl;
        botState.totalClosedGrids += 1;
        logger(`CHỐT LỜI: ${symbol} | Lãi: +${pnl.toFixed(2)}$`, "WIN");
        delete activePositions[symbol];
        saveState();
        return;
    }

    if (pos.grids.length < botState.maxGrids) {
        const lastEntry = pos.grids[pos.grids.length - 1].price;
        const gap = pos.side === 'LONG' ? (lastEntry - currentPrice) / lastEntry : (currentPrice - lastEntry) / lastEntry;
        if (gap * 100 >= botState.stepSize) {
            pos.grids.push({ price: currentPrice, qty: pos.grids[pos.grids.length-1].qty * botState.multiplier, time: Date.now() });
            logger(`DCA: ${symbol} Lưới ${pos.grids.length}`, "DCA");
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
        const currentP = marketPrices[p.symbol] || 0;
        const roi = (p.side === 'LONG' ? (currentP - avgPrice) / avgPrice : (avgPrice - currentP) / avgPrice) * p.maxLev * 100;
        return { ...p, avgPrice, totalMargin, currentGrid: p.grids.length, roi, pnl: totalMargin * (roi/100), currentPrice: currentP };
    });
    res.json({ state: botState, active: activeData, activeCapital: activeData.length * marginPerCoin, logs });
});

app.post('/api/control', (req, res) => { 
    if (req.body.running && !botState.running) botState.startTime = Date.now();
    Object.assign(botState, req.body);
    saveState(); res.json({ status: 'ok' }); 
});

app.post('/api/reset', (req, res) => { 
    activePositions = {}; botState.closedPnl = 0; botState.totalClosedGrids = 0; logs = [];
    saveState(); res.json({ status: 'ok' }); 
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Matrix v5</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace}th{cursor:pointer;background:#161a1e;padding:12px 8px;border-bottom:1px solid #2b3139}th:hover{color:#f0b90b}#logConsole{background:#000;color:#0ecb81;padding:10px;height:180px;overflow-y:auto;font-size:10px;border:1px solid #333}</style>
    </head><body class="p-4 text-[11px]">
        
        <div class="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4 text-center">
            <div class="stat-box bg-[#1e2329] p-3 rounded"><div class="text-gray-500 uppercase">Uptime</div><div id="uptime" class="text-yellow-500 font-bold">0s</div></div>
            <div class="stat-box bg-[#1e2329] p-3 rounded"><div class="text-blue-400 font-bold uppercase">Coin Chạy</div><div id="statCoins" class="text-xl font-bold">0</div></div>
            <div class="stat-box bg-[#1e2329] p-3 rounded"><div class="text-gray-500 uppercase">Lưới Chốt</div><div id="statGrids" class="text-purple-400 font-bold">0</div></div>
            <div class="stat-box bg-[#1e2329] p-3 rounded"><div class="text-gray-500 uppercase">PnL Chốt</div><div id="statClosedPnl" class="text-green-500 font-bold">0.00$</div></div>
            <div class="stat-box bg-[#1e2329] p-3 rounded"><div class="text-gray-500 uppercase">PnL Tạm</div><div id="statUnrealized" class="font-bold">0.00$</div></div>
            <div class="stat-box bg-[#1e2329] p-3 rounded border-t-2 border-yellow-500"><div class="text-gray-500 uppercase">ROI Tổng</div><div id="statTotalRoi" class="text-xl font-bold">0.00%</div></div>
        </div>

        <div class="bg-[#1e2329] p-4 rounded-lg mb-4 border border-gray-800 grid grid-cols-2 md:grid-cols-7 gap-3">
            <div>VỐN/COIN ($)<input id="totalBalance" type="number" value="\${botState.totalBalance}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>MARGIN<div class="flex"><input id="marginValue" type="number" value="\${botState.marginValue}" class="w-full bg-black text-yellow-500 p-1 rounded"><select id="marginType" class="bg-black text-white"><option value="$" \${botState.marginType==='$'?'selected':''}>$</option><option value="%" \${botState.marginType==='%'?'selected':''}>%</option></select></div></div>
            <div>DCA MAX<input id="maxGrids" type="number" value="\${botState.maxGrids}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>GAP (%)<input id="stepSize" type="number" value="\${botState.stepSize}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>TP (%)<input id="tpPercent" type="number" value="\${botState.tpPercent}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>MODE<select id="mode" class="w-full bg-black p-1 rounded"><option value="LONG" \${botState.mode==='LONG'?'selected':''}>LONG</option><option value="SHORT" \${botState.mode==='SHORT'?'selected':''}>SHORT</option></select></div>
            <div class="flex gap-1 items-end"><button onclick="sendCtrl(true)" class="bg-green-600 p-1 rounded font-bold flex-1 h-8">START</button><button onclick="sendCtrl(false)" class="bg-red-600 p-1 rounded font-bold flex-1 h-8">STOP</button><button onclick="resetAll()" class="bg-gray-700 p-1 rounded h-8 px-2 uppercase text-[9px]">Reset</button></div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div class="md:col-span-3 bg-[#1e2329] rounded-lg border border-gray-800 h-[500px] overflow-hidden flex flex-col">
                <div class="overflow-y-auto flex-1">
                    <table class="w-full text-left">
                        <thead class="sticky top-0 bg-[#161a1e] z-10"><tr>
                            <th onclick="setSort('symbol')">SYMBOL ↕</th>
                            <th class="text-right" onclick="setSort('currentPrice')">PRICE ↕</th>
                            <th class="text-right" onclick="setSort('currentGrid')">GRID ↕</th>
                            <th class="text-right" onclick="setSort('roi')">ROI ↕</th>
                            <th class="text-right pr-2" onclick="setSort('pnl')">PNL ↕</th>
                        </tr></thead>
                        <tbody id="activeBody"></tbody>
                    </table>
                </div>
            </div>
            <div class="flex flex-col gap-2">
                <div class="text-[10px] text-gray-500 font-bold uppercase">Live Logs</div>
                <div id="logConsole"></div>
            </div>
        </div>

        <script>
            let sortKey = 'pnl', sortDir = -1, rawData = [], lastLog = "";
            function setSort(k) { if(sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = -1; } render(); }

            async function sendCtrl(run){
                const body = { running:run, totalBalance:Number(document.getElementById('totalBalance').value), marginValue:Number(document.getElementById('marginValue').value), marginType:document.getElementById('marginType').value, maxGrids:Number(document.getElementById('maxGrids').value), stepSize:Number(document.getElementById('stepSize').value), tpPercent:Number(document.getElementById('tpPercent').value), mode:document.getElementById('mode').value, multiplier: 2.0 };
                await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
            }
            async function resetAll(){ if(confirm('Xóa sạch dữ liệu?')) await fetch('/api/reset',{method:'POST'}); }
            
            function render() {
                const sorted = [...rawData].sort((a,b) => {
                    let vA = a[sortKey], vB = b[sortKey];
                    return typeof vA === 'string' ? (sortDir === 1 ? vA.localeCompare(vB) : vB.localeCompare(vA)) : (vA - vB) * sortDir;
                });
                document.getElementById('activeBody').innerHTML = sorted.map(p => \`
                <tr class="border-b border-gray-800">
                    <td class="p-2 font-bold text-yellow-500">\${p.symbol} <span class="text-[9px] text-gray-500">\${p.maxLev}x</span></td>
                    <td class="text-right font-mono">\${p.currentPrice.toFixed(4)}</td>
                    <td class="text-right">\${p.currentGrid}/\${window.maxG}</td>
                    <td class="text-right \${p.roi>=0?'text-green-500':'text-red-500'} font-bold">\${p.roi.toFixed(1)}%</td>
                    <td class="text-right pr-2 \${p.pnl>=0?'text-green-500':'text-red-500'} font-bold">\${p.pnl.toFixed(2)}$</td>
                </tr>\`).join('');
            }

            async function update(){
                try {
                    const res = await fetch('/api/data'); const d = await res.json();
                    rawData = d.active; window.maxG = d.state.maxGrids;
                    render();
                    
                    const unreal = d.active.reduce((s,p)=>s+p.pnl,0);
                    const totalPnl = d.state.closedPnl + unreal;
                    const totalRoi = d.activeCapital > 0 ? (totalPnl / d.activeCapital) * 100 : 0;

                    document.getElementById('statCoins').innerText = d.active.length;
                    document.getElementById('statGrids').innerText = d.state.totalClosedGrids;
                    document.getElementById('statClosedPnl').innerText = d.state.closedPnl.toFixed(2) + '$';
                    document.getElementById('statUnrealized').innerText = unreal.toFixed(2) + '$';
                    document.getElementById('statTotalRoi').innerText = totalRoi.toFixed(2) + '%';
                    document.getElementById('statTotalRoi').className = "text-xl font-bold " + (totalRoi >= 0 ? 'text-green-500' : 'text-red-500');

                    if(d.logs.join('') !== lastLog) {
                        document.getElementById('logConsole').innerHTML = d.logs.join('<br>');
                        lastLog = d.logs.join('');
                    }

                    if(d.state.startTime) {
                        const s = Math.floor((Date.now() - d.state.startTime)/1000);
                        document.getElementById('uptime').innerText = Math.floor(s/3600) + "h " + Math.floor((s%3600)/60) + "m " + (s%60) + "s";
                    }
                } catch(e){}
            }
            setInterval(update, 1000);
        </script>
    </body></html>`);
});

fetchActualLeverage().then(() => {
    initWS();
    app.listen(PORT, '0.0.0.0', () => logger(`Bot chạy tại http://localhost:${PORT}/gui`, "INFO"));
});
