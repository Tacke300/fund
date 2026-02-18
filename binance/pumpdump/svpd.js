import WebSocket from 'ws';
import http from 'http';
import https from 'https';
import express from 'express';
import { URL } from 'url';
import crypto from 'crypto';
import { API_KEY, SECRET_KEY } from './config.js';

const app = express();
const port = 9000;

const BINANCE_FAPI_BASE_URL = 'fapi.binance.com';
const BINANCE_WS_URL = 'wss://fstream.binance.com/stream?streams=';

// --- THAY ĐỔI THEO YÊU CẦU: 5 PHÚT ---
const WINDOW_MINUTES = 5; 
let coinData = {};
let topRankedCoinsForApi = [];
let allSymbols = [];
let wsClient = null;
let vps1DataStatus = "initializing";
let serverTimeOffset = 0;

function logVps1(message) {
    const now = new Date();
    const offset = 7 * 60 * 60 * 1000;
    const localTime = new Date(now.getTime() + offset);
    const timestamp = localTime.toISOString().replace('T', ' ').substring(0, 23);
    console.log(`[VPS1_LUFFY] ${timestamp} - ${message}`);
}

function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

async function makeHttpRequest(method, urlString, headers = {}, postData = '') {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(urlString);
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: method,
            headers: { ...headers, 'User-Agent': 'NodeJS-Client/1.0-VPS1' },
            timeout: 20000
        };
        const protocol = parsedUrl.protocol === 'https:' ? https : http;
        const req = protocol.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
                } else { reject(new Error(`Status: ${res.statusCode}`)); }
            });
        });
        req.on('error', (error) => reject(error));
        if (postData) req.write(postData);
        req.end();
    });
}

async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    const timestamp = Date.now() + serverTimeOffset;
    let queryString = Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=5000`;
    const signature = createSignature(queryString, SECRET_KEY);
    const fullUrlToCall = `https://${BINANCE_FAPI_BASE_URL}${fullEndpointPath}?${queryString}&signature=${signature}`;
    return await makeHttpRequest(method, fullUrlToCall, { 'X-MBX-APIKEY': API_KEY });
}

async function callPublicAPI(fullEndpointPath, params = {}) {
    const queryString = new URLSearchParams(params).toString();
    const fullUrlToCall = `https://${BINANCE_FAPI_BASE_URL}${fullEndpointPath}${queryString ? '?' + queryString : ''}`;
    return makeHttpRequest('GET', fullUrlToCall);
}

async function getAllFuturesSymbols() {
    try {
        const [exchangeInfo, leverageBrackets] = await Promise.all([
            callPublicAPI('/fapi/v1/exchangeInfo'),
            callSignedAPI('/fapi/v1/leverageBracket')
        ]);
        const leverageMap = new Map();
        leverageBrackets.forEach(item => {
            if (item.brackets && item.brackets.length > 0) leverageMap.set(item.symbol, item.brackets[0].initialLeverage);
        });
        return exchangeInfo.symbols
            .filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING' && (leverageMap.get(s.symbol) >= 50))
            .map(s => s.symbol);
    } catch (error) {
        logVps1(`Error symbols: ${error.message}`);
        return [];
    }
}

async function fetchInitialHistoricalData(symbolsToFetch) {
    logVps1(`Fetching 5m history for ${symbolsToFetch.length} symbols...`);
    const now = Date.now();
    for (const symbol of symbolsToFetch) {
        if (!coinData[symbol]) coinData[symbol] = { symbol, prices: [], klineOpenTime: 0 };
        try {
            // Lấy 5 cây nến 1 phút gần nhất
            const klines = await callPublicAPI('/fapi/v1/klines', { symbol, interval: '1m', limit: WINDOW_MINUTES });
            coinData[symbol].prices = klines.map(k => parseFloat(k[4]));
            coinData[symbol].currentPrice = coinData[symbol].prices[coinData[symbol].prices.length - 1];
            coinData[symbol].priceXMinAgo = coinData[symbol].prices[0];
        } catch (e) {}
        await new Promise(r => setTimeout(r, 100)); // Tránh rate limit
    }
    vps1DataStatus = "running_data_available";
}

function connectWebSocket(symbols) {
    if (wsClient) wsClient.terminate();
    const streams = symbols.map(s => `${s.toLowerCase()}@kline_1m`).join('/');
    wsClient = new WebSocket(`${BINANCE_WS_URL}${streams}`);
    wsClient.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.data && msg.data.e === 'kline') {
            const k = msg.data.k;
            const s = k.s;
            if (coinData[s] && k.x) {
                const close = parseFloat(k.c);
                coinData[s].prices.push(close);
                if (coinData[s].prices.length > WINDOW_MINUTES) coinData[s].prices.shift();
                coinData[s].currentPrice = close;
                coinData[s].priceXMinAgo = coinData[s].prices[0];
                coinData[s].lastUpdate = Date.now();
            }
        }
    });
    wsClient.on('close', () => setTimeout(() => connectWebSocket(allSymbols), 5000));
}

// --- CẢI TIẾN: TÍNH TOÁN BIẾN ĐỘNG RÕ RÀNG ---
function calculateAndRank() {
    const results = [];
    for (const symbol in coinData) {
        const d = coinData[symbol];
        if (d.prices.length >= 2) {
            // (Giá hiện tại - Giá 5 phút trước) / Giá 5 phút trước
            const change = ((d.currentPrice - d.priceXMinAgo) / d.priceXMinAgo) * 100;
            
            results.push({
                symbol: d.symbol,
                changePercent: parseFloat(change.toFixed(2)), // Có âm có dương
                direction: change >= 0 ? "LONG" : "SHORT",    // Chỉ dẫn cho bot
                currentPrice: d.currentPrice,
                price5MinAgo: d.priceXMinAgo,
                lastUpdate: d.lastUpdate ? new Date(d.lastUpdate).toISOString() : new Date().toISOString()
            });
        }
    }
    // Sắp xếp theo độ mạnh yếu (giá trị tuyệt đối)
    results.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
    topRankedCoinsForApi = results.slice(0, 50);
}

async function main() {
    try {
        const timeData = await callPublicAPI('/fapi/v1/time');
        serverTimeOffset = timeData.serverTime - Date.now();
        
        allSymbols = await getAllFuturesSymbols();
        await fetchInitialHistoricalData(allSymbols);
        connectWebSocket(allSymbols);

        // --- THEO YÊU CẦU: LÀM MỚI 30 GIÂY ---
        setInterval(calculateAndRank, 30 * 1000); 
        
        // Cập nhật lại danh sách coin mỗi giờ
        setInterval(async () => {
            allSymbols = await getAllFuturesSymbols();
            connectWebSocket(allSymbols);
        }, 60 * 60 * 1000);

    } catch (e) { logVps1(`Main Error: ${e.message}`); }

    app.get('/', (req, res) => {
        res.json({ 
            status: vps1DataStatus, 
            window: "5m",
            refreshInterval: "30s",
            data: topRankedCoinsForApi 
        });
    });

    app.listen(port, '0.0.0.0', () => logVps1(`Server running on port ${port}`));
}

main();
