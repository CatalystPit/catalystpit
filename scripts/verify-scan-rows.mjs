// PIT SCAN ROWS — the adapter between Consensus and the three boards.
//
// boards.mjs was pure, tested and unreachable: nothing ever fed it rows. These assertions cover the
// adapter that finally does, and the display contract of the compact row — which is mostly a list
// of things the row must NEVER say.
//
// Run: node scripts/verify-scan-rows.mjs [--mutate=<mode>]

import { readFileSync } from 'node:fs';
import {
  toScanRow, toScanRows, evidenceLine, joinLine, structureTags, levelsToStructure,
  supportingFacts, freshnessLabel, boardStatusLabel, FRESHNESS_LABEL, isLiveEnough, aggregateFreshness,
  servedRow, JOIN_LINE, EVIDENCE_LINE_MAX,
  SCAN_DEAD_ZONE_PCT, SELLOFF_PCT,
} from '../src/lib/scan/scan-rows.mjs';
import { buildBoard, THRESHOLDS } from '../src/lib/scan/boards.mjs';
import { lastCompletedSession } from '../src/lib/market/market-session.mjs';

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const NOW = Date.parse('2026-09-20T12:00:00Z');
const ago = (h) => new Date(NOW - h * 3_600_000).toISOString();

/**
 * ⚠️ THE PRICE DATE IS RELATIVE TO THE REAL CLOCK, DELIBERATELY, AND NOT TO `NOW`.
 *
 * NOW above pins EVIDENCE ages, which the adapter takes as a parameter. Price staleness does not
 * work that way: sessionsSince() reads the actual calendar, so a hard-coded asOf ages against it.
 *
 * This fixture used to say '2026-09-19'. Written on the 20th that was the last completed session,
 * so the row came back `eod` / LAST CLOSE and the assertion below meant what its name says. By the
 * 25th the same literal was four sessions old, the row correctly came back `stale` / LAST KNOWN,
 * and the assertion had quietly turned into a staleness test that then failed. Deriving the date
 * keeps it testing the fallback it is named for, forever.
 */
const LAST_SESSION = lastCompletedSession();
/** A price old enough to be stale on any day the suite is run. See STALE_SESSIONS. */
const LONG_AGO = '2020-01-06';

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
    at20dHigh: false, at20dLow: false, at52wHigh: false, at52wLow: false,
    asOf: o.asOf || LAST_SESSION } },
});

L('=== FRESHNESS IS ALWAYS STATED ===');
{
  ok('end-of-day is labelled LAST CLOSE', freshnessLabel('eod') === 'LAST CLOSE');
  ok('delayed is labelled DELAYED', freshnessLabel('delayed') === 'DELAYED');
  // ⚠️ REALTIME USED TO MAP TO null — "nothing to disclose" — which was right only while a live
  // price could not reach a reader. Now that one can, silence about it reads as LAST CLOSE to
  // anyone who falls through, and did: an entitled board rendered the stale copy.
  ok('realtime is disclosed as LIVE', freshnessLabel('realtime') === 'LIVE');
  ok('⚠️ near is LIVE, not DELAYED — it is seconds behind the tape, not a delayed feed',
    freshnessLabel('near') === 'LIVE');
  // ⚠️ A ROW IS NEVER A MIXTURE. This used to assert that the ROW map turned 'mixed' into
  // PARTLY LIVE — one map answering two questions, which is exactly what put a board-level summary
  // word where a price's provenance belongs. A single price has one source; the mixture is a fact
  // about the board and is labelled by the board's own map.
  ok('⚠️ the ROW map has no entry for a mixture at all', !('mixed' in FRESHNESS_LABEL));
  ok('⚠️ and a board that is partly live is REAL-TIME, not half-broken',
    boardStatusLabel('mixed') === 'REAL-TIME');
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

  // ⚠️ A PRICE THAT MISSED SESSIONS IS NOT "LAST CLOSE", and until now nothing asserted it.
  // 9463c3db introduced `stale` freshness and changed this file's subject without changing this
  // file. LAST CLOSE claims the number is the most recent completed session; when it is not, the
  // row has to say the other thing.
  const old = toScanRow(crow({ asOf: LONG_AGO }), null);
  ok('a price that missed sessions is labelled LAST KNOWN, not LAST CLOSE',
    old.display.freshnessLabel === 'LAST KNOWN', old.display.freshnessLabel);
  ok('…it still shows the price rather than hiding it', old.display.last === 1.25);
  ok('…it is not described as live', old.display.live === false);
  // A stale price cannot support a reaction claim, including "no reaction".
  ok('…and no reaction verdict is drawn from it',
    old.display.join === JOIN_LINE.REACTION_UNAVAILABLE, old.display.join);
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
  // ⚠️ WHAT THE DASH ACTUALLY MEANS. This assertion used to pass no price at all and expect a dash,
  // which was right until 9463c3db: a missing price now reads REACTION UNAVAILABLE, because "we
  // cannot measure what the market did" is a different statement from "price and evidence have no
  // relationship". The dash belongs to the second case — evidence on file, a real move, and no
  // directional lean for that move to agree or disagree with — so that is what is asserted now.
  ok('a real move against evidence with no directional lean is a dash, not a verdict',
    joinLine({ setup: 'EVIDENCE_BUILDING', direction: 'UNKNOWN', changePct: 8 })
      === JOIN_LINE.NONE);
  ok('…and the dash is not reached when the evidence DOES lean',
    joinLine({ setup: 'EVIDENCE_BUILDING', direction: 'POSITIVE', changePct: 8 })
      !== JOIN_LINE.NONE);
  // The case the dash used to cover, now stated in its own words.
  ok('⚠️ no price at all is REACTION UNAVAILABLE — we cannot measure, so we do not claim',
    joinLine({ setup: 'EVIDENCE_BUILDING', direction: 'POSITIVE' })
      === JOIN_LINE.REACTION_UNAVAILABLE);
  ok('…and so is a stale price, for the same reason',
    joinLine({ setup: 'EVIDENCE_BUILDING', direction: 'POSITIVE', changePct: 8, stale: true })
      === JOIN_LINE.REACTION_UNAVAILABLE);
  ok('⚠️ but no EVIDENCE outranks both — that answer is about the filing, not the price',
    joinLine({ setup: 'EVIDENCE_BUILDING', direction: 'POSITIVE', hasEvidence: false })
      === JOIN_LINE.NO_EVIDENCE);
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

// ── ONE CLOCK PER ROW ───────────────────────────────────────────────────────
//
// The change% a row prints is the quote's when there is one, while the levels come from the
// Consensus row's daily bars. Those are two different snapshots, and reading the prior-close
// relationship from the levels while printing the quote's move put "BELOW PRIOR CLOSE" beside a
// green +4.2% — one row, two contradictory claims about the same session.
L('\n=== ONE CLOCK: STRUCTURE AND CHANGE% AGREE ===');
{
  // Levels say the close was BELOW its prior close; a fresher quote says the stock is up.
  const staleDown = { abovePrevClose: false, close: 1.25, changePct: -3.1,
    at20dHigh: false, at20dLow: false, at52wHigh: false, at52wLow: false };

  ok('the displayed move decides the prior-close tag',
    mut('twoclocks') ? false : structureTags(staleDown, 4.2).includes('ABOVE PRIOR CLOSE'));
  ok('…and the contradicting stale tag is gone',
    !structureTags(staleDown, 4.2).includes('BELOW PRIOR CLOSE'));
  ok('a down move still reads as below',
    structureTags({ abovePrevClose: true }, -4.2).includes('BELOW PRIOR CLOSE'));
  ok('with no quote the levels flag still answers',
    structureTags(staleDown, null).includes('BELOW PRIOR CLOSE'));
  ok('…and a row with neither claims no direction',
    !JSON.stringify(structureTags({ at20dHigh: true }, null)).includes('PRIOR CLOSE'));

  // The whole row, end to end: the tag, the printed move and the board's own reason all agree.
  const row = toScanRow(crow({ levels: staleDown }), { price: 1.4, changePct: 4.2, freshness: 'eod' });
  ok('the row renders the quote\'s move', row.display.changePct === 4.2);
  ok('…and its structure tag agrees with it',
    mut('twoclocks') ? false : row.display.structure.includes('ABOVE PRIOR CLOSE'));
  ok('…and the structure boards.mjs ranks on is the same label',
    row.structure.label === row.display.structure[0]);

  // boards.mjs quotes that label back in its reason ("52W HIGH on +4.2%"); same snapshot, so the
  // sentence cannot contradict itself.
  const built = buildBoard('moving-now', [row], { now: NOW, limit: 5 });
  const reason = built.rows[0]?.boardReason || '';
  const saysAbove = /ABOVE PRIOR CLOSE/.test(reason);
  ok('the board reason never pairs a stale tag with a fresh move',
    mut('twoclocks') ? false : !/BELOW PRIOR CLOSE/.test(reason), reason);
  ok('…and when it names the tag, the move it names is positive',
    !saysAbove || /on \+?4\.2%/.test(reason), reason);
}

// ── ONE REASON PER ROW ──────────────────────────────────────────────────────
//
// boards.mjs writes a gate trace; the row composes an evidence line. Shipping both unreconciled
// put two different explanations of the same row on screen.
L('\n=== ONE REASON: THE EVIDENCE LINE LEADS ===');
{
  const row = toScanRow(crow(), null);
  const built = buildBoard('catalysts-now', [row], { now: NOW, limit: 5 });
  const served = built.rows.map(servedRow);   // the exact mapping the API serves
  ok('a row is served with a reason', served[0] && typeof served[0].boardReason === 'string');
  ok('…and that reason IS the compact evidence line',
    mut('tworeasons') ? false : served[0].boardReason === served[0].evidence, served[0]?.boardReason);
  ok('…so the row never shows two different explanations',
    served[0].boardReason === served[0].evidence);
  ok('the gate trace is kept, under its own name',
    typeof served[0].qualifiedBy === 'string' && served[0].qualifiedBy.length > 0);
  ok('…and is still the board\'s own wording', served[0].qualifiedBy === built.rows[0].boardReason);

  // A row with no composable evidence line must still explain itself.
  const bare = toScanRow(crow({ families: {} }), { price: 9, changePct: 8.5, freshness: 'eod' });
  const bareBuilt = buildBoard('moving-now', [bare], { now: NOW, limit: 5 });
  const bareServed = bareBuilt.rows.map(servedRow);
  ok('a row with no evidence line falls back to the gate trace',
    bareServed[0] && typeof bareServed[0].boardReason === 'string' && bareServed[0].boardReason.length > 0,
    bareServed[0]?.boardReason);

  // ⚠️ THE JOIN BADGE READS THE SAME % THE ROW PRINTS.
  const moved = toScanRow(crow({ direction: 'POSITIVE', setup: 'FRESH_MATERIAL_CATALYST' }),
    { price: 9, changePct: 6.4, freshness: 'eod' });
  ok('the join describes the displayed move, not a second measurement',
    mut('twoclocks') ? false : moved.display.join === JOIN_LINE.CONFIRMING, moved.display.join);
  const flat = toScanRow(crow({ direction: 'POSITIVE', setup: 'FRESH_MATERIAL_CATALYST' }),
    { price: 9, changePct: 1.1, freshness: 'eod' });
  ok('…and a move inside the dead zone reads as no reaction',
    flat.display.join === JOIN_LINE.NO_REACTION);
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

L('\n=== THE TERMINAL SCAN PANEL ===');
{
  const fs = await import('node:fs');
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const page = read('../src/app/scan/ScanClient.jsx');
  const rows = read('../src/components/scan/ScanBoardRows.jsx');
  const route = read('../src/app/api/scan-board/route.js');
  // The board building moved out of the route into a module both Scan endpoints share, so the
  // entitlement and quote rules are asserted where they now live. `route + payload` keeps the
  // assertions honest wherever the code sits: if either file drops the rule, the test fails.
  const payloadMod = read('../src/lib/scan/board-payload.js');
  const routeSrc = route + payloadMod;
  const shared = read('../src/lib/cp-shared.jsx');
  const panel = read('../src/components/scan/PitScanPanel.jsx');
  const terminal = read('../src/app/terminal/TerminalClient.jsx');

  // ─── BADGE / MUTED-TEXT CONTRAST ──────────────────────────────────────────
  //
  // ⚠️ THESE ASSERTIONS COMPUTE THE RATIO, THEY DO NOT MATCH A HEX. An assertion that pins
  // `#B2BEB4` would pass forever while saying nothing about whether the pill is readable, and
  // would fail the moment someone legitimately retuned the palette. So the suite parses the real
  // token values out of both theme blocks and runs the WCAG relative-luminance formula on them.
  // Retune the greens freely; the floor is what is protected.
  //
  // The floors: 4.5:1 for badge text, because these pills are 8.5–9px and the "large text" 3:1
  // relaxation begins at 18.66px bold — nowhere near. 3:1 for the border, which is a UI boundary
  // under WCAG 1.4.11 rather than text.
  const lum = (hex) => {
    const c = hex.replace('#', '').match(/../g).map((h) => {
      const v = parseInt(h, 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  // Pull a token out of a named theme block, so light and dark are checked independently.
  const themeBlock = (sel) => {
    const i = shared.indexOf(sel);
    return i < 0 ? '' : shared.slice(i, shared.indexOf('}', i));
  };
  const tok = (block, name) => {
    const m = new RegExp(`--cp-${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(block);
    return m && m[1];
  };
  const DARK = themeBlock(':root[data-theme="dark"]{');
  const LIGHT = themeBlock(':root{');
  ok('both theme blocks were found', !!DARK && !!LIGHT);

  for (const [name, block] of [['dark', DARK], ['light', LIGHT]]) {
    const fg = tok(block, 'badgeFg');
    const bd = tok(block, 'badgeBorder');
    const surface = tok(block, 'surface');
    const white = tok(block, 'white');
    ok(`${name}: the badge tokens are defined`,
      mut('nobadgetoken') ? false : !!fg && !!bd, `fg=${fg} border=${bd}`);
    if (!fg || !bd) continue;
    // The pill sits on the card (white) and on the banner (surface); both must clear.
    for (const [bgName, bg] of [['surface', surface], ['card', white]]) {
      const r = ratio(fg, bg);
      ok(`${name}: badge text clears 4.5:1 on ${bgName}`,
        mut('dimbadge') ? false : r >= 4.5, `${fg} on ${bg} = ${r.toFixed(2)}:1`);
    }
    const rb = ratio(bd, surface);
    ok(`${name}: the badge border clears 3:1 and actually draws the pill`,
      mut('fadeborder') ? false : rb >= 3, `${bd} on ${surface} = ${rb.toFixed(2)}:1`);
  }

  // ⚠️ THE BADGE MUST OUT-CONTRAST `muted`, NOT MATCH IT. 8.5px uppercase needs more separation
  // than an 11.5px sentence to read as comfortably. If someone "restores the hierarchy" by pulling
  // badgeFg back down to muted, the pill goes quietly unreadable again — so the inversion is
  // asserted rather than left as a comment.
  {
    const r = ratio(tok(DARK, 'badgeFg'), tok(DARK, 'surface'));
    const m = ratio(tok(DARK, 'muted'), tok(DARK, 'surface'));
    ok('dark: badge text out-contrasts muted body text',
      mut('badgeequalsmuted') ? false : r > m, `badge ${r.toFixed(2)} vs muted ${m.toFixed(2)}`);
  }

  // The 9px row keys (STRUCTURE / EVIDENCE / JOIN) are --cp-dim. Dark mode had them at 4.08:1.
  {
    const d = ratio(tok(DARK, 'dim'), tok(DARK, 'surface'));
    ok('dark: the smallest row labels clear 4.5:1',
      mut('dimlabels') ? false : d >= 4.5, `${tok(DARK, 'dim')} = ${d.toFixed(2)}:1`);
    // …and hierarchy is preserved: dim stays quieter than muted.
    const m = ratio(tok(DARK, 'muted'), tok(DARK, 'surface'));
    ok('dark: dim is still quieter than muted', d < m, `dim ${d.toFixed(2)} vs muted ${m.toFixed(2)}`);
  }

  // ⚠️ LIGHT MODE IS NOT COLLATERAL. A dark-mode fix that dims the light pill is a regression, so
  // the light tokens are asserted at the same floors above, and the banner sentence is checked
  // here: it is --cp-muted at 10.5px and was already comfortable in both themes. It must not get
  // "fixed" into near-white, which is how secondary text stops reading as secondary.
  for (const [name, block] of [['dark', DARK], ['light', LIGHT]]) {
    const r = ratio(tok(block, 'muted'), tok(block, 'surface'));
    ok(`${name}: secondary text stays readable without going bright`,
      r >= 4.5 && r < ratio(tok(block, 'ink'), tok(block, 'surface')), `${r.toFixed(2)}:1`);
  }

  // ONE BADGE, NOT FOUR. The contrast bug existed in triplicate because the pill was hand-rolled
  // at each call site; the fix only holds if they keep sharing the primitive.
  ok('the badge is a shared primitive', /export function Badge/.test(shared));
  ok('…used by the feed banner and the row',
    mut('inlinebadge') ? false : /<Badge>/.test(rows) && /<Badge size="xs">/.test(rows));
  ok('…and by the Terminal panel header', /<Badge dot>/.test(panel));
  ok('…with no hand-rolled pill left behind in the scan surface',
    mut('rollsown') ? false
      : !/border:\s*`1px solid \$\{C\.border2\}`,\s*borderRadius:\s*3/.test(rows + panel));
  // Colour is not a prop — a badge that can be told to be any colour will be told to be an
  // unreadable one.
  ok('the badge does not take a colour prop',
    !/function Badge\(\{[^}]*\b(color|fg|tone)\b/.test(shared));

  // ⚠️ THE PANEL IS THE PRODUCT SURFACE, so it has to be in the DEFAULT layout. The boards had a
  // reserved position and two station presets but were absent from DEFAULT_VISIBLE — reachable only
  // by adding the panel by hand, which is the same as not shipping them.
  const defVisible = terminal.split('\n').find((l) => l.startsWith('const DEFAULT_VISIBLE'));
  ok('the Scan panel is in the Terminal default layout',
    mut('panelhidden') ? false : /'pitscan'/.test(defVisible), String(defVisible).slice(0, 100));
  ok('…and the panel renders the boards', /ScanBoardRows/.test(panel));
  ok('…with a reserved layout position', /pitscan:\s*\{\s*x:/.test(terminal));

  // ⚠️ ONE ROW DESIGN. Two surfaces rendering the same boards must not drift into two answers.
  ok('the page wrapper reuses the shared components, it does not fork them',
    mut('forkedrow') ? false
      : /import \{ ScanBoard, FeedBanner, BOARD_TABS, useScanBoards \}/.test(page));
  // ⚠️ AND IT SHARES THE FETCH, NOT JUST THE COMPONENTS. Stacking three boards used to mean three
  // requests, each re-resolving the entitlement, re-reading the published board and re-fetching the
  // same hundred quotes for three views of the same tickers.
  ok('…including the one request that feeds all three', /useScanBoards\(\)/.test(page));
  ok('…and the Terminal panel uses the same module', /ScanBoardRows/.test(panel));
  ok('the page defines no Row of its own', !/function Row\s*\(/.test(page));
  ok('…and no second board list', !/const BOARDS = \[/.test(page));

  // All three boards, from the live API.
  for (const b of ['moving-now', 'catalysts-now', 'divergence']) {
    ok(`the panel offers the ${b} board`, new RegExp(`'${b}'`).test(rows));
  }
  ok('boards are fetched, never hard-coded', /\/api\/scan-board\?board=/.test(rows));
  ok('the panel ships no literal row data', !/ticker:\s*'[A-Z]{1,5}'/.test(panel));

  // ── ONE PIT SCAN, AND THE DEAD ONE IS GONE ────────────────────────────────
  //
  // ⚠️ THE TERMINAL CARRIED A SECOND IMPLEMENTATION. PitScanBody rendered /api/scan?mode=pit —
  // the old weighted signal engine — and had been unreachable since the panel switched to
  // PitScanPanel: defined, never mounted. Two implementations of one product is how the Terminal
  // and /scan eventually disagree about what is on the board.
  ok('the Terminal defines no second Pit Scan body',
    mut('twoscans') ? false : !/function PitScanBody/.test(terminal));
  // Against the CODE: the note explaining the removal names the old endpoint, and an explanation
  // of what was deleted is not a call to it.
  const terminalCode = terminal.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('…and no longer reads the legacy pit engine',
    mut('twoscans') ? false : !/api\/scan\?mode=pit/.test(terminalCode));
  ok('the panel is rendered from the shared component',
    /def\.id === 'pitscan' \? <PitScanPanel/.test(terminal));

  // ── TICKER SYNC, THROUGH THE TERMINAL'S OWN MECHANISM ─────────────────────
  //
  // ⚠️ onPick REACHED ONLY THE LEGACY TABLES. It was threaded to ScanTable and PulseTape — which
  // render only when the signal engine is live, i.e. never today — while the evidence boards that
  // actually display got nothing. Clicking a ticker on the board did not move the linked chart.
  ok('the Terminal passes its existing link helper to the panel',
    /<PitScanPanel onPick=\{\(s\) => linkSymbol\('pitscan', s\)\}/.test(terminal));
  ok('…and linkSymbol is the Terminal-wide mechanism, not a new one',
    /const linkSymbol = \(sourceId, sym\) => selectSymbol\(sym\)/.test(terminal));
  ok('the panel threads onPick into the boards',
    mut('nosync') ? false : /<ScanBoardRows onPick=\{onPick\}/.test(panel));
  ok('…the wrapper accepts it', /export default function ScanBoardRows\(\{ onPick, onFeed \} = \{\}\)/.test(rows));
  // ⚠️ THE BOARD TAKES ITS DATA AS A PROP AND FETCHES NOTHING. That is what makes a tab switch a
  // local state change rather than another round trip for a dataset the client already has.
  ok('…the board accepts it', /export function ScanBoard\(\{ board, data, loading = false, errorText = null, onRetry, title, onState, onPick \}\)/.test(rows));
  ok('⚠️ …and the board no longer fetches for itself',
    !/fetch\(`\/api\/scan-board\?board=\$\{board\}`/.test(rows));
  ok('…and the row receives it', /<Row [^>]*onPick=\{onPick\}/.test(rows));

  // ⚠️ THE SYMBOL STAYS A REAL LINK. /scan has nowhere to sync to, and middle-click, open-in-new-tab
  // and assistive tech all depend on the href surviving.
  ok('the ticker keeps its href on both surfaces',
    mut('losesLink') ? false : /<a href=\{`\/ticker\/\$\{encodeURIComponent\(r\.ticker\)\}`\}/.test(rows));
  ok('…a plain left click is intercepted only when onPick exists',
    /if \(!onPick\) return;/.test(rows));
  ok('…and a modified click is never hijacked',
    mut('hijacksclick') ? false : /metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey \|\| e\.button !== 0/.test(rows));
  ok('the dedicated page passes no onPick, so its links behave as links',
    mut('pagesync') ? false : !/onPick/.test(page));

  // ── NARROW PANELS SCROLL, THEY DO NOT SHED FIELDS ─────────────────────────
  //
  // A Terminal panel can be dragged to MIN_W (240px). Dropping columns to fit would remove the
  // very fields that explain why a row is on the board.
  ok('the panel gives the cards a floor and scrolls past it',
    mut('dropsfields') ? false : /overflowX: 'auto'/.test(panel) && /minWidth: 300/.test(panel));
  ok('…and the panel body scrolls vertically', /overflow: 'auto', flex: 1/.test(panel));
  // Every field the cards carry must still be rendered by the one Row.
  for (const [label, re] of [
    ['ticker', /r\.ticker/], ['price', /r\.last/], ['move %', /r\.changePct/],
    ['freshness', /r\.freshnessLabel/], ['structure', /r\.structure/], ['evidence', /r\.evidence/],
    ['JOIN', /\{r\.join\}/], ['facts', /r\.facts/],
    ['Chart action', />Chart</], ['Evidence action', />Evidence</],
    ['Watch action', />Watch</], ['Alert action', />Alert</],
  ]) {
    ok(`the card still renders ${label}`, mut('dropsfields') ? false : re.test(rows));
  }

  // ── NO DUPLICATE POLLING ──────────────────────────────────────────────────
  ok('the board poll is cleaned up on unmount',
    mut('leakstimer') ? false : /return \(\) => \{ alive = false; clearInterval\(id\); \};/.test(rows));
  ok('…and the panel clears its own interval too',
    /clearInterval\(id\)/.test(panel));
  ok('one board is fetched at a time, behind tabs', /<ScanBoard board=\{board\}/.test(rows));

  // ── ENTITLEMENT STAYS SERVER-SIDE, AND IS SHARED ──────────────────────────
  // Both surfaces call the same endpoint; neither decides entitlement in the browser.
  ok('the panel makes no entitlement decision of its own',
    mut('clientgate') ? false : !/resolveUserAccess|isRealtime|tier ===/.test(panel));
  ok('…nor does the shared row module', !/resolveUserAccess|isRealtime/.test(rows));

  // ⚠️ THE RULE IS UNCHANGED; ITS IMPLEMENTATION IS NOT. This used to assert that no LIVE branch
  // existed anywhere, which was the correct way to guarantee "never claim live" while realtime was
  // unentitled. The entitlement is on, and the missing branch inverted into the bug: there was no
  // input for which the banner could tell an entitled reader the truth. So LIVE must now exist —
  // and must be reachable ONLY from the freshness the rows actually carry.
  ok('the banner has a real-time state', /'REAL-TIME'/.test(rows));
  ok('⚠️ it is chosen by table lookup on the served freshness, never by a branch on entitlement',
    mut('livebadge') ? false : /const state = FEED_STATE\[freshness\] \|\| FEED_STATE\.eod;/.test(rows));
  ok('⚠️ an unknown or absent freshness still renders the weakest state, not the strongest',
    /FEED_STATE\[freshness\] \|\| FEED_STATE\.eod/.test(rows));
  ok('…and the page wrapper still invents no state of its own', !/'LIVE'|>LIVE</.test(page));
  ok('the last-close copy is unchanged for the readers it still applies to',
    /Last completed session — not live quotes\./.test(rows));
  ok('…and the delayed variant is unchanged too', /Delayed quotes — not live\./.test(rows));
  // ⚠️ THE COPY MUST POINT AT THE ROWS, not gloss over them. REAL-TIME is the friendlier word for
  // the service; it is only honest because the sentence beside it sends the reader to the badge
  // that carries the per-symbol truth, and because that badge still says LAST CLOSE.
  ok('⚠️ a partly-live board says real-time WHERE AVAILABLE and names the row status',
    /Real-time quotes where available/.test(rows) && /Each row shows its price status/.test(rows));
  ok('⚠️ the phrase PARTLY LIVE appears nowhere in the product',
    !/PARTLY LIVE/.test(rows.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')));
  ok('there is ONE banner implementation, shared',
    /export function FeedBanner/.test(rows) && !/function FeedBanner/.test(page));

  // ⚠️ "MOVING NOW" MUST NOT IMPLY 9:31.
  const movingBlurb = (rows.match(/label: 'Moving Now',[\s\S]{0,160}/) || [''])[0];
  // ⚠️ IT MUST NAME NO CLOCK AT ALL. The subtitle used to say "on the last completed session",
  // which was the honest wording while realtime was unentitled and became a false claim the day it
  // was not — printed directly under a banner reading LIVE. A static string cannot know what the
  // feed delivered. The banner and the per-row badges can, so the subtitle says what the board
  // SELECTS and leaves what it is PRICED FROM to the two places that measure it.
  ok('the Moving Now subtitle promises no clock in either direction',
    mut('overpromise') ? false
      : !/last completed session|live|real[- ]time|right now/i.test(movingBlurb), movingBlurb.slice(0, 110));
  ok('…while the board keeps its name', /label: 'Moving Now'/.test(rows));

  ok('the banner reads freshness from the API response',
    mut('hardcodedbanner') ? false : /onState=\{\(j\) => \{ if \(j\?\.freshness\)/.test(page));
  ok('…and the page asserts no freshness of its own',
    !/freshness\s*=\s*['"]realtime['"]/.test(page));

  // ⚠️ ENTITLEMENT. `realtime` may only ever narrow what is served.
  ok('the route resolves entitlement server-side',
    /resolveUserAccess\(\)/.test(routeSrc) && /isRealtime\(tier\) && !beta/.test(routeSrc));
  ok('…defaulting to delayed when it cannot be resolved',
    /let realtime = false;/.test(routeSrc));
  ok('…and passes it to getQuotes rather than assuming',
    /getQuotes\(symbols, \{ realtime \}\)/.test(routeSrc));
  ok('the response is never shared-cacheable',
    mut('sharedcache') ? false : /private, no-store/.test(route) && !/s-maxage/.test(route));
  ok('the page is a client component, so no live value is baked into SSR',
    /^'use client'/.test(page));

  // No fabricated anything.
  ok('the page adds no RVOL column', !/rvol/i.test(page));
  ok('…no fabricated structure tag', !/vwap|opening range|premarket/i.test(page));
  ok('…and no fabricated rows when the API is empty',
    /Nothing currently qualifies/.test(rows) && !/placeholder|sample|demo/i.test(page));

  // An empty Divergence renders as an empty board, with the gate left alone.
  ok('an empty board explains itself instead of disappearing',
    /candidates were considered and did not meet the threshold/.test(rows));
  ok('the page does not loosen any threshold', !/THRESHOLDS|minAbsChangePct|deadZone/i.test(page));

  // ⚠️ EVERY EXISTING TAB SURVIVES. Adding Scan must not quietly drop a room.
  const navLine = shared.split('\n').find((l) => l.includes('const links = [') && l.includes('Terminal'));
  for (const tab of ['Terminal', 'Pit Consensus', 'Feed', 'News', 'Screener', 'Heatmap',
    'Dividends', 'Insiders', 'Politicians', 'Institutions']) {
    ok(`nav still contains ${tab}`, mut('droptab') ? false : navLine.includes(`"${tab}"`));
  }
  ok('…and Scan was added', navLine.includes('"Scan"'));
  ok('the nav route resolves to /scan', /\/\$\{l\.toLowerCase\(\)\}/.test(shared));

  // The row's actions point at surfaces that already exist.
  ok('Evidence links into the existing ticker experience', /\/ticker\/\$\{encodeURIComponent/.test(rows));
  ok('Watch uses the existing watchlist API', /'\/api\/watchlist'/.test(rows));
  ok('Alert uses the existing alerts API and fires no synthetic tick',
    /'\/api\/alerts'/.test(rows) && /type: 'news'/.test(rows) && !/setInterval\([^)]*tick/i.test(rows));
}


L('=== ⚠️ ONE FRESHNESS FOR A BOARD OF MANY PROVENANCES ===');
{
  // ── THE BUG, TWICE, IN OPPOSITE DIRECTIONS ────────────────────────────────
  //
  // A board is a set of prices with a set of provenances, and collapsing that to one word has been
  // wrong twice. First it read row[0], so a single unpriceable Consensus ticker reported the whole
  // live board as LAST CLOSE. The repair mapped any mixture to 'near' — and 'near' was labelled
  // DELAYED, so an entitled reader watching live consolidated prices was told "Delayed quotes —
  // not live" because ONE row of twenty-five had no current print. Both readings were pessimistic
  // about data that was genuinely live, and the second is the one a Pro subscriber reported.
  const agg = aggregateFreshness;

  ok('a wholly live board is live', agg(['realtime', 'realtime', 'realtime']) === 'realtime');
  ok('a wholly end-of-day board is end-of-day', agg(['eod', 'eod']) === 'eod');
  ok('a wholly delayed board is delayed', agg(['delayed', 'delayed']) === 'delayed');

  ok('⚠️ one unpriced row does NOT make a live board delayed',
    agg(['realtime', 'realtime', 'realtime', 'eod']) !== 'delayed');
  ok('⚠️ nor does it make it stale, which was the bug before that',
    agg(['realtime', 'realtime', 'realtime', 'eod']) !== 'eod');
  ok('it is reported as the mixture it is',
    agg(['realtime', 'realtime', 'realtime', 'eod']) === 'mixed');
  ok('…and a mixture still reports the market-data path as real-time',
    boardStatusLabel(agg(['realtime', 'eod'])) === 'REAL-TIME');

  ok('⚠️ a live board is never labelled DELAYED, at any mixture of live flavours',
    ['realtime', 'near'].every((a) => ['realtime', 'near'].every((b) =>
      boardStatusLabel(agg([a, b])) === 'REAL-TIME')));
  ok('realtime mixed with near is the weaker of the two live readings',
    agg(['realtime', 'near']) === 'near');
  ok('⚠️ near is never minted for a mixture — it is a provider capability, not a summary',
    agg(['realtime', 'eod']) !== 'near' && agg(['eod', 'stale']) !== 'near');

  ok('nothing live, and one row delayed, is delayed', agg(['delayed', 'eod']) === 'delayed');
  ok('nothing live and nothing delayed is end-of-day', agg(['eod', 'stale']) === 'eod');
  ok('an empty board has no freshness to claim', agg([]) === null && agg(null) === null);
  ok('rows without a freshness are ignored rather than counted',
    agg(['realtime', null, undefined, '']) === 'realtime');
  ok('⚠️ an absent freshness still labels as the weakest, never as real-time',
    boardStatusLabel(agg([])) === 'LAST CLOSE' && freshnessLabel(agg([])) === 'LAST CLOSE');
}

L('=== ⚠️ AN ENTITLED BOARD IS NEVER LESS COMPLETE THAN A FREE ONE ===');
{
  // ⚠️ THE SECOND HALF OF THE SAME BUG. The realtime path built its quote map from the market-wide
  // snapshot alone, and the snapshot is the eligible universe filtered to symbols with a CURRENT
  // print. A Consensus ticker that is an ADR, a fund, or simply has not traded yet this morning is
  // absent from it — so it reached a Pro reader with NO price, while a signed-out reader got the
  // completed-session close for the same ticker. Entitlement narrowing what a reader sees is the
  // inverse of what an entitlement is for, and it is also what produced the mixture above.
  const payload = readFileSync(new URL('../src/lib/scan/board-payload.js', import.meta.url), 'utf8');

  ok('⚠️ symbols the snapshot does not cover are filled from the ordinary quote path',
    mut('nogapfill') ? false
      : /const missing = symbols\.filter\(\(s\) => !quotes\[s\]\);/.test(payload)
        && /getQuotes\(missing, \{ realtime \}\)/.test(payload));
  ok('…and the fill never overwrites a live snapshot price',
    /if \(!quotes\[sym\]\) quotes\[sym\] = q;/.test(payload));
  ok('a failed fill leaves a gap rather than emptying the board',
    /catch \{ \/\* a gap stays a gap/.test(payload));
  ok('the board asks the shared aggregate rather than counting a Set itself',
    mut('inlineagg') ? false
      : /aggregateFreshness\(\(built\.rows \|\| \[\]\)/.test(payload)
        && !/servedFreshness\.size === 1/.test(payload));
  // ⚠️ AND IT LABELS THAT VALUE WITH THE BOARD'S MAP, NOT THE ROW'S. The two maps answer different
  // questions and the payload's field is the board's answer: running it through the row map would
  // report a mixed board as LAST CLOSE — the older of the two bugs, arrived at from the other side.
  ok('⚠️ the board status is labelled by the board map',
    payload.includes('freshnessLabel: boardStatusLabel(freshness)'));
  ok('⚠️ …and the row map is not used for it', !/freshnessLabel\(freshness\)/.test(payload));
  ok('⚠️ entitlement is still resolved server-side, before any price is fetched',
    /resolveUserAccess\(\)/.test(payload) && /isRealtime\(tier\) && !beta/.test(payload));
  ok('⚠️ and the snapshot is still read ONLY for an entitled viewer',
    /if \(realtime\) \{[\s\S]{0,400}movementSnapshot\(db, sql\)/.test(payload));
  ok('the entitlement itself is never put in the response',
    !/realtime:\s*realtime/.test(payload) && !/tier:/.test(payload));
}


L('=== ⚠️ THE BOARD DESCRIBES THE SERVICE; A ROW DESCRIBES ITS PRICE ===');
{
  // ── WHY THESE ARE TWO MAPS ────────────────────────────────────────────────
  //
  // They were one, and the one answer had to serve both questions. "Some of these prices are live
  // and some are not" is true of a board and is the correct thing for a row NEVER to say — so the
  // shared map produced PARTLY LIVE at the top of a working real-time product, which reads as a
  // degraded service rather than as a market in which one ADR has not printed yet.
  //
  // ⚠️ AND THE SPLIT IS ONLY HONEST BECAUSE THE ROWS DID NOT MOVE. Every assertion below that says
  // a row keeps its word is load-bearing: the friendlier board status is paid for by the badge
  // beside each price still telling the truth about that price.

  ok('a live print is LIVE on its row', freshnessLabel('realtime') === 'LIVE');
  ok('a near-real-time print is LIVE too', freshnessLabel('near') === 'LIVE');
  ok('⚠️ a completed-session close still says LAST CLOSE on its row', freshnessLabel('eod') === 'LAST CLOSE');
  ok('⚠️ a genuinely old price still says LAST KNOWN', freshnessLabel('stale') === 'LAST KNOWN');
  ok('⚠️ a row with no price carries no badge, rather than a reassuring one',
    freshnessLabel('unpriced') === null);
  ok('a delayed print still says DELAYED on its row', freshnessLabel('delayed') === 'DELAYED');

  ok('the board calls any live-bearing path REAL-TIME',
    ['realtime', 'near', 'mixed'].every((f) => boardStatusLabel(f) === 'REAL-TIME'));
  ok('⚠️ FREE STAYS DELAYED — the word a free reader sees is unchanged',
    boardStatusLabel('delayed') === 'DELAYED' && freshnessLabel('delayed') === 'DELAYED');
  ok('⚠️ a board with no live price anywhere is NOT called real-time',
    boardStatusLabel('eod') === 'LAST CLOSE' && boardStatusLabel(aggregateFreshness(['eod', 'stale'])) === 'LAST CLOSE');
  ok('⚠️ nor is an unknown provenance', boardStatusLabel(undefined) === 'LAST CLOSE' && boardStatusLabel('nonsense') === 'LAST CLOSE');

  // ⚠️ NOTHING PROMOTES A PRICE. The rule this whole change rests on: the board's word may soften,
  // a row's may not, and no row may be relabelled by the board it is on.
  ok('⚠️ no freshness renders a row MORE live than the board',
    ['eod', 'stale', 'delayed'].every((f) => freshnessLabel(f) !== 'LIVE'));
  ok('⚠️ and the served row still carries the freshness it was given',
    (() => {
      const r = servedRow(toScanRows([crow({ ticker: 'ZZZ' })], {})[0]);
      return r.freshnessLabel === 'LAST CLOSE' && r.live === false;
    })());
}


L('=== ⚠️ THREE VIEWS OF ONE DATASET, LOADED ONCE ===');
{
  const payload = readFileSync(new URL('../src/lib/scan/board-payload.js', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../src/app/api/scan-board/route.js', import.meta.url), 'utf8');

  // ⚠️ THE REFACTOR'S WHOLE SAFETY ARGUMENT. All three boards must be built by the SAME function
  // from the SAME context — not by a faster parallel implementation that could rank differently.
  ok('the shared half is loaded by one function', /export async function loadScanContext\(\)/.test(payload));
  ok('a single board is that context plus one build',
    /export async function buildScanBoardPayload[\s\S]{0,260}await loadScanContext\(\)[\s\S]{0,80}buildOneBoard\(ctx/.test(payload));
  ok('⚠️ all three are the SAME build on the SAME context',
    /export async function buildAllScanBoards[\s\S]{0,420}await loadScanContext\(\)[\s\S]{0,200}BOARDS\.map\(\(b\) => buildOneBoard\(ctx, b, limit\)\)/.test(payload));
  ok('⚠️ there is exactly one board builder, not a fast path and a slow one',
    (payload.match(/export async function buildOneBoard/g) || []).length === 1);
  ok('the entitlement is resolved once, in the shared half',
    (payload.match(/resolveUserAccess\(\)/g) || []).length === 1);
  // ⚠️ THE CALL, NOT THE IMPORT. Counting every mention found two and reported a second read that
  // does not exist — a false alarm is how an assertion gets loosened until it stops meaning anything.
  ok('the published board is read once, in the shared half',
    (payload.match(/await readPublishedBoard\(\)/g) || []).length === 1);
  ok('…and the quote fetch lives there too, not per board',
    payload.indexOf('getQuotes(symbols') > payload.indexOf('export async function loadScanContext')
    && payload.indexOf('getQuotes(symbols') < payload.indexOf('export async function buildOneBoard'));

  ok('the route can serve all three in one request', /board === 'all'/.test(route) && /buildAllScanBoards/.test(route));
  ok('…and its failure keeps the shape the caller asked for', /boards: Object\.fromEntries/.test(route));
  ok('⚠️ the single-board form still exists for the page that stacks them',
    /buildScanBoardPayload\(\{ board, limit \}\)/.test(route));
  ok('timing ships with the answer rather than being added when something is slow',
    /Server-Timing/.test(route));
}

L('=== ⚠️ A REQUEST THAT NEVER ENDS IS A BUG, NOT A SLOW REQUEST ===');
{
  const rows = readFileSync(new URL('../src/components/scan/ScanBoardRows.jsx', import.meta.url), 'utf8');

  // ⚠️ THE STUCK-LOADING BUG, IN ONE LINE. `r.ok ? await r.json() : null` then setState(j): a 503
  // or a function killed at its own maxDuration set state back to NULL, and null IS the loading
  // state. "Loading Pit Scan…" then survived every subsequent poll.
  ok('⚠️ a failed response never sets the data back to null',
    !/setBoards\(null\)/.test(rows));
  ok('⚠️ a non-JSON body is a failure, not a crash — a killed function answers with HTML',
    /r\.json\(\)\.catch\(\(\) => null\)/.test(rows));
  ok('⚠️ every request is on a clock, so loading always ends',
    /AbortSignal\.timeout\(REQUEST_TIMEOUT_MS\)/.test(rows));
  ok('…and a timeout is reported as one rather than as a blank board', /TimeoutError/.test(rows));
  ok('⚠️ loading is the ONLY state with neither data nor an error',
    /loading: boards === null && error === null/.test(rows));
  ok('⚠️ a failed REFRESH keeps the data that is already on screen',
    /if \(!isRefresh\) setError/.test(rows) && /setStale\(true\)/.test(rows));
  ok('…and says so rather than pretending the data is current',
    /Showing the last successful load/.test(rows));
  ok('an error with no data behind it is retryable', /onRetry/.test(rows) && /Try again/.test(rows));
  ok('⚠️ a superseded response cannot land on the state that replaced it', /if \(!alive\) return;/.test(rows));
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
