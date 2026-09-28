import http from 'http';
import { WebSocketServer } from 'ws';
import { loadProjectEnv } from '../shared/env.js';

loadProjectEnv(process.env.BOT_CONFIG || 'configs/web.env');

const PORT = Number(process.env.STATUS_PORT || 8787);
const TOKEN = process.env.STATUS_TOKEN || '';
const bots = new Map();
const sparks = new Map();
const SPARK_MS = Number(process.env.SPARK_WINDOW_MS || 15 * 60 * 1000);
const SPARK_GAP = Number(process.env.SPARK_SAMPLE_MS || 5000);

function noteSparks(bot, markets) {
  const now = Date.now();
  for (const m of markets || []) {
    const mid = parseFloat(m.mid);
    if (!(mid > 0) || !m.symbol) continue;
    const k = bot + ':' + m.symbol;
    const arr = sparks.get(k) || [];
    const last = arr[arr.length - 1];
    if (!last || now - last.t >= SPARK_GAP) arr.push({ t: now, p: mid });
    else last.p = mid;
    while (arr.length && now - arr[0].t > SPARK_MS) arr.shift();
    sparks.set(k, arr);
  }
}
function sparkSeries(bot, symbol) {
  return (sparks.get(bot + ':' + symbol) || []).map((x) => x.p);
}

function auth(req) {
  if (!TOKEN) return true;
  const h = req.headers['x-status-token'] || '';
  const q = new URL(req.url, 'http://local').searchParams.get('token');
  return h === TOKEN || q === TOKEN;
}
function collect() {
  return [...bots.values()].sort((a, b) => String(a.bot).localeCompare(String(b.bot))).map((b) => ({
    ...b,
    markets: (b.markets || []).map((m) => ({ ...m, spark: sparkSeries(b.bot, m.symbol) })),
  }));
}

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>crypto-mm status</title>
<style>
:root{color-scheme:dark}
body{font-family:ui-sans-serif,system-ui,sans-serif;background:#0e1116;color:#e7ecf3;margin:14px;font-size:13px}
h1{font-size:17px;font-weight:600;margin:0 0 8px}
h2{font-size:13px;margin:0 0 8px}
h2 small,.age{color:#8b98a5;font-weight:400;margin-left:8px}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:10px 12px;margin:10px 0}
.kpi{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:8px}
.kpi div{min-width:72px}
.kpi label{display:block;font-size:10px;color:#8b98a5;text-transform:uppercase}
.kpi b{font-size:14px}
.kpi span{display:block;font-size:11px;color:#8b98a5}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:3px 6px;border-bottom:1px solid #30363d}
th{color:#8b98a5;font-weight:500}
.ord,tr.orders td{color:#8b98a5;font-size:12px;font-family:ui-monospace,monospace}
.api-wrap{display:flex;gap:24px;flex-wrap:wrap;margin:8px 0 14px}
.api{font-size:12px;color:#8b98a5;flex:1;min-width:260px}
.api h3{margin:0 0 6px;font-size:12px;color:#c8d1da;text-transform:uppercase;letter-spacing:.04em}
.api ul{margin:4px 0 0 16px;font-family:ui-monospace,monospace}
.mid{color:#79c0ff}
.sell{color:#f85149}
.buy{color:#3fb950}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:#f85149}
.dot.ok{background:#3fb950}
.split{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}
.split .wallet{flex:0 0 280px;max-width:320px}
.split .markets{flex:1;min-width:420px}
.book{width:auto;min-width:280px;font-family:ui-monospace,monospace;font-size:11px}
.book th,.book td{border:0;padding:1px 6px;line-height:1.25}
.book td.px{text-align:right;font-variant-numeric:tabular-nums}
tr.sell,tr.sell td{color:#f85149}
tr.buy,tr.buy td{color:#3fb950}
tr.mid,tr.mid td{color:#79c0ff;font-weight:600}
.spark{vertical-align:middle;display:block}
.fills{margin-top:12px;font-size:12px}
.fills td{font-family:ui-monospace,monospace}
</style>
</head>
<body>
<h1>crypto-mm status <span class="age" id="conn"><span class="dot"></span>connecting</span></h1>
<p class="age" id="meta">waiting for bots</p>
<div id="root"></div>
<script>
function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fmt(n){if(n==null||!Number.isFinite(Number(n)))return 'n/a';const x=Number(n);return (x>=0?'+':'')+x.toFixed(4);}
function fmtN(n){if(n==null||!Number.isFinite(Number(n)))return '';return Number(n).toFixed(2);}
function sumMarkets(b,key){return (b.markets||[]).reduce((s,m)=>s+Number(m[key]||0),0);}
function weightOf(m){return Number(m.wNum||parseFloat(m.w)||0);}
function sparkSvg(vals){
  if(!vals||vals.length<2) return '';
  const w=72,h=18;
  const min=Math.min.apply(null,vals), max=Math.max.apply(null,vals);
  const span=(max-min)||1e-12;
  const pts=vals.map((v,i)=>{
    const x=(i/(vals.length-1))*w;
    const y=h-2-((v-min)/span)*(h-4);
    return x.toFixed(1)+','+y.toFixed(1);
  }).join(' ');
  const up=vals[vals.length-1]>=vals[0];
  return '<svg class="spark" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'"><polyline fill="none" stroke="'+(up?'#3fb950':'#f85149')+'" stroke-width="1.2" points="'+pts+'"/></svg>';
}
function apiBlock(b){
  const a=b.api||{};
  const routes=a.routes||[];
  const last=a.last||[];
  const tally='<div class="api"><h3>API tally</h3>'+
    'n='+esc(a.n||0)+' http · cache '+esc(a.cacheHits||0)+' · '+esc(a.perMin||0)+'/min · avg '+esc(a.avg||0)+'ms max '+esc(a.max||0)+'ms'+
    '<ul>'+routes.slice(0,12).map(r=>'<li>'+r.n+'× avg '+r.avg+'ms max '+r.max+'ms '+esc(r.key)+'</li>').join('')+'</ul></div>';
  const times='<div class="api"><h3>API timings</h3><ul>'+
    last.slice().reverse().map(c=>'<li>'+c.ms+'ms '+esc(c.venue)+' '+esc(c.label)+(c.ok===false?' FAIL':'')+'</li>').join('')+
    '</ul></div>';
  return '<div class="api-wrap">'+tally+times+'</div>';
}
function priceDigits(ords){
  let d=0;
  for(const o of ords||[]){
    const s=String(o.price??'');
    const i=s.indexOf('.');
    if(i>=0) d=Math.max(d,s.length-i-1);
  }
  return d;
}
function fmtPx(px,d){
  const n=Number(px);
  if(!Number.isFinite(n)) return px==null?'':String(px);
  return d>0?n.toFixed(d):String(Math.round(n));
}
function orderBook(m){
  const ords=m.orders||[];
  const d=priceDigits(ords);
  const sells=ords.filter(o=>String(o.side).toLowerCase()==='sell').sort((a,b)=>Number(b.price)-Number(a.price));
  const buys=ords.filter(o=>String(o.side).toLowerCase()==='buy').sort((a,b)=>Number(b.price)-Number(a.price));
  const row=(cls,side,px,size,usd,st,id)=>
    '<tr class="'+cls+'"><td>'+side+'</td><td class="px">'+esc(px)+'</td><td>'+esc(size)+'</td><td>'+esc(usd)+'</td><td>'+esc(st)+'</td><td>'+esc(id)+'</td></tr>';
  const lines=sells.map(o=>row('sell','SELL L'+o.level,fmtPx(o.price,d),o.size,'$'+Number(o.usd||0).toFixed(2),o.status||'',o.id||''));
  lines.push(row('mid','MID',fmtPx(m.mid,d),'','','',''));
  buys.forEach(o=>lines.push(row('buy','BUY L'+o.level,fmtPx(o.price,d),o.size,'$'+Number(o.usd||0).toFixed(2),o.status||'',o.id||'')));
  return '<table class="book"><thead><tr><th></th><th class="px">Price</th><th>Size</th><th>$</th><th></th><th>id</th></tr></thead><tbody>'+
    lines.join('')+'</tbody></table>';
}
function walletTable(b){
  const rows=[...(b.wallet||[])].sort((a,c)=>Number(c.value||0)-Number(a.value||0));
  if(!rows.length) return '<h2>Wallet</h2><p class="age">no positions</p>';
  const body=rows.map(w=>'<tr><td>'+esc(w.asset)+'</td><td>'+esc(w.amount)+'</td><td class="px">'+esc(w.mid)+'</td><td>'+fmtN(w.value)+'</td></tr>').join('');
  const tot=rows.reduce((s,w)=>s+Number(w.value||0),0);
  return '<h2>Wallet</h2><table><thead><tr><th>Asset</th><th>Amount</th><th>Mid</th><th>Value '+esc(b.quote||'')+'</th></tr></thead><tbody>'+
    body+'<tr><td colspan="3">Total</td><td>'+fmtN(tot)+'</td></tr></tbody></table>';
}
function fillsTable(b){
  const rows=(b.fills||[]).slice(0,10);
  if(!rows.length) return '<div class="fills"><h2>Fills</h2><p class="age">none yet</p></div>';
  const body=rows.map(f=>{
    const side=String(f.side||'').toUpperCase();
    const cls=side==='SELL'?'sell':'buy';
    const when=(f.ts||'').replace('T',' ').replace('Z','').slice(11,19);
    return '<tr class="'+cls+'"><td>'+esc(when)+'</td><td>'+side+'</td><td>'+esc(f.symbol||f.pair||'')+'</td><td class="px">'+esc(f.price)+'</td><td>'+esc(f.size)+'</td><td>'+fmtN(f.notional||f.filledValue)+'</td><td>'+esc(f.fee)+'</td></tr>';
  }).join('');
  return '<div class="fills"><h2>Fills</h2><table><thead><tr><th>Time</th><th></th><th>Mkt</th><th>Price</th><th>Size</th><th>$</th><th>Fee</th></tr></thead><tbody>'+body+'</tbody></table></div>';
}
function card(b){
  const p=b.pnl||{};
  const w=b.working||{};
  const mk=[...(b.markets||[])].sort((x,y)=>weightOf(y)-weightOf(x)).map(m=>
    '<tr><td>'+esc(m.symbol)+'<div>'+sparkSvg(m.spark)+'</div></td><td>'+esc(m.mid)+'</td><td>'+m.bids+'/'+m.asks+
    '<div class="ord">bid $'+fmtN(m.bidUsd)+' / ask $'+fmtN(m.askUsd)+'</div></td>'+
    '<td>'+fmtN(m.bidUsd)+'</td><td>'+fmtN(m.askUsd)+'</td><td>'+fmtN(m.buyUsd)+'</td><td>'+fmtN(m.sellUsd)+
    '</td><td>'+esc(m.vol)+'</td><td>'+esc(m.fee)+'</td><td>'+esc(m.w)+'</td></tr>'+
    '<tr class="orders"><td></td><td colspan="9">'+orderBook(m)+'</td></tr>'
  ).join('');
  const age=b.ts?Math.round((Date.now()-b.ts)/1000)+'s ago':'';
  return '<section class="card"><h2>'+esc(b.bot)+' <small>'+esc(b.exchange||'')+' '+esc(b.quote||'')+
    '</small> <span class="age">'+age+'</span></h2><div class="kpi">'+
    '<div><label>Wallet</label><b>'+fmt(p.walletGain)+'</b><span>'+fmtN(p.lastEquity)+'</span></div>'+
    '<div><label>PRICE</label><b>'+fmt(p.pricePnl)+'</b></div>'+
    '<div><label>MAKER</label><b>'+fmt(p.makerPnl)+'</b></div>'+
    '<div><label>FEES</label><b>'+fmt(p.fees!=null?-p.fees:null)+'</b></div>'+
    '<div><label>TAKER</label><b>'+fmt(p.takerFees!=null?-p.takerFees:null)+'</b></div>'+
    '<div><label>GAP</label><b>'+fmt(p.otherPnl)+'</b></div>'+
    '<div><label>BANK</label><b>'+fmt(b.banked)+'</b></div>'+
    '<div><label>Bids</label><b>'+fmtN(w.bids)+'</b></div>'+
    '<div><label>Asks</label><b>'+fmtN(w.asks)+'</b></div>'+
    '<div><label>Inventory</label><b>'+fmtN(w.inventory)+'</b></div>'+
    '<div><label>Cash</label><b>'+fmtN(w.cash)+'</b></div>'+
    '<div><label>Vol buy</label><b>'+fmtN(sumMarkets(b,'buyUsd'))+'</b></div>'+
    '<div><label>Vol sell</label><b>'+fmtN(sumMarkets(b,'sellUsd'))+'</b></div></div>'+
    apiBlock(b)+fillsTable(b)+
    '<div class="split"><div class="wallet">'+walletTable(b)+'</div><div class="markets"><table><thead><tr><th>Mkt</th><th>mid</th><th>bid/ask</th><th>bid$</th><th>ask$</th><th>buy vol</th><th>sell vol</th><th>vol</th><th>fee</th><th>w</th></tr></thead><tbody>'+
    (mk||'<tr><td colspan="10">no markets</td></tr>')+'</tbody></table></div></div></section>';
}
function render(data){
  const rows=data.bots||[];
  document.getElementById('meta').textContent=rows.length?rows.length+' bot(s) · live websocket':'waiting for bot POSTs';
  document.getElementById('root').innerHTML=rows.map(card).join('')||'<p>No reports yet.</p>';
}
function connect(){
  const q=TOKEN_Q;
  const proto=location.protocol==='https:'?'wss':'ws';
  const ws=new WebSocket(proto+'://'+location.host+'/ws'+q);
  const dot=document.getElementById('conn');
  ws.onopen=()=>{dot.innerHTML='<span class="dot ok"></span>live';};
  ws.onmessage=(ev)=>{try{render(JSON.parse(ev.data));}catch(e){}};
  ws.onclose=()=>{dot.innerHTML='<span class="dot"></span>reconnect';setTimeout(connect,1500);};
  ws.onerror=()=>ws.close();
}
const TOKEN_Q=${JSON.stringify(TOKEN ? '?token=' + TOKEN : '')};
fetch('/api/status').then(r=>r.json()).then(render).catch(()=>{});
connect();
</script>
</body></html>`;

function payload() {
  return JSON.stringify({ bots: collect() });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/status.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(payload());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/status') {
    if (!auth(req)) { res.writeHead(401); res.end('unauthorized'); return; }
    let body = '';
    for await (const c of req) body += c;
    try {
      const msg = JSON.parse(body || '{}');
      const id = String(msg.bot || 'unknown');
      const prev = bots.get(id) || {};
      bots.set(id, { ...prev, ...msg, fills: msg.fills || prev.fills || [], bot: id, ts: Date.now() });
      noteSparks(id, msg.markets || prev.markets);
      broadcast();
      res.writeHead(204); res.end();
    } catch { res.writeHead(400); res.end('bad json'); }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/mids') {
    if (!auth(req)) { res.writeHead(401); res.end('unauthorized'); return; }
    let body = '';
    for await (const c of req) body += c;
    try {
      const msg = JSON.parse(body || '{}');
      const id = String(msg.bot || 'unknown');
      const prev = bots.get(id) || { bot: id, markets: [] };
      const incoming = msg.mids || [];
      const bySym = new Map((prev.markets || []).map((m) => [String(m.symbol || '').toUpperCase(), { ...m }]));
      for (const row of incoming) {
        const sym = String(row.symbol || '').toUpperCase();
        if (!sym || !(Number(row.mid) > 0)) continue;
        const cur = bySym.get(sym) || { symbol: sym, orders: [] };
        cur.mid = row.mid;
        if (row.bid != null) cur.bid = row.bid;
        if (row.ask != null) cur.ask = row.ask;
        bySym.set(sym, cur);
      }
      prev.markets = [...bySym.values()];
      bots.set(id, prev);
      noteSparks(id, incoming.map((r) => ({ symbol: r.symbol, mid: r.mid })));
      broadcast();
      res.writeHead(204); res.end();
    } catch { res.writeHead(400); res.end('bad json'); }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/fill') {
    if (!auth(req)) { res.writeHead(401); res.end('unauthorized'); return; }
    let body = '';
    for await (const c of req) body += c;
    try {
      const msg = JSON.parse(body || '{}');
      const id = String(msg.bot || 'unknown');
      const prev = bots.get(id) || { bot: id };
      const fill = msg.fill || msg;
      const fills = [fill, ...(prev.fills || [])].slice(0, 10);
      bots.set(id, { ...prev, fills, bot: id });
      broadcast();
      res.writeHead(204); res.end();
    } catch { res.writeHead(400); res.end('bad json'); }
    return;
  }
  res.writeHead(404); res.end('not found');
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  if (!auth(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});
wss.on('connection', (ws) => {
  try { ws.send(payload()); } catch { /* ignore */ }
});
function broadcast() {
  const msg = payload();
  for (const c of wss.clients) {
    if (c.readyState === 1) {
      try { c.send(msg); } catch { /* ignore */ }
    }
  }
}

server.listen(PORT, () => console.log('status UI http://127.0.0.1:' + PORT + '/  (ws /ws)'));
