import { execFileSync } from 'child_process';
import { appendFileSync, mkdirSync } from 'fs';

const lines = [new Date().toISOString()];
try {
  const j = await (await fetch('http://127.0.0.1:8787/api/status')).json();
  const b = (j.bots || []).find((x) => x.bot === 'ladder') || {};
  const p = b.pnl || {};
  const mk = (b.markets || []).filter((m) => (m.bids || 0) + (m.asks || 0) > 0);
  const money = (n) => (Number(n) || 0).toFixed(2);
  lines.push(`ladder equity $${money(p.lastEquity)} start $${money(p.startEquity)} wallet ${money(p.walletGain)} netMaker ${money(p.netMaker)} fees ${money(p.fees)}`);
  lines.push('quoting ' + (mk.map((m) => `${m.symbol} ${m.bids}b/${m.asks}a`).join(', ') || '-'));
  lines.push('running ' + Object.entries(j.running || {}).map(([k, v]) => `${k}=${v ? 'on' : 'off'}`).join(' '));
} catch (e) {
  lines.push('ladder status ' + (e.message || e));
}
try {
  const log = execFileSync('journalctl', ['-u', 'crypto-mm-margin.service', '-n', '40', '--no-pager', '-o', 'cat'], { encoding: 'utf8' });
  const book = log.split('\n').map((l) => l.trim()).filter((l) => l.includes('BOOK equity')).pop();
  lines.push(book || 'margin book unknown');
} catch (e) {
  lines.push('margin log ' + (e.message || e));
}
const text = lines.join('\n') + '\n';
const logPath = new URL('../logs/status-hour.log', import.meta.url);
mkdirSync(new URL('../logs/', import.meta.url), { recursive: true });
appendFileSync(logPath, text);
console.log(text.trim());
