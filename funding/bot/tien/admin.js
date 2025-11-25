const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

// [CONFIG]
const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

// Load địa chỉ ví
let depositAddresses = {};
try {
    const balanceModule = require('./balance.js');
    if (balanceModule && balanceModule.usdtDepositAddressesByNetwork) {
        depositAddresses = balanceModule.usdtDepositAddressesByNetwork;
    }
} catch (e) { console.log("⚠️ Không tìm thấy balance.js"); }

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function initExchange(exchangeId, config) {
    try {
        let exchangeClass;
        let options = { 'enableRateLimit': true };
        
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

// Helper: Quét chi tiết ví & Tính tổng
async function fetchWalletDetails(config) {
    const report = {
        totalUsdt: 0,
        binance: { spot: [], future: [], margin: [], total: 0 },
        kucoin: { spot: [], future: [], margin: [], total: 0 }
    };

    // --- BINANCE ---
    const binSpot = initExchange('binance', config);
    const binFut = initExchange('binanceusdm', config);

    if (binSpot) {
        try {
            const bal = await binSpot.fetchBalance();
            for (const [coin, amt] of Object.entries(bal.total)) {
                if (amt > 0) {
                    const price = await getPrice(binSpot, coin);
                    const value = amt * price;
                    if (value >= 1) {
                        report.binance.spot.push({ coin, amount: amt, value, price });
                        report.binance.total += value;
                    }
                }
            }
        } catch(e) {}
    }

    if (binFut) {
        try {
            const bal = await binFut.fetchBalance();
            const usdt = bal.total?.USDT || 0;
            if (usdt >= 1) {
                report.binance.future.push({ coin: 'USDT', amount: usdt, value: usdt, price: 1 });
                report.binance.total += usdt;
            }
        } catch(e) {}
    }

    // --- KUCOIN ---
    const kuSpot = initExchange('kucoin', config);
    const kuFut = initExchange('kucoinfutures', config);

    if (kuSpot) {
        try {
            const bal = await kuSpot.fetchBalance();
            for (const [coin, amt] of Object.entries(bal.total)) {
                if (amt > 0) {
                    const price = await getPrice(kuSpot, coin);
                    const value = amt * price;
                    if (value >= 1) {
                        report.kucoin.spot.push({ coin, amount: amt, value, price });
                        report.kucoin.total += value;
                    }
                }
            }
        } catch(e) {}
    }

    if (kuFut) {
        try {
            const bal = await kuFut.fetchBalance();
            const usdt = bal.total?.USDT || 0;
            if (usdt >= 1) {
                report.kucoin.future.push({ coin: 'USDT', amount: usdt, value: usdt, price: 1 });
                report.kucoin.total += usdt;
            }
        } catch(e) {}
    }

    report.totalUsdt = report.binance.total + report.kucoin.total;
    return report;
}

// API: Lấy danh sách user + PNL + Last Login
async function getAllUsersSummary() {
    if (!fs.existsSync(USER_DATA_DIR)) return [];
    const files = fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json'));
    
    const users = [];
    let index = 1;

    for (const file of files) {
        try {
            const filePath = path.join(USER_DATA_DIR, file);
            const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            
            // 1. Lấy thông tin file để biết Last Active
            const stats = fs.statSync(filePath);
            const lastLogin = stats.mtime; // Thời gian sửa file lần cuối

            // 2. Tính tổng PNL từ file history
            let totalPnl = 0;
            const histFile = file.replace('_config.json', '_history.json');
            const histPath = path.join(USER_DATA_DIR, histFile);
            if (fs.existsSync(histPath)) {
                try {
                    const history = JSON.parse(fs.readFileSync(histPath, 'utf8'));
                    if (Array.isArray(history)) {
                        totalPnl = history.reduce((sum, trade) => sum + (trade.actualPnl || 0), 0);
                    }
                } catch(e) {}
            }

            // 3. Quét tài sản
            const details = await fetchWalletDetails(config);
            const binFutVal = details.binance.future.reduce((sum, item) => sum + item.value, 0);
            const kuFutVal = details.kucoin.future.reduce((sum, item) => sum + item.value, 0);

            users.push({
                id: index++,
                username: config.username || file.replace('_config.json', ''),
                email: config.email || 'N/A',
                binanceFuture: binFutVal,
                kucoinFuture: kuFutVal,
                totalAll: details.totalUsdt,
                totalPnl: totalPnl,
                lastLogin: lastLogin,
                filename: file
            });
            
            await sleep(100); 

        } catch (e) { console.log(`Lỗi user ${file}:`, e.message); }
    }
    // Sort ở Frontend hoặc Backend đều được, ở đây backend trả raw
    return users;
}

// Logic Rút tiền đơn lẻ
async function transferOneWay(config, fromExName, toExName, coin, amount, sourceWallet, isGetAll, log) {
    const isFromBinance = fromExName === 'binance';
    const srcEx = initExchange(isFromBinance ? 'binance' : 'kucoin', config);
    const srcFut = initExchange(isFromBinance ? 'binanceusdm' : 'kucoinfutures', config);

    if (!srcEx) { log.push(`! [${fromExName}] Lỗi kết nối API`); return; }

    try {
        if (isGetAll) {
            log.push(`[${fromExName}] Thanh lý toàn bộ...`);
            if (srcFut) {
                try { await srcFut.cancelAllOrders(); } catch(e){}
                const pos = await srcFut.fetchPositions();
                for (const p of pos) {
                    if (parseFloat(p.contracts) > 0) {
                        const side = p.side === 'long' ? 'sell' : 'buy';
                        const params = isFromBinance ? {positionSide: p.side.toUpperCase()} : {reduceOnly:true};
                        try { await srcFut.createMarketOrder(p.symbol, side, p.contracts, undefined, params); } catch(e){}
                    }
                }
                await sleep(2000);
                const bal = await srcFut.fetchBalance();
                const av = bal.free.USDT || 0;
                if (av > 1) await srcFut.transfer('USDT', av, 'future', isFromBinance ? 'spot' : 'main');
            }
            const spotBal = await srcEx.fetchBalance();
            for(const [c, amt] of Object.entries(spotBal.free)) {
                if (c !== 'USDT' && amt > 0) {
                    try { await srcEx.createMarketSellOrder(`${c}/USDT`, amt); } catch(e){}
                }
            }
        } 
        else if (sourceWallet === 'future' || sourceWallet === 'both') {
            if (srcFut) {
                const bal = await srcFut.fetchBalance();
                const av = bal.free.USDT || 0;
                if (av > 1) {
                    await srcFut.transfer('USDT', av, 'future', isFromBinance ? 'spot' : 'main');
                    log.push(`[${fromExName}] Gom ${av.toFixed(2)}$ Fut->Spot`);
                }
            }
        }

        await sleep(1000);
        const spotBal = await srcEx.fetchBalance();
        const avail = spotBal.free[coin] || 0;
        let withdrawAmt = isGetAll ? avail : parseFloat(amount);
        if (withdrawAmt > avail) withdrawAmt = avail;

        if (withdrawAmt < 10) {
            log.push(`[${fromExName}] Số dư < 10$ (${withdrawAmt.toFixed(2)}), không rút.`);
            return;
        }

        let addr = '', net = '';
        if (toExName === 'binance') { 
            if (depositAddresses.binanceusdm?.APT) { addr = depositAddresses.binanceusdm.APT; net = 'APT'; }
            else if (depositAddresses.binance?.APT) { addr = depositAddresses.binance.APT; net = 'APT'; }
        } else { 
            if (depositAddresses.kucoinfutures?.BEP20) { addr = depositAddresses.kucoinfutures.BEP20; net = 'BSC'; }
            else if (depositAddresses.kucoin?.BEP20) { addr = depositAddresses.kucoin.BEP20; net = 'BSC'; }
        }

        if (!addr) { log.push(`[${fromExName}] ❌ Không có ví đích!`); return; }

        try {
            await srcEx.withdraw(coin, withdrawAmt, addr, undefined, { network: net });
            log.push(`[${fromExName}] ✅ Rút ${withdrawAmt.toFixed(2)} ${coin} -> ${toExName}`);
        } catch(e) { log.push(`[${fromExName}] ❌ Lỗi rút: ${e.message}`); }

    } catch (e) { log.push(`[${fromExName}] Lỗi: ${e.message}`); }
}

// API Main Transfer
async function processTransfer(reqData) {
    let { fromExchange, toExchange, sourceWallet, users, coin, amount, isGetAll } = reqData;
    if (isGetAll) coin = 'USDT'; 
    
    const results = [];
    let targetFiles = [];
    
    // Xử lý danh sách users (Mảng hoặc 'ALL')
    if (users === 'ALL') {
        targetFiles = fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json'));
    } else if (Array.isArray(users)) {
        targetFiles = users.map(u => `${u}_config.json`); // Giả định user gửi lên là safeName
    } else {
        targetFiles = [`${users}_config.json`];
    }

    for (const file of targetFiles) {
        // Check file tồn tại
        if (!fs.existsSync(path.join(USER_DATA_DIR, file))) continue;

        let log = [`User: ${file.replace('_config.json','')}`];
        try {
            const config = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, file), 'utf8'));
            if (fromExchange === 'both_ways') {
                log.push(">>> Rút chéo 2 chiều...");
                await Promise.all([
                    transferOneWay(config, 'binance', 'kucoin', coin, amount, sourceWallet, isGetAll, log),
                    transferOneWay(config, 'kucoin', 'binance', coin, amount, sourceWallet, isGetAll, log)
                ]);
            } else {
                await transferOneWay(config, fromExchange, toExchange, coin, amount, sourceWallet, isGetAll, log);
            }
        } catch (e) { log.push(`Lỗi file: ${e.message}`); }
        results.push(log);
    }
    return results;
}

// --- SERVER ---
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
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
        const config = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, filename), 'utf8'));
        const details = await fetchWalletDetails(config);
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
