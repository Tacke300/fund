const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

// Hàm hỗ trợ tên file
function getSafeFileName(username) {
    return username.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// Hàm gộp các trade lẻ thành 1 dòng lịch sử gọn gàng
function aggregateTrades(trades) {
    const groups = {};
    trades.forEach(t => {
        // Gom theo Order ID. Nếu không có orderId thì dùng timestamp làm key tạm
        const key = t.order || t.id;
        if (!groups[key]) {
            groups[key] = {
                timestamp: t.timestamp,
                symbol: t.symbol,
                side: t.side,
                amount: 0,
                cost: 0, // Giá trị = price * amount
                realizedPnl: 0,
                fee: 0
            };
        }
        const g = groups[key];
        g.amount += parseFloat(t.amount);
        g.cost += (parseFloat(t.price) * parseFloat(t.amount));
        if (t.fee && t.fee.cost) g.fee += parseFloat(t.fee.cost);

        // Lấy PnL (Chỉ Binance có sẵn trong info)
        let pnl = 0;
        if (t.info && t.info.realizedPnl) pnl = parseFloat(t.info.realizedPnl);
        g.realizedPnl += pnl;
    });

    // Chuyển object thành array và tính giá trung bình
    return Object.values(groups).map(g => ({
        timestamp: g.timestamp,
        symbol: g.symbol,
        side: g.side,
        amount: g.amount,
        price: g.amount > 0 ? (g.cost / g.amount) : 0, // Giá TB
        realizedPnl: g.realizedPnl,
        fee: g.fee
    })).sort((a, b) => b.timestamp - a.timestamp); // Mới nhất lên đầu
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
            
            // Lấy tạm PnL từ file history bot nếu có (chỉ để hiện ngoài danh sách)
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

    // --- XỬ LÝ CHI TIẾT ---
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

            // Đọc file biểu đồ
            let balanceHistory = [];
            try {
                const bPath = path.join(USER_DATA_DIR, `${safeName}_balance_history.json`);
                if (fs.existsSync(bPath)) {
                    const raw = JSON.parse(fs.readFileSync(bPath, 'utf8'));
                    if(raw.length > 250) { 
                        const step = Math.ceil(raw.length / 250);
                        balanceHistory = raw.filter((_, i) => i % step === 0);
                    } else balanceHistory = raw;
                }
            } catch(e){}

            // Hàm kết nối sàn lấy dữ liệu
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
                        // Lọc những lệnh size > 0
                        positions = rawPos.filter(p => parseFloat(p.contracts) > 0).map(p => {
                            // Fix đòn bẩy Binance (thường nằm sâu trong info)
                            let lev = p.leverage;
                            if (exId === 'binanceusdm' && (!lev || lev == 'undefined')) {
                                lev = p.info.leverage;
                            }
                            
                            return {
                                symbol: p.symbol,
                                side: p.side,
                                size: parseFloat(p.contracts),
                                entryPrice: parseFloat(p.entryPrice),
                                leverage: lev,
                                unrealizedPnl: parseFloat(p.unrealizedPnl),
                                // Margin ước tính nếu sàn không trả về
                                margin: p.initialMargin ? parseFloat(p.initialMargin) : ((parseFloat(p.entryPrice) * parseFloat(p.contracts)) / parseFloat(lev || 1))
                            };
                        });
                    } catch(e) { console.log(`${exName} Pos Err: ${e.message}`); }

                    // 2. OPEN ORDERS (TP/SL)
                    let openOrders = [];
                    try {
                        const rawOrd = await ex.fetchOpenOrders();
                        openOrders = rawOrd.map(o => ({
                            symbol: o.symbol,
                            type: o.type,
                            side: o.side,
                            stopPrice: o.stopPrice || o.price // Binance dùng stopPrice, Kucoin có thể dùng price
                        }));
                    } catch(e) {}

                    // Map TP/SL vào Position (Sử dụng include để match symbol Kucoin)
                    positions = positions.map(p => {
                        // Kucoin: BTC/USDT:USDT vs BTC-USDT-SWAP -> Cần chuẩn hóa
                        // Cách đơn giản: remove hết ký tự đặc biệt rồi so sánh
                        const cleanSym = p.symbol.replace(/[-_/: ]/g, '');
                        const related = openOrders.filter(o => o.symbol.replace(/[-_/: ]/g, '') === cleanSym);
                        return { ...p, openOrders: related };
                    });

                    // 3. HISTORY (fetchMyTrades -> Aggregate)
                    let history = [];
                    try {
                        // Lấy 50 trade gần nhất
                        const trades = await ex.fetchMyTrades(undefined, undefined, 50);
                        
                        // Lọc:
                        // - Binance: Chỉ lấy lệnh có PnL != 0 (là lệnh đóng vị thế)
                        // - Kucoin: Lấy hết (vì Kucoin k trả PnL ở đây, ta hiển thị giá khớp)
                        
                        let filteredTrades = trades;
                        if (exId === 'binanceusdm') {
                            filteredTrades = trades.filter(t => t.info && parseFloat(t.info.realizedPnl) !== 0);
                        }

                        history = aggregateTrades(filteredTrades);
                    } catch(e) { console.log(`${exName} Hist Err: ${e.message}`); }

                    // 4. SPOT
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

            // Gộp lịch sử 2 sàn
            const mergedHistory = [
                ...binance.history.map(h => ({...h, ex: 'Binance'})),
                ...kucoin.history.map(h => ({...h, ex: 'Kucoin'}))
            ].sort((a,b) => b.timestamp - a.timestamp);

            const responsePayload = {
                username: username,
                binance: binance,
                kucoin: kucoin,
                totalUsdt: (binance.total + kucoin.total),
                totalSpotUsdt: (binance.spot + kucoin.spot),
                totalFutureEquity: (binance.total + kucoin.total),
                
                // Dữ liệu hiển thị
                livePositions: [...binance.positions.map(p=>({...p, ex:'Binance'})), ...kucoin.positions.map(p=>({...p, ex:'Kucoin'}))],
                exchangeHistory: mergedHistory,
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

    // API cũ
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
