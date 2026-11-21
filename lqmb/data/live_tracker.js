// Ghi nhận thông tin tướng ngay khi vào trận (khi chưa có ngọc trước đó),
// tự yêu cầu mở/đọc thông tin tướng nếu thiếu dữ liệu, và cập nhật liên tục chỉ số.
class LiveTracker {
  constructor(catalog) {
    this.catalog = catalog;
    this.heroes = new Map();
  }

  onMatchStart(list = [], now = Date.now()) {
    for (const h of list) {
      if (!h || !h.id) continue;
      const def = this.catalog.ensureHero(h.heroId || h.id, h);
      const lv = Math.max(1, h.lv || 1);
      const s = def.stats;

      const baseHp = s.hp + s.hpLv * (lv - 1);
      const baseAd = s.ad + s.adLv * (lv - 1);
      const baseAp = s.ap + s.apLv * (lv - 1);

      const maxHp = h.maxHp ?? baseHp;
      const ad = h.ad ?? baseAd;
      const ap = h.ap ?? baseAp;

      this.heroes.set(h.id, {
        id: h.id,
        heroId: def.id,
        name: def.name,
        team: h.team || 'ENEMY',
        role: h.role || def.roles[0] || 'FIGHTER',
        resourceType: h.resourceType || def.resource || 'MANA',
        lv,
        hp: h.hp ?? maxHp,
        maxHp,
        res: h.res ?? (h.maxRes ?? (s.res + s.resLv * (lv - 1))),
        maxRes: h.maxRes ?? (s.res + s.resLv * (lv - 1)),
        ad,
        ap,
        arm: h.arm ?? (s.arm + s.armLv * (lv - 1)),
        mdef: h.mdef ?? (s.mdef + s.mdefLv * (lv - 1)),
        items: Array.isArray(h.items) ? [...h.items] : [],
        runeDelta: {
          hp: Math.round(maxHp - baseHp),
          ad: Math.round(ad - baseAd),
          ap: Math.round(ap - baseAp)
        },
        headPos: h.headPos || null,
        pos: h.pos || { x: 0.5, y: 0.5 },
        screenPos: h.screenPos || { x: 960, y: 540 },
        lastInspectAt: h.inspected ? now : 0,
        updatedAt: now
      });
    }
    return this.getOverheadHud();
  }

  update(list = [], now = Date.now()) {
    for (const h of list) {
      if (!h || !h.id) continue;
      if (!this.heroes.has(h.id)) {
        this.onMatchStart([h], now);
        continue;
      }
      const cur = this.heroes.get(h.id);
      const lv = Math.max(1, h.lv ?? cur.lv);
      const maxHp = Math.max(1, h.maxHp ?? cur.maxHp);
      const hp = Math.max(0, Math.min(maxHp, h.hp ?? cur.hp));
      const maxRes = Math.max(0, h.maxRes ?? cur.maxRes);
      const res = Math.max(0, Math.min(maxRes, h.res ?? cur.res));

      // Cộng thêm chỉ số từ trang bị đang cầm nếu có trong catalog
      let itemAd = 0;
      let itemAp = 0;
      let itemHp = 0;
      let itemArm = 0;
      let itemMdef = 0;
      const items = Array.isArray(h.items) ? h.items : cur.items;
      for (const itemId of items) {
        const it = this.catalog.items[itemId];
        if (!it || !it.stats) continue;
        itemAd += it.stats.ad || 0;
        itemAp += it.stats.ap || 0;
        itemHp += it.stats.hp || 0;
        itemArm += it.stats.arm || 0;
        itemMdef += it.stats.mdef || 0;
      }

      const ad = typeof h.ad === 'number' ? h.ad : Math.max(cur.ad, this.catalog.ensureHero(cur.heroId).stats.ad + itemAd);
      const ap = typeof h.ap === 'number' ? h.ap : Math.max(cur.ap, this.catalog.ensureHero(cur.heroId).stats.ap + itemAp);

      this.heroes.set(h.id, {
        ...cur,
        lv,
        hp,
        maxHp: Math.max(maxHp, cur.maxHp + (Array.isArray(h.items) ? 0 : 0), itemHp > 0 && !h.maxHp ? maxHp + itemHp : maxHp),
        res,
        maxRes,
        ad,
        ap,
        arm: typeof h.arm === 'number' ? h.arm : cur.arm + itemArm,
        mdef: typeof h.mdef === 'number' ? h.mdef : cur.mdef + itemMdef,
        items,
        headPos: h.headPos || cur.headPos,
        pos: h.pos || cur.pos,
        screenPos: h.screenPos || cur.screenPos,
        lastInspectAt: h.inspected ? now : cur.lastInspectAt,
        updatedAt: now
      });
    }
    return this.getOverheadHud();
  }

  // Nếu tướng thiếu thông số hoặc lâu chưa mở bảng xem thông tin tướng -> gợi ý mở xem ngay
  getInspectSuggestion(now = Date.now(), cooldownMs = 15000) {
    for (const h of this.heroes.values()) {
      if (h.team !== 'ENEMY') continue;
      const missingKeyStats = !h.ad || !h.maxHp;
      if (missingKeyStats || (now - (h.lastInspectAt || 0) > cooldownMs && h.lv >= 4)) {
        return { shouldInspect: true, targetHero: h };
      }
    }
    return { shouldInspect: false, targetHero: null };
  }

  getOverheadHud() {
    const out = [];
    for (const h of this.heroes.values()) {
      const hpPct = Math.round((h.hp / Math.max(1, h.maxHp)) * 100);
      const resPct = h.maxRes > 0 ? Math.round((h.res / h.maxRes) * 100) : 0;
      const resName = h.resourceType === 'ENERGY' ? 'Nội năng' : 'Mana';

      out.push({
        id: h.id,
        heroId: h.heroId,
        name: h.name,
        team: h.team,
        lv: h.lv,
        headPos: h.headPos,
        hp: Math.round(h.hp),
        maxHp: Math.round(h.maxHp),
        hpPct,
        resourceType: h.resourceType,
        resourceName: resName,
        res: Math.round(h.res),
        maxRes: Math.round(h.maxRes),
        resPct,
        ad: Math.round(h.ad),
        ap: Math.round(h.ap),
        labelTop: `HP ${Math.round(h.hp)}/${Math.round(h.maxHp)} (${hpPct}%)`,
        labelMid: h.maxRes > 0 ? `${resName} ${Math.round(h.res)}/${Math.round(h.maxRes)} (${resPct}%)` : 'Không năng lượng',
        labelBot: `STVL ${Math.round(h.ad)} | ST Phép ${Math.round(h.ap)}`
      });
    }
    return out;
  }

  get(id) {
    return this.heroes.get(id) || null;
  }
}

module.exports = LiveTracker;
