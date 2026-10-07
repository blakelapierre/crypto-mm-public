import { createPnl } from '../src/shared/pnl.js';

let failed = 0;
function check(cond, msg) {
  if (cond) { console.log('ok ' + msg); return; }
  failed += 1;
  console.error('FAIL ' + msg);
}
function snapLive(cash, equity, positions) {
  return { freeQuote: cash, quoteHold: 0, totalEquity: equity, positionsValue: equity - cash, positions: positions || {} };
}
function usd(pnl) {
  return (pnl.snapshot().transfers || []).reduce((s, t) => s + t.usd, 0);
}

{
  const pnl = createPnl();
  pnl.markHoldings(snapLive(20, 20));
  const u0 = pnl.snapshot().unattributed;
  pnl.markHoldings(snapLive(30, 30));
  const s = pnl.snapshot();
  check(s.transfers.length === 1 && Math.abs(s.transfers[0].usd - 10) < 1e-6, 'a +10 one transfer');
  check(s.unattributed === u0, 'a unattributed unchanged');
  check(pnl.noteTransfer(10, 'deposit', 'venue-a') === false, 'd venue same amount not double counted');
  check(pnl.snapshot().transfers.length === 1, 'd still one transfer');
}

{
  const pnl = createPnl();
  pnl.markHoldings(snapLive(20, 20));
  const u0 = pnl.snapshot().unattributed;
  pnl.recordFill({ symbol: 'AAA', side: 'buy', size: 1, price: 2, fee: 0 });
  pnl.recordFill({ symbol: 'BBB', side: 'buy', size: 1, price: 4, fee: 0 });
  pnl.markHoldings(snapLive(24, 30, {
    AAA: { amount: 1, hold: 0, mid: 2 },
    BBB: { amount: 1, hold: 0, mid: 4 },
  }));
  const s = pnl.snapshot();
  check(s.transfers.length === 1 && Math.abs(s.transfers[0].usd - 10) < 1e-6, 'b +10 during two fills');
  check(s.unattributed === u0, 'b unattributed unchanged');
}

{
  const pnl = createPnl();
  pnl.markHoldings(snapLive(20, 20));
  pnl.markHoldings(snapLive(15, 15));
  const s = pnl.snapshot();
  check(s.transfers.length === 1 && Math.abs(s.transfers[0].usd + 5) < 1e-6, 'c withdrawal -5');
}

{
  const pnl = createPnl();
  pnl.markHoldings(snapLive(20, 20));
  pnl.recordFill({ symbol: 'AAA', side: 'buy', size: 2, price: 3, fee: 0 });
  pnl.markHoldings(snapLive(14, 20, { AAA: { amount: 2, hold: 0, mid: 3 } }));
  check(pnl.snapshot().transfers.length === 0, 'e fill-only cash move is not a transfer');
}

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('pnl transfer tests passed');
