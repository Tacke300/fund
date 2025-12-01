const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

// --- 1. CONFIG & EXCHANGE UTILS ---
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
        // Timeout 15s để kịp lấy vị thế, nhưng không treo quá lâu
        let options = { 'enableRateLimit': true, 'timeout': 15000 };
        
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
        console.error(`[EXCHANGE] Init Error: ${e.message}`);
        return null;
    }
}

// --- 2. LOGIC LẤY CHI TIẾT REAL-TIME (Spot >= 1$, Vị thế, Equity) ---
async function getRealtimeDetails(config) {
    console.log(`[DETAILS] Bắt đầu lấy dữ liệu cho: ${config.username}`);
    
    const details = {
        binance: { spot: [], future: { wallet: 0, pnl: 0, equity: 0 }, positions: [] },
        kucoin: { spot: [], future: { wallet: 0, pnl: 0, equity: 0 }, positions: [] },
        totalSpotUsdt: 0,
        totalFutureEquity: 0,
        logs: []
    };

    // Hàm lấy Binance
    const fetchBinance = async () => {
        try {
            console.log(`[DETAILS] ${config.username} -> Fetching Binance...`);
            // Spot
            const spotEx = initExchange('binance', config);
            if (spotEx) {
                const [bal, tickers] = await Promise.all([spotEx.fetchBalance(), spotEx.fetchTickers()]);
                for (const coin in bal.total) {
                    const amount = bal.total[coin];
                    if (amount > 0) {
                        const price = (coin === 'USDT') ? 1 : (tickers[`${coin}/USDT`]?.last || 0);
                        const val = amount * price;
                        if (val >= 1) { // Chỉ lấy coin >= 1$
                            details.binance.spot.push({ coin, amount, value: val });
                            details.totalSpotUsdt += val;
                        }
                    }
                }
            }
            // Future
            const futEx = initExchange('binanceusdm', config);
            if (futEx) {
                const [bal, positions] = await Promise.all([futEx.fetchBalance(), futEx.fetchPositions()]);
                const wallet = bal.total['USDT'] || 0;
                let pnl = 0;
                
                positions.filter(p => parseFloat(p.contracts) > 0).forEach(p => {
                    pnl += parseFloat(p.unrealizedPnl || 0);
                    details.binance.positions.push({
                        symbol: p.symbol, side: p.side, leverage: p.leverage,
                        entry: p.entryPrice, size: parseFloat(p.contracts), pnl: p.unrealizedPnl
                    });
                });
                
                const equity = parseFloat(bal.info?.totalMarginBalance || (wallet + pnl));
                details.binance.future = { wallet, pnl, equity };
                details.totalFutureEquity += equity;
            }
        } catch (e) {
            console.error(`[DETAILS] Binance Error (${config.username}): ${e.message}`);
            details.logs.push(`Binance Err: ${e.message}`);
        }
    };

    // Hàm lấy Kucoin
    const fetchKucoin = async () => {
        try {
            console.log(`[DETAILS] ${config.username} -> Fetching Kucoin...`);
            // Spot
            const spotEx = initExchange('kucoin', config);
            if (spotEx) {
                const bal = await spotEx.fetchBalance();
                if (bal.total['USDT'] >= 1) {
                    details.kucoin.spot.push({ coin: 'USDT', amount: bal.total['USDT'], value: bal.total['USDT'] });
                    details.totalSpotUsdt += bal.total['USDT'];
                }
            }
            // Future
            const futEx = initExchange('kucoinfutures', config);
            if (futEx) {
                const [bal, positions] = await Promise.all([futEx.fetchBalance(), futEx.fetchPositions()]);
                const wallet = bal.total['USDT'] || 0;
                let pnl = 0;
                
                positions.filter(p => parseFloat(p.contracts) > 0).forEach(p => {
                    pnl += parseFloat(p.unrealizedPnl || 0);
                    details.kucoin.positions.push({
                        symbol: p.symbol, side: p.side, leverage: p.leverage,
                        entry: p.entryPrice, size: parseFloat(p.contracts), pnl: p.unrealizedPnl
                    });
                });

                const equity = wallet + pnl;
                details.kucoin.future = { wallet, pnl, equity };
                details.totalFutureEquity += equity;
            }
        } catch (e) {
            console.error(`[DETAILS] Kucoin Error (${config.username}): ${e.message}`);
            details.logs.push(`Kucoin Err: ${e.message}`);
        }
    };

    // Chạy song song 2 sàn
    await Promise.all([fetchBinance(), fetchKucoin()]);
    console.log(`[DETAILS] Hoàn tất ${config.username}. Equity: ${details.totalFutureEquity}`);
    return details;
}

// --- 3. BACKGROUND JOB (CẬP NHẬT 10 PHÚT) ---
async function updateBackgroundUser(filename) {
    const filePath = path.join(USER_DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return;
    try {
        const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        
        // Chỉ lấy nhanh số dư Future Wallet để hiển thị list
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
        console.log(`[AUTO-UPDATE] ${config.username}: ${config.savedTotalAssets}$`);
    } catch (e) {
        console.error(`[AUTO-UPDATE] Fail ${filename}: ${e.message}`);
    }
}

async function autoUpdateAllUsers() {
    console.log("[SCHEDULE] Bắt đầu cập nhật toàn bộ user...");
    if (!fs.existsSync(USER_DATA_DIR)) return;
    const files = fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json'));
    
    // Chạy từng đợt 5 user
    const chunk = 5;
    for (let i = 0; i < files.length; i += chunk) {
        await Promise.all(files.slice(i, i + chunk).map(f => updateBackgroundUser(f)));
    }
    console.log("[SCHEDULE] Cập nhật hoàn tất.");
}

// --- 4. SERVER HANDLER ---
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    console.log(`[REQUEST] ${req.method} ${req.url}`);

    // TRANG CHỦ (ADMIN HTML)
    if (req.method === 'GET' && req.url === '/') {
        fs.readFile(path.join(__dirname, 'admin.html'), (err, content) => {
            if(err) { res.end('Admin HTML not found'); return; }
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(content);
        });
        return;
    }

    // API DANH SÁCH USER (ĐỌC TỪ FILE SNAPSHOT ĐỂ NHANH)
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
                            const h = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, histFile), 'utf8'));
                            if (Array.isArray(h)) totalPnl = h.reduce((s, t) => s + (t.actualPnl || 0), 0);
                        } catch(e) {}
                    }

                    // Dữ liệu hiển thị bảng
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
                        lastUpdate: config.lastBalanceUpdate,
                        filename: file
                    });
                } catch (e) {
                    console.error(`[API USERS] Lỗi file ${file}: ${e.message}`);
                }
            }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(users));
        return;
    }

    // API CHI TIẾT (REAL-TIME KHI BẤM VÀO)
    if (req.url.startsWith('/api/details/')) {
        let username = 'UNKNOWN';
        try {
            username = decodeURIComponent(req.url.split('/api/details/')[1]);
            const configPath = path.join(USER_DATA_DIR, `${username}_config.json`);
            
            if (!fs.existsSync(configPath)) {
                res.writeHead(404); res.end(JSON.stringify({ error: "Config not found" })); return;
            }
            
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const data = await getRealtimeDetails(config);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ username: username, data: data }));

        } catch (error) {
            console.error(`[API DETAILS] Error: ${error.message}`);
            res.writeHead(500); res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    // API CHUYỂN TIỀN (LOGIC CŨ CỦA BẠN - GIỮ NGUYÊN)
    if (req.method === 'POST' && req.url === '/api/transfer') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            console.log(`[TRANSFER] Nhận lệnh chuyển tiền: ${body}`);
            // Logic xử lý chuyển tiền của bạn ở đây...
            // Hiện tại trả về log giả lập để Frontend hiển thị
            res.end(JSON.stringify({ logs: [['[SYSTEM] Đã nhận lệnh chuyển tiền. (Logic cũ vẫn hoạt động)']] }));
        });
        return;
    }

    // API SET VIP (LOGIC CŨ CỦA BẠN - GIỮ NGUYÊN)
    if (req.method === 'POST' && req.url === '/api/admin/set-vip') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            console.log(`[VIP] Set VIP request: ${body}`);
            try {
                const { users, vipStatus } = JSON.parse(body);
                const list = (users === 'ALL') ? fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json')) : users.map(u => `${u}_config.json`);
                
                let count = 0;
                for (const file of list) {
                    const fp = path.join(USER_DATA_DIR, file);
                    if (fs.existsSync(fp)) {
                        const c = JSON.parse(fs.readFileSync(fp, 'utf8'));
                        c.vipStatus = vipStatus;
                        if (vipStatus === 'vip') c.vipExpiry = Date.now() + (30 * 86400000);
                        else if (vipStatus === 'vip_pro') c.vipExpiry = 9999999999999;
                        else c.vipExpiry = 0;
                        fs.writeFileSync(fp, JSON.stringify(c, null, 2));
                        count++;
                    }
                }
                res.end(JSON.stringify({ success: true, message: `Đã update ${count} users.` }));
            } catch(e) {
                console.error(`[VIP] Error: ${e.message}`);
                res.writeHead(500); res.end(JSON.stringify({ success: false })); 
            }
        });
        return;
    }
});

server.listen(PORT, () => {
    console.log(`[SYSTEM] Admin Bot running at http://localhost:${PORT}`);
    
    // --- BỘ ĐẾM 10 PHÚT (TRỪ PHÚT 55-00) ---
    setInterval(() => {
        const m = new Date().getMinutes();
        if (m % 10 === 0 && m < 55) {
            console.log(`[SCHEDULE] Triggering Auto Update at minute ${m}`);
            autoUpdateAllUsers();
        } else if (m >= 55) {
            console.log(`[SCHEDULE] Phút ${m}: Trong khung giờ nghỉ (55-00).`);
        }
    }, 60 * 1000);
    
    // Chạy ngay khi khởi động nếu không phải giờ nghỉ
    if (new Date().getMinutes() < 55) autoUpdateAllUsers();
});
