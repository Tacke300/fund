// =========================
// FIX SPAM LOG + FIX TP/SL + FIX CLOSEALL
// PATCH ONLY
// =========================

// =========================
// LOG CHỐNG SPAM
// =========================
const recentLogs = new Map();

function addLog(msg, symbol = '', side = '') {

    const key = `${msg}_${symbol}_${side}`;

    const now = Date.now();

    // block log trùng 15s
    if (recentLogs.has(key)) {

        const last = recentLogs.get(key);

        if (now - last < 15000) return;
    }

    recentLogs.set(key, now);

    // clear cache cũ
    for (const [k, v] of recentLogs) {
        if (now - v > 30000) {
            recentLogs.delete(k);
        }
    }

    const time = new Date().toLocaleTimeString(
        'vi-VN',
        { hour12: false }
    );

    status.botLogs.unshift({
        time,
        msg,
        symbol,
        side
    });

    if (status.botLogs.length > 300) {
        status.botLogs.pop();
    }

    console.log(`[${time}] ${symbol} ${msg}`);
}

// =========================
// FIX VOLATILITY REALTIME
// =========================
function calcChange(arr, min) {

    if (!arr || arr.length < 2) return 0;

    const now = Date.now();

    const old =
        arr.find(x => x.t >= now - (min * 60000))
        || arr[0];

    const latest = arr[arr.length - 1];

    return (
        (
            latest.p - old.p
        ) / old.p
    ) * 100;
}

async function initWS() {

    try {

        const res =
            await axios.get(
                'https://fapi.binance.com/fapi/v1/ticker/price'
            );

        const symbols =
            res.data
                .filter(x => x.symbol.endsWith('USDT'))
                .slice(0, 150)
                .map(x => x.symbol.toLowerCase());

        const ws = new WebSocket(
            `wss://fstream.binance.com/stream?streams=${
                symbols.map(s => `${s}@ticker`).join('/')
            }`
        );

        ws.on('message', raw => {

            try {

                const json = JSON.parse(raw);

                if (!json.data) return;

                const s = json.data.s;

                const p = parseFloat(json.data.c);

                if (!coinData[s]) {
                    coinData[s] = {
                        prices: [],
                        live: {}
                    };
                }

                coinData[s].prices.push({
                    p,
                    t: Date.now()
                });

                if (coinData[s].prices.length > 2000) {
                    coinData[s].prices.shift();
                }

                coinData[s].live = {
                    price: p,
                    c1: calcChange(
                        coinData[s].prices,
                        1
                    ),
                    c5: calcChange(
                        coinData[s].prices,
                        5
                    ),
                    c15: calcChange(
                        coinData[s].prices,
                        15
                    )
                };

            } catch {}
        });

        ws.on('open', () => {
            marketReady = true;
            addLog('MARKET WS READY');
        });

        ws.on('close', () => {
            addLog('WS RECONNECT');
            setTimeout(initWS, 3000);
        });

    } catch (e) {

        addLog(`WS ERROR ${e.message}`);

        setTimeout(initWS, 5000);
    }
}

// =========================
// FIX TP SL
// DÙNG Y HỆT BẢN USER GỬI
// =========================
async function syncTPSL(
    pair,
    side,
    tp,
    sl
) {

    try {

        const closeSide =
            side === 'LONG'
                ? 'SELL'
                : 'BUY';

        const precision =
            exchangeInfo[pair]?.pricePrecision || 5;

        const tpPrice =
            parseFloat(
                exchange.priceToPrecision(
                    pair,
                    tp
                )
            );

        const slPrice =
            parseFloat(
                exchange.priceToPrecision(
                    pair,
                    sl
                )
            );

        // cancel cũ
        try {

            const orders =
                await exchange.fetchOpenOrders(pair);

            for (const o of orders) {

                if (
                    o.info.positionSide === side
                ) {
                    await exchange.cancelOrder(
                        o.id,
                        pair
                    );
                }
            }

        } catch {}

        // TP
        await exchange.createOrder(
            pair,
            'TAKE_PROFIT_MARKET',
            closeSide,
            undefined,
            undefined,
            {
                positionSide: side,
                stopPrice: tpPrice,
                closePosition: true,
                workingType: 'MARK_PRICE'
            }
        );

        // SL
        await exchange.createOrder(
            pair,
            'STOP_MARKET',
            closeSide,
            undefined,
            undefined,
            {
                positionSide: side,
                stopPrice: slPrice,
                closePosition: true,
                workingType: 'MARK_PRICE'
            }
        );

        return {
            tp: tpPrice,
            sl: slPrice
        };

    } catch (e) {

        addLog(
            `TPSL ERROR ${e.message}`,
            pair,
            side
        );

        return {
            tp: 0,
            sl: 0
        };
    }
}

// =========================
// FIX OPEN POSITION
// =========================
async function openPosition(
    symbol,
    side,
    price
) {

    try {

        if (!botSettings.isRunning) return;

        if (positions.size >= botSettings.maxPos) return;

        const key = `${symbol}_${side}`;

        if (positions.has(key)) return;

        const pair = toCCXTSymbol(symbol);

        const info = exchangeInfo[pair];

        if (!info) return;

        const lev =
            await getMaxLeverage(symbol);

        let qty =
            (
                botSettings.capital *
                lev
            ) / price;

        // ép min notional
        const minQty =
            5.5 / price;

        qty = Math.max(
            qty,
            minQty,
            info.minQty
        );

        qty =
            parseFloat(
                exchange.amountToPrecision(
                    pair,
                    qty
                )
            );

        await exchange.setLeverage(
            lev,
            pair
        );

        await exchange.createOrder(
            pair,
            'MARKET',
            side === 'LONG'
                ? 'BUY'
                : 'SELL',
            qty,
            undefined,
            {
                positionSide: side
            }
        );

        const tp =
            side === 'LONG'
                ? price * (
                    1 + (
                        botSettings.tp / 100
                    )
                )
                : price * (
                    1 - (
                        botSettings.tp / 100
                    )
                );

        const sl =
            side === 'LONG'
                ? price * (
                    1 - (
                        botSettings.sl / 100
                    )
                )
                : price * (
                    1 + (
                        botSettings.sl / 100
                    )
                );

        const synced =
            await syncTPSL(
                pair,
                side,
                tp,
                sl
            );

        const nextDca =
            side === 'LONG'
                ? price * (
                    1 - (
                        botSettings.dcaPercent / 100
                    )
                )
                : price * (
                    1 + (
                        botSettings.dcaPercent / 100
                    )
                );

        positions.set(key, {

            symbol,
            side,

            qty,
            leverage: lev,

            avg: price,
            entryInitial: price,

            tp: synced.tp,
            sl: synced.sl,

            nextDca,

            pnl: 0,
            unrealized: 0,

            roi: 0,

            dca: 0,

            margin:
                (
                    qty * price
                ) / lev,

            markPrice: price,

            liquidationPrice: 0,

            startTime: Date.now()
        });

        addLog(
            `OPEN | ${symbol} | ${side} | `
            + `Margin:${(
                (qty * price) / lev
            ).toFixed(2)}$ | `
            + `Lev:${lev}x | `
            + `Entry:${price} | `
            + `TP:${synced.tp} | `
            + `SL:${synced.sl} | `
            + `DCA:${nextDca}`,
            symbol,
            side
        );

        saveState();

    } catch (e) {

        addLog(
            `OPEN ERROR ${e.message}`,
            symbol,
            side
        );
    }
}

// =========================
// REAL PNL
// =========================
async function positionRiskLoop() {

    try {

        const risks =
            await exchange.fetchPositions();

        for (const r of risks) {

            const contracts =
                parseFloat(
                    r.contracts || 0
                );

            if (!contracts) continue;

            const symbol =
                r.symbol.replace(
                    '/USDT:USDT',
                    'USDT'
                );

            const side =
                contracts > 0
                    ? 'LONG'
                    : 'SHORT';

            const key =
                `${symbol}_${side}`;

            const pos =
                positions.get(key);

            if (!pos) continue;

            pos.pnl =
                parseFloat(
                    r.unrealizedPnl || 0
                );

            pos.roi =
                parseFloat(
                    r.percentage || 0
                );

            pos.unrealized =
                parseFloat(
                    r.unrealizedPnl || 0
                );

            pos.markPrice =
                parseFloat(
                    r.markPrice || 0
                );

            pos.notional =
                parseFloat(
                    r.notional || 0
                );

            pos.liquidationPrice =
                parseFloat(
                    r.liquidationPrice || 0
                );
        }

    } catch (e) {

        addLog(
            `PNL ERROR ${e.message}`
        );
    }

    setTimeout(
        positionRiskLoop,
        2000
    );
}

// =========================
// FIX CLOSE
// remove reduceOnly
// =========================
async function closePosition(p) {

    try {

        await exchange.createOrder(
            toCCXTSymbol(p.symbol),
            'MARKET',
            p.side === 'LONG'
                ? 'SELL'
                : 'BUY',
            p.qty,
            undefined,
            {
                positionSide: p.side
            }
        );

        addLog(
            `CLOSE | ${p.symbol} | `
            + `ROI:${p.roi?.toFixed(2)}% | `
            + `PNL:${p.pnl?.toFixed(2)}$`,
            p.symbol,
            p.side
        );

    } catch (e) {

        addLog(
            `CLOSE ERROR ${e.message}`,
            p.symbol,
            p.side
        );
    }
}

// =========================
// FIX AUTO TRADE SPAM
// =========================
let lastTargetCoin = '';
let lastTargetTime = 0;

async function autoTradeLoop() {

    try {

        if (!botSettings.isRunning) {

            setTimeout(
                autoTradeLoop,
                2000
            );

            return;
        }

        for (const [s, v]
            of Object.entries(coinData)
        ) {

            if (!v.live) continue;

            const {
                c1,
                c5,
                c15
            } = v.live;

            const valid =
                Math.abs(c1)
                    >= botSettings.volVolatility
                ||
                Math.abs(c5)
                    >= botSettings.volVolatility
                ||
                Math.abs(c15)
                    >= botSettings.volVolatility;

            if (!valid) continue;

            const side =
                (
                    c1 + c5 + c15
                ) >= 0
                    ? 'LONG'
                    : 'SHORT';

            // chống spam TARGET
            const now = Date.now();

            if (
                lastTargetCoin !== s
                ||
                now - lastTargetTime > 15000
            ) {

                addLog(
                    `TARGET ${s} `
                    + `M1:${c1.toFixed(2)} `
                    + `M5:${c5.toFixed(2)} `
                    + `M15:${c15.toFixed(2)}`,
                    s,
                    side
                );

                lastTargetCoin = s;
                lastTargetTime = now;
            }

            await openPosition(
                s,
                side,
                v.live.price
            );

            break;
        }

    } catch (e) {

        addLog(
            `AUTO ERROR ${e.message}`
        );
    }

    setTimeout(
        autoTradeLoop,
        2000
    );
}
