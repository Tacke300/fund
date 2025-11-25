const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

// [CONFIG]
const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');

// Load địa chỉ ví từ file balance.js
// Cấu trúc mong đợi trong balance.js:
// module.exports.usdtDepositAddressesByNetwork = {
//    binance: { APT: '...', BEP20: '...' },
//    kucoin: { APT: '...', BEP20: '...' }
// }
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
        // Kucoin future ticker format có thể khác, try catch kỹ
        const ticker = await exchange.fetchTicker(`${symbol}/USDT`);
        return ticker.last || 0;
    } catch (e) { return 0; }
}

// Helper: Quét chi tiết ví (ĐÃ FIX LỖI LẪN LỘN SPOT/FUTURE)
async function fetchWalletDetails(config) {
    const report = {
        totalUsdt: 0,
        binance: { spot: [], future: [], total: 0 },
        kucoin: { spot: [], future: [], total: 0 }
    };

    // 1. BINANCE
    const binSpot = initExchange('binance', config);
    const binFut = initExchange('binanceusdm', config);

    // -> Binance Spot
    if (binSpot) {
        try {
            const bal = await binSpot.fetchBalance();
            // Lọc các coin có số dư > 0
            for (const [coin, amt] of Object.entries(bal.total)) {
                if (amt > 0 && coin !== 'USDT') {
                    const price = await getPrice(binSpot, coin);
                    const value = amt * price;
                    if (value > 0.5) report.binance.spot.push({ coin, amount: amt, value, price });
                } else if (coin === 'USDT' && amt > 0.5) {
                    report.binance.spot.push({ coin, amount: amt, value: amt, price: 1 });
                }
            }
            // Tính tổng Spot
            const spotUsdt = report.binance.spot.reduce((a, b) => a + b.value, 0);
            report.binance.total += spotUsdt;
        } catch(e) {}
    }

    // -> Binance Future
    if (binFut) {
        try {
            const bal = await binFut.fetchBalance();
            // Future thường chỉ quan tâm USDT
            const usdt = bal.free['USDT'] || 0; // Dùng 'free' hay 'total' tuỳ nhu cầu, thường rút thì tính free
            const total = bal.total['USDT'] || 0;
            
            if (total > 0.5) {
                report.binance.future.push({ coin: 'USDT', amount: total, value: total, price: 1 });
                report.binance.total += total;
            }
        } catch(e) {}
    }

    // 2. KUCOIN
    const kuSpot = initExchange('kucoin', config);
    const kuFut = initExchange('kucoinfutures', config);

    // -> Kucoin Spot
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
            const spotUsdt = report.kucoin.spot.reduce((a, b) => a + b.value, 0);
            report.kucoin.total += spotUsdt;
        } catch(e) {}
    }

    // -> Kucoin Future
    if (kuFut) {
        try {
            const bal = await kuFut.fetchBalance();
            // Kucoin Future return hơi khác, cẩn thận
            const usdt = bal.free['USDT'] || 0;
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

// --- LOGIC RÚT TIỀN (CORE) ---
async function transferOneWay(config, fromExName, toExName, coin, amountInput, sourceWallet, isGetAll, log) {
    const isFromBinance = fromExName === 'binance';
    
    // Khởi tạo Exchange
    const srcEx = initExchange(isFromBinance ? 'binance' : 'kucoin', config); // Spot
    const srcFut = initExchange(isFromBinance ? 'binanceusdm' : 'kucoinfutures', config); // Future

    if (!srcEx) { log.push(`❌ [${fromExName}] Lỗi kết nối API Spot`); return; }

    let amountRequest = parseFloat(amountInput) || 0;
    let transferPerformed = false;

    try {
        // =========================================================
        // BƯỚC 1: XỬ LÝ FUTURE -> SPOT (GOM TIỀN)
        // =========================================================
        if (sourceWallet === 'future' || sourceWallet === 'both') {
            if (srcFut) {
                try {
                    // Lấy số dư khả dụng bên Future
                    const balFut = await srcFut.fetchBalance();
                    const availableFuture = balFut.free.USDT || 0;

                    log.push(`[${fromExName}] Future Available: ${availableFuture.toFixed(2)}$`);

                    let amountToMove = 0;

                    if (isGetAll) {
                        // Nếu lấy hết: Đóng lệnh -> Chuyển hết
                        log.push(`[${fromExName}] Đang đóng lệnh Future...`);
                        try { await srcFut.cancelAllOrders(); } catch(e){}
                        // (Thêm logic đóng vị thế nếu cần thiết ở đây)
                        amountToMove = availableFuture; 
                    } else {
                        // Nếu lấy số cụ thể (VD: 2$)
                        // Logic: Nếu Future có ít hơn 2$, chuyển hết số đó. Nếu có nhiều hơn, chỉ chuyển 2$.
                        if (amountRequest > 0) {
                            amountToMove = (availableFuture < amountRequest) ? availableFuture : amountRequest;
                        }
                    }

                    // Thực hiện chuyển nội bộ nếu số tiền > 0.5$
                    if (amountToMove >= 0.5) {
                        await srcFut.transfer('USDT', amountToMove, 'future', isFromBinance ? 'spot' : 'main');
                        log.push(`✅ [${fromExName}] Đã chuyển ${amountToMove.toFixed(2)}$ Fut -> Spot`);
                        transferPerformed = true;
                    }
                } catch (err) {
                    log.push(`⚠️ [${fromExName}] Lỗi chuyển Fut->Spot: ${err.message}`);
                }
            }
        }

        // =========================================================
        // BƯỚC 2: CHỜ VÀ CHECK SỐ DƯ SPOT
        // =========================================================
        
        // Nếu vừa chuyển, chờ lâu hơn chút (3s), nếu không thì chờ 0.5s
        await sleep(transferPerformed ? 3000 : 500);

        let availSpot = 0;
        // Retry check 3 lần để đảm bảo tiền đã về ví
        for (let i = 0; i < 3; i++) {
            const spotBal = await srcEx.fetchBalance();
            availSpot = spotBal.free[coin] || 0;
            
            // Điều kiện thoát vòng lặp:
            // 1. Nếu là GetAll: Có tiền > 0.5 là OK
            // 2. Nếu rút số cụ thể: Có tiền >= số yêu cầu (hoặc gần đủ)
            if (isGetAll && availSpot > 0.5) break;
            if (!isGetAll && availSpot >= (amountRequest - 1)) break; // Cho phép sai số 1$ ở bước check

            if (transferPerformed) {
                log.push(`...Đang chờ tiền về Spot (Attempt ${i+1})...`);
                await sleep(1500);
            } else {
                break; // Không chuyển gì thì không cần chờ
            }
        }

        log.push(`[${fromExName}] Spot Available: ${availSpot.toFixed(4)} ${coin}`);

        // =========================================================
        // BƯỚC 3: TÍNH TOÁN SỐ TIỀN RÚT (CHẤP NHẬN SAI SỐ)
        // =========================================================
        let withdrawAmt = 0;

        if (isGetAll) {
            withdrawAmt = availSpot;
        } else {
            // Logic chấp nhận thiếu 1 chút:
            // Ví dụ: Muốn rút 2$, nhưng ví chỉ có 1.5$ -> Rút 1.5$ luôn.
            // Ví dụ: Muốn rút 2$, ví có 10$ -> Rút 2$.
            withdrawAmt = Math.min(availSpot, amountRequest);
            
            // Nếu số tiền thực có < số yêu cầu quá nhiều (VD yêu cầu 100$ mà có 2$) -> Cảnh báo
            if (withdrawAmt < amountRequest) {
                log.push(`⚠️ Yêu cầu ${amountRequest}$, chỉ có ${withdrawAmt.toFixed(2)}$. Sẽ rút tối đa có thể.`);
            }
        }

        // Min rút
        if (withdrawAmt < 1) { 
            log.push(`❌ [${fromExName}] Số dư quá nhỏ (${withdrawAmt.toFixed(2)} < 1$). Hủy rút.`);
            return;
        }

        // =========================================================
        // BƯỚC 4: XÁC ĐỊNH MẠNG LƯỚI & ĐỊA CHỈ (THEO YÊU CẦU MỚI)
        // =========================================================
        // Yêu cầu: "Kucoin rút = aptos. Binance rút bằng bep20."
        
        let addr = '', net = '';

        if (isFromBinance) {
            // Sender: Binance -> Dùng BSC (BEP20)
            // Receiver: Kucoin -> Cần lấy địa chỉ BEP20 của Kucoin
            net = 'BSC'; // Mã mạng BSC trên Binance
            if (depositAddresses.kucoin?.BEP20) {
                addr = depositAddresses.kucoin.BEP20;
            } else if (depositAddresses.kucoinfutures?.BEP20) {
                addr = depositAddresses.kucoinfutures.BEP20;
            }
            log.push(`[Config] Binance -> Kucoin qua mạng BSC (BEP20)`);
        } else {
            // Sender: Kucoin -> Dùng APT (Aptos)
            // Receiver: Binance -> Cần lấy địa chỉ APT của Binance
            net = 'APT'; // Mã mạng Aptos trên Kucoin
            if (depositAddresses.binance?.APT) {
                addr = depositAddresses.binance.APT;
            } else if (depositAddresses.binanceusdm?.APT) {
                addr = depositAddresses.binanceusdm.APT;
            }
            log.push(`[Config] Kucoin -> Binance qua mạng APT (Aptos)`);
        }

        if (!addr) {
            log.push(`❌ [${fromExName}] Không tìm thấy địa chỉ ví đích phù hợp trong file balance.js!`);
            log.push(`   - Nếu từ Binance: Cần Kucoin BEP20`);
            log.push(`   - Nếu từ Kucoin: Cần Binance APT`);
            return;
        }

        // =========================================================
        // BƯỚC 5: THỰC HIỆN RÚT
        // =========================================================
        log.push(`[${fromExName}] 🚀 Đang rút ${withdrawAmt.toFixed(2)} ${coin} -> ${addr} (${net})...`);

        const params = { network: net };
        
        // Fix lỗi sai số precision (làm tròn 4 số thập phân an toàn)
        withdrawAmt = Math.floor(withdrawAmt * 10000) / 10000;

        const result = await srcEx.withdraw(coin, withdrawAmt, addr, undefined, params);
        log.push(`✅ [${fromExName}] Rút thành công! TX ID: ${result.id}`);

    } catch (e) {
        log.push(`❌ [${fromExName}] Lỗi khi rút: ${e.message}`);
        // Log thêm nếu lỗi insufficient balance để debug
        if (e.message.includes('Insufficient funds')) {
             log.push(`   -> Gợi ý: Kiểm tra lại phí rút mạng ${fromExName === 'binance' ? 'BSC' : 'APT'}.`);
        }
    }
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
            const lastLogin = stats.mtime;

            const details = await fetchWalletDetails(config);
            
            // Tính PnL nếu có file history
            let totalPnl = 0;
            const histFile = file.replace('_config.json', '_history.json');
            if (fs.existsSync(path.join(USER_DATA_DIR, histFile))) {
                try {
                    const history = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, histFile), 'utf8'));
                    if (Array.isArray(history)) totalPnl = history.reduce((sum, trade) => sum + (trade.actualPnl || 0), 0);
                } catch(e) {}
            }

            users.push({
                id: index++,
                username: config.username || file.replace('_config.json', ''),
                email: config.email || 'N/A',
                binanceFuture: details.binance.future.reduce((s, i) => s + i.value, 0),
                kucoinFuture: details.kucoin.future.reduce((s, i) => s + i.value, 0),
                totalAll: details.totalUsdt,
                totalPnl: totalPnl,
                lastLogin: lastLogin,
                filename: file
            });
            await sleep(50); 
        } catch (e) { console.log(`Lỗi user ${file}:`, e.message); }
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
        } else {
            res.end(JSON.stringify({}));
        }
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
});

server.listen(PORT, () => {
    console.log(`Admin Bot running at http://localhost:${PORT}`);
});
