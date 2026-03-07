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
let logs = []; // Lưu log để đẩy lên Web

// Hàm ghi log song song
function logger(msg, type = 'INFO') {
    const time = new Date().toLocaleTimeString();
    const logEntry = `[${time}] [${type}] ${msg}`;
    
    // In ra Terminal có màu (nếu chạy node bình thường)
    const colors = { INFO: '\x1b[36m', WIN: '\x1b[32m', DCA: '\x1b[33m', ERR: '\x1b[31m', RESET: '\x1b[0m' };
    console.log(`${colors[type] || ''}${logEntry}${colors.RESET}`);

    // Lưu vào mảng log (giữ lại 50 dòng mới nhất)
    logs.unshift(logEntry);
    if (logs.length > 50) logs.pop();
}

if (fs.existsSync(STATE_FILE)) {
    try { Object.assign(botState, JSON.parse(fs.readFileSync(STATE_FILE))); } catch(e){}
}
if (fs.existsSync(LEVERAGE_FILE)) {
    try { symbolMaxLeverage = JSON.parse(fs.readFileSync(LEVERAGE_FILE)); } catch(e){}
}

const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(botState));

async function fetchActualLeverage() {
    logger("Đang quét danh sách Leverage từ Binance...", "INFO");
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
                        logger(`Đã sẵn sàng ${allSymbols.length} coin.`, "INFO");
                    } else throw new Error();
                    resolve();
                } catch (e) {
                    logger("API Key lỗi hoặc không có quyền Future. Dùng chế độ dự phòng.", "ERR");
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
                    JSON.parse(data).symbols.forEach(s => {
                        if (s.status === 'TRADING' && s.quoteAsset === 'USDT') {
                            allSymbols.push(s.symbol);
                            symbolMaxLeverage[s.symbol] = 20;
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
    const maxL = symbolMaxLeverage[symbol] || 20;

    activePositions[symbol] = {
        symbol, side: botState.mode, maxLev: maxL,
        grids: [{ price, qty: margin, time: Date.now() }],
    };
    logger(`MỞ LỆNH: ${symbol} | Giá: ${price} | Lev: ${maxL}x`, "INFO");
}

function processGridLogic(symbol, currentPrice) {
    const pos = activePositions[symbol];
    if (!pos || !currentPrice) return;

    const totalMargin = pos.grids.reduce((sum, g) => sum + g.qty, 0);
    const avgPrice = pos.grids.reduce((sum, g) => sum + (g.price * g.qty), 0) / totalMargin;
    const diffPct = pos.side === 'LONG' ? (currentPrice - avgPrice) / avgPrice : (avgPrice - currentPrice) / avgPrice;

    // Chốt lời
    if (diffPct * 100 >= botState.tpPercent) {
        const pnl = totalMargin * (diffPct * pos.maxLev);
        botState.closedPnl += pnl;
        botState.totalClosedGrids += 1;
        logger(`CHỐT LỜI: ${symbol} | Lãi: +${pnl.toFixed(2)}$ | Tổng lưới: ${pos.grids.length}`, "WIN");
        delete activePositions[symbol];
        saveState();
        return;
    }

    // DCA
    if (pos.grids.length < botState.maxGrids) {
        const lastEntry = pos.grids[pos.grids.length - 1].price;
        const gap = pos.side === 'LONG' ? (lastEntry - currentPrice) / lastEntry : (currentPrice - lastEntry) / lastEntry;
        if (gap * 100 >= botState.stepSize) {
            const nextQty = pos.grids[pos.grids.length - 1].qty * botState.multiplier;
            pos.grids.push({ price: currentPrice, qty: nextQty, time: Date.now() });
            logger(`DCA: ${symbol} | Lưới ${pos.grids.length} | Giá: ${currentPrice}`, "DCA");
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
    if (req.body.running && !botState.running) {
        botState.startTime = Date.now();
        logger("BẮT ĐẦU CHẠY BOT", "INFO");
    } else if (!req.body.running && botState.running) {
        logger("DỪNG BOT", "ERR");
    }
    Object.assign(botState, req.body);
    saveState(); res.json({ status: 'ok' }); 
});

app.post('/api/reset', (req, res) => { 
    activePositions = {}; botState.closedPnl = 0; botState.totalClosedGrids = 0; logs = [];
    logger("RESET TOÀN BỘ DỮ LIỆU", "ERR");
    saveState(); res.json({ status: 'ok' }); 
});

app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Matrix v4</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace}.stat-box{background:#1e2329;border:1px solid #2b3139;padding:12px;border-radius:8px}
    #logConsole{background:#000;color:#0ecb81;padding:10px;height:150px;overflow-y:auto;font-size:10px;border:1px solid #333;line-height:1.4}</style>
    </head><body class="p-4 text-[11px]">
        <div class="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
            <div class="stat-box text-center"><div class="text-gray-500 uppercase">Uptime</div><div id="uptime" class="text-yellow-500 font-bold text-sm">0s</div></div>
            <div class="stat-box text-center"><div class="text-gray-500 font-bold text-blue-400 uppercase">Coin chạy</div><div id="statCoins" class="text-xl font-bold">0</div></div>
            <div class="stat-box text-center"><div class="text-gray-500 uppercase">Lưới Chốt</div><div id="statGrids" class="text-purple-400 font-bold text-sm">0</div></div>
            <div class="stat-box text-center"><div class="text-gray-500 uppercase">PnL Chốt</div><div id="statClosedPnl" class="text-green-500 font-bold text-sm">0.00$</div></div>
            <div class="stat-box text-center"><div class="text-gray-500 uppercase">PnL Tạm tính</div><div id="statUnrealized" class="font-bold text-sm">0.00$</div></div>
            <div class="stat-box text-center border-t-2 border-yellow-500"><div class="text-gray-500 uppercase">Tổng ROI %</div><div id="statTotalRoi" class="text-xl font-bold">0.00%</div><div id="statCap" class="text-[9px] text-gray-500">Vốn: 0$</div></div>
        </div>

        <div class="bg-[#1e2329] p-4 rounded-lg mb-4 border border-gray-800 grid grid-cols-2 md:grid-cols-7 gap-3">
            <div>VỐN/COIN ($)<input id="totalBalance" type="number" value="\${botState.totalBalance}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>MARGIN<div class="flex"><input id="marginValue" type="number" value="\${botState.marginValue}" class="w-full bg-black text-yellow-500 p-1 rounded"><select id="marginType" class="bg-black"><option value="$">$</option><option value="%">%</option></select></div></div>
            <div>DCA MAX<input id="maxGrids" type="number" value="\${botState.maxGrids}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>GAP (%)<input id="stepSize" type="number" value="\${botState.stepSize}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>TP (%)<input id="tpPercent" type="number" value="\${botState.tpPercent}" class="w-full bg-black text-yellow-500 p-1 rounded"></div>
            <div>MODE<select id="mode" class="w-full bg-black p-1 rounded"><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></div>
            <div class="flex gap-1 items-end"><button onclick="sendCtrl(true)" class="bg-green-600 p-1 rounded font-bold flex-1 h-8">START</button><button onclick="sendCtrl(false)" class="bg-red-600 p-1 rounded font-bold flex-1 h-8">STOP</button><button onclick="resetAll()" class="bg-gray-700 p-1 rounded h-8 px-2 uppercase">Reset</button></div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
            <div class="md:col-span-3 bg-[#1e2329] rounded-lg border border-gray-800 h-[400px] overflow-y-auto">
                <table class="w-full text-left">
                    <thead class="sticky top-0 bg-[#161a1e]"><tr>
                        <th class="p-2">SYMBOL</th><th class="text-right">PRICE</th><th class="text-right">GRID</th><th class="text-right text-green-500">ROI</th><th class="text-right pr-2">PNL</th>
                    </tr></thead>
                    <tbody id="activeBody"></tbody>
                </table>
            </div>
            <div class="flex flex-col gap-2">
                <div class="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Live Logs Terminal</div>
                <div id="logConsole"></div>
            </div>
        </div>

        <script>
            let lastLog = "";
            async function sendCtrl(run){
                const body = { running:run, totalBalance:Number(document.getElementById('totalBalance').value), marginValue:Number(document.getElementById('marginValue').value), marginType:document.getElementById('marginType').value, maxGrids:Number(document.getElementById('maxGrids').value), stepSize:Number(document.getElementById('stepSize').value), tpPercent:Number(document.getElementById('tpPercent').value), mode:document.getElementById('mode').value, multiplier: 2.0 };
                await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
            }
            async function resetAll(){ if(confirm('Reset stats?')) await fetch('/api/reset',{method:'POST'}); }
            
            async function update(){
                try {
                    const res = await fetch('/api/data'); const d = await res.json();
                    
                    // Render Table
                    document.getElementById('activeBody').innerHTML = d.active.sort((a,b)=>b.pnl-a.pnl).map(p => \`
                    <tr class="border-b border-gray-800">
                        <td class="p-2 font-bold text-yellow-500">\${p.symbol} <span class="text-[9px] text-gray-500">\${p.maxLev}x</span></td>
                        <td class="text-right">\${p.currentPrice.toFixed(4)}</td>
                        <td class="text-right">\${p.currentGrid}/\${d.state.maxGrids}</td>
                        <td class="text-right \${p.roi>=0?'text-green-500':'text-red-500'}">\${p.roi.toFixed(1)}%</td>
                        <td class="text-right pr-2 \${p.pnl>=0?'text-green-500 font-bold':'text-red-500 font-bold'}">\${p.pnl.toFixed(2)}$</td>
                    </tr>\`).join('');

                    // Render Stats
                    const unreal = d.active.reduce((s,p)=>s+p.pnl,0);
                    const totalPnl = d.state.closedPnl + unreal;
                    const totalRoi = d.activeCapital > 0 ? (totalPnl / d.activeCapital) * 100 : 0;
                    
                    document.getElementById('statCoins').innerText = d.active.length;
                    document.getElementById('statGrids').innerText = d.state.totalClosedGrids;
                    document.getElementById('statClosedPnl').innerText = d.state.closedPnl.toFixed(2) + '$';
                    document.getElementById('statUnrealized').innerText = unreal.toFixed(2) + '$';
                    document.getElementById('statTotalRoi').innerText = totalRoi.toFixed(2) + '%';
                    document.getElementById('statCap').innerText = "Vốn thực tế: " + d.activeCapital.toLocaleString() + "$";

                    // Render Logs
                    const logStr = d.logs.join('<br>');
                    if(logStr !== lastLog) {
                        document.getElementById('logConsole').innerHTML = logStr;
                        lastLog = logStr;
                    }

                    if(d.state.startTime) {
                        const diff = Math.floor((Date.now() - d.state.startTime) / 1000);
                        document.getElementById('uptime').innerText = diff + "s";
                    }
                } catch(e){}
            }
            setInterval(update, 1000);
        </script>
    </body></html>`);
});

fetchActualLeverage().then(() => {
    initWS();
    app.listen(PORT, '0.0.0.0', () => logger(`Bot Matrix Live tại http://localhost:${PORT}/gui`, "INFO"));
});
