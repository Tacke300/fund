<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <title>Hạm Đội Luffy v6.8 - FULL DASHBOARD</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #050505; color: #e4e4e7; font-family: 'JetBrains Mono', monospace; font-size: 11px; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
        .glass { background: #111111; border: 1px solid #222; border-radius: 4px; }
        .input-dark { background: #000; border: 1px solid #333; color: #fff; padding: 4px; border-radius: 2px; outline: none; width: 100%; }
        .up { color: #10b981; } .down { color: #ef4444; }
        #logs-box { height: 180px; overflow-y: auto; background: #080808; border: 1px solid #222; margin-bottom: 8px; flex-shrink: 0; padding: 8px; }
        .log-line { border-bottom: 1px solid #111; padding: 2px 0; font-size: 10px; }
        .tab-btn { padding: 10px 20px; cursor: pointer; border-right: 1px solid #222; font-weight: bold; }
        .tab-active { background: #1a1a1a; color: #3b82f6; border-bottom: 2px solid #3b82f6; }
        th { font-size: 9px; color: #555; text-transform: uppercase; padding: 10px 4px; border-bottom: 1px solid #222; }
        td { padding: 8px 4px; border-bottom: 1px solid #111; }
        .luffy-glow { text-shadow: 0 0 10px rgba(59, 130, 246, 0.5); }
    </style>
</head>
<body class="p-2 space-y-2">
    <div class="grid grid-cols-12 gap-2 flex-shrink-0">
        <div class="col-span-10 glass p-3 grid grid-cols-8 gap-2 items-end">
            <div><label class="text-[9px] text-zinc-500 block uppercase font-bold">Vốn Lệnh</label><input id="invValue" type="number" class="input-dark"></div>
            <div><label class="text-[9px] text-zinc-500 block uppercase">Loại</label><select id="invType" class="input-dark"><option value="percent">% Ví</option><option value="fixed">USDT</option></select></div>
            <div><label class="text-[9px] text-blue-500 block uppercase font-bold">minVol (%)</label><input id="minVol" type="number" step="0.1" class="input-dark border-blue-900/50"></div>
            <div><label class="text-[9px] text-green-600 block uppercase font-bold">TP (%)</label><input id="posTP" type="number" class="input-dark"></div>
            <div><label class="text-[9px] text-red-600 block uppercase font-bold">SL (%)</label><input id="posSL" type="number" class="input-dark"></div>
            <div><label class="text-[9px] text-zinc-500 block uppercase">Max Pos</label><input id="maxPos" type="number" class="input-dark"></div>
            <div class="col-span-2 flex gap-1">
                <button onclick="save()" class="bg-blue-600 hover:bg-blue-500 w-1/2 h-[26px] rounded font-bold text-[9px]">LƯU</button>
                <button id="runBtn" onclick="toggleBot()" class="w-1/2 h-[26px] rounded font-bold text-[9px]"></button>
            </div>
        </div>
        <div class="col-span-2 glass p-3 text-center flex flex-col justify-center">
            <p id="runtime" class="text-zinc-500 text-[10px] font-bold">00:00:00</p>
            <div class="flex gap-1 mt-1">
                <input id="botSLValue" type="number" class="input-dark border-red-900/50 text-red-400 font-bold" placeholder="SL Bot">
                <select id="botSLType" class="input-dark w-12"><option value="fixed">$</option><option value="percent">%</option></select>
            </div>
        </div>
    </div>

    <div class="grid grid-cols-12 gap-2 flex-shrink-0">
        <div class="col-span-12 glass p-2 flex gap-8 items-center overflow-x-auto">
            <div class="flex gap-6 border-r border-zinc-800 pr-6 shrink-0">
                <div><p class="text-[9px] text-zinc-500 uppercase font-bold">Số dư Ví</p><p id="balance" class="text-base font-black text-green-500 luffy-glow">0.00$</p></div>
                <div><p class="text-[9px] text-zinc-500 uppercase font-bold">Trạng thái</p><p id="bot-status" class="text-[11px] font-bold uppercase">Ready</p></div>
            </div>
            <div class="flex gap-2 flex-nowrap" id="top5"></div>
        </div>
    </div>

    <div id="logs-box" class="font-mono text-[10px]">
        <div id="logs-list"></div>
    </div>

    <div class="flex-grow glass flex flex-col overflow-hidden">
        <div class="flex bg-zinc-900/50 border-b border-zinc-800 shrink-0">
            <div class="tab-btn tab-active uppercase">Vị thế hiện tại</div>
        </div>
        <div id="display-area" class="overflow-auto flex-grow p-2">
            <table class="w-full text-left">
                <thead>
                    <tr>
                        <th>Cặp</th>
                        <th>Side</th>
                        <th>Ký quỹ</th>
                        <th>Entry ➔ Mark</th>
                        <th>TP / SL</th>
                        <th>PnL ($)</th>
                        <th>Snapshot</th>
                    </tr>
                </thead>
                <tbody id="pos-table"></tbody>
            </table>
        </div>
    </div>

    <script>
        function val15(c) { return c?.c15 !== undefined ? c.c15 : (c?.m15 !== undefined ? c.m15 : '0'); }

        async function sync() {
            try {
                const res = await fetch('/api/status'); 
                const d = await res.json();
                
                document.getElementById('balance').innerText = d.status.currentBalance.toFixed(2) + '$';
                document.getElementById('bot-status').innerText = d.botSettings.isRunning ? "Running" : "Stopped";
                document.getElementById('bot-status').className = d.botSettings.isRunning ? "text-green-500" : "text-red-500";

                document.getElementById('top5').innerHTML = (d.status.candidatesList || []).slice(0, 10).map(c => `
                    <div class="bg-black p-1 px-2 border border-zinc-800 rounded text-[9px] whitespace-nowrap">
                        <b class="text-zinc-400">${c.symbol.replace('USDT','')}</b> 
                        <span class="${c.c1>=0?'up':'down'} font-bold">${c.c1}/${c.c5}/${val15(c)}%</span>
                    </div>
                `).join('');

                document.getElementById('logs-list').innerHTML = d.status.botLogs.map(l => `
                    <div class="log-line"><span class="text-zinc-600">[${l.time}]</span> <span class="${l.type==='success'?'up':(l.type==='error'?'down':'text-blue-400')}">${l.msg}</span></div>
                `).join('');

                document.getElementById('pos-table').innerHTML = d.activePositions.map(p => `
                    <tr>
                        <td class="font-black text-blue-400">${p.symbol}</td>
                        <td class="${p.side==='LONG'?'up':'down'} font-bold">${p.side} ${p.leverage}x</td>
                        <td>${p.margin}$</td>
                        <td>${p.entryPrice} ➔ ${p.markPrice || '---'}</td>
                        <td><span class="up">TP: ${p.tpPrice}</span><br><span class="down">SL: ${p.slPrice}</span></td>
                        <td class="font-bold ${parseFloat(p.pnlUsdt)>=0?'up':'down'}">${p.pnlUsdt || '0.00'}$</td>
                        <td class="text-zinc-500">${p.snapshot?.c1 || 0}/${p.snapshot?.c5 || 0}/${val15(p.snapshot)}%</td>
                    </tr>`).join('');

                const btn = document.getElementById('runBtn');
                btn.innerText = d.botSettings.isRunning ? "DỪNG" : "CHẠY";
                btn.className = d.botSettings.isRunning ? "bg-red-600 w-1/2 h-[26px] rounded font-bold" : "bg-green-600 w-1/2 h-[26px] rounded font-bold";
            } catch (e) {}
        }

        async function save() {
            const body = { 
                invValue: parseFloat(document.getElementById('invValue').value), 
                invType: document.getElementById('invType').value,
                minVol: parseFloat(document.getElementById('minVol').value),
                posTP: parseFloat(document.getElementById('posTP').value), 
                posSL: parseFloat(document.getElementById('posSL').value),
                maxPositions: parseInt(document.getElementById('maxPos').value),
                botSLValue: parseFloat(document.getElementById('botSLValue').value), 
                botSLType: document.getElementById('botSLType').value
            };
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
            alert("Đã lưu!");
        }

        async function toggleBot() {
            const res = await fetch('/api/status'); const d = await res.json();
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ isRunning: !d.botSettings.isRunning }) });
        }

        setInterval(sync, 1500);
        window.onload = () => {
             fetch('/api/status').then(r => r.json()).then(d => {
                document.getElementById('invValue').value = d.botSettings.invValue;
                document.getElementById('invType').value = d.botSettings.invType;
                document.getElementById('minVol').value = d.botSettings.minVol;
                document.getElementById('posTP').value = d.botSettings.posTP;
                document.getElementById('posSL').value = d.botSettings.posSL;
                document.getElementById('maxPos').value = d.botSettings.maxPositions;
                document.getElementById('botSLValue').value = d.botSettings.botSLValue;
                document.getElementById('botSLType').value = d.botSettings.botSLType;
             });
        }
    </script>
</body>
</html>
