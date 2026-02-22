import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
app.use(express.json());

let botSettings = { isRunning: false, maxPositions: 5, invValue: 1.5, minVol: 5.0 };
let status = { currentBalance: 0, botLogs: [], candidatesList: [], activePositions: [], exchangeInfo: {} };
let botManagedSymbols = new Set();

// --- BINANCE API ---
async function binanceReq(path, method = 'GET', params = {}) {
    const ts = Date.now();
    const query = new URLSearchParams({...params, timestamp: ts, recvWindow: 10000}).toString();
    const sig = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    const url = `https://fapi.binance.com${path}?${query}&signature=${sig}`;
    return new Promise((res) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } }, r => {
            let d = ''; r.on('data', chunk => d += chunk);
            r.on('end', () => { try { res(JSON.parse(d)); } catch(e) { res({}); } });
        });
        req.end();
    });
}

function addLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
}

// --- CORE ENGINE (QUÉT LIÊN TỤC) ---
async function patrol() {
    // 1. Lấy dữ liệu từ Server 9000 (Local) cực nhanh
    http.get('http://127.0.0.1:9000/api/live', (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
            try { status.candidatesList = JSON.parse(d); } catch(e) {}
        });
    }).on('error', () => {});

    if (!botSettings.isRunning) return;

    // 2. Kiểm tra lệnh
    for (const coin of status.candidatesList) {
        if (botManagedSymbols.has(coin.symbol) || status.activePositions.length >= botSettings.maxPositions) continue;

        const vol = Math.max(Math.abs(coin.c1), Math.abs(coin.c5), Math.abs(coin.c15));
        if (vol >= botSettings.minVol) {
            executeTrade(coin);
            break; 
        }
    }
}

async function executeTrade(coin) {
    const symbol = coin.symbol;
    const side = coin.c1 > 0 ? 'BUY' : 'SELL';
    const posSide = coin.c1 > 0 ? 'LONG' : 'SHORT';
    
    botManagedSymbols.add(symbol); 
    addLog(`🎯 Phát hiện sóng: ${symbol} (${coin.c1}%)`, 'success');

    try {
        const info = status.exchangeInfo[symbol];
        const qty = parseFloat(((botSettings.invValue * 20) / coin.currentPrice).toFixed(info?.quantityPrecision || 2));

        await binanceReq('/fapi/v1/leverage', 'POST', { symbol, leverage: 20 });
        const order = await binanceReq('/fapi/v1/order', 'POST', {
            symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty
        });

        if (order.orderId) addLog(`🚢 ĐÃ VÀO LỆNH: ${symbol}`, 'success');
        else botManagedSymbols.delete(symbol);
    } catch (e) {
        botManagedSymbols.delete(symbol);
    }
}

async function syncAccount() {
    const acc = await binanceReq('/fapi/v2/account');
    if (acc.totalMarginBalance) status.currentBalance = parseFloat(acc.totalMarginBalance);
    
    const pos = await binanceReq('/fapi/v2/positionRisk');
    if (Array.isArray(pos)) {
        status.activePositions = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => ({
            symbol: p.symbol,
            side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
            pnlPercent: ((parseFloat(p.unRealizedProfit) / (parseFloat(p.isolatedWallet) || 1)) * 100).toFixed(2)
        }));
        
        // Giải phóng danh sách quản lý nếu lệnh đã đóng
        botManagedSymbols.forEach(s => {
            if (!status.activePositions.find(p => p.symbol === s)) botManagedSymbols.delete(s);
        });
    }
}

// --- INITIALIZE ---
app.get('/api/status', (req, res) => res.json({ botSettings, status }));
app.post('/api/settings', (req, res) => { botSettings = {...botSettings, ...req.body}; res.json({ok:true}); });
app.get('/', (req, res) => res.sendFile('/index.html', { root: './' })); // Giao diện HTML của bạn

app.listen(9001, async () => {
    console.log("⚓ LUFFY BOT READY ON PORT 9001");
    const info = await binanceReq('/fapi/v1/exchangeInfo');
    info.symbols?.forEach(s => status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision });
    
    setInterval(patrol, 1000);   // Quét biến động 1 giây/lần
    setInterval(syncAccount, 3000); // Đồng bộ ví 3 giây/lần
});
