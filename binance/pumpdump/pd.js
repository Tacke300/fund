import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- CẤU HÌNH HỆ THỐNG ---
let botSettings = { 
    isRunning: false, 
    maxPositions: 10, 
    invValue: 1.5, 
    invType: 'percent', 
    minVol: 5.0, 
    accountSL: 30 
};

let status = { 
    currentBalance: 0, 
    botLogs: [], 
    exchangeInfo: {}, 
    candidatesList: [], 
    topOpportunities: [] 
};

let botManagedSymbols = []; 
let isInitializing = true;
let isProcessing = false;
let coinCooldowns = new Map(); 
let lastLogMessage = ""; 

// --- HÀM LOG CHỐNG SPAM ---
function addBotLog(msg, type = 'info') {
    if (msg === lastLogMessage) return;
    lastLogMessage = msg;
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    
    const colors = { success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m' };
    console.log(`${colors[type] || colors.info}[${time}] ${msg}\x1b[0m`);
}

// --- KẾT NỐI BINANCE ---
async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 8000 }, res => {
            let d = ''; res.on('data', chunk => d += chunk);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(j); else reject(j);
                } catch (e) { reject({ msg: "LỖI_JSON" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

// --- 1. DỌN DẸP VỊ THẾ & XÓA LỆNH CHỜ ---
async function cleanupClosedPositions() {
    if (!botSettings.isRunning) return;
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const now = Date.now();

        for (let i = botManagedSymbols.length - 1; i >= 0; i--) {
            const symbol = botManagedSymbols[i];
            const p = positions.find(pos => pos.symbol === symbol);
            
            if (!p || parseFloat(p.positionAmt) === 0) {
                addBotLog(`🧹 [DỌN DẸP] ${symbol} đã đóng. Xóa lệnh chờ & nghỉ 15p.`, "info");
                coinCooldowns.set(symbol, now);
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(() => {});
                botManagedSymbols.splice(i, 1);
            }
        }
    } catch (e) {}
}

// --- 2. TÍNH TOÁN & CÀI ĐẶT TP/SL ---
async function enforceTPSL() {
    if (!botSettings.isRunning) return;
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const orders = await callBinance('/fapi/v1/openOrders');

        for (const symbol of botManagedSymbols) {
            const p = positions.find(pos => pos.symbol === symbol && parseFloat(pos.positionAmt) !== 0);
            if (!p) continue;

            const hasTP = orders.some(o => o.symbol === symbol && o.type === 'TAKE_PROFIT_MARKET');
            if (!hasTP) {
                const entry = parseFloat(p.entryPrice);
                const side = p.positionSide;
                const info = status.exchangeInfo[symbol];
                const lev = parseFloat(p.leverage);
                
                let m = lev < 26 ? 1.5 : 2.5; 
                const rate = m / lev;
                const tp = side === 'LONG' ? entry * (1 + rate) : entry * (1 - rate);
                const sl = side === 'LONG' ? entry * (1 - rate) : entry * (1 + rate);
                
                const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

                await callBinance('/fapi/v1/order', 'POST', {
                    symbol, side: closeSide, positionSide: side, type: 'TAKE_PROFIT_MARKET',
                    stopPrice: tp.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE'
                }).catch(()=>{});

                await callBinance('/fapi/v1/order', 'POST', {
                    symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET',
                    stopPrice: sl.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE'
                }).catch(()=>{});

                addBotLog(`🎯 Đã cài TP/SL cho ${symbol}`, "success");
            }
        }
    } catch (e) {}
}

// --- 3. HÀM SĂN LỆNH (OR 1-5-15P + XÓA LỆNH CHỜ TRƯỚC KHI MỞ) ---
async function hunt() {
    if (isInitializing || !botSettings.isRunning || isProcessing) return;

    try {
        isProcessing = true;
        if (botManagedSymbols.length >= botSettings.maxPositions) return;

        for (const c of status.candidatesList) {
            if (botManagedSymbols.includes(c.symbol) || botManagedSymbols.length >= botSettings.maxPositions) continue;

            // Xóa sạch lệnh chờ cũ của coin này trước khi vào lệnh mới
            await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol: c.symbol }).catch(() => {});
            
            // Lấy đòn bẩy tối đa cho phép
            const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
            const lev = Math.min(20, brackets[0].brackets[0].initialLeverage);
            await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });

            // Tính toán khối lượng
            const acc = await callBinance('/fapi/v2/account');
            status.currentBalance = parseFloat(acc.totalMarginBalance);
            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
            const info = status.exchangeInfo[c.symbol];
            
            let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
            let qty = (margin * lev) / parseFloat(ticker.price);
            const finalQty = (Math.floor(qty / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

            // Xác định Long/Short dựa trên điều kiện OR
            const isLong = (c.c1 >= botSettings.minVol || c.c5 >= botSettings.minVol || c.c15 >= botSettings.minVol);
            const side = isLong ? 'BUY' : 'SELL';
            const posSide = isLong ? 'LONG' : 'SHORT';

            await callBinance('/fapi/v1/order', 'POST', {
                symbol: c.symbol, side: side, positionSide: posSide, type: 'MARKET', quantity: finalQty
            });

            botManagedSymbols.push(c.symbol);
            addBotLog(`🚀 [LỆNH MỞ] ${posSide} ${c.symbol} thành công!`, "success");
            
            // Đợi 2s để Binance cập nhật vị thế rồi cài TP/SL
            setTimeout(enforceTPSL, 2000);
        }
    } catch (e) {
        addBotLog(`❌ Lỗi vào lệnh: ${e.msg || "API"}`, "error");
    } finally {
        isProcessing = false;
    }
}

// --- 4. LẤY TÍN HIỆU & TOP 5 CƠ HỘI ---
function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const raw = JSON.parse(d);
                const all = raw.live || [];
                const now = Date.now();

                // Top 5 cơ hội (Không lọc ngưỡng)
                status.topOpportunities = [...all]
                    .sort((a, b) => Math.max(Math.abs(b.c1), Math.abs(b.c5)) - Math.max(Math.abs(a.c1), Math.abs(a.c5)))
                    .slice(0, 5)
                    .map(item => ({
                        symbol: item.symbol,
                        change: item.c5.toFixed(2),
                        advice: item.c5 > 0 ? 'LONG' : 'SHORT'
                    }));

                // Danh sách lọc vào lệnh (OR 1-5-15p + Cooldown)
                status.candidatesList = all.filter(c => {
                    if (coinCooldowns.has(c.symbol)) {
                        if (now - coinCooldowns.get(c.symbol) < 15 * 60 * 1000) return false;
                        else coinCooldowns.delete(c.symbol);
                    }
                    return Math.abs(c.c1) >= botSettings.minVol || 
                           Math.abs(c.c5) >= botSettings.minVol || 
                           Math.abs(c.c15) >= botSettings.minVol;
                }).slice(0, 10);

            } catch (e) {}
        });
    }).on('error', () => {});
}

// --- 5. GIAO DIỆN WEB (EXPRESS) ---
const APP = express();
APP.use(express.json());

APP.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <title>LUFFY BOT - PIRATE KING</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Bangers&family=JetBrains+Mono&display=swap');
            body { background: #050507; color: #eee; font-family: 'Inter', sans-serif; overflow: hidden; height: 100vh; display: flex; flex-direction: column; }
            .luffy-font { font-family: 'Bangers', cursive; letter-spacing: 2px; }
            .mono { font-family: 'JetBrains Mono', monospace; }
            .card { background: rgba(20, 20, 25, 0.8); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 12px; }
            .opp-card { background: linear-gradient(145deg, #1a1a20, #0a0a0c); border-left: 3px solid #ef4444; transition: all 0.3s; }
            .opp-card.up { border-left-color: #22c55e; }
            ::-webkit-scrollbar { width: 4px; }
            ::-webkit-scrollbar-thumb { background: #ef4444; border-radius: 10px; }
        </style>
    </head>
    <body class="p-4 flex flex-col gap-4">
        <header class="flex justify-between items-center p-4 card border-b-2 border-red-600">
            <div class="flex items-center gap-4">
                <div class="text-4xl luffy-font text-white uppercase italic tracking-widest">LUFFY <span class="text-red-600">BOT</span></div>
                <div id="botStatusText" class="text-[10px] font-bold text-zinc-500 uppercase px-2 py-1 bg-black rounded">Scanning...</div>
            </div>
            <div class="flex gap-10">
                <div class="text-right"><p class="text-[9px] text-zinc-500 uppercase">Balance</p><p id="balance" class="text-3xl font-black text-yellow-500 mono">$0.00</p></div>
                <div class="text-right"><p class="text-[9px] text-zinc-500 uppercase">Positions</p><p id="posCount" class="text-3xl font-black text-blue-500 mono">0</p></div>
            </div>
        </header>

        <div class="grid grid-cols-5 gap-3">
            <div class="col-span-5 text-[10px] font-bold text-zinc-500 uppercase mb-[-5px] ml-1">🚀 Top 5 Cơ Hội Biến Động</div>
            <div id="oppContainer" class="col-span-5 grid grid-cols-5 gap-3"></div>
        </div>

        <div class="grid grid-cols-6 gap-3">
            <div class="card p-2"><label class="text-[9px] text-zinc-500 block uppercase">Vốn Ký Quỹ %</label><input type="number" id="invValue" class="bg-transparent w-full mono text-xs" value="1.5"></div>
            <div class="card p-2"><label class="text-[9px] text-zinc-500 block uppercase">Ngưỡng Vol %</label><input type="number" id="minVol" class="bg-transparent w-full mono text-xs text-red-500 font-bold" value="5.0"></div>
            <div class="card p-2"><label class="text-[9px] text-zinc-500 block uppercase">Số Lệnh Max</label><input type="number" id="maxPositions" class="bg-transparent w-full mono text-xs" value="10"></div>
            <div class="card p-2"><label class="text-[9px] text-zinc-500 block uppercase">Stop Loss %</label><input type="number" id="accountSL" class="bg-transparent w-full mono text-xs text-orange-400" value="30"></div>
            <button id="runBtn" onclick="handleToggle()" class="col-span-1 bg-red-600 rounded-xl font-black text-[11px] uppercase italic">Giương Buồm</button>
            <button onclick="handleUpdate()" class="card text-[11px] font-bold uppercase hover:bg-zinc-800">Cập Nhật</button>
        </div>

        <div class="flex-grow grid grid-cols-12 gap-4 overflow-hidden">
            <div class="col-span-4 card flex flex-col overflow-hidden">
                <div class="p-2 border-b border-white/5 text-[9px] font-bold text-zinc-500 uppercase">Nhật ký hải trình</div>
                <div id="botLogs" class="flex-grow p-3 mono text-[10px] overflow-y-auto space-y-1"></div>
            </div>
            <div class="col-span-8 card overflow-hidden flex flex-col">
                <table class="w-full text-left text-[11px] mono">
                    <thead class="bg-zinc-900/50 border-b border-white/5 text-[9px] text-zinc-500 uppercase">
                        <tr><th class="p-3">Coin</th><th class="p-3">Side</th><th class="p-3">Entry/Mark Price</th><th class="p-3 text-right">PnL%</th></tr>
                    </thead>
                    <tbody id="positionTable" class="divide-y divide-white/5"></tbody>
                </table>
            </div>
        </div>

        <script>
            let isRunning = false;
            async function sync() {
                try {
                    const res = await fetch('/api/status');
                    const data = await res.json();
                    
                    // Render Opportunities
                    document.getElementById('oppContainer').innerHTML = data.status.topOpportunities.map(o => \`
                        <div class="opp-card \${parseFloat(o.change) > 0 ? 'up' : ''} p-2 rounded-lg relative">
                            <div class="text-[10px] font-black text-white italic opacity-80">\${o.symbol}</div>
                            <div class="flex justify-between items-center">
                                <span class="text-xs font-bold \${parseFloat(o.change) > 0 ? 'text-green-500' : 'text-red-500'}">\${o.change}%</span>
                                <span class="text-[9px] font-black uppercase \${parseFloat(o.change) > 0 ? 'text-green-900 bg-green-400' : 'text-red-900 bg-red-400'} px-1 rounded">\${o.advice}</span>
                            </div>
                        </div>
                    \`).join('');

                    isRunning = data.botSettings.isRunning;
                    const btn = document.getElementById('runBtn');
                    btn.innerText = isRunning ? "Hạ Buồm" : "Giương Buồm";
                    btn.className = isRunning ? "col-span-1 bg-zinc-800 border border-red-600/50 text-red-500 rounded-xl font-black text-[11px] uppercase italic" : "col-span-1 bg-red-600 rounded-xl font-black text-[11px] uppercase italic";
                    
                    document.getElementById('botStatusText').innerText = isRunning ? "Active Patrolling" : "Offline";
                    document.getElementById('balance').innerText = "$" + (data.status.currentBalance || 0).toFixed(2);
                    document.getElementById('posCount').innerText = data.activePositions.length;
                    
                    document.getElementById('botLogs').innerHTML = data.status.botLogs.map(l => \`<div><span class="text-zinc-600">[\${l.time}]</span> \${l.msg}</div>\`).join('');
                    document.getElementById('positionTable').innerHTML = data.activePositions.map(p => \`
                        <tr>
                            <td class="p-3 font-bold text-white">\${p.symbol}</td>
                            <td class="p-3 \${p.side==='LONG'?'text-green-500':'text-red-500'} font-black italic">\${p.side}</td>
                            <td class="p-3 text-zinc-500 text-[10px]">\${p.entryPrice} <span class="mx-1">→</span> \${p.markPrice}</td>
                            <td class="p-3 text-right font-black \${parseFloat(p.pnlPercent)>=0?'text-green-500':'text-red-500'}">\${p.pnlPercent}%</td>
                        </tr>
                    \`).join('');
                } catch(e){}
            }
            async function handleToggle() { 
                isRunning = !isRunning; 
                await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ isRunning }) }); 
            }
            async function handleUpdate() {
                const body = { 
                    invValue: parseFloat(document.getElementById('invValue').value), 
                    minVol: parseFloat(document.getElementById('minVol').value), 
                    maxPositions: parseInt(document.getElementById('maxPositions').value), 
                    accountSL: parseFloat(document.getElementById('accountSL').value) 
                };
                await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
            }
            setInterval(sync, 2000); sync();
        </script>
    </body>
    </html>
    `);
});

APP.get('/api/status', async (req, res) => {
    try {
        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
            const entry = parseFloat(p.entryPrice);
            const amt = Math.abs(parseFloat(p.positionAmt));
            const pnl = (entry > 0) ? ((parseFloat(p.unrealizedProfit) / ((entry * amt) / p.leverage)) * 100).toFixed(2) : "0.00";
            return { symbol: p.symbol, side: p.positionSide, entryPrice: p.entryPrice, markPrice: p.markPrice, pnlPercent: pnl };
        });
        res.json({ botSettings, status, activePositions: active });
    } catch (e) { res.status(500).send(); }
});

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    res.json({ status: "ok" });
});

// --- KHỞI CHẠY ---
async function init() {
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
            const info = JSON.parse(d);
            info.symbols.forEach(s => {
                const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
                status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize) };
            });
            isInitializing = false;
            addBotLog("⚓ Hệ thống hải quân sẵn sàng ra khơi.", "success");
        });
    });
}

init();
setInterval(fetchCandidates, 3000);  
setInterval(hunt, 2000);            
setInterval(cleanupClosedPositions, 5000); 
setInterval(enforceTPSL, 10000);     

APP.listen(9001, '0.0.0.0');
