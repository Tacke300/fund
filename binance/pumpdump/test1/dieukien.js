/**
 * file: dieukien.js
 * Nhiệm vụ: Lọc tín hiệu vào lệnh dựa trên 2 chế độ: 'xedap' hoặc 'dianguc'
 */

export function checkEntryCondition(candidate, botSettings, status, botActivePositions) {
    // 1. Kiểm tra các điều kiện cấm (Blacklist/Permanent Blacklist)
    const isBlacklisted = status.blackList[candidate.symbol] || status.permanentBlacklist[candidate.symbol];
    if (isBlacklisted) return null;

    // 2. Kiểm tra xem cặp tiền này đã có vị thế nào đang mở chưa
    const isPositionActive = botActivePositions.has(`${candidate.symbol}_SHORT`) || botActivePositions.has(`${candidate.symbol}_LONG`);
    if (isPositionActive) return null;

    // 3. Xác định ngưỡng minVol dựa trên chế độ hiện tại của Bot
    // Giả định botSettings có biến mode: 'xedap' hoặc 'dianguc'
    const mode = botSettings.mode || 'xedap'; 
    const minVol = mode === 'xedap' ? botSettings.minVolXeDap : botSettings.minVolDiaNguc;

    // 4. Các khung thời gian cần kiểm tra
    const timeframes = [
        { val: candidate.c15, name: 'M15' },
        { val: candidate.c5, name: 'M5' },
        { val: candidate.c1, name: 'M1' }
    ];

    // 5. Tìm khung thời gian đầu tiên thỏa mãn minVol (Ưu tiên M15 -> M1)
    const signal = timeframes.find(tf => Math.abs(tf.val) >= minVol);

    // 6. Nếu thỏa mãn, trả về object chứa thông tin để mở lệnh
    if (signal) {
        return {
            symbol: candidate.symbol,
            side: signal.val > 0 ? 'LONG' : 'SHORT',
            mode: mode,            // Truyền chế độ để file chính xử lý logic TP/SL
            reason: signal.name    // Lưu lại khung thời gian kích hoạt
        };
    }

    return null;
}
