import express from 'express';
import http from 'http';

const app = express();
const serverIP = '192.168.1.3'; // ĐỊA CHỈ SERVER CỦA BẠN
const serverPort = 9000;

let botSettings = { isRunning: false, invValue: 1.5, invType: 'fixed', minVol: 5.0, maxPositions: 10, accountSL: 30 };
let status = { currentBalance: 0, candidatesList: [], activePositions: [], botLogs: [] };

// Hàm đồng bộ dữ liệu từ Server 9000
function syncFromServer() {
    http.get(`http://${serverIP}:${serverPort}/api/live`, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
            try {
                status.candidatesList = JSON.parse(data);
            } catch (e) { console.log("Lỗi parse dữ liệu Server"); }
        });
    }).on('error', (e) => console.log("Không kết nối được Server 9000"));
}

setInterval(syncFromServer, 2000);

app.use(express.json());
app.get('/api/status', (req, res) => res.json({ botSettings, status }));
app.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ ok: true }); });

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <title>MONCEY D. LUFFY BOT</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Bangers&family=Inter:wght@400;900&display=swap');
        body { background: #0a0a0c; color: #eee; font-family: 'Inter', sans-serif; overflow: hidden; height: 100vh; display: flex; flex-direction: column; }
        .luffy-font { font-family: 'Bangers', cursive; }
        .card { background: rgba(20, 20, 25, 0.9); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 12px; }
        .up { color: #22c55e; } .down { color: #ef4444; }
    </style>
</head>
<body class="p-4">
    <header class="card p-4 mb-4 flex justify-between items-center border-b-2 border-red-500">
        <div class="flex items-center gap-4">
            <div class="w-16 h-16 bg-zinc-800 rounded-lg flex items-center justify-center border-2 border-red-500">
                <span class="text-3xl">👒</span>
            </div>
            <div>
                <h1 class="luffy-font text-4xl text-white uppercase italic">Moncey D. Luffy</h1>
                <div id="botStatusText" class="text-[10px] font-bold text-zinc-500 uppercase">Offline</div>
            </div>
        </div>
        <div class="flex gap-6 bg-black/40 p-3 rounded-xl border border-white/5">
            <div class="text-center">
                <p class="text-[9px] text-zinc-500 font-bold uppercase">Kho báu USDT</p>
                <p id="balance" class="text-2xl font-black text-yellow-500 mono">$0.00</p>
            </div>
            <div class="text-center border-l border-white/10 pl-6">
                <p class="text-[9px] text-zinc-500 font-bold uppercase">Top 5 Biến Động</p>
                <div id="top5" class="flex gap-2 mt-1"></div>
            </div>
        </div>
    </header>

    <div class="grid grid-cols-6 gap-3 mb-4">
        <div class="card p-3"><label class="block text-[10px] text-zinc-500 font-bold mb-1">VỐN</label><input id="invValue" type="number" class="w-full bg-transparent text-white font-bold outline-none" value="1.5"></div>
        <div class="card p-3"><label class="block text-[10px] text-zinc-500 font-bold mb-1">LỌC %</label><input id="minVol" type="number" class="w-full bg-transparent text-red-500 font-bold outline-none" value="5.0"></div>
        <div class="card p-3"><label class="block text-[10px] text-zinc-500 font-bold mb-1">MAX LỆNH</label><input id="maxPositions" type="number" class="w-full bg-transparent text-white font-bold outline-none" value="10"></div>
        <div class="card p-3"><label class="block text-[10px] text-zinc-500 font-bold mb-1">STOP %</label><input id="accountSL" type="number" class="w-full bg-transparent text-orange-500 font-bold outline-none" value="30"></div>
        <button id="runBtn" onclick="handleToggle()" class="col-span-2 bg-green-600 rounded-xl font-black text-white hover:bg-green-500 transition-all uppercase">🚢 Giương Buồm</button>
    </div>

    <div class="flex-grow grid grid-cols-12 gap-4 overflow-hidden">
        <div class="col-span-4 card flex flex-col overflow-hidden">
            <div class="p-3 border-b border-white/5 font-bold text-[10px] text-blue-400 uppercase">Nhật ký hải trình</div>
            <div id="logs" class="p-3 text-[10px] mono overflow-y-auto space-y-1"></div>
        </div>
        <div class="col-span-8 card flex flex-col overflow-hidden">
            <div class="p-3 border-b border-white/5 flex justify-between items-center">
                <span class="luffy-font text-xl text-red-500 uppercase italic">Chiến trường Live</span>
                <span id="posCount" class="bg-red-500 px-2 py-0.5 rounded text-[10px] font-bold">0 LỆNH</span>
            </div>
            <div class="overflow-y-auto">
                <table class="w-full text-[11px] text-left">
                    <thead class="bg-white/5 sticky top-0 text-zinc-500 uppercase text-[9px]">
                        <tr><th class="p-3">Symbol</th><th class="p-3">Side</th><th class="p-3">Entry/Mark</th><th class="p-3 text-right">PnL%</th></tr>
                    </thead>
                    <tbody id="posTable"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        let running = false;
        async function sync() {
            try {
                const r = await fetch('/api/status');
                const d = await r.json();
                
                document.getElementById('balance').innerText = '$' + d.status.currentBalance.toFixed(2);
                document.getElementById('posCount').innerText = d.status.activePositions.length + ' LỆNH';
                
                // Hiển thị Top 5 biến động từ Server 9000
                const top5Data = d.status.candidatesList.slice(0, 5);
                document.getElementById('top5').innerHTML = top5Data.map(c => \`
                    <div class="bg-white/5 px-2 py-1 rounded border border-white/10 text-[10px]">
                        <div class="text-white font-bold">\${c.symbol.replace('USDT','')}</div>
                        <div class="\${c.c1 >= 0 ? 'up':'down'}">\${c.c1}%</div>
                    </div>
                \`).join('');

                document.getElementById('posTable').innerHTML = d.status.activePositions.map(p => \`
                    <tr class="border-b border-white/5">
                        <td class="p-3 font-bold">\${p.symbol}</td>
                        <td class="p-3 \${p.side === 'LONG' ? 'up':'down'} font-black">\${p.side}</td>
                        <td class="p-3 text-zinc-500">\${p.entryPrice}<br><span class="text-white">\${p.markPrice}</span></td>
                        <td class="p-3 text-right font-black \${p.pnlPercent >= 0 ? 'up':'down'}">\${p.pnlPercent}%</td>
                    </tr>
                \`).join('');
            } catch(e) {}
        }

        async function handleToggle() {
            running = !running;
            const btn = document.getElementById('runBtn');
            btn.innerText = running ? '🛑 Hạ Buồm' : '🚢 Giương Buồm';
            btn.className = running ? 'col-span-2 bg-red-600 rounded-xl font-black text-white' : 'col-span-2 bg-green-600 rounded-xl font-black text-white';
            await fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({isRunning: running}) });
        }

        setInterval(sync, 2000);
    </script>
</body>
</html>
    `);
});

app.listen(9001, '0.0.0.0', () => console.log("Bot Luffy chạy tại: http://127.0.0.1:9001"));
