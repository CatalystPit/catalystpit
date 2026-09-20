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
import {
  familyLean, consensusState, CONSENSUS_STATE, describeConflicts, synthesise, normaliseFamily,
  familyState, familyTrend, canonicalConsensus, meaningfulConflict, marketConfirmation, confidenceOf,
  evidenceContributions, explainState, MARKET, BOARD_FILTERS, DISCLOSURE_FAMILIES,
  MINOR_CONTRARY_SHARE, BALANCED_SHARE,
} from '../src/lib/consensus/synthesis.mjs';

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
  // Rows now order off the CANONICAL object, so the fixtures are canonical objects.
  const row = (ticker, state, confidence, active, mass = 0.5) =>
    ({ ticker, canonical: { state, confidence, coverage: { active, total: 4 },
      diagnostics: { positiveMass: mass, negativeMass: 0 } } });
  const list = [
    row('BBB', 'MIXED', 'High', 4),
    row('AAA', 'POSITIVE_ALIGNMENT', 'High', 3),
    row('CCC', 'POSITIVE_ALIGNMENT', 'High', 3),
    row('DDD', 'BALANCED_CONFLICT', 'High', 4),
  ];
  const out = orderBoard(list).map((r) => r.ticker);
  // A decided state outranks an undecided one however much evidence the undecided row has: the
  // board's job is to surface readings worth investigating, and MIXED is the absence of a reading.
  ok('a resolved state ranks above a mixed one with more coverage', out[0] !== 'BBB', out.join(','));
  ok('a perfect tie falls back to the ticker, so the order is stable',
    out.slice(0, 2).join(',') === 'AAA,CCC', out.join(','));
  ok('mixed rows sink to the bottom', out[out.length - 1] === 'BBB', out.join(','));
  ok('ordering is pure — the same input gives the same output',
    orderBoard(list).map((r) => r.ticker).join(',') === out.join(','));
  // The ordering must be a function of EVIDENCE only. Written as property accesses so the `return`
  // keyword in the function body cannot satisfy it — an earlier version of this assertion matched
  // its own control flow and failed for the wrong reason.
  ok('ordering reads no price, return or performance field',
    !/\.(changePct|price|close|perf\w*|return\w*|marketCap)\b/.test(orderBoard.toString()));
  ok('ordering reads only canonical evidence properties',
    ['state', 'confidence', 'coverage', 'ticker'].every((k) => orderBoard.toString().includes(k)));
  // Market confirmation is a SEPARATE layer. Letting it order the board would make price a
  // tiebreaker on an evidence ranking, which is the circularity the layer exists to prevent.
  ok('market confirmation does not enter the ordering',
    !/confirmation|market/i.test(orderBoard.toString()));
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
  // V2.1 answer: the opposing evidence is 22% of the directional total — material, clearly
  // outweighed, not a standoff. So the reading leans positive AND names the conflict, instead of
  // V2's flat CONFLICT (which discarded magnitude) or the arithmetic's clean "Bullish Lean"
  // (which discarded the dissent).
  ok('GOLD reads a positive LEAN WITH CONFLICT, not clean alignment',
    mut('gold') ? state === CONSENSUS_STATE.POSITIVE_ALIGNMENT
      : state === CONSENSUS_STATE.POSITIVE_LEAN_WITH_CONFLICT, state);

  // The specific failure that started this: one high-magnitude family outvoting two opposing
  // families and the dissent vanishing from the headline entirely.
  ok('one strong family cannot erase two opposing families',
    state !== CONSENSUS_STATE.POSITIVE_ALIGNMENT);
  ok('…and the conflict survives into the canonical object', /conflict/i.test(state));

  // And the arithmetic still leans positive — proving the headline no longer comes from it.
  const arithmetic = computeConsensus(gold.filter((f) => f.family !== 'structure'), { now: NOW });
  ok('the retired arithmetic still leans positive on this input (so the fix is the source, not the data)',
    arithmetic.directionValue > 0, String(arithmetic.directionValue?.toFixed(3)));

  // The conflict must be NAMED, not just detected.
  const conflicts = meaningfulConflict(gold);
  ok('the conflict names both sides', conflicts.length === 1
    && conflicts[0].positive.includes('institutions')
    && conflicts[0].negative.includes('congress'));
  // The KEY CONFLICT sentence is held to the same grammar as the WHY: family lists are never the
  // subject, and a list of three reads as a list.
  ok('the conflict text does not make a family list its subject',
    !/^(Insiders|Institutions|Congress|Catalysts)\b/.test(conflicts[0].text), conflicts[0].text);
  ok('…and chains no ANDs', !/ and .* and /.test(conflicts[0].text), conflicts[0].text);

  const k = canonicalConsensus(gold, { now: NOW });
  ok('the dissenting families are carried as OPPOSITION, not as minor contrary evidence',
    k.opposition.map((f) => f.family).sort().join(',') === 'catalysts,congress'
    && k.minorContrary.length === 0, JSON.stringify(k.opposition.map((f) => f.family)));
  ok('the WHY names the outweighed side rather than dropping it',
    /congress/i.test(k.why) && /outweigh/i.test(k.why), k.why);
  // Structure is mixed here, and the state leans — price must decline to confirm either way.
  ok('mixed price structure does not confirm the lean', k.market.confirmation === 'MIXED');
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
    NO_EVIDENCE: 'no-evidence', SINGLE_SOURCE: 'single-family', MIXED: 'no-clear-agreement',
    POSITIVE_ALIGNMENT: 'aligned', NEGATIVE_ALIGNMENT: 'aligned',
    BALANCED_CONFLICT: 'conflicting',
    POSITIVE_LEAN_WITH_CONFLICT: 'conflicting', NEGATIVE_LEAN_WITH_CONFLICT: 'conflicting',
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

// ════════════════════════════════════════════════════════════════════════════
// V2.1 — CONTRIBUTION-AWARE SYNTHESIS
// ════════════════════════════════════════════════════════════════════════════

L('\n=== MINOR CONTRARY EVIDENCE IS NOT A CONFLICT ===');
{
  // THE AMRZ SHAPE. Measured on the live board: positive mass 0.887 against negative 0.002 — a
  // ratio of 0.003 — reported to the reader as a conflict. Magnitude was computed by four factors
  // and then discarded at the last step.
  // ONE dissenting family, reused verbatim below, so the two fixtures differ only in what it opposes.
  const dissent = () => fam('congress', -0.05, { strength: 0.05, quality: 0.9, state: 'bearish' });
  const amrz = [
    fam('insiders', 0.95, { strength: 0.95, quality: 0.95 }),
    fam('institutions', 0.9, { strength: 0.9, quality: 0.95 }),
    dissent(),
  ];
  const c = evidenceContributions(amrz);
  ok('the minority side is a tiny share of the directional evidence',
    c.minorityShare < MINOR_CONTRARY_SHARE, c.minorityShare.toFixed(4));
  const state = consensusState(amrz);
  ok('a 5:1-outweighed dissenter does not make it a conflict',
    state === CONSENSUS_STATE.POSITIVE_ALIGNMENT, state);

  const k = canonicalConsensus(amrz, { now: NOW });
  // But it is NOT hidden. Suppressing contrary evidence would be the opposite defect.
  ok('the contrary family is still surfaced, as minor contrary evidence',
    k.minorContrary.map((f) => f.family).join(',') === 'congress');
  ok('…and is not listed as opposition', k.opposition.length === 0);
  ok('…and the WHY says so explicitly', /minor contrary/i.test(k.why), k.why);
  ok('no KEY CONFLICT box is raised for it', meaningfulConflict(amrz).length === 0);

  // The threshold must be RELATIVE, not absolute: the same tiny family against tiny support IS a
  // contest. This is what separates a share test from a magnitude floor.
  const small = [
    fam('insiders', 0.06, { strength: 0.06, quality: 0.9, state: 'bullish' }),
    fam('institutions', 0.05, { strength: 0.05, quality: 0.9, state: 'accumulating' }),
    dissent(),
  ];
  // The dissenting family in `small` is BYTE-IDENTICAL to the one in `amrz` — same direction,
  // strength, freshness, quality, so the same E. Only what it opposes differs. If the test were an
  // absolute magnitude floor, both would land in the same state; because it is a share, they do not.
  ok('the dissenter is the identical family in both fixtures',
    small[2].E === amrz[2].E && small[2].family === amrz[2].family);
  ok('the same dissenter against comparable support is no longer minor',
    mut('absolute') ? false : evidenceContributions(small).minorityShare >= MINOR_CONTRARY_SHARE,
    evidenceContributions(small).minorityShare.toFixed(3));
  ok('…so an identical family changes the state purely by what it opposes',
    consensusState(small) !== consensusState(amrz),
    `${consensusState(small)} vs ${consensusState(amrz)}`);
  ok('…and now raises a KEY CONFLICT where it did not before',
    meaningfulConflict(small).length === 1 && meaningfulConflict(amrz).length === 0);
}

L('\n=== THE LEAN STATES ===');
{
  // Between 15% and 40% of the directional evidence: material, clearly outweighed. V2 collapsed
  // this band and the one above it into a single CONFLICT, so a 4:1 lean and a coin-flip read
  // identically.
  const lean = [
    fam('insiders', 0.9, { strength: 0.9, quality: 0.95 }),
    fam('institutions', 0.8, { strength: 0.8, quality: 0.95 }),
    fam('congress', -0.6, { strength: 0.55, quality: 0.9, state: 'bearish' }),
  ];
  const cl = evidenceContributions(lean);
  ok('the fixture sits in the lean band',
    cl.minorityShare >= MINOR_CONTRARY_SHARE && cl.minorityShare < BALANCED_SHARE,
    cl.minorityShare.toFixed(3));
  ok('a clearly-outweighed but material dissent reads LEAN WITH CONFLICT',
    consensusState(lean) === CONSENSUS_STATE.POSITIVE_LEAN_WITH_CONFLICT);
  ok('the mirrored input reads the negative lean',
    consensusState([
      fam('insiders', -0.9, { strength: 0.9, quality: 0.95, state: 'bearish' }),
      fam('institutions', -0.8, { strength: 0.8, quality: 0.95, state: 'distributing' }),
      fam('congress', 0.6, { strength: 0.55, quality: 0.9, state: 'bullish' }),
    ])
      === CONSENSUS_STATE.NEGATIVE_LEAN_WITH_CONFLICT);

  // Above 40% neither side dominates — within 1.5:1.
  const even = [
    fam('insiders', 0.8, { strength: 0.8, quality: 0.9 }),
    fam('congress', -0.75, { strength: 0.78, quality: 0.9, state: 'bearish' }),
  ];
  ok('two comparable opposing families read BALANCED CONFLICT',
    consensusState(even) === CONSENSUS_STATE.BALANCED_CONFLICT,
    evidenceContributions(even).minorityShare.toFixed(3));

  // The band boundaries must be ordered and fixed, not free parameters.
  ok('the thresholds are ordered and inside (0,1)',
    MINOR_CONTRARY_SHARE > 0 && MINOR_CONTRARY_SHARE < BALANCED_SHARE && BALANCED_SHARE <= 0.5);
  // 50% is the maximum a minority share can reach by construction — a value above it would mean
  // the "minority" side was larger, which is arithmetically impossible.
  ok('a minority share can never exceed one half',
    [amrzShare(lean), amrzShare(even), amrzShare([fam('insiders', 0.5), fam('congress', -0.5)])]
      .every((s) => s <= 0.5 + 1e-9));
}
function amrzShare(f) { return evidenceContributions(f).minorityShare; }

L('\n=== ALL EIGHT STATES ARE REACHABLE ===');
{
  const reached = new Set([
    consensusState([]),                                                     // NO_EVIDENCE
    consensusState([missing('insiders'), fam('congress', 0)]),              // MIXED (no direction)
    consensusState([fam('insiders', 0.9), missing('congress')]),            // SINGLE_SOURCE
    consensusState([fam('insiders', 0.9), fam('congress', 0.8)]),           // POSITIVE_ALIGNMENT
    consensusState([fam('insiders', -0.9), fam('congress', -0.8)]),         // NEGATIVE_ALIGNMENT
    consensusState([fam('insiders', 0.9, { strength: 0.9 }), fam('institutions', 0.8), fam('congress', -0.6, { strength: 0.55 })]),
    consensusState([fam('insiders', -0.9, { strength: 0.9 }), fam('institutions', -0.8), fam('congress', 0.6, { strength: 0.55 })]),
    consensusState([fam('insiders', 0.8), fam('congress', -0.78, { strength: 0.79 })]),
  ]);
  for (const s of Object.keys(CONSENSUS_STATE)) {
    ok(`${s} is reachable from real family shapes`, reached.has(s));
  }
  ok('exactly eight states exist', Object.keys(CONSENSUS_STATE).length === 8);
}

L('\n=== MARKET STRUCTURE IS A CONFIRMATION LAYER, NOT A FIFTH VOTE ===');
{
  ok('the disclosure families are the four filing-based ones',
    DISCLOSURE_FAMILIES.length === 4 && !DISCLOSURE_FAMILIES.includes('structure'));

  const disclosure = [fam('insiders', 0.9), fam('congress', 0.8)];
  const up = fam('structure', 0.8, { state: 'higher-highs-and-lows' });
  const down = fam('structure', -0.8, { state: 'lower-highs-and-lows' });

  // THE CRITICAL ONE: price cannot change what the disclosure evidence says.
  ok('price structure does not change the evidence state',
    mut('vote') ? false
      : consensusState([...disclosure, down]) === consensusState([...disclosure, up])
        && consensusState([...disclosure, up]) === consensusState(disclosure),
    `${consensusState([...disclosure, down])} vs ${consensusState(disclosure)}`);
  ok('…nor the coverage count',
    canonicalConsensus([...disclosure, down], { now: NOW }).coverage.total === 4);
  ok('…nor the confidence', confidenceOf([...disclosure, down]) === confidenceOf(disclosure));

  const pos = CONSENSUS_STATE.POSITIVE_ALIGNMENT;
  ok('agreeing structure CONFIRMS', marketConfirmation(up, pos) === MARKET.CONFIRMING);
  ok('opposing structure DIVERGES', marketConfirmation(down, pos) === MARKET.DIVERGING);
  ok('an inactive structure family is UNAVAILABLE',
    marketConfirmation(missing('structure'), pos) === MARKET.UNAVAILABLE);
  ok('a missing structure family is UNAVAILABLE', marketConfirmation(null, pos) === MARKET.UNAVAILABLE);

  // NO FAKE CONFIRMATION. Confirmation requires something to confirm.
  for (const s of [CONSENSUS_STATE.BALANCED_CONFLICT, CONSENSUS_STATE.MIXED,
    CONSENSUS_STATE.SINGLE_SOURCE, CONSENSUS_STATE.NO_EVIDENCE]) {
    ok(`structure cannot "confirm" ${s} — there is no lean to confirm`,
      mut('fakeconfirm') ? false : marketConfirmation(up, s) === MARKET.MIXED,
      marketConfirmation(up, s));
  }
  ok('an internally mixed structure confirms nothing',
    marketConfirmation(fam('structure', 0, { state: 'no-clear-sequence' }), pos) === MARKET.MIXED);
  ok('the negative lean is confirmed by lower highs and lows',
    marketConfirmation(down, CONSENSUS_STATE.NEGATIVE_LEAN_WITH_CONFLICT) === MARKET.CONFIRMING);
}

L('\n=== COVERAGE AND CONFIDENCE ARE DIFFERENT QUESTIONS ===');
{
  // Three strong aligned families with the fourth silent must be able to reach High. Under the
  // retired coverage-fraction confidence, 3-of-4 could not — missing evidence was scored as if it
  // were disagreement.
  const three = ['insiders', 'institutions', 'congress'].map((f) => fam(f, 0.9, { strength: 0.9, quality: 0.9 }));
  const k = canonicalConsensus([...three, missing('catalysts')], { now: NOW });
  ok('three strong aligned families reach High confidence with the fourth silent',
    k.confidence === 'High', k.confidence);
  ok('…while coverage honestly reports 3 of 4',
    k.coverage.active === 3 && k.coverage.total === 4);
  ok('…and the silent family is named, not dropped',
    k.coverage.inactiveFamilies.some((f) => f.family === 'catalysts' && f.reason));

  // Conflict reduces confidence; missing evidence reduces coverage. They must not be the same knob.
  const contested = canonicalConsensus([
    fam('insiders', 0.8, { strength: 0.8, quality: 0.9 }),
    fam('institutions', 0.8, { strength: 0.8, quality: 0.9 }),
    fam('congress', -0.8, { strength: 0.8, quality: 0.9, state: 'bearish' }),
    fam('catalysts', -0.8, { strength: 0.8, quality: 0.9, state: 'negative' }),
  ], { now: NOW });
  ok('full coverage with a genuine contest is not High confidence',
    contested.coverage.active === 4 && contested.confidence !== 'High',
    `${contested.coverage.active}/4 ${contested.confidence}`);
  ok('single-source evidence is never better than Low confidence',
    canonicalConsensus([fam('insiders', 0.95, { strength: 0.99, quality: 0.99 }), missing('congress')],
      { now: NOW }).confidence === 'Low');
  ok('confidence is a word, never a percentage',
    ['Low', 'Medium', 'High'].includes(k.confidence) && !/%/.test(String(k.confidence)));
}

L('\n=== THE CANONICAL OBJECT CARRIES NO SCORE ===');
{
  const k = canonicalConsensus([fam('insiders', 0.9), fam('congress', 0.8), fam('structure', 0.7)], { now: NOW });
  const json = JSON.stringify(k);
  for (const banned of ['score', 'rating', 'confluence', 'target', 'probability', 'expectedReturn']) {
    ok(`the canonical object exposes no '${banned}'`, !new RegExp(`"${banned}`, 'i').test(json));
  }
  // minorityShare is the number the states are cut from. It exists for diagnostics and must stay
  // out of the rendered surfaces, or it becomes the precise-looking figure this product removed.
  ok('the cut number lives under diagnostics, not at the top level',
    k.diagnostics.minorityShare !== undefined && k.minorityShare === undefined);
  ok('the canonical object is snapshot-ready', !!k.version && !!k.calculatedAt && !!k.state);
  ok('drivers, opposition and minor contrary are disjoint', (() => {
    const all = [...k.drivers, ...k.opposition, ...k.minorContrary].map((f) => f.family);
    return new Set(all).size === all.length;
  })());
}

L('\n=== FILTERS CAN REACH EVERY STATE ===');
{
  const stateFilters = BOARD_FILTERS.filter((f) => f.states);
  for (const s of Object.keys(CONSENSUS_STATE)) {
    const hits = stateFilters.filter((f) => f.states.includes(s));
    ok(`${s} is reachable from exactly one filter`, hits.length === 1,
      hits.map((h) => h.key).join(',') || 'none');
  }
  ok('no filter names a state that does not exist',
    stateFilters.every((f) => f.states.every((s) => s in CONSENSUS_STATE)));
  ok('the market filter selects on the confirmation layer, not on a state',
    BOARD_FILTERS.some((f) => f.market === MARKET.DIVERGING && !f.states));
  // ⚠️ A filter must describe an evidence situation, never a recommendation.
  ok('no filter is phrased as a pick, a buy or a ranking',
    !/best|top|pick|buy|sell|strong(est)?\b|winner/i.test(BOARD_FILTERS.map((f) => f.label).join(' ')));
}

L('\n=== THE WHY IS DETERMINISTIC AND DERIVED ===');
{
  const fams = [fam('insiders', 0.9), fam('institutions', 0.8), fam('congress', -0.6, { strength: 0.55, state: 'bearish' })];
  const a = explainState(fams, consensusState(fams));
  const b = explainState(fams, consensusState(fams));
  ok('the same evidence produces the same sentence, always', a === b && a.length > 0);
  ok('the sentence names actual families', /insider/i.test(a) && /congress/i.test(a), a);
  for (const s of Object.keys(CONSENSUS_STATE)) {
    ok(`${s} has an explanation, never an empty headline`,
      typeof explainState(fams, s) === 'string' && explainState(fams, s).length > 10);
  }
  ok('the explanation makes no claim about price',
    !/will|expect|should|likely|target|outperform/i.test(a), a);

  // Production read "Insiders and Institutions and Congress align positive" — a template writing a
  // list, not a sentence somebody is being asked to trust.
  const three = ['insiders', 'institutions', 'congress'].map((f) => fam(f, 0.9));
  const t = explainState(three, consensusState(three));
  ok('a three-family list reads as a list, not a chain of ANDs',
    !/ and .* and /.test(t), t);
  ok('…and still names all three', ['Insider', 'Institution', 'Congress'].every((n) => t.includes(n)), t);

  // SUBJECT-VERB AGREEMENT. "Insiders" are many and "Congress" is one, so any sentence that makes
  // the family list its subject is wrong for one of them whichever verb the template picks. Every
  // sentence must therefore survive a single-family Congress input.
  for (const s of Object.keys(CONSENSUS_STATE)) {
    const cong = [fam('congress', 0.9), fam('insiders', -0.85, { strength: 0.9 }), fam('institutions', 0)];
    const sentence = explainState(cong, s);
    ok(`${s} reads correctly with Congress as the named family`,
      mut('agreement') ? false
        : !/^(Insiders|Institutions|Congress|Catalysts)\b/.test(sentence),
      sentence);
  }
}

L('\n=== A ROW NEVER CONTRADICTS ITS OWN HEADLINE ===');
{
  // GOLD and CLH in production: state MIXED, WHY "too slight to name a direction" — and the row
  // still printed driver and opposition chips. The canonical object was describing a direction the
  // state had explicitly declined to name.
  const thin = [
    fam('insiders', -0.3, { strength: 0.25, quality: 0.8, state: 'bearish' }),
    fam('congress', -0.3, { strength: 0.2, quality: 0.8, state: 'bearish' }),
  ];
  const k = canonicalConsensus(thin, { now: NOW });
  ok('the fixture is genuinely below the directional floor', k.state === CONSENSUS_STATE.MIXED, k.state);
  ok('a MIXED row names no drivers',
    mut('phantom') ? false : k.drivers.length === 0, JSON.stringify(k.drivers.map((f) => f.family)));
  ok('…and no opposition', k.opposition.length === 0 && k.minorContrary.length === 0);
  ok('…but the families are still carried for the detail view',
    k.families.filter((f) => f.active).length === 2);
  ok('…and the WHY says exactly that', /too slight/i.test(k.why), k.why);

  const none = canonicalConsensus([missing('insiders'), missing('congress')], { now: NOW });
  ok('a NO_EVIDENCE row names no drivers either', none.drivers.length === 0);

  // The converse: every state that DOES name a direction must name what drives it, or the reader
  // is given a conclusion with nothing behind it.
  for (const fams of [
    [fam('insiders', 0.9), fam('congress', 0.8)],
    [fam('insiders', -0.9), fam('congress', -0.8)],
    [fam('insiders', 0.9, { strength: 0.9 }), fam('institutions', 0.8), fam('congress', -0.6, { strength: 0.55 })],
    [fam('insiders', 0.8), fam('congress', -0.78, { strength: 0.79 })],
    [fam('insiders', 0.9), missing('congress')],
  ]) {
    const c = canonicalConsensus(fams, { now: NOW });
    ok(`${c.state} names at least one driving family`, c.drivers.length > 0);
  }
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
