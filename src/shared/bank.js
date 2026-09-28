import { setTimeout as sleep } from 'timers/promises';
import { coinbaseRequest } from './coinbase.js';
import { formatVolume, calculateVolume, safeQuoteSize, safeSpend } from './sizing.js';

function bankName() {
  return String(process.env.BANK_PORTFOLIO || 'trade bot bank').trim();
}

let bankedUsd = 0;
export function bankedTotalUsd() { return bankedUsd; }
export function noteBankedUsd(n) { const v = Number(n); if (v > 0) bankedUsd += v; }

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
  return { source, bank };
}

async function moveFunds(cfg, sourceUuid, bankUuid, currency, value) {
  const amt = Number(value);
  if (!(amt > 0)) return false;
  await coinbaseRequest(cfg, 'POST', '/api/v3/brokerage/portfolios/move_funds', {
    funds: { value: String(amt), currency: String(currency).toUpperCase() },
    source_portfolio_uuid: sourceUuid,
    target_portfolio_uuid: bankUuid,
  });
  console.log('  BANK move ' + amt + ' ' + currency);
  return true;
}

export async function skimToBank(cfg, live, fraction, onlySymbols = null) {
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
        if (await moveFunds(cfg, ports.source.uuid, ports.bank.uuid, cfg.quote, cash.toFixed(8))) noteBankedUsd(cash);
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
        noteBankedUsd(Number(send) * (pos.mid || 0));
      }
    } catch (e) { console.warn('bank move ' + sym, e.message); }
    await sleep(cfg.rateLimitMs || 200);
  }
}

export async function liquidateSymbols(cfg, ex, live, symbols) {
  for (const sym of symbols) {
    const pos = live.positions[sym];
    if (!pos || !(pos.amount > 0) || !pos.pair) continue;
    const sellAmt = formatVolume(pos.amount * 0.99, pos.lotDecimals);
    if (sellAmt < (pos.ordermin || 0) * (cfg.volumeSafetyMargin || 1.05)) {
      console.log('  skip liq ' + sym + ' below min');
      continue;
    }
    console.log('  MARKET SELL ' + sellAmt + ' ' + sym + ' (leave rotation)');
    try { await ex.marketSell(pos.pair, sellAmt); } catch (e) { console.warn('  liq ' + sym, e.message); }
    await sleep(cfg.rateLimitMs || 200);
  }
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
  const perms = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/key_permissions');
  if (perms.can_transfer === false) {
    throw new Error('Bank API key can_transfer=false — enable Transfer on the bank key');
  }
  const data = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/portfolios');
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
  console.log('dump ' + (pct * 100) + '%  ' + bank.name + ' (' + bank.uuid + ') -> ' + trade.name + ' (' + trade.uuid + ')');
  const accts = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/accounts?limit=250');
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
      await moveFunds(cfg, bank.uuid, trade.uuid, cur, send);
      moved += 1;
    } catch (e) {
      console.warn('dump skip ' + cur, e.message);
    }
    await sleep(200);
  }
  console.log('dump done moves=' + moved);
  return moved;
}
