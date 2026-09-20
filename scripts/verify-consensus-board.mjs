// PIT CONSENSUS BOARD — the evidence-alignment product.
//
// The board replaced a confluence leaderboard: "3/3 SIGNALS", "224 CONFLUENCE", ranked by
// (execs*20 + value/250k*20 + members*25 + netFunds*18)/3 times 1.6 or 2.4. These assertions exist
// so that model cannot return, and so the distinctions the product depends on — active vs missing
// vs mixed, alignment only across two or more families, degraded vs empty — cannot quietly collapse.
//
// Run: node scripts/verify-consensus-board.mjs [--mutate=<mode>]

import { orderBoard, BOARD_FAMILIES, AGGREGATE_FAMILIES, BOARD_LIMIT, CONCURRENCY } from '../src/lib/consensus/board.mjs';
import { computeConsensus, familyValue, FAMILIES, CONSTANTS } from '../src/lib/consensus/consensus-v1.mjs';
import { familyLean, consensusState, CONSENSUS_STATE, describeConflicts, synthesise, normaliseFamily, familyState, familyTrend } from '../src/lib/consensus/synthesis.mjs';

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const NOW = Date.parse('2026-09-20T12:00:00Z');
const DAY = 86_400_000;

// A family carrying real evidence. Direction/strength/freshness/quality are the engine's inputs.
const fam = (family, direction, extra = {}) => familyValue({
  family, direction, strength: 0.8, freshness: 1, quality: 0.9, evidenceCount: 4,
  state: direction > 0.2 ? 'bullish' : direction < -0.2 ? 'bearish' : 'mixed',
  ...extra,
});
const missing = (family) => familyValue({ family, evidenceCount: 0 });

L('=== THE OLD MODEL IS GONE ===');
{
  const k = computeConsensus([fam('insiders', 0.8), fam('congress', 0.7)], { now: NOW });
  for (const banned of ['score', 'confluence', 'signals']) {
    ok(`no '${banned}' field in the consensus payload`, !(banned in k));
  }
  ok('the payload declares consensus_v1', k.version === 'consensus_v1');
  // FIVE families, identical to the ticker page. Market structure is included so the two surfaces
  // describe the same company with the same rows; leaving it off the board was a way for them to
  // differ. The ARITHMETIC aggregate still covers only the four disclosure families (see
  // AGGREGATE_FAMILIES) because Pit Scan compares evidence against price, and folding price into
  // the evidence side would make that comparison circular.
  ok('the board shows all five canonical families', BOARD_FAMILIES.length === 5
    && ['insiders', 'institutions', 'congress', 'catalysts', 'structure'].every((f) => BOARD_FAMILIES.includes(f)));
  ok('the arithmetic aggregate covers only the four disclosure families',
    AGGREGATE_FAMILIES.length === 4 && !AGGREGATE_FAMILIES.includes('structure'));
}

L('\n=== ACTIVE vs MISSING vs MIXED ===');
{
  const miss = missing('congress');
  ok('a family with no evidence is INACTIVE', miss.active === false);
  ok('…and carries a reason, not a zero', miss.inactiveReason === 'no-evidence' && miss.E === null);
  ok('…and has no lean at all', familyLean(miss) === null);

  const mixedFam = fam('institutions', 0);
  ok('an ACTIVE but internally mixed family is still active', mixedFam.active === true);
  ok('…and is distinguishable from a missing one', familyLean(mixedFam) === 'mixed');

  // THE CRITICAL ONE: a missing family must not dilute alignment as if it were neutral evidence.
  const withMissing = computeConsensus([fam('insiders', 0.9), fam('congress', 0.9), missing('institutions'), missing('catalysts')], { now: NOW });
  const withoutMissing = computeConsensus([fam('insiders', 0.9), fam('congress', 0.9)], { now: NOW });
  ok('missing families do not enter the alignment calculation',
    mut('neutral') ? false : withMissing.alignment === withoutMissing.alignment,
    `${withMissing.alignment} vs ${withoutMissing.alignment}`);
  ok('missing families do not inflate the active count', withMissing.activeCount === 2);
  ok('…but they ARE still reported', withMissing.families.filter((f) => !f.active).length === 2);
}

L('\n=== ALIGNMENT NEEDS TWO INDEPENDENT FAMILIES ===');
{
  const single = computeConsensus([fam('insiders', 0.9), missing('congress')], { now: NOW });
  ok('one active family reports SINGLE-SOURCE', single.alignmentState === 'single-source');
  ok('one active family produces NO alignment number',
    mut('single') ? false : single.alignment === null, String(single.alignment));
  ok('…and never reads 100%', !(single.alignment === 1));
  ok('…but still reports what that one family says', single.direction === 'bullish-lean');

  const two = computeConsensus([fam('insiders', 0.9), fam('congress', 0.9)], { now: NOW });
  ok('two agreeing families produce a real alignment', two.alignmentState === 'computed' && two.alignment > 0.9);
}

L('\n=== DIRECTIONAL STATES ===');
{
  const bull = computeConsensus([fam('insiders', 0.9), fam('congress', 0.8)], { now: NOW });
  ok('agreeing positive families read Bullish Lean', bull.directionLabel === 'Bullish Lean', bull.directionLabel);
  const bear = computeConsensus([fam('insiders', -0.9), fam('congress', -0.8)], { now: NOW });
  ok('agreeing negative families read Bearish Lean', bear.directionLabel === 'Bearish Lean', bear.directionLabel);
  const conflict = computeConsensus([fam('insiders', 0.9), fam('congress', -0.9)], { now: NOW });
  ok('opposing families are NOT averaged into a lean',
    /Mixed/.test(conflict.directionLabel), conflict.directionLabel);
  ok('…and the conflict is reported', conflict.conflict?.conflict === true);
  // Agreement on almost nothing is not a direction.
  const thin = computeConsensus([
    fam('insiders', -0.02, { strength: 0.05 }), fam('congress', -0.02, { strength: 0.05 })], { now: NOW });
  ok('perfect agreement on negligible evidence is Mixed, not a lean',
    thin.direction === 'mixed', `${thin.directionLabel} @ mass ${thin.mass?.toFixed(3)}`);
}

L('\n=== CONFIDENCE IS ABOUT THE EVIDENCE ===');
{
  const four = computeConsensus(
    ['insiders', 'institutions', 'congress', 'catalysts'].map((f) => fam(f, 0.9)), { now: NOW });
  const one = computeConsensus([fam('insiders', 0.9), missing('congress'), missing('institutions'), missing('catalysts')], { now: NOW });
  ok('more active families raises confidence',
    ['Low', 'Medium', 'High'].indexOf(four.confidence) > ['Low', 'Medium', 'High'].indexOf(one.confidence),
    `${four.confidence} vs ${one.confidence}`);
  ok('confidence is a category, not a percentage', ['Low', 'Medium', 'High'].includes(four.confidence));
  ok('coverage is measured against the four families', FAMILIES.length === 4);
}

L('\n=== POINT-IN-TIME: PUBLIC AVAILABILITY DECIDES FRESHNESS ===');
{
  // 13F: a filing published yesterday describes a position up to ~135 days old. Freshness must not
  // decay on the QUARTER END, which would fade the only institutional evidence that exists.
  const fresh = familyValue({
    family: 'institutions', direction: 0.5, strength: 0.8, quality: 0.85, evidenceCount: 10,
    freshness: 1, state: 'accumulating',
    dates: { quarterEnd: '2026-06-30', disclosedAt: '2026-09-10' },
  });
  ok('13F keeps BOTH dates, never collapsed',
    fresh.dates.quarterEnd === '2026-06-30' && fresh.dates.disclosedAt === '2026-09-10');
  ok('13F stays active on a recent vintage despite an old quarter end', fresh.active === true);

  // Congress: the activation window is on DISCLOSURE. A trade disclosed today is fresh however old
  // the transaction is.
  const cong = familyValue({
    family: 'congress', direction: 0.6, strength: 0.7, freshness: 1, quality: 0.8, evidenceCount: 1,
    state: 'bullish',
    dates: { latestDisclosure: '2026-09-18', latestTransaction: '2026-07-02' },
  });
  ok('Congress keeps disclosure and transaction dates apart',
    cong.dates.latestDisclosure !== cong.dates.latestTransaction);
  ok('Congress freshness is driven by disclosure, not transaction', cong.active === true);
  ok('the congress activation window is measured in days from disclosure',
    CONSTANTS.activationWindowDays.congress === 90);

  // Fully decayed evidence is NO evidence, not weak evidence — otherwise it pads the active count
  // and therefore confidence.
  const stale = familyValue({
    family: 'insiders', direction: 0.9, strength: 0.9, freshness: 0, quality: 0.9, evidenceCount: 3 });
  ok('fully decayed evidence becomes INACTIVE, not weak',
    mut('stale') ? false : stale.active === false && stale.inactiveReason === 'stale');
  const unusable = familyValue({
    family: 'insiders', direction: 0.9, strength: 0.9, freshness: 1, quality: 0, evidenceCount: 3 });
  ok('unusable-quality evidence becomes INACTIVE', unusable.active === false);
}

L('\n=== INVALID EVIDENCE CANNOT REACH THE BOARD ===');
{
  for (const [label, v] of [
    ['a non-finite direction', familyValue({ family: 'insiders', direction: NaN, strength: 1, freshness: 1, quality: 1, evidenceCount: 2 })],
    ['a zero evidence count', familyValue({ family: 'insiders', direction: 0.9, strength: 1, freshness: 1, quality: 1, evidenceCount: 0 })],
    ['an unknown family', familyValue({ family: 'astrology', direction: 0.9, strength: 1, freshness: 1, quality: 1, evidenceCount: 5 })],
  ]) {
    ok(`${label} is inactive`, v.active === false, v.inactiveReason);
  }
  const empty = computeConsensus([], { now: NOW });
  ok('no families at all is an explicit insufficient-evidence state',
    empty.direction === 'insufficient-evidence' && empty.activeCount === 0);
  ok('…and produces no alignment', empty.alignment === null);
}

L('\n=== ORDERING IS DETERMINISTIC AND NOT A LEADERBOARD ===');
{
  const row = (ticker, activeCount, confidence, alignment, directionValue) =>
    ({ ticker, activeCount, confidence, alignment, directionValue });
  const list = [
    row('BBB', 2, 'Low', 0.9, 0.5),
    row('AAA', 4, 'High', 0.5, 0.4),
    row('CCC', 4, 'High', 0.5, 0.4),
    row('DDD', 3, 'Medium', 0.99, 0.9),
  ];
  const out = orderBoard(list).map((r) => r.ticker);
  ok('more active independent families ranks first', out[0] === 'AAA' || out[0] === 'CCC');
  ok('a perfect tie falls back to the ticker, so the order is stable',
    out.slice(0, 2).join(',') === 'AAA,CCC', out.join(','));
  ok('ordering is pure — the same input gives the same output',
    orderBoard(list).map((r) => r.ticker).join(',') === out.join(','));
  // The ordering must be a function of EVIDENCE only. Written as property accesses so the `return`
  // keyword in the function body cannot satisfy it — an earlier version of this assertion matched
  // its own control flow and failed for the wrong reason.
  ok('ordering reads no price, return or performance field',
    !/\.(changePct|price|close|perf\w*|return\w*|marketCap)\b/.test(orderBoard.toString()));
  ok('ordering reads only evidence properties',
    ['activeCount', 'confidence', 'alignment', 'directionValue', 'ticker']
      .every((k) => orderBoard.toString().includes(k)));
  ok('the board is bounded', BOARD_LIMIT <= 100 && CONCURRENCY <= 8);
}

L('\n=== PIT SCAN CONTRACT ===');
{
  // boards.mjs refuses a row whose consensus is not consensus_v1, and reads exactly these fields.
  const k = computeConsensus([fam('insiders', 0.9), fam('congress', 0.8)], { now: NOW });
  ok('version is present and is consensus_v1', k.version === 'consensus_v1');
  for (const f of ['directionValue', 'confidence', 'activeCount']) {
    ok(`divergence's required field '${f}' is present`, k[f] !== undefined);
  }
  ok('directionValue is a finite signed number', Number.isFinite(k.directionValue) && k.directionValue > 0);
  ok('confidence is one of the ranks divergence knows', ['Low', 'Medium', 'High'].includes(k.confidence));
}

L('\n=== THE GOLD REGRESSION ===');
{
  // The exact shape that broke the product. GOLD: institutions strongly positive, congress and
  // catalysts negative, insiders mixed, structure mixed. The ARITHMETIC said "Bullish Lean" because
  // institutional magnitude outweighed two dissenting families and neither dissenter individually
  // cleared the conflict threshold. The board printed accumulation; the ticker page printed a
  // conflict; both were reading the same evidence.
  const gold = [
    fam('institutions', 0.9, { state: 'accumulating', strength: 0.95 }),
    fam('congress', -0.4, { state: 'bearish', strength: 0.3 }),
    fam('catalysts', -0.4, { state: 'negative', strength: 0.3 }),
    fam('insiders', 0, { state: 'mixed' }),
    fam('structure', 0, { state: 'no-clear-sequence' }),
  ];

  const state = consensusState(gold);
  ok('GOLD reads CONFLICT, not positive alignment',
    mut('gold') ? state === CONSENSUS_STATE.POSITIVE_ALIGNMENT : state === CONSENSUS_STATE.CONFLICT, state);

  // The specific failure: one high-magnitude family outvoting two opposing families.
  ok('one strong family cannot outvote two opposing families',
    state !== CONSENSUS_STATE.POSITIVE_ALIGNMENT);

  // And the arithmetic still leans positive — proving the headline no longer comes from it.
  const arithmetic = computeConsensus(gold.filter((f) => f.family !== 'structure'), { now: NOW });
  ok('the retired arithmetic still leans positive on this input (so the fix is the source, not the data)',
    arithmetic.directionValue > 0, String(arithmetic.directionValue?.toFixed(3)));
  ok('…and the canonical headline disagrees with it, deliberately',
    state === CONSENSUS_STATE.CONFLICT);

  // The conflict must be NAMED, not just detected.
  const conflicts = describeConflicts(gold.filter((f) => f.active));
  ok('the conflict names both sides', conflicts.length === 1
    && conflicts[0].positive.includes('institutions')
    && conflicts[0].negative.includes('congress'));
}

L('\n=== BOARD AND TICKER CANNOT DISAGREE ===');
{
  // The hard invariant (§20). Both surfaces call the same function on the same families, so this
  // asserts they are literally the same computation rather than two that happen to match today.
  const cases = [
    [fam('institutions', 0.9), fam('congress', -0.5), fam('catalysts', -0.5)],
    [fam('insiders', 0.8), fam('congress', 0.7)],
    [fam('insiders', 0.8), missing('congress'), missing('catalysts')],
    [missing('insiders'), missing('congress')],
    [fam('insiders', 0), fam('congress', 0)],
  ];
  const MAP = {
    NO_EVIDENCE: 'no-evidence', CONFLICT: 'conflicting', SINGLE_SOURCE: 'single-family',
    POSITIVE_ALIGNMENT: 'aligned', NEGATIVE_ALIGNMENT: 'aligned', MIXED: 'no-clear-agreement',
  };
  let agree = 0;
  for (const c of cases) {
    const boardState = consensusState(c);          // what the market-wide board headlines
    const tickerView = synthesise(c);              // what the ticker page renders
    if (tickerView.state === boardState && tickerView.agreement === MAP[boardState]) agree++;
  }
  ok(`board state and ticker state agree on every case (${agree}/${cases.length})`,
    agree === cases.length);

  // And the family states themselves must match, not merely the headline.
  const fams = [fam('institutions', 0.9, { state: 'accumulating' }), fam('congress', -0.5, { state: 'bearish' })];
  const norm = fams.map(normaliseFamily);
  ok('normalised family states are shared, so no surface can invent its own reading',
    norm[0].state === 'POSITIVE' && norm[1].state === 'NEGATIVE');
  ok('the family keeps its own descriptor for UI alongside the canonical state',
    norm[0].descriptor === 'accumulating' && norm[0].state === 'POSITIVE');
}

L('\n=== STATE AND TREND ARE SEPARATE AXES ===');
{
  const posWeak = fam('insiders', 0.8, { state: 'bullish', trend: 'weakening' });
  const negStrong = fam('congress', -0.8, { state: 'bearish', trend: 'strengthening' });
  ok('positive + weakening is representable', familyState(posWeak) === 'POSITIVE' && familyTrend(posWeak) === 'WEAKENING');
  ok('negative + strengthening is representable', familyState(negStrong) === 'NEGATIVE' && familyTrend(negStrong) === 'STRENGTHENING');
  ok('a fresh catalyst reads NEW', familyTrend(fam('catalysts', -0.5, { trend: 'fresh' })) === 'NEW');
  // A descriptor that merely describes evidence is NOT a change claim.
  ok('"single actor" is not treated as momentum',
    familyTrend(fam('congress', -0.5, { trend: 'single-actor' })) === 'STABLE');
  ok('an inactive family has no trend', familyTrend(missing('congress')) === null);
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
