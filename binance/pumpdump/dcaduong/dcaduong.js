import express from 'express';
import axios from 'axios';
import WebSocket from 'ws';
import ccxt from 'ccxt';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { API_KEY, SECRET_KEY } from './config.js';

const PORT = 1114;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, 'config_data.json');
const POS_FILE = path.join(__dirname, 'positions.json');

const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    enableRateLimit: true,
    options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000 }
});

// --- STATE MANAGEMENT ---
let botSettings = { isRunning: false, capital: 5.5, volVolatility: 7, maxPos: 3, dcaPercent: 10, tp: 0.5, sl: 10 };
if (fs.existsSync(CONFIG_FILE)) {
    botSettings = { ...botSettings, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) };
}

let positions = new Map();
if (fs.existsSync(POS_FILE)) {
    const savedPos = JSON.parse(fs.readFileSync(POS_FILE));
    savedPos.forEach(p => positions.set(`${p.symbol}_${p.side}`, p));
}

let livePrices = {};
let coinVolatility = {}; // Để theo dõi biến động thực tế

function saveState() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botSettings, null, 2));
    fs.writeFileSync(POS_FILE, JSON.stringify(Array.from(positions.values()), null, 2));
}

// --- REAL-TIME DATA ---
async function initWS() {
    try {
        const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price');
        const symbols = res.data.filter(t => t.symbol.endsWith('USDT')).map(t => t.symbol.toLowerCase());
        const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${symbols.slice(0, 100).map(s => `${s}@ticker`).join('/')}`);
        
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw);
            if (msg.data) {
                const s = msg.data.s;
                livePrices[s] = parseFloat(msg.data.c);
                // Cập nhật biến động đơn giản để làm điều kiện mở lệnh
                coinVolatility[s] = Math.abs(parseFloat(msg.data.P)); 
            }
        });
        ws.on('close', () => setTimeout(initWS, 5000));
    } catch (e) { setTimeout(initWS, 5000); }
}

// --- TRADING LOGIC ---
async function getRealLeverage(symbol) {
    try {
        const markets = await exchange.loadMarkets();
        return markets[symbol]?.leverage || 20;
    } catch { return 20; }
}

async function openPosition(symbol, side, currentPrice, isDca = false, isShining = false) {
    const maxLev = await getRealLeverage(symbol);
    if (maxLev < 20) return; // Chặn các coin đòn bẩy thấp

    try {
        const key = `${symbol}_${side}`;
        let margin = parseFloat(botSettings.capital);
        
        if (isDca) {
            const p = positions.get(key);
            margin = isShining ? p.marginInitial * Math.pow(2, p.dca + 1) : p.marginInitial;
        }

        const qty = (margin * maxLev) / currentPrice;
        await exchange.setLeverage(maxLev, symbol);
        await exchange.createOrder(symbol, 'market', side === 'LONG' ? 'buy' : 'sell', qty, undefined, { positionSide: side });

        if (!isDca) {
            const tpRate = isShining ? (side === 'LONG' ? 0.40 : 0.30) : (botSettings.tp / 100);
            const slRate = 0.10; 
            positions.set(key, { 
                symbol, side, qty, entryInitial: currentPrice, avg: currentPrice, marginInitial: margin,
                tp: side === 'LONG' ? currentPrice * (1 + tpRate) : currentPrice * (1 - tpRate),
                sl: side === 'LONG' ? currentPrice * (1 - slRate) : currentPrice * (1 + slRate),
                dca: 0, isShining, startTime: Date.now() 
            });
        } else {
            const p = positions.get(key);
            p.dca++; p.qty += qty;
            p.avg = ((p.avg * (p.qty - qty)) + (currentPrice * qty)) / p.qty;
        }
        saveState();
    } catch (e) { console.error(`OPEN ERROR: ${e.message}`); }
}

async function monitorLoop() {
    for (const [key, p] of positions) {
        const cp = livePrices[p.symbol];
        if (!cp) continue;

        const isBreakEven = p.side === 'LONG' ? cp >= p.avg * 1.01 : cp <= p.avg * 0.99;
        const isExpired = (Date.now() - p.startTime) > 4 * 60 * 60 * 1000;
        const isHitTpSl = (p.side === 'LONG' && (cp >= p.tp || cp <= p.sl)) || (p.side === 'SHORT' && (cp <= p.tp || cp >= p.sl));

        if (isBreakEven || isExpired || isHitTpSl) {
            try {
                await exchange.createOrder(p.symbol, 'market', p.side === 'LONG' ? 'sell' : 'buy', p.qty, undefined, { reduceOnly: true, positionSide: p.side });
                if (p.isShining) {
                    if (isHitTpSl) console.log(cp >= p.tp || cp <= p.tp ? "THÀ 1 PHÚT HUY HOÀNG RỒI VỤT TẮT CÒN HƠN LE LÓI CẢ TRĂM NĂM 😎😎😎" : "RA ĐẢO RỒI THÍM ƠI😭😭😭");
                    else if (isBreakEven) console.log("TÝ NỮA THÌ GIÀU TO😔😔😔");
                }
                positions.delete(key); saveState();
            } catch (e) { console.error(`CLOSE ERROR: ${e.message}`); }
        } else {
            // Kiểm tra DCA
            const nextDca = p.side === 'LONG' ? p.entryInitial * (1 - 0.10 * (p.dca + 1)) : p.entryInitial * (1 + 0.10 * (p.dca + 1));
            if (p.dca < 3 && (p.side === 'LONG' ? cp <= nextDca : cp >= nextDca)) {
                await openPosition(p.symbol, p.side, cp, true, p.isShining);
            }
        }
    }
    setTimeout(monitorLoop, 1000);
}

// --- SERVER & API ---
const app = express();
app.use(express.json());

app.post('/api/config', (req, res) => { botSettings = { ...botSettings, ...req.body }; saveState(); res.json({ ok: true }); });
app.post('/api/start', (req, res) => { botSettings.isRunning = true; saveState(); res.json({ ok: true }); });
app.post('/api/stop', (req, res) => { botSettings.isRunning = false; saveState(); res.json({ ok: true }); });
app.get('/api/status', (req, res) => {
    res.json({ botStatus: botSettings.isRunning, positions: Array.from(positions.values()) });
});

app.listen(PORT, () => {
    initWS();
    monitorLoop();
    console.log(`MONCEY D. LUFFY SYSTEM READY ON PORT ${PORT}`);
});
