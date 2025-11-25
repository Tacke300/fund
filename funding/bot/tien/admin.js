const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

// [CONFIG]
const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

// Load địa chỉ ví từ file balance.js
let depositAddresses = {};
try {
    const balanceModule = require('./balance.js');
    if (balanceModule && balanceModule.usdtDepositAddressesByNetwork) {
        depositAddresses = balanceModule.usdtDepositAddressesByNetwork;
    }
} catch (e) { console.log("⚠️ Không tìm thấy balance.js"); }

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Init Exchange
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

// Helper: Lấy giá coin hiện tại (USDT)
async function getPrice(exchange, symbol) {
    try {
        if (symbol === 'USDT') return 1;
        const ticker = await exchange.fetchTicker(`${symbol}/USDT`);
        return ticker.last || 0;
    } catch (e) { return 0; }
}

// Helper: Quét chi tiết ví (Spot/Margin/Future/Earn)
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
            // 1. Spot & Margin & Earn (Binance trả chung trong fetchBalance nếu config đúng, hoặc cần endpoint riêng)
            // Ở đây dùng fetchBalance mặc định cho Spot/Flex
            const bal = await binSpot.fetchBalance();
            
            // Quét Spot Assets
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
            
            // Quét Margin (Nếu có) - CCXT Binance hỗ trợ type: 'margin'
            try {
                const marginBal = await binSpot.fetchBalance({ type: 'margin' });
                for (const [coin, amt] of Object.entries(marginBal.total)) {
                    if (amt > 0) {
                        const price = await getPrice(binSpot, coin);
                        // Margin Value = Asset - Liability (Nợ)
                        const debt = marginBal.debt ? (marginBal.debt[coin] || 0) : 0;
                        const netValue = (amt - debt) * price;
                        
                        if (Math.abs(netValue) >= 1) {
                            report.binance.margin.push({ coin, amount: amt, debt, value: netValue, price });
                            report.binance.total += netValue;
                        }
                    }
                }
            } catch(e) {}

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
            // Kucoin Margin check (Type: margin)
            try {
                const marginBal = await kuSpot.fetchBalance({ type: 'margin' });
                for (const [coin, amt] of Object.entries(marginBal.total)) {
                    if (amt > 0) {
                        const price = await getPrice(kuSpot, coin);
                        const debt = marginBal.debt ? (marginBal.debt[coin] || 0) : 0;
                        const netValue = (amt - debt) * price;
                        if (Math.abs(netValue) >= 1) {
                            report.kucoin.margin.push({ coin, amount: amt, debt, value: netValue, price });
                            report.kucoin.total += netValue;
                        }
                    }
                }
            } catch(e) {}

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

// --- API HANDLERS ---

// 1. Danh sách User (Có tổng tiền)
async function getAllUsersSummary() {
    if (!fs.existsSync(USER_DATA_DIR)) return [];
    const files = fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json'));
    
    const users = [];
    let index = 1;

    for (const file of files) {
        try {
            const config = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, file), 'utf8'));
            
            // Fetch nhanh số dư Futures (Spot tính sau vì lâu)
            let binFut = 0, kuFut = 0;
            try {
                const b = initExchange('binanceusdm', config);
                if (b) binFut = (await b.fetchBalance()).total?.USDT || 0;
            } catch(e){}
            try {
                const k = initExchange('kucoinfutures', config);
                if (k) kuFut = (await k.fetchBalance()).total?.USDT || 0;
            } catch(e){}

            users.push({
                id: index++,
                username: config.username || file.replace('_config.json', ''),
                email: config.email || 'N/A',
                binanceFuture: binFut,
                kucoinFuture: kuFut,
                // Tổng tạm tính (chỉ futures) để hiển thị nhanh bảng ngoài
                // Muốn tổng full phải bấm vào chi tiết vì fetch Spot rất lâu
                tempTotal: binFut + kuFut, 
                filename: file
            });
        } catch (e) {}
    }
    return users;
}

// 2. Logic Rút tiền đơn lẻ
async function transferOneWay(config, fromExName, toExName, coin, amount, sourceWallet, isGetAll, log) {
    const isFromBinance = fromExName === 'binance';
    const srcEx = initExchange(isFromBinance ? 'binance' : 'kucoin', config); // Spot
    const srcFut = initExchange(isFromBinance ? 'binanceusdm' : 'kucoinfutures', config); // Future

    if (!srcEx) { log.push(`! Lỗi kết nối ${fromExName}`); return; }

    try {
        // B1: Dọn dẹp Futures & Margin nếu GetAll
        if (isGetAll) {
            log.push(`[${fromExName}] Đang thanh lý toàn bộ...`);
            if (srcFut) {
                try { await srcFut.cancelAllOrders(); } catch(e){}
                // Close Positions (Giả lập logic close market)
                const pos = await srcFut.fetchPositions();
                for (const p of pos) {
                    if (parseFloat(p.contracts) > 0) {
                        const side = p.side === 'long' ? 'sell' : 'buy';
                        const params = isFromBinance ? {positionSide: p.side.toUpperCase()} : {reduceOnly:true};
                        try { await srcFut.createMarketOrder(p.symbol, side, p.contracts, undefined, params); } catch(e){}
                    }
                }
                await sleep(2000);
                // Move Future -> Spot
                const bal = await srcFut.fetchBalance();
                const av = bal.free.USDT || 0;
                if (av > 1) await srcFut.transfer('USDT', av, 'future', isFromBinance ? 'spot' : 'main');
            }
            // Bán Spot -> USDT
            const spotBal = await srcEx.fetchBalance();
            for(const [c, amt] of Object.entries(spotBal.free)) {
                if (c !== 'USDT' && amt > 0) {
                    try { await srcEx.createMarketSellOrder(`${c}/USDT`, amt); } catch(e){}
                }
            }
        } 
        // Nếu không GetAll nhưng chọn nguồn Future -> Gom về Spot
        else if (sourceWallet === 'future' || sourceWallet === 'both') {
            if (srcFut) {
                const bal = await srcFut.fetchBalance();
                const av = bal.free.USDT || 0;
                if (av > 1) {
                    await srcFut.transfer('USDT', av, 'future', isFromBinance ? 'spot' : 'main');
                    log.push(`[${fromExName}] Gom ${av.toFixed(2)}$ Future -> Spot`);
                }
            }
        }

        // B2: Thực hiện Rút
        await sleep(1000);
        const spotBal = await srcEx.fetchBalance();
        const avail = spotBal.free[coin] || 0;
        let withdrawAmt = isGetAll ? avail : parseFloat(amount);
        if (withdrawAmt > avail) withdrawAmt = avail;

        if (withdrawAmt < 10) {
            log.push(`[${fromExName}] Số dư không đủ rút (${withdrawAmt} < 10)`);
            return;
        }

        // Lấy địa chỉ đích
        let addr = '', net = '';
        if (toExName === 'binance') { // Rút về Binance (Aptos)
            if (depositAddresses.binanceusdm?.APT) { addr = depositAddresses.binanceusdm.APT; net = 'APT'; }
            else if (depositAddresses.binance?.APT) { addr = depositAddresses.binance.APT; net = 'APT'; }
        } else { // Rút về Kucoin (BEP20)
            if (depositAddresses.kucoinfutures?.BEP20) { addr = depositAddresses.kucoinfutures.BEP20; net = 'BSC'; }
            else if (depositAddresses.kucoin?.BEP20) { addr = depositAddresses.kucoin.BEP20; net = 'BSC'; }
        }

        if (!addr) { log.push(`[${fromExName}] ❌ Không thấy địa chỉ ví đích!`); return; }

        try {
            await srcEx.withdraw(coin, withdrawAmt, addr, undefined, { network: net });
            log.push(`[${fromExName}] ✅ Đã rút ${withdrawAmt} ${coin} -> ${toExName} (${net})`);
        } catch(e) { log.push(`[${fromExName}] ❌ Lỗi rút: ${e.message}`); }

    } catch (e) { log.push(`[${fromExName}] Lỗi xử lý: ${e.message}`); }
}

// 3. Xử lý Chuyển tiền (API Main)
async function processTransfer(reqData) {
    const { fromExchange, toExchange, sourceWallet, username, coin, amount, isGetAll } = reqData;
    // Nếu GetAll -> Ép coin là USDT
    const targetCoin = isGetAll ? 'USDT' : coin.toUpperCase();
    
    const results = [];
    let targetFiles = [];
    
    if (username === 'ALL') targetFiles = fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json'));
    else {
        const all = fs.readdirSync(USER_DATA_DIR);
        const found = all.find(f => f.includes(username)); // username gửi lên là safeName hoặc realName
        if(found) targetFiles = [found];
    }

    for (const file of targetFiles) {
        let log = [`User: ${file.replace('_config.json','')}`];
        try {
            const config = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, file), 'utf8'));
            
            if (fromExchange === 'both_ways') {
                // Chạy song song: Bin -> Ku VÀ Ku -> Bin
                log.push(">>> Chạy Rút chéo (2 chiều)...");
                await Promise.all([
                    transferOneWay(config, 'binance', 'kucoin', targetCoin, amount, sourceWallet, isGetAll, log),
                    transferOneWay(config, 'kucoin', 'binance', targetCoin, amount, sourceWallet, isGetAll, log)
                ]);
            } else {
                await transferOneWay(config, fromExchange, toExchange, targetCoin, amount, sourceWallet, isGetAll, log);
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
