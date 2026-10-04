import { setTimeout as sleep } from 'timers/promises';
import { coinbaseRequest } from './coinbase.js';
import { invalidateLiveCache } from './portfolio.js';

export function bankAuthCfg(cfg) {
  const key = process.env.BANK_COINBASE_API_KEY || process.env.BANK_API_KEY || process.env.COINBASE_BANK_API_KEY || '';
  if (!key) return cfg;
  return {
    ...cfg,
    coinbaseApiKey: key,
    coinbaseApiSecret: process.env.BANK_COINBASE_API_SECRET || process.env.BANK_API_SECRET || process.env.COINBASE_BANK_API_SECRET || '',
    coinbaseSecretFile: process.env.BANK_COINBASE_API_SECRET_FILE || process.env.BANK_API_SECRET_FILE || process.env.COINBASE_BANK_API_SECRET_FILE || '',
  };
}
import { formatVolume, calculateVolume, safeQuoteSize, safeSpend } from './sizing.js';

function bankName() {
  return String(process.env.BANK_PORTFOLIO || 'trade bot bank').trim();
}

let bankedUsd = 0;
let bankedStartUsd = 0;
export function bankedTotalUsd() { return bankedUsd; }
export function bankedStartTotalUsd() { return bankedStartUsd; }
export function bankedRunUsd() { return Math.max(0, bankedUsd - bankedStartUsd); }
export function noteBankedUsd(n, kind = 'run') {
  const v = Number(n);
  if (!(v > 0)) return;
  bankedUsd += v;
  if (kind === 'startup') bankedStartUsd += v;
}

let cachedPorts = null;
export async function resolvePortfolios(cfg) {
  if (cachedPorts && cachedPorts.source && cachedPorts.bank) return cachedPorts;
  let perms = {};
  try {
    perms = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/key_permissions');
  } catch (e) {
    console.warn('bank key_permissions', e.message);
  }
  if (perms.can_transfer === false) {
    console.warn('bank: API key has can_transfer=false — enable Transfer when creating the key');
    return null;
  }
  const data = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/portfolios');
  const list = data.portfolios || [];
  const want = bankName().toLowerCase();
  const bank = list.find((p) => String(p.name || '').trim().toLowerCase() === want);
  if (!bank) {
    console.warn('bank portfolio not found: "' + bankName() + '" have=' + list.map((p) => p.name).join(', '));
    return null;
  }
  const keyUuid = process.env.COINBASE_PORTFOLIO_UUID || perms.portfolio_uuid;
  const source =
    list.find((p) => String(p.uuid) === String(keyUuid || '')) ||
    list.find((p) => String(p.type || '').toUpperCase() === 'DEFAULT') ||
    list.find((p) => p.uuid !== bank.uuid);
  if (!source || source.uuid === bank.uuid) {
    console.warn('bank: could not resolve source portfolio (key uuid=' + (keyUuid || '?') + ')');
    return null;
  }
  console.log('bank source=' + source.name + ' (' + source.uuid + ') -> ' + bank.name + ' (' + bank.uuid + ') transfer=' + perms.can_transfer);
  lastBankUuid = bank.uuid;
  cachedPorts = { source, bank };
  return cachedPorts;
}

async function moveFunds(cfg, sourceUuid, targetUuid, currency, value) {
  const amt = Number(value);
  if (!(amt > 0)) return false;
  await coinbaseRequest(cfg, 'POST', '/api/v3/brokerage/portfolios/move_funds', {
    funds: { value: String(amt), currency: String(currency).toUpperCase() },
    source_portfolio_uuid: sourceUuid,
    target_portfolio_uuid: targetUuid,
  });
  console.log('  BANK move ' + amt + ' ' + currency);
  invalidateLiveCache();
  const snap = lastBankUuid || null;
  if (snap) {
    try { await refreshBankHoldings(cfg, snap); } catch (e) { console.warn('bank refresh', e.message); }
  }
  return true;
}

let lastBankHoldings = [];
let lastBankUuid = null;
export function bankHoldings() { return lastBankHoldings; }

export async function refreshBankHoldings(cfg, bankUuid) {
  if (cfg.exchange !== 'coinbase') return lastBankHoldings;
  const auth = bankAuthCfg(cfg);
  if (!(auth.coinbaseApiKey && (auth.coinbaseApiSecret || auth.coinbaseSecretFile))) return lastBankHoldings;
  const uuid = lastBankUuid || bankUuid || process.env.BANK_PORTFOLIO_UUID || '';
  if (uuid && !lastBankUuid) lastBankUuid = uuid;
  try {
    if (uuid) {
      const data = await coinbaseRequest(auth, 'GET', '/api/v3/brokerage/portfolios/' + uuid);
      const p = data.portfolio || data;
      const spots = p.spot_positions || [];
      lastBankHoldings = spots.map((s) => ({
        asset: String(s.asset || s.currency || '').toUpperCase(),
        qty: Number(s.total_balance_crypto || s.available_balance || s.available || s.total || 0),
      })).filter((x) => x.asset && x.qty > 0);
    }
  } catch (e) {
    console.warn('bank portfolio get', e.message);
  }
  if (!lastBankHoldings.length) {
    try {
      const accts = await coinbaseRequest(auth, 'GET', '/api/v3/brokerage/accounts?limit=250');
      lastBankHoldings = (accts.accounts || []).map((a) => ({
        asset: String(a.currency || '').toUpperCase(),
        qty: Number((a.available_balance && a.available_balance.value) || 0) + Number((a.hold && a.hold.value) || 0),
      })).filter((x) => x.asset && x.qty > 0);
    } catch (e) {
      console.warn('bank accounts get', e.message);
    }
  }
  return lastBankHoldings;
}

export async function skimToBank(cfg, live, fraction, onlySymbols = null, kind = 'run', getLive = null) {
  if (cfg.exchange !== 'coinbase' || cfg.dryRun) return;
  const pct = Number(fraction);
  if (!(pct > 0)) return;
  invalidateLiveCache();
  if (typeof getLive === 'function') {
    try { live = await getLive(); } catch (e) { console.warn('bank refresh live', e.message); }
  }
  let ports;
  try { ports = await resolvePortfolios(cfg); } catch (e) { console.warn('bank list', e.message); return; }
  if (!ports) return;
  const filter = onlySymbols ? new Set(onlySymbols.map((s) => String(s).toUpperCase())) : null;
  const jobs = [];
  if (!filter) {
    const cash = (live.freeQuote || 0) * pct;
    if (cash >= 0.01) jobs.push({ cur: cfg.quote, send: cash.toFixed(8), usd: cash });
  }
  for (const [sym, pos] of Object.entries(live.positions || {})) {
    if (filter && !filter.has(sym)) continue;
    const avail = Number(pos.amount || 0);
    const qty = avail * pct;
    if (!(qty > 0)) continue;
    let send = formatVolume(qty, pos.lotDecimals != null ? pos.lotDecimals : 8);
    if (Number(send) > avail) send = String((avail * 0.97).toFixed(8));
    if (!(Number(send) > 0)) send = String(qty);
    if (!(Number(send) > 0)) continue;
    jobs.push({ cur: pos.currency || sym, send, usd: Number(send) * (pos.mid || 0) });
  }
  const gap = Number(process.env.BANK_STAGGER_MS || 250);
  await Promise.all(jobs.map((j, i) => sleep(i * gap).then(async () => {
    try {
      if (await moveFunds(cfg, ports.source.uuid, ports.bank.uuid, j.cur, j.send)) noteBankedUsd(j.usd, kind);
    } catch (e) {
      const msg = String(e.message || e);
      if (/INSUFFICIENT|insufficient/i.test(msg) && Number(j.send) > 0) {
        const retry = String((Number(j.send) * 0.5).toFixed(8));
        console.warn('bank retry ' + j.cur + ' ' + j.send + ' -> ' + retry);
        try {
          if (Number(retry) > 0 && await moveFunds(cfg, ports.source.uuid, ports.bank.uuid, j.cur, retry)) {
            noteBankedUsd(Number(retry) * (j.usd / Number(j.send) || 0), kind);
          }
        } catch (e2) { console.warn('bank move ' + j.cur, e2.message); }
      } else console.warn('bank move ' + j.cur, msg);
    }
  })));
  try { await refreshBankHoldings(cfg, ports.bank.uuid); } catch (e) { console.warn('bank holdings', e.message); }
}

export async function liquidateSymbols(cfg, ex, live, symbols, productMap = null) {
  if (!['1', 'true', 'yes'].includes(String(process.env.ALLOW_MARKET_EXIT || '0').toLowerCase())) {
    console.log('  skip market exit n=' + symbols.length + ' ALLOW_MARKET_EXIT=0');
    return;
  }
  const jobs = [];
  const gap = Number(process.env.SELL_STAGGER_MS || 250);
  for (const raw of symbols) {
    const sym = String(raw || '');
    const pos = (live.positions && (live.positions[sym] || live.positions[sym.toUpperCase()])) || {};
    const info = productMap && (productMap[sym] || productMap[sym.toUpperCase()]);
    const pair = pos.pair || (info && info.pair);
    const lot = pos.lotDecimals != null ? pos.lotDecimals : (info && info.lotDecimals);
    const min = pos.ordermin || (info && info.ordermin) || 0;
    const amt = Number(pos.amount || 0);
    if (!(amt > 0) || !pair) {
      console.log('  skip liq ' + sym + ' amt=' + amt + ' pair=' + (pair || 'none'));
      continue;
    }
    const sellAmt = formatVolume(amt * 0.95, lot);
    if (sellAmt < min * (cfg.volumeSafetyMargin || 1.05)) {
      console.log('  skip liq ' + sym + ' below min amt=' + sellAmt);
      continue;
    }
    jobs.push({ sym, pair, sellAmt });
  }
  await Promise.all(jobs.map((j, i) => sleep(i * gap).then(async () => {
    console.log('  MARKET SELL ' + j.sellAmt + ' ' + j.sym + ' (leave rotation)');
    try { await ex.marketSell(j.pair, j.sellAmt); }
    catch (e) { console.warn('  liq ' + j.sym, e.message); }
  })));
}

export async function seedNewInventory(cfg, ex, mmAlloc, live) {
  if (String(process.env.SEED_MODE || 'off').toLowerCase() === 'off') {
    console.log('  seed off, bids will build inventory');
    return;
  }
  let budget = safeSpend(cfg, live.freeQuote);
  const each = mmAlloc.length ? budget / mmAlloc.length : 0;
  const jobs = [];
  for (const a of mmAlloc) {
    const held = (live.positions[a.symbol] && live.positions[a.symbol].valueQuote) || 0;
    const target = a.invTargetQuote || each * (cfg.mmInventoryFraction || 0.5);
    const need = target - held;
    if (need < cfg.minOrderUsd || budget < cfg.minOrderUsd) continue;
    const spend = Math.min(need, budget * 0.98);
    budget -= spend;
    jobs.push({ a, spend });
  }
  const gap = Number(process.env.SELL_STAGGER_MS || 250);
  await Promise.all(jobs.map((j, i) => sleep(i * gap).then(async () => {
    try {
      const book = await ex.getBook(j.a.pair);
      if (!book) return;
      const vol = calculateVolume(cfg, book.mid, safeQuoteSize(cfg, j.spend), j.a.ordermin, j.a.lotDecimals);
      console.log('  seed ' + j.a.symbol + ' buy ~' + j.spend.toFixed(2));
      await ex.marketBuy(j.a.pair, vol, j.spend);
    } catch (e) { console.warn('  seed ' + j.a.symbol, e.message); }
  })));
}

export async function dumpBankToTrade(cfg, fraction) {
  const pct = Number(fraction);
  if (!(pct > 0 && pct <= 1)) throw new Error('fraction must be 0-1, got ' + fraction);
  const auth = bankAuthCfg(cfg);
  if (!(auth.coinbaseApiKey && (auth.coinbaseApiSecret || auth.coinbaseSecretFile))) {
    throw new Error('Set BANK_COINBASE_API_KEY and BANK_COINBASE_API_SECRET or BANK_COINBASE_API_SECRET_FILE');
  }
  const perms = await coinbaseRequest(auth, 'GET', '/api/v3/brokerage/key_permissions');
  if (perms.can_transfer === false) {
    throw new Error('Bank API key can_transfer=false — enable Transfer on the bank key');
  }
  const data = await coinbaseRequest(auth, 'GET', '/api/v3/brokerage/portfolios');
  const list = data.portfolios || [];
  const bankWant = bankName().toLowerCase();
  const tradeWant = String(process.env.TRADE_PORTFOLIO || process.env.TRADE_BOT_PORTFOLIO || '').trim().toLowerCase();
  const bank = list.find((p) => String(p.name || '').trim().toLowerCase() === bankWant)
    || list.find((p) => String(p.uuid) === String(perms.portfolio_uuid || ''));
  const trade = (tradeWant && list.find((p) => String(p.name || '').trim().toLowerCase() === tradeWant))
    || list.find((p) => String(p.uuid) === String(process.env.COINBASE_PORTFOLIO_UUID || ''))
    || list.find((p) => String(p.type || '').toUpperCase() === 'DEFAULT')
    || list.find((p) => bank && p.uuid !== bank.uuid);
  if (!bank || !trade) {
    throw new Error('Need bank + trade portfolios. have=' + list.map((p) => p.name + '/' + p.uuid).join(', '));
  }
  if (bank.uuid === trade.uuid) throw new Error('Bank and trade resolved to the same portfolio ' + bank.name);
  lastBankUuid = bank.uuid;
  console.log('dump ' + (pct * 100) + '%  ' + bank.name + ' (' + bank.uuid + ') -> ' + trade.name + ' (' + trade.uuid + ')');
  const accts = await coinbaseRequest(auth, 'GET', '/api/v3/brokerage/accounts?limit=250');
  const rows = accts.accounts || [];
  const jobs = [];
  for (const a of rows) {
    const cur = String(a.currency || (a.available_balance && a.available_balance.currency) || '').toUpperCase();
    const avail = parseFloat((a.available_balance && (a.available_balance.value || a.available_balance.amount)) || a.available || 0) || 0;
    const qty = avail * pct;
    if (!cur || !(qty > 0)) continue;
    const send = qty >= 1 ? qty.toFixed(8) : String(qty);
    if (!(Number(send) > 0)) continue;
    jobs.push({ cur, send });
  }
  const gap = Number(process.env.BANK_STAGGER_MS || 250);
  const results = await Promise.all(jobs.map((j, i) => sleep(i * gap).then(async () => {
    try { await moveFunds(auth, bank.uuid, trade.uuid, j.cur, j.send); return 1; }
    catch (e) { console.warn('dump skip ' + j.cur, e.message); return 0; }
  })));
  const moved = results.reduce((s, n) => s + n, 0);
  console.log('dump done moves=' + moved);
  return moved;
}

export async function dumpTradeToBank(cfg, fraction) {
  const pct = Number(fraction);
  if (!(pct > 0 && pct <= 1)) throw new Error('fraction must be 0-1, got ' + fraction);
  const ports = await resolvePortfolios(cfg);
  if (!ports) throw new Error('Need bank + trade portfolios (trade API key)');
  const { source: trade, bank } = ports;
  console.log('dump ' + (pct * 100) + '%  ' + trade.name + ' (' + trade.uuid + ') -> ' + bank.name + ' (' + bank.uuid + ')');
  invalidateLiveCache();
  const data = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/accounts?limit=250');
  const jobs = [];
  for (const a of data.accounts || []) {
    const cur = String(a.currency || (a.available_balance && a.available_balance.currency) || '').toUpperCase();
    const avail = parseFloat((a.available_balance && (a.available_balance.value || a.available_balance.amount)) || a.available || 0) || 0;
    const qty = avail * pct;
    if (!cur || !(qty > 0)) continue;
    const send = qty >= 1 ? qty.toFixed(8) : String(qty);
    if (!(Number(send) > 0)) continue;
    jobs.push({ cur, send });
  }
  const gap = Number(process.env.BANK_STAGGER_MS || 250);
  const results = await Promise.all(jobs.map((j, i) => sleep(i * gap).then(async () => {
    try { await moveFunds(cfg, trade.uuid, bank.uuid, j.cur, j.send); return 1; }
    catch (e) { console.warn('dump skip ' + j.cur, e.message); return 0; }
  })));
  const moved = results.reduce((s, n) => s + n, 0);
  console.log('dump done moves=' + moved);
  try { await refreshBankHoldings(cfg, bank.uuid); } catch { /* ignore */ }
  return moved;
}
