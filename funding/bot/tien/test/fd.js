const express = require('express');
const ccxt = require('ccxt');
const app = express();

app.use(express.json());

// --- CẤU HÌNH LOGIC GỐC CỦA TUNGGBEOO ---
const SL_PERCENTAGE = 290;
const TP_PERCENTAGE = 410;
const exchange = new ccxt.binance({ enableRateLimit: true });

let botState = {
    balance: 1000,
    config: { percent: 50, lev: 20 },
    activeTrades: [],
    history: []
};

// Hàm tính TP/SL chuẩn theo logic bot gốc
function calculateExitPrices(side, entryPrice, leverage, collateral) {
    const notionalValue = collateral * leverage;
    const slPriceChange = entryPrice * (SL_PERCENTAGE / 100 / (notionalValue / collateral));
    const tpPriceChange = entryPrice * (TP_PERCENTAGE / 100 / (notionalValue / collateral));
    
    let tp = side === 'SHORT' ? entryPrice - tpPriceChange : entryPrice + tpPriceChange;
    let sl = side === 'SHORT' ? entryPrice + slPriceChange : entryPrice - slPriceChange;
    return { tp, sl };
}

// API lấy trạng thái bot
app.get('/api/status', (req, res) => res.json(botState));

// API khởi tạo/reset bot
app.post('/api/init', (req, res) => {
    botState.balance = parseFloat(req.body.balance);
    botState.config.percent = parseFloat(req.body.percent);
    botState.config.lev = parseInt(req.body.lev);
    botState.activeTrades = [];
    botState.history = [];
    res.json({ status: 'ok' });
});

// API mở lệnh giả lập (Lấy giá sàn thật)
app.post('/api/open', async (req, res) => {
    try {
        const symbol = req.body.symbol.toUpperCase();
        const ticker = await exchange.fetchTicker(symbol); // Lấy giá thật từ Binance
        const entryPrice = ticker.last;
        const lev = botState.config.lev;
        const collateral = botState.balance * (botState.config.percent / 100);

        const { tp, sl } = calculateExitPrices('SHORT', entryPrice, lev, collateral);

        const newPos = {
            id: Date.now(),
            symbol,
            entryPrice,
            currentPrice: entryPrice,
            leverage: lev,
            collateral,
            tp,
            sl,
            side: 'SHORT',
            roi: 0,
            pnl: 0,
            timeIn: new Date().toLocaleTimeString()
        };

        botState.activeTrades.push(newPos);
        botState.balance -= collateral;
        res.json({ success: true, pos: newPos });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Loop cập nhật giá sàn và kiểm tra TP/SL liên tục
setInterval(async () => {
    if (botState.activeTrades.length === 0) return;
    for (let pos of botState.activeTrades) {
        try {
            const ticker = await exchange.fetchTicker(pos.symbol);
            pos.currentPrice = ticker.last;
            
            // Tính ROI & PnL thực tế theo giá nhảy trên sàn
            const priceDiff = (pos.entryPrice - pos.currentPrice) / pos.entryPrice;
            pos.roi = priceDiff * 100 * pos.leverage;
            pos.pnl = (pos.roi / 100) * pos.collateral;

            // Tự động đóng lệnh nếu chạm TP hoặc SL
            if (pos.currentPrice >= pos.sl || pos.currentPrice <= pos.tp) {
                const idx = botState.activeTrades.findIndex(p => p.id === pos.id);
                botState.balance += (pos.collateral + pos.pnl);
                botState.history.unshift({ ...pos, timeOut: new Date().toLocaleTimeString(), status: pos.currentPrice <= pos.tp ? 'TP' : 'SL' });
                botState.activeTrades.splice(idx, 1);
            }
        } catch (e) { console.log(`Error updating ${pos.symbol}`); }
    }
}, 3000);

// --- GIAO DIỆN HTML (TRẢ VỀ KHI VÀO TRÌNH DUYỆT) ---
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>TunggBeoo Bot Sim - Real Price</title>
    <style>
        body { background: #0b0e11; color: #eaeaea; font-family: sans-serif; padding: 20px; }
        .grid { display: grid; grid-template-columns: 320px 1fr; gap: 20px; }
        .card { background: #1e2329; padding: 20px; border-radius: 10px; border: 1px solid #333; }
        input, button { width: 100%; padding: 12px; margin: 8px 0; border-radius: 5px; box-sizing: border-box; }
        input { background: #2b3139; border: 1px solid #444; color: white; }
        button { background: #fcd535; border: none; font-weight: bold; cursor: pointer; color: #000; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 14px; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid #2b3139; }
        .win { color: #0ecb81; } .loss { color: #f6465d; }
        .info-row { display: flex; justify-content: space-between; font-weight: bold; font-size: 18px; color: #fcd535; }
    </style>
</head>
<body>
    <div class="info-row">
        <span>TUNGGBEOO SIMULATOR 2026</span>
        <span>SỐ DƯ: <span id="curBal">0</span> USDT</span>
    </div>
    <div class="grid">
        <div class="card">
            <h3>Cài đặt & Mở lệnh</h3>
            <label>Số dư giả lập ($):</label>
            <input type="number" id="bal" value="1000">
            <label>% Vốn mỗi lệnh:</label>
            <input type="number" id="pct" value="50">
            <label>Leverage (x):</label>
            <input type="number" id="lev" value="20">
            <button onclick="initBot()">RESET CẤU HÌNH</button>
            <hr style="border:0.5px solid #333; margin:20px 0">
            <label>Nhập cặp Coin (Binance):</label>
            <input type="text" id="symbol" value="BTC/USDT">
            <button onclick="openTrade()" style="background:#0ecb81; color:white">VÀO LỆNH SHORT</button>
        </div>
        <div class="card">
            <h3>Vị thế đang mở (Real-time)</h3>
            <table id="activeTable">
                <thead><tr><th>Coin</th><th>Entry</th><th>Price</th><th>TP/SL</th><th>ROI</th><th>PnL</th><th>Time</th></tr></thead>
                <tbody></tbody>
            </table>
            <h3>Lịch sử (History)</h3>
            <table id="historyTable">
                <thead><tr><th>Time Out</th><th>Coin</th><th>Status</th><th>PnL</th></tr></thead>
                <tbody></tbody>
            </table>
        </div>
    </div>
    <script>
        async function initBot() {
            const data = { balance: document.getElementById('bal').value, percent: document.getElementById('pct').value, lev: document.getElementById('lev').value };
            await fetch('/api/init', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) });
            alert('Đã reset số dư và cấu hình!');
        }
        async function openTrade() {
            const symbol = document.getElementById('symbol').value;
            const res = await fetch('/api/open', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ symbol }) });
            const result = await res.json();
            if(result.error) alert(result.error);
        }
        setInterval(async () => {
            const res = await fetch('/api/status');
            const state = await res.json();
            document.getElementById('curBal').innerText = state.balance.toFixed(2);
            const activeTbody = document.querySelector('#activeTable tbody');
            activeTbody.innerHTML = state.activeTrades.map(p => \`
                <tr>
                    <td><b>\${p.symbol}</b></td>
                    <td>\${p.entryPrice.toFixed(2)}</td>
                    <td>\${p.currentPrice.toFixed(2)}</td>
                    <td><small>T: \${p.tp.toFixed(2)}<br>S: \${p.sl.toFixed(2)}</small></td>
                    <td class="\${p.roi >= 0 ? 'win' : 'loss'}">\${p.roi.toFixed(2)}%</td>
                    <td class="\${p.pnl >= 0 ? 'win' : 'loss'}">\${p.pnl.toFixed(2)}$</td>
                    <td>\${p.timeIn}</td>
                </tr>
            \`).join('');
            const histTbody = document.querySelector('#historyTable tbody');
            histTbody.innerHTML = state.history.map(h => \`
                <tr>
                    <td>\${h.timeOut}</td>
                    <td>\${h.symbol}</td>
                    <td class="\${h.status === 'TP' ? 'win' : 'loss'}">\${h.status}</td>
                    <td class="\${h.pnl >= 0 ? 'win' : 'loss'}">\${h.pnl.toFixed(2)}$</td>
                </tr>
            \`).join('');
        }, 1000);
    </script>
</body>
</html>
    `);
});

app.listen(3000, () => console.log("Bot Simulator chạy tại http://localhost:3000"));
