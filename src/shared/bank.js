import { setTimeout as sleep } from 'timers/promises';
import { coinbaseRequest } from './coinbase.js';

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

export async function resolvePortfolios(cfg) {
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
  return { source, bank };
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
  const uuid = lastBankUuid || bankUuid;
  if (!uuid || cfg.exchange !== 'coinbase') return lastBankHoldings;
  if (!lastBankUuid) lastBankUuid = uuid;
  const auth = bankAuthCfg(cfg);
  if (auth === cfg && !(process.env.BANK_COINBASE_API_KEY || process.env.BANK_API_KEY)) {
    console.warn('bank refresh skipped: set BANK_COINBASE_API_KEY (+ SECRET or SECRET_FILE) for the bank portfolio key');
    return lastBankHoldings;
  }
  const data = await coinbaseRequest(auth, 'GET', '/api/v3/brokerage/portfolios/' + uuid);
  const p = data.portfolio || data;
  const spots = p.spot_positions || [];
  lastBankHoldings = spots.map((s) => ({
    asset: String(s.asset || s.currency || '').toUpperCase(),
    qty: Number(s.total_balance_crypto || s.available || s.total || 0),
  })).filter((x) => x.asset && x.qty > 0);
  return lastBankHoldings;
}

export async function skimToBank(cfg, live, fraction, onlySymbols = null, kind = 'run') {
  if (cfg.exchange !== 'coinbase' || cfg.dryRun) return;
  const pct = Number(fraction);
  if (!(pct > 0)) return;
  let ports;
  try { ports = await resolvePortfolios(cfg); } catch (e) { console.warn('bank list', e.message); return; }
  if (!ports) return;
  const filter = onlySymbols ? new Set(onlySymbols.map((s) => String(s).toUpperCase())) : null;
  if (!filter) {
    const cash = (live.freeQuote || 0) * pct;
    if (cash >= 0.01) {
      try {
        if (await moveFunds(cfg, ports.source.uuid, ports.bank.uuid, cfg.quote, cash.toFixed(8))) noteBankedUsd(cash, kind);
      } catch (e) { console.warn('bank move ' + cfg.quote, e.message); }
    }
  }
  for (const [sym, pos] of Object.entries(live.positions || {})) {
    if (filter && !filter.has(sym)) continue;
    const qty = (pos.amount || 0) * pct;
    if (!(qty > 0)) continue;
    const send = formatVolume(qty, pos.lotDecimals != null ? pos.lotDecimals : 8);
    if (!(Number(send) > 0)) continue;
    try {
      if (await moveFunds(cfg, ports.source.uuid, ports.bank.uuid, pos.currency || sym, send)) {
        noteBankedUsd(Number(send) * (pos.mid || 0), kind);
      }
    } catch (e) { console.warn('bank move ' + sym, e.message); }
    await sleep(cfg.rateLimitMs || 200);
  }
  try { await refreshBankHoldings(cfg, ports.bank.uuid); } catch (e) { console.warn('bank holdings', e.message); }
}

export async function liquidateSymbols(cfg, ex, live, symbols, productMap = null) {
  const jobs = [];
  const gap = Number(process.env.SELL_STAGGER_MS || 40);
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
    const sellAmt = formatVolume(amt * 0.99, lot);
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
  let budget = safeSpend(cfg, live.freeQuote);
  const each = mmAlloc.length ? budget / mmAlloc.length : 0;
  for (const a of mmAlloc) {
    const held = (live.positions[a.symbol] && live.positions[a.symbol].valueQuote) || 0;
    const target = a.invTargetQuote || each * (cfg.mmInventoryFraction || 0.5);
    const gap = target - held;
    if (gap < cfg.minOrderUsd || budget < cfg.minOrderUsd) continue;
    const spend = Math.min(gap, budget * 0.98);
    const book = await ex.getBook(a.pair);
    if (!book) continue;
    const vol = calculateVolume(cfg, book.mid, safeQuoteSize(cfg, spend), a.ordermin, a.lotDecimals);
    console.log('  seed ' + a.symbol + ' buy ~' + spend.toFixed(2));
    try { if (await ex.marketBuy(a.pair, vol, spend)) budget -= spend; } catch (e) { console.warn('  seed ' + a.symbol, e.message); }
    await sleep(cfg.rateLimitMs || 200);
  }
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
  let moved = 0;
  for (const a of rows) {
    const cur = String(a.currency || (a.available_balance && a.available_balance.currency) || '').toUpperCase();
    const avail = parseFloat((a.available_balance && (a.available_balance.value || a.available_balance.amount)) || a.available || 0) || 0;
    const qty = avail * pct;
    if (!cur || !(qty > 0)) continue;
    const send = qty >= 1 ? qty.toFixed(8) : String(qty);
    if (!(Number(send) > 0)) continue;
    try {
      await moveFunds(auth, bank.uuid, trade.uuid, cur, send);
      moved += 1;
    } catch (e) {
      console.warn('dump skip ' + cur, e.message);
    }
    await sleep(200);
  }
  console.log('dump done moves=' + moved);
  return moved;
}
