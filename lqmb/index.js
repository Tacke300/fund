const WebSocket = require('ws');
const MODES = require('./config/modes');
const AutoCatalog = require('./data/catalog');
const LiveTracker = require('./data/live_tracker');
const TerrainAI = require('./map/terrain_ai');
const MinimapAI = require('./map/minimap_ai');
const BushAI = require('./map/bush_ai');
const WaveMacro = require('./macro/wave_macro');
const AutoShop = require('./shop/auto_shop');
const DamageCalc = require('./combat/damage_calc');
const ComboPro = require('./combat/combo_pro');
const HumanInput = require('./input/human_input');
const ProPlayer = require('./combat/pro_player');

const PORT = Number(process.env.PORT || 8765);
const CATALOG_URL = process.env.CATALOG_URL || null;

class BrainServer {
  constructor() {
    this.mode = MODES.BALANCED;
    this.catalog = new AutoCatalog({ remoteUrl: CATALOG_URL });
    this.tracker = new LiveTracker(this.catalog);
    this.terrain = new TerrainAI();
    this.minimap = new MinimapAI();
    this.bush = new BushAI();
    this.wave = new WaveMacro();
    this.shop = new AutoShop(this.catalog);
    this.damage = new DamageCalc();
    this.combo = new ComboPro();
    this.wss = new WebSocket.Server({ port: PORT });
    this.clients = new Set();

    this.input = new HumanInput((cmd) => {
      this.sendAll({ type: 'INPUT_CMD', payload: cmd });
    });

    this.player = new ProPlayer({
      catalog: this.catalog,
      tracker: this.tracker,
      terrain: this.terrain,
      minimap: this.minimap,
      bush: this.bush,
      wave: this.wave,
      shop: this.shop,
      damage: this.damage,
      combo: this.combo,
      input: this.input
    });
  }

  start() {
    this.catalog.startAutoSync();

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.send(JSON.stringify({ type: 'READY', payload: { mode: this.mode.id, version: this.catalog.version } }));
      ws.on('message', (raw) => this.onMsg(raw.toString()));
      ws.on('close', () => this.clients.delete(ws));
    });

    console.log(`[LQV-PRO-BRAIN] ws://127.0.0.1:${PORT}`);
  }

  sendAll(obj) {
    const str = JSON.stringify(obj);
    for (const c of this.clients) {
      if (c.readyState === WebSocket.OPEN) c.send(str);
    }
  }

  onMsg(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'SET_MODE' && MODES[msg.mode]) {
      this.mode = MODES[msg.mode];
      this.sendAll({ type: 'MODE_SET', payload: { mode: this.mode.id } });
      return;
    }

    if (msg.type === 'MATCH_INIT' && msg.payload) {
      const hud = this.tracker.onMatchStart(msg.payload.heroes || [], msg.payload.ts || Date.now());
      this.sendAll({ type: 'OVERHEAD_HUD', payload: hud });
      return;
    }

    if (msg.type === 'SHOP_SCAN' && msg.payload) {
      this.catalog.ingestShopScan(msg.payload.items || []);
      return;
    }

    if (msg.type === 'HERO_INSPECT' && msg.payload) {
      this.catalog.ingestHeroInspection(msg.payload.heroes || []);
      const hud = this.tracker.update(msg.payload.heroes || [], msg.payload.ts || Date.now());
      this.sendAll({ type: 'OVERHEAD_HUD', payload: hud });
      return;
    }

    if (msg.type === 'FRAME' && msg.payload) {
      const out = this.player.step(msg.payload, this.mode, msg.payload.ts || Date.now());
      this.sendAll({ type: 'OVERHEAD_HUD', payload: out.overheadHud });
      this.sendAll({ type: 'OVERLAY_DATA', payload: out });
    }
  }
}

if (require.main === module) {
  new BrainServer().start();
}

module.exports = BrainServer;
