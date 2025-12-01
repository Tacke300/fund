const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

function initExchange(exchangeId, config) {
    try {
        let exchangeClass;
        let options = { 'enableRateLimit': true, 'timeout': 15000 };
        
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

async function getRealtimeDetails(config) {
    const details = {
        binance: { spot: [], future: {}, positions: [] },
        kucoin: { spot: [], future: {}, positions: [] },
        totalSpotUsdt: 0,
        totalFutureEquity: 0,
        errors: []
    };

    const fetchBinance = async () => {
        try {
            const spotEx = initExchange('binance', config);
            if (spotEx) {
                const [balance, tickers] = await Promise.all([
                    spotEx.fetchBalance(),
                    spotEx.fetchTickers()
                ]);
                for (const coin in balance.total) {
                    const amount = balance.total[coin];
                    if (amount > 0) {
                        let price = 0;
                        if (coin === 'USDT') price = 1;
                        else {
                            const pair = `${coin}/USDT`;
                            if (tickers[pair]) price = tickers[pair].last;
                        }
                        const valueUsdt = amount * price;
                        if (valueUsdt >= 1) {
                            details.binance.spot.push({ coin, amount, valueUsdt });
                            details.totalSpotUsdt += valueUsdt;
                        }
                    }
                }
            }

            const futEx = initExchange('binanceusdm', config);
            if (futEx) {
                const [bal, positions] = await Promise.all([
                    futEx.fetchBalance(),
                    futEx.fetchPositions()
                ]);

                const totalWallet = bal.total['USDT'] || 0;
                let unrealizedPnL = 0;
                
                const activePositions = positions.filter(p => parseFloat(p.contracts) > 0);
                activePositions.forEach(p => {
                    unrealizedPnL += parseFloat(p.unrealizedPnl || 0);
                    details.binance.positions.push({
                        symbol: p.symbol,
                        side: p.side,
                        leverage: p.leverage,
                        entryPrice: p.entryPrice,
                        markPrice: p.markPrice,
                        amount: p.contracts,
                        pnl: p.unrealizedPnl,
                        roi: p.percentage
                    });
                });

                const equity = parseFloat(bal.info?.totalMarginBalance || (totalWallet + unrealizedPnL));
                details.binance.future = {
                    walletBalance: totalWallet,
                    unrealizedPnL: unrealizedPnL,
                    totalEquity: equity
                };
                details.totalFutureEquity += equity;
            }
        } catch (e) {
            details.errors.push(`Binance Error: ${e.message}`);
        }
    };

    const fetchKucoin = async () => {
        try {
            const spotEx = initExchange('kucoin', config);
            if (spotEx) {
                const balance = await spotEx.fetchBalance();
                if (balance.total['USDT'] >= 1) {
                    details.kucoin.spot.push({ coin: 'USDT', amount: balance.total['USDT'], valueUsdt: balance.total['USDT'] });
                    details.totalSpotUsdt += balance.total['USDT'];
                }
            }

            const futEx = initExchange('kucoinfutures', config);
            if (futEx) {
                const [bal, positions] = await Promise.all([
                    futEx.fetchBalance(),
                    futEx.fetchPositions()
                ]);

                const totalWallet = bal.total['USDT'] || 0;
                let unrealizedPnL = 0;
                
                const activePositions = positions.filter(p => parseFloat(p.contracts) > 0);
                activePositions.forEach(p => {
                    unrealizedPnL += parseFloat(p.unrealizedPnl || 0);
                    details.kucoin.positions.push({
                        symbol: p.symbol,
                        side: p.side,
                        leverage: p.leverage,
                        entryPrice: p.entryPrice,
                        pnl: p.unrealizedPnl
                    });
                });

                const equity = totalWallet + unrealizedPnL;
                details.kucoin.future = {
                    walletBalance: totalWallet,
                    unrealizedPnL: unrealizedPnL,
                    totalEquity: equity
                };
                details.totalFutureEquity += equity;
            }
        } catch (e) {
            details.errors.push(`Kucoin Error: ${e.message}`);
        }
    };

    await Promise.all([fetchBinance(), fetchKucoin()]);
    return details;
}

async function updateBackgroundUser(filename) {
    const filePath = path.join(USER_DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return;
    try {
        const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const getFutBal = async (id) => {
            const ex = initExchange(id, config);
            if (!ex) return 0;
            try { 
                const b = await ex.fetchBalance(); 
                return b.total['USDT'] || 0; 
            } catch { return 0; }
        };

        const [binFut, kuFut] = await Promise.all([
            getFutBal('binanceusdm'), 
            getFutBal('kucoinfutures')
        ]);

        config.savedBinanceFut = binFut;
        config.savedKucoinFut = kuFut;
        config.savedTotalAssets = binFut + kuFut;
        config.lastBalanceUpdate = Date.now();

        fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
    } catch (e) { console.error(`[AUTO] Fail ${filename}`); }
}

async function autoUpdateAllUsers() {
    if (!fs.existsSync(USER_DATA_DIR)) return;
    const files = fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json'));
    const chunk = 5;
    for (let i = 0; i < files.length; i += chunk) {
        const batch = files.slice(i, i + chunk);
        await Promise.all(batch.map(f => updateBackgroundUser(f)));
    }
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
        const users = [];
        if (fs.existsSync(USER_DATA_DIR)) {
            const files = fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json'));
            let index = 1;
            for (const file of files) {
                try {
                    const filePath = path.join(USER_DATA_DIR, file);
                    const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    const stats = fs.statSync(filePath);
                    
                    let totalPnl = 0;
                    const histFile = file.replace('_config.json', '_history.json');
                    if (fs.existsSync(path.join(USER_DATA_DIR, histFile))) {
                        try {
                            const history = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, histFile), 'utf8'));
                            if (Array.isArray(history)) totalPnl = history.reduce((sum, trade) => sum + (trade.actualPnl || 0), 0);
                        } catch(e) {}
                    }

                    const binanceFut = config.savedBinanceFut || 0;
                    const kucoinFut = config.savedKucoinFut || 0;
                    const totalAssets = config.savedTotalAssets || (binanceFut + kucoinFut);

                    users.push({
                        id: index++,
                        username: config.username || file.replace('_config.json', ''),
                        email: config.email || 'N/A',
                        vipStatus: config.vipStatus || 'none',
                        binanceFuture: binanceFut,
                        kucoinFuture: kucoinFut,
                        totalAll: totalAssets,
                        totalPnl: totalPnl,
                        lastLogin: stats.mtime,
                        lastUpdate: config.lastBalanceUpdate || 0,
                        filename: file
                    });
                } catch (e) {
                    console.error(`[USER LOAD] Error loading ${file}: ${e.message}`);
                }
            }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(users));
        return;
    }

    if (req.url.startsWith('/api/details/')) {
        let username = 'UNKNOWN';
        try {
            const urlParts = req.url.split('/api/details/');
            username = decodeURIComponent(urlParts[1]);

            const configPath = path.join(USER_DATA_DIR, `${username}_config.json`);
            if (!fs.existsSync(configPath)) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: "User config not found" }));
                return;
            }
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const detailData = await getRealtimeDetails(config);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ username: username, data: detailData }));

        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
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
                    : users.map(u => `${u}_config.json`);

                for (const file of targetFiles) {
                    const filePath = path.join(USER_DATA_DIR, file);
                    if (fs.existsSync(filePath)) {
                        const cfg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                        cfg.vipStatus = vipStatus;
                        if (vipStatus === 'vip') cfg.vipExpiry = Date.now() + (30 * 86400000);
                        else if (vipStatus === 'vip_pro') cfg.vipExpiry = 9999999999999;
                        else cfg.vipExpiry = 0;
                        fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2));
                    }
                }
                res.end(JSON.stringify({ success: true }));
            } catch(e) {
                res.writeHead(500); 
                res.end(JSON.stringify({ success: false })); 
            }
        });
        return;
    }

    if (req.method === 'POST' && req.url === '/api/transfer') {
        res.end(JSON.stringify({ logs: ['Skipped'] }));
        return;
    }
});

server.listen(PORT, () => {
    console.log(`Admin Bot running at http://localhost:${PORT}`);
    
    setInterval(() => {
        const m = new Date().getMinutes();
        if (m % 10 === 0 && m < 55) {
            autoUpdateAllUsers();
        }
    }, 60 * 1000);
    
    if (new Date().getMinutes() < 55) {
        autoUpdateAllUsers();
    }
});
