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
            'options': { 'defaultType': 'future' } 
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
            
            // Lấy PnL tạm thời từ file history bot để hiển thị ngoài danh sách tổng (nếu có)
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

    // --- API DETAILS ---
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

            // --- LẤY BIỂU ĐỒ (DOWNSAMPLE) ---
            let balanceHistory = [];
            try {
                const bPath = path.join(USER_DATA_DIR, `${safeName}_balance_history.json`);
                if (fs.existsSync(bPath)) {
                    const raw = JSON.parse(fs.readFileSync(bPath, 'utf8'));
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
                    if (!ex) return { total: 0, positions: [], history: [], spot: 0 };

                    await ex.loadMarkets();
                    const bal = await ex.fetchBalance();
                    
                    // 1. Live Positions
                    let positions = [];
                    try {
                        const rawPos = await ex.fetchPositions();
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

                    // 2. Open Orders (Để xem TP/SL)
                    let openOrders = [];
                    try {
                        const rawOrders = await ex.fetchOpenOrders();
                        openOrders = rawOrders.map(o => ({ symbol: o.symbol, type: o.type, side: o.side, stopPrice: o.stopPrice || o.price }));
                    } catch(e) {}

                    // 3. Trade History (Quan trọng: Lấy PnL thực tế)
                    let history = [];
                    try {
                        // Lấy 50 giao dịch gần nhất
                        const trades = await ex.fetchMyTrades(undefined, undefined, 50);
                        
                        history = trades.map(t => {
                            let realizedPnl = 0;
                            // Binance: PnL nằm trong info.realizedPnl
                            if (t.info && t.info.realizedPnl) realizedPnl = parseFloat(t.info.realizedPnl);
                            // Kucoin: PnL thường nằm trong info (tùy API) hoặc không trả về trực tiếp ở endpoint này
                            
                            return {
                                id: t.id,
                                time: t.timestamp,
                                symbol: t.symbol,
                                side: t.side,
                                price: t.price,
                                amount: t.amount,
                                cost: t.cost,
                                pnl: realizedPnl // Quan trọng
                            };
                        });
                        
                        // Đối với Binance, ta chỉ quan tâm các lệnh Close (có PnL != 0) hoặc lệnh mở mới
                        // Ở đây ta trả về hết, frontend sẽ lọc hoặc hiển thị
                    } catch(e) { console.log(`${exName} Hist Error: ${e.message}`); }

                    // Map TP/SL vào Positions
                    positions = positions.map(p => {
                        const relatedOrders = openOrders.filter(o => o.symbol === p.symbol);
                        return { ...p, openOrders: relatedOrders };
                    });

                    // 4. Spot Balance
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
                        history: history,
                        spot: spotTotal 
                    };
                } catch (e) {
                    return { total: 0, positions: [], history: [], spot: 0, error: e.message };
                }
            };

            const [binance, kucoin] = await Promise.all([
                checkExchange('Binance', 'binanceusdm'),
                checkExchange('Kucoin', 'kucoinfutures')
            ]);

            // GỘP LỊCH SỬ 2 SÀN
            // Lưu ý: Binance trả về PnL rõ ràng. Kucoin thì ít khi trả về PnL qua API trade thường.
            const mergedHistory = [
                ...binance.history.map(h => ({ ...h, ex: 'Binance' })),
                ...kucoin.history.map(h => ({ ...h, ex: 'Kucoin' }))
            ].sort((a,b) => b.time - a.time); // Sắp xếp mới nhất trước

            const responsePayload = {
                username: username,
                binanceTotal: binance.total,
                kucoinTotal: kucoin.total,
                totalUsdt: (binance.total + kucoin.total),
                totalSpotUsdt: binance.spot + kucoin.spot,
                
                livePositions: [...binance.positions.map(p=>({...p, ex:'Binance'})), ...kucoin.positions.map(p=>({...p, ex:'Kucoin'}))],
                exchangeHistory: mergedHistory, // Lịch sử gộp
                balanceHistory: balanceHistory
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
