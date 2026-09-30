import fs from 'fs';
import path from 'path';
import { loadNet, forward } from './mlp.js';
import { midReturn, midRangePct } from '../shared/mid-ring.js';

let net = null;
let loaded = false;

function weightsPath() {
  return path.resolve(process.cwd(), process.env.NN_QUOTE_WEIGHTS || 'models/ladder-quote-nn.json');
}

export function loadQuoteNn() {
  if (loaded) return net;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(weightsPath(), 'utf8'));
    net = loadNet(raw.net);
    if (net) console.log('quote-nn', weightsPath(), 'n=' + (raw.examples || '?'));
  } catch { net = null; }
  return net;
}

export function nnQuote({ symbol, buy = 0.5, level = 1, offMid = 0, sizeUsd = 5 } = {}) {
  if (['0', 'false', 'off'].includes(String(process.env.NN_QUOTE || '1').toLowerCase())) {
    return { sizeMult: 1, bidAddBps: 0, askAddBps: 0 };
  }
  const n = loadQuoteNn();
  if (!n) return { sizeMult: 1, bidAddBps: 0, askAddBps: 0 };
  const ret15 = midReturn(symbol, 15000);
  const ret60 = midReturn(symbol, 60000);
  const range60 = midRangePct(symbol, 60000) / 100;
  const x = [
    buy,
    Math.min(4, Number(level) || 1) / 4,
    Math.max(-0.05, Math.min(0.05, Number(offMid) || 0)) / 0.05,
    Math.max(0, Math.min(1, Number(sizeUsd) / 20)),
    Math.max(-1, Math.min(1, ret15 * 50)),
    Math.max(-1, Math.min(1, ret60 * 20)),
    Math.max(0, Math.min(1, range60 * 20)),
  ];
  const y = forward(n, x);
  return {
    sizeMult: Math.max(0.5, Math.min(1.8, 1 + y[0] * 0.5)),
    bidAddBps: y[1] * 12,
    askAddBps: y[2] * 12,
  };
}
