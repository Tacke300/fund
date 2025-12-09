const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

// Hàm log có thời gian
function log(msg) {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    console.log(`[${time}] ${msg}`);
}

function getSafeFileName(username) {
    return username.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

function aggregateTrades(trades) {
    const groups = {};
    trades.forEach(t => {
        const orderId = t.order || t.id;
        if (!groups[orderId]) {
            groups[orderId] = {
                timestamp: t.timestamp,
                symbol: t.symbol,
                side: t.side,
                amount: 0,
                cost: 0,
                realizedPnl: 0,
                leverage: (t.info && t.info.leverage) ? t.info.leverage : null
            };
        }
        const g = groups[orderId];
        g.amount += parseFloat(t.amount);
        g.cost += (parseFloat(t.price) * parseFloat(t.amount));
        if (t.info && t.info.realizedPnl) g.realizedPnl += parseFloat(t.info.realizedPnl);
    });
    return Object.values(groups).map(g => ({
        ...g, 
        price: g.amount > 0 ? g.cost / g.amount : 0
    })).sort((a, b) => b.timestamp - a.timestamp);
}

let depositAddresses = {};
try {
    const balanceModule = require('./balance.js');
    if (balanceModule && balanceModule.usdtDepositAddressesByNetwork) {
        depositAddresses = balanceModule.usdtDepositAddressesByNetwork;
    }
} catch (e) { }

function initExchange(exchangeId, config) {
    try {
        let exchangeClass;
        // Timeout ngắn (8s) để không bị treo nếu mạng lag
        let options = { 
            'enableRateLimit': true, 
            'timeout': 8000, 
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
    } catch (e) {
        log(`[EXCHANGE] Init Error: ${e.message}`);
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

            users.push({
                id: index++,
                username: config.username || username,
                email: config.email || 'N/A',
                vipStatus: config.vipStatus || 'none',
                binanceFuture: config.savedBinanceFut || 0,
                kucoinFuture: config.savedKucoinFut || 0,
                totalAll: config.savedTotalAssets || 0,
                totalPnl: totalPnl,
                lastLogin: stats.mtime,
                filename: file
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

    // --- API DETAILS ---
    if (req.url.startsWith('/api/details/')) {
        let username = 'UNKNOWN';
        const logData = []; // Mảng chứa log để gửi về frontend
        
        // Wrapper log để ghi cả console lẫn response
        const serverLog = (msg) => {
            log(msg);
            logData.push(`[SERVER] ${msg}`);
        };

        try {
            const urlParts = req.url.split('/api/details/');
            username = decodeURIComponent(urlParts[1]);
            const safeName = getSafeFileName(username);

            serverLog(`Processing: ${username}`);

            const configPath = path.join(USER_DATA_DIR, `${safeName}_config.json`);
            if (!fs.existsSync(configPath)) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: "User config not found" }));
                return;
            }
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

            // 1. ĐỌC FILE LOCAL (Nhanh)
            let balanceHistory = [];
            try {
                const bFile = path.join(USER_DATA_DIR, `${safeName}_balance_history.json`);
                if(fs.existsSync(bFile)) {
                    const raw = JSON.parse(fs.readFileSync(bFile, 'utf8'));
                    if(raw.length > 200) {
                        const step = Math.ceil(raw.length / 200);
                        balanceHistory = raw.filter((_,i) => i % step === 0);
                    } else balanceHistory = raw;
                }
            } catch(e){}

            // 2. KẾT NỐI SÀN (Có thể chậm)
            const checkExchange = async (exName, exId) => {
                serverLog(`${exName} > Connecting...`);
                try {
                    const ex = initExchange(exId, config);
                    if (!ex) {
                        serverLog(`${exName} > INIT FAILED (No API Key)`);
                        return { total: 0, positions: [], history: [], spot: 0 };
                    }

                    await ex.loadMarkets();
                    const bal = await ex.fetchBalance();
                    
                    // --- A. Live Positions ---
                    let positions = [];
                    try {
                        const rawPos = await ex.fetchPositions();
                        positions = rawPos.filter(p => parseFloat(p.contracts) > 0).map(p => {
                            let lev = p.leverage;
                            // Fix Lev Binance
                            if(exId === 'binanceusdm' && (!lev || lev == 'undefined')) lev = (p.info && p.info.leverage) ? p.info.leverage : '20';
                            
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
                        serverLog(`${exName} > Positions: ${positions.length}`);
                    } catch(e) { serverLog(`${exName} > Pos Error: ${e.message}`); }

                    // --- B. Open Orders (TP/SL) ---
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

                    // Map TP/SL vào Positions
                    positions = positions.map(p => {
                        const cleanSym = p.symbol.replace(/[-_/: ]/g, '');
                        const related = openOrders.filter(o => o.symbol.replace(/[-_/: ]/g, '') === cleanSym);
                        return { ...p, openOrders: related };
                    });

                    // --- C. History (QUAN TRỌNG: TỐI ƯU ĐỂ KHÔNG TIMEOUT) ---
                    let history = [];
                    try {
                        let trades = [];
                        if (exId === 'binanceusdm') {
                            // CHỈ LẤY CÁC CẶP QUAN TRỌNG ĐỂ TRÁNH TREO
                            // Bao gồm: Các cặp đang có vị thế + BTC + ETH
                            let targetSymbols = ['BTC/USDT:USDT', 'ETH/USDT:USDT'];
                            positions.forEach(p => { 
                                if(ex.markets[p.symbol]) targetSymbols.push(ex.markets[p.symbol].id);
                            });
                            targetSymbols = [...new Set(targetSymbols)]; // Xóa trùng

                            serverLog(`${exName} > Fetching History for: ${targetSymbols.join(', ')}`);
                            
                            // Dùng Promise.all để fetch song song (nhanh hơn loop)
                            const historyPromises = targetSymbols.map(sym => 
                                ex.fetchMyTrades(sym, undefined, 5) // Lấy 5 lệnh gần nhất mỗi cặp
                                .catch(err => {
                                    // serverLog(`${exName} > Hist Error ${sym}: ${err.message}`); 
                                    return []; 
                                })
                            );
                            
                            const results = await Promise.all(historyPromises);
                            trades = results.flat();

                        } else {
                            // Kucoin fetch all được
                            trades = await ex.fetchMyTrades(undefined, undefined, 20);
                        }
                        
                        history = aggregateTrades(trades);
                        serverLog(`${exName} > History Loaded: ${history.length} trades`);

                    } catch(e) { serverLog(`${exName} > Hist Fatal Error: ${e.message}`); }

                    // --- D. Spot ---
                    let spotTotal = 0;
                    try {
                        const spotExId = exId === 'binanceusdm' ? 'binance' : 'kucoin';
                        const spotEx = initExchange(spotExId, config);
                        if(spotEx) {
                            const sBal = await spotEx.fetchBalance();
                            spotTotal = sBal.total['USDT'] || 0;
                        }
                    } catch(e) {}

                    return { 
                        total: bal.total['USDT'] || 0, 
                        positions: positions, 
                        history: history, 
                        spot: spotTotal 
                    };

                } catch (e) {
                    serverLog(`${exName} > CRASH: ${e.message}`);
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
            ].sort((a,b)=>b.timestamp - a.timestamp);

            const responsePayload = {
                username: username,
                binance: binance,
                kucoin: kucoin,
                totalUsdt: (binance.total + kucoin.total),
                totalSpotUsdt: (binance.spot + kucoin.spot),
                totalFutureEquity: (binance.total + kucoin.total),
                
                livePositions: [...binance.positions.map(p=>({...p, ex:'Binance'})), ...kucoin.positions.map(p=>({...p, ex:'Kucoin'}))],
                exchangeHistory: mergedHistory,
                balanceHistory: balanceHistory,
                logs: logData // Trả về log cho client hiển thị
            };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responsePayload));

        } catch (error) {
            log(`CRITICAL: ${error.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    // Các API khác giữ nguyên
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
