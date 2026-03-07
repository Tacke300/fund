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
    console.log(logEntry);
    logs.unshift(logEntry);
    if (logs.length > 60) logs.pop();
}

if (fs.existsSync(STATE_FILE)) try { Object.assign(botState, JSON.parse(fs.readFileSync(STATE_FILE))); } catch(e){}
if (fs.existsSync(LEVERAGE_FILE)) try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){}

const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(botState));

// LẤY DANH SÁCH COIN & ĐÒN BẨY
async function fetchActualLeverage() {
    logger("Đang kết nối Binance lấy danh sách Coin...", "INFO");
    return new Promise((resolve) => {
        const timestamp = Date.now();
        const query = `timestamp=${timestamp}`;
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        
        const options = {
            hostname: 'fapi.binance.com',
            path: `/fapi/v1/leverageBracket?${query}&signature=${signature}`,
            headers: { 'X-MBX-APIKEY': API_KEY },
            timeout: 5000
        };

        const req = https.get(options, (res) => {
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
                        logger(`Thành công: Đã nạp ${allSymbols.length} Coin. Max Lev chuẩn.`, "INFO");
                    } else {
                        throw new Error("API Trả về lỗi");
                    }
                } catch (e) {
                    logger("Lỗi API Key hoặc Quyền hạn. Sử dụng danh sách mặc định (x20).", "ERR");
                    fallbackSymbols();
                }
                resolve();
            });
        });
        
        req.on('error', (e) => {
            logger("Không kết nối được Binance. Kiểm tra mạng.", "ERR");
            fallbackSymbols();
            resolve();
        });
    });
}

function fallbackSymbols() {
    // Dự phòng nếu API Key lỗi
    allSymbols = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "AVAXUSDT", "DOGEUSDT", "DOTUSDT", "LINKUSDT"];
    allSymbols.forEach(s => { if(!symbolMaxLeverage[s]) symbolMaxLeverage[s] = 20; });
    logger("Đã nạp 10 Coin cơ bản để chạy tạm.", "INFO");
}

function initWS() {
    logger("Đang khởi tạo WebSocket...", "INFO");
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    
    ws.on('open', () => logger("WebSocket đã kết nối. Đang đợi tín hiệu giá...", "INFO"));
    
    ws.on('message', (data) => {
        if (!botState.running) return;

        const tickers = JSON.parse(data);
        tickers.forEach(t => {
            marketPrices[t.s] = parseFloat(t.c);
            const price = marketPrices[t.s];

            if (activePositions[t.s]) {
                const pos = activePositions[t.s];
                const totalMargin = pos.grids.reduce((sum, g) => sum + g.qty, 0);
                const avgPrice = pos.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
                const diffPct = pos.side === 'LONG' ? (price - avgPrice) / avgPrice : (avgPrice - price) / avgPrice;

                // CHỐT LỜI
                if (diffPct * 100 >= botState.tpPercent) {
                    const pnl = totalMargin * diffPct * pos.maxLev;
                    botState.closedPnl += pnl;
                    botState.totalClosedGrids++;
                    logger(`[${t.s}] CHỐT LỜI +${pnl.toFixed(2)}$`, "WIN");
                    delete activePositions[t.s];
                    saveState();
                } 
                // DCA
                else if (pos.grids.length < botState.maxGrids) {
                    const lastPrice = pos.grids[pos.grids.length - 1].price;
                    const gap = pos.side === 'LONG' ? (lastPrice - price) / lastPrice : (price - lastPrice) / lastPrice;
                    if (gap * 100 >= botState.stepSize) {
                        pos.grids.push({ price, qty: pos.grids[pos.grids.length-1].qty * botState.multiplier });
                        logger(`[${t.s}] DCA Lưới ${pos.grids.length} tại ${price}`, "DCA");
                    }
                }
            } else if (allSymbols.includes(t.s)) {
                // MỞ LỆNH MỚI
                const margin = botState.marginType === '$' ? botState.marginValue : (botState.totalBalance * botState.marginValue / 100);
                activePositions[t.s] = {
                    symbol: t.s, side: botState.mode, maxLev: symbolMaxLeverage[t.s] || 20,
                    grids: [{ price, qty: margin }]
                };
                // Log 1 lần khi mở
                if (Object.keys(activePositions).length <= 5) {
                    logger(`Mở lệnh đầu tiên: ${t.s} | Giá: ${price}`, "INFO");
                }
            }
        });
    });

    ws.on('error', (e) => logger("WebSocket Lỗi: " + e.message, "ERR"));
    ws.on('close', () => {
        logger("WebSocket bị đóng. Đang thử kết nối lại...", "ERR");
        setTimeout(initWS, 3000);
    });
}

app.get('/api/data', (req, res) => {
    const activeData = Object.values(activePositions).map(p => {
        const totalMargin = p.grids.reduce((sum, g) => sum + g.qty, 0);
        const avgPrice = p.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
        const currentP = marketPrices[p.symbol] || 0;
        const diff = p.side === 'LONG' ? (currentP - avgPrice) / avgPrice : (avgPrice - currentP) / avgPrice;
        const pnl = totalMargin * diff * p.maxLev;
        const roi = (pnl / botState.totalBalance) * 100;
        return { ...p, avgPrice, totalMargin, currentGrid: p.grids.length, roi, pnl, currentPrice: currentP };
    });
    res.json({ state: botState, active: activeData, logs });
});

app.post('/api/control', (req, res) => { 
    if (req.body.running && !botState.running) {
        botState.startTime = Date.now();
        logger(">>> BẤM START: Đang quét " + allSymbols.length + " coin...", "INFO");
    }
    Object.assign(botState, req.body);
    saveState(); res.json({ status: 'ok' }); 
});

app.post('/api/reset', (req, res) => { 
    activePositions = {}; botState.closedPnl = 0; botState.totalClosedGrids = 0; logs = [];
    logger("!!! RESTART: Đã dọn sạch dữ liệu", "ERR");
    saveState(); res.json({ status: 'ok' }); 
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Matrix v10</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace} th{cursor:pointer;background:#161a1e;padding:12px;border-bottom:1px solid #333}#logBox{background:#000;color:#0ecb81;padding:10px;height:240px;overflow-y:auto;font-size:11px;border:1px solid #333;line-height:1.5}</style>
    </head><body class="p-4 text-[12px]">
        <div class="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4 text-center">
            <div class="bg-[#1e2329] p-3 rounded">UPTIME<div id="uptime" class="text-yellow-500 font-bold">0s</div></div>
            <div class="bg-[#1e2329] p-3 rounded text-blue-400">COINS RUNNING<div id="statCoins" class="text-xl font-bold">0</div></div>
            <div class="bg-[#1e2329] p-3 rounded">GRIDS CLOSED<div id="statGrids" class="text-purple-400 font-bold">0</div></div>
            <div class="bg-[#1e2329] p-3 rounded text-green-500">CLOSED PNL<div id="statClosedPnl" class="font-bold">0.00$</div></div>
            <div class="bg-[#1e2329] p-3 rounded text-gray-400">UNREALIZED PNL<div id="statUnrealized" class="font-bold text-white">0.00$</div></div>
            <div class="bg-[#1e2329] p-3 rounded border-t-2 border-yellow-500">TOTAL ROI<div id="statTotalRoi" class="text-xl font-bold text-green-500">0.00%</div></div>
        </div>
        <div class="bg-[#1e2329] p-4 rounded-lg mb-4 border border-gray-800 grid grid-cols-2 md:grid-cols-7 gap-3">
            <div>VỐN/COIN ($)<input id="totalBalance" type="number" value="\${botState.totalBalance}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>MARGIN<div class="flex"><input id="marginValue" type="number" value="\${botState.marginValue}" class="w-full bg-black text-yellow-500 p-1 rounded"><select id="marginType" class="bg-black text-white"><option value="$" \${botState.marginType==='$'?'selected':''}>$</option><option value="%" \${botState.marginType==='%'?'selected':''}>%</option></select></div></div>
            <div>DCA MAX<input id="maxGrids" type="number" value="\${botState.maxGrids}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>GAP (%)<input id="stepSize" type="number" value="\${botState.stepSize}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>TP (%)<input id="tpPercent" type="number" value="\${botState.tpPercent}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>MODE<select id="mode" class="w-full bg-black p-1 rounded"><option value="LONG" \${botState.mode==='LONG'?'selected':''}>LONG</option><option value="SHORT" \${botState.mode==='SHORT'?'selected':''}>SHORT</option></select></div>
            <div class="flex gap-1 items-end"><button onclick="sendCtrl(true)" class="bg-green-600 p-2 rounded font-bold flex-1">START</button><button onclick="sendCtrl(false)" class="bg-red-600 p-2 rounded font-bold flex-1">STOP</button><button onclick="resetBot()" class="bg-yellow-700 p-2 rounded font-bold text-[9px]">RESET</button></div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div class="md:col-span-3 bg-[#1e2329] rounded-lg border border-gray-800 h-[520px] overflow-y-auto">
                <table class="w-full text-left">
                    <thead class="sticky top-0 bg-[#161a1e]"><tr>
                        <th onclick="setSort('symbol')">SYMBOL ↕</th>
                        <th class="text-right" onclick="setSort('currentPrice')">PRICE ↕</th>
                        <th class="text-right" onclick="setSort('currentGrid')">GRID ↕</th>
                        <th class="text-right" onclick="setSort('roi')">ROI ↕</th>
                        <th class="text-right pr-2" onclick="setSort('pnl')">PNL ↕</th>
                    </tr></thead>
                    <tbody id="activeBody"></tbody>
                </table>
            </div>
            <div id="logBox"></div>
        </div>
        <script>
            let sortKey = 'pnl', sortDir = -1, rawData = [];
            function setSort(k){ if(sortKey===k) sortDir*=-1; else {sortKey=k; sortDir=-1;} render(); }
            async function sendCtrl(run){
                const body = { running:run, totalBalance:Number(document.getElementById('totalBalance').value), marginValue:Number(document.getElementById('marginValue').value), marginType:document.getElementById('marginType').value, maxGrids:Number(document.getElementById('maxGrids').value), stepSize:Number(document.getElementById('stepSize').value), tpPercent:Number(document.getElementById('tpPercent').value), mode:document.getElementById('mode').value, multiplier: 2.0 };
                await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
            }
            async function resetBot(){ if(confirm('RESET?')) await fetch('/api/reset',{method:'POST'}); }
            function render(){
                const sorted = [...rawData].sort((a,b)=> (a[sortKey]>b[sortKey]?1:-1)*sortDir);
                document.getElementById('activeBody').innerHTML = sorted.length ? sorted.map(p=>\`<tr class="border-b border-gray-800">
                    <td class="p-2 font-bold text-yellow-500">\${p.symbol} <span class="text-gray-500">\${p.maxLev}x</span></td>
                    <td class="text-right font-mono text-gray-400">\${p.currentPrice.toFixed(4)}</td>
                    <td class="text-right">\${p.currentGrid}/\${window.maxG}</td>
                    <td class="text-right \${p.roi>=0?'text-green-500':'text-red-500'} font-bold">\${p.roi.toFixed(2)}%</td>
                    <td class="text-right pr-2 font-bold \${p.pnl>=0?'text-green-500':'text-red-500'}">\${p.pnl.toFixed(2)}$</td>
                </tr>\`).join('') : '<tr><td colspan="5" class="p-10 text-center text-gray-500 italic">Đang quét tín hiệu thị trường... Hãy đảm bảo bạn đã bấm START.</td></tr>';
            }
            async function update(){
                try {
                    const res = await fetch('/api/data'); const d = await res.json();
                    rawData = d.active; window.maxG = d.state.maxGrids; render();
                    const unreal = d.active.reduce((s,p)=>s+p.pnl,0);
                    const totalInvested = d.active.length * d.state.totalBalance;
                    const totalRoi = totalInvested > 0 ? ((d.state.closedPnl + unreal) / totalInvested) * 100 : 0;
                    document.getElementById('statCoins').innerText = d.active.length;
                    document.getElementById('statGrids').innerText = d.state.totalClosedGrids;
                    document.getElementById('statClosedPnl').innerText = d.state.closedPnl.toFixed(2) + '$';
                    document.getElementById('statUnrealized').innerText = unreal.toFixed(2) + '$';
                    document.getElementById('statTotalRoi').innerText = totalRoi.toFixed(2) + '%';
                    document.getElementById('logBox').innerHTML = d.logs.join('<br>');
                    if(d.state.startTime){
                        const s = Math.floor((Date.now()-d.state.startTime)/1000);
                        document.getElementById('uptime').innerText = s + "s";
                    }
                } catch(e){}
            }
            setInterval(update, 1000);
        </script>
    </body></html>`);
});

fetchActualLeverage().then(() => {
    initWS();
    app.listen(PORT, '0.0.0.0', () => logger(`BOT MATRIX READY: http://localhost:${PORT}/gui`, "INFO"));
});
