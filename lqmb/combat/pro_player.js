// Điều phối mượt mà mọi tướng:
// 1. Né ngay khi bị lộ diện / nguy hiểm (ưu tiên Tốc Biến vượt tường chạy trốn nếu nguy cơ cao)
// 2. Kết liễu an toàn / đổi mạng giữ nhà / cấu rỉa tầm an toàn
// 3. Di chuyển theo hướng an toàn khi lính bị ép / rút lui
// 4. Check bụi nguy hiểm
// 5. Tự mở xem thông tin tướng / mở cửa hàng thu thập số liệu & mua đồ
class ProPlayer {
  constructor({ catalog, tracker, terrain, minimap, bush, wave, shop, damage, combo, input }) {
    this.catalog = catalog;
    this.tracker = tracker;
    this.terrain = terrain;
    this.minimap = minimap;
    this.bush = bush;
    this.wave = wave;
    this.shop = shop;
    this.damage = damage;
    this.combo = combo;
    this.input = input;
  }

  step(frame, mode, now = Date.now()) {
    const overheadHud = this.tracker.update(frame.heroes || [], now);
    this.minimap.update(frame.minimapEnemies || [], now);
    const predictedMissing = this.minimap.predictMissing(now);

    const self = frame.selfId ? this.tracker.get(frame.selfId) : null;
    const all = Array.from(this.tracker.heroes.values());
    const enemies = all.filter((h) => h.team === 'ENEMY');
    const heroDef = self ? this.catalog.ensureHero(self.heroId, self) : null;

    const bushRes = this.bush.evaluate({
      bushes: frame.bushes || [],
      predictedMissing,
      alert: frame.alert || {},
      mode
    });

    const waveRes = this.wave.evaluate({
      wave: frame.wave || null,
      predictedMissing,
      self,
      mode,
      structure: frame.structure || {}
    });

    const target = frame.targetId ? this.tracker.get(frame.targetId) : null;
    const nearbyEnemies = (frame.nearbyEnemyIds || []).map((id) => this.tracker.get(id)).filter(Boolean);

    const defaultCombo = heroDef
      ? [
          {
            phys: heroDef.skills.s1.phys + heroDef.skills.s1.physLv * ((self?.lv || 1) - 1),
            ad: heroDef.skills.s1.ad,
            magic: heroDef.skills.s1.magic + heroDef.skills.s1.magicLv * ((self?.lv || 1) - 1),
            ap: heroDef.skills.s1.ap
          },
          {
            phys: heroDef.skills.s2.phys + heroDef.skills.s2.physLv * ((self?.lv || 1) - 1),
            ad: heroDef.skills.s2.ad,
            magic: heroDef.skills.s2.magic + heroDef.skills.s2.magicLv * ((self?.lv || 1) - 1),
            ap: heroDef.skills.s2.ap
          },
          {
            phys: heroDef.skills.s3.phys + heroDef.skills.s3.physLv * ((self?.lv || 1) - 1),
            ad: heroDef.skills.s3.ad,
            magic: heroDef.skills.s3.magic + heroDef.skills.s3.magicLv * ((self?.lv || 1) - 1),
            ap: heroDef.skills.s3.ap
          }
        ]
      : [];

    const pokeStep = heroDef
      ? {
          phys: heroDef.skills.s1.phys + heroDef.skills.s1.physLv * ((self?.lv || 1) - 1),
          ad: heroDef.skills.s1.ad,
          magic: heroDef.skills.s1.magic + heroDef.skills.s1.magicLv * ((self?.lv || 1) - 1),
          ap: heroDef.skills.s1.ap
        }
      : null;

    const combatRes = this.damage.evaluate({
      self,
      target,
      comboSteps: frame.comboSteps && frame.comboSteps.length ? frame.comboSteps : defaultCombo,
      pokeStep,
      nearbyEnemies,
      mode,
      flags: frame.combatFlags || {}
    });

    const safeDir = this.terrain.computeSafeDirection({
      self,
      enemies,
      predictedMissing,
      safeBase: frame.safeBase || { x: 0.12, y: 0.88 }
    });

    const wallFlash = this.terrain.findBestWallFlashEscape({
      self,
      enemies,
      threats: predictedMissing.flatMap((p) => p.predictedLine || [])
    });

    const shopRes = this.shop.decide({
      self,
      gold: frame.gold ?? 0,
      enemies,
      mode,
      now
    });

    const inspectSuggestion = this.tracker.getInspectSuggestion(now);
    const actions = [];

    if (bushRes.evadeNow && frame.joy) {
      const span = 120;
      this.input.move(
        frame.joy.cx,
        frame.joy.cy,
        frame.joy.cx + safeDir.dx * span,
        frame.joy.cy + safeDir.dy * span,
        { tag: 'EVADE_SAFE_DIR' }
      );
      actions.push('EVADE_NOW');

      if (
        safeDir.dangerScore >= mode.wallFlashEscapeMinRisk &&
        wallFlash &&
        frame.ready?.flash &&
        frame.buttons?.flash
      ) {
        this.input.tap(frame.buttons.flash.x, frame.buttons.flash.y, { delayMs: 40, tag: `WALL_FLASH_${wallFlash.wallId}` });
        actions.push(`WALL_FLASH_${wallFlash.wallId}`);
      }
    } else if (
      (combatRes.action === 'KILL_AND_ESCAPE_SAFE' ||
        combatRes.action === 'TRADE_TO_SAVE_STRUCTURE' ||
        combatRes.action === 'POKE_HARASS') &&
      frame.buttons &&
      self
    ) {
      const steps = this.combo.build({
        heroDef,
        role: self.role,
        modeAction: combatRes.action,
        ready: frame.ready || {},
        buttons: frame.buttons,
        flashTrick: Boolean(frame.flashTrick)
      });
      for (const s of steps) {
        this.input.tap(s.x, s.y, { delayMs: s.delayMs, tag: s.tag });
      }
      // Sau khi cấu rỉa hoặc dồn chiêu xong, điều chỉnh vị trí theo hướng an toàn để giữ nhịp múa
      if (frame.joy && combatRes.action === 'POKE_HARASS') {
        this.input.move(frame.joy.cx, frame.joy.cy, frame.joy.cx + safeDir.dx * 75, frame.joy.cy + safeDir.dy * 75, {
          tag: 'REPOSITION_AFTER_POKE'
        });
      }
      actions.push(combatRes.action);
    } else if (waveRes.action === 'SAFE_CLEAR_NO_OVEREXTEND' && frame.joy) {
      this.input.move(frame.joy.cx, frame.joy.cy, frame.joy.cx + safeDir.dx * 95, frame.joy.cy + safeDir.dy * 95, {
        tag: 'SAFE_WAVE_MOVE'
      });
      actions.push('SAFE_WAVE_CLEAR');
    } else if (bushRes.action === 'CHECK_BUSH' && frame.checkBushTap) {
      this.input.tap(frame.checkBushTap.x, frame.checkBushTap.y, { tag: 'CHECK_BUSH' });
      actions.push('CHECK_BUSH');
    } else if (frame.joy && safeDir.dangerScore > 0.25) {
      this.input.move(frame.joy.cx, frame.joy.cy, frame.joy.cx + safeDir.dx * 85, frame.joy.cy + safeDir.dy * 85, {
        tag: 'MICRO_SAFE_STEP'
      });
      actions.push('MICRO_SAFE_STEP');
    }

    if (shopRes.buy && frame.shopTap) {
      this.input.tap(frame.shopTap.x, frame.shopTap.y, { tag: `BUY_${shopRes.itemId}` });
      actions.push(`BUY_${shopRes.itemId}`);
    } else if ((shopRes.shouldScanShop || inspectSuggestion.shouldInspect) && frame.inspectTap) {
      this.input.tap(frame.inspectTap.x, frame.inspectTap.y, { tag: 'AUTO_INSPECT_STATS' });
      actions.push('AUTO_INSPECT_STATS');
    }

    return {
      mode: mode.id,
      overheadHud,
      predictedMissing,
      safeDir,
      wallFlash,
      bushRes,
      waveRes,
      combatRes,
      shopRes,
      actions
    };
  }
}

module.exports = ProPlayer;
