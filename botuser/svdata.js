const express = require('express');
const path = require('path');
const cors = require('cors');
const ccxt = require('ccxt');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const port = 3000;
const DB_FILE = 'user.db';
const ADMIN_SECRET_KEY = 'huyen';

const SERVER_DATA_URL = 'http://35.240.146.86:5005/api/data';
const MIN_PNL_PERCENTAGE = 1;
const DATA_FETCH_INTERVAL_SECONDS = 2;
const MIN_COLLATERAL_FOR_TRADE = 1;
const TP_SL_PNL_PERCENTAGE = 150;

let activeBotInstance = {
    username: null, userData: null, marginOptions: null,
    botState: 'STOPPED', capitalManagementState: 'IDLE', botLoopIntervalId: null,
    balances: {}, tradeHistory: [], currentTradeDetails: null, tradeAwaitingPnl: null,
    hasLoggedNotFoundThisHour: false, exchanges: {}
};

const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) return console.error(err.message);
    console.log('Connected to the SQLite database.');
    const tableSchema = `
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
            is_vip INTEGER DEFAULT 0, vip_level TEXT, vip_expiry_timestamp INTEGER, pnl REAL DEFAULT 0,
            binance_apikey TEXT, binance_secret TEXT,
            bitget_apikey TEXT, bitget_secret TEXT, bitget_password TEXT,
            kucoin_apikey TEXT, kucoin_secret TEXT, kucoin_password TEXT,
            binance_bep20 TEXT, binance_aptos TEXT,
            bitget_bep20 TEXT, bitget_aptos TEXT,
            kucoin_aptos TEXT
        )`;
    db.run(tableSchema);
});

const safeLog = (type, ...args) => {
    const user = activeBotInstance.username ? `[${activeBotInstance.username}]` : '';
    const timestamp = new Date().toLocaleTimeString('vi-VN');
    const message = args.map(arg => (arg instanceof Error) ? (arg.stack || arg.message) : (typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg)).join(' ');
    console[type](`[${timestamp}]${user}`, message);
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function initializeExchangesForUser(userData) {
    const userExchanges = {};
    const exchangeConfigs = [
        { id: 'binanceusdm', apiKey: userData.binance_apikey, secret: userData.binance_secret, options: { 'defaultType': 'swap' } },
        { id: 'bitget', apiKey: userData.bitget_apikey, secret: userData.bitget_secret, password: userData.bitget_password, options: { 'defaultType': 'swap' } },
        { id: 'kucoinfutures', apiKey: userData.kucoin_apikey, secret: userData.kucoin_secret, password: userData.kucoin_password },
    ];
    for (const config of exchangeConfigs) {
        if (config.apiKey && config.secret) {
            try {
                userExchanges[config.id] = new ccxt[config.id]({ apiKey: config.apiKey, secret: config.secret, password: config.password, enableRateLimit: true, ...config.options });
                await userExchanges[config.id].loadMarkets();
                safeLog('info', `Khởi tạo sàn ${config.id.toUpperCase()} thành công.`);
            } catch (e) {
                safeLog('error', `Lỗi khi khởi tạo sàn ${config.id}:`, e.message);
            }
        }
    }
    return userExchanges;
}

async function fetchAllBalances() {
    for (const id in activeBotInstance.exchanges) {
        try {
            const balanceData = await activeBotInstance.exchanges[id].fetchBalance({ 'type': 'swap' });
            activeBotInstance.balances[id] = { available: balanceData?.free?.USDT || 0, total: balanceData?.total?.USDT || 0 };
        } catch (e) {
            safeLog('warn', `Không thể lấy số dư từ ${id}: ${e.message}`);
        }
    }
}

async function getExchangeSpecificSymbol(exchange, rawCoinSymbol) {
    const base = String(rawCoinSymbol).toUpperCase().replace(/USDT$/, '');
    const attempts = [`${base}/USDT:USDT`, `${base}USDT`, `${base}-USDT-SWAP`];
    for (const attempt of attempts) {
        if (exchange.markets[attempt]?.active) return exchange.markets[attempt].id;
    }
    return null;
}

async function setLeverageSafely(exchange, symbol, desiredLeverage) {
    try {
        await exchange.setLeverage(desiredLeverage, symbol, (exchange.id === 'kucoinfutures' ? { 'marginMode': 'cross' } : {}));
        return desiredLeverage;
    } catch (e) {
        safeLog('error', `Không thể đặt đòn bẩy x${desiredLeverage} cho ${symbol} trên ${exchange.id}. Lỗi: ${e.message}`);
        return null;
    }
}

async function computeOrderDetails(exchange, symbol, targetNotionalUSDT, leverage, availableBalance) {
    const market = exchange.market(symbol);
    const ticker = await exchange.fetchTicker(symbol);
    const price = ticker?.last || ticker?.close;
    if (!price) throw new Error(`Không lấy được giá cho ${symbol} trên ${exchange.id}`);
    
    let amount = parseFloat(exchange.amountToPrecision(symbol, targetNotionalUSDT / price));
    let currentNotional = amount * price;

    if (currentNotional / leverage > availableBalance * 0.98) {
        amount = parseFloat(exchange.amountToPrecision(symbol, (availableBalance * 0.98 * leverage) / price));
        currentNotional = amount * price;
    }

    if (amount <= (market.limits.amount.min || 0)) throw new Error(`Số lượng (${amount}) nhỏ hơn mức tối thiểu của sàn.`);
    return { amount, price, notional: currentNotional };
}

async function placeTpSlOrders(exchange, symbol, side, amount, entryPrice, collateral, notionalValue) {
    if (!entryPrice || notionalValue <= 0) return;
    const pnlAmount = collateral * (TP_SL_PNL_PERCENTAGE / 100);
    const priceChange = (pnlAmount / notionalValue) * entryPrice;
    const tpPrice = side === 'sell' ? entryPrice - priceChange : entryPrice + priceChange;
    const slPrice = side === 'sell' ? entryPrice + priceChange : entryPrice - priceChange;
    const orderSide = (side === 'sell') ? 'buy' : 'sell';

    try {
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', orderSide, amount, undefined, { 'stopPrice': exchange.priceToPrecision(symbol, tpPrice), 'reduceOnly': true });
        await exchange.createOrder(symbol, 'STOP_MARKET', orderSide, amount, undefined, { 'stopPrice': exchange.priceToPrecision(symbol, slPrice), 'reduceOnly': true });
    } catch (e) {
        safeLog('error', `Lỗi khi đặt lệnh TP/SL cho ${symbol} trên ${exchange.id}:`, e);
    }
}

async function executeTrades(opportunity) {
    const { coin, commonLeverage: desiredLeverage } = opportunity;
    const [shortExIdRaw, longExIdRaw] = opportunity.exchanges.split(' / ');
    const shortExId = shortExIdRaw.toLowerCase().trim().replace('usdm','').replace('futures','') === 'binance' ? 'binanceusdm' : shortExIdRaw.toLowerCase().trim().replace('usdm','').replace('futures','');
    const longExId = longExIdRaw.toLowerCase().trim().replace('usdm','').replace('futures','') === 'binance' ? 'binanceusdm' : longExIdRaw.toLowerCase().trim().replace('usdm','').replace('futures','');

    await fetchAllBalances();
    const shortEx = activeBotInstance.exchanges[shortExId];
    const longEx = activeBotInstance.exchanges[longExId];
    if (!shortEx || !longEx) {
        safeLog('error', `Sàn không hợp lệ hoặc chưa được cấu hình API: ${shortExId}, ${longExId}`);
        return false;
    }

    const shortBalance = activeBotInstance.balances[shortExId]?.available || 0;
    const longBalance = activeBotInstance.balances[longExId]?.available || 0;
    const minBalance = Math.min(shortBalance, longBalance);
    
    let collateral;
    if (activeBotInstance.marginOptions.type === 'percent') {
        collateral = minBalance * (parseFloat(activeBotInstance.marginOptions.value) / 100);
    } else {
        collateral = Math.min(minBalance, parseFloat(activeBotInstance.marginOptions.value));
    }

    if (collateral < MIN_COLLATERAL_FOR_TRADE) {
        safeLog('warn', `Vốn không đủ để giao dịch.`);
        activeBotInstance.capitalManagementState = 'IDLE';
        return false;
    }

    safeLog('info', `Bắt đầu vào lệnh cho ${coin} với ký quỹ ${collateral.toFixed(2)} USDT.`);
    activeBotInstance.capitalManagementState = 'TRADE_OPEN';

    try {
        const shortSymbol = await getExchangeSpecificSymbol(shortEx, coin);
        const longSymbol = await getExchangeSpecificSymbol(longEx, coin);
        if (!shortSymbol || !longSymbol) throw new Error(`Không tìm thấy symbol cho ${coin}`);

        await Promise.all([ setLeverageSafely(shortEx, shortSymbol, desiredLeverage), setLeverageSafely(longEx, longSymbol, desiredLeverage) ]);

        const targetNotional = collateral * desiredLeverage;
        const [shortOrderDetails, longOrderDetails] = await Promise.all([
            computeOrderDetails(shortEx, shortSymbol, targetNotional, desiredLeverage, shortBalance),
            computeOrderDetails(longEx, longSymbol, targetNotional, desiredLeverage, longBalance)
        ]);
        
        await Promise.all([
            shortEx.createMarketSellOrder(shortSymbol, shortOrderDetails.amount),
            longEx.createMarketBuyOrder(longSymbol, longOrderDetails.amount)
        ]);

        activeBotInstance.currentTradeDetails = {
            coin, shortExchange: shortExId, longExchange: longExId,
            shortOrderAmount: shortOrderDetails.amount, longOrderAmount: longOrderDetails.amount,
            shortSymbol, longSymbol, collateralUsed: collateral, status: 'OPEN',
            shortBalanceBefore: shortBalance, longBalanceBefore: longBalance
        };
        safeLog('info', `✅ Mở lệnh chính thành công cho ${coin}. Đang đặt TP/SL...`);
        
        await sleep(2000);
        const [shortFill, longFill] = await Promise.all([ shortEx.fetchMyTrades(shortSymbol, undefined, 1), longEx.fetchMyTrades(longSymbol, undefined, 1) ]);
        
        if (shortFill.length > 0 && longFill.length > 0) {
            await Promise.all([
                placeTpSlOrders(shortEx, shortSymbol, 'sell', shortOrderDetails.amount, shortFill[0].price, collateral, shortOrderDetails.notional),
                placeTpSlOrders(longEx, longSymbol, 'buy', longOrderDetails.amount, longFill[0].price, collateral, longOrderDetails.notional)
            ]);
        } else {
            safeLog('warn', 'Không lấy được giá khớp lệnh, sẽ không đặt TP/SL.');
        }

        return true;
    } catch (e) {
        safeLog('error', `[TRADE] Lỗi nghiêm trọng khi vào lệnh:`, e);
        await closeTradeNow();
        activeBotInstance.capitalManagementState = 'IDLE';
        return false;
    }
}

async function closeTradeNow() {
    if (!activeBotInstance.currentTradeDetails) return;
    const trade = activeBotInstance.currentTradeDetails;
    safeLog('info', `Bắt đầu đóng vị thế cho ${trade.coin}`);

    try {
        const shortEx = activeBotInstance.exchanges[trade.shortExchange];
        const longEx = activeBotInstance.exchanges[trade.longExchange];
        
        await Promise.all([
            shortEx.cancelAllOrders(trade.shortSymbol),
            longEx.cancelAllOrders(trade.longSymbol)
        ]);

        await Promise.all([
            shortEx.createMarketBuyOrder(trade.shortSymbol, trade.shortOrderAmount, { 'reduceOnly': true }),
            longEx.createMarketSellOrder(trade.longSymbol, trade.longOrderAmount, { 'reduceOnly': true })
        ]);

        activeBotInstance.tradeAwaitingPnl = { ...trade, status: 'PENDING_PNL_CALC', closeTime: Date.now() };
        activeBotInstance.currentTradeDetails = null;
    } catch (e) {
        safeLog('error', `[CLOSE] Lỗi khi đóng vị thế:`, e);
        activeBotInstance.currentTradeDetails.status = "CLOSE_FAILED";
    }
}

async function calculatePnlAfterDelay() {
    if (!activeBotInstance.tradeAwaitingPnl) return;
    const closedTrade = activeBotInstance.tradeAwaitingPnl;
    
    await sleep(5000);
    await fetchAllBalances();
    
    const shortBalanceAfter = activeBotInstance.balances[closedTrade.shortExchange]?.available || 0;
    const longBalanceAfter = activeBotInstance.balances[closedTrade.longExchange]?.available || 0;
    const pnl = (shortBalanceAfter + longBalanceAfter) - (closedTrade.shortBalanceBefore + closedTrade.longBalanceBefore);

    safeLog('info', `[PNL] KẾT QUẢ PHIÊN (${closedTrade.coin}): PNL Tổng: ${pnl.toFixed(4)} USDT`);
    const finalTradeRecord = { ...closedTrade, status: 'CLOSED', actualPnl: pnl };
    activeBotInstance.tradeHistory.unshift(finalTradeRecord);
    
    db.run('UPDATE users SET pnl = pnl + ? WHERE username = ?', [pnl, activeBotInstance.username]);

    activeBotInstance.tradeAwaitingPnl = null;
    activeBotInstance.capitalManagementState = 'IDLE';
}

async function mainBotLoop() {
    if (activeBotInstance.botState !== 'RUNNING') return;
    try {
        if (activeBotInstance.tradeAwaitingPnl) await calculatePnlAfterDelay();

        const response = await fetch(SERVER_DATA_URL);
        const serverData = await response.json();
        
        const now = new Date();
        const minute = now.getUTCMinutes();
        const second = now.getUTCSeconds();

        if (minute === 1) activeBotInstance.hasLoggedNotFoundThisHour = false;
        
        if (activeBotInstance.capitalManagementState === 'IDLE' && minute >= 50 && minute < 59) {
            const opportunity = serverData.arbitrageData.find(op => 
                op.estimatedPnl >= MIN_PNL_PERCENTAGE &&
                (op.nextFundingTime - Date.now()) / 60000 < 15
            );
            if (opportunity) {
                safeLog('info', `[FIND] Tìm thấy cơ hội: ${opportunity.coin} (${opportunity.exchanges}). Bắt đầu thực hiện.`);
                activeBotInstance.capitalManagementState = 'PREPARING_FUNDS';
                await executeTrades(opportunity);
            } else if (!activeBotInstance.hasLoggedNotFoundThisHour) {
                safeLog('log', "[FIND] Không tìm thấy cơ hội nào hợp lệ.");
                activeBotInstance.hasLoggedNotFoundThisHour = true;
            }
        }
        
        if (activeBotInstance.capitalManagementState === 'TRADE_OPEN' && minute === 59 && second >= 58) {
             await closeTradeNow();
        }

    } catch (e) {
        safeLog('error', '[LOOP] Lỗi nghiêm trọng trong vòng lặp chính:', e);
        activeBotInstance.capitalManagementState = 'IDLE';
    }
    if (activeBotInstance.botState === 'RUNNING') {
        activeBotInstance.botLoopIntervalId = setTimeout(mainBotLoop, DATA_FETCH_INTERVAL_SECONDS * 1000);
    }
}

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, password], function(err) {
        if (err) return res.status(400).json({ success: false, message: 'Username already exists.' });
        res.status(201).json({ success: true, message: 'User registered successfully.' });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, row) => {
        if (err || !row) return res.status(401).json({ success: false, message: 'Invalid credentials.' });
        res.status(200).json({ success: true, username: row.username });
    });
});

app.post('/api/status', (req, res) => {
    const { username } = req.body;
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err || !user) return res.status(404).json({ message: 'User not found.' });
        
        if (activeBotInstance.username === username) {
            res.status(200).json({
                is_vip: user.is_vip, vip_level: user.vip_level, vip_expiry_timestamp: user.vip_expiry_timestamp, pnl: user.pnl,
                botState: activeBotInstance.botState,
                capitalManagementState: activeBotInstance.capitalManagementState,
                currentTradeDetails: activeBotInstance.currentTradeDetails,
                tradeHistory: activeBotInstance.tradeHistory,
                balances: activeBotInstance.balances
            });
        } else {
             res.status(200).json({ is_vip: user.is_vip, vip_level: user.vip_level, vip_expiry_timestamp: user.vip_expiry_timestamp, pnl: user.pnl, botState: 'STOPPED' });
        }
    });
});

app.post('/api/save-settings', (req, res) => {
    const { username, settings } = req.body;
    const sql = `UPDATE users SET 
        binance_apikey = ?, binance_secret = ?, 
        bitget_apikey = ?, bitget_secret = ?, bitget_password = ?,
        kucoin_apikey = ?, kucoin_secret = ?, kucoin_password = ?,
        binance_bep20 = ?, binance_aptos = ?,
        bitget_bep20 = ?, bitget_aptos = ?,
        kucoin_aptos = ?
        WHERE username = ?`;
    const params = [
        settings.binance_apikey, settings.binance_secret,
        settings.bitget_apikey, settings.bitget_secret, settings.bitget_password,
        settings.kucoin_apikey, settings.kucoin_secret, settings.kucoin_password,
        settings.binance_bep20, settings.binance_aptos,
        settings.bitget_bep20, settings.bitget_aptos,
        settings.kucoin_aptos,
        username
    ];
    db.run(sql, params, function(err) {
        if (err) return res.status(500).json({ success: false, message: 'Database error: ' + err.message });
        res.status(200).json({ success: true, message: 'Settings saved successfully.' });
    });
});

app.post('/api/start', async (req, res) => {
    if (activeBotInstance.username) {
        return res.status(409).json({ success: false, message: `Bot đã được chạy bởi user: ${activeBotInstance.username}` });
    }
    const { username, marginOptions } = req.body;
    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
        if (err || !user) return res.status(404).json({ success: false, message: "User không tồn tại." });
        
        activeBotInstance = {
            username, userData: user, marginOptions,
            botState: 'RUNNING', capitalManagementState: 'IDLE',
            botLoopIntervalId: null, balances: {}, tradeHistory: [],
            currentTradeDetails: null, tradeAwaitingPnl: null, hasLoggedNotFoundThisHour: false,
            exchanges: await initializeExchangesForUser(user)
        };
        
        if (Object.keys(activeBotInstance.exchanges).length === 0) {
            activeBotInstance = { username: null, botState: 'STOPPED' };
            return res.status(400).json({ success: false, message: "Không thể khởi tạo sàn nào. Vui lòng kiểm tra API keys." });
        }

        mainBotLoop();
        res.status(200).json({ success: true });
    });
});

app.post('/api/stop', async (req, res) => {
    if (activeBotInstance.username) {
        safeLog('info', `Nhận yêu cầu dừng bot từ user ${activeBotInstance.username}.`);
        clearTimeout(activeBotInstance.botLoopIntervalId);
        activeBotInstance = { username: null, botState: 'STOPPED' };
    }
    res.status(200).json({ success: true });
});

app.post('/admin/update-user', (req, res) => {
    const { secret, username, level, days } = req.body;
    if (secret !== ADMIN_SECRET_KEY) return res.status(403).json({ success: false, message: 'Forbidden.' });
    
    let sql, params;
    if (level === 'NONE') {
        sql = 'UPDATE users SET is_vip = 0, vip_level = NULL, vip_expiry_timestamp = NULL WHERE username = ?';
        params = [username];
    } else {
        const expiry_timestamp = (level === 'GOLD') ? new Date('9999-12-31T23:59:59Z').getTime() : Date.now() + (parseInt(days) * 86400000);
        sql = 'UPDATE users SET is_vip = 1, vip_level = ?, vip_expiry_timestamp = ? WHERE username = ?';
        params = [level, expiry_timestamp, username];
    }
    db.run(sql, params, function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (this.changes === 0) return res.status(404).json({ success: false, message: `User '${username}' not found.` });
        res.status(200).json({ success: true, message: `User '${username}' updated.` });
    });
});

app.get('/admin', (req, res) => {
    const secret = req.query.secret;
    if (secret !== ADMIN_SECRET_KEY) return res.status(403).send('<h1>Forbidden</h1>');

    db.all('SELECT * FROM users ORDER BY id DESC', [], (err, rows) => {
        if (err) return res.status(500).send(`<h1>Database Error: ${err.message}</h1>`);
        
        if (rows.length === 0) {
            return res.send('<h1>Admin - User Database</h1><p>No users found.</p>');
        }

        const headers = Object.keys(rows[0]);
        const headerHtml = headers.map(h => `<th>${h}</th>`).join('') + '<th>Actions</th>';

        const userRowsHtml = rows.map(row => {
            const cells = headers.map(header => `<td>${row[header] === null ? '' : row[header]}</td>`).join('');
            return `
                <tr>
                    ${cells}
                    <td><button onclick="openVipModal('${row.username}', '${row.vip_level || ''}')">Set VIP</button></td>
                </tr>`;
        }).join('');

        res.send(`
            <!DOCTYPE html>
            <html lang="vi">
            <head>
                <meta charset="UTF-8">
                <title>Admin - User Database</title>
                <style>
                    body { font-family: sans-serif; margin: 2em; background-color: #f4f4f9; color: #333; }
                    .table-container { overflow-x: auto; }
                    table { border-collapse: collapse; width: 100%; min-width: 1200px; box-shadow: 0 2px 3px rgba(0,0,0,0.1); }
                    th, td { border: 1px solid #ddd; padding: 12px; text-align: left; white-space: nowrap; }
                    th { background-color: #343a40; color: white; }
                    tr:nth-child(even){ background-color: #f2f2f2; }
                    button { background-color: #007bff; color: white; border: none; padding: 8px 12px; border-radius: 4px; cursor: pointer; }
                    button:hover { background-color: #0056b3; }
                    .modal { position: fixed; z-index: 100; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.5); display: none; justify-content: center; align-items: center; }
                    .modal-content { background-color: #fefefe; padding: 20px; border: 1px solid #888; width: 80%; max-width: 400px; border-radius: 8px; }
                    .close-btn { color: #aaa; float: right; font-size: 28px; cursor: pointer; }
                </style>
            </head>
            <body>
                <h1>Admin - User Database</h1>
                <div class="table-container">
                    <table>
                        <thead><tr>${headerHtml}</tr></thead>
                        <tbody>${userRowsHtml}</tbody>
                    </table>
                </div>

                <div id="vip-modal" class="modal">
                    <div class="modal-content">
                        <span class="close-btn" onclick="closeVipModal()">&times;</span>
                        <h2 id="modal-title">Set VIP</h2>
                        <input type="hidden" id="modal-username">
                        <div>
                            <label for="vip-level">Cấp VIP</label>
                            <select id="vip-level" onchange="toggleDaysInput()">
                                <option value="NONE">Không phải VIP</option>
                                <option value="1">VIP 1</option>
                                <option value="2">VIP 2</option>
                                <option value="3">VIP 3</option>
                                <option value="GOLD">VIP GOLD (Vĩnh viễn)</option>
                            </select>
                        </div>
                        <div id="days-group" style="margin-top: 15px;">
                            <label for="vip-days">Số ngày</label>
                            <input type="number" id="vip-days" value="30">
                        </div>
                        <button onclick="saveVipSettings()" style="margin-top: 20px;">Lưu thay đổi</button>
                    </div>
                </div>

                <script>
                    const modal = document.getElementById('vip-modal');
                    function openVipModal(username, currentLevel) {
                        document.getElementById('modal-title').innerText = 'Set VIP cho ' + username;
                        document.getElementById('modal-username').value = username;
                        document.getElementById('vip-level').value = currentLevel || 'NONE';
                        toggleDaysInput();
                        modal.style.display = 'flex';
                    }
                    function closeVipModal() { modal.style.display = 'none'; }
                    function toggleDaysInput() {
                        const level = document.getElementById('vip-level').value;
                        document.getElementById('days-group').style.display = (level === 'NONE' || level === 'GOLD') ? 'none' : 'block';
                    }
                    async function saveVipSettings() {
                        const username = document.getElementById('modal-username').value;
                        const level = document.getElementById('vip-level').value;
                        const days = document.getElementById('vip-days').value;
                        const response = await fetch('/admin/update-user', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ secret: '${ADMIN_SECRET_KEY}', username, level, days })
                        });
                        const result = await response.json();
                        alert(result.message);
                        if (result.success) window.location.reload();
                    }
                    window.onclick = (event) => { if (event.target == modal) closeVipModal(); }
                </script>
            </body>
            </html>
        `);
    });
});

app.listen(port, () => safeLog('info', `Server tổng hợp đang chạy tại http://localhost:${port}`));
