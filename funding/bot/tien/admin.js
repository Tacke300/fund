const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

function getSafeFileName(username) {
    return username.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

function normSym(symbol) {
    if (!symbol) return '';
    return symbol.replace(/[-_/: ]/g, '').toUpperCase().replace('USDTM', 'USDT');
}

// Cách 4: Hàm gộp lệnh
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
                realizedPnl: 0
            };
        }
        groups[key].amount += parseFloat(t.amount);
        groups[key].cost += (parseFloat(t.price) * parseFloat(t.amount));
        if (t.info && t.info.realizedPnl) groups[key].realizedPnl += parseFloat(t.info.realizedPnl);
    });
    return Object.values(groups).map(g => ({
        ...g,
        price: g.amount > 0 ? g.cost / g.amount : 0
    })).sort((a, b) => b.timestamp - a.timestamp);
}

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
            const username = file.replace('_config.json', '');
            const safeName = getSafeFileName(username);
            const filePath = path.join(USER_DATA_DIR, file);
            const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const stats = fs.statSync(filePath);
            
            let totalPnl = 0;
            const histFile = path.join(USER_DATA_DIR, `${safeName}_history.json`);
            if (fs.existsSync(histFile)) {
                try {
                    const history = JSON.parse(fs.readFileSync(histFile, 'utf8'));
                    if (Array.isArray(history)) totalPnl = history.reduce((sum, trade) => sum + (parseFloat(trade.actualPnl) || 0), 0);
                } catch(e) {}
            }

            users.push({
                id: index++,
                username: config.username || username,
                email: config.email || 'N/A',
                vipStatus: config.vipStatus || 'none',
                binanceFuture: config.savedBinanceFut || 0,
                kucoinFuture: config.savedKucoinFut || 0,
                totalAll: config.savedTotalAssets || 0,
                totalPnl: totalPnl,
                lastLogin: stats.mtime
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

    // --- API CHI TIẾT ---
    if (req.url.startsWith('/api/details/')) {
        let username = 'UNKNOWN';
        const logs = [];
        try {
            const urlParts = req.url.split('/api/details/');
            username = decodeURIComponent(urlParts[1]);
            const safeName = getSafeFileName(username);
            const configPath = path.join(USER_DATA_DIR, `${safeName}_config.json`);
            
            if (!fs.existsSync(configPath)) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: "User config not found" }));
                return;
            }
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

            // [CÁCH 1] FILE BOT
            let fileHistory = [];
            try {
                const hFile = path.join(USER_DATA_DIR, `${safeName}_history.json`);
                if(fs.existsSync(hFile)) fileHistory = JSON.parse(fs.readFileSync(hFile, 'utf8'));
            } catch(e){}

            // [BIỂU ĐỒ]
            let balanceHistory = [];
            try {
                const bFile = path.join(USER_DATA_DIR, `${safeName}_balance_history.json`);
                if(fs.existsSync(bFile)) {
                    const raw = JSON.parse(fs.readFileSync(bFile, 'utf8'));
                    if(raw.length > 200) balanceHistory = raw.filter((_, i) => i % Math.ceil(raw.length/200) === 0);
                    else balanceHistory = raw;
                }
            } catch(e){}

            // KẾT NỐI SÀN
            const checkExchange = async (exName, exId) => {
                try {
                    const ex = initExchange(exId, config);
                    if (!ex) return { total: 0, positions: [], closed: [], trades: [], income: [], spot: 0 };

                    await ex.loadMarkets();
                    const bal = await ex.fetchBalance();
                    
                    // A. LIVE POSITIONS
                    let positions = [];
                    try {
                        const rawPos = await ex.fetchPositions();
                        positions = rawPos.filter(p => parseFloat(p.contracts) > 0).map(p => {
                            let lev = p.leverage;
                            if (exId === 'binanceusdm' && (!lev || lev == 'undefined')) lev = p.info.leverage || 20;
                            return {
                                symbol: p.symbol,
                                side: p.side,
                                size: parseFloat(p.contracts),
                                entryPrice: parseFloat(p.entryPrice),
                                leverage: lev,
                                unrealizedPnl: parseFloat(p.unrealizedPnl),
                                margin: p.initialMargin || ((parseFloat(p.entryPrice)*parseFloat(p.contracts))/(lev||1))
                            };
                        });
                    } catch(e) { logs.push(`${exName} Pos: ${e.message}`); }

                    // B. OPEN ORDERS (TP/SL)
                    let openOrders = [];
                    try {
                        const rawOrd = await ex.fetchOpenOrders();
                        openOrders = rawOrd.map(o => ({ symbol: o.symbol, type: o.type, side: o.side, stopPrice: o.stopPrice || o.price }));
                    } catch(e) {}

                    // C. CHUẨN BỊ SYMBOL ĐỂ LẤY LỊCH SỬ (Fix Binance)
                    let symbolsIds = [];
                    if (exId === 'binanceusdm') {
                        // Lấy 5 coin từ Bot History + Position
                        let coins = [...fileHistory.slice(0, 5).map(b=>b.coin), ...positions.map(p=>p.symbol)];
                        coins = [...new Set(coins)];
                        coins.forEach(c => {
                            const m = Object.values(ex.markets).find(m => normSym(m.symbol).includes(normSym(c)));
                            if(m) symbolsIds.push(m.id);
                        });
                    }

                    // [CÁCH 2] CLOSED ORDERS
                    let closedOrders = [];
                    try {
                        let raw = [];
                        if (exId === 'binanceusdm') {
                            for (let sym of symbolsIds) {
                                try { raw.push(...await ex.fetchClosedOrders(sym, undefined, 5)); } catch(e){}
                            }
                        } else {
                            raw = await ex.fetchClosedOrders(undefined, undefined, 20);
                        }
                        closedOrders = raw.sort((a,b)=>b.timestamp-a.timestamp);
                    } catch(e) { logs.push(`${exName} Closed: ${e.message}`); }

                    // [CÁCH 3] MY TRADES (RAW)
                    let myTrades = [];
                    try {
                        let raw = [];
                        if (exId === 'binanceusdm') {
                            for (let sym of symbolsIds) {
                                try { raw.push(...await ex.fetchMyTrades(sym, undefined, 5)); } catch(e){}
                            }
                        } else {
                            raw = await ex.fetchMyTrades(undefined, undefined, 20);
                        }
                        myTrades = raw.sort((a,b)=>b.timestamp-a.timestamp);
                    } catch(e) { logs.push(`${exName} Trades: ${e.message}`); }

                    // [CÁCH 5] INCOME / TRANSACTION HISTORY (PnL Thực)
                    let income = [];
                    try {
                        if (exId === 'binanceusdm') {
                            // Binance: fetchIncome lấy dòng tiền (REALIZED_PNL, FUNDING_FEE)
                            // Cần symbol hoặc lấy chung (binance hỗ trợ lấy chung income nhưng giới hạn thời gian)
                            const rawInc = await ex.fetchIncome(undefined, undefined, 50, {incomeType: 'REALIZED_PNL'});
                            income = rawInc;
                        } else {
                            // Kucoin: fetchLedger
                            // Kucoin futures ledger
                            const rawLed = await ex.fetchLedger(undefined, undefined, 20);
                            income = rawLed.filter(l => l.info.type === 'RealisedPNL'); // Lọc PnL
                        }
                    } catch(e) { logs.push(`${exName} Income: ${e.message}`); }

                    // Spot
                    let spotTotal = 0;
                    try {
                        const spotExId = exId === 'binanceusdm' ? 'binance' : 'kucoin';
                        const spotEx = initExchange(spotExId, config);
                        if(spotEx) {
                            const sBal = await spotEx.fetchBalance();
                            spotTotal = sBal.total['USDT'] || 0;
                        }
                    } catch(e) {}

                    // Map TP/SL
                    positions = positions.map(p => {
                        const clean = normSym(p.symbol);
                        const related = openOrders.filter(o => normSym(o.symbol).includes(clean));
                        return { ...p, openOrders: related };
                    });

                    return { 
                        total: bal.total['USDT'] || 0, 
                        positions, closedOrders, trades: myTrades, income, spot: spotTotal 
                    };

                } catch (e) {
                    return { total: 0, positions: [], closed: [], trades: [], income: [], spot: 0, error: e.message };
                }
            };

            const [binance, kucoin] = await Promise.all([
                checkExchange('Binance', 'binanceusdm'),
                checkExchange('Kucoin', 'kucoinfutures')
            ]);

            // [CÁCH 4] AGGREGATED TRADES
            const binanceAgg = aggregateTrades(binance.trades);
            const kucoinAgg = aggregateTrades(kucoin.trades);

            const responsePayload = {
                username: username,
                binance: binance,
                kucoin: kucoin,
                // Data cho 5 bảng
                fileHistory: fileHistory,
                
                binanceClosed: binance.closedOrders,
                kucoinClosed: kucoin.closedOrders,
                
                binanceRaw: binance.trades,
                kucoinRaw: kucoin.trades,
                
                binanceAgg: binanceAgg,
                kucoinAgg: kucoinAgg,
                
                binanceIncome: binance.income,
                kucoinIncome: kucoin.income,

                totalUsdt: (binance.total + kucoin.total),
                balanceHistory: balanceHistory,
                logs: logs
            };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responsePayload));

        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/api/transfer') {
        res.end(JSON.stringify({ logs: ['Skipped'] }));
        return;
    }
    if (req.method === 'POST' && req.url === '/api/admin/set-vip') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { users, vipStatus } = JSON.parse(body);
                const targetFiles = (users === 'ALL') 
                    ? fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json'))
                    : users.map(u => `${getSafeFileName(u)}_config.json`);
                for (const file of targetFiles) {
                    const filePath = path.join(USER_DATA_DIR, file);
                    if (fs.existsSync(filePath)) {
                        const cfg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                        cfg.vipStatus = vipStatus;
                        cfg.vipExpiry = (vipStatus==='vip') ? Date.now()+30*86400000 : 0;
                        fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2));
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
