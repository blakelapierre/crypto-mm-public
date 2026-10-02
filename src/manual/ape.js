import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { coinbaseRequest } from '../shared/coinbase.js';

const file = path.resolve(process.cwd(), 'data', 'ape-positions.json');
const positions = new Map();

function load() {
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const row of rows) if (row && row.symbol) positions.set(row.symbol, row);
  } catch { /* first run */ }
}
function save() {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([...positions.values()], null, 2));
}
load();

export function apeCfg() {
  return {
    exchange: 'coinbase',
    quote: 'USDC',
    postOnly: true,
    coinbaseApiKey: process.env.APE_COINBASE_API_KEY || '',
    coinbaseApiSecret: process.env.APE_COINBASE_API_SECRET || '',
    coinbaseSecretFile: process.env.APE_COINBASE_API_SECRET_FILE || '',
  };
}

export function apeReady() {
  const cfg = apeCfg();
  return !!(cfg.coinbaseApiKey && (cfg.coinbaseApiSecret || cfg.coinbaseSecretFile));
}

function snap(price, inc) {
  const step = Number(inc) || 0.01;
  const n = Math.floor((Number(price) + 1e-12) / step) * step;
  const decimals = (String(step).split('.')[1] || '').length;
  return n.toFixed(decimals);
}

async function product(symbol) {
  const id = String(symbol).toUpperCase() + '-USDC';
  const data = await coinbasePublic('/api/v3/brokerage/market/products/' + id);
  const p = data.product || data;
  return {
    id,
    base: p.base_increment || '0.00000001',
    quote: p.quote_increment || p.price_increment || '0.01',
    min: Number(p.base_min_size || 0),
  };
}

async function touch(id) {
  const cfg = apeCfg();
  const data = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/best_bid_ask?product_ids=' + encodeURIComponent(id));
  const row = (data.pricebooks || [])[0] || {};
  const bid = Number(row.bids && row.bids[0] && row.bids[0].price || 0);
  const ask = Number(row.asks && row.asks[0] && row.asks[0].price || 0);
  return { bid, ask, mid: bid && ask ? (bid + ask) / 2 : bid || ask };
}

async function place(cfg, pair, side, price, size) {
  const res = await coinbaseRequest(cfg, 'POST', '/api/v3/brokerage/orders', {
    client_order_id: randomUUID(),
    product_id: pair,
    side: side.toUpperCase(),
    order_configuration: {
      limit_limit_gtc: { base_size: String(size), limit_price: String(price), post_only: true },
    },
  });
  if (res.success === false || res.error_response) {
    const err = new Error((res.error_response && (res.error_response.message || res.error_response.error)) || 'order rejected');
    err.detail = res.error_response || res;
    throw err;
  }
  return (res.success_response && res.success_response.order_id) || res.order_id;
}

export async function apeBuy(symbol, usd) {
  const cfg = apeCfg();
  if (!apeReady()) throw new Error('set APE_COINBASE_API_KEY and APE_COINBASE_API_SECRET');
  const p = await product(symbol);
  const book = await touch(p.id);
  if (!(book.bid > 0)) throw new Error('no bid for ' + p.id);
  const px = snap(book.bid, p.quote);
  const size = snap(Number(usd) / Number(px), p.base);
  if (!(Number(size) > 0) || (p.min && Number(size) < p.min)) throw new Error('size below min ' + size);
  const id = await place(cfg, p.id, 'buy', px, size);
  const prev = positions.get(p.id.split('-')[0]) || { symbol: p.id.split('-')[0], qty: 0, cost: 0 };
  prev.qty += Number(size);
  prev.cost += Number(size) * Number(px);
  prev.lastBuy = { id, price: Number(px), size: Number(size), at: Date.now() };
  positions.set(prev.symbol, prev);
  save();
  return { ok: true, side: 'buy', symbol: prev.symbol, price: px, size, id, note: 'post-only at bid; qty is reserved until the order fills' };
}

export async function apeSell(symbol) {
  const cfg = apeCfg();
  if (!apeReady()) throw new Error('set APE_COINBASE_API_KEY and APE_COINBASE_API_SECRET');
  const sym = String(symbol).toUpperCase();
  const p = await product(sym);
  const accts = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/accounts?limit=250');
  const acct = (accts.accounts || []).find((a) => String(a.currency) === sym);
  const avail = Number(acct && acct.available_balance && acct.available_balance.value || 0);
  const held = positions.get(sym);
  const qty = avail > 0 ? avail : Number(held && held.qty || 0);
  const size = snap(qty, p.base);
  if (!(Number(size) > 0)) throw new Error('nothing to sell in ' + sym);
  const book = await touch(p.id);
  if (!(book.ask > 0)) throw new Error('no ask for ' + p.id);
  const px = snap(book.ask, p.quote);
  const id = await place(cfg, p.id, 'sell', px, size);
  if (held) {
    held.qty = Math.max(0, held.qty - Number(size));
    held.lastSell = { id, price: Number(px), size: Number(size), at: Date.now() };
    positions.set(sym, held);
    save();
  }
  return { ok: true, side: 'sell', symbol: sym, price: px, size, id };
}

export function apePositions() {
  return [...positions.values()];
}

export async function apePortfolios() {
  const cfg = apeCfg();
  if (!apeReady()) return { ready: false, portfolios: [] };
  const data = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/portfolios');
  return { ready: true, portfolios: (data.portfolios || []).map((p) => ({ uuid: p.uuid, name: p.name, type: p.type })) };
}

export async function apeMove(source, target, currency, amount) {
  const cfg = apeCfg();
  if (!apeReady()) throw new Error('ape key not set');
  await coinbaseRequest(cfg, 'POST', '/api/v3/brokerage/portfolios/move_funds', {
    funds: { value: String(amount), currency: String(currency).toUpperCase() },
    source_portfolio_uuid: source,
    target_portfolio_uuid: target,
  });
  return { ok: true };
}

export function apePage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>manual ape</title>
<style>
body{font:13px/1.4 ui-sans-serif,system-ui;background:#0e1116;color:#e7ecf3;margin:0}
header{padding:12px 16px;border-bottom:1px solid #30363d;display:flex;justify-content:space-between}
a{color:#58a6ff}
main{padding:16px;display:grid;grid-template-columns:1.2fr .8fr;gap:16px}
section{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px}
button{background:#21262d;color:#e7ecf3;border:1px solid #30363d;border-radius:6px;padding:4px 8px;cursor:pointer}
input,select{background:#0e1116;color:#e7ecf3;border:1px solid #30363d;border-radius:6px;padding:4px 6px}
table{width:100%;border-collapse:collapse} td,th{padding:4px;text-align:left}
.up{color:#3fb950}.dn{color:#f85149}
#log{white-space:pre-wrap;font-size:12px;color:#8b98a5}
</style></head><body>
<header><b>manual ape positioner</b><a href="/">status</a></header>
<main>
<section>
<h3>rising tapes</h3>
<p>Buy is post-only at the bid. Sell is post-only at the ask, for the available balance.</p>
<label>clip $ <input id="usd" value="5" size="6"></label>
<table id="tapes"><thead><tr><th>symbol</th><th>15m</th><th>mid</th><th></th></tr></thead><tbody></tbody></table>
<h3>positions</h3>
<table id="pos"><thead><tr><th>symbol</th><th>qty</th><th>avg</th><th>mid</th><th>gain</th><th></th></tr></thead><tbody></tbody></table>
</section>
<section>
<h3>move funds</h3>
<p>The ape key needs Transfer enabled, or Coinbase will reject the move.</p>
<select id="src"></select> → <select id="dst"></select><br>
<input id="cur" value="USDC" size="6"> <input id="amt" value="1" size="6">
<button id="move">move</button>
<div id="log"></div>
</section>
</main>
<script>
function log(x){document.getElementById('log').textContent=typeof x==='string'?x:JSON.stringify(x,null,2);}
function spark(points){
  const arr=(points||[]).map(function(p){return Number(p.p);}).filter(function(n){return n>0;});
  if(arr.length<2) return '';
  const w=88,h=22,lo=Math.min.apply(null,arr),hi=Math.max.apply(null,arr),span=hi-lo||1;
  const d=arr.map(function(v,i){const x=(i/(arr.length-1))*w;const y=h-((v-lo)/span)*h;return (i?'L':'M')+x.toFixed(1)+' '+y.toFixed(1);}).join(' ');
  return '<svg width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'"><path d="'+d+'" fill="none" stroke="#58a6ff" stroke-width="1.2"/></svg>';
}
async function refresh(){
  const st=await fetch('/ape/state').then(r=>r.json());
  const body=document.querySelector('#tapes tbody');
  body.innerHTML=(st.rising||[]).map(function(r){
    return '<tr><td>'+r.symbol+'<div>'+spark(r.spark)+'</div></td><td class="'+(r.ret>=0?'up':'dn')+'">'+((r.ret*100).toFixed(2))+'%</td><td>'+(r.mid?Number(r.mid).toPrecision(6):'')+'</td><td><button data-buy="'+r.symbol+'">buy</button></td></tr>';
  }).join('')||'<tr><td colspan="4">no feed yet — run npm run feed</td></tr>';
  document.querySelector('#pos tbody').innerHTML=(st.positions||[]).map(function(p){
    const gain=Number(p.gain||0);
    const pct=p.avg?((p.mid-p.avg)/p.avg*100):0;
    return '<tr><td>'+p.symbol+'<div>'+spark(p.spark)+'</div></td><td>'+Number(p.qty).toPrecision(4)+'</td><td>'+(p.avg?Number(p.avg).toPrecision(6):'')+'</td><td>'+(p.mid?Number(p.mid).toPrecision(6):'')+'</td><td class="'+(gain>=0?'up':'dn')+'">'+(gain>=0?'+':'')+gain.toFixed(4)+' ('+(pct>=0?'+':'')+pct.toFixed(2)+'%)</td><td><button data-sell="'+p.symbol+'">sell</button></td></tr>';
  }).join('')||'<tr><td colspan="6">none</td></tr>';
  const opts=(st.portfolios||[]).map(function(p){return '<option value="'+p.uuid+'">'+p.name+'</option>';}).join('');
  document.getElementById('src').innerHTML=opts;
  document.getElementById('dst').innerHTML=opts;
  if(!st.ready) log('waiting for APE_COINBASE_API_KEY');
}
document.body.addEventListener('click', async function(ev){
  const b=ev.target.closest('button');
  if(!b) return;
  try {
    if(b.dataset.buy) log(await fetch('/ape/buy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:b.dataset.buy,usd:document.getElementById('usd').value})}).then(r=>r.json()));
    if(b.dataset.sell) log(await fetch('/ape/sell',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:b.dataset.sell})}).then(r=>r.json()));
    if(b.id==='move') log(await fetch('/ape/move',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:src.value,target:dst.value,currency:cur.value,amount:amt.value})}).then(r=>r.json()));
    refresh();
  } catch(e) { log(String(e)); }
});
refresh();
setInterval(refresh, 1000);
</script></body></html>`;
}
