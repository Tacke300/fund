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
        req.on('error', () => res({}));
        req.end();
    });
}

function addLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
}

async function patrol() {
    http.get('http://127.0.0.1:9000/api/live', (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d); } catch(e) {} });
    }).on('error', () => {});

    if (!botSettings.isRunning) return;

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
    try {
        const info = status.exchangeInfo[symbol];
        const qty = parseFloat(((botSettings.invValue * 20) / coin.currentPrice).toFixed(info?.quantityPrecision || 2));
        if (qty <= 0) { botManagedSymbols.delete(symbol); return; }
        await binanceReq('/fapi/v1/leverage', 'POST', { symbol, leverage: 20 });
        const order = await binanceReq('/fapi/v1/order', 'POST', { symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty });
        if (order.orderId) { 
            addLog(`🚀 VÀO LỆNH: ${symbol} [${posSide}]`, 'success'); 
        } else { 
            botManagedSymbols.delete(symbol); 
            addLog(`❌ THẤT BẠI: ${symbol}`, 'error');
        }
    } catch (e) { botManagedSymbols.delete(symbol); }
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
        botManagedSymbols.forEach(s => { 
            if (!status.activePositions.find(p => p.symbol === s)) botManagedSymbols.delete(s); 
        });
    }
}

app.get('/api/status', (req, res) => res.json({ botSettings, status }));
app.post('/api/settings', (req, res) => { botSettings = {...botSettings, ...req.body}; res.json({ok:true}); });
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>LUFFY BOT</title><script src="https://cdn.tailwindcss.com"></script><style>@import url('https://fonts.googleapis.com/css2?family=Bangers&family=JetBrains+Mono:wght@400;700&display=swap'); body { background: #0a0a0c; color: #eee; font-family: 'Inter', sans-serif; overflow: hidden; height: 100vh; display: flex; flex-direction: column; } .luffy-font { font-family: 'Bangers', cursive; letter-spacing: 2px; } .mono { font-family: 'JetBrains Mono', monospace; } .card { background: rgba(15, 15, 20, 0.9); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; } .up { color: #22c55e; } .down { color: #ef4444; }</style></head><body class="p-3"><header class="card p-4 mb-3 flex justify-between items-center border-b-2 border-red-500"><div><h1 class="luffy-font text-4xl text-white">LUFFY BOT</h1><div id="statusTag" class="text-[10px] font-bold text-gray-500 uppercase">OFFLINE</div></div><div class="text-right"><div id="balance" class="text-3xl font-black text-yellow-400 mono">$0.00</div></div>
