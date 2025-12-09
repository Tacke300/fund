const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');
const ADMIN_CACHE_DIR = path.join(__dirname, 'admin_cache');

// LOAD VÍ ADMIN
let adminWallets = {};
try {
    const p1 = path.join(__dirname, '../../balance.js');
    if (fs.existsSync(p1)) adminWallets = require(p1).usdtDepositAddressesByNetwork || {};
    else {
        const p2 = path.join(__dirname, 'balance.js');
        if (fs.existsSync(p2)) adminWallets = require(p2).usdtDepositAddressesByNetwork || {};
    }
} catch (e) {}

if (!fs.existsSync(ADMIN_CACHE_DIR)) fs.mkdirSync(ADMIN_CACHE_DIR);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const getSafeName = (u) => u.replace(/[^a-z0-9]/gi, '_').toLowerCase();

function initExchange(id, config) {
    const opts = { enableRateLimit: true, timeout: 20000 };
    try {
        if (id === 'binanceusdm') return new ccxt.binanceusdm({ apiKey: config.binanceApiKey, secret: config.binanceApiSecret, ...opts });
        if (id === 'kucoinfutures') return new ccxt.kucoinfutures({ apiKey: config.kucoinApiKey, secret: config.kucoinApiSecret, password: config.kucoinPassword, ...opts });
        // Spot client cho withdraw
        if (id === 'binance') return new ccxt.binance({ apiKey: config.binanceApiKey, secret: config.binanceApiSecret, ...opts });
        if (id === 'kucoin') return new ccxt.kucoin({ apiKey: config.kucoinApiKey, secret: config.kucoinApiSecret, password: config.kucoinPassword, ...opts });
    } catch (e) { return null; }
    return null;
}

// --- WORKER: CHỈ QUÉT INCOME ĐỂ HIỆN PNL TỔNG NGOÀI DANH SÁCH (KHÔNG ẢNH HƯỞNG CHI TIẾT) ---
async function backgroundWorker() {
    const files = fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json'));
    for (const file of files) {
        try {
            const config = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, file), 'utf8'));
            const safeName = getSafeName(config.username || file.replace('_config.json', ''));
            const cacheFile = path.join(ADMIN_CACHE_DIR, `${safeName}_pnl_summary.json`);
            
            // Chỉ cần lấy tổng PnL để hiện ngoài bảng user, chi tiết sẽ load realtime
            const bEx = initExchange('binanceusdm', config);
            let totalPnl = 0;
            if (bEx) {
                const income = await bEx.fetchIncome(undefined, undefined, 1000); // Lấy 1000 gd gần nhất
                totalPnl = income.filter(i => i.info.incomeType === 'REALIZED_PNL').reduce((sum, i) => sum + parseFloat(i.amount), 0);
            }
            fs.writeFileSync(cacheFile, JSON.stringify({ totalPnl }));
        } catch(e){}
        await sleep(1000);
    }
}
backgroundWorker();
setInterval(backgroundWorker, 600000); // 10p quét 1 lần cho nhẹ

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const sendJSON = (d) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };

    if (req.method === 'GET' && req.url === '/') {
        fs.readFile(path.join(__dirname, 'admin.html'), (err, c) => {
            if(err) { res.writeHead(404); res.end('Missing HTML'); return; }
            res.writeHead(200, {'Content-Type': 'text/html'}); res.end(c);
        });
        return;
    }

    // LIST USERS
    if (req.url === '/api/users') {
        const users = [];
        fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json')).forEach(f => {
            try {
                const c = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, f), 'utf8'));
                const safeName = getSafeName(c.username || f.replace('_config.json',''));
                
                // PnL tổng lấy từ cache worker cho nhanh
                let pnl = 0;
                const cPath = path.join(ADMIN_CACHE_DIR, `${safeName}_pnl_summary.json`);
                if(fs.existsSync(cPath)) pnl = JSON.parse(fs.readFileSync(cPath,'utf8')).totalPnl;

                users.push({ 
                    username: c.username||safeName, vipStatus: c.vipStatus||'none', 
                    binanceFuture: c.savedBinanceFut||0, kucoinFuture: c.savedKucoinFut||0, 
                    totalAll: c.savedTotalAssets||0, totalPnl: pnl 
                });
            } catch(e){}
        });
        sendJSON(users); return;
    }

    // --- API DETAILS: REAL-TIME FETCHING (THEO YÊU CẦU) ---
    if (req.url.startsWith('/api/details/')) {
        const s = getSafeName(decodeURIComponent(req.url.split('/api/details/')[1]));
        const cPath = path.join(USER_DATA_DIR, `${s}_config.json`);
        
        if(!fs.existsSync(cPath)) { sendJSON({error: 'User not found'}); return; }
        const config = JSON.parse(fs.readFileSync(cPath, 'utf8'));

        const data = { balances: { binance: 0, kucoin: 0 }, activeTrades: [], history: [] };
        
        try {
            const bEx = initExchange('binanceusdm', config);
            const kEx = initExchange('kucoinfutures', config);

            // 1. FETCH BALANCE & POSITIONS (LIVE - REALTIME)
            const tasks = [];
            if(bEx) tasks.push(bEx.fetchBalance(), bEx.fetchPositions()); else tasks.push({}, []);
            if(kEx) tasks.push(kEx.fetchBalance(), kEx.fetchPositions()); else tasks.push({}, []);
            
            const [bBal, bPos, kBal, kPos] = await Promise.all(tasks);

            data.balances.binance = bBal.total?.USDT || 0;
            data.balances.kucoin = kBal.total?.USDT || 0;

            // Xử lý Live Position
            const mapPos = (p, ex) => {
                const size = parseFloat(p.contracts || p.info.positionAmt || 0);
                if(size === 0) return null;
                const side = size > 0 ? 'LONG' : 'SHORT';
                return {
                    ex, 
                    symbol: p.symbol, 
                    side, 
                    size: Math.abs(size), 
                    margin: p.initialMargin || p.collateral || 0,
                    lev: p.leverage,
                    entryPrice: p.entryPrice,
                    pnl: p.unrealizedPnl,
                    entryTime: p.timestamp // Một số sàn trả về timestamp mở lệnh
                };
            };

            const liveBinance = (Array.isArray(bPos) ? bPos : []).map(p => mapPos(p, 'Binance')).filter(x=>x);
            const liveKucoin = (Array.isArray(kPos) ? kPos : []).map(p => mapPos(p, 'Kucoin')).filter(x=>x);
            data.activeTrades = [...liveBinance, ...liveKucoin];

            // 2. FETCH HISTORY (REAL-TIME NHƯNG THÔNG MINH)
            // Lấy danh sách coin vừa trade từ Income để tránh fetch hết sàn
            let activeSymbols = new Set();
            if (bEx) {
                const income = await bEx.fetchIncome(undefined, undefined, 50); // Lấy 50 gd income gần nhất
                income.forEach(i => activeSymbols.add(i.symbol));
            }
            // Thêm symbol đang mở lệnh vào danh sách cần quét
            data.activeTrades.forEach(t => activeSymbols.add(t.symbol));

            const historyTasks = [];
            // Binance: Fetch Closed Orders cho các symbol active
            if(bEx) {
                for(let sym of activeSymbols) {
                    if(!sym) continue;
                    historyTasks.push(bEx.fetchClosedOrders(sym, undefined, 5).catch(()=>[]));
                }
            }
            // Kucoin: Fetch Closed Orders (thường support fetch all hoặc theo symbol)
            if(kEx) {
                historyTasks.push(kEx.fetchClosedOrders(undefined, undefined, 20).catch(()=>[]));
            }

            const rawHist = (await Promise.all(historyTasks)).flat();
            
            // Format lại dữ liệu lịch sử chuẩn sàn
            data.history = rawHist.map(h => ({
                openTime: h.timestamp, // Time Open
                closeTime: h.info.updateTime || h.lastTradeTimestamp || Date.now(), // Time Close (ước lượng nếu ko có)
                symbol: h.symbol,
                side: h.side,
                price: h.price || h.average,
                amount: h.amount,
                cost: h.cost,
                ex: h.info.symbol ? 'Binance' : 'Kucoin', // Check đặc thù object để đoán sàn
                status: h.status
            })).sort((a,b) => b.closeTime - a.closeTime).slice(0, 50); // Lấy 50 lệnh mới nhất

        } catch(e) { console.log('Err Detail:', e.message); }

        sendJSON(data); return;
    }

    // --- API CHUYỂN TIỀN (REAL) ---
    if (req.method === 'POST' && req.url === '/api/transfer') {
        let body = ''; req.on('data', c=>body+=c);
        req.on('end', async () => {
            const { direction, users, amount, isGetAll } = JSON.parse(body);
            const logs = [];
            const targets = (users === 'ALL') ? fs.readdirSync(USER_DATA_DIR).filter(f=>f.endsWith('_config.json')) : users.map(u => `${getSafeName(u)}_config.json`);
            
            let adminAddr = '';
            if (direction === 'binance_to_kucoin') adminAddr = adminWallets['kucoin']?.['BEP20'];
            else adminAddr = adminWallets['binance']?.['APTOS'] || adminWallets['binance']?.['APT'];

            if(!adminAddr) { sendJSON({ logs: ['❌ Thiếu ví Admin trong balance.js'] }); return; }

            for (const f of targets) {
                const p = path.join(USER_DATA_DIR, f); if(!fs.existsSync(p)) continue;
                const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
                let amt = parseFloat(amount);
                logs.push(`👤 ${cfg.username}:`);
                try {
                    if (direction === 'binance_to_kucoin') {
                        const bEx = initExchange('binance', cfg); const bFut = initExchange('binanceusdm', cfg);
                        if(isGetAll) { const b = await bFut.fetchBalance(); amt = b.free['USDT']||0; }
                        if(amt<1) continue;
                        await bFut.transfer('USDT', amt, 'future', 'spot');
                        await bEx.withdraw('USDT', amt, adminAddr, undefined, { network: 'BSC' });
                        logs.push(`  ✅ Rút ${amt}$ (BSC) OK`);
                    } else {
                        const kEx = initExchange('kucoin', cfg); const kFut = initExchange('kucoinfutures', cfg);
                        if(isGetAll) { const b = await kFut.fetchBalance(); amt = b.free['USDT']||0; }
                        if(amt<1) continue;
                        await kFut.transfer('USDT', amt, 'future', 'main');
                        await kEx.withdraw('USDT', amt, adminAddr, undefined, { network: 'APT' });
                        logs.push(`  ✅ Rút ${amt}$ (APT) OK`);
                    }
                } catch(e) { logs.push(`  ❌ ${e.message}`); }
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
                if(fs.existsSync(p)) { const c = JSON.parse(fs.readFileSync(p,'utf8')); c.vipStatus = vipStatus; c.vipExpiry = (vipStatus==='vip')?Date.now()+2592000000:0; fs.writeFileSync(p, JSON.stringify(c,null,2)); }
            });
            sendJSON({ success: true });
        });
        return;
    }
});

server.listen(PORT, () => console.log(`Admin Realtime running http://localhost:${PORT}`));
