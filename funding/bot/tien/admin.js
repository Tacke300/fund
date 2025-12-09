const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 4953;
const USER_DATA_DIR = path.join(__dirname, 'user_data');
const ADMIN_CACHE_DIR = path.join(__dirname, 'admin_cache');

// --- LOAD VÍ ADMIN (BALANCE.JS) ---
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
    const opts = { enableRateLimit: true, timeout: 30000 };
    try {
        if (id === 'binance') return new ccxt.binance({ apiKey: config.binanceApiKey, secret: config.binanceApiSecret, ...opts });
        if (id === 'binanceusdm') return new ccxt.binanceusdm({ apiKey: config.binanceApiKey, secret: config.binanceApiSecret, ...opts });
        if (id === 'kucoin') return new ccxt.kucoin({ apiKey: config.kucoinApiKey, secret: config.kucoinApiSecret, password: config.kucoinPassword, ...opts });
        if (id === 'kucoinfutures') return new ccxt.kucoinfutures({ apiKey: config.kucoinApiKey, secret: config.kucoinApiSecret, password: config.kucoinPassword, ...opts });
    } catch (e) { return null; }
    return null;
}

// --- WORKER: QUÉT INCOME & HISTORY (CHỈ ĐỂ CẢI THIỆN LỊCH SỬ) ---
async function backgroundWorker() {
    console.log('[WORKER] 🔄 Đang quét lịch sử...');
    const files = fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json'));
    for (const file of files) {
        try {
            const config = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, file), 'utf8'));
            const safeName = getSafeName(config.username || file.replace('_config.json', ''));
            const cacheFile = path.join(ADMIN_CACHE_DIR, `${safeName}_income.json`);
            let incomeData = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : [];

            const bEx = initExchange('binanceusdm', config);
            if (bEx) {
                try {
                    const lastTime = incomeData.filter(x => x.ex === 'Binance').reduce((max, c) => Math.max(max, c.timestamp), 0);
                    const income = await bEx.fetchIncome(undefined, undefined, 1000, { startTime: lastTime + 1000 });
                    income.forEach(i => { if (!incomeData.some(h => h.id === i.id)) incomeData.push({ id: i.id, timestamp: i.timestamp, ex: 'Binance', symbol: i.symbol, type: i.info.incomeType, amount: parseFloat(i.amount) }); });
                } catch(e){}
            }
            const kEx = initExchange('kucoinfutures', config);
            if (kEx) {
                try {
                    const lastTime = incomeData.filter(x => x.ex === 'Kucoin').reduce((max, c) => Math.max(max, c.timestamp), 0);
                    const ledger = await kEx.fetchLedger(undefined, lastTime + 1000, 1000);
                    ledger.forEach(i => { if ((i.info.type === 'RealisedPNL' || i.info.type === 'Funding') && !incomeData.some(h => h.id === i.id)) incomeData.push({ id: i.id, timestamp: i.timestamp, ex: 'Kucoin', symbol: i.info.symbol || i.currency, type: i.info.type, amount: parseFloat(i.amount) }); });
                } catch(e){}
            }
            incomeData.sort((a,b) => b.timestamp - a.timestamp);
            fs.writeFileSync(cacheFile, JSON.stringify(incomeData, null, 2));
        } catch(e){}
        await sleep(500);
    }
}
backgroundWorker();
setInterval(backgroundWorker, 300000);

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

    if (req.url === '/api/users') {
        const users = [];
        fs.readdirSync(USER_DATA_DIR).filter(f => f.endsWith('_config.json')).forEach(f => {
            try {
                const c = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, f), 'utf8'));
                const safeName = getSafeName(c.username || f.replace('_config.json',''));
                
                // Lấy tổng PnL từ file history của bot (cho giống bản gốc)
                let totalPnl = 0;
                const hFile = path.join(USER_DATA_DIR, `${safeName}_history.json`);
                if(fs.existsSync(hFile)) {
                    const h = JSON.parse(fs.readFileSync(hFile,'utf8'));
                    totalPnl = h.reduce((s,i)=>s+(parseFloat(i.actualPnl)||0),0);
                }

                users.push({ 
                    username: c.username||safeName, 
                    vipStatus: c.vipStatus||'none', 
                    // Lấy số dư y hệt bản gốc (bot lưu sao hiện vậy)
                    binanceFuture: c.savedBinanceFut||0, 
                    kucoinFuture: c.savedKucoinFut||0, 
                    totalAll: c.savedTotalAssets||0, 
                    totalPnl: totalPnl 
                });
            } catch(e){}
        });
        sendJSON(users); return;
    }

    if (req.url.startsWith('/api/details/')) {
        const s = getSafeName(decodeURIComponent(req.url.split('/api/details/')[1]));
        const data = { activeTrades: [], botHistory: [], incomeHistory: [], balances: { binance: 0, kucoin: 0 } };
        try {
            // Live: Đọc active_trades của bot
            const aPath = path.join(USER_DATA_DIR, `${s}_active_trades.json`);
            if(fs.existsSync(aPath)) data.activeTrades = JSON.parse(fs.readFileSync(aPath, 'utf8'));
            
            // History: Đọc history của bot
            const hPath = path.join(USER_DATA_DIR, `${s}_history.json`);
            if(fs.existsSync(hPath)) data.botHistory = JSON.parse(fs.readFileSync(hPath, 'utf8'));
            
            // Income: Đọc từ Worker
            const iPath = path.join(ADMIN_CACHE_DIR, `${s}_income.json`);
            if(fs.existsSync(iPath)) data.incomeHistory = JSON.parse(fs.readFileSync(iPath, 'utf8'));

            // Balance: Đọc config
            const cPath = path.join(USER_DATA_DIR, `${s}_config.json`);
            if(fs.existsSync(cPath)) {
                const c = JSON.parse(fs.readFileSync(cPath, 'utf8'));
                data.balances = { binance: c.savedBinanceFut||0, kucoin: c.savedKucoinFut||0 };
            }
        } catch(e){}
        sendJSON(data); return;
    }

    // API CHUYỂN TIỀN VỀ VÍ ADMIN
    if (req.method === 'POST' && req.url === '/api/transfer') {
        let body = ''; req.on('data', c=>body+=c);
        req.on('end', async () => {
            const { direction, users, amount, isGetAll } = JSON.parse(body);
            const logs = [];
            const targets = (users === 'ALL') ? fs.readdirSync(USER_DATA_DIR).filter(f=>f.endsWith('_config.json')) : users.map(u => `${getSafeName(u)}_config.json`);
            
            let adminAddr = '';
            if (direction === 'binance_to_kucoin') adminAddr = adminWallets['kucoin']?.['BEP20'];
            else adminAddr = adminWallets['binance']?.['APTOS'] || adminWallets['binance']?.['APT'];

            if(!adminAddr) { sendJSON({ logs: ['❌ Chưa cấu hình ví Admin trong balance.js'] }); return; }

            for (const f of targets) {
                const p = path.join(USER_DATA_DIR, f); if(!fs.existsSync(p)) continue;
                const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
                let amt = parseFloat(amount);
                logs.push(`👤 ${cfg.username}:`);
                try {
                    if (direction === 'binance_to_kucoin') {
                        const bEx = initExchange('binance', cfg); const bFut = initExchange('binanceusdm', cfg);
                        if(isGetAll) { const b = await bFut.fetchBalance(); amt = b.free['USDT']||0; }
                        if(amt<2) continue;
                        await bFut.transfer('USDT', amt, 'future', 'spot');
                        await bEx.withdraw('USDT', amt, adminAddr, undefined, { network: 'BSC' });
                        logs.push(`  ✅ Rút ${amt}$ về Admin (BEP20)`);
                    } else {
                        const kEx = initExchange('kucoin', cfg); const kFut = initExchange('kucoinfutures', cfg);
                        if(isGetAll) { const b = await kFut.fetchBalance(); amt = b.free['USDT']||0; }
                        if(amt<2) continue;
                        await kFut.transfer('USDT', amt, 'future', 'main');
                        await kEx.withdraw('USDT', amt, adminAddr, undefined, { network: 'APT' });
                        logs.push(`  ✅ Rút ${amt}$ về Admin (APTOS)`);
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

server.listen(PORT, () => console.log(`Admin running http://localhost:${PORT}`));
