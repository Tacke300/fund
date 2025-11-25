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
} catch (e) { console.log("⚠️ Không tìm thấy balance.js hoặc sai cấu trúc"); }

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

// Helper: Quét chi tiết ví
async function fetchWalletDetails(config) {
    const report = {
        totalUsdt: 0,
        binance: { spot: [], future: [], total: 0 },
        kucoin: { spot: [], future: [], total: 0 }
    };

    const binSpot = initExchange('binance', config);
    const binFut = initExchange('binanceusdm', config);

    if (binSpot) {
        try {
            const bal = await binSpot.fetchBalance();
            for (const [coin, amt] of Object.entries(bal.total)) {
                if (amt > 0 && coin !== 'USDT') {
                    const price = await getPrice(binSpot, coin);
                    const value = amt * price;
                    if (value > 0.5) report.binance.spot.push({ coin, amount: amt, value, price });
                } else if (coin === 'USDT' && amt > 0.5) {
                    report.binance.spot.push({ coin, amount: amt, value: amt, price: 1 });
                }
            }
            report.binance.total += report.binance.spot.reduce((a, b) => a + b.value, 0);
        } catch(e) {}
    }

    if (binFut) {
        try {
            const bal = await binFut.fetchBalance();
            const total = bal.total['USDT'] || 0;
            if (total > 0.5) {
                report.binance.future.push({ coin: 'USDT', amount: total, value: total, price: 1 });
                report.binance.total += total;
            }
        } catch(e) {}
    }

    const kuSpot = initExchange('kucoin', config);
    const kuFut = initExchange('kucoinfutures', config);

    if (kuSpot) {
        try {
            const bal = await kuSpot.fetchBalance();
            for (const [coin, amt] of Object.entries(bal.total)) {
                if (amt > 0 && coin !== 'USDT') {
                    const price = await getPrice(kuSpot, coin);
                    const value = amt * price;
                    if (value > 0.5) report.kucoin.spot.push({ coin, amount: amt, value, price });
                } else if (coin === 'USDT' && amt > 0.5) {
                    report.kucoin.spot.push({ coin, amount: amt, value: amt, price: 1 });
                }
            }
            report.kucoin.total += report.kucoin.spot.reduce((a, b) => a + b.value, 0);
        } catch(e) {}
    }

    if (kuFut) {
        try {
            const bal = await kuFut.fetchBalance();
            const total = bal.total['USDT'] || 0;
            if (total > 0.5) {
                report.kucoin.future.push({ coin: 'USDT', amount: total, value: total, price: 1 });
                report.kucoin.total += total;
            }
        } catch(e) {}
    }

    report.totalUsdt = report.binance.total + report.kucoin.total;
    return report;
}

// --- LOGIC RÚT TIỀN ---
async function transferOneWay(config, fromExName, toExName, coin, amountInput, sourceWallet, isGetAll, log) {
    const isFromBinance = fromExName === 'binance';
    const srcEx = initExchange(isFromBinance ? 'binance' : 'kucoin', config); 
    const srcFut = initExchange(isFromBinance ? 'binanceusdm' : 'kucoinfutures', config);

    if (!srcEx) { log.push(`❌ [${fromExName}] Lỗi kết nối API Spot`); return; }

    let amountRequest = parseFloat(amountInput) || 0;
    let transferPerformed = false;

    try {
        // 1. Future -> Spot
        if (sourceWallet === 'future' || sourceWallet === 'both') {
            if (srcFut) {
                try {
                    const balFut = await srcFut.fetchBalance();
                    const availableFuture = balFut.free.USDT || 0;
                    log.push(`[${fromExName}] Future Available: ${availableFuture.toFixed(2)}$`);

                    let amountToMove = 0;
                    if (isGetAll) {
                        log.push(`[${fromExName}] Đang đóng lệnh Future...`);
                        try { await srcFut.cancelAllOrders(); } catch(e){}
                        amountToMove = availableFuture; 
                    } else {
                        if (amountRequest > 0) amountToMove = (availableFuture < amountRequest) ? availableFuture : amountRequest;
                    }

                    if (amountToMove >= 0.5) {
                        await srcFut.transfer('USDT', amountToMove, 'future', isFromBinance ? 'spot' : 'main');
                        log.push(`✅ [${fromExName}] Đã chuyển ${amountToMove.toFixed(2)}$ Fut -> Spot`);
                        transferPerformed = true;
                    }
                } catch (err) { log.push(`⚠️ [${fromExName}] Lỗi chuyển Fut->Spot: ${err.message}`); }
            }
        }

        await sleep(transferPerformed ? 3000 : 500);

        let availSpot = 0;
        for (let i = 0; i < 3; i++) {
            const spotBal = await srcEx.fetchBalance();
            availSpot = spotBal.free[coin] || 0;
            if (isGetAll && availSpot > 0.5) break;
            if (!isGetAll && availSpot >= (amountRequest - 1)) break;
            if (transferPerformed) await sleep(1500); else break;
        }

        log.push(`[${fromExName}] Spot Available: ${availSpot.toFixed(4)} ${coin}`);

        let withdrawAmt = isGetAll ? availSpot : Math.min(availSpot, amountRequest);
        if (withdrawAmt < 1) { log.push(`❌ [${fromExName}] Số dư quá nhỏ (${withdrawAmt.toFixed(2)}). Hủy rút.`); return; }

        let addr = '', net = '';
        if (isFromBinance) {
            net = 'BSC'; 
            if (depositAddresses.kucoin?.BEP20) addr = depositAddresses.kucoin.BEP20;
            else if (depositAddresses.kucoinfutures?.BEP20) addr = depositAddresses.kucoinfutures.BEP20;
        } else {
            net = 'APT'; 
            if (depositAddresses.binance?.APT) addr = depositAddresses.binance.APT;
            else if (depositAddresses.binanceusdm?.APT) addr = depositAddresses.binanceusdm.APT;
        }

        if (!addr) { log.push(`❌ [${fromExName}] Thiếu địa chỉ ví đích trong balance.js!`); return; }

        log.push(`[${fromExName}] 🚀 Đang rút ${withdrawAmt.toFixed(2)} ${coin} -> ${addr} (${net})...`);
        withdrawAmt = Math.floor(withdrawAmt * 10000) / 10000;
        const result = await srcEx.withdraw(coin, withdrawAmt, addr, undefined, { network: net });
        log.push(`✅ [${fromExName}] Rút thành công! TX ID: ${result.id}`);

    } catch (e) { log.push(`❌ [${fromExName}] Lỗi khi rút: ${e.message}`); }
}

// 3. API Handlers
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

            // Ở bảng tổng quan, để nhanh thì chưa fetch balance thật (sẽ fetch khi bấm chi tiết hoặc dùng cache)
            // Hoặc trả về 0 để load nhanh
            users.push({
                id: index++,
                username: config.username || file.replace('_config.json', ''),
                email: config.email || 'N/A',
                vipStatus: config.vipStatus || 'none', // Thêm trường VIP
                totalAll: 0, // Placeholder
                totalPnl: totalPnl,
                lastLogin: stats.mtime,
                filename: file
            });
        } catch (e) {}
    }
    return users;
}

async function processTransfer(reqData) {
    let { fromExchange, toExchange, sourceWallet, users, coin, amount, isGetAll } = reqData;
    if (isGetAll) coin = 'USDT'; 
    
    const results = [];
    let targetFiles = [];
    
    if (users === 'ALL') {
        targetFiles = fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json'));
    } else if (Array.isArray(users)) {
        targetFiles = users.map(u => `${u}_config.json`);
    } else {
        targetFiles = [`${users}_config.json`];
    }

    for (const file of targetFiles) {
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
        const filename = req.url.split('/').pop();
        if(fs.existsSync(path.join(USER_DATA_DIR, filename))) {
            const config = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, filename), 'utf8'));
            const details = await fetchWalletDetails(config);
            res.end(JSON.stringify(details));
        } else { res.end(JSON.stringify({})); }
        return;
    }

    if (req.method === 'POST' && req.url === '/api/transfer') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const logs = await processTransfer(data);
                res.end(JSON.stringify({ logs }));
            } catch(e) { res.end(JSON.stringify({ logs: [['Error parsing JSON']] })); }
        });
        return;
    }

    // --- API MỚI: CẬP NHẬT VIP ---
    if (req.method === 'POST' && req.url === '/api/admin/set-vip') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { users, vipStatus } = JSON.parse(body);
                if (!users || !vipStatus) {
                    res.writeHead(400); res.end(JSON.stringify({ success: false })); return;
                }

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
            } catch(e) { res.writeHead(500); res.end(JSON.stringify({ success: false, error: e.message })); }
        });
        return;
    }
});

server.listen(PORT, () => {
    console.log(`Admin Bot running at http://localhost:${PORT}`);
});
