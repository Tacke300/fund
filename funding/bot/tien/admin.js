const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

// [CONFIG]
const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

// Load địa chỉ ví từ file balance.js (nếu có)
let depositAddresses = {};
try {
    const balanceModule = require('./balance.js');
    if (balanceModule && balanceModule.usdtDepositAddressesByNetwork) {
        depositAddresses = balanceModule.usdtDepositAddressesByNetwork;
    }
} catch (e) { console.log("⚠️ Không tìm thấy balance.js, chức năng rút tiền có thể lỗi."); }

// Helper: Delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Khởi tạo Exchange từ Config User
function initExchange(exchangeId, config) {
    try {
        let exchangeClass;
        let options = { 'enableRateLimit': true };
        
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
    } catch (e) { return null; }
}

// --- API HANDLERS ---

// 1. Lấy danh sách User và Số dư tổng quan
async function getAllUsersSummary() {
    if (!fs.existsSync(USER_DATA_DIR)) return [];
    const files = fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json'));
    
    const users = [];
    let index = 1;

    for (const file of files) {
        try {
            const config = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, file), 'utf8'));
            // Chỉ fetch số dư Futures để hiển thị nhanh ở bảng ngoài
            let binanceBal = 0;
            let kucoinBal = 0;

            // Binance Futures Balance
            const binEx = initExchange('binanceusdm', config);
            if (binEx) {
                try {
                    const bal = await binEx.fetchBalance();
                    binanceBal = bal.total?.USDT || 0;
                } catch(e){}
            }

            // Kucoin Futures Balance
            const kuEx = initExchange('kucoinfutures', config);
            if (kuEx) {
                try {
                    const bal = await kuEx.fetchBalance();
                    kucoinBal = bal.total?.USDT || 0;
                } catch(e){}
            }

            users.push({
                id: index++,
                username: config.username || file.replace('_config.json', ''),
                email: config.email || 'N/A',
                binanceFuture: binanceBal,
                kucoinFuture: kucoinBal,
                total: binanceBal + kucoinBal,
                filename: file
            });
        } catch (e) { console.error(`Lỗi đọc file ${file}:`, e.message); }
    }
    return users;
}

// 2. Lấy chi tiết tài khoản (Spot, Margin, Earn...)
async function getUserDetails(filename) {
    const config = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, filename), 'utf8'));
    const details = [];

    // Helper quét số dư > 1$
    const scanBalance = async (exId, typeName) => {
        const ex = initExchange(exId, config);
        if (!ex) return;
        try {
            const bal = await ex.fetchBalance();
            const total = bal.total || {};
            for (const [coin, amount] of Object.entries(total)) {
                // Giả định giá 1 coin = 1 USDT cho nhanh (hoặc chỉ lọc USDT). 
                // Để chính xác cần fetchTicker nhưng sẽ rất chậm.
                // Ở đây ta lọc số lượng > 0 trước.
                if (amount > 0) {
                    // Nếu là USDT thì check > 1
                    if (coin === 'USDT' && amount < 1) continue;
                    details.push({ type: typeName, coin, amount: amount });
                }
            }
        } catch(e) {}
    };

    await Promise.all([
        scanBalance('binance', 'Binance Spot'),
        scanBalance('binanceusdm', 'Binance Future'),
        scanBalance('kucoin', 'KuCoin Spot'),
        scanBalance('kucoinfutures', 'KuCoin Future')
    ]);

    return details;
}

// 3. Xử lý GET ALL (Thanh lý toàn bộ -> Spot -> USDT)
async function processGetAll(config, exchangeName) {
    let log = [];
    const isBinance = exchangeName === 'binance';
    const spotEx = initExchange(isBinance ? 'binance' : 'kucoin', config);
    const futEx = initExchange(isBinance ? 'binanceusdm' : 'kucoinfutures', config);

    if (!spotEx || !futEx) return { success: false, log: ['Lỗi khởi tạo sàn'] };

    try {
        // A. Đóng Futures
        log.push(`Đang đóng lệnh Futures trên ${exchangeName}...`);
        try { await futEx.cancelAllOrders(); } catch(e){}
        
        // Đóng vị thế: Lấy position -> Market Close
        const positions = await futEx.fetchPositions();
        for (const pos of positions) {
            if (parseFloat(pos.contracts) > 0) {
                const side = pos.side === 'long' ? 'sell' : 'buy';
                // Kucoin cần params reduceOnly, Binance usdm cần positionSide
                const params = isBinance ? {positionSide: pos.side.toUpperCase()} : {reduceOnly: true};
                try {
                    await futEx.createMarketOrder(pos.symbol, side, pos.contracts, undefined, params);
                    log.push(`- Đóng ${pos.symbol} ${pos.side}`);
                } catch(e) { log.push(`! Lỗi đóng ${pos.symbol}: ${e.message}`); }
            }
        }
        await sleep(2000);

        // B. Chuyển Future -> Spot
        const futBal = await futEx.fetchBalance();
        const usdtFut = futBal.free.USDT || 0;
        if (usdtFut > 1) {
            try {
                await futEx.transfer('USDT', usdtFut, 'future', isBinance ? 'spot' : 'main');
                log.push(`- Đã chuyển ${usdtFut.toFixed(2)} USDT Future -> Spot`);
            } catch(e) { log.push(`! Lỗi chuyển Future->Spot: ${e.message}`); }
        }

        // C. Bán Coin Spot -> USDT (Chỉ bán đơn giản các coin số dư lớn)
        const spotBal = await spotEx.fetchBalance();
        for (const [coin, amount] of Object.entries(spotBal.free)) {
            if (coin === 'USDT') continue;
            // Logic bán qua USDT (Cần check min notional, ở đây làm mẫu)
            if (amount > 0) {
                try {
                    const symbol = `${coin}/USDT`;
                    await spotEx.createMarketSellOrder(symbol, amount);
                    log.push(`- Đã bán ${amount} ${coin} -> USDT`);
                } catch(e) { /* Bỏ qua lỗi min notional */ }
            }
        }

    } catch(e) { log.push(`Lỗi Get All: ${e.message}`); }
    
    return log;
}

// 4. Xử lý Chuyển tiền (Transfer Logic)
async function processTransfer(reqData) {
    const { fromExchange, toExchange, sourceWallet, username, coin, amount, isGetAll } = reqData;
    const results = [];

    // Xác định danh sách user cần xử lý
    let targetFiles = [];
    if (username === 'ALL') {
        targetFiles = fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json'));
    } else {
        targetFiles = [`${username}_config.json`]; // Username ở đây là safeName (phần đầu file) hoặc xử lý tìm file
        // Logic frontend gửi filename hoặc username, ta giả định gửi filename hoặc username khớp
        if (!fs.existsSync(path.join(USER_DATA_DIR, targetFiles[0]))) {
             // Thử tìm
             const all = fs.readdirSync(USER_DATA_DIR);
             const found = all.find(f => f.includes(username));
             if(found) targetFiles = [found];
        }
    }

    for (const file of targetFiles) {
        let userLog = [`User: ${file}`];
        try {
            const config = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, file), 'utf8'));
            
            // 1. Nếu chọn Get All -> Thực hiện dọn dẹp trước
            if (isGetAll) {
                const logs = await processGetAll(config, fromExchange);
                userLog = userLog.concat(logs);
            }

            // 2. Xác định sàn gửi / nhận
            const isFromBinance = fromExchange === 'binance';
            const srcEx = initExchange(isFromBinance ? 'binance' : 'kucoin', config); // Spot instance
            const srcFut = initExchange(isFromBinance ? 'binanceusdm' : 'kucoinfutures', config);
            
            if (!srcEx) { userLog.push("Thiếu API Key"); results.push(userLog); continue; }

            // 3. Gom tiền về Spot (nếu chưa Get All và chọn nguồn Future)
            if (!isGetAll && (sourceWallet === 'future' || sourceWallet === 'both')) {
                try {
                    const bal = await srcFut.fetchBalance();
                    const avail = bal.free.USDT || 0;
                    if (avail > 1) {
                        await srcFut.transfer('USDT', avail, 'future', isFromBinance ? 'spot' : 'main');
                        userLog.push(`Gom ${avail.toFixed(2)} USDT từ Future -> Spot`);
                    }
                } catch(e) {}
            }

            // 4. Rút tiền (Withdraw)
            // Lấy số dư Spot hiện tại
            const spotBalData = await srcEx.fetchBalance();
            const coinCode = coin.toUpperCase(); // USDT
            let availableAmount = spotBalData.free[coinCode] || 0;

            // Nếu ko phải Get All, dùng amount chỉ định
            let withdrawAmount = isGetAll ? availableAmount : parseFloat(amount);
            if (withdrawAmount > availableAmount) withdrawAmount = availableAmount;

            if (withdrawAmount < 10) { // Min rút thường là 10$
                userLog.push(`Số dư Spot không đủ để rút (${withdrawAmount} < 10)`);
            } else {
                // Lấy địa chỉ ví đích
                let address = '', network = '', tag = undefined;
                
                // Logic lấy địa chỉ từ balance.js
                if (toExchange === 'binance') {
                    // Rút từ Kucoin -> Binance (Mạng APTOS hoặc TRC20 tùy config)
                    // Giả định Binance dùng ví Aptos như code cũ
                    if(depositAddresses.binanceusdm?.APT) { address = depositAddresses.binanceusdm.APT; network = 'APT'; }
                    else if(depositAddresses.binance?.APT) { address = depositAddresses.binance.APT; network = 'APT'; }
                } else {
                    // Rút từ Binance -> Kucoin (Mạng BEP20)
                    if(depositAddresses.kucoinfutures?.BEP20) { address = depositAddresses.kucoinfutures.BEP20; network = 'BSC'; }
                    else if(depositAddresses.kucoin?.BEP20) { address = depositAddresses.kucoin.BEP20; network = 'BSC'; }
                }

                if (!address) {
                    userLog.push(`❌ Không tìm thấy địa chỉ ví đích trong balance.js`);
                } else {
                    try {
                        const params = { network: network };
                        await srcEx.withdraw(coinCode, withdrawAmount, address, tag, params);
                        userLog.push(`✅ Đã rút ${withdrawAmount} ${coinCode} về ${toExchange} (${network})`);
                    } catch(e) {
                        userLog.push(`❌ Lỗi rút tiền: ${e.message}`);
                    }
                }
            }

        } catch (e) { userLog.push(`Lỗi: ${e.message}`); }
        results.push(userLog);
    }
    return results;
}

// --- SERVER SETUP ---
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'GET' && req.url === '/') {
        fs.readFile(path.join(__dirname, 'admin.html'), (err, content) => {
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
        const filename = req.url.split('/').pop();
        const details = await getUserDetails(filename);
        res.end(JSON.stringify(details));
        return;
    }

    if (req.method === 'POST' && req.url === '/api/transfer') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            const data = JSON.parse(body);
            const logs = await processTransfer(data);
            res.end(JSON.stringify({ logs }));
        });
        return;
    }
});

server.listen(PORT, () => {
    console.log(`Admin Bot running at http://localhost:${PORT}`);
});
