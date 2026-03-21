const express = require('express');
const { 
    binanceApiKey, binanceApiSecret, 
    bingxApiKey, bingxApiSecret,
    okxApiKey, okxApiSecret, okxPassword,
    bitgetApiKey, bitgetApiSecret, bitgetApiPassword 
} = require('./config.js');

const app = express();
app.use(express.json());

// --- TRẠNG THÁI GIẢ LẬP ---
let botState = {
    virtualBalance: 1000, // Số dư giả lập
    config: { 
        percentVốn: 50, 
        pnlThreshold: 0.01, 
        isAutoTrade: false 
    },
    arbitrageOpportunities: [], // Dữ liệu thô từ 4 sàn quét về
    activePositions: [], // Các vị thế giả lập đang mở
    bestOpp: null, // Kèo thơm nhất dự kiến
    logs: []
};

// --- LOGIC TÍNH TOÁN VỊ THẾ GIẢ LẬP ---
function updateSimulation() {
    if (botState.arbitrageOpportunities.length === 0) return;

    // Tìm kèo chênh lệch (Spread) cao nhất
    const sorted = [...botState.arbitrageOpportunities].sort((a, b) => b.diff - a.diff);
    const top = sorted[0];

    if (top) {
        const totalVốn = botState.virtualBalance * (botState.config.percentVốn / 100);
        const marginPerSide = totalVốn / 2;
        const leverage = 20; 

        botState.bestOpp = {
            symbol: top.coin,
            diff: top.diff,
            shortSide: {
                exchange: top.highEx,
                fd: top.highFd,
                margin: marginPerSide.toFixed(2),
                lev: leverage,
                estFunding: (marginPerSide * (top.highFd / 100)).toFixed(4)
            },
            longSide: {
                exchange: top.lowEx,
                fd: top.lowFd,
                margin: marginPerSide.toFixed(2),
                lev: leverage,
                estFunding: top.lowFd < 0 ? Math.abs(marginPerSide * (top.lowFd / 100)).toFixed(4) : "0.0000"
            },
            totalProfit: (marginPerSide * (top.diff / 100)).toFixed(4)
        };

        // Tự động "vào lệnh giả" nếu bật Auto
        if (botState.config.isAutoTrade && top.diff >= botState.config.pnlThreshold) {
            const exists = botState.activePositions.find(p => p.symbol === top.coin);
            if (!exists && botState.activePositions.length < 10) {
                botState.activePositions.push({
                    ...botState.bestOpp,
                    timeIn: new Date().toLocaleTimeString()
                });
                addLog(`🎯 GIẢ LẬP: Đã mở Hedging ${top.coin} (Lãi dự kiến: ${botState.bestOpp.totalProfit}$)`);
            }
        }
    }
}

function addLog(msg) {
    botState.logs.unshift(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (botState.logs.length > 15) botState.logs.pop();
}

// --- GIAO DIỆN DASHBOARD ---
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>TunggBeoo | Funding Simulator</title>
    <style>
        body { background: #0b0e11; color: #e1e1e1; font-family: sans-serif; margin: 0; display: flex; height: 100vh; }
        .sidebar { width: 350px; background: #1e2329; padding: 20px; border-right: 1px solid #333; }
        .main { flex: 1; padding: 20px; overflow-y: auto; }
        .card { background: #181a20; border: 1px solid #2b3139; border-radius: 8px; padding: 15px; margin-bottom: 20px; }
        .highlight { color: #fcd535; font-weight: bold; }
        .win { color: #0ecb81; } .loss { color: #f6465d; }
        input, button { width: 100%; padding: 12px; margin: 8px 0; border-radius: 4px; border: 1px solid #444; background: #2b313a; color: white; box-sizing: border-box; }
        button { background: #fcd535; color: #000; border: none; font-weight: bold; cursor: pointer; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th, td { text-align: left; padding: 10px; border-bottom: 1px solid #2b3139; }
        .proj-box { display: grid; grid-template-columns: 1fr 1fr; background: #2b3139; padding: 15px; border-radius: 4px; border-left: 5px solid #fcd535; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2 style="color:#fcd535">GIẢ LẬP FUNDING</h2>
        <div class="card">
            <label>Vốn giả lập ($):</label>
            <input type="number" id="vBal" value="1000">
            <label>% Vốn/Cặp:</label>
            <input type="number" id="vPct" value="50">
            <label>Threshold báo kèo (%):</label>
            <input type="number" id="vThr" value="0.01" step="0.001">
            <button onclick="saveSim()">CHẠY GIẢ LẬP</button>
            <button onclick="stopSim()" style="background:#f6465d; color:white; margin-top:5px;">DỪNG</button>
        </div>
        <div id="logBox" style="font-size:11px; color:#848e9c; height:250px; overflow-y:auto;"></div>
    </div>

    <div class="main">
        <div class="card">
            <h3 style="margin-top:0">💰 DỰ TOÁN VỊ THẾ LÃI NHẤT (GIẢ LẬP)</h3>
            <div id="bestProj" class="proj-box">Quá trình tính toán kèo ngon nhất...</div>
        </div>

        <div class="card">
            <h3>📈 CƠ HỘI FUNDING (DỮ LIỆU THẬT)</h3>
            <table id="oppTable">
                <thead><tr><th>Cặp</th><th>Short Sàn (FD)</th><th>Long Sàn (FD)</th><th>Chênh lệch</th></tr></thead>
                <tbody></tbody>
            </table>
        </div>

        <div class="card">
            <h3>📑 DANH SÁCH VỊ THẾ ĐANG TEST</h3>
            <table id="posTable">
                <thead><tr><th>Cặp</th><th>Chi tiết</th><th>Vốn</th><th>Lãi dự kiến</th></tr></thead>
                <tbody></tbody>
            </table>
        </div>
    </div>

    <script>
        async function saveSim() {
            const data = { virtualBalance: document.getElementById('vBal').value, percentVốn: document.getElementById('vPct').value, pnlThreshold: document.getElementById('vThr').value, isAutoTrade: true };
            await fetch('/api/config', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) });
            alert("Đã bắt đầu chạy giả lập!");
        }
        async function stopSim() {
            await fetch('/api/config', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ isAutoTrade: false }) });
        }

        setInterval(async () => {
            const res = await fetch('/api/status');
            const s = await res.json();
            
            if(s.bestOpp) {
                document.getElementById('bestProj').innerHTML = \`
                    <div>
                        <b class="highlight" style="font-size:18px;">\${s.bestOpp.symbol}</b><br>
                        Spread: <b class="win">\${s.bestOpp.diff}%</b><br>
                        Lãi phiên: <b class="win">+\${s.bestOpp.totalProfit}$</b>
                    </div>
                    <div style="border-left:1px solid #444; padding-left:15px;">
                        <span class="loss">SHORT:</span> \${s.bestOpp.shortSide.exchange} (M: \${s.bestOpp.shortSide.margin}$) <br>
                        <span class="win">LONG:</span> \${s.bestOpp.longSide.exchange} (M: \${s.bestOpp.longSide.margin}$) <br>
                        <small>Ăn FD: \${s.bestOpp.shortSide.estFunding}$ + \${s.bestOpp.longSide.estFunding}$</small>
                    </div>
                \`;
            }

            document.querySelector('#oppTable tbody').innerHTML = s.arbitrageOpportunities.map(o => \`
                <tr><td><b>\${o.coin}</b></td><td>\${o.highEx} (\${o.highFd}%)</td><td>\${o.lowEx} (\${o.lowFd}%)</td><td class="win">\${o.diff}%</td></tr>
            \`).join('');

            document.querySelector('#posTable tbody').innerHTML = s.activePositions.map(p => \`
                <tr>
                    <td><b>\${p.symbol}</b></td>
                    <td>S: \${p.shortSide.exchange} | L: \${p.longSide.exchange}</td>
                    <td>\${(p.shortSide.margin * 2).toFixed(2)}$</td>
                    <td class="win">+\${p.totalProfit}$</td>
                </tr>
            \`).join('');

            document.getElementById('logBox').innerHTML = s.logs.join('<br>');
        }, 1200);
    </script>
</body>
</html>
    `);
});

// --- API ---
app.post('/api/config', (req, res) => {
    if (req.body.virtualBalance) botState.virtualBalance = parseFloat(req.body.virtualBalance);
    Object.assign(botState.config, req.body);
    res.json({ status: 'ok' });
});

app.get('/api/status', (req, res) => {
    updateSimulation();
    res.json(botState);
});

app.listen(5005, () => console.log("Dashboard giả lập chạy tại http://localhost:5005"));
