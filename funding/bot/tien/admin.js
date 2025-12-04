const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

function initExchange(exchangeId, config) {
    try {
        let exchangeClass;
        let options = { 'enableRateLimit': true, 'timeout': 10000 };
        
        if (exchangeId.includes('binance')) {
            exchangeClass = exchangeId === 'binanceusdm' ? ccxt.binanceusdm : ccxt.binance;
            options.apiKey = config.binanceApiKey;
            options.secret = config.binanceApiSecret;
        } else if (exchangeId.includes('kucoin')) {
            exchangeClass = exchangeId === 'kucoinfutures' ? ccxt.kucoinfutures : ccxt.kucoin;
            options.apiKey = config.kucoinApiKey;
            options.secret = config.kucoinApiSecret;
            options.password = config.kucoinPassword;
        }
        return new exchangeClass(options);
    } catch (e) { return null; }
}

async function getAllUsersSummary() {
    if (!fs.existsSync(USER_DATA_DIR)) return [];
    const files = fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json'));
    
    const users = [];
    for (const file of files) {
        try {
            const config = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, file), 'utf8'));
            const totalPnl = config.cumulativePnl || 0; // Fix #3: Lấy PnL cộng dồn
            
            users.push({
                username: config.username,
                email: config.email || '-',
                vipStatus: config.vipStatus,
                binanceFuture: config.savedBinanceFut || 0,
                kucoinFuture: config.savedKucoinFut || 0,
                totalAll: config.savedTotalAssets || 0,
                totalPnl: totalPnl,
                lastLogin: fs.statSync(path.join(USER_DATA_DIR, file)).mtime
            });
        } catch(e) {}
    }
    return users;
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // --- API LIST USERS ---
    if (req.url === '/api/users') {
        const users = await getAllUsersSummary();
        res.end(JSON.stringify(users));
        return;
    }

    // --- API DETAILS (Fix #1, #2) ---
    if (req.url.startsWith('/api/details/')) {
        const username = req.url.split('/api/details/')[1];
        const configPath = path.join(USER_DATA_DIR, `${username}_config.json`);
        
        if (!fs.existsSync(configPath)) return res.end(JSON.stringify({error: 'User not found'}));
        
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const responseData = { username, binance: {}, kucoin: {}, totalSpotUsdt: 0, totalFutureEquity: 0, logs: [] };

        const getPos = async (exId, name) => {
            const ex = initExchange(exId, config);
            if(!ex) return { equity: 0, positions: [], spot: [] };
            
            try {
                // Fetch Balance & Positions
                const [bal, posRaw] = await Promise.all([
                    ex.fetchBalance(),
                    ex.fetchPositions()
                ]);

                // Map Positions (Fix #1: Leverage & #2: Margin)
                const positions = posRaw
                    .filter(p => parseFloat(p.contracts) > 0)
                    .map(p => {
                        // Extract leverage safely
                        let lev = p.leverage;
                        if (!lev && p.info) lev = p.info.leverage; // Binance often hides it here
                        lev = parseFloat(lev || 1);

                        // Calculate Margin (Fix #2)
                        const size = parseFloat(p.contractSize || 1) * parseFloat(p.contracts) * parseFloat(p.price || p.markPrice || 0);
                        const margin = size / lev;

                        return {
                            symbol: p.symbol,
                            leverage: lev,
                            side: p.side,
                            size: parseFloat(p.contracts),
                            notional: size,
                            margin: margin, // NEW FIELD
                            entry: p.entryPrice,
                            pnl: p.unrealizedPnl || 0
                        };
                    });

                return {
                    equity: bal.total?.USDT || 0,
                    spot: [], // Giản lược spot cho ngắn gọn
                    positions: positions
                };
            } catch(e) { 
                responseData.logs.push(`${name} Err: ${e.message}`);
                return { equity: 0, positions: [], spot: [] };
            }
        };

        const [bin, kuc] = await Promise.all([
            getPos('binanceusdm', 'Binance'),
            getPos('kucoinfutures', 'KuCoin')
        ]);

        responseData.binance = { future: bin };
        responseData.kucoin = { future: kuc };
        responseData.totalFutureEquity = bin.equity + kuc.equity;
        
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ data: responseData }));
        return;
    }

    // Default: Serve Admin HTML
    if (req.url === '/') {
        fs.readFile(path.join(__dirname, 'admin.html'), (err, content) => {
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(content);
        });
    }
});

server.listen(PORT, () => console.log(`Admin running on ${PORT}`));
