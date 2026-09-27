import fs from 'fs';
import path from 'path';

function filePath() {
  const raw = process.env.MM_SET_FILE;
  if (raw === 'off' || raw === '0' || raw === 'false') return null;
  return path.resolve(process.cwd(), raw && raw.trim() ? raw.trim() : 'logs/mm-set.json');
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

export function saveMmSet(alloc) {
  const dest = filePath();
  if (!dest || !alloc || !alloc.length) return;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const symbols = [...new Set(alloc.map((a) => String(a.symbol || '').toUpperCase()).filter(Boolean))];
    const pairs = alloc.map((a) => a.pair).filter(Boolean);
    fs.writeFileSync(dest, JSON.stringify({ ts: new Date().toISOString(), symbols, pairs }, null, 2));
  } catch (e) {
    console.warn('mm-set save', e.message);
  }
}
