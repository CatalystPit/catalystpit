// PIT SCAN V1 — the three boards and the rules that keep them honest.
//
// Pure: no database, no network, no clock. Membership and ranking are functions of a row, so every
// assertion here is about the PRODUCT RULE rather than about today's market.
//
// ⚠️ NOTHING HERE IS FITTED TO RETURNS. Ranking is discovery prioritisation. A test that asserted a
// board ordering predicted anything would be asserting something we have not established and this
// task explicitly forbids.
//
// Run: node scripts/verify-pitscan-boards.mjs

import {
  qualifiesMovingNow, qualifiesCatalystsNow, qualifiesDivergence,
  buildBoard, scoreMovingNow, scoreCatalystsNow, scoreDivergence,
  THRESHOLDS, BOARDS, BOARDS_VERSION, formatAge,
} from '../src/lib/scan/boards.mjs';
import {
  selectPrimaryCatalyst, toCandidate, insiderContext, CATALYST_TYPES, ITEM_TO_TYPE,
} from '../src/lib/scan/catalyst-select.mjs';
import { VOLUME_METHODOLOGY, methodologyCompatible } from '../src/lib/scan/provider-contract.mjs';
import { sessionPhase, SESSION } from '../src/lib/scan/market-state.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}`); } };
const NOW = Date.parse('2026-09-21T15:00:00Z');   // Monday 11:00 ET, regular session
const agoH = (h) => new Date(NOW - h * 3600000).toISOString();
const row = (over = {}) => ({ symbol: 'TEST', last: 10, changePct: 0, ...over });
const cat = (type, hoursAgo, over = {}) => ({ ...toCandidate({ type, publicAt: agoH(hoursAgo), ref: 'ref-1' }), ...over });

console.log('\n=== 1. MOVING NOW identifies supported structure conditions ===');
{
  ok('a big move qualifies on its own', qualifiesMovingNow(row({ changePct: 4.2 }), { now: NOW }).ok);
  ok('a small move with fresh structure qualifies',
    qualifiesMovingNow(row({ changePct: 1.1, structure: { label: 'ORB', at: agoH(0.2) } }), { now: NOW }).ok);
  ok('a small move with NO structure does not', !qualifiesMovingNow(row({ changePct: 1.1 }), { now: NOW }).ok);
  ok('a tiny move with structure still does not', !qualifiesMovingNow(row({ changePct: 0.2, structure: { label: 'ORB', at: agoH(0.2) } }), { now: NOW }).ok);
  ok('stale structure is rejected',
    qualifiesMovingNow(row({ changePct: 1.1, structure: { label: 'ORB', at: agoH(5) } }), { now: NOW }).reason === 'structure-stale');
  ok('no price at all is rejected', qualifiesMovingNow(row({ changePct: null, last: null }), { now: NOW }).reason === 'no-price');
  ok('downside moves qualify too', qualifiesMovingNow(row({ changePct: -5 }), { now: NOW }).ok);
  ok('the reason is human-readable', /%/.test(qualifiesMovingNow(row({ changePct: 4.2 }), { now: NOW }).why));
}

console.log('\n=== 2+6. CATALYSTS NOW admits only qualifying material events ===');
{
  ok('a fresh material 8-K qualifies', qualifiesCatalystsNow(row({ catalyst: cat('sec_8k_material_agreement', 1) }), { now: NOW }).ok);
  ok('a routine 10b5-1 sale does NOT', !qualifiesCatalystsNow(row({ catalyst: cat('insider_routine_sell', 1) }), { now: NOW }).ok);
  ok('…because it is below the materiality floor',
    qualifiesCatalystsNow(row({ catalyst: cat('insider_routine_sell', 1) }), { now: NOW }).reason === 'below-materiality');
  ok('a cluster buy qualifies', qualifiesCatalystsNow(row({ catalyst: cat('insider_cluster_buy', 2) }), { now: NOW }).ok);
  ok('no catalyst is rejected', qualifiesCatalystsNow(row({}), { now: NOW }).reason === 'no-catalyst');
  ok('a stale catalyst is rejected', qualifiesCatalystsNow(row({ catalyst: cat('sec_8k_results', 100) }), { now: NOW }).reason === 'stale');
  ok('every eligible type has a materiality', Object.values(CATALYST_TYPES).every((t) => typeof t.materiality === 'number'));
  ok('every eligible type has a label and family', Object.values(CATALYST_TYPES).every((t) => t.label && t.family));
}

console.log('\n=== 3. CATALYST FRESHNESS USES PUBLIC AVAILABILITY ===');
{
  const c = toCandidate({ type: 'sec_8k_results', publicAt: agoH(3), ref: 'acc-1' });
  ok('publicAt is what is carried', typeof c.publicAt === 'string');
  ok('a candidate with no publicAt is refused', toCandidate({ type: 'sec_8k_results' }) === null);
  ok('a row with no public timestamp is refused',
    qualifiesCatalystsNow(row({ catalyst: { ...c, publicAt: null } }), { now: NOW }).reason === 'no-public-timestamp');
}

console.log('\n=== 4. CONGRESS FRESHNESS USES DISCLOSURE, NOT TRADE DATE ===');
{
  // A member may trade 40 days before disclosing. The catalyst is dated to the disclosure, so a
  // fresh disclosure of an old trade is fresh evidence — and an old disclosure is not made fresh by
  // a recent trade date.
  const disclosedToday = toCandidate({ type: 'congress_disclosure', publicAt: agoH(2) });
  ok('a disclosure made 2h ago is fresh', qualifiesCatalystsNow(row({ catalyst: disclosedToday }), { now: NOW }).ok);
  const disclosedLongAgo = toCandidate({ type: 'congress_disclosure', publicAt: agoH(200) });
  ok('a disclosure made 200h ago is stale', !qualifiesCatalystsNow(row({ catalyst: disclosedLongAgo }), { now: NOW }).ok);
  ok('the congress types exist', !!CATALYST_TYPES.congress_disclosure && !!CATALYST_TYPES.congress_multi);
  ok('multiple members outrank a single disclosure',
    CATALYST_TYPES.congress_multi.materiality > CATALYST_TYPES.congress_disclosure.materiality);
}

console.log('\n=== 5+6+7. DIVERGENCE GATES ===');
{
  const good = { version: 'consensus_v1', activeCount: 3, confidence: 'High', directionValue: 0.62 };
  ok('bullish evidence + falling price qualifies',
    qualifiesDivergence(row({ changePct: -5, consensus: good }), { now: NOW }).ok);
  ok('bearish evidence + rallying price qualifies',
    qualifiesDivergence(row({ changePct: 6, consensus: { ...good, directionValue: -0.5 } }), { now: NOW }).ok);
  ok('agreement is NOT divergence',
    qualifiesDivergence(row({ changePct: 6, consensus: good }), { now: NOW }).reason === 'evidence-and-price-agree');

  // 5: at least two active families
  ok('one active family is refused',
    qualifiesDivergence(row({ changePct: -5, consensus: { ...good, activeCount: 1 } }), { now: NOW }).reason === 'too-few-families');
  ok('two families are enough', qualifiesDivergence(row({ changePct: -5, consensus: { ...good, activeCount: 2 } }), { now: NOW }).ok);

  // 6: confidence at least Medium
  ok('Low confidence is refused',
    qualifiesDivergence(row({ changePct: -5, consensus: { ...good, confidence: 'Low' } }), { now: NOW }).reason === 'confidence-too-low');
  ok('Medium confidence is accepted', qualifiesDivergence(row({ changePct: -5, consensus: { ...good, confidence: 'Medium' } }), { now: NOW }).ok);

  // 7: the legacy score can never power this board
  ok('a legacy consensus object is REFUSED',
    qualifiesDivergence(row({ changePct: -5, consensus: { score: 224, signals: 3 } }), { now: NOW }).reason === 'legacy-consensus-refused');
  ok('…even when it looks otherwise complete',
    qualifiesDivergence(row({ changePct: -5, consensus: { version: 'confluence_v0', activeCount: 3, confidence: 'High', directionValue: 0.9 } }), { now: NOW }).reason === 'legacy-consensus-refused');
  ok('no consensus at all is refused', qualifiesDivergence(row({ changePct: -5 }), { now: NOW }).reason === 'no-consensus');

  // Magnitude gates
  ok('a small move is refused', qualifiesDivergence(row({ changePct: -1, consensus: good }), { now: NOW }).reason === 'move-too-small');
  ok('a weak evidence lean is refused',
    qualifiesDivergence(row({ changePct: -5, consensus: { ...good, directionValue: 0.1 } }), { now: NOW }).reason === 'evidence-lean-too-weak');
}

console.log('\n=== 8. INACTIVE CONSENSUS FAMILIES ARE NOT NEUTRAL EVIDENCE ===');
{
  // activeCount counts families with usable evidence. A ticker with two active and two inactive
  // families must be treated as two, never four.
  const twoActive = { version: 'consensus_v1', activeCount: 2, confidence: 'Medium', directionValue: 0.5 };
  ok('two active families pass the family gate', qualifiesDivergence(row({ changePct: -5, consensus: twoActive }), { now: NOW }).ok);
  const oneActive = { ...twoActive, activeCount: 1 };
  ok('one active family fails even though others exist but are inactive',
    !qualifiesDivergence(row({ changePct: -5, consensus: oneActive }), { now: NOW }).ok);
  ok('activeCount 0 fails', !qualifiesDivergence(row({ changePct: -5, consensus: { ...twoActive, activeCount: 0 } }), { now: NOW }).ok);
}

console.log('\n=== 9+10. VOLUME — never mislabelled, never mixed ===');
{
  ok('venue vs consolidated is refused',
    !methodologyCompatible(VOLUME_METHODOLOGY.SINGLE_VENUE, VOLUME_METHODOLOGY.CONSOLIDATED));
  ok('consolidated vs venue is refused',
    !methodologyCompatible(VOLUME_METHODOLOGY.CONSOLIDATED, VOLUME_METHODOLOGY.SINGLE_VENUE));
  ok('same methodology is allowed', methodologyCompatible(VOLUME_METHODOLOGY.SINGLE_VENUE, VOLUME_METHODOLOGY.SINGLE_VENUE));
  ok('unknown is never compatible', !methodologyCompatible(null, VOLUME_METHODOLOGY.CONSOLIDATED));
  // Volume is OPTIONAL in V1: no board rule reads it, so an absent volume cannot silently become 0.
  const noVolume = row({ changePct: 5, volume: null, rvol: null });
  ok('a row with no volume still qualifies for Moving Now', qualifiesMovingNow(noVolume, { now: NOW }).ok);
  ok('no board threshold mentions volume',
    !/volume|rvol/i.test(JSON.stringify(THRESHOLDS)));
}

console.log('\n=== 11. SESSION BOUNDARIES ===');
{
  // Reused from market-state.mjs rather than reimplemented — two session implementations is how
  // they drift apart.
  ok('premarket is premarket', sessionPhase(SESSION.PREMARKET_OPEN + 10) === 'premarket');
  ok('the open is regular', sessionPhase(SESSION.REGULAR_OPEN + 1) === 'regular');
  ok('just before the open is premarket', sessionPhase(SESSION.REGULAR_OPEN - 1) === 'premarket');
  ok('just after the close is after-hours', sessionPhase(SESSION.REGULAR_CLOSE + 1) === 'afterhours');
  ok('the middle of the night is closed', sessionPhase(120) === 'closed');
}

console.log('\n=== 12. FUTURE-DATED EVIDENCE CANNOT CONTAMINATE ===');
{
  const future = { ...toCandidate({ type: 'sec_8k_non_reliance', publicAt: new Date(NOW + 3600000).toISOString() }) };
  ok('a future-dated catalyst is refused by the board',
    qualifiesCatalystsNow(row({ catalyst: future }), { now: NOW }).reason === 'future-dated');
  // …and cannot win selection by appearing freshest.
  const picked = selectPrimaryCatalyst([future, cat('sec_8k_other', 1)], { now: NOW });
  ok('a future-dated candidate never wins selection', picked?.type === 'sec_8k_other');
}

console.log('\n=== 13+14. ONE TICKER, ONE ROW PER BOARD ===');
{
  const dupes = [
    row({ symbol: 'ABC', changePct: 5, catalyst: cat('sec_8k_results', 1) }),
    row({ symbol: 'ABC', changePct: 5, catalyst: cat('sec_8k_other', 2) }),
    row({ symbol: 'XYZ', changePct: 4 }),
  ];
  const b = buildBoard('moving-now', dupes, { now: NOW });
  ok('duplicates collapse to one row', b.rows.filter((r) => r.symbol === 'ABC').length === 1);
  ok('other symbols survive', b.rows.some((r) => r.symbol === 'XYZ'));
  ok('every symbol is unique', new Set(b.rows.map((r) => r.symbol)).size === b.rows.length);
  // Dedup keeps the strongest instance, so input order cannot change the board.
  const reversed = buildBoard('moving-now', [...dupes].reverse(), { now: NOW });
  ok('dedup is order-independent',
    JSON.stringify(b.rows.map((r) => r.symbol)) === JSON.stringify(reversed.rows.map((r) => r.symbol)));
}

console.log('\n=== 15+16. PRIMARY CATALYST SELECTION IS DETERMINISTIC ===');
{
  const candidates = [cat('sec_8k_results', 3), cat('insider_buy', 1), cat('congress_disclosure', 5)];
  const a = selectPrimaryCatalyst(candidates, { now: NOW });
  const b = selectPrimaryCatalyst([...candidates].reverse(), { now: NOW });
  ok('same inputs, same pick regardless of order', a.type === b.type);
  ok('selection returns exactly one', a && !Array.isArray(a));

  // 16: fresh + material beats stale background.
  const freshOffering = cat('sec_8k_obligation', 0.2);
  const staleResults = cat('sec_8k_results', 40);
  ok('a fresh material filing outranks a stale one',
    selectPrimaryCatalyst([staleResults, freshOffering], { now: NOW }).type === 'sec_8k_obligation');
  // …and a fresh trivial event does NOT beat a fresh material one.
  ok('materiality still matters at equal freshness',
    selectPrimaryCatalyst([cat('sec_8k_other', 1), cat('sec_8k_non_reliance', 1)], { now: NOW }).type === 'sec_8k_non_reliance');
  ok('empty input returns null', selectPrimaryCatalyst([], { now: NOW }) === null);
  ok('all-unusable input returns null', selectPrimaryCatalyst([null, undefined], { now: NOW }) === null);
}

console.log('\n=== 17+18. INSIDER NOISE VS INSIDER EVIDENCE ===');
{
  // 17: routine selling must not become a strong catalyst.
  ok('a routine sale never outranks a material 8-K',
    selectPrimaryCatalyst([cat('insider_routine_sell', 0.1), cat('sec_8k_material_agreement', 6)], { now: NOW }).type === 'sec_8k_material_agreement');
  ok('routine selling is below the Catalysts Now floor',
    CATALYST_TYPES.insider_routine_sell.materiality < THRESHOLDS.catalystsNow.minMateriality);
  ok('routine selling produces no insider context label', insiderContext({ routineSells: 4 }) === null);

  // 18: meaningful insider evidence does contribute.
  ok('a cluster reads as CLUSTER', insiderContext({ buyers: 3, cluster: true }) === 'CLUSTER');
  ok('an officer purchase is surfaced', insiderContext({ buyers: 1, officerBuy: true }) === 'CEO/CFO BUY');
  ok('multiple buys are counted', insiderContext({ buyers: 2 }) === '2 BUYS');
  ok('a single buy is surfaced', insiderContext({ buyers: 1 }) === '1 BUY');
  ok('discretionary selling is surfaced', insiderContext({ discretionarySellers: 3 }) === '3 SELLS');
  ok('cluster buys outrank ordinary buys', CATALYST_TYPES.insider_cluster_buy.materiality > CATALYST_TYPES.insider_buy.materiality);
  ok('officer buys outrank ordinary buys', CATALYST_TYPES.insider_officer_buy.materiality > CATALYST_TYPES.insider_buy.materiality);
  // Nothing is invented when there is no evidence: an empty cell, not the word NONE.
  ok('no insider evidence yields null, not a label', insiderContext({}) === null);
}

console.log('\n=== 19. 13F IS BACKGROUND, NEVER A CATALYST ===');
{
  const inst = { type: 'institutions_change', family: 'institutions', materiality: 0.9, publicAt: agoH(1), label: '13F' };
  ok('13F is refused by the board', qualifiesCatalystsNow(row({ catalyst: inst }), { now: NOW }).reason === '13f-is-not-a-catalyst');
  ok('13F can never be selected as primary', selectPrimaryCatalyst([inst], { now: NOW }) === null);
  ok('…even alongside a weaker real catalyst',
    selectPrimaryCatalyst([inst, cat('sec_8k_other', 20)], { now: NOW })?.type === 'sec_8k_other');
  ok('no institutions entry exists in the catalyst vocabulary',
    !Object.values(CATALYST_TYPES).some((t) => t.family === 'institutions'));
}

console.log('\n=== 23+24. NOTHING IS FABRICATED, EVERYTHING IS TRACEABLE ===');
{
  const c = toCandidate({ type: 'sec_8k_results', publicAt: agoH(1), ref: '0001234567-26-000999' });
  ok('the evidence reference survives', c.ref === '0001234567-26-000999');
  ok('the family survives', c.family === 'catalysts');
  ok('the materiality survives', typeof c.materiality === 'number');
  const b = buildBoard('moving-now', [row({ symbol: 'ABC', changePct: 5, catalyst: c })], { now: NOW });
  ok('every row records WHY it is on the board', typeof b.rows[0].boardReason === 'string' && b.rows[0].boardReason.length > 0);
  ok('every row records its ranking input', typeof b.rows[0].boardScore === 'number');
  ok('the board stamps its version', b.version === BOARDS_VERSION);
  ok('the board stamps when it was built', typeof b.calculatedAt === 'string');
  ok('rejections are recorded with a reason, not silently dropped',
    buildBoard('moving-now', [row({ symbol: 'Q', changePct: 0.1 })], { now: NOW }).rejected[0].reason === 'move-too-small');
  // An unknown 8-K item produces no catalyst rather than a generic one.
  ok('an unmapped 8-K item maps to nothing', ITEM_TO_TYPE['9.99'] === undefined);
  ok('an unknown type yields no candidate', toCandidate({ type: 'made_up', publicAt: agoH(1) }) === null);
}

console.log('\n=== ranking is deterministic and explainable ===');
{
  const rows = [
    row({ symbol: 'AAA', changePct: 3 }),
    row({ symbol: 'BBB', changePct: 3, catalyst: cat('sec_8k_results', 0.5) }),
  ];
  const b = buildBoard('moving-now', rows, { now: NOW });
  ok('an explained move outranks an unexplained one of equal size', b.rows[0].symbol === 'BBB');
  ok('scoring is a pure function', scoreMovingNow(rows[0], { now: NOW }) === scoreMovingNow(rows[0], { now: NOW }));
  ok('divergence scoring weights confidence',
    scoreDivergence({ changePct: -5, consensus: { confidence: 'High', directionValue: 0.6 } })
    > scoreDivergence({ changePct: -5, consensus: { confidence: 'Medium', directionValue: 0.6 } }));
  ok('catalysts-now ranks materiality over reaction',
    scoreCatalystsNow(row({ changePct: 0.1, catalyst: cat('sec_8k_non_reliance', 0.5) }), { now: NOW })
    > scoreCatalystsNow(row({ changePct: 9, catalyst: cat('sec_8k_other', 0.5) }), { now: NOW }));
  ok('an unknown board yields an empty result', buildBoard('nope', rows, { now: NOW }).rows.length === 0);
  ok('all three boards are registered', BOARDS.length === 3);
  ok('age formatting is readable', formatAge(0.25) === '15m' && formatAge(5) === '5h');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
