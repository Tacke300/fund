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
} catch (e) {}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function initExchange(exchangeId, config) {
    try {
        let exchangeClass;
        let options = { 'enableRateLimit': true, 'timeout': 5000 };
        
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

async function getPrice(exchange, symbol) {
    try {
        if (symbol === 'USDT') return 1;
        const ticker = await exchange.fetchTicker(`${symbol}/USDT`);
        return ticker.last || 0;
    } catch (e) { return 0; }
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
                    if (Array.isArray(history)) totalPnl = history.reduce((sum, trade) => sum + (trade.actualPnl || 0), 0);
                } catch(e) {}
            }

            const binanceFut = config.savedBinanceFut || 0;
            const kucoinFut = config.savedKucoinFut || 0;
            const totalAssets = config.savedTotalAssets || 0;

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
                filename: file
            });
        } catch (e) {}
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

    if (req.url.startsWith('/api/details/')) {
        let username = '';
        try {
            const urlParts = req.url.split('/api/details/');
            if (urlParts.length < 2) throw new Error("Invalid URL");
            username = decodeURIComponent(urlParts[1]);

            const configPath = path.join(USER_DATA_DIR, `${username}_config.json`);
            if (!fs.existsSync(configPath)) {
                res.end(JSON.stringify({ error: "User config not found", totalUsdt: 0 }));
                return;
            }
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

            const getBalance = async (exId) => {
                try {
                    const ex = initExchange(exId, config);
                    if (!ex) return { total: 0, free: 0 };
                    const bal = await ex.fetchBalance();
                    return { 
                        total: bal.total['USDT'] || 0, 
                        free: bal.free['USDT'] || 0 
                    };
                } catch (e) { return { total: 0, free: 0, error: e.message }; }
            };

            const [binance, kucoin] = await Promise.all([
                getBalance('binanceusdm'),
                getBalance('kucoinfutures')
            ]);

            res.end(JSON.stringify({
                username: username,
                binance: binance,
                kucoin: kucoin,
                totalUsdt: (binance.total + kucoin.total)
            }));

        } catch (error) {
            res.end(JSON.stringify({ error: error.message, totalUsdt: 0 }));
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/api/transfer') {
        res.end(JSON.stringify({ logs: ['Transfer logic skipped in this version'] }));
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

                let count = 0;
                for (const file of targetFiles) {
                    const filePath = path.join(USER_DATA_DIR, file);
                    if (fs.existsSync(filePath)) {
                        const cfg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                        cfg.vipStatus = vipStatus;
                        if (vipStatus === 'vip') cfg.vipExpiry = Date.now() + (30 * 86400000);
                        else if (vipStatus === 'vip_pro') cfg.vipExpiry = 9999999999999;
                        else cfg.vipExpiry = 0;
                        fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2));
                        count++;
                    }
                }
                res.end(JSON.stringify({ success: true, message: `Updated ${count} users.` }));
            } catch(e) { res.writeHead(500); res.end(JSON.stringify({ success: false })); }
        });
        return;
    }
});

server.listen(PORT, () => {
    console.log(`Admin Bot running at http://localhost:${PORT}`);
});
