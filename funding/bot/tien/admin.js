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
    } catch (e) {
        return null;
    }
}

// Hàm tối ưu dữ liệu biểu đồ (Downsampling)
function getOptimizedBalanceHistory(username) {
    try {
        const file = path.join(USER_DATA_DIR, `${username}_balance_history.json`);
        if (!fs.existsSync(file)) return [];
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(raw) || raw.length === 0) return [];

        // Nếu dữ liệu quá lớn, chỉ lấy mẫu khoảng 300 điểm để vẽ chart cho nhanh
        const targetPoints = 300;
        if (raw.length <= targetPoints) return raw;

        const step = Math.ceil(raw.length / targetPoints);
        const optimized = [];
        for (let i = 0; i < raw.length; i += step) {
            optimized.push(raw[i]);
        }
        // Luôn lấy điểm cuối cùng
        if (optimized[optimized.length - 1] !== raw[raw.length - 1]) {
            optimized.push(raw[raw.length - 1]);
        }
        return optimized;
    } catch (e) {
        return [];
    }
}

function getUserTradeHistory(username) {
    try {
        const file = path.join(USER_DATA_DIR, `${username}_history.json`);
        if (!fs.existsSync(file)) return [];
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return [];
    }
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
                    if (Array.isArray(history)) totalPnl = history.reduce((sum, trade) => sum + (parseFloat(trade.actualPnl) || 0), 0);
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
        try {
            const users = await getAllUsersSummary();
            res.end(JSON.stringify(users));
        } catch (e) { res.end('[]'); }
        return;
    }

    if (req.url.startsWith('/api/details/')) {
        let username = 'UNKNOWN';
        try {
            const urlParts = req.url.split('/api/details/');
            if (urlParts.length < 2) throw new Error("URL Invalid");
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
                    if (!ex) return { total: 0, free: 0, positions: [], spot: [] };

                    await ex.loadMarkets();
                    const bal = await ex.fetchBalance();
                    const total = bal.total['USDT'] || 0;
                    const free = bal.free['USDT'] || 0;

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
                                leverage: p.leverage || (p.info && p.info.leverage) || 'N/A',
                                pnl: parseFloat(p.unrealizedPnl || 0)
                            }));
                    } catch (e) {}

                    let spotAssets = [];
                    try {
                        const spotExId = exId === 'binanceusdm' ? 'binance' : 'kucoin';
                        const spotEx = initExchange(spotExId, config);
                        if(spotEx) {
                            const sBal = await spotEx.fetchBalance();
                            for(const [c, v] of Object.entries(sBal.total)) {
                                if(c === 'USDT' && v > 1) spotAssets.push({coin: c, amount: v, value: v});
                            }
                        }
                    } catch(e) {}

                    return { total: total, free: free, positions: positions, spot: spotAssets };
                } catch (e) {
                    return { total: 0, free: 0, error: e.message, positions: [], spot: [] };
                }
            };

            const [binance, kucoin] = await Promise.all([
                checkExchange('Binance', 'binanceusdm'),
                checkExchange('Kucoin', 'kucoinfutures')
            ]);

            // Lấy dữ liệu lịch sử và biểu đồ
            const balanceHistory = getOptimizedBalanceHistory(username);
            const tradeHistory = getUserTradeHistory(username);

            const responsePayload = {
                username: username,
                binance: binance,
                kucoin: kucoin,
                totalUsdt: (binance.total + kucoin.total),
                balanceHistory: balanceHistory,
                tradeHistory: tradeHistory
            };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responsePayload));

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
});

server.listen(PORT, () => {
    console.log(`Admin Bot running at http://localhost:${PORT}`);
});
