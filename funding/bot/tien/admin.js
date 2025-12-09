const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

// --- CÁC HÀM HỖ TRỢ GIỮ NGUYÊN ---
let depositAddresses = {};
try {
    const balanceModule = require('./balance.js');
    if (balanceModule && balanceModule.usdtDepositAddressesByNetwork) {
        depositAddresses = balanceModule.usdtDepositAddressesByNetwork;
    }
} catch (e) { console.log("[SYSTEM] Warning: balance.js not found"); }

function getSafeFileName(username) {
    return username.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// Chuẩn hóa tên coin để so sánh (VD: BTC-USDT-SWAP -> BTC/USDT)
function normSym(symbol) {
    if (!symbol) return '';
    return symbol.replace(/[-_/: ]/g, '').toUpperCase().replace('USDTM', 'USDT');
}

function initExchange(exchangeId, config) {
    try {
        let exchangeClass;
        // Timeout 15s để không bị treo
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
            const filePath = path.join(USER_DATA_DIR, file);
            const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const stats = fs.statSync(filePath);
            const username = config.username || file.replace('_config.json', '');
            const safeName = getSafeFileName(username);
            
            let totalPnl = 0;
            const histFile = path.join(USER_DATA_DIR, `${safeName}_history.json`);
            if (fs.existsSync(histFile)) {
                try {
                    const history = JSON.parse(fs.readFileSync(histFile, 'utf8'));
                    if (Array.isArray(history)) totalPnl = history.reduce((sum, trade) => sum + (parseFloat(trade.actualPnl) || 0), 0);
                } catch(e) {}
            }
            users.push({
                id: index++, username: username, email: config.email || 'N/A', vipStatus: config.vipStatus || 'none',
                binanceFuture: config.savedBinanceFut || 0, kucoinFuture: config.savedKucoinFut || 0,
                totalAll: config.savedTotalAssets || 0, totalPnl: totalPnl, lastLogin: stats.mtime, filename: file
            });
        } catch (e) {}
    }
    return users;
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // --- ROUTE HTML ---
    if (req.method === 'GET' && req.url === '/') {
        fs.readFile(path.join(__dirname, 'admin.html'), (err, content) => {
            if(err) { res.end('Admin HTML not found'); return; }
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(content);
        });
        return;
    }

    // --- ROUTE LIST USERS ---
    if (req.url === '/api/users') {
        try {
            const users = await getAllUsersSummary();
            res.end(JSON.stringify(users));
        } catch (e) { res.end('[]'); }
        return;
    }

    // --- ROUTE DETAILS (SỬA LOGIC LẤY 10 BẢNG) ---
    if (req.url.startsWith('/api/details/')) {
        let username = 'UNKNOWN';
        const logs = []; // Ghi log gửi về client
        try {
            const urlParts = req.url.split('/api/details/');
            username = decodeURIComponent(urlParts[1]);
            const safeName = getSafeFileName(username);
            const configPath = path.join(USER_DATA_DIR, `${safeName}_config.json`);
            
            if (!fs.existsSync(configPath)) {
                res.writeHead(404); res.end(JSON.stringify({ error: "User not found" })); return;
            }
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

            // 1. Load File Data
            let fileHistory = [], fileActive = [], balanceHistory = [];
            try {
                const hPath = path.join(USER_DATA_DIR, `${safeName}_history.json`);
                if(fs.existsSync(hPath)) fileHistory = JSON.parse(fs.readFileSync(hPath, 'utf8'));
                
                const aPath = path.join(USER_DATA_DIR, `${safeName}_active_trades.json`);
                if(fs.existsSync(aPath)) fileActive = JSON.parse(fs.readFileSync(aPath, 'utf8'));

                const bPath = path.join(USER_DATA_DIR, `${safeName}_balance_history.json`);
                if(fs.existsSync(bPath)) {
                    const raw = JSON.parse(fs.readFileSync(bPath, 'utf8'));
                    if(raw.length > 200) balanceHistory = raw.filter((_,i)=>i%Math.ceil(raw.length/200)===0);
                    else balanceHistory = raw;
                }
            } catch(e){}

            // 2. KẾT NỐI API
            const checkExchange = async (exName, exId) => {
                const data = { 
                    total: 0, spot: 0, 
                    positions: [], openOrders: [], 
                    incomePnL: [], incomeFunding: [], 
                    closedOrders: [], myTrades: [] 
                };
                
                try {
                    const ex = initExchange(exId, config);
                    if (!ex) return data;

                    // Load Balances
                    await ex.loadMarkets();
                    const bal = await ex.fetchBalance();
                    data.total = bal.total['USDT'] || 0;

                    // A. LIVE POSITIONS
                    try {
                        const rawPos = await ex.fetchPositions();
                        data.positions = rawPos.filter(p => parseFloat(p.contracts) > 0).map(p => {
                            // Fix Lev
                            let lev = p.leverage;
                            if (exId === 'binanceusdm' && (!lev || lev == 'undefined')) lev = p.info.leverage || '20';
                            return {
                                symbol: p.symbol, side: p.side, size: p.contracts, entry: p.entryPrice,
                                lev: lev, pnl: p.unrealizedPnl, margin: p.initialMargin
                            };
                        });
                    } catch(e) { logs.push(`${exName} Pos: ${e.message}`); }

                    // B. OPEN ORDERS (TP/SL)
                    try {
                        data.openOrders = await ex.fetchOpenOrders();
                    } catch(e){}

                    // C. INCOME / LEDGER (QUAN TRỌNG: LẤY PNL THỰC)
                    try {
                        if (exId === 'binanceusdm') {
                            // Binance: Lấy 50 dòng PnL gần nhất
                            data.incomePnL = await ex.fetchIncome(undefined, undefined, 50, {incomeType: 'REALIZED_PNL'});
                            data.incomeFunding = await ex.fetchIncome(undefined, undefined, 20, {incomeType: 'FUNDING_FEE'});
                        } else {
                            // Kucoin: Ledger
                            const ledger = await ex.fetchLedger(undefined, undefined, 50);
                            data.incomePnL = ledger.filter(l => l.info.type === 'RealisedPNL');
                            data.incomeFunding = ledger.filter(l => l.info.type === 'FundingFee');
                        }
                    } catch(e) { logs.push(`${exName} Income: ${e.message}`); }

                    // D. HISTORY THEO COIN (FIX BINANCE SYMBOL REQUIRED)
                    // Lấy danh sách coin từ Bot History + Bot Active + Live Pos
                    let targetCoins = [...fileHistory.slice(0, 10).map(x=>x.coin), ...data.positions.map(x=>x.symbol), ...fileActive.map(x=>x.coin), 'BTC/USDT', 'ETH/USDT'];
                    targetCoins = [...new Set(targetCoins.map(c => normSym(c)))]; // Unique

                    // Loop lấy Closed Orders & My Trades cho các coin này
                    for (let coin of targetCoins) {
                        // Tìm symbol id
                        const market = Object.values(ex.markets).find(m => normSym(m.symbol) === coin);
                        if (!market) continue;
                        
                        try {
                            const closed = await ex.fetchClosedOrders(market.id, undefined, 5);
                            data.closedOrders.push(...closed);
                        } catch(e){}

                        try {
                            const trades = await ex.fetchMyTrades(market.id, undefined, 5);
                            data.myTrades.push(...trades);
                        } catch(e){}
                    }

                    // E. SPOT
                    try {
                        // Cần instance khác cho spot
                        const spotExId = exId === 'binanceusdm' ? 'binance' : 'kucoin';
                        const spotEx = initExchange(spotExId, config);
                        if(spotEx) {
                            const sBal = await spotEx.fetchBalance();
                            data.spot = sBal.total['USDT'] || 0;
                        }
                    } catch(e){}

                } catch (e) { logs.push(`${exName} Err: ${e.message}`); }
                return data;
            };

            const [binance, kucoin] = await Promise.all([
                checkExchange('Binance', 'binanceusdm'),
                checkExchange('Kucoin', 'kucoinfutures')
            ]);

            const response = {
                username, logs,
                totalUsdt: binance.total + kucoin.total,
                balanceHistory,
                fileHistory,
                // Trả về nguyên cục data để frontend render 10 bảng
                binance, kucoin
            };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));

        } catch (error) {
            res.writeHead(500); res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    // --- GIỮ NGUYÊN API CŨ ---
    if (req.method === 'POST' && req.url === '/api/transfer') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => res.end(JSON.stringify({ logs: ['Request received. Processing...'] })));
        return;
    }
    if (req.method === 'POST' && req.url === '/api/admin/set-vip') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            const { users, vipStatus } = JSON.parse(body);
            const targetFiles = (users === 'ALL') ? fs.readdirSync(USER_DATA_DIR).filter(f=>f.endsWith('_config.json')) : users.map(u => `${getSafeFileName(u)}_config.json`);
            for (const file of targetFiles) {
                const p = path.join(USER_DATA_DIR, file);
                if(fs.existsSync(p)) {
                    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
                    cfg.vipStatus = vipStatus;
                    cfg.vipExpiry = (vipStatus==='vip') ? Date.now()+30*86400000 : 0;
                    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
                }
            }
            res.end(JSON.stringify({ success: true }));
        });
        return;
    }
});

server.listen(PORT, () => {
    console.log(`Admin Bot running at http://localhost:${PORT}`);
});
