const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

// Hàm chuẩn hóa tên file
function getSafeFileName(username) {
    return username.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// Hàm chuẩn hóa Symbol (để so sánh BTC-USDT-SWAP với BTC/USDT)
function normSym(symbol) {
    if (!symbol) return '';
    return symbol.replace(/[-_/: ]/g, '').toUpperCase().replace('USDTM', 'USDT');
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
            'timeout': 20000,
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
            const filePath = path.join(USER_DATA_DIR, file);
            const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const stats = fs.statSync(filePath);
            
            // Lấy tổng PnL từ file bot để hiện ngoài dashboard
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

            users.push({
                id: index++,
                username: username,
                email: config.email || 'N/A',
                vipStatus: config.vipStatus || 'none',
                binanceFuture: config.savedBinanceFut || 0,
                kucoinFuture: config.savedKucoinFut || 0,
                totalAll: config.savedTotalAssets || 0,
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
    
    if (req.method === 'GET' && req.url === '/') {
        fs.readFile(path.join(__dirname, 'admin.html'), (err, content) => {
            if(err) { res.end('Admin HTML not found'); return; }
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

    // --- XỬ LÝ CHI TIẾT (Logic mới update) ---
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

            // 1. ĐỌC DATA BOT (Để làm tham chiếu Margin/Lev/OpenTime)
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

            // Hàm tìm info từ Bot
            const enrichInfo = (symbol) => {
                const clean = normSym(symbol);
                // Tìm trong active trước
                let match = botActive.find(b => normSym(b.coin) === clean);
                if (match) return { margin: match.collateral, lev: match.leverage, openTime: match.entryTime };
                // Tìm trong history
                match = botHistory.find(b => normSym(b.coin) === clean);
                if (match) return { margin: match.collateral, lev: match.leverage, openTime: match.entryTime };
                return { margin: null, lev: null, openTime: null };
            };

            // Đọc biểu đồ
            let balanceHistory = [];
            try {
                const bFile = path.join(USER_DATA_DIR, `${safeName}_balance_history.json`);
                if(fs.existsSync(bFile)) {
                    const raw = JSON.parse(fs.readFileSync(bFile, 'utf8'));
                    // Downsample
                    if(raw.length > 200) balanceHistory = raw.filter((_, i) => i % Math.ceil(raw.length/200) === 0);
                    else balanceHistory = raw;
                }
            } catch(e){}

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
                            // Lấy thông tin từ Bot
                            const botInfo = enrichInfo(p.symbol);
                            
                            // Fix Lev Binance
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
                                // Ưu tiên hiển thị Margin của Bot (2.5$)
                                margin: botInfo.margin || p.initialMargin || ((parseFloat(p.entryPrice)*parseFloat(p.contracts))/(lev||1))
                            };
                        });
                    } catch(e) { logs.push(`${exName} Pos: ${e.message}`); }

                    // B. OPEN ORDERS (TP/SL)
                    let openOrders = [];
                    try {
                        const rawOrd = await ex.fetchOpenOrders();
                        openOrders = rawOrd.map(o => ({ symbol: o.symbol, type: o.type, side: o.side, stopPrice: o.stopPrice || o.price }));
                    } catch(e) {}

                    // C. HISTORY (LẤY TỪ SÀN + MERGE TIME/MARGIN TỪ BOT)
                    let history = [];
                    try {
                        let trades = [];
                        
                        if (exId === 'binanceusdm') {
                            // Binance: Chỉ lấy lịch sử các coin ĐÃ/ĐANG TRADE (để tránh lỗi require symbol)
                            // Gom symbol từ Bot History + Bot Active + Top coins
                            let coinsToCheck = [...botHistory.map(b=>b.coin), ...botActive.map(b=>b.coin), 'BTC/USDT', 'ETH/USDT'];
                            // Map sang ID market của sàn
                            let symbolsIds = [];
                            coinsToCheck.forEach(c => {
                                // Tìm market id tương ứng trong ccxt markets
                                const m = Object.values(ex.markets).find(m => normSym(m.symbol) === normSym(c));
                                if(m) symbolsIds.push(m.id);
                            });
                            symbolsIds = [...new Set(symbolsIds)]; // Unique

                            // Gọi API song song (giới hạn 10 cặp gần nhất để nhanh)
                            const promises = symbolsIds.slice(0, 10).map(sym => ex.fetchMyTrades(sym, undefined, 5).catch(e=>[]));
                            const results = await Promise.all(promises);
                            trades = results.flat();

                        } else {
                            // Kucoin: Fetch chung được
                            try {
                                const t = await ex.fetchMyTrades(undefined, undefined, 30);
                                trades = t;
                            } catch(e) {}
                        }

                        // Xử lý Trades -> History Item
                        history = trades.map(t => {
                            let pnl = 0;
                            // Binance
                            if (t.info && t.info.realizedPnl) pnl = parseFloat(t.info.realizedPnl);
                            // Kucoin (thường không có pnl trong myTrades, tạm để 0 hoặc lọc)
                            
                            const botInfo = enrichInfo(t.symbol);

                            return {
                                timeClose: t.timestamp,
                                timeOpen: botInfo.openTime, // Lấy từ bot
                                symbol: t.symbol,
                                side: t.side,
                                price: t.price,
                                margin: botInfo.margin,     // Lấy từ bot (2.5$)
                                leverage: botInfo.lev,      // Lấy từ bot
                                realizedPnl: pnl
                            };
                        });

                        // Lọc: Với Binance chỉ lấy lệnh có PnL != 0 (Lệnh đóng)
                        if (exId === 'binanceusdm') {
                            history = history.filter(h => Math.abs(h.realizedPnl) > 0.0001);
                        }

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
                        const related = openOrders.filter(o => normSym(o.symbol) === clean);
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

            // Gộp và sort history
            const unifiedHistory = [
                ...binance.history.map(h => ({...h, ex:'Binance'})),
                ...kucoin.history.map(h => ({...h, ex:'Kucoin'}))
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

    if (req.method === 'POST' && req.url === '/api/transfer') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
             // Logic chuyển tiền giữ nguyên (Demo log)
             console.log("[TRANSFER] Request:", body);
             res.end(JSON.stringify({ logs: ['Request received', 'Processing...'] }));
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
