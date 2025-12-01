const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

// --- 1. CONFIG CHUNG ---
function initExchange(exchangeId, config) {
    try {
        let exchangeClass;
        let options = { 'enableRateLimit': true, 'timeout': 15000 }; // Tăng timeout lên 15s để kịp load vị thế
        
        if (exchangeId === 'binance') { // Spot
            exchangeClass = ccxt.binance;
            options.apiKey = config.binanceApiKey;
            options.secret = config.binanceApiSecret;
        } else if (exchangeId === 'binanceusdm') { // Future
            exchangeClass = ccxt.binanceusdm;
            options.apiKey = config.binanceApiKey;
            options.secret = config.binanceApiSecret;
        } else if (exchangeId === 'kucoin') { // Spot
            exchangeClass = ccxt.kucoin;
            options.apiKey = config.kucoinApiKey;
            options.secret = config.kucoinApiSecret;
            options.password = config.kucoinPassword || config.kucoinApiPassword;
        } else if (exchangeId === 'kucoinfutures') { // Future
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

// --- 2. HÀM CHECK REAL-TIME CHI TIẾT (SPOT + FUTURE + POSITIONS) ---
async function getRealtimeDetails(config) {
    const details = {
        binance: { spot: [], future: {}, positions: [] },
        kucoin: { spot: [], future: {}, positions: [] },
        totalSpotUsdt: 0,
        totalFutureEquity: 0,
        errors: []
    };

    // Hàm lấy giá thị trường để tính ra USD cho Spot
    const getPrices = async (ex) => {
        try { return await ex.fetchTickers(); } catch(e) { return {}; }
    };

    // Logic lấy dữ liệu Binance
    const fetchBinance = async () => {
        try {
            // A. SPOT
            const spotEx = initExchange('binance', config);
            if (spotEx) {
                const [balance, tickers] = await Promise.all([
                    spotEx.fetchBalance(),
                    spotEx.fetchTickers() // Lấy giá để quy đổi ra USDT
                ]);
                
                // Lọc coin có số dư
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
                        if (valueUsdt >= 1) { // Chỉ lấy coin >= 1$
                            details.binance.spot.push({ coin, amount, valueUsdt });
                            details.totalSpotUsdt += valueUsdt;
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

                // Tính Equity (Tổng tài sản thực tế bao gồm PnL chưa chốt)
                // Binance trả về totalMarginBalance trong info
                const totalWallet = bal.total['USDT'] || 0;
                let unrealizedPnL = 0;
                
                // Lọc vị thế đang mở
                const activePositions = positions.filter(p => parseFloat(p.contracts) > 0);
                
                activePositions.forEach(p => {
                    unrealizedPnL += parseFloat(p.unrealizedPnl || 0);
                    details.binance.positions.push({
                        symbol: p.symbol,
                        side: p.side, // long/short
                        leverage: p.leverage,
                        entryPrice: p.entryPrice,
                        markPrice: p.markPrice,
                        amount: p.contracts,
                        pnl: p.unrealizedPnl,
                        roi: p.percentage // % lãi lỗ
                    });
                });

                // Equity = Wallet Balance + Unrealized PnL
                // (Hoặc dùng marginBalance từ sàn nếu có)
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

    // Logic lấy dữ liệu Kucoin (Tương tự)
    const fetchKucoin = async () => {
        try {
            // SPOT KUCOIN
            const spotEx = initExchange('kucoin', config);
            if (spotEx) {
                const balance = await spotEx.fetchBalance();
                // Kucoin fetchTickers khá nặng, có thể bỏ qua nếu sợ chậm, hoặc fetch từng coin
                // Ở đây demo lấy số dư USDT trước
                if (balance.total['USDT'] >= 1) {
                    details.kucoin.spot.push({ coin: 'USDT', amount: balance.total['USDT'], valueUsdt: balance.total['USDT'] });
                    details.totalSpotUsdt += balance.total['USDT'];
                }
                // (Muốn chính xác coin khác cần fetchTickers nhưng API Kucoin Spot public rate limit hơi gắt)
            }

            // FUTURE KUCOIN
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

                const equity = totalWallet + unrealizedPnL; // Kucoin logic
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

    // CHẠY SONG SONG CẢ 2 SÀN
    await Promise.all([fetchBinance(), fetchKucoin()]);
    
    return details;
}

// --- 3. BACKGROUND JOB (Cập nhật 10p/lần cho danh sách tổng) ---
async function updateBackgroundUser(filename) {
    const filePath = path.join(USER_DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return;
    try {
        const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        
        // Chỉ lấy số dư sơ bộ (Future Wallet Balance) để hiện list cho nhanh
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
        console.log(`[AUTO] Updated ${config.username}: ${config.savedTotalAssets}$`);
    } catch (e) { console.error(`[AUTO] Fail ${filename}`); }
}

async function autoUpdateAllUsers() {
    if (!fs.existsSync(USER_DATA_DIR)) return;
    const files = fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json'));
    // Chạy song song từng đợt 5 user để tránh spam network quá mức
    const chunk = 5;
    for (let i = 0; i < files.length; i += chunk) {
        const batch = files.slice(i, i + chunk);
        await Promise.all(batch.map(f => updateBackgroundUser(f)));
    }
}

// --- 4. SERVER CHÍNH ---
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    // API: Lấy danh sách (Đọc từ file JSON đã cache) -> SIÊU NHANH
    if (req.url === '/api/users') {
        const users = [];
        if (fs.existsSync(USER_DATA_DIR)) {
            const files = fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json'));
            let idx = 1;
            for (const file of files) {
                try {
                    const cfg = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, file), 'utf8'));
                    users.push({
                        id: idx++,
                        username: cfg.username || file.replace('_config.json', ''),
                        totalAll: cfg.savedTotalAssets || 0, // Số dư update 10p/lần
                        lastUpdate: cfg.lastBalanceUpdate
                    });
                } catch(e) {}
            }
        }
        res.end(JSON.stringify(users));
        return;
    }

    // API: Chi tiết (REAL-TIME fetch) -> Chậm hơn chút nhưng data đầy đủ
    if (req.url.startsWith('/api/details/')) {
        const username = decodeURIComponent(req.url.split('/api/details/')[1]);
        const configPath = path.join(USER_DATA_DIR, `${username}_config.json`);
        
        if (!fs.existsSync(configPath)) {
            res.writeHead(404); res.end('{}'); return;
        }

        try {
            console.log(`[DETAIL] Fetching REAL-TIME for ${username}...`);
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            
            // Gọi hàm lấy chi tiết (Spot, Future, Positions)
            const detailData = await getRealtimeDetails(config);
            
            // Trả về cho frontend
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                username: username,
                data: detailData
            }));
            console.log(`[DETAIL] Done ${username}`);

        } catch (e) {
            console.error(e);
            res.writeHead(500); res.end(JSON.stringify({error: e.message}));
        }
        return;
    }

    // Admin UI
    if (req.method === 'GET' && req.url === '/') {
        fs.readFile(path.join(__dirname, 'admin.html'), (err, content) => {
            if(err) res.end('No UI'); else {
                res.writeHead(200, {'Content-Type': 'text/html'});
                res.end(content);
            }
        });
        return;
    }
});

server.listen(PORT, () => {
    console.log(`Server running port ${PORT}`);

    // --- SCHEDULE 10 PHÚT (TRỪ 55-00) ---
    setInterval(() => {
        const m = new Date().getMinutes();
        // Chạy tại phút 0, 10, 20, 30, 40, 50. Và phải < 55 (để tránh khung giờ đỏ)
        if (m % 10 === 0 && m < 55) {
            console.log(`[SCHEDULE] Triggering Auto Update at minute ${m}`);
            autoUpdateAllUsers();
        }
    }, 60 * 1000); // Check mỗi phút
    
    // Chạy ngay lần đầu nếu không phải giờ cấm
    if (new Date().getMinutes() < 55) autoUpdateAllUsers();
});
