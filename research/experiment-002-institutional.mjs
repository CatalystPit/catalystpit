// EXPERIMENT 002 — the INSTITUTIONAL portions, rerun on the completed 13F history.
//
// Same frozen specification (research/experiment-002-spec.md), same dataset builder
// (research/dataset-002.mjs). NOTHING here redefines a horizon, a cohort, a threshold, a
// point-in-time rule or a baseline. The only difference from the first run is that the 13F history
// behind it is deeper — which is precisely the question: does COMPLETE institutional history change
// the conclusion?
//
// ⚠️ RESEARCH ONLY. Reads the database, writes nothing, consumed by no production path.
//   node --env-file=.env.local research/experiment-002-institutional.mjs

import { buildDataset, MIN_N, MIN_FILERS, H } from './dataset-002.mjs';
import { describe, tStatistic, overlapFactorFor, bonferroniThreshold, walkForwardSplits, inRange } from './validation.mjs';

const pctS = (v) => (v == null ? '   —  ' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const pad = (s, n) => String(s).padEnd(n);
const OVERLAP = overlapFactorFor(H, 1);
let hypotheses = 0;

console.log('EXPERIMENT 002 — INSTITUTIONAL RERUN on completed history');
console.log('frozen spec: research/experiment-002-spec.md · nothing redefined\n');

const { rows, qStats, validPairs, explore, holdout } = await buildDataset({ log: console.log });
console.log(`exploratory ${explore.length} · protected holdout ${holdout.length}\n`);

/** One configuration, with the path and the uncertainty the spec asks for. */
function row(label, set, { indent = 2 } = {}) {
  hypotheses += 1;
  const pre = ' '.repeat(indent);
  if (set.length < MIN_N) { console.log(`${pre}${pad(label, 42)} n=${pad(set.length, 5)} UNDERPOWERED (min ${MIN_N})`); return null; }
  const coh = describe(set.map((r) => r.relCohort));
  const sec = describe(set.map((r) => r.relSec));
  const spy = describe(set.map((r) => r.relSpy));
  const abs = describe(set.map((r) => r.ret));
  const mfe = describe(set.map((r) => r.mfe));
  const mae = describe(set.map((r) => r.mae));
  const t = tStatistic(set.map((r) => r.relCohort), { overlapFactor: OVERLAP });
  console.log(`${pre}${pad(label, 42)} n=${pad(set.length, 5)} coh ${pctS(coh.median)}  sec ${pctS(sec.median)}  ` +
    `spy ${pctS(spy.median)}  abs ${pctS(abs.median)}  hit ${(coh.hitRate * 100).toFixed(0)}%`);
  console.log(`${pre}${' '.repeat(42)}   MFE ${pctS(mfe.median)}  MAE ${pctS(mae.median)}  ` +
    `coh p25 ${pctS(coh.p25)}  p10 ${pctS(coh.p10)}  t=${t ? t.t.toFixed(2) : '—'}  effN≈${t ? Math.round(t.effectiveN) : '—'}`);
  return { label, n: set.length, coh, t };
}

console.log('  (coh = cohort-relative, the size×sector control · sec = sector ETF · spy = SPY)\n');

console.log('=== INSTITUTIONAL COVERAGE ===');
const withInst = explore.filter((r) => r.inst != null);
console.log(`  observations with a VALID 13F filed before them: ${withInst.length} of ${explore.length}` +
  ` (${((100 * withInst.length) / Math.max(1, explore.length)).toFixed(1)}%)`);
const dirCount = {};
for (const r of explore) dirCount[r.instDir ?? 'none'] = (dirCount[r.instDir ?? 'none'] || 0) + 1;
console.log(`  direction mix: ${JSON.stringify(dirCount)}\n`);

console.log('=== 16/17. INSTITUTIONAL DIRECTION ALONE ===');
row('institutions ACCUMULATING', withInst.filter((r) => r.instDir === 'accumulation'));
row('institutions MIXED', withInst.filter((r) => r.instDir === 'mixed'));
row('institutions DISTRIBUTING', withInst.filter((r) => r.instDir === 'distribution'));
row('institutions sparse (<5 funds moving)', withInst.filter((r) => r.instDir === 'sparse'));

console.log('\n=== BREADTH, not raw fund counts ===');
const breadth = (r) => {
  const tot = r.inst.inc + r.inst.init + r.inst.dec + r.inst.exited;
  return tot ? ((r.inst.inc + r.inst.init) - (r.inst.dec + r.inst.exited)) / tot : null;
};
const deep = withInst.filter((r) => r.inst.holders >= 50);
console.log(`  restricted to names held by >=50 funds (removes fund-count bias): ${deep.length}`);
row('breadth > +0.2 (strong accumulation)', deep.filter((r) => breadth(r) > 0.2), { indent: 4 });
row('breadth +0.05 to +0.2', deep.filter((r) => breadth(r) > 0.05 && breadth(r) <= 0.2), { indent: 4 });
row('breadth -0.05 to +0.05 (flat)', deep.filter((r) => Math.abs(breadth(r)) <= 0.05), { indent: 4 });
row('breadth -0.2 to -0.05', deep.filter((r) => breadth(r) < -0.05 && breadth(r) >= -0.2), { indent: 4 });
row('breadth < -0.2 (strong distribution)', deep.filter((r) => breadth(r) < -0.2), { indent: 4 });
console.log('  new positions vs exits:');
row('more initiations than exits', deep.filter((r) => r.inst.init > r.inst.exited), { indent: 4 });
row('more exits than initiations', deep.filter((r) => r.inst.exited > r.inst.init), { indent: 4 });

console.log('\n=== 18/19. THE AGREEMENT / CONTRADICTION MATRIX ===');
console.log('  (configurations, NOT labelled bullish or bearish in advance)');
for (const ins of ['buy_only', 'sell_only', 'both']) {
  for (const inst of ['accumulation', 'mixed', 'distribution']) {
    row(`${ins} + ${inst}`, withInst.filter((r) => r.conflict === ins && r.instDir === inst), { indent: 4 });
  }
}

console.log('\n=== 24. DOES INSTITUTIONAL EVIDENCE ADD ANYTHING TO INSIDER ALONE? ===');
const buysAll = explore.filter((r) => r.conflict === 'buy_only');
const buysInst = buysAll.filter((r) => r.inst != null);
const base = describe(buysInst.map((r) => r.relCohort));
console.log(`  baseline — buy_only WITH a 13F available: n=${buysInst.length} coh ${pctS(base.median)} hit ${(base.hitRate * 100).toFixed(0)}%`);
for (const d of ['accumulation', 'mixed', 'distribution']) {
  const s = buysInst.filter((r) => r.instDir === d);
  if (s.length < MIN_N) { console.log(`    + ${pad(d, 14)} n=${pad(s.length, 5)} UNDERPOWERED`); continue; }
  const x = describe(s.map((r) => r.relCohort));
  // THE QUESTION IS THE INCREMENT, not the level: does knowing the institutional direction move the
  // answer beyond what insider buying already told us?
  console.log(`    + ${pad(d, 14)} n=${pad(s.length, 5)} coh ${pctS(x.median)} hit ${(x.hitRate * 100).toFixed(0)}%  ` +
    `increment over baseline ${pctS(x.median - base.median)}`);
}

console.log('\n=== 21. MOMENTUM CONTROL, applied to the institutional cells ===');
const withMom = withInst.filter((r) => r.mom63 != null);
const ms = [...withMom].sort((a, b) => a.mom63 - b.mom63);
const m1 = ms[Math.floor(ms.length / 3)]?.mom63, m2 = ms[Math.floor((2 * ms.length) / 3)]?.mom63;
const tier = (r) => (r.mom63 == null ? null : r.mom63 <= m1 ? 'low' : r.mom63 <= m2 ? 'mid' : 'high');
console.log(`  prior-63-session terciles: <=${m1?.toFixed(1)}% / <=${m2?.toFixed(1)}% / above`);
for (const t of ['low', 'mid', 'high']) {
  console.log(`  momentum ${t}:`);
  row('accumulation', withMom.filter((r) => tier(r) === t && r.instDir === 'accumulation'), { indent: 4 });
  row('distribution', withMom.filter((r) => tier(r) === t && r.instDir === 'distribution'), { indent: 4 });
}

console.log('\n=== 22. WALK-FORWARD (exploratory only) ===');
const days = explore.map((r) => r.asOfMs).sort((a, b) => a - b);
const splits = walkForwardSplits({ startMs: days[0], endMs: days[days.length - 1], trainDays: 150, validateDays: 60, stepDays: 60, embargoDays: 92 });
console.log(`  folds: ${splits.length}`);
for (const s of splits) {
  const va = inRange(explore, s.validate).filter((r) => r.inst != null);
  for (const d of ['accumulation', 'distribution']) {
    const x = describe(va.filter((r) => r.instDir === d).map((r) => r.relCohort));
    console.log(`  fold ${s.index}  ${pad(d, 14)} out-of-sample n=${pad(x.n, 5)} coh ${pctS(x.median)} ` +
      `hit ${x.hitRate == null ? '—' : (x.hitRate * 100).toFixed(0) + '%'}`);
  }
}

console.log('\n=== 25. PROTECTED HOLDOUT (read once) ===');
const hInst = holdout.filter((r) => r.inst != null);
row('accumulation', hInst.filter((r) => r.instDir === 'accumulation'));
row('distribution', hInst.filter((r) => r.instDir === 'distribution'));
row('buy_only + accumulation', hInst.filter((r) => r.conflict === 'buy_only' && r.instDir === 'accumulation'));
row('buy_only + distribution', hInst.filter((r) => r.conflict === 'buy_only' && r.instDir === 'distribution'));

console.log('\n=== 23. MULTIPLE TESTING ===');
const bt = bonferroniThreshold(hypotheses, 0.05);
console.log(`  hypotheses tried here: ${bt.hypothesesTried} → adjusted alpha ${bt.adjustedAlpha.toExponential(2)}`);
console.log(`  overlap factor on every t: ${OVERLAP.toFixed(0)}×  ·  quarter threshold MIN_FILERS=${MIN_FILERS} (frozen)`);
console.log(`  valid QoQ pairs used: ${validPairs.length} — ${validPairs.map((p) => `${p.prev}→${p.cur}`).join(', ')}`);
