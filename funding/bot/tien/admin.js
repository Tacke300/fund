const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

function getSafeFileName(username) {
    return username.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

function initExchange(exchangeId, config) {
    try {
        let exchangeClass;
        let options = { 'enableRateLimit': true, 'timeout': 10000 };
        
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
        } catch (e) { }
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

    if (req.url.startsWith('/api/details/')) {
        let username = 'UNKNOWN';
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

            // --- KẾT NỐI SÀN: LẤY VỊ THẾ LIVE + LỆNH CHỜ (TP/SL) ---
            const checkExchange = async (exName, exId) => {
                try {
                    const ex = initExchange(exId, config);
                    if (!ex) return { total: 0, positions: [], orders: [], spot: 0 };

                    await ex.loadMarkets();
                    const bal = await ex.fetchBalance();
                    
                    // Lấy vị thế thực tế
                    let positions = [];
                    try {
                        const rawPos = await ex.fetchPositions();
                        positions = rawPos.filter(p => parseFloat(p.contracts) > 0);
                    } catch(e) {}

                    // Lấy lệnh chờ (TP/SL)
                    let openOrders = [];
                    try {
                        openOrders = await ex.fetchOpenOrders();
                    } catch(e) {}

                    let spotTotal = 0;
                    try {
                        const spotExId = exId === 'binanceusdm' ? 'binance' : 'kucoin';
                        const spotEx = initExchange(spotExId, config);
                        if(spotEx) {
                            const sBal = await spotEx.fetchBalance();
                            spotTotal = (sBal.total['USDT'] || 0);
                        }
                    } catch(e) {}

                    return { 
                        total: bal.total['USDT'] || 0, 
                        positions: positions, 
                        orders: openOrders, // Trả về lệnh chờ
                        spot: spotTotal 
                    };
                } catch (e) {
                    return { total: 0, positions: [], orders: [], spot: 0, error: e.message };
                }
            };

            const [binance, kucoin] = await Promise.all([
                checkExchange('Binance', 'binanceusdm'),
                checkExchange('Kucoin', 'kucoinfutures')
            ]);

            // --- ĐỌC FILE ACTIVE TRADES (Để lấy Margin gốc, Cặp coin) ---
            let activeTrades = [];
            const activePath = path.join(USER_DATA_DIR, `${safeName}_active_trades.json`);
            if (fs.existsSync(activePath)) {
                try { activeTrades = JSON.parse(fs.readFileSync(activePath, 'utf8')); } catch(e){}
            }

            // --- GHÉP DATA ACTIVE VỚI LIVE PNL TỪ SÀN ---
            // Mục đích: Hiển thị đúng cặp (Pair), nhưng PnL phải là Real-time
            const enrichedActiveTrades = activeTrades.map(trade => {
                // Tìm vị thế thực tế trên Binance/Kucoin tương ứng với coin này
                const bPos = binance.positions.find(p => p.symbol.replace(/[-_/]/g,'').includes(trade.coin.replace('USDT','')));
                const kPos = kucoin.positions.find(p => p.symbol.replace(/[-_/]/g,'').includes(trade.coin.replace('USDT','')));
                
                // Lấy PnL thực tế
                const bPnl = bPos ? parseFloat(bPos.unrealizedPnl) : 0;
                const kPnl = kPos ? parseFloat(kPos.unrealizedPnl) : 0;
                
                // Tìm lệnh TP/SL liên quan
                // Lọc orders của coin này
                const filterOrders = (orders, symbol) => orders.filter(o => o.symbol.replace(/[-_/]/g,'').includes(symbol.replace('USDT','')));
                const bOrders = filterOrders(binance.orders, trade.coin);
                const kOrders = filterOrders(kucoin.orders, trade.coin);

                return {
                    ...trade,
                    livePnlLong: (trade.longExchange.includes('binance') ? bPnl : kPnl),
                    livePnlShort: (trade.shortExchange.includes('binance') ? bPnl : kPnl),
                    netPnl: bPnl + kPnl,
                    tpSlOrders: [...bOrders, ...kOrders].map(o => ({
                        type: o.type, 
                        side: o.side, 
                        price: o.price || o.stopPrice, 
                        ex: trade.longExchange.includes('binance') && o.info.symbol ? 'Binance' : 'Kucoin' // Logic đơn giản định danh sàn
                    }))
                };
            });

            // --- ĐỌC HISTORY ---
            let tradeHistory = [];
            const hPath = path.join(USER_DATA_DIR, `${safeName}_history.json`);
            if (fs.existsSync(hPath)) {
                try { tradeHistory = JSON.parse(fs.readFileSync(hPath, 'utf8')); } catch(e){}
            }

            // --- ĐỌC BALANCE HISTORY ---
            let balanceHistory = [];
            const bPath = path.join(USER_DATA_DIR, `${safeName}_balance_history.json`);
            if (fs.existsSync(bPath)) {
                try {
                    const raw = JSON.parse(fs.readFileSync(bPath, 'utf8'));
                    if (raw.length > 200) {
                        const step = Math.ceil(raw.length / 200);
                        balanceHistory = raw.filter((_, i) => i % step === 0);
                    } else balanceHistory = raw;
                } catch(e){}
            }

            const responsePayload = {
                username: username,
                binance: binance, // Chứa raw positions để debug nếu cần
                kucoin: kucoin,
                totalUsdt: (binance.total + kucoin.total),
                totalSpotUsdt: (binance.spot + kucoin.spot),
                totalFutureEquity: (binance.total + kucoin.total),
                activeTrades: enrichedActiveTrades, // Dữ liệu đã ghép
                tradeHistory: tradeHistory,
                balanceHistory: balanceHistory
            };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responsePayload));

        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
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
                        cfg.vipExpiry = (vipStatus === 'vip') ? Date.now() + 30*86400000 : 0;
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
