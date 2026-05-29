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
    apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true,
    options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000 }
});

// --- STATE MANAGEMENT ---
let botSettings = { isRunning: false, capital: 5.5, volVolatility: 7, maxPos: 3, dcaPercent: 10, tp: 0.5, sl: 10 };
if (fs.existsSync(CONFIG_FILE)) botSettings = { ...botSettings, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) };

let positions = new Map();
if (fs.existsSync(POS_FILE)) {
    JSON.parse(fs.readFileSync(POS_FILE)).forEach(p => positions.set(`${p.symbol}_${p.side}`, p));
}

let coinData = {}; 
let status = { botLogs: [] };

function addLog(msg) {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg });
    if (status.botLogs.length > 300) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

function saveState() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botSettings, null, 2));
    fs.writeFileSync(POS_FILE, JSON.stringify(Array.from(positions.values()), null, 2));
}

async function getPublicIP() {
    try { const res = await axios.get('https://api.ipify.org?format=json'); return res.data.ip; }
    catch { return '0.0.0.0'; }
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0];
    return parseFloat(((pArr[pArr.length - 1].p - start.p) / start.p * 100).toFixed(2));
}

// --- REAL-TIME DATA (WebSocket) ---
async function initWS() {
    try {
        const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price');
        const symbols = res.data.filter(t => t.symbol.endsWith('USDT')).map(t => t.symbol.toLowerCase());
        const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${symbols.slice(0, 50).map(s => `${s}@ticker`).join('/')}`);
        
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw);
            if (msg.data) {
                const s = msg.data.s;
                const p = parseFloat(msg.data.c);
                if (!coinData[s]) coinData[s] = { prices: [] };
                coinData[s].prices.push({ p, t: Date.now() });
                if (coinData[s].prices.length > 1200) coinData[s].prices.shift();
                coinData[s].live = { c1: calculateChange(coinData[s].prices, 1), c5: calculateChange(coinData[s].prices, 5), c15: calculateChange(coinData[s].prices, 15), currentPrice: p };
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
    if (maxLev < 20) return; 

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
            positions.set(key, { 
                symbol, side, qty, entryInitial: currentPrice, avg: currentPrice, marginInitial: margin,
                tp: side === 'LONG' ? currentPrice * (1 + tpRate) : currentPrice * (1 - tpRate),
                sl: side === 'LONG' ? currentPrice * (1 - 0.10) : currentPrice * (1 + 0.10),
                dca: 0, isShining, startTime: Date.now() 
            });
            addLog(`🚀 OPEN ${symbol} ${side} (Shining: ${isShining})`);
        } else {
            const p = positions.get(key);
            p.dca++; p.qty += qty;
            p.avg = ((p.avg * (p.qty - qty)) + (currentPrice * qty)) / p.qty;
            addLog(`💵 DCA ${symbol} ${side} | NewAvg:${p.avg.toFixed(4)}`);
        }
        saveState();
    } catch (e) { addLog(`⛔ OPEN ERROR ${symbol}: ${e.message}`); }
}

async function autoTradeLoop() {
    if (botSettings.isRunning && positions.size < botSettings.maxPos) {
        const market = Object.entries(coinData).filter(([,v]) => v.live);
        for (const [s, v] of market) {
            const { c1, c5, c15 } = v.live;
            if (Math.abs(c1) > 7 && Math.abs(c5) > 7 && Math.abs(c15) > 7) {
                const isShining = Math.abs(c1) > 15 || Math.abs(c5) > 15;
                await openPosition(s, (c1 + c5 + c15) >= 0 ? 'LONG' : 'SHORT', v.live.currentPrice, false, isShining);
                break; 
            }
        }
    }
    setTimeout(autoTradeLoop, 2000);
}

async function monitorLoop() {
    for (const [key, p] of positions) {
        const cp = coinData[p.symbol]?.live?.currentPrice;
        if (!cp) continue;

        const isBreakEven = p.side === 'LONG' ? cp >= p.avg * 1.01 : cp <= p.avg * 0.99;
        const isExpired = (Date.now() - p.startTime) > 4 * 60 * 60 * 1000;
        const isHitTpSl = (p.side === 'LONG' && (cp >= p.tp || cp <= p.sl)) || (p.side === 'SHORT' && (cp <= p.tp || cp >= p.sl));

        if (isBreakEven || isExpired || isHitTpSl) {
            await exchange.createOrder(p.symbol, 'market', p.side === 'LONG' ? 'sell' : 'buy', p.qty, undefined, { reduceOnly: true, positionSide: p.side });
            if (p.isShining) {
                if (isHitTpSl) addLog(cp >= p.tp || cp <= p.tp ? "THÀ 1 PHÚT HUY HOÀNG RỒI VỤT TẮT CÒN HƠN LE LÓI CẢ TRĂM NĂM 😎😎😎" : "RA ĐẢO RỒI THÍM ƠI😭😭😭");
                else if (isBreakEven) addLog("TÝ NỮA THÌ GIÀU TO😔😔😔");
            }
            positions.delete(key); saveState();
        } else {
            const nextDca = p.side === 'LONG' ? p.entryInitial * (1 - 0.10 * (p.dca + 1)) : p.entryInitial * (1 + 0.10 * (p.dca + 1));
            if (p.dca < 3 && (p.side === 'LONG' ? cp <= nextDca : cp >= nextDca)) {
                await openPosition(p.symbol, p.side, cp, true, p.isShining);
            }
        }
    }
    setTimeout(monitorLoop, 1000);
}

// --- API & SERVER ---
const app = express();
app.use(express.json());

app.post('/api/config', (req, res) => { botSettings = { ...botSettings, ...req.body }; saveState(); addLog('⚙️ CONFIG UPDATED'); res.json({ ok: true }); });
app.post('/api/start', (req, res) => { botSettings.isRunning = true; saveState(); addLog('🚀 START'); res.json({ ok: true }); });
app.post('/api/stop', (req, res) => { botSettings.isRunning = false; saveState(); addLog('⛔ STOP'); res.json({ ok: true }); });

app.get('/api/status', async (req, res) => {
    res.json({ 
        botStatus: botSettings.isRunning ? 'RUNNING' : 'STOPPED',
        botIp: await getPublicIP(),
        market: Object.entries(coinData).map(([s,v]) => ({ symbol: s, ...v.live })),
        activePositions: Array.from(positions.values()),
        status
    });
});

app.listen(PORT, () => {
    initWS();
    autoTradeLoop();
    monitorLoop();
    addLog('✅ SYSTEM READY');
});
