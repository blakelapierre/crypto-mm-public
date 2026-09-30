import http from 'http';
import { WebSocketServer } from 'ws';
import { loadProjectEnv } from '../shared/env.js';
import { backtestRungs } from '../shared/rungs.js';

loadProjectEnv(process.env.BOT_CONFIG || 'configs/web.env');

const PORT = Number(process.env.STATUS_PORT || 8787);
const TOKEN = process.env.STATUS_TOKEN || '';
const bots = new Map();
const sparks = new Map();
const volSparks = new Map();
const rangeSparks = new Map();
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
  const seen = new Set();
  for (const m of markets || []) {
    const mid = parseFloat(m.mid);
    if (!(mid > 0) || !m.symbol) continue;
    const k = bot + ':' + m.symbol;
    seen.add(k);
    const arr = sparks.get(k) || [];
    const last = arr[arr.length - 1];
    if (!last || now - last.t >= SPARK_GAP) arr.push({ t: now, p: mid });
    else { last.p = mid; last.t = now; }
    while (arr.length && now - arr[0].t > SPARK_MS) arr.shift();
    sparks.set(k, arr);
  }
  if (bot) {
    const prefix = String(bot) + ':';
    for (const [k, arr] of sparks) {
      if (!k.startsWith(prefix) || seen.has(k) || !arr.length) continue;
      const last = arr[arr.length - 1];
      if (now - last.t >= SPARK_GAP) arr.push({ t: now, p: last.p, held: true });
    }
  }
  pruneSparks();
}
function holdAllSparks() {
  const now = Date.now();
  for (const [, arr] of sparks) {
    if (!arr.length) continue;
    const last = arr[arr.length - 1];
    if (now - last.t >= SPARK_GAP) arr.push({ t: now, p: last.p, held: true });
  }
  pruneSparks();
}
setInterval(holdAllSparks, SPARK_GAP);

function noteRangeSparks(bot, movers) {
  const now = Date.now();
  for (const m of movers || []) {
    const rng = Number(m.rangePct || 0);
    if (!m.symbol) continue;
    const k = bot + ':' + String(m.symbol).toUpperCase();
    const arr = rangeSparks.get(k) || [];
    const last = arr[arr.length - 1];
    if (!last || now - last.t >= SPARK_GAP) arr.push({ t: now, p: rng });
    else last.p = rng;
    while (arr.length && now - arr[0].t > SPARK_MS) arr.shift();
    rangeSparks.set(k, arr);
  }
}
function noteVolSparks(bot, markets) {
  const now = Date.now();
  for (const m of markets || []) {
    if (!m.symbol) continue;
    const vol = Number(m.buyUsd || 0) + Number(m.sellUsd || 0);
    const k = bot + ':' + m.symbol;
    const arr = volSparks.get(k) || [];
    const last = arr[arr.length - 1];
    if (!last || now - last.t >= SPARK_GAP) arr.push({ t: now, p: vol });
    else last.p = vol;
    while (arr.length && now - arr[0].t > SPARK_MS) arr.shift();
    volSparks.set(k, arr);
  }
}

function downsample(points, maxPts) {
  const arr = points || [];
  if (arr.length <= maxPts) return arr;
  const out = [];
  const step = (arr.length - 1) / (maxPts - 1);
  for (let i = 0; i < maxPts; i++) out.push(arr[Math.round(i * step)]);
  return out;
}
function pruneSparks() {
  const cut = Date.now() - SPARK_MS;
  for (const [k, arr] of sparks) {
    while (arr.length && arr[0].t < cut) arr.shift();
    if (!arr.length) sparks.delete(k);
  }
  for (const [k, arr] of sparkFills) {
    const keep = (arr || []).filter((f) => Date.parse(f.ts || 0) >= cut);
    if (keep.length) sparkFills.set(k, keep);
    else sparkFills.delete(k);
  }
}
function sparkSeries(bot, symbol) {
  return downsample(sparks.get(bot + ':' + symbol) || [], Number(process.env.SPARK_UI_POINTS || 180));
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
function mergeFills(prev, incoming) {
  const map = new Map();
  for (const f of [...(incoming || []), ...(prev || [])]) {
    const id = String(f.orderId || f.id || '') + '|' + String(f.ts || '') + '|' + String(f.price || '') + '|' + String(f.size || '');
    if (!map.has(id)) map.set(id, f);
  }
  return [...map.values()].sort((a, b) => Date.parse(b.ts || 0) - Date.parse(a.ts || 0)).slice(0, 10);
}
function mergeMarkets(prev, incoming) {
  const by = new Map((prev || []).map((m) => [String(m.symbol || '').toUpperCase(), { ...m }]));
  for (const m of incoming || []) {
    const k = String(m.symbol || '').toUpperCase();
    if (!k) continue;
    const old = by.get(k) || {};
    const live = old.orderTs && Date.now() - old.orderTs < 20000;
    const orders = live && old.orders && old.orders.length ? old.orders : (m.orders || old.orders || []);
    const open = (orders || []).filter((o) => o.status === 'open');
    const fromBook = (side) => open.filter((o) => o.side === side).reduce((s, o) => s + Number(o.usd != null ? o.usd : Number(o.size) * Number(o.price) || 0), 0);
    by.set(k, {
      ...old,
      ...m,
      orders,
      orderTs: live ? old.orderTs : (m.orders ? Date.now() : old.orderTs),
      bidUsd: open.length ? fromBook('buy') : (m.bidUsd != null ? m.bidUsd : old.bidUsd),
      askUsd: open.length ? fromBook('sell') : (m.askUsd != null ? m.askUsd : old.askUsd),
      bids: open.length ? open.filter((o) => o.side === 'buy').length : m.bids,
      asks: open.length ? open.filter((o) => o.side === 'sell').length : m.asks,
    });
  }
  return [...by.values()];
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
    edgeBps: b.edgeBps,
    markets: (b.markets || []).map((m) => ({ ...m, spark: sparkSeries(b.bot, m.symbol), volSpark: volSparks.get(b.bot + ':' + m.symbol) || [], rangeSpark: rangeSparks.get(b.bot + ':' + String(m.symbol).toUpperCase()) || [], sparkFills: sparkFillsFor(b.bot, m.symbol), rungs: backtestRungs(sparkSeries(b.bot, m.symbol), parseFloat(m.fee)), edgeBps: m.edgeBps })),
    movers: (b.movers || []).map((m) => ({ ...m, rangeSpark: rangeSparks.get(b.bot + ':' + String(m.symbol).toUpperCase()) || [] })),
  }));
}

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>crypto-mm status</title>
<style>
:root{color-scheme:dark}
body{font-family:ui-sans-serif,system-ui,sans-serif;background:#0e1116;color:#e7ecf3;margin:0;font-size:13px}
#chrome{position:sticky;top:0;z-index:30;background:#0e1116;padding:10px 14px 6px}
#shell{display:flex;align-items:flex-start;gap:12px;padding:0 14px 0}
#pin{flex:1;min-width:0;max-height:40vh;overflow-y:auto;background:#0e1116;padding:0 0 8px;border-bottom:1px solid #30363d}
#bank.bank-card{position:sticky;top:10px;flex:0 0 240px;max-height:40vh;overflow:hidden;display:flex;flex-direction:column;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:8px 10px}
#root{padding:10px 14px 24px}
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
.spark{vertical-align:middle;display:block}.spark-wrap{display:flex;flex-direction:column;align-items:flex-start;gap:0}.spark-row{display:flex;flex-direction:row;align-items:center;gap:2px}.spark-time{font-size:7px;opacity:.75;writing-mode:vertical-rl;transform:rotate(180deg);line-height:1;letter-spacing:.02em;flex:0 0 auto}.spark-hl{font-size:7px;opacity:.75;line-height:1.1;font-variant-numeric:tabular-nums}.spark-hl.hi{color:#3fb950}.spark-hl.lo{color:#f85149}
.book-wrap{display:flex;gap:12px;align-items:flex-start}
.book-wrap .mfills{font-size:11px;min-width:160px}.book-wrap .mpnl{font-size:11px;min-width:110px;font-variant-numeric:tabular-nums}
.book-wrap .mfills .buy{color:#3fb950}.book-wrap .mfills .sell{color:#f85149}
.fills{margin-top:12px;font-size:12px}
.fills td{font-family:ui-monospace,monospace}
#board.board{display:flex;flex-direction:row;flex-wrap:wrap;align-items:flex-start;justify-content:center;gap:12px;margin:8px 0 14px;width:100%}
#board .board-card{flex:0 1 auto;width:auto;max-width:100%;display:inline-flex;flex-direction:column;align-items:center;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:8px 10px;margin:0;box-sizing:border-box}
.board-card h2{margin:0 0 6px;text-align:center}
.hdr-stats{display:flex;gap:12px;margin:0 0 6px;font-size:11px;justify-content:center;flex-wrap:wrap}
.hdr-stats .col{display:flex;flex-direction:column;gap:1px}
.hdr-stats label{color:#8b98a5;font-size:10px}
.hdr-stats b{font-size:13px}
.hdr-stats span{color:#8b98a5}
.kpi span.ph{font-size:12px}.kpi span.pd{font-size:11px;opacity:.95}
.kpi span.pw{font-size:10px;opacity:.85}.kpi span.pm{font-size:9px;opacity:.75}
.kpi span.py{font-size:8px;opacity:.65}
.hdr-stats .pw{font-size:10px}.hdr-stats .pm{font-size:9px}.hdr-stats .py{font-size:8px;opacity:.7}
.board-card .sparks{display:flex;flex-direction:row;flex-wrap:wrap;align-items:stretch;justify-content:center;gap:8px;line-height:normal;width:100%}
.board-card .cell{flex:0 0 auto;width:118px;min-height:110px;display:flex;flex-direction:column;align-items:center;text-align:center;margin:0;background:#0e1116;border:1px solid #30363d;border-radius:8px;padding:6px 8px;box-sizing:border-box}
.board-card .cell .sym{font-size:12px;font-weight:600}
.board-card .cell .sz{font-size:10px;color:#8b98a5;line-height:1.2;min-height:2.2em;margin-top:auto}
.movers{display:flex;flex-direction:row;flex-wrap:wrap;justify-content:center;align-items:flex-start;gap:6px;margin:6px 0 4px;width:100%}
.movers .row{display:flex;flex-wrap:nowrap;justify-content:flex-start;align-items:flex-end;gap:6px;max-width:100%;overflow-x:auto}
.movers .mv{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:4px 6px;min-width:72px;text-align:center;flex:0 0 auto}
.movers .mv .s{font-weight:600;font-size:11px}
.movers .mv .r{font-size:10px;font-variant-numeric:tabular-nums}
.movers .up{color:#3fb950}.movers .dn{color:#f85149}
.movers h3{margin:0;font-size:11px;color:#8b98a5;font-weight:600;text-align:center;width:100%}
.movers .botg{display:flex;flex-direction:column;align-items:center;background:#161b22;border:1px solid #30363d;border-radius:10px;padding:6px 8px;margin:0 4px;width:auto;max-width:100%;flex:0 1 auto;box-sizing:border-box}
.movers .botg .bn{width:100%;text-align:center;font-size:10px;color:#8b98a5}
.movers .botg .sub{width:100%;text-align:center;font-size:9px;color:#8b98a5;margin-top:4px}
#top-row{display:flex;flex-wrap:nowrap;justify-content:flex-start;align-items:stretch;gap:12px;width:100%;flex:1;min-height:0;overflow:hidden}
#board.board{flex:1 1 auto;min-width:0}
#bank .bank-list{overflow-y:auto;flex:1;min-height:0;font-size:11px;font-variant-numeric:tabular-nums}
#bank table{width:100%;border-collapse:collapse}
#bank td{padding:1px 4px}
#bank h3{margin:0 0 2px;font-size:12px}
#bank .bank-total{font-size:16px;font-weight:700;margin:0 0 6px;font-variant-numeric:tabular-nums}
</style>
</head>
<body>
<div id="chrome">
<h1>crypto-mm status <span class="age" id="conn"><span class="dot"></span>connecting</span></h1>
<p class="age" id="meta">waiting for bots</p>
</div>
<div id="shell">
<div id="pin">
<div id="movers" class="movers"></div>
<div id="top-row">
<div id="board" class="board"></div>
</div>
</div>
<div id="bank" class="bank-card"></div>
</div>
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
function projLines(q, key, sparkPts, t0, money){
  const h=q[key], d=h*24, w=h*24*7, m=h*24*30, y=h*24*365;
  const show=money?fmt:fmtN;
  const pre=money?'':'$';
  const sign=function(v){return money?show(v):pre+show(v);};
  return '<span class="ph">/h '+sign(h)+'</span>'+sparkSvg(rateSeries(sparkPts,t0,false))+
    '<span class="pd">/d '+sign(d)+'</span>'+sparkSvg(rateSeries(sparkPts,t0,true))+
    '<span class="pw">/7d '+sign(w)+'</span>'+
    '<span class="pm">/30d '+sign(m)+'</span>'+
    '<span class="py">/365d '+sign(y)+'</span>';
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
function sparkSvg(points, fills, orders, opt){
  const ptsIn=(!points||!points.length)?[]:points[0].p!=null?points:points.map(function(p){return {t:0,p:p};});
  if(ptsIn.length<2) return '';
  const w=(opt&&opt.w)||88,h=(opt&&opt.h)||28;
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
  function spanLabel(ms){
    const s=Math.max(0,Number(ms)||0);
    if(s>=86400000) return (s/86400000).toFixed(2)+'d';
    if(s>=3600000) return (s/3600000).toFixed(1)+'h';
    return Math.max(1,Math.round(s/60000))+'m';
  }
  return '<div class="spark-wrap"><div class="spark-hl hi">H '+hi.toFixed(d)+'</div>'+
    '<div class="spark-row"><div class="spark-time">'+spanLabel(spanT)+'</div>'+
    '<svg class="spark" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'"><polyline fill="none" stroke="'+(up?'#3fb950':'#f85149')+'" stroke-width="1.2" points="'+line+'"/>'+dots+ticks+'</svg></div>'+
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
  const ords=(m.orders||[]).filter(function(o){return String(o.status||'open').toLowerCase()==='open';});
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
    '<tr><td>'+esc(m.symbol)+'<div>'+sparkSvg(m.spark, m.sparkFills, m.orders)+'</div></td><td>'+esc(fmtPx(m.mid,priceDigits(m.orders)))+'</td><td>'+esc(fmtSpread(m))+'</td><td>'+(m.edgeBps==null?'':((Number(m.edgeBps)>=0?'+':'')+Number(m.edgeBps).toFixed(0)))+'</td><td>'+m.bids+'/'+m.asks+
    '<div class="ord">bid $'+fmtN(m.bidUsd)+' / ask $'+fmtN(m.askUsd)+'</div></td>'+
    '<td>'+fmtN(m.bidUsd)+'</td><td>'+fmtN(m.askUsd)+'</td><td>'+fmtN(m.invUsd)+'</td><td>'+fmtN(m.fills)+'</td><td>'+fmtN(m.buyUsd)+'</td><td>'+fmtN(m.sellUsd)+
    '</td><td>'+esc(m.vol)+'</td><td>'+esc(m.fee)+'</td><td>'+esc(m.w)+'</td></tr>'+
    '<tr class="orders"><td></td><td colspan="11">'+orderBook(m)+'</td></tr>'
  ).join('');
  const age=b.ts?Math.round((Date.now()-b.ts)/1000)+'s ago':'';
  const q=projectOf(b);
  const t0=(b.pnl&&b.pnl.startedAt)||b.ts||Date.now();
  return '<section class="card"><h2>'+esc(b.bot)+' <small>'+esc(b.exchange||'')+' '+esc(b.quote||'')+
    '</small> <span class="age">'+age+'</span></h2><div class="kpi">'+
    '<div><label>Wallet</label><b>'+fmt(p.walletGain)+'</b><span>'+fmtN(p.lastEquity)+'</span>'+sparkSvg((b.kpiSpark||{}).wallet)+projLines(q,'wallet',(b.kpiSpark||{}).wallet,t0,true)+'</div>'+
    '<div><label>PRICE</label><b>'+fmt(p.pricePnl)+'</b>'+sparkSvg((b.kpiSpark||{}).price)+projLines(q,'price',(b.kpiSpark||{}).price,t0,true)+'</div>'+
    '<div><label>MAKER</label><b>'+fmt(p.makerPnl)+'</b>'+sparkSvg((b.kpiSpark||{}).maker)+projLines(q,'maker',(b.kpiSpark||{}).maker,t0,true)+'</div>'+
    '<div><label>FEES</label><b>'+fmt(p.fees!=null?-p.fees:null)+'</b>'+sparkSvg((b.kpiSpark||{}).fees)+projLines({fees:q.fees!=null?-q.fees:0},'fees',(b.kpiSpark||{}).fees,t0,true)+'</div>'+
    '<div><label>TAKER</label><b>'+fmt(p.takerFees!=null?-p.takerFees:null)+'</b></div>'+
    '<div><label>GAP</label><b>'+fmt(p.otherPnl)+'</b></div>'+
    '<div><label>BANK</label><b>'+fmt(b.banked)+'</b></div>'+
    '<div><label>Buy orders</label><b>$'+fmtN(w.bids)+'</b></div>'+
    '<div><label>Sell orders</label><b>$'+fmtN(w.asks)+'</b></div>'+
    '<div><label>Book</label><b>$'+fmtN(Number(w.bids||0)+Number(w.asks||0))+'</b></div>'+
    '<div><label>Inventory</label><b>$'+fmtN(w.inventory)+'</b></div>'+
    '<div><label>Cash '+esc(b.quote||'')+'</label><b>$'+fmtN(w.cash)+'</b></div>'+
    '<div><label>Cash on bids</label><b>$'+fmtN(w.cashHold)+'</b></div>'+
    '<div><label>Equity</label><b>$'+fmtN(w.equity||p.lastEquity)+'</b></div>'+
    '<div><label>Fills</label><b>'+(w.fills!=null?String(w.fills):String((b.fills||[]).length))+'</b></div>'+
    '<div><label>Vol buy</label><b>'+fmtN(sumMarkets(b,'buyUsd'))+'</b></div>'+
    '<div><label>Vol sell</label><b>'+fmtN(sumMarkets(b,'sellUsd'))+'</b></div>'+
    '<div><label>Vol</label><b>'+fmtN(sumMarkets(b,'buyUsd')+sumMarkets(b,'sellUsd'))+'</b>'+sparkSvg((b.kpiSpark||{}).vol)+projLines(q,'vol',(b.kpiSpark||{}).vol,t0,false)+'</div>'+
    '<div><label>Bank run</label><b>'+fmt(b.bankedRun)+'</b>'+sparkSvg((b.kpiSpark||{}).bank)+projLines(q,'bank',(b.kpiSpark||{}).bank,t0,true)+'</div>'+
    '<div><label>Edge 1h</label><b>'+(b.edgeBps==null?'n/a':(Number(b.edgeBps)>=0?'+':'')+Number(b.edgeBps).toFixed(0)+'bps')+'</b></div></div>'+
    
    '<div class="split"><div class="wallet">'+walletTable(b)+'</div><div class="markets"><table><thead><tr><th>Mkt</th><th>mid</th><th>spr</th><th>edge</th><th>bid/ask</th><th>bid$</th><th>ask$</th><th>inv$</th><th>fills</th><th>buy vol</th><th>sell vol</th><th>vol</th><th>fee</th><th>w</th></tr></thead><tbody>'+
    (mk||'<tr><td colspan="10">no markets</td></tr>')+'</tbody></table></div></div>'+fillsTable(b)+apiBlock(b)+'</section>';
}
function boardHtml(rows){
  return (rows||[]).map(function(b){
    const cells=(b.markets||[]).map(function(m){
      const open=(m.orders||[]).filter(function(o){return o.status==='open';});
      const from=function(side){return open.filter(function(o){return o.side===side;}).reduce(function(s,o){return s+Number(o.usd!=null?o.usd:Number(o.size)*Number(o.price)||0);},0);};
      const bidU=open.length?from('buy'):Number(m.bidUsd||0);
      const askU=open.length?from('sell'):Number(m.askUsd||0);
      const work=bidU+askU;
      const vol=Number(m.buyUsd||0)+Number(m.sellUsd||0);
      return {m,work,vol,w:weightOf(m)};
    }).sort(function(a,c){return c.w-a.w||c.work-a.work;});
    if(!cells.length) return '';
    const inner=cells.map(function(c){
      const e=c.m.edgeBps==null?'':((Number(c.m.edgeBps)>=0?'+':'')+Number(c.m.edgeBps).toFixed(0)+'e');
      const rng=c.m.vol&&String(c.m.vol).indexOf('%')>=0?c.m.vol:(c.m.rangePct!=null?Number(c.m.rangePct).toFixed(2)+'%':'');
      const maker=Number(c.m.makerPnl||0), fees=Number(c.m.fees||0), price=Number(c.m.pricePnl||0);
      const net=maker+price+(-Math.abs(fees));
      const netCls=net>0?'up':(net<0?'dn':'');
      return '<div class="cell"><div class="sym">'+esc(c.m.symbol)+'</div>'+
        sparkSvg(c.m.spark,c.m.sparkFills,c.m.orders,{w:88,h:28})+
        sparkSvg(c.m.volSpark,null,null,{w:88,h:16})+
        '<div class="sz">$'+fmtN(c.work)+' v$'+fmtN(c.vol)+(rng?' · '+esc(rng):'')+'<br>w '+esc(c.m.w||'')+(e?' '+e:'')+
        '<br><span class="'+netCls+'">net '+fmt(net)+'</span></div></div>';
    }).join('');
    const q=projectOf(b);
    const volNow=sumMarkets(b,'buyUsd')+sumMarkets(b,'sellUsd');
    const wal=b.pnl&&b.pnl.walletGain;
    const eq=b.pnl&&b.pnl.lastEquity;
    const edge=b.edgeBps;
    return '<section class="board-card"><h2>'+esc(b.bot)+' <small>'+esc(b.exchange||'')+' '+esc(b.quote||'')+'</small></h2>'+
      '<div class="hdr-stats">'+
        '<div class="col"><label>wallet</label><b>'+fmt(wal)+'</b><span>$'+fmtN(eq)+'</span>'+sparkSvg((b.kpiSpark||{}).wallet,null,null,{w:56,h:16})+'<span>/h '+fmt(q.wallet)+'</span><span>/d '+fmt(q.wallet*24)+'</span><span class="pw">/7d '+fmt(q.wallet*24*7)+'</span><span class="pm">/30d '+fmt(q.wallet*24*30)+'</span><span class="py">/365d '+fmt(q.wallet*24*365)+'</span></div>'+
        '<div class="col"><label>edge 1h</label><b>'+(edge==null?'n/a':(Number(edge)>=0?'+':'')+Number(edge).toFixed(0)+'bps')+'</b></div>'+
        '<div class="col"><label>vol</label><b>$'+fmtN(volNow)+'</b>'+sparkSvg((b.kpiSpark||{}).vol,null,null,{w:56,h:18})+'<span>/h $'+fmtN(q.vol)+'</span><span>/d $'+fmtN(q.vol*24)+'</span><span class="pw">/7d $'+fmtN(q.vol*24*7)+'</span><span class="pm">/30d $'+fmtN(q.vol*24*30)+'</span><span class="py">/365d $'+fmtN(q.vol*24*365)+'</span></div>'+
        '<div class="col"><label>buys</label><b>$'+fmtN((b.working||{}).bids)+'</b></div>'+
        '<div class="col"><label>sells</label><b>$'+fmtN((b.working||{}).asks)+'</b></div>'+
        '<div class="col"><label>book</label><b>$'+fmtN(Number((b.working||{}).bids||0)+Number((b.working||{}).asks||0))+'</b></div>'+
        '<div class="col"><label>cash</label><b>$'+fmtN((b.working||{}).cash)+'</b></div>'+
        '<div class="col"><label>inv</label><b>$'+fmtN((b.working||{}).inventory)+'</b></div>'+
        '<div class="col"><label>fills</label><b>'+((b.working&&b.working.fills)!=null?String(b.working.fills):'0')+'</b></div>'+
        '<div class="col"><label>bank</label><b>$'+fmtN(b.bankedRun)+'</b><span>/h '+fmt(q.bank)+'</span><span>/d '+fmt(q.bank*24)+'</span><span class="pw">/7d '+fmt(q.bank*24*7)+'</span><span class="pm">/30d '+fmt(q.bank*24*30)+'</span><span class="py">/365d '+fmt(q.bank*24*365)+'</span></div>'+
      '</div>'+
      '<div class="sparks">'+inner+'</div></section>';
  }).join('');
}
function moversHtml(rows){
  function cell(x, kind){
    const ret=x.ret, cls=ret>0?'up':(ret<0?'dn':'');
    const extra=kind==='vol'
      ? ((x.rangePct||0).toFixed(2)+'% rng')
      : (ret==null?'':((ret>=0?'+':'')+(ret*100).toFixed(2)+'%'));
    return '<div class="mv"><div class="s">'+esc(x.symbol)+'</div>'+(x.spark?sparkSvg(x.spark,x.sparkFills,x.orders,{w:40,h:14}):'')+'<div class="r '+cls+'">'+extra+'</div></div>';
  }
  function itemsOf(b, kind){
    const items=[];
    const seen={};
    function add(row){
      const k=String(row.symbol||'').toUpperCase();
      if(!k) return;
      const prev=seen[k];
      if(!prev){ seen[k]=row; items.push(row); return; }
      if(kind==='vol' && (row.rangePct||0)>(prev.rangePct||0)) Object.assign(prev,row);
      if(kind!=='vol' && Math.abs(row.ret||0)>Math.abs(prev.ret||0)) Object.assign(prev,row);
    }
    if(kind==='vol'){
      (b.movers||[]).forEach(function(m){
        const mk=(b.markets||[]).find(function(x){return String(x.symbol).toUpperCase()===String(m.symbol).toUpperCase();})||{};
        add({symbol:m.symbol,rangePct:Number(m.rangePct||0),ret:Number(m.ret||0),spark:m.rangeSpark||mk.rangeSpark,sparkFills:null,orders:null});
      });
      if(!items.length){
        (b.markets||[]).forEach(function(m){
          const pts=m.spark||[];
          if(pts.length<2) return;
          const hi=Math.max.apply(null,pts.map(function(p){return Number(p.p||p);}));
          const lo=Math.min.apply(null,pts.map(function(p){return Number(p.p||p);}));
          const z=Number(pts[pts.length-1].p||pts[pts.length-1]);
          add({symbol:m.symbol,rangePct:z>0?((hi-lo)/z)*100:0,spark:pts,sparkFills:m.sparkFills,orders:m.orders});
        });
      }
      items.sort(function(a,c){return (c.rangePct||0)-(a.rangePct||0);});
    } else {
      (b.movers||[]).forEach(function(m){
        add({symbol:m.symbol,ret:Number(m.ret||0),rangePct:Number(m.rangePct||0)});
      });
      if(!items.length){
        (b.markets||[]).forEach(function(m){
          const pts=m.spark||[];
          if(pts.length<2) return;
          const a=Number(pts[0].p||pts[0]), z=Number(pts[pts.length-1].p||pts[pts.length-1]);
          if(!(a>0&&z>0)) return;
          add({symbol:m.symbol,ret:(z-a)/a,spark:pts,sparkFills:m.sparkFills,orders:m.orders});
        });
      }
      items.sort(function(a,c){return Math.abs(c.ret||0)-Math.abs(a.ret||0);});
    }
    return items.slice(0,8);
  }
  const cards=(rows||[]).map(function(b){
    const vols=itemsOf(b,'vol');
    const moves=itemsOf(b,'move');
    if(!vols.length && !moves.length) return '';
    return '<div class="botg"><div class="bn">'+esc(b.bot)+' '+esc(b.exchange||'')+'</div>'+
      '<div class="sub">15m vol</div><div class="row">'+vols.map(function(x){return cell(x,'vol');}).join('')+'</div>'+
      '<div class="sub">15m price</div><div class="row">'+moves.map(function(x){return cell(x,'move');}).join('')+'</div></div>';
  }).join('');
  return '<div class="row">'+cards+'</div>';
}
function bankHtml(rows){
  const mids={};
  const hold={};
  (rows||[]).forEach(function(b){
    (b.markets||[]).forEach(function(m){ const p=parseFloat(m.mid); if(m.symbol&&p>0) mids[String(m.symbol).toUpperCase()]=p; });
    (b.wallet||[]).forEach(function(w){ const p=Number(w.mid); if(w.asset&&p>0) mids[String(w.asset).toUpperCase()]=p; });
    (b.bankHoldings||[]).forEach(function(h){
      const a=String(h.asset||'').toUpperCase();
      if(!a) return;
      hold[a]=(hold[a]||0)+Number(h.qty||0);
    });
  });
  const rowsH=Object.keys(hold).map(function(a){
    const qty=hold[a], mid=mids[a]||(a==='USDC'||a==='USD'||a==='USDT'?1:0);
    return {a,qty,usd:qty*mid};
  }).filter(function(x){return x.qty>0;}).sort(function(x,y){return y.usd-x.usd;});
  const tot=rowsH.reduce(function(s,x){return s+x.usd;},0);
  if(!rowsH.length) return '<h3>bank</h3><div class="age">no bank snapshot yet</div>';
  return '<h3>bank</h3><div class="bank-total">$'+fmtN(tot)+'</div><div class="bank-list"><table>'+rowsH.map(function(x){
    return '<tr><td>'+esc(x.a)+'</td><td>'+esc(x.qty.toPrecision(6))+'</td><td>$'+fmtN(x.usd)+'</td></tr>';
  }).join('')+'</table></div>';
}
function render(data){
  const rows=data.bots||[];
  document.getElementById('meta').textContent=rows.length?rows.length+' bot(s) · live websocket':'waiting for bot POSTs';
  const mv=document.getElementById('movers');
  if(mv) mv.innerHTML=moversHtml(rows);
  const board=document.getElementById('board');
  if(board) board.innerHTML=boardHtml(rows);
  const bank=document.getElementById('bank');
  if(bank){
    const snap=JSON.stringify((rows||[]).map(function(b){return b.bankHoldings||[];}));
    if(window._bankSnap!==snap){ window._bankSnap=snap; bank.innerHTML=bankHtml(rows); }
  }
  document.getElementById('root').innerHTML=rows.map(card).join('')||'<p>No reports yet.</p>';
}
function connect(){
  const q=TOKEN_Q;
  const proto=location.protocol==='https:'?'wss':'ws';
  const ws=new WebSocket(proto+'://'+location.host+'/ws'+q);
  const dot=document.getElementById('conn');
  ws.onopen=()=>{dot.innerHTML='<span class="dot ok"></span>live';};
  let last=null;
  ws.onmessage=(ev)=>{try{
    const msg=JSON.parse(ev.data);
    if(msg&&msg.type==='orders'&&last){
      const bot=(last.bots||[]).find(b=>b.bot===msg.bot);
      if(bot){
        let m=(bot.markets||[]).find(x=>String(x.symbol).toUpperCase()===String(msg.symbol||'').toUpperCase());
        if(!m){m={symbol:msg.symbol,orders:[]};bot.markets=bot.markets||[];bot.markets.push(m);}
        m.orders=msg.orders||[];
        if(msg.mid)m.mid=msg.mid;
      }
      render(last);return;
    }
    if(msg&&msg.bots) last=msg;
    render(msg);
  }catch(e){}};
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
      bots.set(id, { ...prev, ...msg, markets: mergeMarkets(prev.markets, msg.markets), fills: mergeFills(prev.fills, msg.fills), bankHoldings: (msg.bankHoldings && msg.bankHoldings.length) ? msg.bankHoldings : (prev.bankHoldings || []), bot: id, ts: Date.now() });
      noteSparks(id, msg.markets || prev.markets);
      noteVolSparks(id, msg.markets || prev.markets);
      noteRangeSparks(id, msg.movers || []);
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
  if (req.method === 'POST' && url.pathname === '/orders') {
    if (!auth(req)) { res.writeHead(401); res.end('unauthorized'); return; }
    let body = '';
    for await (const c of req) body += c;
    try {
      const msg = JSON.parse(body || '{}');
      const id = String(msg.bot || 'unknown');
      const prev = bots.get(id) || { bot: id, markets: [] };
      const markets = [...(prev.markets || [])];
      let m = markets.find((x) => String(x.symbol).toUpperCase() === String(msg.symbol || '').toUpperCase());
      if (!m) {
        m = { symbol: msg.symbol, orders: [] };
        markets.push(m);
      }
      m.orders = msg.orders || [];
      m.orderTs = Date.now();
      if (msg.mid) m.mid = msg.mid;
      if (msg.pair) m.pair = msg.pair;
      const open = (m.orders || []).filter(function(o){ return o.status === 'open'; });
      m.bidUsd = open.filter(function(o){ return o.side === 'buy'; }).reduce(function(s,o){ return s + Number(o.usd != null ? o.usd : Number(o.size)*Number(o.price)); }, 0);
      m.askUsd = open.filter(function(o){ return o.side === 'sell'; }).reduce(function(s,o){ return s + Number(o.usd != null ? o.usd : Number(o.size)*Number(o.price)); }, 0);
      m.bids = open.filter(function(o){ return o.side === 'buy'; }).length;
      m.asks = open.filter(function(o){ return o.side === 'sell'; }).length;
      const working = { ...(prev.working || {}), bids: 0, asks: 0 };
      for (const x of markets) {
        working.bids += Number(x.bidUsd || 0);
        working.asks += Number(x.askUsd || 0);
      }
      bots.set(id, { ...prev, markets, working, bot: id });
      broadcast();
      try {
        const frame = JSON.stringify({ type: 'orders', bot: id, symbol: msg.symbol, orders: m.orders, mid: m.mid });
        for (const c of wss.clients) if (c.readyState === 1) c.send(frame);
      } catch { /* ignore */ }
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
      fills = mergeFills(fills, []);
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
