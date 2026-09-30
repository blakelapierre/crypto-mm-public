/** Tiny 2-layer MLP, no deps. */

export function zeros(n) { return new Float64Array(n); }

export function initNet(inN, hid = 12, outN = 1, scale = 0.2) {
  const W1 = zeros(hid * inN);
  const b1 = zeros(hid);
  const W2 = zeros(outN * hid);
  const b2 = zeros(outN);
  for (let i = 0; i < W1.length; i++) W1[i] = (Math.random() * 2 - 1) * scale;
  for (let i = 0; i < W2.length; i++) W2[i] = (Math.random() * 2 - 1) * scale;
  return { inN, hid, outN, W1, b1, W2, b2 };
}

function relu(x) { return x > 0 ? x : 0; }

export function forward(net, x, cache = null) {
  const { inN, hid, outN, W1, b1, W2, b2 } = net;
  const h = new Float64Array(hid);
  for (let j = 0; j < hid; j++) {
    let s = b1[j];
    for (let i = 0; i < inN; i++) s += W1[j * inN + i] * x[i];
    h[j] = relu(s);
  }
  const y = new Float64Array(outN);
  for (let k = 0; k < outN; k++) {
    let s = b2[k];
    for (let j = 0; j < hid; j++) s += W2[k * hid + j] * h[j];
    y[k] = Math.tanh(s);
  }
  if (cache) { cache.h = h; cache.x = x; }
  return y;
}

export function trainStep(net, x, target, lr = 0.01) {
  const cache = {};
  const y = forward(net, x, cache);
  const { inN, hid, outN, W1, b1, W2, b2 } = net;
  const h = cache.h;
  const dy = new Float64Array(outN);
  let loss = 0;
  for (let k = 0; k < outN; k++) {
    const err = y[k] - target[k];
    loss += err * err;
    dy[k] = err * (1 - y[k] * y[k]);
  }
  const dh = new Float64Array(hid);
  for (let k = 0; k < outN; k++) {
    for (let j = 0; j < hid; j++) {
      dh[j] += dy[k] * W2[k * hid + j];
      W2[k * hid + j] -= lr * dy[k] * h[j];
    }
    b2[k] -= lr * dy[k];
  }
  for (let j = 0; j < hid; j++) {
    if (h[j] <= 0) continue;
    for (let i = 0; i < inN; i++) W1[j * inN + i] -= lr * dh[j] * x[i];
    b1[j] -= lr * dh[j];
  }
  return loss;
}

export function serialize(net) {
  return {
    inN: net.inN, hid: net.hid, outN: net.outN,
    W1: Array.from(net.W1), b1: Array.from(net.b1),
    W2: Array.from(net.W2), b2: Array.from(net.b2),
  };
}

export function loadNet(obj) {
  if (!obj || !obj.W1) return null;
  return {
    inN: obj.inN, hid: obj.hid, outN: obj.outN,
    W1: Float64Array.from(obj.W1),
    b1: Float64Array.from(obj.b1),
    W2: Float64Array.from(obj.W2),
    b2: Float64Array.from(obj.b2),
  };
}
