const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

// --- HÀM MỚI: ĐỂ ĐỌC ĐÚNG TÊN FILE BOT ---
function getSafeFileName(username) {
    return username.replace(/[^a-z0-9]/gi, '_').toLowerCase();
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
            const safeName = getSafeFileName(username); // Dùng tên chuẩn để tìm history
            const filePath = path.join(USER_DATA_DIR, file);
            const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const stats = fs.statSync(filePath);
            
            let totalPnl = 0;
            // Tìm file history theo tên chuẩn
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
            const safeName = getSafeFileName(username); // Tên file chuẩn

            console.log(`[DETAILS] Processing for: ${username}`);

            const configPath = path.join(USER_DATA_DIR, `${safeName}_config.json`);
            if (!fs.existsSync(configPath)) {
                console.log(`[DETAILS] Config file missing for ${username}`);
                res.writeHead(404);
                res.end(JSON.stringify({ error: "User config not found", totalUsdt: 0 }));
                return;
            }
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

            const checkExchange = async (exName, exId) => {
                console.log(`[DETAILS] Connecting to ${exName}...`);
                try {
                    const ex = initExchange(exId, config);
                    if (!ex) return { total: 0, positions: [], orders: [], closed: [], spot: [] };

                    await ex.loadMarkets();
                    const bal = await ex.fetchBalance();
                    const total = bal.total['USDT'] || 0;

                    // 1. Lấy Vị Thế (Positions)
                    let positions = [];
                    try {
                        const rawPos = await ex.fetchPositions();
                        positions = rawPos.filter(p => parseFloat(p.contracts) > 0);
                    } catch (e) { console.log(`[Pos Error] ${exName}: ${e.message}`); }

                    // 2. Lấy Lệnh Chờ (Open Orders - Để xem TP/SL)
                    let orders = [];
                    try {
                        orders = await ex.fetchOpenOrders();
                    } catch(e) {}

                    // 3. Lấy Lịch Sử Giao Dịch Sàn (Closed Orders - Để xem User tự đánh)
                    let closed = [];
                    try {
                        // Lấy 20 lệnh gần nhất
                        closed = await ex.fetchClosedOrders(undefined, undefined, 20);
                    } catch(e) {}

                    // 4. Lấy Spot
                    let spotAssets = [];
                    try {
                        const spotExId = exId === 'binanceusdm' ? 'binance' : 'kucoin';
                        const spotEx = initExchange(spotExId, config);
                        if(spotEx) {
                            const sBal = await spotEx.fetchBalance();
                            for(const [c, v] of Object.entries(sBal.total)) {
                                if(c === 'USDT' && v > 1) spotAssets.push({coin: c, amount: v, value: v});
                            }
                        }
                    } catch(e) {}

                    return { 
                        total: total, 
                        positions: positions, 
                        orders: orders,
                        closed: closed,
                        spot: spotAssets
                    };

                } catch (e) {
                    console.log(`[DETAILS] ${exName} FAILED: ${e.message}`);
                    return { total: 0, error: e.message };
                }
            };

            const [binance, kucoin] = await Promise.all([
                checkExchange('Binance', 'binanceusdm'),
                checkExchange('Kucoin', 'kucoinfutures')
            ]);

            // --- LẤY DỮ LIỆU TỪ FILE CỦA BOT ---
            let activeTradesFile = [];
            try {
                const p = path.join(USER_DATA_DIR, `${safeName}_active_trades.json`);
                if (fs.existsSync(p)) activeTradesFile = JSON.parse(fs.readFileSync(p, 'utf8'));
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
                    if(raw.length > 200) { // Tối ưu biểu đồ
                        const step = Math.ceil(raw.length / 200);
                        balanceHistory = raw.filter((_, i) => i % step === 0);
                    } else balanceHistory = raw;
                }
            } catch(e){}

            // --- GHÉP DỮ LIỆU (Logic quan trọng) ---
            // Ghép activeTradesFile (có margin, lev) với Live PnL từ sàn
            const mergedActiveTrades = activeTradesFile.map(trade => {
                // Tìm vị thế thực tế trên sàn
                const bPos = binance.positions ? binance.positions.find(p => p.symbol.includes(trade.coin.replace('USDT',''))) : null;
                const kPos = kucoin.positions ? kucoin.positions.find(p => p.symbol.includes(trade.coin.replace('USDT',''))) : null;
                
                const bPnl = bPos ? parseFloat(bPos.unrealizedPnl) : 0;
                const kPnl = kPos ? parseFloat(kPos.unrealizedPnl) : 0;

                // Tìm TP/SL
                const findOrders = (orders, coin) => (orders || []).filter(o => o.symbol.includes(coin.replace('USDT','')));
                const bOrders = findOrders(binance.orders, trade.coin);
                const kOrders = findOrders(kucoin.orders, trade.coin);

                return {
                    ...trade,
                    livePnlLong: (trade.longExchange.includes('binance') ? bPnl : kPnl),
                    livePnlShort: (trade.shortExchange.includes('binance') ? bPnl : kPnl),
                    netPnl: bPnl + kPnl,
                    tpSl: [...bOrders, ...kOrders] // Gộp lệnh chờ
                };
            });

            const responsePayload = {
                username: username,
                binanceTotal: binance.total,
                kucoinTotal: kucoin.total,
                totalUsdt: (binance.total + kucoin.total),
                totalSpotUsdt: (binance.spot?.reduce((a,b)=>a+b.value,0)||0) + (kucoin.spot?.reduce((a,b)=>a+b.value,0)||0),
                
                activeTrades: mergedActiveTrades, // Lệnh Bot đang chạy (Ghép live PnL)
                botHistory: botHistory,           // Lịch sử Bot
                
                // Lịch sử User (Raw từ sàn)
                exchangeHistory: {
                    binance: binance.closed || [],
                    kucoin: kucoin.closed || []
                },
                
                balanceHistory: balanceHistory // Biểu đồ
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
                    : users.map(u => `${getSafeFileName(u)}_config.json`); // Fix tên file

                let count = 0;
                for (const file of targetFiles) {
                    const filePath = path.join(USER_DATA_DIR, file);
                    if (fs.existsSync(filePath)) {
                        const cfg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                        cfg.vipStatus = vipStatus;
                        cfg.vipExpiry = (vipStatus === 'vip') ? Date.now() + 30*86400000 : (vipStatus === 'vip_pro' ? 9999999999999 : 0);
                        fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2));
                        count++;
                    }
                }
                console.log(`[ADMIN] VIP updated for ${count} users`);
                res.end(JSON.stringify({ success: true, message: `Updated ${count} users.` }));
            } catch(e) {
                console.error(`[ADMIN] VIP Set Error: ${e.message}`);
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
