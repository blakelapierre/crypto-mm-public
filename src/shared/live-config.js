import fs from 'fs';
import path from 'path';

export const TUNABLES = [
  { key: 'LIVE_FOCUS_N', type: 'num', hint: 'full books (top 1m names)' },
  { key: 'FOCUS_LOCK_MS', type: 'num', hint: 'ms lock before focus can flip' },
  { key: 'LIVE_WEIGHT_MS', type: 'num', hint: 'weight window ms' },
  { key: 'LIVE_TREND_GAIN', type: 'num', hint: '1m return multiplier' },
  { key: 'MM_LEVELS', type: 'num' },
  { key: 'MM_MAX_PAIRS', type: 'num' },
  { key: 'MM_SPREAD_BPS', type: 'num' },
  { key: 'MIN_HALF_SPREAD_BPS', type: 'num' },
  { key: 'MAX_HALF_SPREAD_BPS', type: 'num' },
  { key: 'MIN_EDGE_BPS', type: 'num' },
  { key: 'MAKER_FEE_BPS', type: 'num' },
  { key: 'REQUOTE_MOVE_BPS', type: 'num' },
  { key: 'L1_REQUOTE_BPS', type: 'num' },
  { key: 'HOLD_EXIT_MS', type: 'num', hint: 'down-tape hold exit ms' },
  { key: 'DEAD_RANGE_PCT', type: 'num' },
  { key: 'RISE_INV_HOLD', type: 'num' },
  { key: 'RISE_INV_HOLD_MAX', type: 'num' },
  { key: 'RISE_SELL_EXTRA_BPS', type: 'num' },
  { key: 'VOL_ENTER_PCT', type: 'num' },
  { key: 'VOL_EXIT_PCT', type: 'num' },
  { key: 'VOL_ROTATE_MIN_MS', type: 'num' },
  { key: 'UPDATE_INTERVAL_MS', type: 'num' },
  { key: 'MIN_ORDER_USD', type: 'num' },
  { key: 'JOIN_TOUCH', type: 'bool' },
  { key: 'POST_ONLY', type: 'bool' },
  { key: 'SKEW_OTHER_SIDE', type: 'bool' },
  { key: 'SKEW_TIGHTEN_BPS', type: 'num' },
  { key: 'MM_INVENTORY_FRACTION', type: 'num' },
  { key: 'INV_NAME_MAX_FRAC', type: 'num', hint: 'max inventory / equity per name' },
  { key: 'INV_CAP_HARD', type: 'num' },
  { key: 'CASH_FLOOR_FRAC', type: 'num', hint: 'min cash/equity before new buys' },
  { key: 'CLIP_EQ_FRAC', type: 'num' },
  { key: 'HOLD_FLAT_RET', type: 'num' },
  { key: 'ENTER_RET_MIN', type: 'num', hint: 'min 1m return to enter or bid' },
  { key: 'FALL_EXIT_RET', type: 'num', hint: 'exit name if 1m return below this' },
  { key: 'INV_BOOK_MAX_FRAC', type: 'num', hint: 'max inventory+bids / equity' },
  { key: 'BOOK_TARGET_FRAC', type: 'num', hint: 'open bids+asks / equity target' },
  { key: 'FOCUS_ALL_EQ_USD', type: 'num', hint: 'below this equity, focus the whole set' },
  { key: 'DEPOSIT_DETECT_USD', type: 'num', hint: 'cash step booked as a transfer' },
  { key: 'DUST_EXIT_USD', type: 'num', hint: 'post-only exit floor for leftovers' },
  { key: 'ROTATE_MIN_HOLD_MS', type: 'num' },
  { key: 'ALLOW_MARKET_EXIT', type: 'bool' },
  { key: 'SEED_MODE', type: 'str' },
  { key: 'BANK_ROTATE_PCT', type: 'num' },
];

const CFG_MAP = {
  MM_LEVELS: 'mmLevels',
  MM_MAX_PAIRS: 'mmMaxPairs',
  MM_SPREAD_BPS: 'mmSpreadBps',
  MIN_HALF_SPREAD_BPS: 'minHalfSpreadBps',
  MAX_HALF_SPREAD_BPS: 'maxHalfSpreadBps',
  MIN_EDGE_BPS: 'minEdgeBps',
  REQUOTE_MOVE_BPS: 'requoteMoveBps',
  UPDATE_INTERVAL_MS: 'updateIntervalMs',
  MIN_ORDER_USD: 'minOrderUsd',
  JOIN_TOUCH: 'joinTouch',
  POST_ONLY: 'postOnly',
  SKEW_OTHER_SIDE: 'skewOtherSide',
  SKEW_TIGHTEN_BPS: 'skewTightenBps',
  MM_INVENTORY_FRACTION: 'mmInventoryFraction',
};

let targetCfg = null;
const dirty = new Map();

export function bindLiveConfig(cfg) { targetCfg = cfg; }

export function liveConfigSnap() {
  return TUNABLES.map((t) => ({
    ...t,
    value: process.env[t.key] != null && process.env[t.key] !== '' ? process.env[t.key] : '',
  }));
}

export function applyLiveConfig(values) {
  if (!values || typeof values !== 'object') return [];
  const changed = [];
  for (const t of TUNABLES) {
    if (!Object.prototype.hasOwnProperty.call(values, t.key)) continue;
    let v = values[t.key];
    if (v == null) continue;
    v = String(v).trim();
    if (t.type === 'num' && v !== '' && !Number.isFinite(Number(v))) continue;
    if (t.type === 'bool') v = ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()) ? 'true' : 'false';
    if (process.env[t.key] === v) continue;
    process.env[t.key] = v;
    dirty.set(t.key, v);
    const field = CFG_MAP[t.key];
    if (targetCfg && field) {
      if (t.type === 'num') targetCfg[field] = Number(v);
      else if (t.type === 'bool') targetCfg[field] = v === 'true';
      else targetCfg[field] = v;
    }
    changed.push(t.key);
  }
  if (changed.length) console.log('live-config apply ' + changed.join(','));
  return changed;
}

function resolveUp(rel) {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd(), rel);
}

export function persistLiveConfig(configFile) {
  const file = resolveUp(configFile || process.env.BOT_CONFIG || 'configs/ladder.env');
  if (!dirty.size) return;
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const seen = new Set();
  const lines = text.split('\n').map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) return line;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    if (!dirty.has(k)) return line;
    seen.add(k);
    const prefix = line.startsWith(' ') || line.startsWith('\t') ? line.slice(0, line.indexOf(k)) : '';
    return prefix + k + '=' + dirty.get(k);
  });
  for (const [k, v] of dirty) {
    if (seen.has(k)) continue;
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push(k + '=' + v);
  }
  fs.writeFileSync(file, lines.join('\n').replace(/\n+$/, '\n'));
  console.log('live-config wrote ' + file + ' keys=' + [...dirty.keys()].join(','));
}
