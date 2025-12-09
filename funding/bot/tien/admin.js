const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

function getSafeFileName(username) {
    return username.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// Hàm chuẩn hóa Symbol để so sánh (VD: BTC-USDT-SWAP -> BTCUSDT)
function normSym(symbol) {
    if (!symbol) return '';
    return symbol.replace(/[-_/: ]/g, '').toUpperCase().replace('USDTM', 'USDT');
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

            // 1. ĐỌC DỮ LIỆU BOT (Để làm từ điển tra cứu Margin/Lev)
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

            // Hàm tìm thông tin bổ sung từ Bot (Lev, Margin, OpenTime)
            const enrichData = (coin, exchangeId) => {
                // Tìm trong active trades trước
                let match = botActive.find(b => normSym(b.coin) === normSym(coin));
                if(match) return { lev: match.leverage, margin: match.collateral, openTime: match.entryTime };
                
                // Tìm trong history (lấy cái gần nhất)
                match = botHistory.find(b => normSym(b.coin) === normSym(coin));
                if(match) return { lev: match.leverage, margin: match.collateral, openTime: match.entryTime };

                return { lev: 20, margin: 2.5, openTime: null }; // Default fallback
            };

            // Đọc biểu đồ
            let balanceHistory = [];
            try {
                const bPath = path.join(USER_DATA_DIR, `${safeName}_balance_history.json`);
                if(fs.existsSync(bPath)) {
                    const raw = JSON.parse(fs.readFileSync(bPath, 'utf8'));
                    if(raw.length > 200) balanceHistory = raw.filter((_,i) => i%Math.ceil(raw.length/200)===0);
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
                            // Lấy Leverage từ Bot File nếu sàn trả về undefined
                            const botInfo = enrichData(p.symbol, exId);
                            let lev = p.leverage;
                            if (!lev || lev == 'undefined') lev = (p.info && p.info.leverage) ? p.info.leverage : botInfo.lev;

                            return {
                                symbol: p.symbol,
                                side: p.side,
                                size: parseFloat(p.contracts),
                                entryPrice: parseFloat(p.entryPrice),
                                leverage: lev,
                                unrealizedPnl: parseFloat(p.unrealizedPnl),
                                // Ưu tiên hiển thị Margin của Bot (2.5$) cho chính xác ý đồ
                                margin: botInfo.margin || (parseFloat(p.initialMargin)) 
                            };
                        });
                    } catch(e) { logs.push(`${exName} Pos: ${e.message}`); }

                    // B. OPEN ORDERS (TP/SL)
                    let openOrders = [];
                    try {
                        const rawOrd = await ex.fetchOpenOrders();
                        openOrders = rawOrd.map(o => ({ symbol: o.symbol, type: o.type, side: o.side, stopPrice: o.stopPrice || o.price }));
                    } catch(e) {}

                    // C. HISTORY (REALIZED PNL)
                    let history = [];
                    try {
                        let trades = [];
                        if (exId === 'binanceusdm') {
                            // Binance: Hack lấy trade của các cặp trong botHistory để tránh lỗi symbol
                            // Lấy 10 coin gần nhất bot đã trade
                            let coinsToCheck = botHistory.slice(0, 10).map(b => b.coin);
                            // Thêm positions đang chạy
                            positions.forEach(p => coinsToCheck.push(p.symbol));
                            // Thêm BTC/ETH
                            coinsToCheck.push('BTC/USDT', 'ETH/USDT');
                            coinsToCheck = [...new Set(coinsToCheck)]; // Unique

                            for (let coin of coinsToCheck) {
                                // Tìm market id
                                const market = Object.values(ex.markets).find(m => normSym(m.symbol) === normSym(coin));
                                if(market) {
                                    try {
                                        const t = await ex.fetchMyTrades(market.id, undefined, 5);
                                        trades.push(...t);
                                    } catch(err) {}
                                }
                            }
                        } else {
                            // Kucoin: Dùng fetchClosedOrders (Lệnh đã đóng) sẽ chuẩn hơn cho việc xem PnL đã chốt
                            // Tuy nhiên Kucoin API ClosedOrders trả về mảng lệnh, PnL nằm trong đó (nếu có)
                            try {
                                const orders = await ex.fetchClosedOrders(undefined, undefined, 30);
                                // Map sang format chung
                                trades = orders.map(o => ({
                                    timestamp: o.timestamp,
                                    symbol: o.symbol,
                                    side: o.side,
                                    price: o.price || o.average,
                                    amount: o.amount,
                                    info: o.info, // Kucoin info thường chứa PnL
                                    id: o.id
                                }));
                            } catch(err) { logs.push(`Kucoin Closed Err: ${err.message}`); }
                        }

                        // XỬ LÝ & LỌC LỊCH SỬ
                        history = trades.map(t => {
                            let pnl = 0;
                            // Binance Logic
                            if (exId === 'binanceusdm' && t.info && t.info.realizedPnl) pnl = parseFloat(t.info.realizedPnl);
                            // Kucoin Logic (Thường không trả PnL trực tiếp trong closedOrders list, phải fetch riêng hoặc ước tính)
                            // Tạm thời nếu không có PnL thì để 0.
                            
                            // LẤY INFO TỪ BOT
                            const botInfo = enrichData(t.symbol, exId);

                            return {
                                timeClose: t.timestamp,
                                timeOpen: botInfo.openTime, // Lấy từ bot
                                symbol: t.symbol,
                                side: t.side,
                                margin: botInfo.margin,     // Lấy từ bot (2.5$)
                                leverage: botInfo.lev,      // Lấy từ bot
                                realizedPnl: pnl
                            };
                        });

                        // LỌC: Chỉ lấy lệnh CÓ PNL khác 0 (Binance) hoặc lệnh Đóng
                        // Với Binance: realizedPnl != 0 là lệnh đóng/chốt lời lỗ.
                        if (exId === 'binanceusdm') {
                            history = history.filter(h => Math.abs(h.realizedPnl) > 0.0001);
                        }

                    } catch(e) { logs.push(`${exName} Hist: ${e.message}`); }

                    // Spot Balance
                    let spotTotal = 0;
                    try {
                        const spotExId = exId === 'binanceusdm' ? 'binance' : 'kucoin';
                        const spotEx = initExchange(spotExId, config);
                        if(spotEx) {
                            const sBal = await spotEx.fetchBalance();
                            spotTotal = sBal.total['USDT'] || 0;
                        }
                    } catch(e) {}

                    // Map TP/SL vào Positions
                    positions = positions.map(p => {
                        const cleanSym = normSym(p.symbol);
                        const related = openOrders.filter(o => normSym(o.symbol) === cleanSym);
                        return { ...p, openOrders: related };
                    });

                    return { 
                        total: bal.total['USDT'] || 0, 
                        positions, history, spot: spotTotal 
                    };
                } catch (e) {
                    return { total: 0, positions: [], history: [], spot: 0, error: e.message };
                }
            };

            const [binance, kucoin] = await Promise.all([
                checkExchange('Binance', 'binanceusdm'),
                checkExchange('Kucoin', 'kucoinfutures')
            ]);

            // Gộp lịch sử và sắp xếp
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
