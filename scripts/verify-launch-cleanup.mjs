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
  // ⚠️ THE CALL GAINED A `named` ARGUMENT, and the reason belongs in the test. `classified: metaByT.has(t)`
  // was the whole test for "our reference data knows this symbol" — but metaByT is now filtered to rows
  // whose vendor-derived columns may be SERVED, so TEST (the real YieldMax ETF, whose meta row predates the
  // provenance work and carries a NULL source) stopped counting as known, was refused as an exchange test
  // symbol, and vanished from screener_stocks entirely. Whether we may publish a sector is a different
  // question from whether a symbol denotes a real security, so the security master's name decides too.
  ok('the rebuild applies it at the single universe entry point',
    /isExchangeTestSymbol\(t, \{ classified: metaByT\.has\(t\), named: !!nameByT\.get\(t\) \}\)/.test(code('src/lib/screener-data.js')));
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
  // ⚠️ THIS ASSERTED THE INTERIM DECISION, AND THE CONTRACT HAS SINCE SETTLED IT. The label was kept
  // pending the attribution term; the executed agreement requires "Market Data from Tiingo.com" on the
  // legal/disclaimer pages and does NOT require the vendor beside every market-data surface, so the
  // per-surface label is gone. The attribution itself is asserted in verify-freshness-entitlement.mjs.
  ok('⚠️ the provider label is no longer shipped either', !/label: (caps|served)\.label/.test(r));
  ok('…and the reason points at the legal pages rather than at an open question',
    /attribution clause is satisfied on the legal pages/.test(read('src/app/api/screener/route.js')));
  // ⚠️ THIS ASSERTION WAS WRONG, AND IT WAS PINNING THE BUG IN PLACE. It read "the EOD row path resolves
  // no tier (EOD is not Pro-gated)", on the reasoning that end-of-day prices need no entitlement check.
  // That reasoning is sound about PRICES and was applied to the whole row — and the row also carried
  // eight derived aggregates (insiderNet90d, congressNet90d, fundNetQoq, consensusScore and siblings)
  // over datasets gated to ten records elsewhere. Freshness was never the only thing in the payload.
  //
  // The row path now resolves a tier. What must stay true is the narrower thing this was reaching for:
  // the EOD PRICE is not gated, so the Screener remains usable for Free and logged-out visitors.
  ok('⚠️ the row path resolves a tier, because the row carries the Pro aggregate',
    /isProTier\(\(await resolveUserAccess\(\)\)\.tier\)/.test(r));
  ok('⚠️ …and EOD prices are still NOT gated — the Screener stays usable for everyone',
    !/price.*proOnly|stripProAggregate.*price/.test(r)
    && !/PRO_AGGREGATE_FIELDS.*'price'/.test(read('src/lib/screener-entitlement.mjs')));
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
  // ⚠️ BOTH DECLARATIONS NOW CARRY !important, AND THAT IS NOT COSMETIC. Three controls — the Watch button
  // and both Alert controls — set `padding: 0` inline to reset the button default, and an inline
  // declaration beats a stylesheet one, so this rule was fully overridden on exactly the row actions it
  // was written for. Measured on production at 390px: 12px tall. The inline resets are gone and the rule
  // is now !important so a future one cannot silently defeat it again.
  ok('a tap-target class exists', /\.cp-scan-act\{padding:9px 5px!important;margin:-9px -5px!important/.test(css));
  ok('⚠️ …and the negative margin cancels it, so desktop density is unchanged',
    /margin:-9px -5px!important/.test(css));
  ok('…and it grows further on a phone',
    /@media \(max-width:560px\)\{[\s\S]*?\.cp-scan-act\{padding:13px 8px!important;margin:-13px -8px!important\}/.test(css));
  // The bordered pills could not use the negative-margin trick at all — the padding is the visible box.
  ok('⚠️ …and the bordered pills get a mobile minimum height instead',
    /\.cp-tap-pill\{min-height:38px;display:inline-flex!important/.test(css));
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
  // ⚠️ THIS ASSERTION HAS BEEN REVERSED ON THE OWNER'S INSTRUCTION, AND THE REVERSAL IS THE POINT.
  //
  // It required that "a KV outage leaves the env decision in force rather than revoking Pro data" —
  // failing OPEN, on the reasoning that the licensing question is answered by the flag's PRESENCE and not
  // by our ability to read it, and that an infrastructure blip should not revoke data nobody asked to
  // revoke. That argument is sound for one of the two states it covered and wrong for the other.
  //
  // A SUCCESSFUL read finding no key really is "no stop issued" — the steady state, nothing revoked, and
  // that is still asserted below. A read we could not PERFORM means we do not know, and a redistribution
  // control that cannot be consulted is not a control. The rule is now that an unknown licensing state
  // fails in the safe direction, so the two states are separated rather than collapsed.
  const tiingoSrc = read('src/lib/market/tiingo.mjs');
  ok('⚠️ a successful read finding no key does NOT revoke anything',
    /value: String\(result \?\? ''\)\.trim\(\) === '1'/.test(tiingoSrc));
  ok('⚠️ …but an unreadable or unconfigured control now fails CLOSED',
    /if \(!url \|\| !tok\) return true;/.test(tiingoSrc)
    && /const stoppedUnlessKnownOtherwise = \(\) => _stop\.value !== false;/.test(tiingoSrc));
  ok('…and a recent known answer still carries a brief blip', /STOP_TTL_MS/.test(tiingoSrc)
    && /_stop\.value !== null/.test(tiingoSrc));
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

L('⚠️ 12 — health distinguishes FAILED from NEVER-RUN, without faking green');
{
  const hb = read('src/lib/job-heartbeat.js');
  // ⚠️ AN EVENT-DRIVEN JOB THAT HAS NOT FIRED IS NOT A BROKEN ONE, and must not be reported as a
  // successful run either. Three states, not two.
  // ⚠️ THE THREE-WAY DISTINCTION LIVES IN THE HEALTH ROUTE, not in the heartbeat writer.
  const health = read('src/app/api/health/route.js');
  ok('event-driven jobs are declared as such', /eventDriven: true/.test(hb));
  ok('…and a never-run job is its own state, distinct from a failing one',
    /state: b == null \? 'never'/.test(health));
  ok('⚠️ …and "never" is surfaced rather than buried, because benign-forever is a hole',
    /IS BENIGN FOREVER, WHICH IS A HOLE/.test(health));
  ok('a heartbeat records a run that SUCCEEDED, not that we reached a line',
    /A heartbeat records that the job RAN AND SUCCEEDED/.test(hb));
  // ⚠️ MATCHED ON A FRAGMENT THAT SITS ON ONE LINE: the sentence wraps after "is a".
  ok('…and seen: 0 is explicitly healthy', /perfectly healthy Sunday/.test(hb));
  ok('⚠️ only a successful run moves the success clock',
    /last_success_at = case when \$\{!!ok\} then now\(\) else feed_state\.last_success_at end/.test(hb));
  ok('⚠️ and the public note can never be an error dump', /\$\{safeNote\(note\)\}/.test(hb));

  // Production, measured rather than asserted from code.
  const dividends = await one(sql`select last_success_at, last_status, consecutive_failures, events_seen, note
    from feed_state where feed_key='job:dividends'`);
  ok('⚠️ dividends has genuinely succeeded', dividends?.last_success_at != null, JSON.stringify(dividends));
  ok('…with status 200 and no consecutive failures',
    Number(dividends?.last_status) === 200 && Number(dividends?.consecutive_failures) === 0);
  ok('…and a non-zero events_seen, so the counter is real', Number(dividends?.events_seen) > 0, String(dividends?.events_seen));
  ok('…and its note is not a dumped statement', !/insert into|failed query/i.test(String(dividends?.note)));

  // ⚠️ NOTHING WAS MANUFACTURED TO MAKE THIS GREEN. The two webhooks have still never run, and that
  // is the correct pre-launch state — no synthetic Stripe or Clerk event exists.
  for (const k of ['job:stripe-webhook', 'job:clerk-webhook']) {
    const row = await one(sql`select last_success_at from feed_state where feed_key=${k}`);
    ok(`${k} has NOT been faked into a successful run`, !row || row.last_success_at == null, JSON.stringify(row));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
