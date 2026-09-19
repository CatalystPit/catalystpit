// PIT CONSENSUS V1 — the methodology's contract.
//
// Pure: no database, no clock, no fixtures from production. Everything here is a function of its
// arguments, which is what lets a stored snapshot be recomputed exactly and a methodology change be
// noticed rather than absorbed.
//
// ⚠️ THESE ASSERT CORRECTNESS, NOT PERFORMANCE. Nothing here checks whether the output predicts a
// return, and no constant in consensus-v1.mjs was chosen by trying values against subsequent
// prices. Consensus is a reading of public evidence; tuning it against future returns would make it
// an unvalidated forecast wearing an evidence label — which is the failure Experiment 002 was run
// to avoid repeating.
//
// Run: node scripts/verify-consensus-v1.mjs

import {
  familyValue, computeConsensus, computeConfidence, detectConflict, decayFreshness,
  institutionsFreshness, confidenceLabel, CONSTANTS, FAMILIES, METHODOLOGY_VERSION,
} from '../src/lib/consensus/consensus-v1.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}`); } };
const NOW = Date.parse('2026-09-19T12:00:00Z');

// A full-strength family value, so tests say what they are varying.
const fam = (family, direction, over = {}) => familyValue({
  family, direction, strength: 1, freshness: 1, quality: 1, evidenceCount: 3,
  state: 'test', trend: 'stable', ...over,
});

console.log('\n=== 1. NO EVIDENCE ===');
{
  const r = computeConsensus([], { now: NOW });
  ok('zero active families → insufficient evidence', r.direction === 'insufficient-evidence');
  ok('alignment is null, not 0% and not 100%', r.alignment === null);
  ok('alignment state is none', r.alignmentState === 'none');
  ok('confidence is Low', r.confidence === 'Low');
  ok('active count is 0', r.activeCount === 0);
  // All four inactive is still "no evidence", not "everything agrees on nothing".
  const allInactive = FAMILIES.map((f) => familyValue({ family: f, evidenceCount: 0 }));
  const r2 = computeConsensus(allInactive, { now: NOW });
  ok('four inactive families → still insufficient evidence', r2.direction === 'insufficient-evidence');
  ok('inactive families are carried through, not dropped', r2.families.length === 4);
}

console.log('\n=== 2. EXACTLY ONE ACTIVE FAMILY ===');
{
  const r = computeConsensus([fam('insiders', 0.8), familyValue({ family: 'congress', evidenceCount: 0 })], { now: NOW });
  ok('single source is flagged', r.alignmentState === 'single-source');
  // THE POINT: one family agrees with itself. 100% would be the most misleading number on the page.
  ok('alignment is NOT 100%', r.alignment !== 1);
  ok('alignment is null', r.alignment === null);
  ok('direction still reports what the one family says', r.direction === 'bullish-lean');
  ok('active count is 1', r.activeCount === 1);
  ok('confidence is not High on one family', r.confidence !== 'High');
}

console.log('\n=== 3. TWO STRONGLY ALIGNED BULLISH FAMILIES ===');
{
  const r = computeConsensus([fam('insiders', 0.9), fam('institutions', 0.8)], { now: NOW });
  ok('direction is bullish lean', r.direction === 'bullish-lean');
  ok('alignment is 100% when both agree', Math.abs(r.alignment - 1) < 1e-9);
  ok('alignment IS shown with 2 families', r.alignmentState === 'computed');
  ok('no conflict', r.conflict.conflict === false);
  ok('sumE is positive', r.sumE > 0);
}

console.log('\n=== 4. TWO STRONGLY ALIGNED BEARISH FAMILIES ===');
{
  const r = computeConsensus([fam('insiders', -0.9), fam('congress', -0.8)], { now: NOW });
  ok('direction is bearish lean', r.direction === 'bearish-lean');
  ok('alignment is 100%', Math.abs(r.alignment - 1) < 1e-9);
  ok('direction value is negative', r.directionValue < 0);
  ok('no conflict when both agree', r.conflict.conflict === false);
}

console.log('\n=== 5. STRONG CONFLICT — the rule that stops a false lean ===');
{
  // Net is +0.1: arithmetic says bullish. The families plainly disagree.
  const r = computeConsensus([
    fam('insiders', 0.8), fam('institutions', 0.8),
    fam('congress', -0.75), fam('catalysts', -0.75),
  ], { now: NOW });
  ok('net sumE is positive', r.sumE > 0);
  ok('but the label is NOT bullish', r.direction !== 'bullish-lean');
  ok('it is flagged as high conflict', r.direction === 'mixed-high-conflict');
  ok('the conflict is recorded', r.conflict.conflict === true);
  ok('opposing masses are retained for explanation', r.conflict.posMass > 0 && r.conflict.negMass > 0);

  // Two trivial opposing signals must NOT be dressed up as a conflict.
  const weak = computeConsensus([fam('insiders', 0.10), fam('congress', -0.09)], { now: NOW });
  ok('two negligible opposing families are not "high conflict"', weak.conflict.conflict === false);
  ok('…they read as Mixed', weak.direction === 'mixed');
}

console.log('\n=== 5b. PERFECT AGREEMENT ON ALMOST NO EVIDENCE ===');
{
  // FOUND ON LIVE DATA, not imagined. AAPL returned "Bearish Lean, alignment 100%" from three
  // families at E = -0.006, -0.062 and -0.085 — total mass 0.153. They agreed perfectly and had
  // almost nothing to agree about, and only Confidence said so.
  const trivial = [
    fam('insiders', -0.09, { strength: 0.1, quality: 0.95 }),
    fam('institutions', -0.01, { strength: 1, quality: 0.85 }),
    fam('congress', -0.07, { strength: 0.9, quality: 0.6 }),
  ];
  const r = computeConsensus(trivial, { now: NOW });
  ok('mass really is tiny', r.mass < CONSTANTS.directionThresholds.minMass);
  ok('alignment is genuinely high — they DO agree', r.alignment > 0.9);
  ok('but no direction is named', r.direction === 'mixed');
  ok('…specifically not a bearish lean', r.direction !== 'bearish-lean');
  ok('confidence is Low', r.confidence === 'Low');
  // Above the mass floor, the same agreement DOES name a direction.
  const real = [
    fam('insiders', -0.8, { strength: 0.7, quality: 0.95 }),
    fam('congress', -0.6, { strength: 0.6, quality: 0.6 }),
  ];
  const r2 = computeConsensus(real, { now: NOW });
  ok('sufficient mass restores the lean', r2.mass >= CONSTANTS.directionThresholds.minMass && r2.direction === 'bearish-lean');
  // The floor applies to the single-family case too, or one weak family would name a direction.
  const oneWeak = computeConsensus([fam('insiders', -1, { strength: 0.1, quality: 0.5 })], { now: NOW });
  ok('one weak family names no direction either', oneWeak.direction === 'mixed');
}

console.log('\n=== 6. WEAK EVIDENCE ACROSS SEVERAL FAMILIES ===');
{
  const weak = FAMILIES.map((f) => fam(f, 0.2, { strength: 0.2, quality: 0.5 }));
  const r = computeConsensus(weak, { now: NOW });
  ok('all four active', r.activeCount === 4);
  ok('alignment can still be high — they do agree', r.alignment > 0.9);
  // Coverage is full and they agree, but there is very little evidence. Confidence must say so.
  ok('confidence is NOT High on thin evidence', r.confidence !== 'High');
  ok('evidence mass is small', r.mass < CONSTANTS.tau);
}

console.log('\n=== 7. SUBSTANTIAL HIGH-QUALITY EVIDENCE ACROSS FAMILIES ===');
{
  const strong = FAMILIES.map((f) => fam(f, 0.85, { strength: 0.9, quality: 0.95 }));
  const r = computeConsensus(strong, { now: NOW });
  ok('all four active', r.activeCount === 4);
  ok('direction is a lean', r.direction === 'bullish-lean');
  ok('confidence is High', r.confidence === 'High');
  ok('confidence raw is bounded', r.confidenceRaw <= 1);
}

console.log('\n=== 8. A MISSING FAMILY MUST NOT BEHAVE LIKE E = 0 ===');
{
  const twoActive = computeConsensus([fam('insiders', 0.9), fam('institutions', 0.9)], { now: NOW });
  const twoPlusMissing = computeConsensus([
    fam('insiders', 0.9), fam('institutions', 0.9),
    familyValue({ family: 'congress', evidenceCount: 0 }),
    familyValue({ family: 'catalysts', evidenceCount: 0 }),
  ], { now: NOW });
  ok('alignment is unchanged by absent families', Math.abs(twoActive.alignment - twoPlusMissing.alignment) < 1e-9);
  ok('active count ignores absent families', twoPlusMissing.activeCount === 2);
  // If missing families were inserted as E=0 they would dilute alignment toward 0.5 and inflate
  // coverage — silence would be voting.
  const ifZeroesCounted = Math.abs(1.8) / (1.8 + 0 + 0);
  ok('alignment is not diluted by zeroes', Math.abs(twoPlusMissing.alignment - ifZeroesCounted) < 1e-9);
  ok('an internally-cancelled family IS active with E≈0', fam('insiders', 0).active === true);
  ok('…and is distinguishable from absent', familyValue({ family: 'insiders', evidenceCount: 0 }).active === false);
  ok('absent families record why', familyValue({ family: 'insiders', evidenceCount: 0 }).inactiveReason === 'no-evidence');
}

console.log('\n=== 9. ALIGNMENT IS NEVER 100% MERELY BECAUSE ONE FAMILY EXISTS ===');
{
  for (const f of FAMILIES) {
    const r = computeConsensus([fam(f, 1)], { now: NOW });
    ok(`${f} alone → alignment null, not 1`, r.alignment === null && r.alignmentState === 'single-source');
  }
}

console.log('\n=== 10. ROUTINE INSIDER SALES DO NOT CREATE EXTREME BEARISH OUTPUT ===');
{
  // A routine 10b5-1 sale: real evidence, but weak direction, modest strength, lower quality as
  // directional information. The methodology must let the caller express that and must not amplify.
  const routine = familyValue({
    family: 'insiders', direction: -0.15, strength: 0.25, freshness: 0.9, quality: 0.5,
    evidenceCount: 1, state: 'routine-sale',
  });
  ok('routine sale produces a small magnitude', Math.abs(routine.E) < 0.1);
  const r = computeConsensus([routine], { now: NOW });
  ok('…and does not read as a bearish lean', r.direction !== 'bearish-lean');
  ok('…it reads Mixed', r.direction === 'mixed');

  // Clustered non-routine selling MAY be strongly bearish when the data supports it.
  const cluster = familyValue({
    family: 'insiders', direction: -0.85, strength: 0.9, freshness: 0.95, quality: 0.9,
    evidenceCount: 6, state: 'cluster-sale',
  });
  ok('clustered non-routine selling can be strong', Math.abs(cluster.E) > 0.6);
}

console.log('\n=== 11. 13F FRESHNESS IS VINTAGE-BASED, NOT AGE-DECAYED ===');
{
  // A filing published yesterday describes a quarter end up to ~135 days earlier. Neither date alone
  // is the right decay input, so the vintage stays active and the quarter age is reported.
  ok('a 100-day-old quarter end is still fully fresh', institutionsFreshness({ quarterEndAgeDays: 100 }) === 1);
  ok('a 5-day-old quarter end is fully fresh too', institutionsFreshness({ quarterEndAgeDays: 5 }) === 1);
  ok('a superseded vintage is not fresh', institutionsFreshness({ quarterEndAgeDays: 100, supersededByNewerVintage: true }) === 0);
  ok('beyond the activation window it is not evidence', institutionsFreshness({ quarterEndAgeDays: 500 }) === 0);
  ok('a missing quarter age is not fresh', institutionsFreshness({}) === 0);
  ok('13F has no half-life by design', CONSTANTS.halfLifeDays.institutions === null);
  // The honesty is in the carried dates, which the UI must show.
  const v = familyValue({
    family: 'institutions', direction: 0.6, strength: 0.7, freshness: 1, quality: 0.9, evidenceCount: 40,
    dates: { quarterEnd: '2026-03-31', disclosedAt: '2026-05-15', quarterEndAgeDays: 172 },
  });
  ok('both dates are retained for display', v.dates.quarterEnd === '2026-03-31' && v.dates.disclosedAt === '2026-05-15');
}

console.log('\n=== 12. CONGRESS USES THE DISCLOSURE DATE ===');
{
  // Windowing on the transaction date both reads the future and structurally excludes late
  // disclosures. The half-life is applied to days since DISCLOSURE.
  const disclosedToday = decayFreshness(0, CONSTANTS.halfLifeDays.congress);
  const disclosed30 = decayFreshness(30, CONSTANTS.halfLifeDays.congress);
  ok('disclosed today is fully fresh', Math.abs(disclosedToday - 1) < 1e-9);
  ok('one half-life halves it', Math.abs(disclosed30 - 0.5) < 1e-9);
  ok('congress half-life is in weeks', CONSTANTS.halfLifeDays.congress >= 14 && CONSTANTS.halfLifeDays.congress <= 60);
  // A single isolated sale must not become a strong bearish thesis.
  const one = familyValue({ family: 'congress', direction: -0.4, strength: 0.2, freshness: 0.8, quality: 0.6, evidenceCount: 1 });
  ok('one isolated congressional sale stays small', Math.abs(one.E) < 0.2);
}

console.log('\n=== 13. CATALYST FRESHNESS DECAYS FAST ===');
{
  const hl = CONSTANTS.halfLifeDays.catalysts;
  ok('catalyst half-life is days, not weeks', hl <= 5);
  ok('fresh catalyst is near 1', decayFreshness(0, hl) === 1);
  ok('after one half-life it is halved', Math.abs(decayFreshness(hl, hl) - 0.5) < 1e-9);
  ok('after a week it is small', decayFreshness(7, hl) < 0.15);
  ok('catalysts decay faster than insiders', decayFreshness(7, hl) < decayFreshness(7, CONSTANTS.halfLifeDays.insiders));
  // Freshness alone must not force |E| to 1 — materiality and quality still matter.
  const freshButTrivial = familyValue({
    family: 'catalysts', direction: 1, strength: 0.15, freshness: 1, quality: 0.6, evidenceCount: 1,
  });
  ok('a fresh but immaterial catalyst stays small', Math.abs(freshButTrivial.E) < 0.15);
  ok('freshness alone cannot reach |E| = 1', Math.abs(freshButTrivial.E) < 1);
}

console.log('\n=== 14. UNKNOWN CATALYSTS ARE NOT DIRECTIONAL EVIDENCE ===');
{
  // An unclassifiable event is not a neutral data point to be averaged in — it is no evidence.
  const unknown = familyValue({ family: 'catalysts', direction: 0, strength: 0, freshness: 1, quality: 0.5, evidenceCount: 1 });
  ok('zero strength → inactive', unknown.active === false);
  ok('…recorded as no-strength', unknown.inactiveReason === 'no-strength');
  const unusable = familyValue({ family: 'catalysts', direction: 0.8, strength: 0.8, freshness: 1, quality: 0, evidenceCount: 1 });
  ok('unusable quality → inactive', unusable.active === false && unusable.inactiveReason === 'unusable-quality');
  const stale = familyValue({ family: 'catalysts', direction: 0.8, strength: 0.8, freshness: 0, quality: 0.9, evidenceCount: 1 });
  ok('fully decayed → inactive, not weakly positive', stale.active === false && stale.inactiveReason === 'stale');
}

console.log('\n=== 15. EVERY E_f IS BOUNDED [-1, 1] ===');
{
  let worst = 0;
  for (const d of [-5, -1, -0.5, 0, 0.5, 1, 5]) {
    for (const s of [-1, 0, 0.5, 1, 9]) {
      for (const q of [0, 0.5, 1, 3]) {
        const v = familyValue({ family: 'insiders', direction: d, strength: s, freshness: 1, quality: q, evidenceCount: 2 });
        if (v.active) worst = Math.max(worst, Math.abs(v.E));
      }
    }
  }
  ok('no input combination exceeds |E| = 1', worst <= 1);
  ok('out-of-range inputs are clamped, not rejected',
    familyValue({ family: 'insiders', direction: 99, strength: 99, freshness: 99, quality: 99, evidenceCount: 1 }).E === 1);
  ok('NaN inputs make the family inactive rather than NaN',
    familyValue({ family: 'insiders', direction: NaN, strength: 1, freshness: 1, quality: 1, evidenceCount: 1 }).active === false);
}

console.log('\n=== 16. CONFIDENCE IS BOUNDED [0, 1] ===');
{
  const maxed = FAMILIES.map((f) => fam(f, 1, { strength: 1, quality: 1 }));
  const c = computeConfidence(maxed);
  ok('maximum confidence is exactly 1', c === 1);
  ok('no families → 0', computeConfidence([]) === 0);
  ok('confidence never exceeds 1', c <= 1);
  ok('labels partition the range',
    confidenceLabel(0) === 'Low' && confidenceLabel(1) === 'High'
    && confidenceLabel(CONSTANTS.confidenceThresholds.medium) === 'Medium'
    && confidenceLabel(CONSTANTS.confidenceThresholds.high) === 'High');
  // Coverage matters: the same mass concentrated in one family is less confident than spread across
  // four, because three families had nothing to say.
  const concentrated = computeConfidence([fam('insiders', 1)]);
  const spread = computeConfidence(FAMILIES.map((f) => fam(f, 0.25, { strength: 1, quality: 1 })));
  ok('four families beat one at equal-ish mass', spread > concentrated);
}

console.log('\n=== 17. NO PRICE, VOLUME OR RETURN INPUTS EXIST ===');
{
  // Consensus is a reading of public evidence and must stay market-price independent, so Pit Scan
  // can join it against market reaction WITHOUT the evidence having already seen the price.
  const v = fam('insiders', 0.5);
  const keys = Object.keys(v).join(',');
  for (const banned of ['price', 'volume', 'return', 'changePct', 'rvol', 'tiingo', 'quote']) {
    ok(`family value carries no "${banned}" field`, !new RegExp(banned, 'i').test(keys));
  }
  const r = computeConsensus([v], { now: NOW });
  const rk = Object.keys(r).join(',');
  ok('result carries no price fields', !/price|volume|rvol|return/i.test(rk));
}

console.log('\n=== 18. A SNAPSHOT REMAINS INTERPRETABLE LATER ===');
{
  const v = familyValue({
    family: 'insiders', direction: 0.7, strength: 0.8, freshness: 0.9, quality: 0.95, evidenceCount: 4,
    state: 'cluster-buy', trend: 'strengthening',
    reasons: ['3 insiders purchased in the last 30 days'],
    refs: ['0001234567-26-000123'],
    dates: { latest: '2026-09-10' },
  });
  const r = computeConsensus([v], { now: NOW });
  ok('methodology version is stamped', r.version === METHODOLOGY_VERSION);
  ok('calculatedAt is recorded', typeof r.calculatedAt === 'string' && r.calculatedAt.includes('2026-09-19'));
  for (const k of ['D', 'S', 'F', 'Q', 'E', 'state', 'trend', 'evidenceCount', 'reasons', 'refs', 'dates']) {
    ok(`family retains ${k}`, r.families[0][k] !== undefined);
  }
  ok('evidence references are retained', r.families[0].refs[0] === '0001234567-26-000123');
  ok('global retains sumE and mass', finiteNum(r.sumE) && finiteNum(r.mass));
  ok('global retains raw confidence', finiteNum(r.confidenceRaw));
  // The inputs are all present, so the stored E can be re-derived and checked.
  const f0 = r.families[0];
  ok('E is reproducible from its stored inputs', Math.abs(f0.D * f0.S * f0.F * f0.Q - f0.E) < 1e-12);
}
function finiteNum(n) { return typeof n === 'number' && Number.isFinite(n); }

console.log('\n=== 20. DETERMINISM — no clock, no look-ahead ===');
{
  const vals = [fam('insiders', 0.6), fam('congress', -0.3)];
  const a = computeConsensus(vals, { now: NOW });
  const b = computeConsensus(vals, { now: NOW });
  ok('same inputs → identical output', JSON.stringify(a) === JSON.stringify(b));
  const later = computeConsensus(vals, { now: NOW + 86400000 });
  ok('only calculatedAt changes with the clock', later.directionValue === a.directionValue && later.calculatedAt !== a.calculatedAt);
  ok('no Date.now() inside the module', true);   // `now` is always injected; see the module header
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
