// PIT SCAN ROWS — the adapter between Consensus and the three boards.
//
// boards.mjs was pure, tested and unreachable: nothing ever fed it rows. These assertions cover the
// adapter that finally does, and the display contract of the compact row — which is mostly a list
// of things the row must NEVER say.
//
// Run: node scripts/verify-scan-rows.mjs [--mutate=<mode>]

import {
  toScanRow, toScanRows, evidenceLine, joinLine, structureTags, levelsToStructure,
  supportingFacts, freshnessLabel, isLiveEnough, servedRow, JOIN_LINE, EVIDENCE_LINE_MAX,
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
      : /import \{ ScanBoard, FeedBanner, BOARD_TABS \}/.test(page));
  ok('…and the Terminal panel uses the same module', /ScanBoardRows/.test(panel));
  ok('the page defines no Row of its own', !/function Row\s*\(/.test(page));
  ok('…and no second board list', !/const BOARDS = \[/.test(page));

  // All three boards, from the live API.
  for (const b of ['moving-now', 'catalysts-now', 'divergence']) {
    ok(`the panel offers the ${b} board`, new RegExp(`'${b}'`).test(rows));
  }
  ok('boards are fetched, never hard-coded', /\/api\/scan-board\?board=/.test(rows));
  ok('the panel ships no literal row data', !/ticker:\s*'[A-Z]{1,5}'/.test(panel));

  // ⚠️ NEVER "LIVE". Realtime is not entitled, so a LIVE branch could only ever be wrong — and a
  // dead branch that renders "LIVE" is one refactor away from rendering it for real.
  ok('the banner has no LIVE state at all',
    mut('livebadge') ? false : !/'LIVE'|>LIVE</.test(rows));
  ok('…nor does the page wrapper', !/'LIVE'|>LIVE</.test(page));
  ok('the banner says exactly what the ticket requires',
    /Last completed session — not live quotes\./.test(rows));
  ok('…and has a delayed variant', /Delayed quotes — not live\./.test(rows));
  ok('there is ONE banner implementation, shared',
    /export function FeedBanner/.test(rows) && !/function FeedBanner/.test(page));

  // ⚠️ "MOVING NOW" MUST NOT IMPLY 9:31.
  const movingBlurb = (rows.match(/label: 'Moving Now',[\s\S]{0,160}/) || [''])[0];
  ok('the Moving Now subtitle does not overpromise a live tape',
    mut('overpromise') ? false : /last completed session/i.test(movingBlurb), movingBlurb.slice(0, 110));
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

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
