// dieukien.js
export function checkEntryCondition(candidate, botSettings, status, botActivePositions) {
    // 1. Kiểm tra các điều kiện cấm (Blacklist)
    const isBlacklisted = status.blackList[candidate.symbol] || status.permanentBlacklist[candidate.symbol];
    if (isBlacklisted) return null;

    // 2. Kiểm tra vị thế đang hoạt động
    const isPositionActive = botActivePositions.has(`${candidate.symbol}_SHORT`) || botActivePositions.has(`${candidate.symbol}_LONG`);
    if (isPositionActive) return null;

    // 3. Định nghĩa các khung thời gian
    const timeframes = [
        { val: candidate.c15, name: 'M15' },
        { val: candidate.c5, name: 'M5' },
        { val: candidate.c1, name: 'M1' }
    ];

    // 4. Tìm khung đầu tiên thỏa mãn minVol
    const signal = timeframes.find(tf => Math.abs(tf.val) >= botSettings.minVol);

    if (signal) {
        return {
            symbol: candidate.symbol,
            side: signal.val > 0 ? 'LONG' : 'SHORT',
            reason: signal.name // Lưu lại khung nào kích hoạt để tiện log
        };
    }

    return null;
}
