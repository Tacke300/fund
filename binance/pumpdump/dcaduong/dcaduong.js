// ==========================
// MONITOR LOOP (FIXED PYRAMID LOGIC)
// ==========================

async function monitorLoop() {

    try {

        for (const [key, p] of positions) {

            const cp =
                coinData[p.symbol]?.live?.currentPrice;

            if (!cp) continue;

            // ==========================
            // TRACK HIGH / LOW
            // ==========================

            if (p.highestPrice === undefined) {
                p.highestPrice = cp;
            }

            if (p.side === 'LONG') {

                p.highestPrice = Math.max(
                    p.highestPrice,
                    cp
                );

            } else {

                p.highestPrice = Math.min(
                    p.highestPrice,
                    cp
                );
            }

            // ==========================
            // TP / SL BACKUP
            // ==========================

            const isTp =
                p.side === 'LONG'
                    ? cp >= p.tp
                    : cp <= p.tp;

            const isSl =
                p.side === 'LONG'
                    ? cp <= p.sl
                    : cp >= p.sl;

            // ==========================
            // DYNAMIC PROTECT
            // avg +- 1% entry
            // ==========================

            const protectPrice =
                p.side === 'LONG'
                    ? (
                        p.avg +
                        (
                            p.entryInitial * 0.01
                        )
                    )
                    : (
                        p.avg -
                        (
                            p.entryInitial * 0.01
                        )
                    );

            const isProtect =
                p.dca > 0 &&
                (
                    p.side === 'LONG'
                        ? (
                            p.highestPrice >= protectPrice &&
                            cp <= protectPrice
                        )
                        : (
                            p.highestPrice <= protectPrice &&
                            cp >= protectPrice
                        )
                );

            // ==========================
            // TIMEOUT
            // ==========================

            const isTimeout =
                Date.now() - p.startTime >
                14400000;

            // ==========================
            // CLOSE
            // ==========================

            if (
                isTp ||
                isSl ||
                isProtect ||
                isTimeout
            ) {

                try {

                    await exchange.createOrder(
                        p.symbol,
                        'market',
                        p.side === 'LONG'
                            ? 'sell'
                            : 'buy',
                        exchange.amountToPrecision(
                            p.symbol,
                            p.qty
                        ),
                        undefined,
                        {
                            reduceOnly: true,
                            positionSide: p.side
                        }
                    );

                } catch (e) {}

                // ==========================
                // PNL
                // ==========================

                let pnl = 0;

                if (p.side === 'LONG') {

                    pnl =
                        (
                            (
                                cp - p.avg
                            ) * p.qty
                        );

                } else {

                    pnl =
                        (
                            (
                                p.avg - cp
                            ) * p.qty
                        );
                }

                const fee =
                    (
                        (
                            p.avg * p.qty
                        ) +
                        (
                            cp * p.qty
                        )
                    ) * 0.001;

                pnl -= fee;

                // ==========================
                // LOG
                // ==========================

                if (isProtect) {

                    addLog(
                        `🛡️ PROTECT CLOSE ${p.symbol} | PNL ${pnl.toFixed(2)}$`
                    );

                } else if (isTp) {

                    addLog(
                        `🎯 TP ${p.symbol} | PNL ${pnl.toFixed(2)}$`
                    );

                } else if (isSl) {

                    addLog(
                        `🩸 SL ${p.symbol} | PNL ${pnl.toFixed(2)}$`
                    );

                } else {

                    addLog(
                        `⏰ TIMEOUT ${p.symbol} | PNL ${pnl.toFixed(2)}$`
                    );
                }

                // ==========================
                // BLOCK
                // ==========================

                blockedCoins.set(
                    p.symbol,
                    Date.now() + (15 * 60 * 1000)
                );

                positions.delete(key);

                saveState();

                continue;
            }

            // ==========================
            // PYRAMID DCA POSITIVE
            // ==========================

            if (p.dca < 3) {

                const trigger =
                    p.side === 'LONG'
                        ? (
                            cp >=
                            (
                                p.entryInitial *
                                (
                                    1 +
                                    (
                                        (
                                            botSettings.dcaPercent / 100
                                        ) *
                                        (
                                            p.dca + 1
                                        )
                                    )
                                )
                            )
                        )
                        : (
                            cp <=
                            (
                                p.entryInitial *
                                (
                                    1 -
                                    (
                                        (
                                            botSettings.dcaPercent / 100
                                        ) *
                                        (
                                            p.dca + 1
                                        )
                                    )
                                )
                            )
                        );

                if (trigger) {

                    await openPosition(
                        p.symbol,
                        p.side,
                        cp,
                        true,
                        p.isVip
                    );
                }
            }
        }

    } catch (e) {}

    setTimeout(
        monitorLoop,
        1000
    );
}
