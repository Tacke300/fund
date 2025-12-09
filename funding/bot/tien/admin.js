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

// Hàm gộp lệnh từ lịch sử dòng tiền (Income)
function aggregateIncome(incomes) {
    // Incomes thường là từng dòng tiền PnL. Ta chỉ cần format lại.
    return incomes.map(i => ({
        timestamp: i.timestamp,
        symbol: i.symbol || i.info.symbol || 'N/A',
        type: i.type || i.info.incomeType || i.info.type, // REALIZED_PNL
        amount: parseFloat(i.amount || i.info.income || 0) // Số tiền PnL
    })).sort((a,b) => b.timestamp - a.timestamp);
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
        // Timeout 10s để tránh treo server
        let options = { 'enableRateLimit': true, 'timeout': 10000, 'options': { 'defaultType': 'future' } };
        
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

            // 1. FILE DATA
            let fileHistory = [];
            try {
                const hFile = path.join(USER_DATA_DIR, `${safeName}_history.json`);
                if(fs.existsSync(hFile)) fileHistory = JSON.parse(fs.readFileSync(hFile, 'utf8'));
            } catch(e){}

            let balanceHistory = [];
            try {
                const bFile = path.join(USER_DATA_DIR, `${safeName}_balance_history.json`);
                if(fs.existsSync(bFile)) {
                    const raw = JSON.parse(fs.readFileSync(bFile, 'utf8'));
                    if(raw.length > 200) balanceHistory = raw.filter((_, i) => i % Math.ceil(raw.length/200) === 0);
                    else balanceHistory = raw;
                }
            } catch(e){}

            // 2. KẾT NỐI SÀN
            const checkExchange = async (exName, exId) => {
                try {
                    const ex = initExchange(exId, config);
                    if (!ex) return { total: 0, positions: [], closed: [], income: [], spot: 0 };

                    // Load markets & Balance
                    await ex.loadMarkets();
                    const bal = await ex.fetchBalance();
                    
                    // A. Live Positions
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
                                margin: p.initialMargin
                            };
                        });
                    } catch(e) { logs.push(`${exName} Pos: ${e.message}`); }

                    // B. Open Orders (TP/SL)
                    let openOrders = [];
                    try {
                        const rawOrd = await ex.fetchOpenOrders();
                        openOrders = rawOrd.map(o => ({ symbol: o.symbol, type: o.type, side: o.side, stopPrice: o.stopPrice || o.price }));
                    } catch(e) {}

                    // C. INCOME / LEDGER (Cách nhanh nhất lấy PnL)
                    let income = [];
                    try {
                        if (exId === 'binanceusdm') {
                            // Lấy 50 dòng PnL gần nhất (Không cần symbol)
                            const rawInc = await ex.fetchIncome(undefined, undefined, 50, { incomeType: 'REALIZED_PNL' });
                            income = rawInc;
                        } else {
                            // Kucoin Ledger
                            const rawLed = await ex.fetchLedger(undefined, undefined, 50);
                            // Lọc ra RealisedPNL
                            income = rawLed.filter(l => l.info.type === 'RealisedPNL'); 
                        }
                    } catch(e) { logs.push(`${exName} Income: ${e.message}`); }

                    // D. CLOSED ORDERS (Lấy trạng thái lệnh)
                    let closed = [];
                    try {
                        // Kucoin hỗ trợ tốt, Binance có thể lỗi nếu không có symbol
                        // Ta chỉ thử gọi chung, nếu lỗi thì bỏ qua
                        if(exId !== 'binanceusdm') {
                            closed = await ex.fetchClosedOrders(undefined, undefined, 20);
                        }
                    } catch(e) {}

                    // E. SPOT
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
                        positions, closed, income, spot: spotTotal 
                    };

                } catch (e) {
                    return { total: 0, positions: [], closed: [], income: [], spot: 0, error: e.message };
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
                
                // Data cho 5 bảng
                fileHistory: fileHistory,
                binanceIncome: aggregateIncome(binance.income), // PnL thực
                kucoinIncome: aggregateIncome(kucoin.income),   // PnL thực
                binanceClosed: binance.closed,
                kucoinClosed: kucoin.closed,

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

    // --- GIỮ NGUYÊN API CHUYỂN TIỀN & VIP GỐC ---
    if (req.method === 'POST' && req.url === '/api/transfer') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            // Giả lập log như code gốc
            const dummyLogs = ['[SYSTEM] Checking wallets...', '[BINANCE] Transfer success', '[KUCOIN] Deposit detected', '[SYSTEM] Done.'];
            res.end(JSON.stringify({ logs: dummyLogs }));
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
                    : users.map(u => `${getSafeFileName(u)}_config.json`);
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
                res.end(JSON.stringify({ success: true, message: `Updated ${count} users` }));
            } catch(e) { res.end(JSON.stringify({ success: false })); }
        });
        return;
    }
});

server.listen(PORT, () => {
    console.log(`Admin Bot running at http://localhost:${PORT}`);
});
