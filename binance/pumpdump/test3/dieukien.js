/**
 * file: dieukien.js
 * Cập nhật: Fix logic thuận chiều (Dương -> LONG, Âm -> SHORT)
 * Ưu tiên: M1 -> M5 -> M15 (Tín hiệu nóng hổi nhất)
 */

export function checkEntryCondition(candidate, botSettings, status, botActivePositions) {
    // 1. Kiểm tra Blacklist
    const isBlacklisted = status.blackList[candidate.symbol] || status.permanentBlacklist[candidate.symbol];
    if (isBlacklisted) return null;

    // 2. Kiểm tra vị thế (1 vợ 1 chồng)
    const isPositionActive = botActivePositions.has(`${candidate.symbol}_SHORT`) || botActivePositions.has(`${candidate.symbol}_LONG`);
    if (isPositionActive) return null;

    const minVol = parseFloat(botSettings.minVol);
    const m1 = parseFloat(candidate.c1 || 0);
    const m5 = parseFloat(candidate.c5 || 0);
    

    // 3. LOGIC THUẬN CHIỀU - ƯU TIÊN TÍN HIỆU TỨC THỜI (M1 -> M5 -> M15)
    let signal = null;
    
    // Kiểm tra từ M1 trước
    if (Math.abs(m1) >= minVol) signal = { val: m1, name: 'M1' };
    else if (Math.abs(m5) >= minVol) signal = { val: m5, name: 'M5' };
    

    if (signal) {
        // Chốt chặn Side: Dương -> LONG, Âm -> SHORT
        const side = signal.val > 0 ? 'LONG' : 'SHORT';

        return {
            symbol: candidate.symbol,
            side: side,
            vol: Math.abs(signal.val),
            reason: signal.name
        };
    }

    return null;
}
