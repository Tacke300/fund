function gauss(mean = 0, std = 1) {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v) * std;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

class HumanInput {
  constructor(emit) {
    this.emit = emit;
  }

  tap(x, y, { jitter = 4, delayMs = null, tag = 'TAP' } = {}) {
    this.emit({
      type: 'TAP',
      x: Math.max(0, Math.round(x + gauss(0, jitter))),
      y: Math.max(0, Math.round(y + gauss(0, jitter))),
      holdMs: randInt(42, 80),
      delayBeforeMs: delayMs !== null ? delayMs : randInt(50, 110),
      tag
    });
  }

  move(cx, cy, tx, ty, { steps = 8, tag = 'MOVE' } = {}) {
    const ctrlX = (cx + tx) / 2 + gauss(0, 10);
    const ctrlY = (cy + ty) / 2 + gauss(0, 10);
    const pts = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const inv = 1 - t;
      pts.push({
        x: Math.max(0, Math.round(inv * inv * cx + 2 * inv * t * ctrlX + t * t * tx + gauss(0, 2))),
        y: Math.max(0, Math.round(inv * inv * cy + 2 * inv * t * ctrlY + t * t * ty + gauss(0, 2))),
        stepMs: randInt(12, 20)
      });
    }
    this.emit({ type: 'SWIPE', pts, tag });
  }
}

module.exports = HumanInput;
