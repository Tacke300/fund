const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

function getSafeFileName(username) {
    return username.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// Chuẩn hóa tên coin: "RIVER/USDT:USDT" -> "RIVERUSDT"
function normSym(symbol) {
    if (!symbol) return '';
    return symbol.replace(/[-_/: ]/g, '').toUpperCase().replace('USDTM', 'USDT');
}

// GỘP LỆNH THÔNG MINH
// Gộp các lệnh cùng Symbol + Side + Gần thời gian nhau (trong vòng 2 phút)
function smartAggregate(trades) {
    if (!trades || trades.length === 0) return [];
    
    // Sắp xếp theo thời gian
    trades.sort((a, b) => a.timestamp - b.timestamp);

    const merged = [];
    let current = null;

    for (const t of trades) {
        // Bỏ qua lệnh quá nhỏ (< 1$) để đỡ rác
        const cost = parseFloat(t.cost) || (parseFloat(t.price) * parseFloat(t.amount));
        if (cost < 1) continue;

        if (!current) {
            current = { ...t, amount: parseFloat(t.amount), cost: cost, realizedPnl: 0 };
            if (t.info && t.info.realizedPnl) current.realizedPnl = parseFloat(t.info.realizedPnl);
            continue;
        }

        // Nếu cùng Symbol, cùng Side và thời gian chênh lệch < 2 phút -> Gộp
        if (t.symbol === current.symbol && t.side === current.side && (t.timestamp - current.timestamp < 120000)) {
            current.amount += parseFloat(t.amount);
            current.cost += cost;
            if (t.info && t.info.realizedPnl) current.realizedPnl += parseFloat(t.info.realizedPnl);
            // Cập nhật timestamp mới nhất
            current.timestamp = t.timestamp;
        } else {
            // Đẩy lệnh cũ vào list, tạo lệnh mới
            merged.push(current);
            current = { ...t, amount: parseFloat(t.amount), cost: cost, realizedPnl: 0 };
            if (t.info && t.info.realizedPnl) current.realizedPnl = parseFloat(t.info.realizedPnl);
        }
    }
    if (current) merged.push(current);

    return merged.reverse(); // Mới nhất lên đầu
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

            // 1. DATA BOT (Tham chiếu)
            let botHistory = [];
            try {
                const hFile = path.join(USER_DATA_DIR, `${safeName}_history.json`);
                if(fs.existsSync(hFile)) botHistory = JSON.parse(fs.readFileSync(hFile, 'utf8'));
            } catch(e){}

            let botActive = [];
            try {
                const aFile = path.join(USER_DATA_DIR, `${safeName}_active_trades.json`);
                if(fs.existsSync(aFile)) botActive = JSON.parse(fs.readFileSync(aFile, 'utf8'));
            } catch(e){}

            // Hàm tìm info từ Bot (Thêm check lỏng hơn)
            const enrichInfo = (symbol) => {
                const clean = normSym(symbol); // Ví dụ: RIVERUSDT
                // Tìm coin có chứa chuỗi (để khớp RIVERUSDT với RIVER)
                let match = botActive.find(b => clean.includes(normSym(b.coin)));
                if (!match) match = botHistory.find(b => clean.includes(normSym(b.coin)));
                
                if (match) return { margin: match.collateral, lev: match.leverage, openTime: match.entryTime };
                return { margin: null, lev: null, openTime: null };
            };

            // Chart Data
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
                    if (!ex) return { total: 0, positions: [], history: [], spot: 0 };

                    await ex.loadMarkets();
                    const bal = await ex.fetchBalance();
                    
                    // A. LIVE POSITIONS
                    let positions = [];
                    try {
                        const rawPos = await ex.fetchPositions();
                        positions = rawPos.filter(p => parseFloat(p.contracts) > 0).map(p => {
                            const botInfo = enrichInfo(p.symbol);
                            let lev = p.leverage;
                            if (exId === 'binanceusdm' && (!lev || lev == 'undefined')) {
                                lev = (p.info && p.info.leverage) ? p.info.leverage : botInfo.lev;
                            }

                            return {
                                symbol: p.symbol,
                                side: p.side,
                                size: parseFloat(p.contracts),
                                entryPrice: parseFloat(p.entryPrice),
                                leverage: lev || 20,
                                unrealizedPnl: parseFloat(p.unrealizedPnl),
                                margin: botInfo.margin || p.initialMargin || ((parseFloat(p.entryPrice)*parseFloat(p.contracts))/(lev||1))
                            };
                        });
                    } catch(e) { logs.push(`${exName} Pos: ${e.message}`); }

                    // B. TP/SL
                    let openOrders = [];
                    try {
                        const rawOrd = await ex.fetchOpenOrders();
                        openOrders = rawOrd.map(o => ({ symbol: o.symbol, type: o.type, side: o.side, stopPrice: o.stopPrice || o.price }));
                    } catch(e) {}

                    // C. HISTORY (LẤY & GỘP)
                    let history = [];
                    try {
                        let trades = [];
                        if (exId === 'binanceusdm') {
                            // Lấy danh sách coin từ Bot + Position + BTC/ETH
                            let coinsToCheck = [...botHistory.slice(0, 5).map(b=>b.coin), ...positions.map(p=>p.symbol), 'BTC/USDT'];
                            // Map sang ID market
                            let symbolsIds = [];
                            coinsToCheck.forEach(c => {
                                const m = Object.values(ex.markets).find(m => normSym(m.symbol).includes(normSym(c)));
                                if(m) symbolsIds.push(m.id);
                            });
                            symbolsIds = [...new Set(symbolsIds)];

                            const promises = symbolsIds.slice(0, 5).map(sym => ex.fetchMyTrades(sym, undefined, 10).catch(e=>[]));
                            const results = await Promise.all(promises);
                            trades = results.flat();
                        } else {
                            try {
                                const t = await ex.fetchMyTrades(undefined, undefined, 50); // Kucoin lấy 50 lệnh
                                trades = t;
                            } catch(e) {}
                        }

                        // GỘP LỆNH (Tránh partial fills)
                        const aggregated = smartAggregate(trades);

                        history = aggregated.map(t => {
                            const botInfo = enrichInfo(t.symbol);
                            return {
                                timeClose: t.timestamp,
                                timeOpen: botInfo.openTime,
                                symbol: t.symbol,
                                side: t.side,
                                margin: botInfo.margin, // Lấy từ bot
                                leverage: botInfo.lev,  // Lấy từ bot
                                realizedPnl: t.realizedPnl
                            };
                        });

                    } catch(e) { logs.push(`${exName} Hist: ${e.message}`); }

                    // D. SPOT
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

                    return { total: bal.total['USDT'] || 0, positions, history, spot: spotTotal };

                } catch (e) {
                    return { total: 0, positions: [], history: [], spot: 0, error: e.message };
                }
            };

            const [binance, kucoin] = await Promise.all([
                checkExchange('Binance', 'binanceusdm'),
                checkExchange('Kucoin', 'kucoinfutures')
            ]);

            const unifiedHistory = [
                ...binance.history.map(h => ({...h, ex: 'Binance'})),
                ...kucoin.history.map(h => ({...h, ex: 'Kucoin'}))
            ].sort((a,b) => b.timeClose - a.timeClose);

            const responsePayload = {
                username: username,
                binance: binance,
                kucoin: kucoin,
                totalUsdt: (binance.total + kucoin.total),
                totalSpotUsdt: (binance.spot + kucoin.spot),
                totalFutureEquity: (binance.total + kucoin.total),
                livePositions: [...binance.positions.map(p=>({...p, ex:'Binance'})), ...kucoin.positions.map(p=>({...p, ex:'Kucoin'}))],
                exchangeHistory: unifiedHistory,
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

    // Các API khác giữ nguyên...
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
