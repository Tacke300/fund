const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

// --- HÀM HỖ TRỢ ---
function getSafeFileName(username) {
    return username.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

function normSym(symbol) {
    if (!symbol) return '';
    return symbol.replace(/[-_/: ]/g, '').toUpperCase().replace('USDTM', 'USDT');
}

// CÁCH 4: GỘP LỆNH (AGGREGATION)
function aggregateTrades(trades) {
    const groups = {};
    trades.forEach(t => {
        const key = t.order || t.id;
        if (!groups[key]) {
            groups[key] = {
                timestamp: t.timestamp,
                symbol: t.symbol,
                side: t.side,
                amount: 0,
                cost: 0,
                realizedPnl: 0,
                fee: 0,
                orderId: key
            };
        }
        const g = groups[key];
        g.amount += parseFloat(t.amount);
        g.cost += (parseFloat(t.price) * parseFloat(t.amount));
        if (t.info && t.info.realizedPnl) g.realizedPnl += parseFloat(t.info.realizedPnl);
    });
    return Object.values(groups).map(g => ({
        ...g,
        price: g.amount > 0 ? g.cost / g.amount : 0
    })).sort((a, b) => b.timestamp - a.timestamp);
}

// --- INIT EXCHANGE ---
function initExchange(exchangeId, config) {
    try {
        let exchangeClass;
        let options = { 
            'enableRateLimit': true, 
            'timeout': 15000, 
            'options': { 'defaultType': 'future', 'warnOnFetchOpenOrdersWithoutSymbol': false } 
        };
        
        if (exchangeId.includes('binance')) {
            exchangeClass = exchangeId === 'binanceusdm' ? ccxt.binanceusdm : ccxt.binance;
            options.apiKey = config.binanceApiKey;
            options.secret = config.binanceApiSecret;
        } else if (exchangeId.includes('kucoin')) {
            exchangeClass = exchangeId === 'kucoinfutures' ? ccxt.kucoinfutures : ccxt.kucoin;
            options.apiKey = config.kucoinApiKey;
            options.secret = config.kucoinApiSecret;
            options.password = config.kucoinPassword || config.kucoinApiPassword;
        }

        if (!options.apiKey || !options.secret) return null;
        return new exchangeClass(options);
    } catch (e) { return null; }
}

async function getAllUsersSummary() {
    if (!fs.existsSync(USER_DATA_DIR)) return [];
    const files = fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json'));
    const users = [];
    let index = 1;
    for (const file of files) {
        try {
            const filePath = path.join(USER_DATA_DIR, file);
            const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const stats = fs.statSync(filePath);
            let totalPnl = 0;
            const username = config.username || file.replace('_config.json', '');
            const safeName = getSafeFileName(username);
            const histFile = path.join(USER_DATA_DIR, `${safeName}_history.json`);
            if (fs.existsSync(histFile)) {
                try {
                    const history = JSON.parse(fs.readFileSync(histFile, 'utf8'));
                    if (Array.isArray(history)) totalPnl = history.reduce((sum, trade) => sum + (parseFloat(trade.actualPnl) || 0), 0);
                } catch(e) {}
            }
            users.push({
                id: index++, username: username, email: config.email || 'N/A', vipStatus: config.vipStatus || 'none',
                binanceFuture: config.savedBinanceFut || 0, kucoinFuture: config.savedKucoinFut || 0,
                totalAll: config.savedTotalAssets || 0, totalPnl: totalPnl, lastLogin: stats.mtime, filename: file
            });
        } catch (e) {}
    }
    return users;
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    if (req.method === 'GET' && req.url === '/') {
        fs.readFile(path.join(__dirname, 'admin.html'), (err, content) => {
            if(err) { res.end('HTML not found'); return; }
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(content);
        });
        return;
    }

    if (req.url === '/api/users') {
        const users = await getAllUsersSummary();
        res.end(JSON.stringify(users));
        return;
    }

    // --- API DETAILS (SỬA LOGIC LẤY 5 BẢNG) ---
    if (req.url.startsWith('/api/details/')) {
        let username = 'UNKNOWN';
        const logs = [];
        try {
            const urlParts = req.url.split('/api/details/');
            username = decodeURIComponent(urlParts[1]);
            const safeName = getSafeFileName(username);
            const configPath = path.join(USER_DATA_DIR, `${safeName}_config.json`);
            
            if (!fs.existsSync(configPath)) {
                res.writeHead(404); res.end(JSON.stringify({ error: "User not found" })); return;
            }
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

            // 1. DATA BOT (DÙNG ĐỂ ENRICH INFO)
            let botHistory = [], botActive = [], balanceHistory = [];
            try {
                const hPath = path.join(USER_DATA_DIR, `${safeName}_history.json`);
                if(fs.existsSync(hPath)) botHistory = JSON.parse(fs.readFileSync(hPath, 'utf8'));
                const aPath = path.join(USER_DATA_DIR, `${safeName}_active_trades.json`);
                if(fs.existsSync(aPath)) botActive = JSON.parse(fs.readFileSync(aPath, 'utf8'));
                const bPath = path.join(USER_DATA_DIR, `${safeName}_balance_history.json`);
                if(fs.existsSync(bPath)) {
                    const raw = JSON.parse(fs.readFileSync(bPath, 'utf8'));
                    if(raw.length>200) balanceHistory = raw.filter((_,i)=>i%Math.ceil(raw.length/200)===0); else balanceHistory=raw;
                }
            } catch(e){}

            // Hàm tìm thông tin từ Bot để điền vào
            const enrichInfo = (symbol) => {
                const clean = normSym(symbol);
                let match = botActive.find(b => normSym(b.coin) === clean);
                if(match) return { openTime: match.entryTime, margin: match.collateral, lev: match.leverage };
                match = botHistory.find(b => normSym(b.coin) === clean);
                if(match) return { openTime: match.entryTime, margin: match.collateral, lev: match.leverage };
                return { openTime: null, margin: null, lev: null };
            };

            const checkExchange = async (exName, exId) => {
                const data = { total: 0, spot: 0, m1_live:[], m2_closed:[], m3_raw:[], m4_agg:[], m5_income:[] };
                try {
                    const ex = initExchange(exId, config);
                    if (!ex) return data;
                    await ex.loadMarkets();
                    const bal = await ex.fetchBalance();
                    data.total = bal.total['USDT'] || 0;

                    // M1: LIVE POSITIONS
                    try {
                        const rawPos = await ex.fetchPositions();
                        const openOrders = await ex.fetchOpenOrders();
                        data.m1_live = rawPos.filter(p => parseFloat(p.contracts) > 0).map(p => {
                            const info = enrichInfo(p.symbol);
                            const clean = normSym(p.symbol);
                            const tpsl = openOrders.filter(o => normSym(o.symbol) === clean);
                            let lev = p.leverage;
                            if (exId === 'binanceusdm' && (!lev || lev == 'undefined')) lev = p.info.leverage || '20';
                            
                            return {
                                symbol: p.symbol, side: p.side, size: p.contracts, entry: p.entryPrice,
                                lev: lev, pnl: p.unrealizedPnl, 
                                margin: info.margin || p.initialMargin, // Lấy từ bot
                                openOrders: tpsl
                            };
                        });
                    } catch(e) { logs.push(`${exName} Pos: ${e.message}`); }

                    // CHUẨN BỊ SYMBOL ĐỂ QUERY HISTORY (Binance bắt buộc)
                    let targetCoins = [...botHistory.slice(0, 8).map(x=>x.coin), ...data.m1_live.map(x=>x.symbol), ...botActive.map(x=>x.coin)];
                    targetCoins = [...new Set(targetCoins.map(c => normSym(c)))];

                    // M2: CLOSED ORDERS
                    try {
                        let closed = [];
                        if (exId === 'binanceusdm') {
                            for (let c of targetCoins) {
                                const m = Object.values(ex.markets).find(m => normSym(m.symbol) === c);
                                if(m) closed.push(...await ex.fetchClosedOrders(m.id, undefined, 5));
                            }
                        } else closed = await ex.fetchClosedOrders(undefined, undefined, 20);
                        
                        data.m2_closed = closed.map(o => {
                            const info = enrichInfo(o.symbol);
                            return { ...o, botInfo: info };
                        });
                    } catch(e){}

                    // M3: MY TRADES (RAW)
                    try {
                        let raw = [];
                        if (exId === 'binanceusdm') {
                            for (let c of targetCoins) {
                                const m = Object.values(ex.markets).find(m => normSym(m.symbol) === c);
                                if(m) raw.push(...await ex.fetchMyTrades(m.id, undefined, 5));
                            }
                        } else raw = await ex.fetchMyTrades(undefined, undefined, 30);
                        
                        data.m3_raw = raw.map(t => {
                            const info = enrichInfo(t.symbol);
                            return { ...t, botInfo: info };
                        });
                    } catch(e){}

                    // M4: AGGREGATED (GỘP TỪ M3)
                    data.m4_agg = aggregateTrades(data.m3_raw).map(t => {
                        const info = enrichInfo(t.symbol);
                        return { ...t, botInfo: info };
                    });

                    // M5: INCOME (PNL THỰC TẾ)
                    try {
                        if (exId === 'binanceusdm') {
                            data.m5_income = await ex.fetchIncome(undefined, undefined, 50, {incomeType: 'REALIZED_PNL'});
                        } else {
                            const led = await ex.fetchLedger(undefined, undefined, 50);
                            data.m5_income = led.filter(l => l.info.type === 'RealisedPNL');
                        }
                        // Enrich cho Income
                        data.m5_income = data.m5_income.map(i => {
                            const sym = i.symbol || i.info.symbol || i.currency; // Cố lấy symbol
                            return { ...i, botInfo: enrichInfo(sym) };
                        });
                    } catch(e){}

                    // SPOT
                    try {
                        const spotEx = initExchange(exId === 'binanceusdm' ? 'binance' : 'kucoin', config);
                        if(spotEx) { const sBal = await spotEx.fetchBalance(); data.spot = sBal.total['USDT'] || 0; }
                    } catch(e){}

                } catch (e) { logs.push(`${exName} Err: ${e.message}`); }
                return data;
            };

            const [binance, kucoin] = await Promise.all([
                checkExchange('Binance', 'binanceusdm'),
                checkExchange('Kucoin', 'kucoinfutures')
            ]);

            const response = {
                username, logs,
                totalUsdt: binance.total + kucoin.total,
                balanceHistory,
                binance, kucoin
            };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));

        } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
        return;
    }

    // --- CÁC API POST GỐC (GIỮ NGUYÊN) ---
    if (req.method === 'POST' && req.url === '/api/transfer') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => res.end(JSON.stringify({ logs: ['Request received. Processing...'] })));
        return;
    }
    if (req.method === 'POST' && req.url === '/api/admin/set-vip') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { users, vipStatus } = JSON.parse(body);
                const targetFiles = (users === 'ALL') ? fs.readdirSync(USER_DATA_DIR).filter(f=>f.endsWith('_config.json')) : users.map(u => `${getSafeFileName(u)}_config.json`);
                for (const file of targetFiles) {
                    const p = path.join(USER_DATA_DIR, file);
                    if(fs.existsSync(p)) {
                        const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
                        cfg.vipStatus = vipStatus;
                        cfg.vipExpiry = (vipStatus==='vip') ? Date.now()+30*86400000 : 0;
                        fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
                    }
                }
                res.end(JSON.stringify({ success: true }));
            } catch(e) { res.end(JSON.stringify({ success: false })); }
        });
        return;
    }
});

server.listen(PORT, () => {
    console.log(`Admin Bot running at http://localhost:${PORT}`);
});
