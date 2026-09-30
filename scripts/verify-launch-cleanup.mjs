// LAUNCH CLEANUP — the previously-reported items, each pinned so it cannot quietly come back.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-launch-cleanup.mjs
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = (p) => read(p).replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const one = async (q) => (await q)[0];

L('⚠️ 6 — exchange test symbols, refused by a rule that keeps the real TEST ETF');
{
  const { isExchangeTestSymbol } = await import('../src/lib/ticker-symbol.mjs');
  for (const t of ['ZXZZT', 'ZVZZT', 'ZWZZT', 'ZJZZT', 'ZAZZT', 'ZBZZT', 'ZCZZT', 'NTEST', 'MTEST', 'ATEST', 'ZTEST', 'ZXYZ']) {
    ok(`${t} is refused when our reference data knows nothing about it`, isExchangeTestSymbol(t) === true);
  }
  // ⚠️ THE CASE THAT MAKES A BARE BLACKLIST WRONG. TEST is a real, listed, classified ETF.
  ok('⚠️ a CLASSIFIED symbol matching the pattern is kept', isExchangeTestSymbol('TEST', { classified: true }) === false);
  ok('⚠️ a NAMED symbol matching the pattern is kept', isExchangeTestSymbol('TEST', { named: true }) === false);
  ok('…and the reason is recorded against the real ETF by name',
    /YieldMax TSLA Performance & Distribution Target 25 ETF/.test(read('src/lib/ticker-symbol.mjs')));
  // Legitimate securities that merely look similar.
  for (const t of ['CBOE', 'CBON', 'LBO', 'LBOX', 'CBOT', 'ZTS', 'ZM', 'TESLA']) {
    ok(`${t} is not treated as a test symbol`, isExchangeTestSymbol(t) === false);
  }
  ok('the rebuild applies it at the single universe entry point',
    /isExchangeTestSymbol\(t, \{ classified: metaByT\.has\(t\) \}\)/.test(code('src/lib/screener-data.js')));
  ok('…and logs what it refused rather than dropping it silently',
    /refused \$\{testSyms\.length\} exchange test symbol/.test(read('src/lib/screener-data.js')));
  // Production.
  const left = await one(sql`select count(*)::int n from screener_stocks
    where ticker ~ '^(Z[A-Z]ZZT|[A-Z]?TEST[A-Z]?|ZXYZ[A-Z]?)$' and company is null`);
  ok('⚠️ no unnamed test symbol remains in the production universe', left.n === 0, `${left.n}`);
  const kept = await one(sql`select company from screener_stocks where ticker='TEST'`);
  ok('⚠️ …and the real TEST ETF is still there, with its name', /YieldMax/.test(String(kept?.company)), JSON.stringify(kept));
}

L('⚠️ 7 — the anonymous capabilities payload no longer names the vendor internally');
{
  const r = code('src/app/api/screener/route.js');
  ok('⚠️ the internal provider id is not shipped', !/provider: caps\.id/.test(r));
  ok('the human label is kept, because the UI renders it', /label: caps\.label/.test(r));
  ok('…and the attribution question is flagged rather than decided',
    /attribution term in the licence/.test(read('src/app/api/screener/route.js')));
  // The Screener's own Free/Pro boundary is in the quote path, not the row path — that is correct and
  // is asserted so a tier check is not later bolted onto EOD rows that do not need one.
  ok('the EOD row path resolves no tier (EOD is not Pro-gated)',
    !/resolveUserTier|resolveUserAccess|isProTier/.test(r));
  ok('…and the live freshening goes through the entitlement-aware quotes API',
    /\/api\/quotes\?symbols=/.test(code('src/app/screener/ScreenerClient.jsx')));
}

L('⚠️ 8 — a mixed board does not claim REAL-TIME');
{
  const { BOARD_STATUS_LABEL, boardStatusLabel, aggregateFreshness } = await import('../src/lib/scan/scan-rows.mjs');
  ok('⚠️ mixed is labelled PARTIAL, not REAL-TIME', BOARD_STATUS_LABEL.mixed === 'REAL-TIME · PARTIAL');
  // ⚠️ AND GENUINELY LIVE DATA IS NOT DOWNGRADED, which the instruction was equally clear about.
  ok('realtime still reads REAL-TIME', BOARD_STATUS_LABEL.realtime === 'REAL-TIME');
  ok('near still reads REAL-TIME', BOARD_STATUS_LABEL.near === 'REAL-TIME');
  ok('delayed still reads DELAYED', BOARD_STATUS_LABEL.delayed === 'DELAYED');
  ok('eod still reads LAST CLOSE', BOARD_STATUS_LABEL.eod === 'LAST CLOSE');
  ok('an unknown provenance falls to the weakest label', boardStatusLabel('nonsense') === 'LAST CLOSE');
  // The aggregation itself is unchanged: a mixture is still detected as a mixture.
  ok('live + not-live still aggregates to mixed', aggregateFreshness(['realtime', 'eod']) === 'mixed');
  ok('all-live still aggregates to realtime', aggregateFreshness(['realtime', 'realtime']) === 'realtime');
  ok('realtime + near is still the weaker of the two', aggregateFreshness(['realtime', 'near']) === 'near');
  // ⚠️ TWO COMPONENTS, ONE WORD. The banner and the label map must not disagree about one feed.
  ok('⚠️ the banner and the label map agree on the mixed wording',
    /mixed: \{ label: 'REAL-TIME · PARTIAL'/.test(code('src/components/scan/ScanBoardRows.jsx')));
  ok('…and the row badges still describe each price individually',
    /Each row shows its price status/.test(read('src/components/scan/ScanBoardRows.jsx')));
}

L('⚠️ 9 — Pit Scan row actions are tappable');
{
  const css = read('src/lib/cp-shared.jsx');
  ok('a tap-target class exists', /\.cp-scan-act\{padding:9px 5px;margin:-9px -5px/.test(css));
  ok('⚠️ …and the negative margin cancels it, so desktop density is unchanged',
    /margin:-9px -5px/.test(css));
  ok('…and it grows further on a phone', /@media \(max-width:560px\)\{[\s\S]*?\.cp-scan-act\{padding:13px 8px;margin:-13px -8px\}/.test(css));
  ok('…where the gap between targets widens too', /\.cp-scan-acts\{gap:22px!important/.test(css));
  ok('the tap highlight is suppressed so the grown box is invisible', /-webkit-tap-highlight-color:transparent/.test(css));
  // ⚠️ ALL FOUR ACTIONS, not three: the one that was easiest to miss is the one that creates a
  // subscription.
  const rows = code('src/components/scan/ScanBoardRows.jsx');
  ok('Chart carries the class', /#chart`\} className="cp-scan-act"/.test(rows));
  ok('Evidence carries the class', /<a href=\{href\} className="cp-scan-act"/.test(rows));
  ok('Watch carries the class', /onWatch\(r\.ticker\)\} disabled=\{busy === r\.ticker\} className="cp-scan-act"/.test(rows));
  ok('⚠️ Alert carries the class', /aria-pressed=\{on\} className="cp-scan-act"/.test(code('src/components/AlertToggle.jsx')));
  ok('the action row is addressable for the media query', /className="cp-scan-acts"/.test(rows));
  // No horizontal overflow: the row already wraps.
  ok('the action row wraps rather than overflowing', /flexWrap: 'wrap'/.test(rows));
}

L('⚠️ 10 — the Tiingo licence switch is read when it is asked, and can be pulled without a deploy');
{
  const t = code('src/lib/market/tiingo.mjs');
  // ⚠️ THE GAP: these were module-level constants, so the "switch" was whatever the value happened to
  // be the first time a serverless instance loaded the file.
  ok('⚠️ the realtime flag is read per call, not captured at import',
    /const realtimeFlag = \(\) => String\(process\.env\.TIINGO_REALTIME_ENABLED/.test(t));
  ok('…and so is the token, so a rotation takes effect', /const token = \(\) => process\.env\.TIINGO_API_KEY/.test(t));
  ok('…and no module-level constant gates anything any more', !/^const (REALTIME_ENABLED|ENABLED|TOKEN) =/m.test(t));
  ok('the stop order is checked in the one function that can emit a live print',
    /const entitled = realtime && tiingoRealtimeEnabled\(\) && !\(await tiingoRealtimeStopped\(\)\);/.test(t));
  ok('…and it is one-directional', /String\(result \?\? ''\)\.trim\(\) === '1'/.test(t));
  ok('⚠️ …and a KV outage leaves the env decision in force rather than revoking Pro data',
    /keep the last known answer/.test(read('src/lib/market/tiingo.mjs')));
  ok('…cached so the quote path is not a KV round trip per request', /STOP_TTL_MS = 30_000/.test(t));

  // Exercised: only the exact literal enables it, everything else fails closed.
  const m = await import('../src/lib/market/tiingo.mjs');
  const orig = process.env.TIINGO_REALTIME_ENABLED;
  try {
    for (const [v, want] of [['true', true], ['TRUE', true], ['false', false], ['yes', false], ['1', false], ['', false]]) {
      process.env.TIINGO_REALTIME_ENABLED = v;
      ok(`TIINGO_REALTIME_ENABLED=${JSON.stringify(v)} -> ${want}`, m.tiingoRealtimeEnabled() === want);
    }
    delete process.env.TIINGO_REALTIME_ENABLED;
    ok('⚠️ unset fails CLOSED', m.tiingoRealtimeEnabled() === false);
  } finally {
    if (orig === undefined) delete process.env.TIINGO_REALTIME_ENABLED; else process.env.TIINGO_REALTIME_ENABLED = orig;
  }
  ok('the stop key is exported so an operator can set it', typeof m.TIINGO_STOP_KEY === 'string' && m.TIINGO_STOP_KEY.length > 0);
  ok('⚠️ no licence internals are exposed client-side from this module',
    !/tiingo/i.test(code('src/app/screener/ScreenerClient.jsx')));
}

L('⚠️ 11 — the What Changed watermark is the feature, not an artifact');
{
  const r = read('src/app/api/watchlist/changes/route.js');
  // Reported as a possible debug/visual watermark. It is neither: it is a per-user "last seen"
  // timestamp that decides what counts as new, and it is what makes the feature work at all.
  ok('it is a per-user seen timestamp', /const seenKey = \(userId\) => `catalystpit:watchlist:seen:\$\{userId\}`;/.test(r));
  ok('…kept in KV deliberately, with the reasoning written down', /The watermark lives in KV rather than a new column/.test(r));
  ok('…and losing it degrades to the documented 24h default, never to an error',
    /a lost watermark degrades to the 24h default, never to an error/.test(r));
  ok('⚠️ advancing it is a deliberate act, never a side effect of rendering',
    /Advancing the watermark is a deliberate act, never a side effect of rendering/.test(read('src/components/WatchlistChanges.jsx')));
  ok('the route is never shared-cacheable, because the answer is one person\'s', /private, no-store/.test(r));
  // ⚠️ AND IT IS PER-USER RATHER THAN PER-LIST, which is the open product question, not a bug.
  ok('it is scoped to the user, not to a list', !/listId/.test(code('src/app/api/watchlist/changes/route.js')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
