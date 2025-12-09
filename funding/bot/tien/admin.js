const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

// --- HÀM HỖ TRỢ: Đọc đúng tên file (quan trọng) ---
function getSafeFileName(username) {
    return username.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// --- HÀM HỖ TRỢ: Gộp lệnh khớp lẻ (Partial Fills) ---
function aggregateTrades(trades) {
    const groups = {};
    trades.forEach(t => {
        const orderId = t.order || t.id; // Group theo Order ID
        if (!groups[orderId]) {
            groups[orderId] = {
                timestamp: t.timestamp,
                symbol: t.symbol,
                side: t.side,
                amount: 0,
                cost: 0,
                realizedPnl: 0,
                fee: 0,
                leverage: (t.info && t.info.leverage) ? t.info.leverage : null
            };
        }
        const g = groups[orderId];
        g.amount += parseFloat(t.amount);
        g.cost += (parseFloat(t.price) * parseFloat(t.amount));
        
        // Lấy PnL thực tế từ sàn
        if (t.info && t.info.realizedPnl) g.realizedPnl += parseFloat(t.info.realizedPnl);
    });

    return Object.values(groups).map(g => ({
        timestamp: g.timestamp,
        symbol: g.symbol,
        side: g.side,
        price: g.amount > 0 ? (g.cost / g.amount) : 0,
        amount: g.amount,
        cost: g.cost,
        realizedPnl: g.realizedPnl,
        leverage: g.leverage
    })).sort((a, b) => b.timestamp - a.timestamp);
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
        // Tăng timeout và set defaultType future
        let options = { 
            'enableRateLimit': true, 
            'timeout': 25000,
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
            const filePath = path.join(USER_DATA_DIR, file);
            const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const stats = fs.statSync(filePath);
            
            // Fix: Đọc đúng file history theo safeName
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

            const binanceFut = config.savedBinanceFut || 0;
            const kucoinFut = config.savedKucoinFut || 0;
            const totalAssets = config.savedTotalAssets || 0;

            users.push({
                id: index++,
                username: username,
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

    // --- FIX API DETAILS: LẤY FULL DATA SÀN ---
    if (req.url.startsWith('/api/details/')) {
        let username = 'UNKNOWN';
        try {
            const urlParts = req.url.split('/api/details/');
            if (urlParts.length < 2) throw new Error("URL Invalid");
            username = decodeURIComponent(urlParts[1]);
            const safeName = getSafeFileName(username);

            console.log(`[DETAILS] Loading for: ${username}`);

            const configPath = path.join(USER_DATA_DIR, `${safeName}_config.json`);
            if (!fs.existsSync(configPath)) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: "User config not found", totalUsdt: 0 }));
                return;
            }
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

            // Đọc biểu đồ
            let balanceHistory = [];
            try {
                const bFile = path.join(USER_DATA_DIR, `${safeName}_balance_history.json`);
                if(fs.existsSync(bFile)) {
                    const raw = JSON.parse(fs.readFileSync(bFile, 'utf8'));
                    if(raw.length > 250) {
                        const step = Math.ceil(raw.length/250);
                        balanceHistory = raw.filter((_,i)=>i%step===0);
                    } else balanceHistory = raw;
                }
            } catch(e){}

            const checkExchange = async (exName, exId) => {
                console.log(`[DETAILS] Connecting ${exName}...`);
                try {
                    const ex = initExchange(exId, config);
                    if (!ex) return { total: 0, positions: [], history: [], spot: 0 };

                    await ex.loadMarkets();
                    const bal = await ex.fetchBalance();
                    const total = bal.total['USDT'] || 0;

                    // 1. LIVE POSITIONS
                    let positions = [];
                    try {
                        const rawPos = await ex.fetchPositions();
                        positions = rawPos.filter(p => parseFloat(p.contracts) > 0).map(p => {
                            // Fix Lev Binance
                            let lev = p.leverage;
                            if (exId === 'binanceusdm' && (!lev || lev == 'undefined')) {
                                lev = (p.info && p.info.leverage) ? p.info.leverage : '20';
                            }
                            return {
                                symbol: p.symbol,
                                side: p.side,
                                size: parseFloat(p.contracts),
                                entryPrice: parseFloat(p.entryPrice),
                                leverage: lev,
                                unrealizedPnl: parseFloat(p.unrealizedPnl),
                                margin: p.initialMargin ? parseFloat(p.initialMargin) : ((parseFloat(p.entryPrice)*parseFloat(p.contracts))/parseFloat(lev||1))
                            };
                        });
                        console.log(`[DETAILS] ${exName} Positions: ${positions.length}`);
                    } catch (e) { console.log(`[Pos Error] ${exName}: ${e.message}`); }

                    // 2. OPEN ORDERS (TP/SL)
                    let openOrders = [];
                    try {
                        const rawOrd = await ex.fetchOpenOrders();
                        openOrders = rawOrd.map(o => ({ 
                            symbol: o.symbol, 
                            type: o.type, 
                            side: o.side, 
                            price: o.stopPrice || o.price 
                        }));
                    } catch(e) {}

                    // 3. HISTORY (fetchMyTrades)
                    let history = [];
                    try {
                        let trades = [];
                        if (exId === 'binanceusdm') {
                            // Binance Future bắt buộc symbol. Hack: Lấy các cặp đang có lệnh + Top coins
                            let symbolsToCheck = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT'];
                            positions.forEach(p => { 
                                if(ex.markets[p.symbol]) symbolsToCheck.push(ex.markets[p.symbol].id); 
                            });
                            symbolsToCheck = [...new Set(symbolsToCheck)]; // Unique

                            for (let sym of symbolsToCheck) {
                                try {
                                    const t = await ex.fetchMyTrades(sym, undefined, 10);
                                    trades.push(...t);
                                } catch(err) {}
                            }
                        } else {
                            // Kucoin
                            try { trades = await ex.fetchMyTrades(undefined, undefined, 30); } catch(e){}
                        }
                        
                        history = aggregateTrades(trades);
                        console.log(`[DETAILS] ${exName} History: ${history.length}`);
                    } catch(e) { console.log(`[Hist Error] ${exName}: ${e.message}`); }

                    // 4. SPOT
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
                        const cleanSym = p.symbol.replace(/[-_/: ]/g, '');
                        const related = openOrders.filter(o => o.symbol.replace(/[-_/: ]/g, '') === cleanSym);
                        return { ...p, openOrders: related };
                    });

                    return { 
                        total: total, 
                        positions: positions, 
                        history: history, 
                        spot: spotTotal 
                    };

                } catch (e) {
                    console.log(`[DETAILS] ${exName} CRASH: ${e.message}`);
                    return { total: 0, positions: [], history: [], spot: 0, error: e.message };
                }
            };

            const [binance, kucoin] = await Promise.all([
                checkExchange('Binance', 'binanceusdm'),
                checkExchange('Kucoin', 'kucoinfutures')
            ]);

            const mergedHistory = [
                ...binance.history.map(h => ({...h, ex:'Binance'})),
                ...kucoin.history.map(h => ({...h, ex:'Kucoin'}))
            ].sort((a,b)=>b.timestamp-a.timestamp);

            const responsePayload = {
                username: username,
                binance: binance,
                kucoin: kucoin,
                totalUsdt: (binance.total + kucoin.total),
                totalSpotUsdt: (binance.spot + kucoin.spot),
                totalFutureEquity: (binance.total + kucoin.total),
                exchangeHistory: mergedHistory,
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
        // GIỮ NGUYÊN API CHUYỂN TIỀN
        console.log("[TRANSFER] Request received");
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            // Logic chuyển tiền thực tế sẽ nằm ở đây
            // Hiện tại trả về log mẫu để UI hiển thị
            res.end(JSON.stringify({ logs: ['Received. Processing...', 'Done (Demo)'] }));
        });
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
                        if (vipStatus === 'vip') cfg.vipExpiry = Date.now() + (30 * 86400000);
                        else if (vipStatus === 'vip_pro') cfg.vipExpiry = 9999999999999;
                        else cfg.vipExpiry = 0;
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
