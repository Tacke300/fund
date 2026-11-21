// Tự động tính và mua đồ theo vàng, vai trò, đội hình địch & mode;
// nếu thiếu thông số đồ -> gợi ý mở cửa hàng để tự thu thập.
class AutoShop {
  constructor(catalog) {
    this.catalog = catalog;
  }

  needsShopScan(now = Date.now(), minIntervalMs = 45000) {
    const count = this.catalog.getAllItems().length;
    if (count < 6) return true;
    const latestScan = Math.max(0, ...this.catalog.getAllItems().map((i) => i.scannedAt || 0));
    return now - latestScan > minIntervalMs;
  }

  getPlan(self, enemies = [], mode) {
    const hero = this.catalog.ensureHero(self.heroId, self);
    const roles = hero.roles || [];

    let adEnemies = 0;
    let apEnemies = 0;
    let tankEnemies = 0;

    for (const e of enemies) {
      const eh = this.catalog.ensureHero(e.heroId, e);
      if (eh.roles.includes('MARKSMAN') || eh.roles.includes('ASSASSIN') || (e.ad || 0) > (e.ap || 0) + 80) adEnemies++;
      if (eh.roles.includes('MAGE') || (e.ap || 0) > 120) apEnemies++;
      if (eh.roles.includes('TANK') || (e.maxHp || 0) >= 6500 || (e.arm || 0) >= 260) tankEnemies++;
    }

    const isAp = roles.includes('MAGE') || (self.ap || 0) > (self.ad || 0);
    const isTank = roles.includes('TANK') || roles.includes('SUPPORT') || mode.tankBias >= 0.7;

    const plan = [];
    if (isAp) plan.push('enchanted_kicks');
    else if (apEnemies >= 2) plan.push('gilded_greaves');
    else if (adEnemies >= 2 || isTank) plan.push('sonic_boots');
    else plan.push('war_boots');

    if (isTank) {
      plan.push(apEnemies > adEnemies ? 'gaia_standard' : 'shield_of_the_lost');
      plan.push(apEnemies > adEnemies ? 'shield_of_the_lost' : 'gaia_standard');
    } else if (isAp) {
      plan.push('hecate_diadem');
      if (tankEnemies >= 2) plan.push('staff_of_nuul');
    } else {
      plan.push('claves_sancti', 'fenrir_tooth');
      if (tankEnemies >= 2) plan.push('muramasa');
    }

    if (mode.tankBias >= 0.65 || adEnemies + apEnemies >= 3) {
      plan.push('blade_of_eternity');
    }

    return [...new Set(plan)].slice(0, 6);
  }

  decide({ self, gold = 0, enemies = [], mode, now = Date.now() }) {
    if (!self) return { buy: false, shouldScanShop: false };

    const owned = new Set(self.items || []);
    const plan = this.getPlan(self, enemies, mode);
    const nextId = plan.find((id) => !owned.has(id));
    if (!nextId) {
      return { buy: false, shouldScanShop: this.needsShopScan(now), plan };
    }

    const item = this.catalog.ensureItem(nextId);
    return {
      buy: gold >= item.cost,
      shouldScanShop: this.needsShopScan(now),
      itemId: item.id,
      itemName: item.name,
      cost: item.cost,
      gold,
      plan
    };
  }
}

module.exports = AutoShop;
