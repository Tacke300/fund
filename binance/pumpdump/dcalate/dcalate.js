import express from 'express';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = 9888;
const DATA_DIR = './candle_data';
const LEVERAGE_FILE = './leverage_cache.json';

// Cấu hình y hệt bản Live của bạn
let botState = { 
    running: false, marginValue: 10, maxGrids: 5, 
    stepSize: 1.0, tpPercent: 1.0, mode: 'LONG', userLeverage: 125 
};

let allSymbols = [];
let symbolMaxLeverage = {}; 
let cachedData = {}; // Bộ nhớ đệm nến để chống LAG
let logs = [];
let analysisResults = [];

function logger(msg, type = 'INFO') {
    const color = type === 'ERR' ? 'text-red-500' : (type === 'WIN' ? 'text-green-400' : 'text-emerald-400');
    logs.unshift(`<span class="${color}">[${new Date().toLocaleTimeString()}] [${type}] ${msg}</span>`);
    if (logs.length > 50) logs.pop();
}

// 1. SỬA LỖI LEVERAGE - Lấy chuẩn từ Binance API
async function fetchActualLeverage() {
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
                            symbolMaxLeverage[item.symbol] = item.brackets[0].initialLeverage;
                        });
                        fs.writeFileSync(LEVERAGE_FILE, JSON.stringify(symbolMaxLeverage));
                        logger("Đã đồng bộ Leverage thực tế từ Binance.", "INFO");
                    }
                } catch (e) { logger("Lỗi giải mã Leverage. Kiểm tra API Key.", "ERR"); }
                resolve();
            });
        }).on('error', () => { logger("Không thể kết nối Binance để lấy Lev.", "ERR"); resolve(); });
    });
}

// 2. TỐI ƯU TỐC ĐỘ - Load sẵn dữ liệu vào RAM
async function preloadData() {
    if (!fs.existsSync(DATA_DIR)) return;
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    logger(`Đang nạp ${files.length} tệp dữ liệu vào RAM...`, "INFO");
    
    for (const file of files) {
        const symbol = file.replace('.json', '');
        const content = fs.readFileSync(path.join(DATA_DIR, file));
        cachedData[symbol] = JSON.parse(content);
        if (!allSymbols.includes(symbol)) allSymbols.push(symbol);
    }
    logger("Hệ thống đã sẵn sàng phân tích nhanh.", "INFO");
}

// 3. LOGIC PHÂN TÍCH (Y hệt bản live nhưng chạy trên nến)
async function runAnalysis() {
    const rangeDays = 30; // Mặc định 30 ngày
    const endTs = Date.now();
    const startTs = endTs - (rangeDays * 24 * 60 * 60 * 1000);
    
    analysisResults = [];
    const symbols = Object.keys(cachedData);

    for (const symbol of symbols) {
        const rawData = cachedData[symbol].filter(k => k[0] >= startTs);
        if (rawData.length === 0) continue;

        const maxLev = symbolMaxLeverage[symbol] || 20;
        const finalLev = Math.min(botState.userLeverage, maxLev);
        const capitalGoc = botState.marginValue * botState.maxGrids; 

        let pos = null, closedPnl = 0, winCount = 0, history = [];

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
                    history.push({ pnl, grids: pos.grids.length, time });
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
                pnl: 0, // Đang gồng (trong backtest giả định = 0 khi kết thúc)
                totalClosedPnl: closedPnl,
                grids: { length: 0 }, // Không có lệnh đang gồng
                totalRoi: (closedPnl / capitalGoc) * 100,
                history: history
            });
        }
        await new Promise(r => setImmediate(r)); // Chống treo Event Loop
    }
    logger(`Hoàn tất phân tích ${analysisResults.length} mã.`, "WIN");
}

app.get('/api/data', (req, res) => {
    res.json({ 
        state: botState, active: analysisResults, logs, 
        stats: { today: 0, d7: 0, d30: 0, closedPnl: analysisResults.reduce((a,b)=>a+b.totalClosedPnl,0), unrealizedPnl: 0, totalGridsMatched: 0 } 
    });
});

app.post('/api/control', async (req, res) => { 
    Object.assign(botState, req.body);
    if (req.body.running) await runAnalysis();
    res.json({ status: 'ok' }); 
});

// GIỮ NGUYÊN GIAO DIỆN BẢN LIVE CỦA BẠN
app.get('/gui', (req, res) => {
    const html = fs.readFileSync('./gui_template.html', 'utf8'); // Hoặc dán trực tiếp chuỗi HTML y hệt bản bạn gửi
    res.send(html.replace('PORT_HERE', PORT)); 
});

// Lưu ý: Tôi tích hợp luôn HTML vào đây để bạn chạy 1 file duy nhất
app.get('/gui', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Luffy Matrix Backtest</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0b0e11;color:#eaecef;font-family:monospace} th{cursor:pointer;background:#161a1e;padding:10px 8px;border-bottom:1px solid #333;font-size:10px}
    #logBox{background:#000;padding:10px;height:150px;overflow-y:auto;font-size:11px;border:1px solid #333}</style>
    </head><body class="p-4 text-[11px]">
        <div class="bg-[#1e2329] p-4 rounded-lg mb-2 border border-yellow-500/20 flex flex-wrap items-end gap-3">
            <div class="w-[100px]">MARGIN ($)<input id="marginValue" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[70px]">MAX DCA<input id="maxGrids" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[70px]">GAP %<input id="stepSize" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[70px]">TP %<input id="tpPercent" type="number" step="0.1" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <div class="w-[90px]">HƯỚNG<select id="mode" class="w-full bg-black p-2 rounded border border-gray-700 mt-1 text-yellow-500"><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></div>
            <div class="w-[90px]">USER LEV<input id="userLeverage" type="number" class="w-full bg-black text-yellow-500 p-2 rounded border border-gray-700 mt-1"></div>
            <button onclick="sendCtrl(true)" class="bg-yellow-500 px-10 py-3 rounded font-black text-black text-sm ml-auto">PHÂN TÍCH DỮ LIỆU</button>
        </div>

        <div class="bg-[#1e2329] rounded border border-gray-800 mb-2 overflow-hidden shadow-2xl">
            <table class="w-full text-left">
                <thead class="bg-[#161a1e]"><tr>
                    <th class="p-2 w-10 text-center">STT</th>
                    <th>COIN ↕</th>
                    <th class="text-center">VÒNG ↕</th>
                    <th class="text-center">LEV ↕</th>
                    <th class="text-right">TỔNG PNL ($) ↕</th>
                    <th class="text-center pr-4">ROI TỔNG % ↕</th>
                </tr></thead>
                <tbody id="activeBody"></tbody>
            </table>
        </div>
        <div id="logBox"></div>

        <script>
            async function sendCtrl(run){
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
            }
            async function update(){
                const res = await fetch('/api/data'); const d = await res.json();
                document.getElementById('activeBody').innerHTML = d.active.map((p, i)=> \`
                    <tr class="border-b border-gray-800 hover:bg-[#2b3139]">
                        <td class="p-2 text-center text-gray-500">\${i+1}</td>
                        <td class="p-2 font-bold text-yellow-500">\${p.symbol}</td>
                        <td class="text-center text-blue-400 font-bold">\${p.closedCount}</td>
                        <td class="text-center text-purple-400">x\${p.maxLev}</td>
                        <td class="text-right font-bold text-emerald-400">\${p.totalClosedPnl.toFixed(2)}$</td>
                        <td class="text-center pr-4 font-bold text-green-400">\${p.totalRoi.toFixed(1)}%</td>
                    </tr>\`).join('');
                document.getElementById('logBox').innerHTML = d.logs.join('<br>');
            }
            setInterval(update, 2000);
            window.onload = () => { document.getElementById('userLeverage').value = 125; };
        </script>
    </body></html>`);
});

// KHỞI CHẠY
(async () => {
    await preloadData(); // Tải nến vào RAM trước
    await fetchActualLeverage(); // Lấy đòn bẩy
    app.listen(PORT, '0.0.0.0', () => console.log(`BACKTEST LIVE: http://localhost:${PORT}/gui`));
})();
