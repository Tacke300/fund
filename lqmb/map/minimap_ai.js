class MinimapAI {
  constructor() {
    this.tracks = new Map(); 
  }

  update(visibleEnemies = [], now = Date.now()) {
    const seen = new Set();

    for (const e of visibleEnemies) {
      if (!e || !e.id) continue;
      seen.add(e.id);
      const prev = this.tracks.get(e.id);
      let vx = prev ? prev.vx : 0;
      let vy = prev ? prev.vy : 0;

      if (prev && prev.seenAt && now > prev.seenAt) {
        const dt = (now - prev.seenAt) / 1000;
        if (dt >= 0.025 && dt <= 1.5) {
          vx = prev.vx * 0.35 + ((e.x - prev.x) / dt) * 0.65;
          vy = prev.vy * 0.35 + ((e.y - prev.y) / dt) * 0.65;
        }
      }

      this.tracks.set(e.id, {
        id: e.id,
        heroId: e.heroId || e.id,
        x: e.x,
        y: e.y,
        vx,
        vy,
        seenAt: now,
        lostAt: null,
        visible: true
      });
    }

    for (const [id, t] of this.tracks.entries()) {
      if (!seen.has(id)) {
        t.visible = false;
        if (!t.lostAt) t.lostAt = now;
      }
    }
  }

  predictMissing(now = Date.now(), maxLostSec = 8.0) {
    const list = [];

    for (const t of this.tracks.values()) {
      if (t.visible || !t.lostAt) continue;
      const lostSec = (now - t.lostAt) / 1000;
      if (lostSec > maxLostSec) continue;

      const speed = Math.hypot(t.vx, t.vy);
      let dx = t.vx;
      let dy = t.vy;
      if (speed < 0.003) {
        dx = (0.5 - t.x) * 0.4;
        dy = (0.5 - t.y) * 0.4;
      }

      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const vNorm = Math.min(0.075, Math.max(0.038, speed || 0.045));

      const predictedLine = [1, 2, 3, 4].map((step) => {
        const horizon = lostSec + step * 0.6;
        return {
          step,
          x: Number(Math.min(0.97, Math.max(0.03, t.x + ux * vNorm * horizon)).toFixed(3)),
          y: Number(Math.min(0.97, Math.max(0.03, t.y + uy * vNorm * horizon)).toFixed(3)),
          radius: Number(Math.min(0.22, 0.03 + horizon * 0.02).toFixed(3))
        };
      });

      list.push({
        id: t.id,
        heroId: t.heroId,
        lastPos: { x: t.x, y: t.y },
        lostSec: Number(lostSec.toFixed(1)),
        confidence: Math.max(0.15, Number((1 - lostSec / maxLostSec).toFixed(2))),
        predictedLine
      });
    }

    return list;
  }
}

module.exports = MinimapAI;
