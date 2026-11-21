function reduceDef(raw, flat = 0, pct = 0) {
  const afterFlat = Math.max(0, (raw || 0) - (flat || 0));
  return afterFlat * (1 - Math.min(0.9, Math.max(0, pct || 0)));
}

function dmgAfterDef(raw, def, dr = 0) {
  if (raw <= 0) return 0;
  const defMult = 600 / (600 + Math.max(0, def || 0));
  const drMult = Math.max(0.05, 1 - Math.min(0.9, Math.max(0, dr || 0)));
  return raw * defMult * drMult;
}

// Đánh giá:
// 1. Kết liễu an toàn + rủi ro bị bắt ngược + đổi mạng giữ nhà
// 2. Cấu rỉa (poke) thông minh: cấu tầm xa khi địch ló mặt / chưa đủ sát thương kết liễu, vẫn giữ an toàn
class DamageCalc {
  evaluate({ self, target, comboSteps = [], pokeStep = null, nearbyEnemies = [], mode, flags = {} }) {
    if (!self || !target) {
      return { action: 'HOLD', canKill: false, safeKill: false, canPoke: false };
    }

    const effArm = reduceDef(target.arm, self.flatPen, self.pctPen);
    const effMdef = reduceDef(target.mdef, self.flatMpen, self.pctMpen);

    let comboDmg = 0;
    for (const st of comboSteps) {
      const phys = (st.phys || 0) + (st.ad || 0) * (self.ad || 0);
      const magic = (st.magic || 0) + (st.ap || 0) * (self.ap || 0);
      let stepDmg = dmgAfterDef(phys, effArm, target.dr) + dmgAfterDef(magic, effMdef, target.dr) + (st.trueDmg || 0);
      if (st.execBelow && target.hp / Math.max(1, target.maxHp) <= st.execBelow) {
        stepDmg *= 1 + (st.execBonus || 0);
      }
      comboDmg += stepDmg;
    }

    const targetPool = (target.hp || 0) + (target.shield || 0);
    const canKill = comboDmg >= targetPool * 1.08;

    let incoming = target.counterBurst || 0;
    let hasCc = Boolean(target.hasCc);
    for (const e of nearbyEnemies) {
      incoming += e.counterBurst || 0;
      if (e.hasCc) hasCc = true;
    }

    const incomingRatio = incoming / Math.max(1, self.hp || 1);
    const hpAfter = Math.max(0, (self.hp || 0) - incoming);
    const surviveRatio = hpAfter / Math.max(1, self.maxHp || 1);
    const selfHpRatio = (self.hp || 0) / Math.max(1, self.maxHp || 1);
    const hasEscape = Boolean(self.hasDash || self.hasFlash);
    const ccPenalty = hasCc && !self.ccImmune ? 0.15 : 0;

    const safeKill =
      canKill &&
      incomingRatio <= mode.maxEnemyBurstRatio - ccPenalty &&
      surviveRatio >= mode.minHpAfterKillRatio &&
      (hasEscape || surviveRatio >= 0.42);

    const tradeBase =
      canKill &&
      Boolean(flags.defendStructure) &&
      Boolean(flags.waveThreat) &&
      incomingRatio <= mode.towerTradeMaxBurstRatio;

    // Cấu rỉa an toàn: đủ máu theo mode, không bị dồn sát thương chết ngược, địch đang lộ diện
    const pokeRaw = pokeStep
      ? dmgAfterDef((pokeStep.phys || 0) + (pokeStep.ad || 0) * (self.ad || 0), effArm, target.dr) +
        dmgAfterDef((pokeStep.magic || 0) + (pokeStep.ap || 0) * (self.ap || 0), effMdef, target.dr)
      : 0;

    const canPoke =
      !canKill &&
      pokeRaw > 0 &&
      selfHpRatio >= mode.pokeMinHpRatio &&
      incomingRatio <= mode.maxEnemyBurstRatio * 0.75;

    let action = 'HOLD_NO_DIE';
    if (safeKill) action = 'KILL_AND_ESCAPE_SAFE';
    else if (tradeBase) action = 'TRADE_TO_SAVE_STRUCTURE';
    else if (canPoke) action = 'POKE_HARASS';

    return {
      action,
      canKill,
      safeKill,
      tradeBase,
      canPoke,
      comboDmg: Math.round(comboDmg),
      pokeDmg: Math.round(pokeRaw),
      targetPool: Math.round(targetPool),
      incomingBurst: Math.round(incoming),
      surviveRatio: Number(surviveRatio.toFixed(2))
    };
  }
}

module.exports = DamageCalc;
