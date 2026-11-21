class WaveMacro {
  evaluate({ wave = null, predictedMissing = [], self, mode, structure = {} }) {
    const missingCount = predictedMissing.filter((p) => p.confidence >= 0.4).length;
    const hpRatio = self ? self.hp / Math.max(1, self.maxHp) : 1;

    if (structure.nexusThreat || structure.towerThreat) {
      return {
        stance: 'DEFENSE',
        action: 'DEFEND_BASE_OR_TOWER',
        pushRisk: 0.4,
        reason: 'Structure under threat'
      };
    }

    if (wave && wave.isPushedHard) {
      let pushRisk = 0.15;
      if (missingCount >= 2) pushRisk += 0.45;
      else if (missingCount === 1) pushRisk += 0.25;
      if (typeof wave.enemyDist === 'number' && wave.enemyDist < 720) pushRisk += 0.25;
      if (hpRatio < 0.45) pushRisk += 0.15;

      pushRisk = Math.min(1, Number(pushRisk.toFixed(2)));
      const safeToPush = pushRisk <= mode.maxWavePushRisk;

      return {
        stance: safeToPush ? 'OFFENSE' : 'DEFENSE',
        action: safeToPush ? 'CLEAR_AND_PUSH' : 'SAFE_CLEAR_NO_OVEREXTEND',
        pushRisk,
        reason: safeToPush ? 'Safe to clear pushed wave' : 'High risk of getting caught while pushing wave'
      };
    }

    if (hpRatio <= mode.retreatHpRatio) {
      return {
        stance: 'DEFENSE',
        action: 'RETREAT_LOW_HP',
        pushRisk: 0.5,
        reason: 'Low HP -> retreat'
      };
    }

    return {
      stance: mode.id === 'AGGRESSIVE' ? 'OFFENSE' : mode.id === 'DEFENSE' ? 'DEFENSE' : 'BALANCED',
      action: mode.id === 'AGGRESSIVE' ? 'PRESSURE_AND_FIGHT' : 'FARM_AND_CONTROL',
      pushRisk: Number(Math.min(1, missingCount * 0.25).toFixed(2)),
      reason: `Mode ${mode.id}`
    };
  }
}

module.exports = WaveMacro;
