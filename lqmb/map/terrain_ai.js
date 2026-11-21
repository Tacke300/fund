// Tính địa hình, vật cản / tường mỏng có thể dùng Tốc Biến / chiêu lướt vượt qua để chạy trốn hoặc áp sát,
// và tính hướng di chuyển an toàn nhất tránh nguy hiểm.
class TerrainAI {
  constructor() {
    // Danh sách vùng tường/vật cản chuẩn hóa (0..1) có thể Tốc Biến/lướt qua (như tường rồng/taek/đường giữa/rừng)
    this.flashableWalls = [
      { id: 'wall_mid_top', x: 0.44, y: 0.42, thickness: 0.045, safeExit: { x: 0.37, y: 0.36 } },
      { id: 'wall_mid_bot', x: 0.56, y: 0.58, thickness: 0.045, safeExit: { x: 0.63, y: 0.64 } },
      { id: 'wall_dragon_pit', x: 0.66, y: 0.72, thickness: 0.050, safeExit: { x: 0.73, y: 0.78 } },
      { id: 'wall_slayer_pit', x: 0.34, y: 0.28, thickness: 0.050, safeExit: { x: 0.27, y: 0.22 } }
    ];
  }

  // Tìm điểm Tốc Biến vượt tường tối ưu để chạy trốn khi bị truy đuổi
  findBestWallFlashEscape({ self, enemies = [], threats = [] }) {
    if (!self || !self.pos) return null;

    let bestWall = null;
    let bestScore = -Infinity;

    for (const w of this.flashableWalls) {
      const distToWall = Math.hypot(self.pos.x - w.x, self.pos.y - w.y);
      if (distToWall > 0.16) continue;

      // Khoảng cách từ điểm thoát sau tường tới địch/vùng nguy hiểm gần nhất
      let minEnemyDistAfter = 1.0;
      for (const e of enemies) {
        if (!e || !e.pos) continue;
        const d = Math.hypot(w.safeExit.x - e.pos.x, w.safeExit.y - e.pos.y);
        if (d < minEnemyDistAfter) minEnemyDistAfter = d;
      }

      let threatPenalty = 0;
      for (const t of threats) {
        const d = Math.hypot(w.safeExit.x - t.x, w.safeExit.y - t.y);
        if (d < (t.radius || 0.08) + 0.06) threatPenalty += 0.5;
      }

      const score = minEnemyDistAfter * 1.4 - distToWall * 0.8 - threatPenalty;
      if (score > bestScore && minEnemyDistAfter >= 0.14) {
        bestScore = score;
        bestWall = {
          wallId: w.id,
          safeExit: w.safeExit,
          score: Number(score.toFixed(3))
        };
      }
    }

    return bestWall;
  }

  // Tính hướng di chuyển an toàn nhất (vector chuẩn hóa dx, dy trong khoảng -1..1)
  computeSafeDirection({ self, enemies = [], predictedMissing = [], safeBase = { x: 0.1, y: 0.9 } }) {
    if (!self || !self.pos) return { dx: -0.7, dy: 0.7, dangerScore: 0.5 };

    let repulseX = 0;
    let repulseY = 0;
    let dangerScore = 0;

    for (const e of enemies) {
      if (!e || !e.pos) continue;
      const vx = self.pos.x - e.pos.x;
      const vy = self.pos.y - e.pos.y;
      const dist = Math.max(0.02, Math.hypot(vx, vy));
      if (dist < 0.35) {
        const weight = (0.35 - dist) / 0.35;
        repulseX += (vx / dist) * weight * 1.6;
        repulseY += (vy / dist) * weight * 1.6;
        dangerScore += weight * 0.55;
      }
    }

    for (const p of predictedMissing) {
      for (const pt of p.predictedLine || []) {
        const vx = self.pos.x - pt.x;
        const vy = self.pos.y - pt.y;
        const dist = Math.max(0.02, Math.hypot(vx, vy));
        const span = (pt.radius || 0.06) + 0.09;
        if (dist < span) {
          const w = ((span - dist) / span) * p.confidence;
          repulseX += (vx / dist) * w * 1.1;
          repulseY += (vy / dist) * w * 1.1;
          dangerScore += w * 0.4;
        }
      }
    }

    // Lực kéo nhẹ về hướng trụ/nhà an toàn
    const toSafeX = safeBase.x - self.pos.x;
    const toSafeY = safeBase.y - self.pos.y;
    const safeLen = Math.hypot(toSafeX, toSafeY) || 1;

    let fx = repulseX + (toSafeX / safeLen) * 0.45;
    let fy = repulseY + (toSafeY / safeLen) * 0.45;
    const mag = Math.hypot(fx, fy) || 1;

    return {
      dx: Number((fx / mag).toFixed(3)),
      dy: Number((fy / mag).toFixed(3)),
      dangerScore: Math.min(1, Number(dangerScore.toFixed(2)))
    };
  }
}

module.exports = TerrainAI;
