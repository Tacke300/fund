/**
 * file: dieukien.js
 * Nhiệm vụ: Lọc tín hiệu vào lệnh, kiểm tra Blacklist và quét Vol
 */

export function checkEntryCondition(candidate, botSettings, status, botActivePositions) {
    // 1. Kiểm tra các điều kiện cấm (Blacklist/Permanent Blacklist)
    const isBlacklisted = status.blackList[candidate.symbol] || status.permanentBlacklist[candidate.symbol];
    if (isBlacklisted) return null;

    // 2. Kiểm tra xem cặp tiền này đã có vị thế nào đang mở chưa
    const isPositionActive = botActivePositions.has(`${candidate.symbol}_SHORT`) || botActivePositions.has(`${candidate.symbol}_LONG`);
    if (isPositionActive) return null;

    // 3. Lấy đúng biến minVol từ cấu hình UI
    const minVol = parseFloat(botSettings.minVol);

    // 4. Các khung thời gian cần kiểm tra
    const timeframes = [
        { val: parseFloat(candidate.c15 || 0), name: 'M15' },
        { val: parseFloat(candidate.c5 || 0), name: 'M5' },
        { val: parseFloat(candidate.c1 || 0), name: 'M1' }
    ];

    // 5. Tìm khung thời gian đầu tiên thỏa mãn minVol (Ưu tiên M15 -> M1)
    const signal = timeframes.find(tf => Math.abs(tf.val) >= minVol);

    // 6. Nếu thỏa mãn, trả về object để file bot.js nã đạn
    if (signal) {
        return {
            symbol: candidate.symbol,
            side: signal.val > 0 ? 'LONG' : 'SHORT',
            vol: Math.abs(signal.val),     // Bắt buộc phải có để main check Địa ngục
            reason: signal.name            // Lưu lại khung thời gian kích hoạt
        };
    }

    return null;
}
