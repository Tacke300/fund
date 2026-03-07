import express from 'express';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
app.use(express.json({ limit: '100mb' }));

const PORT = 7000; // Đảm bảo cổng này chưa có ai dùng
const DATA_DIR = './candle_data';
const LEVERAGE_FILE = './leverage_cache.json';

// Cấu hình y hệt bản Live của bạn
let botState = { 
    running: false, marginValue: 10, maxGrids: 5, 
    stepSize: 1.0, tpPercent: 1.0, mode: 'LONG', userLeverage: 125 
};

let cachedData = {}; 
let symbolMaxLeverage = {}; 
let logs = [];
let analysisResults = [];

function logger(msg, type = 'INFO') {
    const time = new Date().toLocaleTimeString();
    logs.unshift(`[${time}] [${type}] ${msg}`);
    if (logs.length > 100) logs.pop();
    console.log(`[${time}] ${msg}`);
}

// 1. LẤY LEVERAGE CHUẨN TỪ BINANCE (Sửa lỗi thiếu Signature)
async function fetchActualLeverage() {
    return new Promise((resolve) => {
        const timestamp = Date.now();
        const query = `timestamp=${timestamp}`;
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        
        const options = {
            hostname: 'fapi.binance.com',
            path: `/fapi/v1/leverageBracket?${query}&signature=${signature}`,
            headers: { 'X-MBX-APIKEY': API_KEY },
            timeout: 10000
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
                        });
                        fs.writeFileSync(LEVERAGE_FILE, JSON.stringify(symbolMaxLeverage));
                        logger("Đã cập nhật Leverage thực tế.", "WIN");
                    }
                } catch (e) { logger("Lỗi giải mã Leverage. Kiểm tra API Key!", "ERR"); }
                resolve();
            });
        }).on('error', (e) => { logger("Lỗi kết nối Binance: " + e.message, "ERR"); resolve(); });
    });
}

// 2. NẠP DỮ LIỆU TỪ JSON VÀO RAM (CHỐNG LAG)
async function preloadData() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR);
        logger("Thư mục candle_data trống! Hãy bỏ file json vào.", "ERR");
        return;
    }
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    if (files.length === 0) return logger("Không tìm thấy file .json nào trong candle_data!", "ERR");

    logger(`Đang nạp ${files.length} coin vào RAM...`, "INFO");
    for (const file of files) {
        const symbol = file.replace('.json', '');
        const content = fs.readFileSync(path.join(DATA_DIR, file));
        cachedData[symbol] = JSON.parse(content);
    }
    logger("Nạp RAM hoàn tất. Sẵn sàng phân tích!", "WIN");
}

// 3. LOGIC PHÂN TÍCH QUÁ KHỨ (Vốn gốc = margin * lev * grids)
async function runAnalysis() {
    const rangeDays = 30; // Mặc định 30 ngày gần nhất
    const endTs = Date.now();
    const startTs = endTs - (rangeDays * 24 * 60 * 60 * 1000);
    
    analysisResults = [];
    const symbols = Object.keys(cachedData);

    for (const symbol of symbols) {
        // Lọc nến theo thời gian
        const rawData = cachedData[symbol].filter(k => k[0] >= startTs);
        if (rawData.length === 0) continue;

        const maxLev = symbolMaxLeverage[symbol] || 20;
        const finalLev = Math.min(botState.userLeverage, maxLev);
        const capitalGoc = botState.marginValue * finalLev * botState.maxGrids; 

        let pos = null, closedPnl = 0, winCount = 0;

        for (const k of rawData) {
            const [time, open, high, low, close] = k.map(Number);
            
            if (!pos) {
                pos = { entry: close, grids: [close] };
            } else {
                const avg = pos.entry;
                const pnlPct = botState.mode === 'LONG' ? (high - avg) / avg : (avg - low) / avg;

                if (pnlPct * 100 >= botState.tpPercent) {
                    const pnl = (pos.grids.length * botState.marginValue * finalLev) * (botState.tpPercent / 100);
                    closedPnl += pnl; winCount++;
                    pos = null;
                } else if (pos.grids.length < botState.maxGrids) {
                    const lastPrice = pos.grids[pos.grids.length - 1];
                    const gap = botState.mode === 'LONG' ? (lastPrice - low) / lastPrice : (high - lastPrice) / lastPrice;
                    
                    if (gap * 100 >= botState.stepSize) {
                        const newEntry = lastPrice * (botState.mode === 'LONG' ? (1 - botState.stepSize/100) : (1 + botState.stepSize/100));
                        pos.grids.push(newEntry);
                        pos.entry = pos.grids.reduce((a, b) => a + b, 0) / pos.grids.length;
                    }
                }
            }
        }

        if (winCount > 0) {
            analysisResults.push({
                symbol, closedCount: winCount, maxLev: finalLev,
                totalClosedPnl: closedPnl,
                capitalGoc: capitalGoc,
                totalRoi: (closedPnl / capitalGoc) * 100
            });
        }
        await new Promise(r => setImmediate(r)); 
    }
    logger(`Xong! Phân tích được ${analysisResults.length} cặp tiền.`, "WIN");
}

app.get('/api/data', (req, res) => {
    res.json({ 
        state: botState, active: analysisResults, logs, 
        stats: { closedPnl: analysisResults.reduce((a,b)=>a+b.totalClosedPnl,0) } 
    });
});

app.post('/api/control', async (req, res) => { 
    Object.assign(botState, req.body);
    if (req.body.running) await runAnalysis();
    res.json({ status: 'ok' }); 
});

// GIAO DIỆN CHUẨN LUFFY
app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Backtest</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace} th{background:#161a1e;padding:12px 8px;border-bottom:1px solid #333;font-size:10px}</style>
    </head><body class="p-4 text-[11px]">
        <div class="bg-[#1e2329] p-4 rounded-lg mb-2 border border-yellow-500/20 flex flex-wrap items-end gap-3 shadow-xl">
            <div class="w-[100px]">MARGIN ($)<input id="marginValue" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[70px]">MAX DCA<input id="maxGrids" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[70px]">GAP %<input id="stepSize" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[70px]">TP %<input id="tpPercent" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[90px]">HƯỚNG<select id="mode" class="w-full bg-black p-2 rounded border border-gray-700 mt-1 text-yellow-500"><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></div>
            <div class="w-[90px]">USER LEV<input id="userLeverage" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <button onclick="sendCtrl(true)" id="btnRun" class="bg-yellow-500 px-10 py-3 rounded font-black text-black text-sm ml-auto hover:bg-yellow-400">PHÂN TÍCH 30 NGÀY</button>
        </div>

        <div class="grid grid-cols-2 gap-2 mb-2">
            <div class="bg-[#1e2329] p-3 rounded border border-gray-800 text-center"><div class="text-gray-500 text-[10px]">TỔNG PNL PHÂN TÍCH</div><div id="statClosedPnl" class="font-bold text-yellow-500 text-2xl">0.00$</div></div>
            <div class="bg-black p-3 rounded border border-gray-800 overflow-y-auto h-20 text-[10px] text-green-500" id="logBox"></div>
        </div>

        <div class="bg-[#1e2329] rounded border border-gray-800 overflow-hidden shadow-2xl">
            <table class="w-full text-left">
                <thead class="bg-[#161a1e]"><tr>
                    <th class="p-2 w-10 text-center">STT</th>
                    <th>COIN</th>
                    <th class="text-center">VÒNG THẮNG</th>
                    <th class="text-center">MAX LEV</th>
                    <th class="text-right">VỐN GỐC (POS)</th>
                    <th class="text-right">PNL TỔNG ($)</th>
                    <th class="text-center pr-4">ROI %</th>
                </tr></thead>
                <tbody id="activeBody"></tbody>
            </table>
        </div>

        <script>
            async function sendCtrl(run){
                document.getElementById('btnRun').innerText = 'ĐANG TÍNH...';
                const body = { 
                    running: run, 
                    marginValue: Number(document.getElementById('marginValue').value), 
                    maxGrids: Number(document.getElementById('maxGrids').value), 
                    stepSize: Number(document.getElementById('stepSize').value), 
                    tpPercent: Number(document.getElementById('tpPercent').value), 
                    mode: document.getElementById('mode').value,
                    userLeverage: Number(document.getElementById('userLeverage').value)
                };
                await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
                document.getElementById('btnRun').innerText = 'PHÂN TÍCH 30 NGÀY';
            }
            async function update(){
                try {
                    const res = await fetch('/api/data'); const d = await res.json();
                    document.getElementById('activeBody').innerHTML = d.active.map((p, i)=> \`
                        <tr class="border-b border-gray-800 hover:bg-[#2b3139]">
                            <td class="p-2 text-center text-gray-500">\${i+1}</td>
                            <td class="p-2 font-bold text-yellow-500 uppercase">\${p.symbol}</td>
                            <td class="text-center text-blue-400 font-bold">\${p.closedCount}</td>
                            <td class="text-center text-purple-400">x\${p.maxLev}</td>
                            <td class="text-right text-gray-400">\${p.capitalGoc.toLocaleString()}$</td>
                            <td class="text-right font-bold text-emerald-400">\${p.totalClosedPnl.toFixed(2)}$</td>
                            <td class="text-center pr-4 font-bold text-green-400">\${p.totalRoi.toFixed(1)}%</td>
                        </tr>\`).join('');
                    document.getElementById('statClosedPnl').innerText = d.stats.closedPnl.toFixed(2) + '$';
                    document.getElementById('logBox').innerHTML = d.logs.map(l => \`<div>\${l}</div>\`).join('');
                } catch(e){}
            }
            setInterval(update, 2000);
            window.onload = () => { 
                document.getElementById('userLeverage').value = 125; 
                document.getElementById('marginValue').value = 10;
                document.getElementById('maxGrids').value = 5;
                document.getElementById('stepSize').value = 1.0;
                document.getElementById('tpPercent').value = 1.0;
            };
        </script>
    </body></html>`);
});

// KHỞI CHẠY HỆ THỐNG
(async () => {
    await preloadData();
    await fetchActualLeverage();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n=== LUFFY SYSTEM READY ===`);
        console.log(`TRUY CẬP: http://localhost:${PORT}/gui`);
        console.log(`==========================\n`);
    });
})();
