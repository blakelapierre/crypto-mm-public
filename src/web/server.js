import http from 'http';
import { loadProjectEnv } from '../shared/env.js';

loadProjectEnv(process.env.BOT_CONFIG || 'configs/web.env');

const PORT = Number(process.env.STATUS_PORT || 8787);
const TOKEN = process.env.STATUS_TOKEN || '';
const bots = new Map();

function auth(req) {
  if (!TOKEN) return true;
  const h = req.headers['x-status-token'] || '';
  const q = new URL(req.url, 'http://local').searchParams.get('token');
  return h === TOKEN || q === TOKEN;
}
function collect() {
  return [...bots.values()].sort((a, b) => String(a.bot).localeCompare(String(b.bot)));
}
function esc(s) {
  return String(s ?? '').replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
}
function fmt(n) {
  if (n == null || !Number.isFinite(Number(n))) return 'n/a';
  const x = Number(n);
  return (x >= 0 ? '+' : '') + x.toFixed(4);
}
function fmtN(n) {
  if (n == null || !Number.isFinite(Number(n))) return '';
  return Number(n).toFixed(2);
}
function sumMarkets(b, key) {
  return (b.markets || []).reduce((s, m) => s + Number(m[key] || 0), 0);
}
function weightOf(m) {
  return Number(m.wNum || parseFloat(m.w) || 0);
}
function apiHtml(b) {
  const a = b.api || {};
  const last = a.last || [];
  if (!last.length) return '';
  return '<div class="api">API avg ' + (a.avg || 0) + 'ms max ' + (a.max || 0) + 'ms<ul>' +
    last.slice().reverse().map((c) => '<li>' + c.ms + 'ms ' + esc(c.venue) + ' ' + esc(c.label) + (c.ok === false ? ' FAIL' : '') + '</li>').join('') +
    '</ul></div>';
}

function htmlPage() {
  const rows = collect();
  const cards = rows.map((b) => {
    const p = b.pnl || {};
    const w = b.working || {};
    const mk = [...(b.markets || [])].sort((x, y) => weightOf(y) - weightOf(x)).map((m) => {
      const ords = (m.orders || []).map((o) =>
        String(o.side || '').toUpperCase() + ' L' + o.level + ' ' + o.size + ' @ ' + o.price +
        ' ~$' + Number(o.usd || 0).toFixed(2) + ' ' + (o.status || '') + ' ' + (o.id || '')
      ).join('<br/>');
      return '<tr><td>' + esc(m.symbol) + '</td><td>' + esc(m.mid) + '</td><td>' + m.bids + '/' + m.asks +
        '<div class="ord">bid $' + fmtN(m.bidUsd) + ' / ask $' + fmtN(m.askUsd) + '</div></td>' +
        '<td>' + fmtN(m.bidUsd) + '</td><td>' + fmtN(m.askUsd) +
        '</td><td>' + fmtN(m.buyUsd) + '</td><td>' + fmtN(m.sellUsd) +
        '</td><td>' + esc(m.vol) + '</td><td>' + esc(m.fee) + '</td><td>' + esc(m.w) + '</td></tr>' +
        '<tr class="orders"><td></td><td colspan="9">' + (ords || 'no open orders') + '</td></tr>';
    }).join('');
    const age = b.ts ? Math.round((Date.now() - b.ts) / 1000) + 's ago' : '';
    return '<section class="card"><h2>' + esc(b.bot) + ' <small>' + esc(b.exchange || '') + ' ' +
      esc(b.quote || '') + '</small> <span class="age">' + age + '</span></h2><div class="kpi">' +
      '<div><label>Wallet</label><b>' + fmt(p.walletGain) + '</b><span>' + fmtN(p.lastEquity) + '</span></div>' +
      '<div><label>PRICE</label><b>' + fmt(p.pricePnl) + '</b></div>' +
      '<div><label>MAKER</label><b>' + fmt(p.makerPnl) + '</b></div>' +
      '<div><label>FEES</label><b>' + fmt(p.fees != null ? -p.fees : null) + '</b></div>' +
      '<div><label>TAKER</label><b>' + fmt(p.takerFees != null ? -p.takerFees : null) + '</b></div>' +
      '<div><label>GAP</label><b>' + fmt(p.otherPnl) + '</b></div>' +
      '<div><label>BANK</label><b>' + fmt(b.banked) + '</b></div>' +
      '<div><label>Bids</label><b>' + fmtN(w.bids) + '</b></div>' +
      '<div><label>Asks</label><b>' + fmtN(w.asks) + '</b></div>' +
      '<div><label>Inventory</label><b>' + fmtN(w.inventory) + '</b></div>' +
      '<div><label>Cash</label><b>' + fmtN(w.cash) + '</b></div>' +
      '<div><label>Vol buy</label><b>' + fmtN(sumMarkets(b, 'buyUsd')) + '</b></div>' +
      '<div><label>Vol sell</label><b>' + fmtN(sumMarkets(b, 'sellUsd')) + '</b></div></div>' +
      apiHtml(b) +
      '<table><thead><tr><th>Mkt</th><th>mid</th><th>bid/ask</th><th>bid$</th><th>ask$</th><th>buy vol</th><th>sell vol</th><th>vol</th><th>fee</th><th>w</th></tr></thead><tbody>' +
      (mk || '<tr><td colspan="10">no markets</td></tr>') + '</tbody></table></section>';
  }).join('');
  return '<!doctype html><html><head><meta charset="utf-8"/><meta http-equiv="refresh" content="5"/>' +
    '<title>crypto-mm status</title><style>:root{color-scheme:dark}body{font-family:ui-sans-serif,system-ui,sans-serif;background:#0e1116;color:#e7ecf3;margin:24px}h1{font-size:20px;font-weight:600}h2{font-size:16px;margin:0 0 12px}h2 small,.age{color:#8b98a5;font-weight:400;margin-left:8px}.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:16px 18px;margin:16px 0}.kpi{display:flex;flex-wrap:wrap;gap:16px;margin-bottom:12px}.kpi div{min-width:90px}.kpi label{display:block;font-size:11px;color:#8b98a5;text-transform:uppercase}.kpi b{font-size:16px}.kpi span{display:block;font-size:12px;color:#8b98a5}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #30363d}th{color:#8b98a5;font-weight:500}.ord,tr.orders td{color:#8b98a5;font-size:12px;font-family:ui-monospace,monospace}.api{font-size:12px;color:#8b98a5;margin:8px 0}.api ul{margin:4px 0 0 16px;font-family:ui-monospace,monospace}</style></head><body><h1>crypto-mm status</h1><p class="age">' +
    (rows.length ? rows.length + ' bot(s)' : 'waiting for bot POSTs to /status') +
    ' · auto-refresh 5s</p>' +
    (cards || '<p>No reports yet. Start ladder/comp with STATUS_URL=http://127.0.0.1:' + PORT + '</p>') +
    '</body></html>';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/status.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlPage());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ bots: collect() }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/status') {
    if (!auth(req)) { res.writeHead(401); res.end('unauthorized'); return; }
    let body = '';
    for await (const c of req) body += c;
    try {
      const msg = JSON.parse(body || '{}');
      bots.set(String(msg.bot || 'unknown'), { ...msg, ts: Date.now() });
      res.writeHead(204); res.end();
    } catch { res.writeHead(400); res.end('bad json'); }
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => console.log('status UI http://127.0.0.1:' + PORT + '/'));
