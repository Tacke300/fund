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
        let options = { 
            'enableRateLimit': true, 
            'timeout': 15000,
            'options': { 'defaultType': 'future' } // Bắt buộc để lấy đúng future binance
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

            // --- LẤY DỮ LIỆU FILE BOT TRƯỚC ---
            let botActiveTrades = [];
            try {
                const p = path.join(USER_DATA_DIR, `${safeName}_active_trades.json`);
                if (fs.existsSync(p)) botActiveTrades = JSON.parse(fs.readFileSync(p, 'utf8'));
            } catch(e){}

            let botHistory = [];
            try {
                const p = path.join(USER_DATA_DIR, `${safeName}_history.json`);
                if (fs.existsSync(p)) botHistory = JSON.parse(fs.readFileSync(p, 'utf8'));
            } catch(e){}

            let balanceHistory = [];
            try {
                const p = path.join(USER_DATA_DIR, `${safeName}_balance_history.json`);
                if (fs.existsSync(p)) {
                    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
                    if(raw.length > 300) { 
                        const step = Math.ceil(raw.length / 300);
                        balanceHistory = raw.filter((_, i) => i % step === 0);
                    } else balanceHistory = raw;
                }
            } catch(e){}


            // --- KẾT NỐI SÀN ---
            const checkExchange = async (exName, exId) => {
                try {
                    const ex = initExchange(exId, config);
                    if (!ex) return { total: 0, positions: [], closed: [], spot: 0 };

                    await ex.loadMarkets();
                    const bal = await ex.fetchBalance();
                    
                    // 1. Live Positions (Source of Truth)
                    let positions = [];
                    try {
                        const rawPos = await ex.fetchPositions();
                        // Chỉ lấy vị thế đang mở (size > 0)
                        positions = rawPos.filter(p => parseFloat(p.contracts) > 0).map(p => ({
                            symbol: p.symbol,
                            side: p.side,
                            size: parseFloat(p.contracts),
                            entryPrice: parseFloat(p.entryPrice),
                            leverage: p.leverage,
                            unrealizedPnl: parseFloat(p.unrealizedPnl),
                            margin: p.initialMargin ? parseFloat(p.initialMargin) : (parseFloat(p.entryPrice)*parseFloat(p.contracts)/p.leverage)
                        }));
                    } catch(e) { console.log(`${exName} Pos Error: ${e.message}`); }

                    // 2. Open Orders (TP/SL)
                    let openOrders = [];
                    try {
                        const rawOrders = await ex.fetchOpenOrders();
                        openOrders = rawOrders.map(o => ({
                            symbol: o.symbol,
                            type: o.type,
                            side: o.side,
                            price: o.price,
                            stopPrice: o.stopPrice
                        }));
                    } catch(e) {}

                    // 3. Closed Orders (History Sàn)
                    let closed = [];
                    try {
                        // Lấy 30 lệnh gần nhất
                        const rawClosed = await ex.fetchClosedOrders(undefined, undefined, 30);
                        closed = rawClosed.map(o => ({
                            id: o.id,
                            timestamp: o.timestamp,
                            symbol: o.symbol,
                            side: o.side,
                            price: o.price || o.average,
                            amount: o.amount,
                            cost: o.cost,
                            status: o.status,
                            // Binance thường có realizedPnl trong info
                            realizedPnl: (o.info && o.info.realizedPnl) ? parseFloat(o.info.realizedPnl) : null 
                        }));
                    } catch(e) { console.log(`${exName} Hist Error: ${e.message}`); }

                    // 4. Spot
                    let spotTotal = 0;
                    try {
                        const spotExId = exId === 'binanceusdm' ? 'binance' : 'kucoin';
                        const spotEx = initExchange(spotExId, config);
                        if(spotEx) {
                            const sBal = await spotEx.fetchBalance();
                            spotTotal = (sBal.total['USDT'] || 0);
                        }
                    } catch(e) {}

                    // Map TP/SL vào Positions
                    positions = positions.map(p => {
                        const relatedOrders = openOrders.filter(o => o.symbol === p.symbol);
                        return { ...p, openOrders: relatedOrders };
                    });

                    return { 
                        total: bal.total['USDT'] || 0, 
                        positions: positions, 
                        closed: closed,
                        spot: spotTotal 
                    };
                } catch (e) {
                    return { total: 0, positions: [], closed: [], spot: 0, error: e.message };
                }
            };

            const [binance, kucoin] = await Promise.all([
                checkExchange('Binance', 'binanceusdm'),
                checkExchange('Kucoin', 'kucoinfutures')
            ]);

            // --- XỬ LÝ MERGE HISTORY (QUAN TRỌNG) ---
            // Gộp lịch sử 2 sàn lại
            let unifiedHistory = [];

            // Helper: Tìm xem lệnh sàn này có khớp với Bot không
            const findBotMatch = (exOrder, exchangeName) => {
                // Logic: Tìm trong botHistory xem có lệnh nào gần giờ đó, cùng Symbol không
                // Bot lưu trade (Long+Short). Exchange lưu Order lẻ.
                // Đơn giản: Check symbol và thời gian entry (trong khoảng 5 phút)
                return botHistory.find(b => {
                    const isSymbolMatch = (exchangeName === 'Binance' ? b.shortExchange.includes('binance') || b.longExchange.includes('binance') : b.shortExchange.includes('kucoin') || b.longExchange.includes('kucoin')) 
                                          && b.coin.includes(exOrder.symbol.replace('/USDT','').replace('USDT',''));
                    // Bot history time là Entry Time. Closed order time là Exit Time.
                    // Cái này khó match chính xác 100% nếu không lưu OrderID.
                    // Tạm thời: Nếu user không trade tay nhiều thì giả định các lệnh lạ là User.
                    // Ở đây ta sẽ check xem OrderID có trong Bot Active Trades cũ không (nếu có lưu).
                    // Vì bot cũ ko lưu closed OrderID, ta dùng Heuristic:
                    return isSymbolMatch; 
                });
            };
            
            // Xử lý Binance History
            binance.closed.forEach(o => {
                const botMatch = findBotMatch(o, 'Binance');
                unifiedHistory.push({
                    time: o.timestamp,
                    exchange: 'Binance',
                    symbol: o.symbol,
                    side: o.side,
                    price: o.price,
                    amount: o.amount,
                    pnl: o.realizedPnl, // PnL thực tế từ sàn
                    source: botMatch ? 'BOT' : 'USER'
                });
            });

            // Xử lý Kucoin History
            kucoin.closed.forEach(o => {
                const botMatch = findBotMatch(o, 'Kucoin');
                unifiedHistory.push({
                    time: o.timestamp,
                    exchange: 'Kucoin',
                    symbol: o.symbol,
                    side: o.side,
                    price: o.price,
                    amount: o.amount,
                    pnl: null, // Kucoin API closed orders thường không trả PnL trực tiếp
                    source: botMatch ? 'BOT' : 'USER'
                });
            });

            // Sắp xếp lịch sử mới nhất
            unifiedHistory.sort((a,b) => b.time - a.time);


            // --- XỬ LÝ LIVE POSITIONS ---
            // Tag xem Position nào là của Bot
            const tagPosition = (pos, exName) => {
                const match = botActiveTrades.find(b => pos.symbol.includes(b.coin.replace('USDT','')));
                return {
                    ...pos,
                    source: match ? 'BOT' : 'USER',
                    botData: match || null // Kèm data margin/entry gốc của bot nếu cần
                };
            };

            const livePositions = [
                ...binance.positions.map(p => ({...tagPosition(p, 'Binance'), exchange: 'Binance'})),
                ...kucoin.positions.map(p => ({...tagPosition(p, 'Kucoin'), exchange: 'Kucoin'}))
            ];


            const responsePayload = {
                username: username,
                binanceTotal: binance.total,
                kucoinTotal: kucoin.total,
                totalUsdt: (binance.total + kucoin.total),
                totalSpotUsdt: binance.spot + kucoin.spot,
                
                livePositions: livePositions,   // Dữ liệu thực tế từ sàn
                unifiedHistory: unifiedHistory, // Lịch sử gộp (Có Bot/User)
                balanceHistory: balanceHistory  // Biểu đồ
            };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responsePayload));

        } catch (error) {
            console.error(error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    // API cũ giữ nguyên
    if (req.method === 'POST' && req.url === '/api/transfer') {
        res.end(JSON.stringify({ logs: ['Request received'] }));
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
