const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'auto_catalog.json');

// Kho dữ liệu tự học & tự cập nhật:
// 1. Tự tìm / đồng bộ số liệu từ manifest (nếu có) hoặc ước lượng thông minh theo cấp/vai trò/đồ
// 2. Tự thu thập thông số trang bị khi mở cửa hàng trong game & lưu xuống cache
// 3. Tự thu thập thông số tướng khi mở bảng thông tin tướng trong trận & lưu/cập nhật liên tục
class AutoCatalog {
  constructor({ remoteUrl = null, syncIntervalMs = 60 * 60 * 1000 } = {}) {
    this.remoteUrl = remoteUrl;
    this.syncIntervalMs = syncIntervalMs;
    this.version = 'auto-2026';
    this.heroes = {};
    this.items = {};
  }

  ensureCacheDir() {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  loadCache() {
    this.ensureCacheDir();
    if (!fs.existsSync(CACHE_FILE)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (raw.version) this.version = raw.version;
      if (raw.heroes) this.heroes = raw.heroes;
      if (raw.items) this.items = raw.items;
    } catch (_) {}
  }

  saveCache() {
    this.ensureCacheDir();
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({ version: this.version, heroes: this.heroes, items: this.items }, null, 2)
    );
  }

  async syncRemote() {
    if (!this.remoteUrl) return { synced: false, version: this.version };
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 6000);
      const res = await fetch(this.remoteUrl, { signal: ac.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      let changed = false;

      if (json.heroes && typeof json.heroes === 'object') {
        for (const [id, h] of Object.entries(json.heroes)) {
          this.heroes[id] = this.mergeHero(id, h, this.heroes[id]);
          changed = true;
        }
      }
      if (json.items && typeof json.items === 'object') {
        for (const [id, it] of Object.entries(json.items)) {
          this.items[id] = this.mergeItem(id, it, this.items[id]);
          changed = true;
        }
      }
      if (json.version && json.version !== this.version) {
        this.version = json.version;
        changed = true;
      }
      if (changed) this.saveCache();
      return { synced: changed, version: this.version };
    } catch (e) {
      return { synced: false, version: this.version, error: e.message };
    }
  }

  startAutoSync() {
    this.loadCache();
    this.syncRemote();
    return setInterval(() => this.syncRemote(), this.syncIntervalMs);
  }

  // Tự thu thập & lưu thông số khi mở cửa hàng trong game
  ingestShopScan(scannedItems = []) {
    let changed = false;
    for (const it of scannedItems) {
      if (!it || !it.id) continue;
      const key = String(it.id).toLowerCase();
      this.items[key] = this.mergeItem(key, { ...it, source: 'SHOP_SCAN', scannedAt: Date.now() }, this.items[key]);
      changed = true;
    }
    if (changed) this.saveCache();
    return Object.keys(this.items).length;
  }

  // Tự thu thập & lưu thông số khi mở xem chi tiết tướng trong trận
  ingestHeroInspection(inspectedList = []) {
    let changed = false;
    for (const h of inspectedList) {
      if (!h || !h.id) continue;
      const key = String(h.heroId || h.id).toLowerCase();
      this.heroes[key] = this.mergeHero(
        key,
        {
          ...h,
          source: 'IN_MATCH_INSPECT',
          inspectedAt: Date.now()
        },
        this.heroes[key]
      );
      changed = true;
    }
    if (changed) this.saveCache();
    return Object.keys(this.heroes).length;
  }

  mergeHero(id, incoming = {}, prev = null) {
    const roles = incoming.roles || prev?.roles || ['FIGHTER'];
    const isTank = roles.includes('TANK');
    const isMage = roles.includes('MAGE');
    const isAss = roles.includes('ASSASSIN');

    const base = prev || {
      id,
      name: incoming.name || id,
      roles,
      resource: incoming.resource || (isAss ? 'ENERGY' : 'MANA'),
      stats: {
        hp: isTank ? 3550 : isMage ? 3020 : 3150,
        hpLv: isTank ? 265 : isMage ? 175 : 200,
        res: incoming.resource === 'ENERGY' || isAss ? 100 : 440,
        resLv: incoming.resource === 'ENERGY' || isAss ? 0 : 30,
        ad: isMage ? 155 : 175,
        adLv: isMage ? 11 : 14,
        ap: isMage ? 25 : 0,
        apLv: isMage ? 12 : 0,
        arm: isTank ? 130 : isMage ? 85 : 95,
        armLv: isTank ? 23 : isMage ? 15 : 18,
        mdef: isTank ? 55 : 50,
        mdefLv: isTank ? 11 : 9
      },
      skills: {
        s1: {
          phys: isMage ? 0 : 210,
          physLv: isMage ? 0 : 42,
          ad: isMage ? 0 : 0.85,
          magic: isMage ? 340 : 0,
          magicLv: isMage ? 70 : 0,
          ap: isMage ? 0.72 : 0,
          dash: isAss || roles.includes('MARKSMAN'),
          cc: true,
          range: isMage ? 760 : 540,
          cdSec: 7
        },
        s2: {
          phys: isMage ? 0 : 190,
          physLv: isMage ? 0 : 38,
          ad: isMage ? 0 : 0.75,
          magic: isMage ? 260 : 0,
          magicLv: isMage ? 55 : 0,
          ap: isMage ? 0.62 : 0,
          dash: isAss,
          cc: !isAss,
          range: 560,
          cdSec: 8
        },
        s3: {
          phys: isMage ? 0 : 410,
          physLv: isMage ? 0 : 110,
          ad: isMage ? 0 : 1.45,
          magic: isMage ? 420 : 0,
          magicLv: isMage ? 95 : 0,
          ap: isMage ? 0.85 : 0,
          dash: false,
          cc: false,
          range: isMage ? 650 : 480,
          cdSec: 26
        }
      }
    };

    const nextStats = { ...base.stats };
    if (typeof incoming.maxHp === 'number' && incoming.lv) {
      const estBaseHp = incoming.maxHp - nextStats.hpLv * (incoming.lv - 1);
      if (estBaseHp > 1200) nextStats.hp = Math.round(estBaseHp);
    }
    if (typeof incoming.ad === 'number' && incoming.lv) {
      const estBaseAd = incoming.ad - nextStats.adLv * (incoming.lv - 1);
      if (estBaseAd > 50) nextStats.ad = Math.round(estBaseAd);
    }
    if (typeof incoming.ap === 'number' && incoming.lv) {
      const estBaseAp = incoming.ap - nextStats.apLv * (incoming.lv - 1);
      if (estBaseAp >= 0) nextStats.ap = Math.round(estBaseAp);
    }
    if (typeof incoming.arm === 'number' && incoming.lv) {
      const estArm = incoming.arm - nextStats.armLv * (incoming.lv - 1);
      if (estArm >= 20) nextStats.arm = Math.round(estArm);
    }
    if (typeof incoming.mdef === 'number' && incoming.lv) {
      const estMdef = incoming.mdef - nextStats.mdefLv * (incoming.lv - 1);
      if (estMdef >= 10) nextStats.mdef = Math.round(estMdef);
    }

    return {
      ...base,
      ...incoming,
      stats: { ...nextStats, ...(incoming.stats || {}) },
      skills: {
        s1: { ...base.skills.s1, ...((incoming.skills && incoming.skills.s1) || {}) },
        s2: { ...base.skills.s2, ...((incoming.skills && incoming.skills.s2) || {}) },
        s3: { ...base.skills.s3, ...((incoming.skills && incoming.skills.s3) || {}) }
      }
    };
  }

  mergeItem(id, incoming = {}, prev = null) {
    const inferredCost =
      typeof incoming.cost === 'number'
        ? incoming.cost
        : prev?.cost ??
          ((incoming.stats?.ad || 0) >= 160 || (incoming.stats?.ap || 0) >= 200 ? 2300 : 1400);

    return {
      id,
      name: incoming.name || prev?.name || id,
      cost: inferredCost,
      slotPos: incoming.slotPos || prev?.slotPos || null,
      stats: { ...(prev?.stats || {}), ...(incoming.stats || {}) },
      tags: incoming.tags || prev?.tags || []
    };
  }

  ensureHero(heroId, hint = {}) {
    const key = String(heroId || 'unknown_hero').toLowerCase();
    if (!this.heroes[key]) {
      this.heroes[key] = this.mergeHero(key, hint);
      this.saveCache();
    }
    return this.heroes[key];
  }

  // Luôn trả về item hợp lệ (tự sinh nếu chưa từng thấy)
  ensureItem(itemId, hint = {}) {
    const key = String(itemId || 'unknown_item').toLowerCase();
    if (!this.items[key]) {
      this.items[key] = this.mergeItem(key, hint);
      this.saveCache();
    }
    return this.items[key];
  }

  getAllItems() {
    return Object.values(this.items);
  }
}

module.exports = AutoCatalog;
