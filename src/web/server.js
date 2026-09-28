import http from 'http';
import { WebSocketServer } from 'ws';
import { loadProjectEnv } from '../shared/env.js';
import { backtestRungs } from '../shared/rungs.js';

loadProjectEnv(process.env.BOT_CONFIG || 'configs/web.env');

const PORT = Number(process.env.STATUS_PORT || 8787);
const TOKEN = process.env.STATUS_TOKEN || '';
const bots = new Map();
const sparks = new Map();
const sparkFills = new Map();
const SPARK_MS = Number(process.env.SPARK_WINDOW_MS || 15 * 60 * 1000);
const SPARK_GAP = Number(process.env.SPARK_SAMPLE_MS || 1000);
const KPI_SPARK_MS = Number(process.env.KPI_SPARK_MS || 6 * 60 * 60 * 1000);
const KPI_SPARK_GAP = Number(process.env.KPI_SPARK_GAP_MS || 60 * 1000);
const kpiSparks = new Map();
function noteKpiSpark(bot, snap) {
  if (!bot || !snap) return;
  const now = Date.now();
  const arr = kpiSparks.get(bot) || [];
  const last = arr[arr.length - 1];
  if (last && now - last.t < KPI_SPARK_GAP) {
    last.v = snap;
    kpiSparks.set(bot, arr);
    return;
  }
  arr.push({ t: now, v: snap });
  while (arr.length && now - arr[0].t > KPI_SPARK_MS) arr.shift();
  kpiSparks.set(bot, arr);
}
function kpiSeries(bot, key) {
  return (kpiSparks.get(bot) || []).map((x) => ({ t: x.t, p: Number((x.v || {})[key]) }));
}

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
  return sparks.get(bot + ':' + symbol) || [];
}
function noteSparkFill(bot, fill) {
  const sym = String(fill.symbol || '').toUpperCase() || String(fill.pair || '').split('-')[0].toUpperCase();
  if (!sym) return;
  const k = bot + ':' + sym;
  const arr = sparkFills.get(k) || [];
  arr.push({ ...fill, ts: fill.ts || new Date().toISOString() });
  const cut = Date.now() - SPARK_MS;
  sparkFills.set(k, arr.filter((f) => Date.parse(f.ts || 0) >= cut));
}
function backtestRungs(points, feeBps) {
  if (!points || points.length < 8) return null;
  const fee = (Number(feeBps) || 35) / 10000;
  let best = null;
  for (const levels of [1, 2, 3]) {
    for (const stepBps of [25, 40, 55, 80, 110]) {
      const step = stepBps / 10000;
      let touches = 0, edge = 0;
      let mid = Number(points[0].p);
      if (!(mid > 0)) continue;
      for (let i = 1; i < points.length; i++) {
        const px = Number(points[i].p);
        if (!(px > 0)) continue;
        const move = (px - mid) / mid;
        if (move <= -step) {
          const L = Math.min(levels, Math.max(1, Math.floor(Math.abs(move) / step)));
          touches += 1;
          edge += L * step - 2 * fee;
        } else if (move >= step) {
          const L = Math.min(levels, Math.max(1, Math.floor(move / step)));
          touches += 1;
          edge += L * step - 2 * fee;
        }
        mid = px;
      }
      const row = { levels, stepBps, touches, edgePct: edge * 100 };
      if (!best || row.edgePct > best.edgePct) best = row;
    }
  }
  return best;
}
function sparkFillsFor(bot, symbol) {
  const cut = Date.now() - SPARK_MS;
  return (sparkFills.get(bot + ':' + String(symbol || '').toUpperCase()) || []).filter((f) => Date.parse(f.ts || 0) >= cut);
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
    kpiSpark: {
      wallet: kpiSeries(b.bot, 'wallet'),
      price: kpiSeries(b.bot, 'price'),
      maker: kpiSeries(b.bot, 'maker'),
      fees: kpiSeries(b.bot, 'fees'),
      vol: kpiSeries(b.bot, 'vol'),
      bank: kpiSeries(b.bot, 'bank'),
    },
    markets: (b.markets || []).map((m) => ({ ...m, spark: sparkSeries(b.bot, m.symbol), sparkFills: sparkFillsFor(b.bot, m.symbol), rungs: backtestRungs(sparkSeries(b.bot, m.symbol), parseFloat(m.fee)) })),
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
.spark{vertical-align:middle;display:block}.spark-wrap{display:flex;flex-direction:column;align-items:flex-start;gap:0}.spark-hl{font-size:8px;opacity:.75;line-height:1.15;font-variant-numeric:tabular-nums}.spark-hl.hi{color:#3fb950}.spark-hl.lo{color:#f85149}
.book-wrap{display:flex;gap:12px;align-items:flex-start}
.book-wrap .mfills{font-size:11px;min-width:160px}.book-wrap .mpnl{font-size:11px;min-width:110px;font-variant-numeric:tabular-nums}
.book-wrap .mfills .buy{color:#3fb950}.book-wrap .mfills .sell{color:#f85149}
.fills{margin-top:12px;font-size:12px}
.fills td{font-family:ui-monospace,monospace}
#board.board{display:flex;flex-direction:row;flex-wrap:wrap;align-items:flex-start;justify-content:center;gap:12px;margin:8px 0 14px;width:100%}
#board .board-card{flex:0 1 auto;width:auto;max-width:100%;display:inline-flex;flex-direction:column;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:10px 12px;margin:0;box-sizing:border-box}
.board-card h2{margin:0 0 8px}
.hdr-stats{display:flex;gap:16px;margin:0 0 8px;font-size:11px}
.hdr-stats .col{display:flex;flex-direction:column;gap:1px}
.hdr-stats label{color:#8b98a5;font-size:10px}
.hdr-stats b{font-size:13px}
.hdr-stats span{color:#8b98a5}
.board-card .sparks{display:flex;flex-direction:row;flex-wrap:wrap;align-items:flex-end;gap:8px;line-height:normal}
.board-card .cell{flex:0 0 auto;width:118px;margin:0;background:#0e1116;border:1px solid #30363d;border-radius:8px;padding:6px 8px;box-sizing:border-box}
.board-card .cell .sym{font-size:12px;font-weight:600}
.board-card .cell .sz{font-size:10px;color:#8b98a5}
</style>
</head>
<body>
<h1>crypto-mm status <span class="age" id="conn"><span class="dot"></span>connecting</span></h1>
<p class="age" id="meta">waiting for bots</p>
<div id="board" class="board"></div>
<div id="root"></div>
<script>
function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fmt(n){if(n==null||!Number.isFinite(Number(n)))return 'n/a';const x=Number(n);return (x>=0?'+':'')+x.toFixed(4);}
function fmtN(n){if(n==null||!Number.isFinite(Number(n)))return '';return Number(n).toFixed(2);}
function sumMarkets(b,key){return (b.markets||[]).reduce((s,m)=>s+Number(m[key]||0),0);}
function weightOf(m){return Number(m.wNum||parseFloat(m.w)||0);}
function ourSpread(m){
  if(m.spreadBps!=null&&Number.isFinite(Number(m.spreadBps))) return Number(m.spreadBps);
  const buys=(m.orders||[]).filter(o=>String(o.side).toLowerCase()==='buy');
  const sells=(m.orders||[]).filter(o=>String(o.side).toLowerCase()==='sell');
  const bid=buys.reduce((x,o)=>Math.max(x,Number(o.price)||0),0);
  const ask=sells.reduce((x,o)=>{const p=Number(o.price);return p>0&&(x===0||p<x)?p:x;},0);
  const mid=Number(m.mid)||((bid&&ask)?(bid+ask)/2:0);
  if(!(bid>0&&ask>0&&mid>0)) return null;
  return ((ask-bid)/mid)*10000;
}
function feeBpsOf(m){
  const n=parseFloat(m.fee);
  return Number.isFinite(n)?n:null;
}
function fmtSpread(m){
  const spr=ourSpread(m);
  if(spr==null) return '';
  const pct=(spr/100).toFixed(2)+'%';
  const fee=feeBpsOf(m);
  if(fee==null) return pct+' ('+spr.toFixed(0)+'bps)';
  const extra=spr-fee;
  const rel=(extra>=0?'+':'')+extra.toFixed(0)+'bps vs fee';
  return pct+' ('+rel+')';
}

function projectOf(b){
  const started=(b.pnl&&b.pnl.startedAt)||(b.proj&&b.proj.startedAt)||b.ts;
  const hours=Math.max((Date.now()-(started||Date.now()))/3600000, 1/60);
  const vol=sumMarkets(b,'buyUsd')+sumMarkets(b,'sellUsd');
  const pnl=b.pnl||{};
  const bankRun=Number(b.bankedRun||0);
  return {
    hours,
    vol: vol/hours,
    maker: Number(pnl.makerPnl||0)/hours,
    fees: Number(pnl.fees||0)/hours,
    wallet: Number(pnl.walletGain||0)/hours,
    price: Number(pnl.pricePnl||0)/hours,
    bank: bankRun/hours,
  };
}
function rateSeries(points, startedAt, daily){
  const t0=startedAt||((points&&points[0]&&points[0].t)||Date.now());
  return (points||[]).filter(function(x){return Number.isFinite(Number(x.p));}).map(function(x){
    const hours=Math.max((x.t-t0)/3600000, 1/60);
    return {t:x.t,p:Number(x.p)/hours*(daily?24:1)};
  });
}
function projBlock(b){
  const q=projectOf(b);
  const h=q.hours>=1?q.hours.toFixed(2)+'h':(q.hours*60).toFixed(0)+'m';
  return '';
}

function sparkDigits(vals){
  const span=Math.max.apply(null,vals)-Math.min.apply(null,vals);
  if(!(span>0)) return 4;
  if(span>=10) return 2;
  if(span>=1) return 3;
  if(span>=0.1) return 4;
  if(span>=0.01) return 5;
  return 6;
}
function sparkSvg(points, fills, orders){
  const ptsIn=(!points||!points.length)?[]:points[0].p!=null?points:points.map(function(p){return {t:0,p:p};});
  if(ptsIn.length<2) return '';
  const w=88,h=28;
  const t0=ptsIn[0].t, t1=ptsIn[ptsIn.length-1].t || t0+1;
  const spanT=Math.max(1,t1-t0);
  const marks=(fills||[]).map(function(f){
    const ts=f.ts?Date.parse(f.ts):NaN;
    const px=Number(f.price);
    if(!Number.isFinite(px)) return null;
    if(Number.isFinite(ts) && (ts<t0-5000 || ts>t1+5000)) return null;
    return {t:Number.isFinite(ts)?ts:t1,p:px,side:String(f.side||'').toLowerCase()};
  }).filter(Boolean);
  const working=(orders||[]).map(function(o){
    const px=Number(o.price);
    if(!Number.isFinite(px)) return null;
    return {p:px,side:String(o.side||'').toLowerCase()};
  }).filter(Boolean);
  const vals=ptsIn.map(function(x){return x.p;}).concat(marks.map(function(m){return m.p;})).concat(working.map(function(m){return m.p;}));
  const lo=Math.min.apply(null,vals), hi=Math.max.apply(null,vals);
  const span=(hi-lo)||1e-12;
  function X(t,i){
    if(t0 && t) return ((t-t0)/spanT)*(w-10);
    return (i/(ptsIn.length-1))*(w-10);
  }
  function Y(p){ return h-3-((p-lo)/span)*(h-6); }
  const line=ptsIn.map(function(pt,i){ return X(pt.t,i).toFixed(1)+','+Y(pt.p).toFixed(1); }).join(' ');
  const up=ptsIn[ptsIn.length-1].p>=ptsIn[0].p;
  const dots=marks.map(function(m){
    const fill=m.side==='sell'?'#f85149':'#3fb950';
    return '<circle cx="'+X(m.t,ptsIn.length-1).toFixed(1)+'" cy="'+Y(m.p).toFixed(1)+'" r="2.2" fill="'+fill+'" stroke="#0e1116" stroke-width="0.6"/>';
  }).join('');
  const ticks=working.map(function(o){
    const y=Y(o.p).toFixed(1);
    const col=o.side==='sell'?'#f85149':'#3fb950';
    return '<line x1="'+(w-9)+'" y1="'+y+'" x2="'+w+'" y2="'+y+'" stroke="'+col+'" stroke-width="1.6"/>';
  }).join('');
  const d=sparkDigits(vals);
  return '<div class="spark-wrap"><div class="spark-hl hi">H '+hi.toFixed(d)+'</div>'+
    '<svg class="spark" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'"><polyline fill="none" stroke="'+(up?'#3fb950':'#f85149')+'" stroke-width="1.2" points="'+line+'"/>'+dots+ticks+'</svg>'+
    '<div class="spark-hl lo">L '+lo.toFixed(d)+'</div></div>';
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
  if(!d) d=4;
  return Math.min(8,d);
}
function fmtPx(px,d){
  const n=Number(px);
  if(!Number.isFinite(n)) return px==null?'':String(px);
  const dd=Math.min(8, d==null?6:d);
  return dd>0?n.toFixed(dd):String(Math.round(n));
}
function orderBook(m){
  const ords=m.orders||[];
  const d=priceDigits(ords);
  const sells=ords.filter(o=>String(o.side).toLowerCase()==='sell').sort((a,b)=>Number(b.price)-Number(a.price));
  const buys=ords.filter(o=>String(o.side).toLowerCase()==='buy').sort((a,b)=>Number(b.price)-Number(a.price));
  function pctMid(px){
    const p=Number(px), mid=Number(m.mid);
    if(!(p>0&&mid>0)) return '';
    const pct=(p-mid)/mid*100;
    const dd=Math.abs(pct)>=1?2:3;
    return (pct>=0?'+':'')+pct.toFixed(dd)+'%';
  }
  const row=(cls,side,px,vs,size,usd,st,id)=>
    '<tr class="'+cls+'"><td>'+side+'</td><td class="px">'+esc(px)+'</td><td>'+esc(vs)+'</td><td>'+esc(size)+'</td><td>'+esc(usd)+'</td><td>'+esc(st)+'</td><td>'+esc(id)+'</td></tr>';
  const lines=sells.map(o=>row('sell','SELL L'+o.level,fmtPx(o.price,d),pctMid(o.price),o.size,'$'+Number(o.usd||0).toFixed(2),o.status||'',o.id||''));
  lines.push(row('mid','MID',fmtPx(m.mid,d),fmtSpread(m),'','','',''));
  buys.forEach(o=>lines.push(row('buy','BUY L'+o.level,fmtPx(o.price,d),pctMid(o.price),o.size,'$'+Number(o.usd||0).toFixed(2),o.status||'',o.id||'')));
  const fills=(m.sparkFills||[]).slice().sort(function(a,c){return Date.parse(c.ts||0)-Date.parse(a.ts||0);}).slice(0,5);
  const fl=fills.map(function(f){
    const side=String(f.side||'').toLowerCase();
    const when=(f.ts||'').replace('T',' ').replace('Z','').slice(11,19);
    return '<div class="'+side+'">'+when+' '+side.toUpperCase()+' '+esc(f.price)+' × '+esc(f.size)+'</div>';
  }).join('')||'<div class="age">no fills</div>';
  const rg=m.rungs; const rtxt=rg?('L'+rg.levels+' @ '+rg.stepBps+'bps · '+rg.touches+' x · edge '+Number(rg.edgePct).toFixed(2)+'%'):'rungs n/a';
  const pnl='<div class="mpnl"><div>price '+fmt(m.pricePnl)+'</div><div>maker '+fmt(m.makerPnl)+'</div><div>fees '+fmt(m.fees!=null?-Number(m.fees):null)+'</div><div class="age">'+rtxt+'</div></div>';
  return '<div class="book-wrap"><table class="book"><thead><tr><th></th><th class="px">Price</th><th>vs mid</th><th>Size</th><th>$</th><th></th><th>id</th></tr></thead><tbody>'+
    lines.join('')+'</tbody></table><div class="mfills"><div class="age">fills</div>'+fl+'</div>'+pnl+'</div>';
}
function walletTable(b){
  const rows=[...(b.wallet||[])].sort((a,c)=>Number(c.value||0)-Number(a.value||0));
  if(!rows.length) return '<h2>Wallet</h2><p class="age">no positions</p>';
  const body=rows.map(w=>'<tr><td>'+esc(w.asset)+'</td><td>'+esc(w.amount)+'</td><td class="px">'+esc(fmtPx(w.mid,6))+'</td><td>'+fmtN(w.value)+'</td></tr>').join('');
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
    const notion=Number(f.notional||f.filledValue||0);
    const feeN=Number(f.fee||0);
    const bps=notion>0&&feeN?((feeN/notion)*10000).toFixed(1)+'bps':'';
    return '<tr class="'+cls+'"><td>'+esc(when)+'</td><td>'+side+'</td><td>'+esc(f.symbol||f.pair||'')+'</td><td class="px">'+esc(f.price)+'</td><td>'+esc(f.size)+'</td><td>'+fmtN(notion)+'</td><td>'+(feeN?feeN.toFixed(6):'')+'</td><td>'+bps+'</td></tr>';
  }).join('');
  const h=b.feesHist||{};
  const hist=h.n?('realized '+(h.bps!=null?Number(h.bps).toFixed(1):'n/a')+'bps on '+h.n+' fills · fee '+fmtN(h.fee)+' / '+fmtN(h.notional)):'';
  return '<div class="fills"><h2>Fills</h2><p class="age">'+hist+'</p><table><thead><tr><th>Time</th><th></th><th>Mkt</th><th>Price</th><th>Size</th><th>$</th><th>Fee</th><th>bps</th></tr></thead><tbody>'+body+'</tbody></table></div>';
}
function card(b){
  const p=b.pnl||{};
  const w=b.working||{};
  const mk=[...(b.markets||[])].sort((x,y)=>weightOf(y)-weightOf(x)).map(m=>
    '<tr><td>'+esc(m.symbol)+'<div>'+sparkSvg(m.spark, m.sparkFills, m.orders)+'</div></td><td>'+esc(fmtPx(m.mid,priceDigits(m.orders)))+'</td><td>'+esc(fmtSpread(m))+'</td><td>'+m.bids+'/'+m.asks+
    '<div class="ord">bid $'+fmtN(m.bidUsd)+' / ask $'+fmtN(m.askUsd)+'</div></td>'+
    '<td>'+fmtN(m.bidUsd)+'</td><td>'+fmtN(m.askUsd)+'</td><td>'+fmtN(m.buyUsd)+'</td><td>'+fmtN(m.sellUsd)+
    '</td><td>'+esc(m.vol)+'</td><td>'+esc(m.fee)+'</td><td>'+esc(m.w)+'</td></tr>'+
    '<tr class="orders"><td></td><td colspan="10">'+orderBook(m)+'</td></tr>'
  ).join('');
  const age=b.ts?Math.round((Date.now()-b.ts)/1000)+'s ago':'';
  const q=projectOf(b);
  const t0=(b.pnl&&b.pnl.startedAt)||b.ts||Date.now();
  return '<section class="card"><h2>'+esc(b.bot)+' <small>'+esc(b.exchange||'')+' '+esc(b.quote||'')+
    '</small> <span class="age">'+age+'</span></h2><div class="kpi">'+
    '<div><label>Wallet</label><b>'+fmt(p.walletGain)+'</b><span>'+fmtN(p.lastEquity)+'</span>'+sparkSvg((b.kpiSpark||{}).wallet)+
      '<span>/h '+fmt(q.wallet)+'</span>'+sparkSvg(rateSeries((b.kpiSpark||{}).wallet,t0,false))+
      '<span>/d '+fmt(q.wallet*24)+'</span>'+sparkSvg(rateSeries((b.kpiSpark||{}).wallet,t0,true))+'</div>'+
    '<div><label>PRICE</label><b>'+fmt(p.pricePnl)+'</b>'+sparkSvg((b.kpiSpark||{}).price)+
      '<span>/h '+fmt(q.price)+'</span>'+sparkSvg(rateSeries((b.kpiSpark||{}).price,t0,false))+
      '<span>/d '+fmt(q.price*24)+'</span>'+sparkSvg(rateSeries((b.kpiSpark||{}).price,t0,true))+'</div>'+
    '<div><label>MAKER</label><b>'+fmt(p.makerPnl)+'</b>'+sparkSvg((b.kpiSpark||{}).maker)+
      '<span>/h '+fmt(q.maker)+'</span>'+sparkSvg(rateSeries((b.kpiSpark||{}).maker,t0,false))+
      '<span>/d '+fmt(q.maker*24)+'</span>'+sparkSvg(rateSeries((b.kpiSpark||{}).maker,t0,true))+'</div>'+
    '<div><label>FEES</label><b>'+fmt(p.fees!=null?-p.fees:null)+'</b>'+sparkSvg((b.kpiSpark||{}).fees)+
      '<span>/h '+fmt(q.fees!=null?-q.fees:null)+'</span>'+sparkSvg(rateSeries((b.kpiSpark||{}).fees,t0,false))+
      '<span>/d '+fmt(q.fees!=null?-q.fees*24:null)+'</span>'+sparkSvg(rateSeries((b.kpiSpark||{}).fees,t0,true))+'</div>'+
    '<div><label>TAKER</label><b>'+fmt(p.takerFees!=null?-p.takerFees:null)+'</b></div>'+
    '<div><label>GAP</label><b>'+fmt(p.otherPnl)+'</b></div>'+
    '<div><label>BANK</label><b>'+fmt(b.banked)+'</b></div>'+
    '<div><label>Bids</label><b>'+fmtN(w.bids)+'</b></div>'+
    '<div><label>Asks</label><b>'+fmtN(w.asks)+'</b></div>'+
    '<div><label>Inventory</label><b>'+fmtN(w.inventory)+'</b></div>'+
    '<div><label>Cash</label><b>'+fmtN(w.cash)+'</b></div>'+
    '<div><label>Vol buy</label><b>'+fmtN(sumMarkets(b,'buyUsd'))+'</b></div>'+
    '<div><label>Vol sell</label><b>'+fmtN(sumMarkets(b,'sellUsd'))+'</b></div>'+
    '<div><label>Vol</label><b>'+fmtN(sumMarkets(b,'buyUsd')+sumMarkets(b,'sellUsd'))+'</b>'+sparkSvg((b.kpiSpark||{}).vol)+
      '<span>/h $'+fmtN(q.vol)+'</span>'+sparkSvg(rateSeries((b.kpiSpark||{}).vol,t0,false))+
      '<span>/d $'+fmtN(q.vol*24)+'</span>'+sparkSvg(rateSeries((b.kpiSpark||{}).vol,t0,true))+'</div>'+
    '<div><label>Bank run</label><b>'+fmt(b.bankedRun)+'</b>'+sparkSvg((b.kpiSpark||{}).bank)+
      '<span>/h '+fmt(q.bank)+'</span>'+sparkSvg(rateSeries((b.kpiSpark||{}).bank,t0,false))+
      '<span>/d '+fmt(q.bank*24)+'</span>'+sparkSvg(rateSeries((b.kpiSpark||{}).bank,t0,true))+'</div></div>'+
    
    '<div class="split"><div class="wallet">'+walletTable(b)+'</div><div class="markets"><table><thead><tr><th>Mkt</th><th>mid</th><th>spr</th><th>bid/ask</th><th>bid$</th><th>ask$</th><th>buy vol</th><th>sell vol</th><th>vol</th><th>fee</th><th>w</th></tr></thead><tbody>'+
    (mk||'<tr><td colspan="10">no markets</td></tr>')+'</tbody></table></div></div>'+fillsTable(b)+apiBlock(b)+'</section>';
}
function boardHtml(rows){
  return (rows||[]).map(function(b){
    const cells=(b.markets||[]).map(function(m){
      const work=Number(m.bidUsd||0)+Number(m.askUsd||0);
      const vol=Number(m.buyUsd||0)+Number(m.sellUsd||0);
      return {m,work,vol,score:work*2+vol};
    }).sort(function(a,c){return c.score-a.score||c.work-a.work||c.vol-a.vol;});
    if(!cells.length) return '';
    const inner=cells.map(function(c){
      return '<div class="cell"><div class="sym">'+esc(c.m.symbol)+'</div>'+
        sparkSvg(c.m.spark,c.m.sparkFills,c.m.orders)+
        '<div class="sz">ord $'+fmtN(c.work)+' · vol $'+fmtN(c.vol)+(fmtSpread(c.m)?' · '+fmtSpread(c.m):'')+'</div></div>';
    }).join('');
    const q=projectOf(b);
    const volNow=sumMarkets(b,'buyUsd')+sumMarkets(b,'sellUsd');
    const wal=b.pnl&&b.pnl.walletGain;
    return '<section class="board-card"><h2>'+esc(b.bot)+' <small>'+esc(b.exchange||'')+' '+esc(b.quote||'')+'</small></h2>'+
      '<div class="hdr-stats">'+
        '<div class="col"><label>vol</label><b>$'+fmtN(volNow)+'</b><span>/h $'+fmtN(q.vol)+'</span><span>/d $'+fmtN(q.vol*24)+'</span></div>'+
        '<div class="col"><label>wallet</label><b>'+fmt(wal)+'</b><span>/h '+fmt(q.wallet)+'</span><span>/d '+fmt(q.wallet*24)+'</span></div>'+
        '<div class="col"><label>bank</label><b>$'+fmtN(b.bankedRun)+'</b><span>/h '+fmt(q.bank)+'</span><span>/d '+fmt(q.bank*24)+'</span></div>'+
      '</div>'+
      '<div class="sparks">'+inner+'</div></section>';
  }).join('');
}
function render(data){
  const rows=data.bots||[];
  document.getElementById('meta').textContent=rows.length?rows.length+' bot(s) · live websocket':'waiting for bot POSTs';
  const board=document.getElementById('board');
  if(board) board.innerHTML=boardHtml(rows);
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
      const pnl = msg.pnl || prev.pnl || {};
      const vol = (msg.markets || prev.markets || []).reduce((s, m) => s + Number(m.buyUsd || 0) + Number(m.sellUsd || 0), 0);
      noteKpiSpark(id, {
        wallet: pnl.walletGain,
        price: pnl.pricePnl,
        maker: pnl.makerPnl,
        fees: pnl.fees != null ? -pnl.fees : 0,
        vol,
        bank: Number(msg.bankedRun != null ? msg.bankedRun : prev.bankedRun || 0),
      });
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
      const fid = String(fill.orderId || fill.id || '');
      let fills = prev.fills || [];
      const existing = fills.findIndex((f) => String(f.orderId || f.id || '') === fid && fid);
      if (existing >= 0) fills[existing] = { ...fills[existing], ...fill };
      else fills = [fill, ...fills];
      fills = fills.slice(0, 10);
      const markets = (prev.markets || []).map((m) => {
        const orders = (m.orders || []).filter((o) => {
          const oid = String(o.id || o.orderId || '');
          if (!fid || !oid) return true;
          return !(oid === fid || fid.startsWith(oid) || oid.startsWith(fid.slice(0, 8)));
        });
        return {
          ...m,
          orders,
          bids: orders.filter((o) => String(o.side).toLowerCase() === 'buy').length,
          asks: orders.filter((o) => String(o.side).toLowerCase() === 'sell').length,
        };
      });
      noteSparkFill(id, fill);
      bots.set(id, { ...prev, fills, markets, bot: id });
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
