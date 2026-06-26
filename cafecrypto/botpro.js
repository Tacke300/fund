const express = require('express');
const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const activeBots = new Map();

class ProBotCore {
    constructor(username, apiKey, secretKey) {
        this.username = username;
        this.direction = 'TREND_VOLATILITY';
        this.botSettings = { isRunning: false };
        this.status = { botLogs: [], botClosedCount: 0, botPnLClosed: 0 };
        this.activePositions = [];
        this.walletCache = { totalWalletBalance: "0.00", availableBalance: "0.00", totalUnrealizedProfit: "0.00" };
        this.logFile = path.join(__dirname, 'user', username, 'botpro_log.txt');

        this.exchange = new ccxt.binance({
            apiKey: apiKey,
            secret: secretKey,
            enableRateLimit: true,
            options: { defaultType: 'future', adjustForTimeDifference: true, recvWindow: 60000 }
        });
    }

    addLog(msg) {
        const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
        const fullMsg = `[${time}] ${msg}`;
        console.log(fullMsg);
        this.status.botLogs.unshift({ time, msg });
        if (this.status.botLogs.length > 25) this.status.botLogs.pop();
        try { fs.appendFileSync(this.logFile, fullMsg + '\n'); } catch (e) {}
    }

    async forceCrossModeGlobal() {
        try {
            this.addLog(`[PRO] CHECKING CROSS MODE...`);
            const positions = await this.exchange.fetchPositions();
            const openPositions = positions.filter(p => parseFloat(p.contracts) > 0);
            if (openPositions.length > 0) {
                for (const pos of openPositions) {
                    const side = pos.side === 'long' ? 'sell' : 'buy';
                    try {
                        await this.exchange.createMarketOrder(pos.symbol, side, Math.abs(parseFloat(pos.contracts)), undefined, { reduceOnly: true });
                        this.addLog(`MARKET CLOSED: ${pos.symbol}`);
                    } catch (err) {}
                }
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            try {
                await this.exchange.setMarginMode('CROSS', 'BTC/USDT');
            } catch (e) {}
        } catch (error) {}
    }

    async updateWallet() {
        try {
            const balance = await this.exchange.fetchBalance();
            if (balance && balance.info && balance.info.assets) {
                const usdt = balance.info.assets.find(a => a.asset === 'USDT');
                if (usdt) {
                    this.walletCache.totalWalletBalance = parseFloat(usdt.walletBalance).toFixed(2);
                    this.walletCache.availableBalance = parseFloat(usdt.availableBalance).toFixed(2);
                    this.walletCache.totalUnrealizedProfit = parseFloat(usdt.unrealizedProfit || 0).toFixed(2);
                }
            }
        } catch (e) {}
    }
}

app.post('/api/user/toggle', async (req, res) => {
    const { username, apiKey, secretKey, isRunning } = req.body;
    let bot = activeBots.get(username);
    if (!bot) { bot = new ProBotCore(username, apiKey, secretKey); activeBots.set(username, bot); }
    bot.botSettings.isRunning = isRunning;
    if (bot.botSettings.isRunning) {
        bot.addLog("STARTING PRO BOT [VOLATILITY TREND MODE]");
        await bot.forceCrossModeGlobal();
    } else {
        bot.addLog("STOPPING PRO BOT");
    }
    return res.json({ success: true, status: bot.botSettings.isRunning ? "RUNNING" : "STOPPED" });
});

app.post('/api/user/status', async (req, res) => {
    const { username, apiKey, secretKey } = req.body;
    let bot = activeBots.get(username);
    if (!bot) {
        bot = new ProBotCore(username, apiKey, secretKey);
        activeBots.set(username, bot);
    }
    await bot.updateWallet();
    return res.json({ botSettings: bot.botSettings, activePositions: bot.activePositions, status: bot.status, wallet: bot.walletCache });
});

app.get('/:username', (req, res) => {
    const logPath = path.join(__dirname, 'user', req.params.username, 'botpro_log.txt');
    if (fs.existsSync(logPath)) res.send(`<pre>${fs.readFileSync(logPath, 'utf8')}</pre>`);
    else res.send("NO LOGS");
});

app.listen(1841, '127.0.0.1', () => console.log(`BOT PRO PORT 1841`));
