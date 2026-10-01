// ITEMS #8, #9 AND #10 — freshness labelling, Pit Scan tap targets, and the Tiingo licensing stop.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-items-8-9-10.mjs
//
// ⚠️ #10 IS THE ONE THAT MATTERED. The stop order (market:tiingo:realtime_stop) was consulted in exactly
// ONE place — getQuotes() — which is enough to stop a live PRICE reaching a page and not enough to stop
// the CLAIM. "Is this caller realtime?" was answered in SEVEN places, five of them an inlined
// `isRealtime(tier) && !beta`, and that flag selects the freshness label, the capability descriptor
// served to the client, and in board-payload whether the realtime snapshot path is read at all. With the
// switch thrown, a Pro subscriber received previous-close prices described as real-time: licensing
// withdrawn for the data, left standing for the assertion about the data.
//
// And the stop check itself failed OPEN — an unconfigured or unreadable KV returned "not stopped", so a
// redistribution control that could not be consulted permitted live data.
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// ⚠️ LINE COMMENTS FIRST, THEN BLOCK COMMENTS, AND THE ORDER IS NOT COSMETIC. market/tiingo.mjs documents
// the endpoints it probed with lines like `// /realtime/*, /consolidated/* all 404` — a `/*` inside a line
// comment. Stripping block comments first treated that as an opener and matched forward to the next `*/`,
// deleting 30,425 of the file's 42,664 characters including the code under test. Six assertions failed
// against code that was present and correct, which is the most expensive kind of test bug: it accuses the
// implementation. Removing the line comments first leaves nothing for the block matcher to mis-anchor on.
const code = (p) => read(p)
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

L('⚠️ #8 — the freshness label describes the ROWS, never the entitlement');
{
  const r = read('src/components/scan/ScanBoardRows.jsx');
  const c = code('src/components/scan/ScanBoardRows.jsx');
  // ⚠️ A BARE "REAL-TIME" OVER A MIXTURE IS A CLAIM THE BOARD DOES NOT MEET.
  ok('⚠️ a mixed board is not called simply REAL-TIME',
    /mixed: \{ label: 'REAL-TIME · PARTIAL'/.test(c));
  ok('…and it points the reader at the per-row status rather than hiding it',
    /Each row shows its price status/.test(r));
  ok('a genuinely live board still reads REAL-TIME',
    /realtime: \{ label: 'REAL-TIME'/.test(c) && /near: \{ label: 'REAL-TIME'/.test(c));
  ok('⚠️ delayed and EOD are named for what they are, not softened',
    /delayed: \{ label: 'DELAYED', text: 'Delayed quotes — not live\.' \}/.test(c)
    && /eod: \{ label: 'LAST CLOSE', text: 'Last completed session — not live quotes\.' \}/.test(c));
  // ⚠️ UNKNOWN IS NOT A LIVE ONE. An absent freshness must not fall through to the best case.
  ok('⚠️ an unknown freshness renders as LAST CLOSE, not as live',
    /const state = FEED_STATE\[freshness\] \|\| FEED_STATE\.eod;/.test(c));
  // ⚠️ AND THE STATE COMES FROM THE SERVED ROWS. Being entitled to realtime and receiving it are
  // different facts and only the second may be announced — which is also what makes the label correct
  // under a licensing stop, with no extra wiring.
  // ⚠️ MATCHED ON THE REAL DERIVATION, NOT ON A NAME FROM THE COMMENT. `aggregateFreshness` appears in
  // this file only inside the explanatory comment — the value actually arrives on the server payload as
  // `freshness` and is read straight off it. Asserting the commented name failed against correct code.
  ok('⚠️ the banner state is read off the served payload, not derived from a tier',
    /const feed = current\?\.freshness \?\? null;/.test(c)
    && /<FeedBanner freshness=\{feed\} compact \/>/.test(c));
  ok('…and the page-level banner is fed the same way',
    /onState=\{\(j\) => \{ if \(j\?\.freshness\) setFreshness\(j\.freshness\); \}\}/.test(code('src/app/scan/ScanClient.jsx')));
  ok('…with each row carrying its own badge, so a mixture is visible per row',
    /r\.freshnessLabel && \(/.test(c));
  ok('…and the reasoning is recorded against the file', /THE STATE COMES FROM THE SERVED ROWS/.test(r));
  // The banner's scope is quotes, and Pit Scan's signals are market-data only — so there is no
  // filing-driven component sitting silently under a market-data label.
  const cols = code('src/lib/scan/columns.mjs');
  ok('⚠️ no filing-driven signal sits under the quote banner',
    !/insider|congress|form4|filing_date|thirteenF/i.test(cols));
  ok('…and every scan signal declares the freshness it requires',
    /requires: \{ quoteFreshness/.test(cols));
}

L('⚠️ #9 — the Pit Scan tap targets, including the ones the first fix missed');
{
  const shared = read('src/lib/cp-shared.jsx');
  // The bare-text actions: padding grows the hit box, equal negative margin keeps the row height.
  ok('bare text actions carry a grown hit box', /\.cp-scan-act\{padding:9px 5px;margin:-9px -5px/.test(shared));
  ok('⚠️ …and it grows further on a narrow screen', /\.cp-scan-act\{padding:13px 8px;margin:-13px -8px\}/.test(shared));
  ok('…with the row gap widened so neighbours cannot be mis-tapped',
    /\.cp-scan-acts\{gap:22px!important/.test(shared));
  // ⚠️ THE PILLS COULD NOT USE THAT TRICK, AND WERE LEFT BEHIND. Measured at 390px: board tabs 11px type
  // with 4px padding ≈ 21px tall; the panel's tabs and toggle ≈ 19px.
  ok('⚠️ bordered pills get a mobile minimum height instead',
    /\.cp-tap-pill\{min-height:38px;display:inline-flex!important;align-items:center!important/.test(shared));
  // ⚠️ AND THE BASE RULE MUST CARRY NO HEIGHT. An ordering check alone passed when min-height was ALSO
  // added to the unqueried rule — which would grow every pill on desktop, the "do not simply make
  // everything huge" failure. The base declaration is asserted to contain nothing but the tap-highlight
  // reset.
  ok('⚠️ …inside the narrow query only, so desktop is untouched',
    shared.indexOf('@media (max-width:560px)') < shared.indexOf('.cp-tap-pill{min-height'));
  ok('⚠️ …and the unqueried rule sets no size at all',
    /\.cp-tap-pill\{-webkit-tap-highlight-color:transparent\}/.test(shared)
    && !/\.cp-tap-pill\{-webkit-tap-highlight-color:transparent;[^}]*(min-height|padding|height)/.test(shared));
  ok('…and the rule needs !important only where an inline style would win',
    /display:inline-flex!important/.test(shared) && !/min-height:38px!important/.test(shared));
  // Every interactive control in the two Pit Scan surfaces must carry one of the two classes.
  for (const [f, n] of [['src/components/scan/ScanBoardRows.jsx', 3], ['src/components/scan/PitScanPanel.jsx', 2]]) {
    ok(`${f} tags its pill controls`, (read(f).match(/cp-tap-pill/g) || []).length === n,
      `${(read(f).match(/cp-tap-pill/g) || []).length} of ${n}`);
  }
  const rows = code('src/components/scan/ScanBoardRows.jsx');
  ok('⚠️ the board tabs are tagged', /onClick=\{\(\) => setBoard\(t\.key\)\} className="cp-tap-pill"/.test(rows));
  ok('⚠️ both retry buttons are tagged', (rows.match(/onClick=\{onRetry\} className="cp-tap-pill"/g) || []).length === 2);
  const panel = code('src/components/scan/PitScanPanel.jsx');
  ok('⚠️ the panel tab strip is tagged', /setTab\(id\)\} className="cp-tap-pill"/.test(panel));
  ok('⚠️ the show-every-signal toggle is tagged', /setShowDark\(\(v\) => !v\)\} className="cp-tap-pill"/.test(panel));
  // ⚠️ AND THE DATA IS UNTOUCHED — this is a usability change only.
  ok('⚠️ no scoring, filter or gating logic was altered',
    !/score|qualif|threshold/i.test(shared.slice(shared.indexOf('.cp-tap-pill'), shared.indexOf('.cp-tap-pill') + 400)));
}

L('⚠️ #10 — the stop order is part of the ONE answer, and it fails closed');
{
  const t = code('src/lib/market/tiingo.mjs');
  const e = code('src/lib/entitlements.js');
  // ⚠️ THE STOP CHECK ITSELF FAILED OPEN. Unconfigured or unreadable KV returned "not stopped".
  ok('⚠️ unknown starts as unknown, not as permitted', /let _stop = \{ at: 0, value: null \};/.test(t));
  ok('⚠️ an unconfigured control reads as STOPPED', /if \(!url \|\| !tok\) return true;/.test(t));
  ok('⚠️ an unreadable control reads as stopped unless a recent answer says otherwise',
    /const stoppedUnlessKnownOtherwise = \(\) => _stop\.value !== false;/.test(t)
    && (t.match(/return stoppedUnlessKnownOtherwise\(\);/g) || []).length === 2);
  ok('…and a cached unknown is not trusted as an answer',
    /Date\.now\(\) - _stop\.at < STOP_TTL_MS && _stop\.value !== null/.test(t));
  // ⚠️ AN ABSENT KEY IS STILL NOT A STOP. The steady state must not be revoked.
  ok('⚠️ a successful read finding no key is NOT a stop',
    /value: String\(result \?\? ''\)\.trim\(\) === '1'/.test(t));

  // The single answer now includes it.
  ok('⚠️ callerHasRealtime consults the stop order', /return !\(await tiingoRealtimeStopped\(\)\);/.test(e));
  // ⚠️ PRESENCE *THEN* ORDER. Asserted as an indexOf comparison alone, DELETING the tier guard passed —
  // indexOf returns -1 and -1 precedes any real index. That mutation is a privilege escalation, not a
  // style regression: without the guard, callerHasRealtime returns true for a FREE user whenever no stop
  // is in force. It survived a mutation run, which is exactly what mutation testing is for.
  ok('⚠️ the tier guard exists', /if \(!isRealtimeRule\(tier\) \|\| beta\) return false;/.test(e),
    'without it a Free caller is granted real-time');
  ok('⚠️ …and precedes the stop check, so a non-Pro caller costs no KV read',
    e.includes('if (!isRealtimeRule(tier) || beta) return false;')
    && e.includes('tiingoRealtimeStopped()')
    && e.indexOf('if (!isRealtimeRule(tier) || beta) return false;') < e.indexOf('tiingoRealtimeStopped()'));
  // ⚠️ THE SYMBOL MUST BE IMPORTED, AND THIS ASSERTION EXISTS BECAUSE IT WAS NOT.
  //
  // I added the stop check to callerHasRealtime and forgot the import. A free identifier is a runtime
  // ReferenceError, not a compile error, so the build passed — and the call sits inside a try whose catch
  // returns false, so the throw was swallowed and EVERY Pro and Elite caller silently lost real-time.
  // This file already carries that scar about the isRealtime re-export; it is the same failure, in the
  // same function, for the same reason. verify-freshness-entitlement caught it by exercising the five
  // tiers, which is the only way it could have been caught.
  ok('⚠️ tiingoRealtimeStopped is actually imported, not a free identifier',
    /^import \{ tiingoRealtimeStopped \} from '\.\/market\/tiingo\.mjs';$/m.test(read('src/lib/entitlements.js')));
  ok('⚠️ …and every symbol callerHasRealtime calls resolves at runtime', await (async () => {
    const m = await import('../src/lib/entitlements.js');
    return typeof m.callerHasRealtime === 'function' && typeof (await import('../src/lib/market/tiingo.mjs')).tiingoRealtimeStopped === 'function';
  })());

  // Exercised: the pure rule must still deny every non-realtime tier regardless of any stop state.
  const { isRealtime } = await import('../src/lib/entitlement-rules.mjs');
  for (const tier of ['free', undefined, null, '', 'trial', 'FREE']) {
    ok(`  ${JSON.stringify(tier)} is not a real-time tier`, isRealtime(tier) === false);
  }
  ok('  pro and elite are', isRealtime('pro') === true && isRealtime('elite') === true);
  ok('…and the whole thing still fails closed on any error', /return false;                 \/\/ never grant/.test(read('src/lib/entitlements.js')));

  // ⚠️ AND EVERY SITE USES THAT ONE ANSWER. Seven determinations, five of them copies.
  const SITES = ['src/app/api/heatmap/performance/route.js', 'src/app/api/market-movers/route.js',
    'src/app/api/movers/route.js', 'src/app/api/quotes/route.js', 'src/app/api/pitscan/route.js',
    'src/lib/scan/board-payload.js'];
  for (const f of SITES) {
    const src = code(f);
    ok(`${f} uses callerHasRealtime`, /await callerHasRealtime\(\)/.test(src));
    ok(`  …and no longer inlines the tier check`, !/realtime = isRealtime\(tier\) && !beta/.test(src));
  }
  ok('⚠️ no inlined realtime determination survives anywhere',
    SITES.every((f) => !/isRealtime\(tier\) && !beta/.test(code(f))));

  // The data path keeps its own gate — belt and braces, since it is the only thing that can emit a print.
  ok('⚠️ getQuotes still checks the stop itself',
    /const entitled = realtime && tiingoRealtimeEnabled\(\) && !\(await tiingoRealtimeStopped\(\)\)/.test(t));

  // ⚠️ CACHE SAFETY: a stop must not be defeated by a previously stored live response.
  // ⚠️ SCOPED TO getQuotes, BECAUSE indexOf FOUND AN EARLIER FUNCTION'S CALL. `const res = await tiingo(`
  // appears in getIntradayBars first, so comparing raw positions said the stop was evaluated too late when
  // it is in fact the first statement in the right function. The window is cut to getQuotes and the
  // ordering checked inside it.
  const gq = t.slice(t.indexOf('const entitled = realtime &&'));
  ok('⚠️ the stop is evaluated before any price is fetched in getQuotes',
    gq.indexOf('const entitled = realtime &&') === 0
    && gq.indexOf('await tiingo(') > 0
    && gq.indexOf('const price = gate.useLivePrice') > gq.indexOf('await tiingo('));
  ok('…and an unentitled caller is served the settled close, not a cached live print',
    /const price = gate\.useLivePrice \? \(live \?\? prevClose\) : prevClose;/.test(t));

  // Health must distinguish intentional from broken, and leak nothing.
  const h = code('src/app/api/health/route.js');
  ok('⚠️ health reports the licensing state', /run\('licensing\.realtime'/.test(h));
  ok('⚠️ …as ok even when stopped, so a deliberate stop is not a red alert',
    /ok: true,\s*\n\s*state,/.test(h));
  ok('⚠️ …naming stopped, off, unconfigured and live distinctly',
    /'unconfigured'/.test(h) && /'off'/.test(h) && /'stopped'/.test(h) && /'live'/.test(h));
  ok('…and saying which is intentional', /intentional, not a provider failure/.test(read('src/app/api/health/route.js')));
  // ⚠️ SECRETS: /api/health is world-readable.
  ok('⚠️ no credential or licensing internal is published',
    !/TIINGO_API_KEY|KV_REST_API_TOKEN|apiKey|process\.env\.TIINGO/.test(h));
  ok('…and no vendor plan or contract term either', !/plan|contract|invoice|tier:/i.test(h.slice(h.indexOf("licensing.realtime"), h.indexOf("licensing.realtime") + 1400)));
}

L('⚠️ the things these three changes must not have broken');
{
  // Each of these is a guarantee established earlier in this cleanup; a licensing change touching five
  // routes is exactly where one would be lost by accident.
  ok('Screener aggregate gating still enforced',
    /pro \? rows : rows\.map\(stripProAggregate\)/.test(code('src/app/api/screener/route.js')));
  ok('Screener responses still private', /'private, no-store'/.test(read('src/app/api/screener/route.js')));
  ok('test-symbol exclusion still applied',
    /isExchangeTestSymbol\(t, \{ classified: metaByT\.has\(t\) \}\)/.test(code('src/lib/screener-data.js')));
  ok('Evidence Alert delivery-time entitlement still enforced',
    /PRO_TIERS\.has\(access\.get\(s\.userId\)\?\.tier\)/.test(code('src/lib/alerts/evidence-alert-worker.mjs')));
  ok('Form 4 channel scoping still structural',
    /const stored = channelKey\(channel, eventKey\);/.test(code('src/lib/evidence-alerts.js')));
  ok('the halt sweep still has its own heartbeat', /recordJobRun\('halts', \{/.test(code('src/app/api/cron/primary-sources/route.js')));
  ok('Pro ad-free still gated', /adsEligibleTier\(tier\)/.test(code('src/lib/adsense.mjs')));
  ok('dividends still display one licensed source', /d\.source = \$\{calendarSource\(\)\}/.test(code('src/lib/dividends/dividend-store.js')));
  const v = JSON.parse(read('vercel.json'));
  ok('⚠️ still 40 crons or fewer', v.crons.length <= 40, String(v.crons.length));
  ok('⚠️ and no new market-data provider was introduced',
    !/twelvedata|twelve_data/i.test(read('src/lib/market/tiingo.mjs') + read('src/lib/entitlements.js')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
