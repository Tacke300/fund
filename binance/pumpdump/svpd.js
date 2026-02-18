import WebSocket from 'ws';
import http from 'http';
import https from 'https';
import express from 'express';
import fs from 'fs';
import { URL } from 'url';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
const port = 9000;
const HISTORY_FILE = './history_db.json';

// Cấu hình logic
const WINDOW_MINUTES = 5;
let coinData = {};
let topRankedCoinsForApi = [];
let allSymbols = [];

// Khởi tạo file log nếu chưa có
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));

function logVps1(msg) { console.log(`[PIRATE-SERVER] ${new Date().toLocaleTimeString()} - ${msg}`); }

// --- HÀM TRUY XUẤT BINANCE (Rút gọn để tiết kiệm tài nguyên) ---
async function callPublicAPI(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    return new Promise((res, rej) => {
        https.get(`https://fapi.binance.com${path}${qs ? '?' + qs : ''}`, (r) => {
            let d = ''; r.on('data', chunk => d += chunk);
            r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
        }).on('error', rej);
    });
}

// --- LOGIC LỊCH SỬ & FILE JSON ---
function saveToHistory(coin) {
    const now = Date.now();
    if (Math.abs(coin.changePercent) < 5) return;

    let history = JSON.parse(fs.readFileSync(HISTORY_FILE));
    // Tìm coin này đã ghi trong vòng 1h qua chưa
    let existingIndex = history.findIndex(h => h.symbol === coin.symbol && (now - h.startTime) < 3600000);

    if (existingIndex === -1) {
        history.push({
            symbol: coin.symbol,
            startTime: now,
            startPrice: coin.price5MinAgo,
            maxChange: coin.changePercent,
            direction: coin.direction,
            dateStr: new Date(now).toISOString().split('T')[0] // Dùng để lọc ngày
        });
    } else {
        // Cập nhật biến động cực đại
        if (history[existingIndex].direction === "LONG") {
            history[existingIndex].maxChange = Math.max(history[existingIndex].maxChange, coin.changePercent);
        } else {
            history[existingIndex].maxChange = Math.min(history[existingIndex].maxChange, coin.changePercent);
        }
    }
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
}

// --- WEBSOCKET ---
async function init() {
    const info = await callPublicAPI('/fapi/v1/exchangeInfo');
    allSymbols = info.symbols.filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING').map(s => s.symbol);
    
    // Chỉ stream top 150 coin để tránh quá tải cho VPS yếu
    const streams = allSymbols.slice(0, 150).map(s => `${s.toLowerCase()}@kline_1m`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);
    
    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.data && msg.data.k.x) {
            const s = msg.data.k.s;
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            const close = parseFloat(msg.data.k.c);
            coinData[s].prices.push(close);
            if (coinData[s].prices.length > WINDOW_MINUTES) coinData[s].prices.shift();
            
            const change = ((close - coinData[s].prices[0]) / coinData[s].prices[0]) * 100;
            const coinObj = {
                symbol: s,
                changePercent: parseFloat(change.toFixed(2)),
                direction: change >= 0 ? "LONG" : "SHORT",
                currentPrice: close,
                price5MinAgo: coinData[s].prices[0]
            };
            
            // Cập nhật API realtime
            let idx = topRankedCoinsForApi.findIndex(c => c.symbol === s);
            if (idx > -1) topRankedCoinsForApi[idx] = coinObj;
            else topRankedCoinsForApi.push(coinObj);
            
            saveToHistory(coinObj);
        }
    });
    
    setInterval(() => {
        topRankedCoinsForApi.sort((a,b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
        topRankedCoinsForApi = topRankedCoinsForApi.slice(0, 50);
    }, 10000);
}

// --- GIAO DIỆN WEB ---
app.get('/gui', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>LUFFY DATABASE CENTER</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>body { background: #0c0c0e; color: #eee; font-family: monospace; }</style>
    </head>
    <body class="p-4">
        <div class="flex justify-between items-center bg-red-900/20 p-4 rounded-lg mb-6 border border-red-500/30">
            <h1 class="text-2xl font-bold text-red-500 underline">PIRATE DATABASE</h1>
            <div class="flex gap-4 items-center">
                <input type="date" id="datePicker" class="bg-zinc-800 p-1 rounded text-sm">
                <button onclick="loadHistory('day')" class="bg-zinc-700 px-3 py-1 rounded text-xs">Ngày</button>
                <button onclick="loadHistory('week')" class="bg-zinc-700 px-3 py-1 rounded text-xs">Tuần</button>
                <button onclick="loadHistory('month')" class="bg-zinc-700 px-3 py-1 rounded text-xs">Tháng</button>
                <button onclick="loadHistory('all')" class="bg-red-600 px-3 py-1 rounded text-xs font-bold">Tất cả</button>
            </div>
        </div>

        <div class="grid grid-cols-12 gap-6">
            <div class="col-span-4 bg-zinc-900/50 p-4 rounded-lg border border-zinc-800">
                <h2 class="text-blue-400 font-bold mb-4 uppercase">🚀 Biến động 5m (Live)</h2>
                <div id="liveList" class="space-y-2 text-sm"></div>
            </div>

            <div class="col-span-8 bg-zinc-900/50 p-4 rounded-lg border border-zinc-800">
                <div class="flex justify-between mb-4">
                    <h2 class="text-yellow-500 font-bold uppercase">📊 Lịch sử & Thống kê</h2>
                    <div id="statSummary" class="text-xs text-zinc-400"></div>
                </div>
                <div class="overflow-y-auto max-h-[600px]">
                    <table class="w-full text-left text-sm">
                        <thead class="bg-zinc-800 sticky top-0">
                            <tr><th class="p-2">Thời gian</th><th class="p-2">Coin</th><th class="p-2 text-right">Biến động đỉnh</th></tr>
                        </thead>
                        <tbody id="historyList"></tbody>
                    </table>
                </div>
            </div>
        </div>

        <script>
            async function updateLive() {
                const res = await fetch('/api/live');
                const data = await res.json();
                document.getElementById('liveList').innerHTML = data.map(c => \`
                    <div class="flex justify-between border-b border-zinc-800 pb-1">
                        <span>\${c.symbol}</span>
                        <span class="\${c.changePercent >= 0 ? 'text-green-500' : 'text-red-500'} font-bold">\${c.changePercent}%</span>
                    </div>
                \`).join('');
            }

            async function loadHistory(range) {
                const dateVal = document.getElementById('datePicker').value;
                const res = await fetch(\`/api/history?range=\${range}&date=\${dateVal}\`);
                const data = await res.json();
                
                // Thống kê
                const longCount = data.filter(h => h.direction === 'LONG').length;
                const shortCount = data.filter(h => h.direction === 'SHORT').length;
                document.getElementById('statSummary').innerHTML = \`Tổng: \${data.length} | LONG: \${longCount} | SHORT: \${shortCount}\`;

                document.getElementById('historyList').innerHTML = data.reverse().map(h => \`
                    <tr class="border-b border-zinc-800 hover:bg-white/5">
                        <td class="p-2 text-zinc-500 text-xs">\${new Date(h.startTime).toLocaleString()}</td>
                        <td class="p-2 font-bold">\${h.symbol}</td>
                        <td class="p-2 text-right font-bold \${h.maxChange >= 0 ? 'text-green-500' : 'text-red-500'}">\${h.maxChange}%</td>
                    </tr>
                \`).join('');
            }

            setInterval(updateLive, 5000);
            updateLive();
            loadHistory('day');
        </script>
    </body>
    </html>
    `);
});

// --- API DATA ---
app.get('/api/live', (req, res) => res.json(topRankedCoinsForApi));

app.get('/api/history', (req, res) => {
    const { range, date } = req.query;
    let history = JSON.parse(fs.readFileSync(HISTORY_FILE));
    const now = Date.now();

    if (date) {
        history = history.filter(h => h.dateStr === date);
    } else {
        if (range === 'day') history = history.filter(h => (now - h.startTime) < 86400000);
        if (range === 'week') history = history.filter(h => (now - h.startTime) < 604800000);
        if (range === 'month') history = history.filter(h => (now - h.startTime) < 2592000000);
    }
    res.json(history);
});

app.listen(port, '0.0.0.0', () => {
    logVps1(`Hệ thống khởi chạy tại port ${port}`);
    init();
});
