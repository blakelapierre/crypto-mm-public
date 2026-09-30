import fs from 'fs';
import path from 'path';
import { loadNet, forward } from './mlp.js';

let net = null;
let loaded = false;

function weightsPath() {
  return path.resolve(process.cwd(), process.env.NN_WEIGHTS || 'models/ladder-nn.json');
}

export function loadNn() {
  if (loaded) return net;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(weightsPath(), 'utf8'));
    net = loadNet(raw.net);
    if (net) console.log('nn weights', weightsPath(), 'examples=' + (raw.examples || '?'));
  } catch {
    net = null;
  }
  return net;
}

/** Map quote context to [0.4, 1.8] size multiplier. Disabled if NN_ENABLED=0 or no weights. */
export function nnSizeMult({ buy = 0.5, level = 1, offMid = 0, sizeUsd = 5, feeBps = 35, invSign = 0 } = {}) {
  if (['0', 'false', 'off'].includes(String(process.env.NN_ENABLED || '1').toLowerCase())) return 1;
  const n = loadNn();
  if (!n) return 1;
  const x = [
    buy,
    Math.min(4, Number(level) || 1) / 4,
    Math.max(-0.05, Math.min(0.05, Number(offMid) || 0)) / 0.05,
    Math.max(0, Math.min(1, Number(sizeUsd) / 20)),
    Math.max(0, Math.min(1, Number(feeBps) / 80)),
    invSign >= 0 ? 1 : -1,
  ];
  const y = forward(n, x)[0];
  return Math.max(0.4, Math.min(1.8, 1 + y * 0.6));
}
