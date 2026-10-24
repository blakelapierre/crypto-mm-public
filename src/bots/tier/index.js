import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { setTimeout as sleep } from 'timers/promises';
import { loadProjectEnv, baseConfig, envNum } from '../../shared/env.js';
import { createExchange } from '../../shared/exchange.js';
import { coinbaseRequest } from '../../shared/coinbase.js';
import { startCoinbaseUserWs, startCoinbaseTickerWs } from '../../shared/coinbase.js';
import { markOrderFromExchange, pollOpenOrders } from '../../shared/orders.js';
import { createPnl } from '../../shared/pnl.js';
import { fetchLivePortfolio, invalidateLiveCache } from '../../shared/portfolio.js';
import { createVolScan, setSizeUniverse, sizeWeightForSymbol } from '../../shared/vol-scan.js';
import { planRotation } from '../../shared/rotate.js';
import { refreshFeeTier } from '../../shared/fee-tier.js';
import { noteMid, remember } from '../../shared/mid-ring.js';
import { postStatus, postMids } from '../../shared/status-client.js';
import { formatVolume } from '../../shared/sizing.js';
import { offsetBps, trailDecision, nextBounds, weightedClips, effPairCap } from './quote.js';

loadProjectEnv(process.env.BOT_CONFIG || 'configs/tier.env');
const cfg = baseConfig();
cfg.volWindowMin = envNum('VOL_WINDOW_MIN', 15);
cfg.volScanMs = envNum('VOL_SCAN_MS', 60000);
cfg.postOnly = true;
const CID = 'tier-';
const statePath = path.resolve(process.cwd(), process.env.TIER_STATE || 'data/tier.json');
const orderRegistry = new Map();
const pnl = createPnl();
const ex = createExchange(cfg, orderRegistry);
const bounds = { askFloor: {}, bidCeil: {} };
const enteredAt = new Map();
const watch = new Map();
const noted = new Set();

function num(k, d) { return envNum(k, d); }
function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (j && j.askFloor) Object.assign(bounds.askFloor, j.askFloor);
    if (j && j.bidCeil) Object.assign(bounds.bidCeil, j.bidCeil);
    for (const [pair, t] of Object.entries((j && j.enteredAt) || {})) {
      const n = Number(t);
      if (n > 0) enteredAt.set(pair, n);
    }
  } catch { /* first run */ }
}
function saveState() {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const body = {
      askFloor: bounds.askFloor,
      bidCeil: bounds.bidCeil,
      enteredAt: Object.fromEntries(enteredAt),
    };
    const tmp = statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(body));
    fs.renameSync(tmp, statePath);
  } catch (e) { console.warn('state', e.message); }
}

function legOf(o) {
  const limit = ((o.order_configuration || {}).limit_limit_gtc) || ((o.order_configuration || {}).sor_limit_ioc) || {};
  return {
    id: o.order_id,
    product: o.product_id,
    side: String(o.side || '').toLowerCase(),
    price: Number(limit.limit_price || o.limit_price || 0),
    size: Number(limit.base_size || o.base_size || 0),
    client: String(o.client_order_id || ''),
  };
}

async function listAllOpen() {
  const rows = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    let p = '/api/v3/brokerage/orders/historical/batch?order_status=OPEN&limit=100';
    if (cursor) p += '&cursor=' + encodeURIComponent(cursor);
    const data = await coinbaseRequest(cfg, 'GET', p);
    rows.push(...(data.orders || []));
    cursor = data.has_next ? (data.cursor || '') : '';
    if (!cursor) break;
  }
  return rows;
}

async function cancelIds(ids, why) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return;
  console.log('TIER cancel n=' + list.length + ' why=' + why);
  if (cfg.dryRun) return;
  for (let i = 0; i < list.length; i += 50) {
    const part = list.slice(i, i + 50);
    try { await coinbaseRequest(cfg, 'POST', '/api/v3/brokerage/orders/batch_cancel', { order_ids: part }); }
    catch (e) { console.warn('cancel', e.message); }
  }
  for (const id of list) {
    const rec = orderRegistry.get(id);
    if (rec && rec.status === 'open') rec.status = 'cancelled';
  }
  invalidateLiveCache();
}

async function cancelPrefix(prefix) {
  let open = [];
  try { open = await listAllOpen(); }
  catch (e) { console.warn('list open', e.message); return; }
  const ids = [];
  for (const o of open) {
    if (String(o.client_order_id || '').startsWith(prefix) && o.order_id) ids.push(o.order_id);
  }
  await cancelIds(ids, prefix);
}

function seedVol(history, windowMs) {
  const files = ['logs/px-as-cb.jsonl', 'logs/px-ladder.jsonl', 'logs/px-tier.jsonl'];
  const cut = Date.now() - windowMs;
  let n = 0;
  for (const rel of files) {
    const p = path.resolve(process.cwd(), rel);
    if (!fs.existsSync(p)) continue;
    try {
      const st = fs.statSync(p);
      const take = Math.min(st.size, 8 * 1024 * 1024);
      const start = Math.max(0, st.size - take);
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(take);
      fs.readSync(fd, buf, 0, take, start);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift();
      let day = null;
      for (const line of lines) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (!Array.isArray(row)) continue;
        if (row[0] === 0 && row[1]) { day = row[1]; continue; }
        if (row[0] !== 1 || !day) continue;
        const t = Date.parse(String(day) + 'T00:00:00.000Z') + Number(row[1] || 0);
        const sym = String(row[2] || '').toUpperCase();
        const mid = Number(row[3]);
        if (!sym || !(mid > 0) || !(t >= cut)) continue;
        const arr = history.get(sym) || [];
        const prev = arr[arr.length - 1];
        if (prev && t - prev.t < 20000) prev.mid = mid;
        else arr.push({ t, mid });
        history.set(sym, arr);
        remember(sym, mid, t);
        n += 1;
      }
    } catch (e) { console.warn('seed vol', rel, e.message); }
  }
  if (n) console.log('TIER seeded vol n=' + n + ' symbols=' + history.size);
}

function noteFill(rec, bps) {
  if (!rec || rec.tierNoted || rec.status !== 'filled') return;
  rec.tierNoted = true;
  const sym = String(rec.symbol || String(rec.pair || '').split(/[-/]/)[0] || '').toUpperCase();
  const px = Number(rec.price);
  if (!sym || !(px > 0)) return;
  const next = nextBounds({ side: rec.side, fillPx: px, offsetBps: bps });
  if (!(next.complementPx > 0)) return;
  bounds.askFloor[sym] = next.askFloor;
  bounds.bidCeil[sym] = next.bidCeil;
  if (!(next.askFloor > 0)) delete bounds.askFloor[sym];
  if (!(next.bidCeil > 0)) delete bounds.bidCeil[sym];
  noted.add(rec.orderId || sym + px);
  console.log('TIER FILL ' + rec.side + ' ' + sym + ' @ ' + px + ' -> ' + next.complementSide + ' ' + next.complementPx);
  saveState();
}

async function vanishedFills(openIds) {
  for (const [id, rec] of orderRegistry) {
    if (!rec || rec.status !== 'open') continue;
    if (openIds.has(id)) continue;
    if (Date.now() - Number(rec.placedAt || 0) < 8000) continue;
    try {
      const st = await ex.getOrderStatus(id);
      if (st && st.status) markOrderFromExchange(orderRegistry, id, st.status, pnl, st);
    } catch { /* next loop */ }
  }
}

async function send(a, side, px, baseQty) {
  const lot = Number.isFinite(Number(a.lotDecimals)) ? a.lotDecimals : 8;
  const vol = formatVolume(baseQty, lot);
  const minV = Number(a.baseMin || a.ordermin || 0);
  const quoteMin = Number(a.quoteMin || num('MIN_ORDER_USD', 1));
  if (!(vol > 0) || vol + 1e-12 < minV || vol * px + 1e-12 < quoteMin) {
    console.log('TIER skip ' + side + ' ' + a.symbol + ' below min vol=' + vol);
    return null;
  }
  const cid = CID + randomUUID();
  console.log('TIER ' + side + ' ' + a.symbol + ' ' + vol + ' @ ' + px);
  const r = await ex.limitOrder(a.pair, side, px, vol, { clientOrderId: cid, level: 1, why: 'tier' });
  if (!r || r.error || r.skipped) {
    console.log('TIER REJECT ' + a.symbol + ' ' + side + ' ' + (r && (r.error || r.skipped) || 'none'));
    return null;
  }
  const id = r.order_id || r.orderId;
  if (id && orderRegistry.has(id)) {
    const rec = orderRegistry.get(id);
    rec.symbol = a.symbol;
    rec.clientOrderId = cid;
    rec.placedAt = rec.placedAt || Date.now();
  }
  return id || null;
}

async function main() {
  loadState();
  console.log('tier products');
  const productMap = await ex.getProducts();
  console.log('tier products ' + Object.keys(productMap).length);
  await cancelPrefix('as-cb-');
  const volScan = createVolScan(cfg, productMap);
  seedVol(volScan.history, cfg.volWindowMin * 60 * 1000);
  try {
    const n = await volScan.tick();
    console.log('tier scan n=' + n);
  } catch (e) { console.warn('vol', e.message); }

  const mmAlloc = [];
  let ticker = { close() {} };
  let tickerKey = '';
  function retarget(pairs) {
    const key = pairs.slice().sort().join(',');
    if (key === tickerKey) return;
    tickerKey = key;
    try { ticker.close(); } catch { /* ignore */ }
    ticker = startCoinbaseTickerWs(pairs, (tk) => {
      for (const a of mmAlloc) {
        if (String(a.pair).toUpperCase() !== String(tk.pair || '').toUpperCase()) continue;
        noteMid(a.symbol, tk.mid);
        postMids([{ symbol: a.symbol, pair: a.pair, mid: tk.mid, bid: tk.bid, ask: tk.ask }]);
      }
    });
  }
  if (cfg.useUserWebsocket) {
    startCoinbaseUserWs(cfg, (id, st, d) => markOrderFromExchange(orderRegistry, id, st, pnl, d));
  }

  let lastScan = Date.now();
  let lastRotate = 0;
  let lastProducts = Date.now();
  let offShown = 0;
  let bookShown = '';
  let bookAt = 0;
  const loopMs = num('TIER_LOOP_MS', 4000);
  console.log('tier loop ' + loopMs + 'ms post-only edge=' + num('TIER_EDGE_BPS', 10) + 'bp');

  while (true) {
    try {
      if (Date.now() - lastProducts > num('PRODUCTS_REFRESH_MS', 1800000)) {
        lastProducts = Date.now();
        try {
          const next = await ex.getProducts();
          for (const k of Object.keys(productMap)) if (!next[k]) delete productMap[k];
          Object.assign(productMap, next);
        } catch (e) { console.warn('products', e.message); }
      }
      if (Date.now() - lastScan >= cfg.volScanMs) {
        lastScan = Date.now();
        try {
          await volScan.tick();
          const top = volScan.ranking().slice(0, 6);
          if (top.length) console.log('TIER vol ' + top.map((r) => r.symbol + ' ' + Number(r.rangePct).toFixed(2) + '%').join('  '));
        } catch (e) { console.warn('vol', e.message); }
      }
      const ranked = volScan.ranking();
      let live = null;
      try { live = await fetchLivePortfolio(cfg, ex, productMap); }
      catch (e) { console.warn('portfolio', e.message); }
      const now = Date.now();
      if (live && ranked.length && now - lastRotate >= num('VOL_ROTATE_MS', 60000)) {
        lastRotate = now;
        const cash = Number(live.freeQuote || 0);
        const inv = Math.max(0, Number(live.totalEquity || 0) - cash);
        const cap = effPairCap({
          equity: cash + inv,
          maxPairs: num('MM_MAX_PAIRS', cfg.mmMaxPairs || 6),
          minUsd: Math.max(cfg.minOrderUsd || 1, 1),
          cashK: num('PAIR_CASH_K', 2.5),
        });
        process.env.MM_MAX_PAIRS_HARD = String(cap);
        const plan = planRotation({
          mmAlloc, ranked, now, enteredAt, watch, live,
          cfg: { ...cfg, preview: () => true },
        });
        if (plan.leaving.length || plan.additions.length) {
          console.log('TIER exit ' + (plan.leaving.map((a) => a.symbol).join(',') || '-') + ' enter ' + (plan.additions.map((a) => a.symbol + ' ' + Number(a.rangePct).toFixed(2) + '%').join(',') || '-'));
          let open = [];
          try { open = await listAllOpen(); } catch { open = []; }
          const leave = new Set(plan.leaving.map((a) => a.pair));
          const ids = [];
          for (const o of open) {
            if (!leave.has(o.product_id)) continue;
            if (!String(o.client_order_id || '').startsWith(CID)) continue;
            if (o.order_id) ids.push(o.order_id);
          }
          await cancelIds(ids, 'rotate');
          for (const a of plan.leaving) {
            watch.set(a.pair, { ...a, leftAt: now });
            enteredAt.delete(a.pair);
          }
          mmAlloc.length = 0;
          for (const a of [...plan.keep, ...plan.additions]) {
            mmAlloc.push(a);
            if (!enteredAt.has(a.pair)) enteredAt.set(a.pair, now);
          }
          saveState();
        }
      }
      setSizeUniverse(mmAlloc.map((a) => a.symbol));
      retarget(mmAlloc.map((a) => a.pair).filter(Boolean));

      let tier = null;
      try { tier = await refreshFeeTier(cfg); } catch { tier = null; }
      const off = offsetBps({
        makerBps: tier && tier.makerBps,
        edgeBps: num('TIER_EDGE_BPS', 10),
        fallbackBps: num('MAKER_FEE_BPS', 35),
      });
      if (off !== offShown) {
        offShown = off;
        const src = tier && tier.makerBps > 0 ? 'venue' : 'fallback';
        console.log('TIER offset=' + off + 'bp src=' + src + (tier && tier.tier ? ' tier=' + tier.tier : ''));
      }
      for (const rec of orderRegistry.values()) noteFill(rec, off);

      let open = null;
      try { open = await listAllOpen(); }
      catch (e) { console.warn('open', e.message); open = null; }
      if (!open) {
        console.warn('TIER skip quote, open orders unknown');
        await sleep(loopMs);
        continue;
      }
      const openIds = new Set();
      const byKey = new Map();
      if (open) {
        const extra = [];
        for (const o of open) {
          const leg = legOf(o);
          if (!leg.client.startsWith(CID) || !leg.id) continue;
          openIds.add(leg.id);
          const sym = String(leg.product || '').split('-')[0].toUpperCase();
          if (!orderRegistry.has(leg.id)) {
            orderRegistry.set(leg.id, {
              orderId: leg.id, pair: leg.product, symbol: sym, side: leg.side,
              status: 'open', price: leg.price, size: leg.size, placedAt: Date.now(),
              clientOrderId: leg.client, why: 'tier',
            });
          }
          const key = leg.product + ':' + leg.side;
          if (byKey.has(key)) extra.push(leg.id);
          else byKey.set(key, leg);
        }
        if (extra.length) await cancelIds(extra, 'dup');
        await vanishedFills(openIds);
        for (const rec of orderRegistry.values()) noteFill(rec, off);
      }

      const inSet = new Set(mmAlloc.map((a) => a.pair));
      if (open) {
        const stray = [];
        for (const leg of byKey.values()) {
          if (!inSet.has(leg.product)) stray.push(leg.id);
        }
        if (stray.length) await cancelIds(stray, 'not-selected');
      }

      const ordered = [...mmAlloc].sort((a, b) => sizeWeightForSymbol(b.symbol) - sizeWeightForSymbol(a.symbol));
      const weights = ordered.map((a) => sizeWeightForSymbol(a.symbol));
      const free = live ? Number(live.freeQuote || 0) : 0;
      const clips = weightedClips(weights, {
        free,
        reserve: num('CASH_RESERVE_USD', 0.1),
        minUsd: Math.max(cfg.minOrderUsd || 1, 1),
        maxUsd: num('CLIP_MAX_USD', 1.5),
      });
      let cashLeft = Math.max(0, free - num('CASH_RESERVE_USD', 0.1));
      const hyst = num('TIER_HYST_BPS', 2);
      const markets = [];

      for (let i = 0; i < ordered.length; i++) {
        const a = ordered[i];
        let book = null;
        try { book = await ex.getBook(a.pair); } catch (e) { console.warn('book', a.symbol, e.message); }
        if (!book || !(book.mid > 0)) continue;
        noteMid(a.symbol, book.mid);
        const bidLeg = byKey.get(a.pair + ':buy');
        const askLeg = byKey.get(a.pair + ':sell');
        const tick = Number(a.quoteIncrement) || 0;
        const bidDec = trailDecision({
          side: 'buy', mid: book.mid, offsetBps: off,
          resting: bidLeg ? bidLeg.price : 0,
          bound: Number(bounds.bidCeil[a.symbol]) || 0,
          touchBid: book.bid, touchAsk: book.ask, tick, hystBps: hyst,
        });
        const pos = live && live.positions && live.positions[a.symbol];
        const avail = Number(pos && pos.amount || 0);
        const askQty = Math.max(0, avail) + (askLeg ? Number(askLeg.size || 0) : 0);
        const askNotional = askQty * book.mid;
        const canAsk = askQty + 1e-12 >= Number(a.baseMin || a.ordermin || 0) && askNotional + 1e-9 >= Number(a.quoteMin || cfg.minOrderUsd || 1);
        const askDec = canAsk || askLeg ? trailDecision({
          side: 'sell', mid: book.mid, offsetBps: off,
          resting: askLeg ? askLeg.price : 0,
          bound: Number(bounds.askFloor[a.symbol]) || 0,
          touchBid: book.bid, touchAsk: book.ask, tick, hystBps: hyst,
        }) : { action: 'skip', why: 'no-inv', px: 0 };
        await apply(a, 'buy', bidDec, bidLeg, clips[i], cashLeft, book.mid);
        if (bidDec.action === 'place' || bidDec.action === 'replace') {
          const usd = Math.min(Number(clips[i]) || 0, cashLeft);
          if (usd > 0) cashLeft -= usd;
        }
        await apply(a, 'sell', askDec, askLeg, clips[i], askQty, book.mid);
        markets.push({
          symbol: a.symbol, pair: a.pair, mid: book.mid,
          w: weights[i], bids: bidLeg ? 1 : 0, asks: askLeg ? 1 : 0,
          bidUsd: bidLeg ? bidLeg.price * bidLeg.size : 0,
          askUsd: askLeg ? askLeg.price * askLeg.size : 0,
        });
      }
      if (ordered.length) {
        const line = ordered.map((a, i) => a.symbol + (clips[i] ? ' $' + clips[i].toFixed(2) : ' bid0')).join(' ');
        if (line !== bookShown || now - bookAt > 60000) {
          bookShown = line;
          bookAt = now;
          console.log('TIER book ' + line + ' off=' + off + 'bp cash=' + free.toFixed(2));
        }
      }
      postStatus({
        bot: 'tier', exchange: cfg.exchange, quote: cfg.quote,
        pnl: pnl.snapshot(), equity: live && live.totalEquity, cash: free,
        markets, feeTier: tier, offsetBps: off,
        working: {
          bids: markets.reduce((s, m) => s + m.bidUsd, 0),
          asks: markets.reduce((s, m) => s + m.askUsd, 0),
        },
      });
    } catch (e) {
      console.warn('tier loop', e.message || e);
    }
    await sleep(loopMs);
  }

  async function apply(a, side, decision, resting, clipUsd, qtyOrCash, mid) {
    const drop = decision.action === 'skip' && resting && (decision.why === 'ceiling' || decision.why === 'floor' || decision.why === 'cross');
    if (drop) {
      await cancelIds([resting.id], decision.why);
      return;
    }
    if (decision.action === 'keep' || decision.action === 'skip') return;
    if (decision.action === 'replace' && resting) {
      await cancelIds([resting.id], decision.why);
      return;
    }
    if (decision.action !== 'place' && decision.action !== 'replace') return;
    if (!(decision.px > 0) || !(mid > 0)) return;
    let base;
    if (side === 'buy') {
      const usd = Math.min(Number(clipUsd) || 0, Number(qtyOrCash) || 0);
      if (!(usd >= Math.max(cfg.minOrderUsd || 1, 1))) return;
      base = usd / decision.px;
    } else {
      const clipBase = (Number(clipUsd) > 0 ? Number(clipUsd) : num('CLIP_MAX_USD', 1.5)) / decision.px;
      base = Math.min(Number(qtyOrCash) || 0, clipBase);
    }
    await send(a, side, decision.px, base);
  }
}

process.on('SIGTERM', () => { saveState(); process.exit(0); });
process.on('SIGINT', () => { saveState(); process.exit(0); });

main().catch((e) => {
  console.error('Fatal:', e.message || e);
  process.exit(1);
});
