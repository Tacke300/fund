const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

function getSafeFileName(username) {
    return username.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

function aggregateTrades(trades) {
    const groups = {};
    trades.forEach(t => {
        const key = t.order || t.id;
        if(!groups[key]) {
            groups[key] = { ...t, amount:0, cost:0, realizedPnl:0, fee:0 };
        }
        const g = groups[key];
        g.amount += parseFloat(t.amount);
        g.cost += (parseFloat(t.price)*parseFloat(t.amount));
        if(t.info && t.info.realizedPnl) g.realizedPnl += parseFloat(t.info.realizedPnl);
    });
    return Object.values(groups).map(g => ({
        ...g, 
        price: g.amount>0 ? g.cost/g.amount : 0
    })).sort((a,b)=>b.timestamp - a.timestamp);
}

let depositAddresses = {};
try {
    const balanceModule = require('./balance.js');
    if (balanceModule && balanceModule.usdtDepositAddressesByNetwork) {
        depositAddresses = balanceModule.usdtDepositAddressesByNetwork;
    }
} catch (e) {
    console.log("[SYSTEM] Warning: balance.js not found");
}

function initExchange(exchangeId, config) {
    try {
        let exchangeClass;
        let options = { 'enableRateLimit': true, 'timeout': 15000, 'options': { 'defaultType': 'future' } };
        
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

        if (!options.apiKey || !options.secret) {
            console.log(`[EXCHANGE] Missing API Key/Secret for ${exchangeId}`);
            return null;
        }
        return new exchangeClass(options);
    } catch (e) {
        console.error(`[EXCHANGE] Init Error: ${e.message}`);
        return null;
    }
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

            const binanceFut = config.savedBinanceFut || 0;
            const kucoinFut = config.savedKucoinFut || 0;
            const totalAssets = config.savedTotalAssets || 0;

            users.push({
                id: index++,
                username: config.username || username,
                email: config.email || 'N/A',
                vipStatus: config.vipStatus || 'none',
                binanceFuture: binanceFut,
                kucoinFuture: kucoinFut,
                totalAll: totalAssets,
                totalPnl: totalPnl,
                lastLogin: stats.mtime,
                filename: file
            });
        } catch (e) {
            console.error(`[USER LOAD] Error loading ${file}: ${e.message}`);
        }
    }
    return users;
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    console.log(`[REQUEST] ${req.method} ${req.url}`);

    if (req.method === 'GET' && req.url === '/') {
        fs.readFile(path.join(__dirname, 'admin.html'), (err, content) => {
            if(err) { res.end('Admin HTML not found'); return; }
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(content);
        });
        return;
    }

    if (req.url === '/api/users') {
        try {
            const users = await getAllUsersSummary();
            res.end(JSON.stringify(users));
        } catch (e) {
            console.error(`[API USERS] Error: ${e.message}`);
            res.end('[]');
        }
        return;
    }

    // --- FIX: API DETAILS ---
    if (req.url.startsWith('/api/details/')) {
        let username = 'UNKNOWN';
        try {
            const urlParts = req.url.split('/api/details/');
            if (urlParts.length < 2) throw new Error("URL Invalid");
            username = decodeURIComponent(urlParts[1]);
            const safeName = getSafeFileName(username);

            console.log(`[DETAILS] Processing for: ${username}`);

            const configPath = path.join(USER_DATA_DIR, `${safeName}_config.json`);
            if (!fs.existsSync(configPath)) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: "User config not found", totalUsdt: 0 }));
                return;
            }
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

            // Đọc lịch sử bot từ file
            let botHistory = [];
            const histPath = path.join(USER_DATA_DIR, `${safeName}_history.json`);
            if(fs.existsSync(histPath)) {
                try { botHistory = JSON.parse(fs.readFileSync(histPath, 'utf8')); } catch(e){}
            }

            // Đọc biểu đồ
            let balanceHistory = [];
            try {
                const bPath = path.join(USER_DATA_DIR, `${safeName}_balance_history.json`);
                if(fs.existsSync(bPath)) {
                    const raw = JSON.parse(fs.readFileSync(bPath, 'utf8'));
                    if(raw.length > 300) {
                        const step = Math.ceil(raw.length/300);
                        balanceHistory = raw.filter((_,i)=>i%step===0);
                    } else balanceHistory = raw;
                }
            } catch(e){}

            const checkExchange = async (exName, exId) => {
                console.log(`[DETAILS] Connecting to ${exName}...`);
                try {
                    const ex = initExchange(exId, config);
                    if (!ex) return { total: 0, free: 0, positions: [], spot: [], rawTrades: [], aggTrades: [], closedOrders: [] };

                    await ex.loadMarkets();
                    const bal = await ex.fetchBalance();
                    const total = bal.total['USDT'] || 0;
                    const free = bal.free['USDT'] || 0;

                    // 1. Live Positions
                    let positions = [];
                    try {
                        const rawPos = await ex.fetchPositions();
                        // Fix leverage Binance
                        positions = rawPos.filter(p => parseFloat(p.contracts) > 0).map(p => {
                            let lev = p.leverage;
                            if(exId==='binanceusdm' && (!lev || lev=='undefined')) lev = p.info.leverage;
                            return { ...p, leverage: lev };
                        });
                    } catch (e) { console.log(`[Pos Error] ${exName}: ${e.message}`); }

                    // 2. Open Orders (TP/SL)
                    let openOrders = [];
                    try { openOrders = await ex.fetchOpenOrders(); } catch(e){}

                    // 3. Raw Trades (MyTrades)
                    let rawTrades = [];
                    try {
                        // Hack: Lấy 30 trade gần nhất (Binance Future bắt buộc symbol nên có thể lỗi nếu gọi không tham số -> catch)
                        rawTrades = await ex.fetchMyTrades(undefined, undefined, 30);
                    } catch(e) {}

                    // 4. Aggregated Trades
                    let aggTrades = aggregateTrades(rawTrades);

                    // 5. Closed Orders
                    let closedOrders = [];
                    try {
                        closedOrders = await ex.fetchClosedOrders(undefined, undefined, 20);
                    } catch(e){}

                    // 6. Spot
                    let spotAssets = [];
                    try {
                        const spotExId = exId === 'binanceusdm' ? 'binance' : 'kucoin';
                        const spotEx = initExchange(spotExId, config);
                        if(spotEx) {
                            const sBal = await spotEx.fetchBalance();
                            spotAssets = sBal.total['USDT'] || 0;
                        }
                    } catch(e) {}

                    // Map TP/SL vào Positions
                    positions = positions.map(p => {
                        const related = openOrders.filter(o => o.symbol === p.symbol);
                        return { ...p, openOrders: related };
                    });

                    return { 
                        total: total, 
                        free: free, 
                        positions: positions, 
                        spot: spotAssets,
                        future: { equity: total },
                        rawTrades: rawTrades,
                        aggTrades: aggTrades,
                        closedOrders: closedOrders
                    };

                } catch (e) {
                    console.log(`[DETAILS] ${exName} FAILED: ${e.message}`);
                    return { total: 0, free: 0, error: e.message };
                }
            };

            const [binance, kucoin] = await Promise.all([
                checkExchange('Binance', 'binanceusdm'),
                checkExchange('Kucoin', 'kucoinfutures')
            ]);

            const responsePayload = {
                username: username,
                binance: binance,
                kucoin: kucoin,
                totalUsdt: (binance.total + kucoin.total),
                totalSpotUsdt: ((binance.spot||0) + (kucoin.spot||0)),
                totalFutureEquity: (binance.total + kucoin.total),
                botHistory: botHistory,
                balanceHistory: balanceHistory,
                logs: []
            };

            console.log(`[DETAILS] Sending response for ${username}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responsePayload));

        } catch (error) {
            console.error(`[DETAILS] CRITICAL ERROR: ${error.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message, totalUsdt: 0 }));
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
                    : users.map(u => `${getSafeFileName(u)}_config.json`); // Fix name

                let count = 0;
                for (const file of targetFiles) {
                    const filePath = path.join(USER_DATA_DIR, file);
                    if (fs.existsSync(filePath)) {
                        const cfg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                        cfg.vipStatus = vipStatus;
                        cfg.vipExpiry = (vipStatus==='vip') ? Date.now()+30*86400000 : 0;
                        fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2));
                        count++;
                    }
                }
                res.end(JSON.stringify({ success: true }));
            } catch(e) {
                res.writeHead(500); 
                res.end(JSON.stringify({ success: false })); 
            }
        });
        return;
    }
});

server.listen(PORT, () => {
    console.log(`Admin Bot running at http://localhost:${PORT}`);
});
