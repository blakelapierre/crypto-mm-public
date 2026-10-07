import fs from 'fs';
import path from 'path';

function botName() {
  return String(process.env.BOT || 'ladder').toLowerCase().replace(/[^a-z0-9_-]+/g, '') || 'ladder';
}

function filePath() {
  const raw = process.env.MM_SET_FILE;
  if (raw === 'off' || raw === '0' || raw === 'false') return null;
  if (raw && raw.trim()) return path.resolve(process.cwd(), raw.trim());
  return path.resolve(process.cwd(), 'logs/mm-set-' + botName() + '.json');
}

export function loadMmSet() {
  const dest = filePath();
  if (!dest || !fs.existsSync(dest)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(dest, 'utf8'));
    const list = Array.isArray(j.symbols) ? j.symbols : [];
    const symbols = list.map((s) => String(s).toUpperCase()).filter(Boolean);
    if (symbols.length) console.log('restored MM set: ' + symbols.join(','));
    return symbols;
  } catch (e) {
    console.warn('mm-set load', e.message);
    return [];
  }
}

export function saveMmSet(alloc, setState) {
  if (botName() === 'comp') return;
  const dest = filePath();
  if (!dest || !alloc || !alloc.length) return;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const symbols = [...new Set(alloc.map((a) => String(a.symbol || '').toUpperCase()).filter(Boolean))];
    const pairs = alloc.map((a) => a.pair).filter(Boolean);
    const body = { ts: new Date().toISOString(), symbols, pairs };
    if (setState && setState.version) {
      body.version = setState.version;
      body.updatedAt = setState.updatedAt;
      body.set = setState.pairs || [];
    }
    fs.writeFileSync(dest, JSON.stringify(body, null, 2));
  } catch (e) {
    console.warn('mm-set save', e.message);
  }
}
