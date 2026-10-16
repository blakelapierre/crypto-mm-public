import {
  cashTransferJump, drawdownPct, lossHalts, displayCapital, openPending, settleTransfer,
  controlResume, statusMoney, clearPendingState,
} from '../src/bots/as/quote.js';

let failed = 0;
function check(cond, msg) {
  if (cond) { console.log('ok ' + msg); return; }
  failed += 1;
  console.error('FAIL ' + msg);
}

const oct16 = {
  prevQuoteCash: 20,
  startEquity: 24.90,
  originEquity: 24.90,
  lifetimeTransfers: 0,
  capitalBaseline: 24.90,
  equityMarks: [{ t: 1, eq: 25.7 }, { t: 2, eq: 25.72 }],
  haltEquity: 25.7,
  resetBaselines: [24.90],
  pendingShift: 0,
  halted: null,
};
const trading = 0.89;
const life0 = trading / displayCapital(oct16) * 100;
const jump = cashTransferJump({ prevCash: 20, nextCash: 9.99, fillDelta: 0, feeDelta: 0, orderHoldDelta: 0 });
check(Math.abs(jump + 10.01) < 1e-9, 'the Oct 16 cash drop is -10.01');
check(cashTransferJump({ prevCash: 20, nextCash: 9.99, fillDelta: 1 }) === 0, 'a fill explains a cash drop');
check(cashTransferJump({ prevCash: 20, nextCash: 19.6 }) === 0, 'a move under a dollar is not a transfer');
check(cashTransferJump({ prevCash: 20, nextCash: 15, orderHoldDelta: 5 }) === 0, 'an order hold is not a withdrawal');

const opened = openPending(oct16, jump, 'jump', 16);
check(opened.opened && opened.state.skipHalt === true, 'a cash jump is pending before any halt check');
check(Math.abs(opened.state.transferPending.usd + 10.01) < 1e-9, 'pending=-10.01');
check(Math.abs(trading / displayCapital(opened.state) * 100 - life0) < 1e-6, 'life % is unchanged while the withdrawal is pending');
check(Math.abs(opened.state.equityMarks[0].eq - (25.7 - 10.01)) < 1e-9, 'equity marks shift with the pending withdrawal');
check(Math.abs(opened.state.startEquity - (24.90 - 10.01)) < 1e-9, 'session baseline shifts');
check(Math.abs(opened.state.resetBaselines[0] - (24.90 - 10.01)) < 1e-9, 'reset baselines shift');
const quiet = lossHalts({
  sessionTrading: trading, dayTrading: trading, lifeTrading: trading,
  sessionCapital: displayCapital(opened.state), dayCapital: displayCapital(opened.state), lifeCapital: displayCapital(opened.state),
  resid: -8.03, pending: -10.01, sessionLoss: 0.08, dayLoss: 0.12, lifetimeDd: 0.25,
});
check(!quiet.sessionHalt && !quiet.dayHalt && !quiet.lifetimeHalt, 'no halt of any kind on the Oct 16 drop');

const session = lossHalts({
  sessionTrading: -3, dayTrading: -1, lifeTrading: -1,
  sessionCapital: 25, dayCapital: 25, lifeCapital: 25,
  resid: -10, pending: -10, sessionLoss: 0.08, dayLoss: 0.12, lifetimeDd: 0.25,
});
check(session.sessionHalt && !session.dayHalt && !session.lifetimeHalt, 'session drawdown ignores resid and pending');
const day = lossHalts({
  sessionTrading: -1, dayTrading: -4, lifeTrading: -1,
  sessionCapital: 25, dayCapital: 25, lifeCapital: 25,
  resid: 8, pending: 8, sessionLoss: 0.08, dayLoss: 0.12, lifetimeDd: 0.25,
});
check(!day.sessionHalt && day.dayHalt && !day.lifetimeHalt, 'day drawdown ignores resid and pending');
const life = lossHalts({
  sessionTrading: -1, dayTrading: -1, lifeTrading: -8,
  sessionCapital: 25, dayCapital: 25, lifeCapital: 25,
  resid: -10, pending: -10, sessionLoss: 0.08, dayLoss: 0.12, lifetimeDd: 0.25,
});
check(!life.sessionHalt && !life.dayHalt && life.lifetimeHalt, 'lifetime drawdown ignores resid and pending');
check(drawdownPct({ trading: -2, capital: 20 }) === 0.1, 'drawdown is trading loss over capital');
check(drawdownPct({ trading: 1, capital: 20 }) === 0, 'a gain is not a drawdown');

const booked = settleTransfer(opened.state, { id: 'wd-1', usd: -10.01, source: 'v2' });
check(booked.booked && !booked.state.transferPending, 'a venue record replaces the pending withdrawal');
check(Math.abs(displayCapital(booked.state) - (24.90 - 10.01)) < 1e-6, 'capital moves by -10.01 when the record arrives');
check(Math.abs(booked.state.equityMarks[0].eq - (25.7 - 10.01)) < 1e-6, 'marks are not shifted a second time');

const resumed = controlResume({ halted: 'lifetime-dd', haltSwept: true, haltSince: 5, haltAt: 5 });
check(resumed.prev === 'lifetime-dd' && resumed.state.halted == null && resumed.state.haltSwept === false, 'resume clears lifetime-dd without a restart');
const dayCleared = controlResume({ halted: 'day-loss', haltSwept: true });
check(dayCleared.prev === 'day-loss' && dayCleared.state.halted == null && dayCleared.state.haltSwept === false, 'resume clears day-loss');

const dropped = clearPendingState(opened.state, opened.id);
check(dropped.result === 'cleared' && !dropped.state.transferPending, 'clear-pending drops the entry');
check(Math.abs(displayCapital(dropped.state) - 24.90) < 1e-6, 'clearing a pending withdrawal restores capital');
check(Math.abs(dropped.state.equityMarks[0].eq - 25.7) < 1e-6, 'clearing a pending withdrawal restores marks');

const line = statusMoney({ equity: 15.78, capital: 24.90, trading: 0.89, resid: 1.98, pending: -10.01 });
check(line.includes('eq=$15.78') && line.includes('capital=$24.90') && line.includes('trading=$0.89') && line.includes('resid=$1.98') && line.includes('pending=$-10.01'), 'status shows eq, capital, trading, resid, and pending separately');
check(line.includes('+3.6%'), 'the life percent is trading over capital');

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('as v12 checks passed');
