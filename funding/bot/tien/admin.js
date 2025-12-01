const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

// --- 1. CONFIG & EXCHANGE ---
function initExchange(exchangeId, config) {
    try {
        let exchangeClass;
        // Timeout 20s để kịp lấy vị thế nhiều coin
        let options = { 'enableRateLimit': true, 'timeout': 20000 };
        
        if (exchangeId === 'binance') {
            exchangeClass = ccxt.binance;
            options.apiKey = config.binanceApiKey;
            options.secret = config.binanceApiSecret;
        } else if (exchangeId === 'binanceusdm') {
            exchangeClass = ccxt.binanceusdm;
            options.apiKey = config.binanceApiKey;
            options.secret = config.binanceApiSecret;
        } else if (exchangeId === 'kucoin') {
            exchangeClass = ccxt.kucoin;
            options.apiKey = config.kucoinApiKey;
            options.secret = config.kucoinApiSecret;
            options.password = config.kucoinPassword || config.kucoinApiPassword;
        } else if (exchangeId === 'kucoinfutures') {
            exchangeClass = ccxt.kucoinfutures;
            options.apiKey = config.kucoinApiKey;
            options.secret = config.kucoinApiSecret;
            options.password = config.kucoinPassword || config.kucoinApiPassword;
        }

        if (!options.apiKey || !options.secret) return null;
        return new exchangeClass(options);
    } catch (e) {
        return null;
    }
}

// --- 2. HÀM LẤY CHI TIẾT (QUAN TRỌNG) ---
async function getRealtimeDetails(config) {
    const details = {
        binance: { spot: [], future: { wallet: 0, pnl: 0, equity: 0 }, positions: [], connected: false },
        kucoin: { spot: [], future: { wallet: 0, pnl: 0, equity: 0 }, positions: [], connected: false },
        totalSpotUsdt: 0,
        totalFutureEquity: 0,
        logs: []
    };

    // Helper: Lấy Binance
    const fetchBinance = async () => {
        try {
            // A. SPOT
            const spotEx = initExchange('binance', config);
            if (spotEx) {
                const [bal, tickers] = await Promise.all([
                    spotEx.fetchBalance(),
                    spotEx.fetchTickers()
                ]);
                
                for (const coin in bal.total) {
                    const amount = bal.total[coin];
                    if (amount > 0) {
                        let price = (coin === 'USDT') ? 1 : (tickers[`${coin}/USDT`]?.last || 0);
                        const val = amount * price;
                        if (val >= 1) { // Chỉ lấy >= 1$
                            details.binance.spot.push({ coin, amount, value: val });
                            details.totalSpotUsdt += val;
                        }
                    }
                }
            }

            // B. FUTURE & POSITIONS
            const futEx = initExchange('binanceusdm', config);
            if (futEx) {
                const [bal, positions] = await Promise.all([
                    futEx.fetchBalance(),
                    futEx.fetchPositions()
                ]);

                // 1. Số dư ví (Wallet Balance)
                const wallet = bal.total['USDT'] || 0;
                
                // 2. Vị thế & PnL
                let totalUnrealizedPnl = 0;
                const activePos = positions.filter(p => parseFloat(p.contracts) > 0);
                
                activePos.forEach(p => {
                    const pnl = parseFloat(p.unrealizedPnl || 0);
                    totalUnrealizedPnl += pnl;
                    details.binance.positions.push({
                        symbol: p.symbol,
                        side: p.side, // long/short
                        leverage: p.leverage,
                        entry: p.entryPrice,
                        mark: p.markPrice,
                        size: parseFloat(p.contracts),
                        pnl: pnl,
                        roi: p.percentage // % Lãi lỗ
                    });
                });

                // 3. Equity (Tổng tài sản ròng = Ví + PnL chưa chốt)
                // Binance trả về totalMarginBalance là chuẩn nhất
                const equity = parseFloat(bal.info?.totalMarginBalance || (wallet + totalUnrealizedPnl));

                details.binance.future = { wallet, pnl: totalUnrealizedPnl, equity };
                details.binance.connected = true;
                details.totalFutureEquity += equity;
            }
        } catch (e) {
            details.logs.push(`Binance Err: ${e.message}`);
        }
    };

    // Helper: Lấy Kucoin
    const fetchKucoin = async () => {
        try {
            // A. SPOT
            const spotEx = initExchange('kucoin', config);
            if (spotEx) {
                const bal = await spotEx.fetchBalance();
                // Kucoin fetchTickers rất nặng, tạm thời chỉ tính USDT. 
                // Nếu muốn full coin phải chấp nhận chậm thêm 5s.
                if (bal.total['USDT'] >= 1) {
                    details.kucoin.spot.push({ coin: 'USDT', amount: bal.total['USDT'], value: bal.total['USDT'] });
                    details.totalSpotUsdt += bal.total['USDT'];
                }
            }

            // B. FUTURE
            const futEx = initExchange('kucoinfutures', config);
            if (futEx) {
                const [bal, positions] = await Promise.all([
                    futEx.fetchBalance(),
                    futEx.fetchPositions()
                ]);

                const wallet = bal.total['USDT'] || 0;
                let totalUnrealizedPnl = 0;

                const activePos = positions.filter(p => parseFloat(p.contracts) > 0);
                activePos.forEach(p => {
                    const pnl = parseFloat(p.unrealizedPnl || 0);
                    totalUnrealizedPnl += pnl;
                    details.kucoin.positions.push({
                        symbol: p.symbol,
                        side: p.side,
                        leverage: p.leverage,
                        entry: p.entryPrice,
                        size: parseFloat(p.contracts),
                        pnl: pnl,
                        roi: null // Kucoin API basic đôi khi ko trả về % ROI trực tiếp
                    });
                });

                const equity = wallet + totalUnrealizedPnl;
                details.kucoin.future = { wallet, pnl: totalUnrealizedPnl, equity };
                details.kucoin.connected = true;
                details.totalFutureEquity += equity;
            }
        } catch (e) {
            details.logs.push(`Kucoin Err: ${e.message}`);
        }
    };

    // Chạy song song, chờ tối đa
    await Promise.all([fetchBinance(), fetchKucoin()]);
    return details;
}

// --- 3. BACKGROUND UPDATE (Để list load nhanh) ---
async function updateBackgroundUser(filename) {
    const filePath = path.join(USER_DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return;
    try {
        const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        
        // Chỉ check nhanh Future Balance để hiện list
        const check = async (id) => {
            const ex = initExchange(id, config);
            if (!ex) return 0;
            try { const b = await ex.fetchBalance(); return b.total['USDT'] || 0; } catch { return 0; }
        };

        const [bin, ku] = await Promise.all([check('binanceusdm'), check('kucoinfutures')]);
        
        config.savedBinanceFut = bin;
        config.savedKucoinFut = ku;
        config.savedTotalAssets = bin + ku;
        config.lastBalanceUpdate = Date.now();

        fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
    } catch (e) {}
}

async function autoUpdateAllUsers() {
    if (!fs.existsSync(USER_DATA_DIR)) return;
    const files = fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json'));
    // Chia nhỏ batch để ko bị ban IP
    const chunk = 3; 
    for (let i = 0; i < files.length; i += chunk) {
        await Promise.all(files.slice(i, i + chunk).map(f => updateBackgroundUser(f)));
    }
}

// --- 4. SERVER HANDLER ---
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    // -- GET ADMIN HTML --
    if (req.method === 'GET' && req.url === '/') {
        fs.readFile(path.join(__dirname, 'admin.html'), (err, content) => {
            if(err) { res.end('Missing admin.html'); return; }
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(content);
        });
        return;
    }

    // -- API LIST USERS (FAST - FROM FILE) --
    if (req.url === '/api/users') {
        const users = [];
        if (fs.existsSync(USER_DATA_DIR)) {
            const files = fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json'));
            let idx = 1;
            for (const file of files) {
                try {
                    const cfg = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, file), 'utf8'));
                    const stat = fs.statSync(path.join(USER_DATA_DIR, file));
                    
                    let pnl = 0;
                    try {
                        const h = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, file.replace('config','history')),'utf8'));
                        pnl = h.reduce((a,b)=>a+(b.actualPnl||0),0);
                    } catch{}

                    users.push({
                        id: idx++,
                        filename: file,
                        username: cfg.username || file.replace('_config.json',''),
                        email: cfg.email || '',
                        vipStatus: cfg.vipStatus || 'none',
                        lastLogin: stat.mtime,
                        binanceFuture: cfg.savedBinanceFut || 0,
                        kucoinFuture: cfg.savedKucoinFut || 0,
                        totalAll: cfg.savedTotalAssets || 0,
                        totalPnl: pnl
                    });
                } catch(e) {}
            }
        }
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify(users));
        return;
    }

    // -- API DETAILS (REALTIME - HEAVY) --
    if (req.url.startsWith('/api/details/')) {
        const username = decodeURIComponent(req.url.split('/api/details/')[1]);
        const configPath = path.join(USER_DATA_DIR, `${username}_config.json`);
        
        if (!fs.existsSync(configPath)) {
            res.writeHead(404); res.end(JSON.stringify({error:'Not Found'})); return;
        }

        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const data = await getRealtimeDetails(config);
            
            res.writeHead(200, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ username, data }));
        } catch (e) {
            res.writeHead(500); res.end(JSON.stringify({error: e.message}));
        }
        return;
    }

    // -- API SET VIP --
    if (req.method === 'POST' && req.url === '/api/admin/set-vip') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { users, vipStatus } = JSON.parse(body);
                const list = (users === 'ALL') ? fs.readdirSync(USER_DATA_DIR).filter(f=>f.endsWith('_config.json')) : users.map(u=>`${u}_config.json`);
                
                list.forEach(f => {
                    if(fs.existsSync(path.join(USER_DATA_DIR, f))) {
                        const c = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, f),'utf8'));
                        c.vipStatus = vipStatus;
                        // Set expiry logic...
                        fs.writeFileSync(path.join(USER_DATA_DIR, f), JSON.stringify(c,null,2));
                    }
                });
                res.end(JSON.stringify({success:true, message:`Đã set VIP cho ${list.length} users`}));
            } catch(e) { res.writeHead(500); res.end(JSON.stringify({success:false})); }
        });
        return;
    }

    // -- API TRANSFER (MOCK) --
    if (req.method === 'POST' && req.url === '/api/transfer') {
        res.end(JSON.stringify({ logs: [['Simulated Transfer: Success']] }));
        return;
    }
});

server.listen(PORT, () => {
    console.log(`Bot running: http://localhost:${PORT}`);
    
    // Auto Update Schedule
    setInterval(() => {
        const m = new Date().getMinutes();
        if (m % 10 === 0 && m < 55) autoUpdateAllUsers();
    }, 60000);
    if (new Date().getMinutes() < 55) autoUpdateAllUsers();
});
