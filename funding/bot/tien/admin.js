const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

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
        let options = { 'enableRateLimit': true, 'timeout': 10000 };
        
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
            
            let totalPnl = 0;
            const histFile = file.replace('_config.json', '_history.json');
            if (fs.existsSync(path.join(USER_DATA_DIR, histFile))) {
                try {
                    const history = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, histFile), 'utf8'));
                    // Chỉ tính PnL từ các lệnh đã đóng có actualPnl hợp lệ
                    if (Array.isArray(history)) {
                        totalPnl = history.reduce((sum, trade) => sum + (parseFloat(trade.actualPnl) || 0), 0);
                    }
                } catch(e) {}
            }

            users.push({
                id: index++,
                username: config.username || file.replace('_config.json', ''),
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

    // FIX: API Details Logic
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

            const checkExchange = async (exName, exId) => {
                try {
                    const ex = initExchange(exId, config);
                    if (!ex) return { total: 0, positions: [], spot: [] };

                    // Load market để lấy đúng precision và symbol
                    await ex.loadMarkets();

                    // 1. Lấy Balance Future
                    const bal = await ex.fetchBalance();
                    const total = bal.total['USDT'] || 0;

                    // 2. Lấy Positions & Fix Leverage
                    let positions = [];
                    try {
                        const rawPos = await ex.fetchPositions();
                        positions = rawPos
                            .filter(p => parseFloat(p.contracts) > 0)
                            .map(p => ({
                                symbol: p.symbol,
                                side: p.side,
                                size: parseFloat(p.contracts),
                                entry: parseFloat(p.entryPrice),
                                // FIX: Lấy leverage chuẩn từ binance/kucoin
                                leverage: p.leverage || (p.info && p.info.leverage) || 'N/A',
                                pnl: parseFloat(p.unrealizedPnl || 0)
                            }));
                    } catch (e) {}

                    // 3. Lấy Spot Balance (Logic quét coin > 1$)
                    let spotAssets = [];
                    try {
                        // Cần init sàn Spot tương ứng
                        const spotExId = exId === 'binanceusdm' ? 'binance' : 'kucoin';
                        const spotEx = initExchange(spotExId, config);
                        if(spotEx) {
                            const spotBal = await spotEx.fetchBalance();
                            const totalSpot = spotBal.total;
                            for (const [coin, amt] of Object.entries(totalSpot)) {
                                if (coin !== 'USDT' && amt > 0) {
                                    // Giả định giá trị > 1 USDT (đơn giản hóa để không call ticker quá nhiều gây lag)
                                    // Trong thực tế cần fetchTicker, ở đây ta lấy USDT balance là chính
                                    if(coin === 'USDT' && amt > 1) spotAssets.push({coin: 'USDT', amount: amt, value: amt});
                                }
                            }
                            // Thêm logic fetchTicker nếu cần thiết, ở đây giữ simple để server k bị timeout
                        }
                    } catch(e) {}

                    return { 
                        total: total, 
                        positions: positions, 
                        spot: spotAssets,
                        future: { equity: total }
                    };
                } catch (e) {
                    return { total: 0, positions: [], spot: [], error: e.message };
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
                totalSpotUsdt: (binance.spot.reduce((a,b)=>a+b.value,0) + kucoin.spot.reduce((a,b)=>a+b.value,0)),
                totalFutureEquity: (binance.total + kucoin.total),
                logs: []
            };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responsePayload));

        } catch (error) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/api/transfer') {
        res.end(JSON.stringify({ logs: ['Request Sent'] }));
        return;
    }

    if (req.method === 'POST' && req.url === '/api/admin/set-vip') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { users, vipStatus } = JSON.parse(body);
                const targetFiles = (users === 'ALL') ? fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json')) : users.map(u => `${u}_config.json`);
                for (const file of targetFiles) {
                    const p = path.join(USER_DATA_DIR, file);
                    if (fs.existsSync(p)) {
                        const c = JSON.parse(fs.readFileSync(p));
                        c.vipStatus = vipStatus;
                        c.vipExpiry = vipStatus === 'vip' ? Date.now() + 2592000000 : (vipStatus === 'vip_pro' ? 9999999999999 : 0);
                        fs.writeFileSync(p, JSON.stringify(c, null, 2));
                    }
                }
                res.end(JSON.stringify({ success: true }));
            } catch(e) { res.writeHead(500); res.end(JSON.stringify({ success: false })); }
        });
        return;
    }
});

server.listen(PORT, () => console.log(`Admin running on ${PORT}`));
