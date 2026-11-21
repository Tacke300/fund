const MODES = require('../config/modes');
const AutoCatalog = require('../data/catalog');
const LiveTracker = require('../data/live_tracker');
const TerrainAI = require('../map/terrain_ai');
const MinimapAI = require('../map/minimap_ai');
const BushAI = require('../map/bush_ai');
const WaveMacro = require('../macro/wave_macro');
const AutoShop = require('../shop/auto_shop');
const DamageCalc = require('../combat/damage_calc');
const ComboPro = require('../combat/combo_pro');
const HumanInput = require('../input/human_input');
const ProPlayer = require('../combat/pro_player');

const catalog = new AutoCatalog();
catalog.loadCache();

// Giả lập tự thu thập đồ khi mở shop & thông số tướng khi mở xem chi tiết trong trận
catalog.ingestShopScan([
  { id: 'boots_x', name: 'Giày Tự Quét', cost: 720, stats: { spd: 65, arm: 100 } },
  { id: 'sword_y', name: 'Kiếm Tự Quét', cost: 1950, stats: { ad: 140, crit: 0.25 } }
]);

const tracker = new LiveTracker(catalog);
const terrain = new TerrainAI();
const minimap = new MinimapAI();
const bush = new BushAI();
const wave = new WaveMacro();
const shop = new AutoShop(catalog);
const damage = new DamageCalc();
const combo = new ComboPro();
const cmds = [];
const input = new HumanInput((c) => cmds.push(c));

const player = new ProPlayer({ catalog, tracker, terrain, minimap, bush, wave, shop, damage, combo, input });

const t0 = Date.now();
tracker.onMatchStart(
  [
    { id: 'me', heroId: 'nakroth', team: 'ALLY', role: 'ASSASSIN', lv: 1, hp: 3260, maxHp: 3260, res: 100, maxRes: 100, ad: 195, ap: 0, pos: { x: 0.45, y: 0.44 }, headPos: { x: 700, y: 420 } },
    { id: 'e1', heroId: 'krixi', team: 'ENEMY', role: 'MAGE', lv: 1, hp: 3140, maxHp: 3140, res: 490, maxRes: 490, ad: 155, ap: 30, pos: { x: 0.52, y: 0.48 }, headPos: { x: 1050, y: 400 } }
  ],
  t0
);

const out = player.step(
  {
    selfId: 'me',
    targetId: 'e1',
    nearbyEnemyIds: [],
    gold: 2100,
    heroes: [
      { id: 'me', lv: 10, hp: 4700, maxHp: 5400, res: 100, maxRes: 100, ad: 460, ap: 0, pos: { x: 0.45, y: 0.43 }, headPos: { x: 720, y: 410 } },
      { id: 'e1', lv: 10, hp: 2900, maxHp: 4600, res: 400, maxRes: 800, ad: 210, ap: 440, arm: 170, mdef: 110, counterBurst: 700, hasCc: true, pos: { x: 0.53, y: 0.49 }, headPos: { x: 1040, y: 390 } }
    ],
    minimapEnemies: [],
    bushes: [{ id: 'b_mid', x: 0.48, y: 0.46, canCheck: true }],
    wave: { isPushedHard: false, enemyDist: 800 },
    ready: { s1: true, s2: true, s3: true, flash: true },
    buttons: { aa: { x: 1720, y: 920 }, s1: { x: 1620, y: 940 }, s2: { x: 1660, y: 790 }, s3: { x: 1780, y: 740 }, flash: { x: 1510, y: 980 } },
    joy: { cx: 260, cy: 860 },
    checkBushTap: { x: 1620, y: 940 },
    shopTap: { x: 1420, y: 120 },
    inspectTap: { x: 1280, y: 90 }
  },
  MODES.BALANCED,
  t0 + 2000
);

console.log(JSON.stringify({ out, cmds }, null, 2));
