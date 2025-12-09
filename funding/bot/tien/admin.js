const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

function getSafeFileName(username) {
    return username.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// Hàm gộp các lệnh khớp lẻ (Partial Fills) thành 1 lệnh tổng
function aggregateTrades(trades) {
    const groups = {};
    
    trades.forEach(t => {
        const orderId = t.order || t.id; // Dùng OrderID để gom
        if (!groups[orderId]) {
            groups[orderId] = {
                id: orderId,
                timestamp: t.timestamp,
                symbol: t.symbol,
                side: t.side,
                amount: 0,
                cost: 0,
                realizedPnl: 0,
                fee: 0,
                leverage: t.info?.leverage || 'N/A' // Cố lấy leverage nếu sàn trả về
            };
        }
        
        const g = groups[orderId];
        g.amount += parseFloat(t.amount);
        g.cost += parseFloat(t.cost); // cost = price * amount
        
        // Lấy PnL
        let pnl = 0;
        if (t.info) {
            // Binance
            if (t.info.realizedPnl) pnl = parseFloat(t.info.realizedPnl);
            // Kucoin (thường nằm trong info.realisedPnl hoặc funds)
            else if (t.info.realisedPnl) pnl = parseFloat(t.info.realisedPnl);
        }
        g.realizedPnl += pnl;
    });

    // Chuyển về mảng và tính giá trung bình
    return Object.values(groups).map(g => ({
        ...g,
        price: g.cost / g.amount, // Giá khớp trung bình
        // Ước tính Margin = Cost / Leverage (Nếu leverage có số)
        margin: (g.leverage && !isNaN(g.leverage)) ? (g.cost / parseFloat(g.leverage)) : 0
    }));
}

function initExchange(exchangeId, config) {
    try {
        let exchangeClass;
        // Options quan trọng để lấy đúng dữ liệu Future
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
            const username = file.replace('_config.json', '');
            const filePath = path.join(USER_DATA_DIR, file);
            const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const stats = fs.statSync(filePath);
            
            // Tính tổng PnL từ file history bot (để tham khảo)
            let totalPnl = 0;
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

            // --- LẤY BIỂU ĐỒ ---
            let balanceHistory = [];
            try {
                const bPath = path.join(USER_DATA_DIR, `${safeName}_balance_history.json`);
                if (fs.existsSync(bPath)) {
                    const raw = JSON.parse(fs.readFileSync(bPath, 'utf8'));
                    if(raw.length > 200) { 
                        const step = Math.ceil(raw.length / 200);
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
                    
                    // 1. LIVE POSITIONS
                    let positions = [];
                    try {
                        const rawPos = await ex.fetchPositions();
                        // Filter size > 0
                        positions = rawPos.filter(p => parseFloat(p.contracts) > 0).map(p => {
                            // Fix leverage Binance (thường ở info.leverage)
                            let lev = p.leverage;
                            if (!lev || lev === 'undefined') {
                                if(p.info && p.info.leverage) lev = p.info.leverage;
                            }

                            return {
                                symbol: p.symbol,
                                side: p.side,
                                size: parseFloat(p.contracts),
                                entryPrice: parseFloat(p.entryPrice),
                                leverage: lev, 
                                unrealizedPnl: parseFloat(p.unrealizedPnl),
                                // Tính margin nếu sàn không trả về
                                margin: p.initialMargin ? parseFloat(p.initialMargin) : (parseFloat(p.entryPrice)*parseFloat(p.contracts)/parseFloat(lev||1))
                            };
                        });
                    } catch(e) { console.log(`${exName} Pos Error: ${e.message}`); }

                    // 2. TP/SL (Open Orders)
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

                    // Map TP/SL vào Position
                    positions = positions.map(p => {
                        const related = openOrders.filter(o => o.symbol === p.symbol);
                        return { ...p, openOrders: related };
                    });

                    // 3. HISTORY (fetchMyTrades -> Aggregate)
                    let history = [];
                    try {
                        // Cố gắng lấy trade của các cặp đang active hoặc top coin để tối ưu (vì fetchMyTrades without symbol trên Binance Futures rất chậm hoặc lỗi)
                        // Tuy nhiên để đơn giản cho code này, ta thử fetch chung (nếu sàn hỗ trợ) hoặc fetch 1 vài cặp điển hình.
                        // Binance USD-M bắt buộc có symbol. Hack: Lấy history của các cặp đang có vị thế + BTC/USDT + ETH/USDT.
                        
                        let symbolsToCheck = ['BTC/USDT:USDT', 'ETH/USDT:USDT'];
                        // Thêm symbol từ active positions
                        positions.forEach(p => { if(!symbolsToCheck.includes(p.symbol)) symbolsToCheck.push(p.symbol); });

                        let rawTrades = [];
                        
                        // Chạy loop lấy history (giới hạn để ko quá chậm)
                        for (const sym of symbolsToCheck) {
                            try {
                                const t = await ex.fetchMyTrades(sym, undefined, 10); // Lấy 10 trade gần nhất mỗi cặp
                                rawTrades = rawTrades.concat(t);
                            } catch(err) {}
                        }

                        // Gộp lệnh
                        history = aggregateTrades(rawTrades);
                        
                        // Lọc các lệnh có PnL != 0 (Lệnh đóng vị thế)
                        // Hoặc hiển thị hết nhưng user yêu cầu xem PnL.
                        // Ta sẽ hiển thị tất cả, nhưng lệnh mở sẽ có PnL = 0.
                        
                    } catch(e) { console.log(`${exName} Hist Error: ${e.message}`); }

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
                    return { total: 0, positions: [], history: [], spot: 0, error: e.message };
                }
            };

            const [binance, kucoin] = await Promise.all([
                checkExchange('Binance', 'binanceusdm'),
                checkExchange('Kucoin', 'kucoinfutures')
            ]);

            // GỘP LỊCH SỬ CHUNG
            const unifiedHistory = [
                ...binance.history.map(h => ({ ...h, ex: 'Binance' })),
                ...kucoin.history.map(h => ({ ...h, ex: 'Kucoin' }))
            ].sort((a,b) => b.timestamp - a.timestamp); // Mới nhất lên đầu

            const responsePayload = {
                username: username,
                binance: binance,
                kucoin: kucoin,
                totalUsdt: (binance.total + kucoin.total),
                totalSpotUsdt: (binance.spot + kucoin.spot),
                totalFutureEquity: (binance.total + kucoin.total),
                
                // Dữ liệu cho bảng
                livePositions: [...binance.positions.map(p=>({...p, ex:'Binance'})), ...kucoin.positions.map(p=>({...p, ex:'Kucoin'}))],
                exchangeHistory: unifiedHistory,
                balanceHistory: balanceHistory
            };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responsePayload));

        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    // Các API khác giữ nguyên
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
    if (req.method === 'POST' && req.url === '/api/transfer') {
        res.end(JSON.stringify({ logs: ['Ack'] }));
        return;
    }
});

server.listen(PORT, () => {
    console.log(`Admin Bot running at http://localhost:${PORT}`);
});
