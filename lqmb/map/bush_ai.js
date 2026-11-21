class BushAI {
  evaluate({ bushes = [], predictedMissing = [], alert = {}, mode }) {
    if (alert.spotted || alert.ambush || alert.danger) {
      return {
        evadeNow: true,
        action: 'EVADE_NOW',
        reason: 'Spotted or danger signal detected',
        bushes
      };
    }

    const scored = bushes.map((b) => {
      let risk = 0.16;
      for (const p of predictedMissing) {
        for (const pt of p.predictedLine || []) {
          const d = Math.hypot(b.x - pt.x, b.y - pt.y);
          const span = (pt.radius || 0.05) + 0.085;
          if (d <= span) {
            risk += p.confidence * (1 - d / span) * 0.85;
          }
        }
      }
      return { ...b, risk: Math.min(1, Number(risk.toFixed(2))) };
    });

    const candidates = scored
      .filter((b) => b.canCheck !== false)
      .sort((a, b) => b.risk - a.risk);

    const best = candidates[0];
    if (best && (best.risk >= 0.20 || (mode.bushCheckBias >= 0.85 && best.risk >= 0.16))) {
      return {
        evadeNow: false,
        action: 'CHECK_BUSH',
        targetBush: best,
        candidates,
        bushes: scored
      };
    }

    return {
      evadeNow: false,
      action: 'NONE',
      targetBush: null,
      candidates,
      bushes: scored
    };
  }
}

module.exports = BushAI;
