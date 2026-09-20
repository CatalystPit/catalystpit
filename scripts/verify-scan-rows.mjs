// PIT SCAN ROWS — the adapter between Consensus and the three boards.
//
// boards.mjs was pure, tested and unreachable: nothing ever fed it rows. These assertions cover the
// adapter that finally does, and the display contract of the compact row — which is mostly a list
// of things the row must NEVER say.
//
// Run: node scripts/verify-scan-rows.mjs [--mutate=<mode>]

import {
  toScanRow, toScanRows, evidenceLine, joinLine, structureTags, levelsToStructure,
  supportingFacts, freshnessLabel, isLiveEnough, JOIN_LINE, EVIDENCE_LINE_MAX,
  SCAN_DEAD_ZONE_PCT, SELLOFF_PCT,
} from '../src/lib/scan/scan-rows.mjs';
import { buildBoard, THRESHOLDS } from '../src/lib/scan/boards.mjs';

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const NOW = Date.parse('2026-09-20T12:00:00Z');
const ago = (h) => new Date(NOW - h * 3_600_000).toISOString();

// A materialized Consensus row, shaped exactly as the board stores it.
const crow = (o = {}) => ({
  ticker: o.ticker || 'AAA',
  setup: { setup: o.setup || 'CROSS_SOURCE_CONFLICT', label: 'Cross-source conflict',
    direction: o.direction || 'MIXED', marketState: 'NO_REACTION' },
  canonical: { version: 'consensus_v2_synthesis', confidence: 'High' },
  consensusV1: o.consensusV1 !== undefined ? o.consensusV1 : {
    version: 'consensus_v1', activeCount: 3, confidence: 'High', directionValue: o.dv ?? 0.6 },
  evidence_layer: { L: 0.5, A: 0.5, n: 3 },
  reaction_layer: o.reaction !== undefined ? o.reaction
    : { abs: -1.2, rel: -1.1, meaningful: false, reason: 'below-absolute-floor' },
  join_layer: { state: o.joinState || 'EVIDENCE_BUILDING' },
  families: o.families !== undefined ? o.families : {
    catalyst: [{ family: 'catalyst', familyLabel: 'CATALYST', direction: 'negative',
      headline: 'Delisting / listing-standard notice', publicTime: ago(12), publicAgo: '12 hours ago',
      materiality: 0.95, quality: 0.95, dates: 'Event dated Sep 15 · filed Sep 18', url: 'https://sec.gov/x' }],
    insider: [{ family: 'insider', familyLabel: 'INSIDERS', direction: 'positive',
      headline: 'Chief Executive Officer open-market purchase of $186K', publicTime: ago(40),
      context: '4 open-market purchases in 5 days', materiality: 0.8, quality: 0.95 }],
  },
  market: { levels: o.levels !== undefined ? o.levels : {
    close: 1.25, prevClose: 1.29, changePct: -3.1, abovePrevClose: false, sessions: 264,
    at20dHigh: false, at20dLow: false, at52wHigh: false, at52wLow: false, asOf: '2026-09-19' } },
});

L('=== FRESHNESS IS ALWAYS STATED ===');
{
  ok('end-of-day is labelled LAST CLOSE', freshnessLabel('eod') === 'LAST CLOSE');
  ok('delayed is labelled DELAYED', freshnessLabel('delayed') === 'DELAYED');
  ok('realtime needs no disclosure', freshnessLabel('realtime') === null);
  ok('an unknown freshness is treated as the weakest, not the strongest',
    mut('assumelive') ? false : freshnessLabel(undefined) === 'LAST CLOSE');
  ok('only realtime or near counts as live',
    isLiveEnough('realtime') && isLiveEnough('near')
    && !isLiveEnough('eod') && !isLiveEnough('delayed'));

  // ⚠️ REALTIME IS NOT ENTITLED. Every row must carry its own freshness, because the move shown is
  // the last completed session's and a board called "Moving Now" must not imply otherwise.
  const r = toScanRow(crow(), null);
  ok('a row built without a quote is labelled LAST CLOSE',
    mut('hidefreshness') ? false : r.display.freshnessLabel === 'LAST CLOSE');
  ok('…and is not described as live', r.display.live === false);
  const live = toScanRow(crow(), { price: 10, changePct: 4, freshness: 'realtime' });
  ok('an entitled realtime quote is carried through', live.display.live === true);
  ok('…and the row shows that quote, not the stored close', live.display.last === 10);
}

L('\n=== THE ROW NEVER SAYS WHAT IT MUST NOT SAY ===');
{
  const r = toScanRow(crow(), null);
  const text = JSON.stringify(r.display);
  // Each of these is a specific thing the product has refused before and must keep refusing.
  for (const [what, re] of [
    ['a score', /"score"|score:/i],
    ['an alignment percentage', /alignment/i],
    ['a confidence word', /\b(High|Medium|Low) confidence\b|"confidence"/],
    ['a Bullish or Bearish headline', /bullish|bearish/i],
    ['13F occupancy', /\d+\s+funds\b/i],
    ['RVOL', /rvol|relative volume/i],
  ]) {
    ok(`the row carries no ${what}`, mut('leakforbidden') ? false : !re.test(text), text.slice(0, 90));
  }
  // The boards must not have acquired a volume threshold either — there is no consolidated volume
  // on this feed, so any volume gate would be unmeasurable rather than merely unmet.
  ok('no board threshold mentions volume', !/volume|rvol/i.test(JSON.stringify(THRESHOLDS)));
}

L('\n=== THE EVIDENCE LINE ===');
{
  const conflict = evidenceLine(crow());
  ok('a conflict reads as two sides',
    /vs/.test(conflict) && /Delisting/.test(conflict), conflict);
  ok('…and stays within the line budget', conflict.length <= EVIDENCE_LINE_MAX, String(conflict.length));

  // ⚠️ NO FAMILY SOUP. Three clauses is a list, not a reason.
  ok('the line never chains three clauses',
    mut('familysoup') ? false : (conflict.match(/·/g) || []).length <= 1, conflict);

  const unusual = evidenceLine(crow({ setup: 'UNUSUAL_INSIDER_ACTIVITY' }));
  ok('unusual insider activity leads with the act and its rarity',
    /purchase/i.test(unusual) && /5 days/.test(unusual), unusual);

  const fresh = evidenceLine(crow({ setup: 'FRESH_MATERIAL_CATALYST' }));
  ok('a fresh catalyst leads with the filing', /Delisting/.test(fresh), fresh);

  ok('a row with no families has no evidence line', evidenceLine(crow({ families: {} })) === null);
}

L('\n=== THE JOIN DESCRIBES THE MOVE THE ROW SHOWS ===');
{
  // AAOI shipped printing "+7.3%" beside "NO REACTION" because the join read the evidence-anchored
  // reaction while the row displayed the session move. One line, one measurement.
  ok('a move inside the dead zone is NO REACTION',
    joinLine({ setup: 'CROSS_SOURCE_ALIGNMENT', direction: 'POSITIVE', changePct: 2.0 })
      === JOIN_LINE.NO_REACTION);
  ok('…and +0.8% certainly is',
    mut('noiseisreaction') ? false
      : joinLine({ setup: 'CROSS_SOURCE_ALIGNMENT', direction: 'POSITIVE', changePct: 0.8 })
        === JOIN_LINE.NO_REACTION);
  ok('the dead zone is at least 3.5%', SCAN_DEAD_ZONE_PCT >= 3.5);

  ok('a big move agreeing with positive evidence is CONFIRMING',
    joinLine({ setup: 'CROSS_SOURCE_ALIGNMENT', direction: 'POSITIVE', changePct: 7 })
      === JOIN_LINE.CONFIRMING);
  ok('a big move against positive evidence is DIVERGING',
    joinLine({ setup: 'CROSS_SOURCE_ALIGNMENT', direction: 'POSITIVE', changePct: -4 })
      === JOIN_LINE.DIVERGING);
  ok('a hard down move earns its own word',
    joinLine({ setup: 'CROSS_SOURCE_ALIGNMENT', direction: 'POSITIVE', changePct: -9 })
      === JOIN_LINE.SELLING_OFF);
  ok('the selloff threshold is a real move', SELLOFF_PCT <= -5);

  // ⚠️ A CONFLICT IS NEVER CONFIRMED BY PRICE.
  for (const dir of ['POSITIVE', 'NEGATIVE', 'MIXED']) {
    ok(`a cross-source conflict moving ${dir === 'NEGATIVE' ? 'down' : 'up'} is never CONFIRMING`,
      mut('conflictconfirms') ? false
        : joinLine({ setup: 'CROSS_SOURCE_CONFLICT', direction: dir, changePct: 8 })
          !== JOIN_LINE.CONFIRMING);
  }
  ok('…it reads CONFLICT + MOVING',
    joinLine({ setup: 'CROSS_SOURCE_CONFLICT', direction: 'MIXED', changePct: 8 })
      === JOIN_LINE.CONFLICT_MOVING);
  ok('a MIXED reading is never confirmed either',
    joinLine({ setup: 'CROSS_SOURCE_ALIGNMENT', direction: 'MIXED', changePct: 8 })
      !== JOIN_LINE.CONFIRMING);
  ok('no move and no reaction is a dash, not a verdict',
    joinLine({ setup: 'EVIDENCE_BUILDING', direction: 'POSITIVE' }) === JOIN_LINE.NONE);
}

L('\n=== STRUCTURE IS DAILY-ONLY, AND HONEST ABOUT IT ===');
{
  const lv = { abovePrevClose: true, at20dHigh: true, at52wHigh: false, at20dLow: false, at52wLow: false };
  ok('daily tags are produced', structureTags(lv).includes('20D HIGH'));
  ok('…including the prior-close relationship', structureTags(lv).includes('ABOVE PRIOR CLOSE'));
  ok('no levels means no tags', structureTags(null).length === 0);
  ok('a 52-week tag outranks a 20-day one',
    structureTags({ at52wHigh: true, at20dHigh: true })[0] === '52W HIGH');

  // ⚠️ NOTHING INTRADAY. These need bars that do not exist in this database.
  const tags = JSON.stringify(structureTags({ at52wHigh: true, abovePrevClose: true }));
  for (const banned of ['vwap', 'opening range', 'premarket', 'session high', 'rvol']) {
    ok(`structure never claims ${banned}`, !new RegExp(banned, 'i').test(tags));
  }

  // ⚠️ THE 90-MINUTE TRAP. boards.mjs ages a structure signal against 90 minutes, and a daily
  // level's asOf is a DATE — a real timestamp would make every row silently 'structure-stale'.
  const st = levelsToStructure(lv);
  ok('a daily level asserts no intraday clock',
    mut('faketimestamp') ? false : st.at === null, JSON.stringify(st));
  ok('no tags means no structure object', levelsToStructure({}) === null);
}

L('\n=== THE ADAPTER FEEDS THE BOARDS CORRECTLY ===');
{
  const r = toScanRow(crow(), null);
  ok('the board key is the symbol', r.symbol === 'AAA');
  ok('last falls back to the stored daily close', r.last === 1.25);
  ok('…and so does the change', r.changePct === -3.1);

  // ⚠️ consensusV1, NOT canonical. The divergence gate requires version 'consensus_v1' and refuses
  // the v2 synthesis object — measured, passing `canonical` rejected all 28 live rows.
  ok('the divergence gate receives the v1 consensus object',
    mut('wrongconsensus') ? false : r.consensus?.version === 'consensus_v1', String(r.consensus?.version));
  ok('…carrying the four fields the gate reads',
    ['version', 'activeCount', 'confidence', 'directionValue'].every((k) => r.consensus[k] !== undefined));
  ok('a row with no v1 object passes null rather than a guess',
    toScanRow(crow({ consensusV1: null }), null).consensus === null);

  ok('the catalyst is built from the fact block',
    r.catalyst?.materiality === 0.95 && r.catalyst.publicAt === ago(12));
  ok('a row with no catalyst block passes null',
    toScanRow(crow({ families: {} }), null).catalyst === null);
  ok('a row without a ticker is dropped, not rendered blank', toScanRow({}, null) === null);

  // End to end through the real board builder.
  const built = buildBoard('catalysts-now', [r], { now: NOW });
  ok('a fresh material catalyst reaches the evidence board', built.rows.length === 1, JSON.stringify(built.rejected));
  ok('…and carries the board\'s own reason', typeof built.rows[0].boardReason === 'string');

  // A flat name with unusual evidence belongs on the evidence board, never at the top of Moving Now.
  const flat = toScanRow(crow({ setup: 'UNUSUAL_INSIDER_ACTIVITY',
    levels: { close: 18.72, prevClose: 18.66, changePct: 0.3, abovePrevClose: true, sessions: 300 } }), null);
  const moving = buildBoard('moving-now', [flat], { now: NOW });
  ok('a flat unusual-insider name is NOT on Moving Now',
    mut('flatmoves') ? false : moving.rows.length === 0, JSON.stringify(moving.rejected));
  ok('…and the rejection says why', moving.rejected[0]?.reason === 'move-too-small');
  const evidence = buildBoard('catalysts-now', [flat], { now: NOW });
  ok('…while it still reaches the evidence board', evidence.rows.length === 1);

  // The catalyst window the ticket asks for.
  ok('catalysts are current for 72 hours', THRESHOLDS.catalystsNow.maxAgeHours === 72);
  const stale = toScanRow(crow({ families: { catalyst: [{ family: 'catalyst', familyLabel: 'CATALYST',
    direction: 'negative', headline: 'Old filing', publicTime: ago(100), materiality: 0.95 }] } }), null);
  ok('a filing public 100 hours ago is stale',
    buildBoard('catalysts-now', [stale], { now: NOW }).rejected[0]?.reason === 'stale');
}

L('\n=== SUPPORTING FACTS COME FROM THE CARD ===');
{
  const facts = supportingFacts(crow());
  ok('at most two facts are carried', facts.length <= 2);
  ok('they are lines the Consensus card already renders',
    facts.some((f) => /filed Sep 18|open-market purchases/.test(f)), facts.join(' | '));
  ok('a row with nothing to add carries none', supportingFacts(crow({ families: {} })).length === 0);
}

L('\n=== MAPPING A WHOLE BOARD ===');
{
  const rows = toScanRows([crow({ ticker: 'AAA' }), crow({ ticker: 'BBB' }), {}],
    { AAA: { price: 5, changePct: 6, freshness: 'eod' } });
  ok('rows without a ticker are dropped', rows.length === 2);
  ok('a quote is matched by upper-case ticker', rows[0].last === 5);
  ok('…and a ticker with no quote still renders from stored levels', rows[1].last === 1.25);
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
