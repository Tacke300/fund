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

// Helper: Quét chi tiết ví (Dùng cho API detail)
async function fetchWalletDetails(config) {
    const report = {
        totalUsdt: 0,
        binance: { spot: [], future: [], total: 0 },
        kucoin: { spot: [], future: [], total: 0 }
    };
    // ... (Giữ nguyên code quét chi tiết cũ nếu bạn cần, hoặc rút gọn)
    // Để ngắn gọn tôi lược bỏ phần quét chi tiết ở đây vì API này chủ yếu dùng cho nút "Chi tiết"
    // Bạn có thể giữ lại code cũ của hàm này.
    return report; 
}

// --- LOGIC RÚT TIỀN (GIỮ NGUYÊN) ---
async function transferOneWay(config, fromExName, toExName, coin, amountInput, sourceWallet, isGetAll, log) {
    // ... (Giữ nguyên logic transfer của bạn)
    // Tôi để trống phần này để tập trung vào phần hiển thị danh sách người dùng
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

            // ĐỌC DỮ LIỆU SNAPSHOT TỪ CONFIG
            const binanceFut = config.savedBinanceFut || 0;
            const kucoinFut = config.savedKucoinFut || 0;
            const totalAssets = config.savedTotalAssets || 0;

            users.push({
                id: index++,
                username: config.username || file.replace('_config.json', ''),
                email: config.email || 'N/A',
                vipStatus: config.vipStatus || 'none',
                binanceFuture: binanceFut, // Dữ liệu đã lưu
                kucoinFuture: kucoinFut,   // Dữ liệu đã lưu
                totalAll: totalAssets,     // Dữ liệu đã lưu
                totalPnl: totalPnl,
                lastLogin: stats.mtime,
                filename: file
            });
        } catch (e) {}
    }
    return users;
}

async function processTransfer(reqData) {
    // ... (Giữ nguyên logic transfer)
    return [['Transfer Logic Skipped in this snippet']];
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

    // API USER MỚI (ĐÃ CẬP NHẬT ĐỂ ĐỌC SNAPSHOT)
    if (req.url === '/api/users') {
        const users = await getAllUsersSummary();
        res.end(JSON.stringify(users));
        return;
    }

    if (req.url.startsWith('/api/details/')) {
        // ... (Giữ nguyên)
        res.end(JSON.stringify({}));
        return;
    }

    if (req.method === 'POST' && req.url === '/api/transfer') {
        // ... (Giữ nguyên)
        res.end(JSON.stringify({ logs: [] }));
        return;
    }

    // API SET VIP
    if (req.method === 'POST' && req.url === '/api/admin/set-vip') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { users, vipStatus } = JSON.parse(body);
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
            } catch(e) { res.writeHead(500); res.end(JSON.stringify({ success: false })); }
        });
        return;
    }
});

server.listen(PORT, () => {
    console.log(`Admin Bot running at http://localhost:${PORT}`);
});
