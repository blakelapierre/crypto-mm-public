import fs from 'fs';
import path from 'path';
import { buildQuoteExamples, Q_FEATURES } from './quote-data.js';
import { initNet, trainStep, serialize, forward } from './mlp.js';

const EPOCHS = Number(process.env.NN_EPOCHS || 10);
const LR = Number(process.env.NN_LR || 0.015);
const HID = Number(process.env.NN_HID || 16);
const OUT = path.resolve(process.cwd(), process.env.NN_QUOTE_WEIGHTS || 'models/ladder-quote-nn.json');

const { xs, ys } = buildQuoteExamples();
console.log('quote examples', xs.length, 'features', Q_FEATURES.join(','));
if (xs.length < 15) {
  console.error('not enough fills (need px log + fills). run the bot to collect px-*.jsonl then retry');
  process.exit(1);
}

const net = initNet(xs[0].length, HID, 3);
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

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  trainedAt: new Date().toISOString(),
  examples: xs.length,
  mse: last,
  features: Q_FEATURES,
  net: serialize(net),
}, null, 2));
console.log('wrote', OUT);
console.log('probe', forward(net, xs[0]));
