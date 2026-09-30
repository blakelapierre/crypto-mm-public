import fs from 'fs';
import path from 'path';
import { buildExamples, FEATURES } from './dataset.js';
import { initNet, trainStep, serialize, forward } from './mlp.js';

const EPOCHS = Number(process.env.NN_EPOCHS || 8);
const LR = Number(process.env.NN_LR || 0.02);
const HID = Number(process.env.NN_HID || 12);
const OUT = path.resolve(process.cwd(), process.env.NN_WEIGHTS || 'models/ladder-nn.json');

const { xs, ys } = buildExamples();
console.log('examples', xs.length, 'features', FEATURES.join(','));
if (xs.length < 20) {
  console.error('not enough fills to train');
  process.exit(1);
}

const net = initNet(xs[0].length, HID, 1);
let last = 0;
for (let e = 0; e < EPOCHS; e++) {
  let loss = 0;
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
    [ys[i], ys[j]] = [ys[j], ys[i]];
  }
  for (let i = 0; i < xs.length; i++) loss += trainStep(net, xs[i], ys[i], LR);
  last = loss / xs.length;
  console.log('epoch', e + 1, 'mse', last.toFixed(5));
}

let hit = 0;
for (let i = 0; i < xs.length; i++) {
  const y = forward(net, xs[i])[0];
  if ((y >= 0 && ys[i][0] >= 0) || (y < 0 && ys[i][0] < 0)) hit++;
}
console.log('sign-agree', (hit / xs.length * 100).toFixed(1) + '%');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  trainedAt: new Date().toISOString(),
  examples: xs.length,
  mse: last,
  features: FEATURES,
  net: serialize(net),
}, null, 2));
console.log('wrote', OUT);
