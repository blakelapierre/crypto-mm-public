import fs from 'fs';
import path from 'path';

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

export function loadEnvFile(file, { override = true } = {}) {
  const envPath = resolveUp(file);
  if (!fs.existsSync(envPath)) {
    console.warn(`env file not found: ${file} (looked from ${process.cwd()})`);
    return [];
  }
  const applied = [];
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (override || process.env[k] === undefined || process.env[k] === '') {
      process.env[k] = v;
      applied.push(k);
    }
  }
  console.log(`loaded env ${envPath}${override ? ' (override)' : ''} keys=${applied.join(',') || '(none new)'}`);
  return applied;
}

export function loadProjectEnv(configFile) {
  loadEnvFile('.env', { override: false });
  if (configFile) loadEnvFile(configFile, { override: true });
  console.log(
    `resolved EXCHANGE=${process.env.EXCHANGE || ''} QUOTE=${process.env.QUOTE || ''} ` +
      `DRY_RUN=${process.env.DRY_RUN || ''} MM_LEVELS=${process.env.MM_LEVELS || ''} BOT=${process.env.BOT || ''}`
  );
}

export function envStr(k, d) {
  return process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d;
}
export function envNum(k, d) {
  const v = process.env[k];
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
export function envBool(k, d) {
  const v = process.env[k];
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

export function baseConfig() {
  return {
    exchange: envStr('EXCHANGE', 'print'),
    dryRun: envBool('DRY_RUN', true),
    quote: envStr('QUOTE', 'USDC'),
    krakenApiKey: envStr('KRAKEN_API_KEY', ''),
    krakenApiSecret: envStr('KRAKEN_API_SECRET', ''),
    coinbaseApiKey: envStr('COINBASE_API_KEY', ''),
    coinbaseApiSecret: envStr('COINBASE_API_SECRET', ''),
    totalCapitalOverride: envNum('TOTAL_CAPITAL_USD', 0),
    portfolioFraction: envNum('PORTFOLIO_FRACTION', 0.25),
    portfolioCoins: envNum('PORTFOLIO_COINS', 10),
    mmEnabled: envBool('MM_ENABLED', true),
    mmLevels: envNum('MM_LEVELS', 1),
    mmSpreadBps: envNum('MM_SPREAD_BPS', 15),
    mmMaxPairs: envNum('MM_MAX_PAIRS', 5),
    mmInventoryFraction: envNum('MM_INVENTORY_FRACTION', 0.5),
    inventorySafetyMultiplier: envNum('INVENTORY_SAFETY_MULTIPLIER', 1.05),
    capitalSafetyMargin: envNum('CAPITAL_SAFETY_MARGIN', 0.92),
    orderSizeHaircut: envNum('ORDER_SIZE_HAIRCUT', 0.95),
    feeBufferPct: envNum('FEE_BUFFER_PCT', 0.005),
    postOnly: envBool('POST_ONLY', true),
    cancelAllOrdersOnStartup: envBool('CANCEL_ALL_ORDERS_ON_STARTUP', true),
    settleWaitMs: envNum('SETTLE_WAIT_MS', 3000),
    settlePolls: envNum('SETTLE_POLLS', 3),
    settlePollIntervalMs: envNum('SETTLE_POLL_INTERVAL_MS', 2000),
    rebalanceOnFill: envBool('REBALANCE_ON_FILL', false),
    slideMaxLegsPerSide: envNum('SLIDE_MAX_LEGS_PER_SIDE', 6),
    skewOtherSide: envBool('SKEW_OTHER_SIDE', true),
    skewTightenBps: envNum('SKEW_TIGHTEN_BPS', 8),
    useUserWebsocket: envBool('USE_USER_WEBSOCKET', true),
    orderPollMs: envNum('ORDER_POLL_MS', 3000),
    updateIntervalMs: envNum('UPDATE_INTERVAL_MS', 2000),
    minOrderUsd: envNum('MIN_ORDER_USD', 1),
    volumeSafetyMargin: envNum('VOLUME_SAFETY_MARGIN', 1.05),
    rateLimitMs: envNum('RATE_LIMIT_MS', 400),
    dustUsd: envNum('DUST_USD', 0.5),
    rebalanceTolerancePct: envNum('REBALANCE_TOLERANCE_PCT', 0.03),
    gamma: envNum('GAMMA', 0.1),
    kappa: envNum('KAPPA', 1.5),
    volWindow: envNum('VOL_WINDOW', 30),
    minHalfSpreadBps: envNum('MIN_HALF_SPREAD_BPS', 10),
    maxHalfSpreadBps: envNum('MAX_HALF_SPREAD_BPS', 80),
    requoteMoveBps: envNum('REQUOTE_MOVE_BPS', 8),
    minEdgeBps: envNum('MIN_EDGE_BPS', 25),
    feeBpsCoinbase: envNum('FEE_BPS_COINBASE', 6),
    feeBpsKraken: envNum('FEE_BPS_KRAKEN', 16),
    maxNotionalPerTrade: envNum('MAX_NOTIONAL_PER_TRADE', 50),
    maxGrossExposure: envNum('MAX_GROSS_EXPOSURE', 250),
    cooldownMs: envNum('COOLDOWN_MS', 3000),
  };
}

export const STABLECOINS = new Set([
  'USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDP', 'GUSD', 'FRAX',
  'USDD', 'USDE', 'PYUSD', 'EURC', 'EURT', 'AGEUR', 'USD',
]);
export const KEEP_ASSETS = new Set([
  'USD', 'ZUSD', 'USDT', 'USDC', 'DAI', 'EUR', 'ZEUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY',
]);
