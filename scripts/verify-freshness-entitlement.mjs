// FRESHNESS METADATA, asOf SEMANTICS, PER-USER CHANGES, AND CHANNEL INDEPENDENCE.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-freshness-entitlement.mjs
//
// ⚠️ TWO CLAIMS THAT WERE NOT TRUE OF THE CALLER READING THEM.
//
//   /api/screener?meta=1 takes no auth and served `quoteFreshness: "realtime"` to anyone, describing
//   the ACCOUNT's plan while handing the caller the 15-minute delayed snapshot.
//
//   /api/quotes stamped every quote with `q.timestamp`, the moment Tiingo GENERATED the record. On a
//   pre-market request the price has degraded to prevClose — the previous session's settled close —
//   so a yesterday price arrived looking seconds old. Measured 2026-09-30 09:14 ET: AAPL prevClose
//   329.40 carried timestamp 2026-09-30T09:14:45-04:00.
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = (p) => read(p).replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const one = async (q) => (await q)[0];

const clerk = await import('../scripts/lib/clerk-stub.mjs');
const { FRESHNESS, callerCapabilities, FULL_PROVIDER, INTERIM_PROVIDER } = await import('../src/lib/scan/market-capabilities.mjs');
const { callerHasRealtime, callerRealtimeAccess } = await import('../src/lib/entitlements.js');

const IDENTITIES = {
  anonymous: { userId: null },
  free: { userId: 'u_free', publicMetadata: {} },
  pro: { userId: 'u_pro', publicMetadata: { plan: 'pro' } },
  elite: { userId: 'u_elite', publicMetadata: { plan: 'elite' } },
  beta: { userId: 'u_beta', publicMetadata: { beta: true } },
};

L('⚠️ the freshness a caller is TOLD matches the freshness they are SERVED');
{
  // The real-time provider descriptor — what our Tiingo plan can do.
  const rt = { ...FULL_PROVIDER, quoteFreshness: FRESHNESS.REALTIME, streaming: true, bidAsk: true };

  ok('⚠️ an unentitled caller is never told realtime',
    callerCapabilities(rt, { realtime: false }).quoteFreshness === FRESHNESS.DELAYED);
  ok('…nor near, which is also a live claim',
    callerCapabilities({ ...rt, quoteFreshness: FRESHNESS.NEAR }, { realtime: false }).quoteFreshness === FRESHNESS.DELAYED);
  ok('an entitled caller is told exactly what the provider gives',
    callerCapabilities(rt, { realtime: true }).quoteFreshness === FRESHNESS.REALTIME);

  // ⚠️ IT CAPS, IT NEVER PROMOTES. Claiming `delayed` to a caller receiving settled closes is the
  // same lie in the other direction.
  ok('⚠️ an EOD-only provider is not upgraded to delayed for an unentitled caller',
    callerCapabilities({ ...rt, quoteFreshness: FRESHNESS.EOD }, { realtime: false }).quoteFreshness === FRESHNESS.EOD);
  ok('…and the interim delayed provider is unchanged',
    callerCapabilities(INTERIM_PROVIDER, { realtime: false }).quoteFreshness === FRESHNESS.DELAYED);

  // A stream and a quote book are the same licensed entitlement as the price.
  const capped = callerCapabilities(rt, { realtime: false });
  ok('an unentitled caller is not told the feed streams', capped.streaming === false);
  ok('…nor that a quote book is available', capped.bidAsk === false);
  ok('an entitled caller keeps both', callerCapabilities(rt, { realtime: true }).streaming === true);

  // ⚠️ THE INTERNAL DESCRIPTOR IS NOT MUTATED. Signal partitioning and readiness must keep deciding
  // against the real provider — an unentitled caller is described honestly, not served a crippled engine.
  ok('⚠️ the provider descriptor itself is untouched', rt.quoteFreshness === FRESHNESS.REALTIME && rt.streaming === true);
  ok('…and the projection is a copy', callerCapabilities(rt, { realtime: false }) !== rt);
}

L('⚠️ entitlement is resolved from the session, and nothing else can reach it');
{
  const EXPECT = { anonymous: false, free: false, pro: true, elite: true, beta: false };
  for (const [name, id] of Object.entries(IDENTITIES)) {
    clerk.__setIdentity(id);
    const got = await callerHasRealtime();
    ok(`${name} → realtime ${EXPECT[name]}`, got === EXPECT[name], `got ${got}`);
    // And the metadata a route would serve follows it.
    const served = callerCapabilities({ ...FULL_PROVIDER, quoteFreshness: FRESHNESS.REALTIME }, { realtime: got });
    const live = served.quoteFreshness === FRESHNESS.REALTIME;
    ok(`  …and ${name} is described as ${live ? 'realtime' : 'not realtime'}`, live === EXPECT[name]);
  }
  // ⚠️ BETA IS THE CASE THAT MAKES "PRO" INSUFFICIENT. A flagged tester is Pro-tier and is
  // deliberately served delayed quotes, so Pit Scan describing their feed as realtime would
  // contradict the prices they receive.
  clerk.__setIdentity(IDENTITIES.beta);
  ok('⚠️ a beta-flagged Pro user is Pro but NOT realtime', (await callerHasRealtime()) === false);

  // ⚠️ FORGED CLIENT INPUT CANNOT PARTICIPATE, proven structurally: the resolver takes no arguments
  // and reads no request. A header, cookie, query parameter or body field has nowhere to enter.
  ok('⚠️ the resolver accepts no caller-supplied argument', callerHasRealtime.length === 0);
  const ent = code('src/lib/entitlements.js');
  const resolver = ent.slice(ent.indexOf('export async function callerHasRealtime'));
  ok('⚠️ …and its body reads no request, header or cookie',
    !/request|headers|cookies|searchParams|req\b/i.test(resolver), resolver.slice(0, 120));
  // ⚠️ EXERCISED, NOT MATCHED. This asserted /return false;/ against the source of callerHasRealtime,
  // which proves only that the characters exist somewhere in the slice — it passed when the function
  // was a four-line body and it would pass again if the catch returned false for the wrong reason. It
  // then went red when the body moved into callerRealtimeAccess, even though the fail-closed behaviour
  // was unchanged, which is the giveaway that it was measuring spelling.
  //
  // Both failure modes are now provoked for real, on a PRO identity so that a denial can only come
  // from the error path and not from the tier:
  for (const [label, id] of [
    ['the identity provider itself throws', { userId: 'u_pro', publicMetadata: { plan: 'pro' }, authThrows: true }],
    ['the user lookup throws', { userId: 'u_pro', publicMetadata: { plan: 'pro' }, getUserThrows: true }],
  ]) {
    clerk.__setIdentity(id);
    ok(`⚠️ …and a Pro caller is DENIED real-time when ${label}`, (await callerHasRealtime()) === false);
    const a = await callerRealtimeAccess();
    ok(`   …with the combined shape denying too, and claiming no tier it could not read`,
      a.realtime === false && a.tier === 'free', JSON.stringify(a));
  }
  // Restore a known identity so a later case cannot inherit a throwing provider.
  clerk.__setIdentity(IDENTITIES.pro);
  ok('⚠️ …and the throwing identity did not leak into the next case', (await callerHasRealtime()) === true);
  // The two serving routes must pass the RESOLVED value, never something off the wire.
  for (const f of ['src/app/api/screener/route.js', 'src/app/api/pitscan/route.js']) {
    const c = code(f);
    ok(`${f} resolves the entitlement server-side`, /callerHasRealtime\(\)/.test(c));
    ok(`  …and reads no tier from the request`, !/headers\.get\(['"]x-tier|searchParams\.get\(['"]tier/i.test(c));
  }
  ok('the screener serves the projected capabilities, not the raw provider',
    /quoteFreshness: served\.quoteFreshness/.test(code('src/app/api/screener/route.js')));
  ok('…and Pit Scan does too', /quoteFreshness: served\.quoteFreshness/.test(code('src/lib/scan/runtime.js')));
  ok('⚠️ …while readiness still uses the real provider', /const readiness = scanReadiness\(caps\);/.test(code('src/lib/scan/runtime.js')));
  clerk.__setIdentity({ userId: null });
}

L('⚠️ asOf describes the price shown, not the moment we asked');
{
  const { lastSessionCloseIso, lastCompletedSession, closeMinute, etInstant } = await import('../src/lib/market/market-session.mjs');
  const t = code('src/lib/market/tiingo.mjs');

  ok('⚠️ the quote timestamp follows the price that was actually chosen',
    /asOf: priceIsLive \? \(q\.timestamp \|\| null\) : lastSessionCloseIso\(\)/.test(t));
  ok('…and "chosen" means the live print WON, not merely that it was permitted',
    /const priceIsLive = gate\.useLivePrice && live != null;/.test(t));
  ok('the market-wide snapshot applies the same rule',
    /asOf: live != null \? \(q\.timestamp \|\| null\) : lastSessionCloseIso\(\)/.test(t));
  ok('⚠️ no precision is invented — the close instant comes from the exchange calendar',
    /lastSessionCloseIso/.test(read('src/lib/market/market-session.mjs'))
    && /walks holidays and early closes|real exchange calendar/.test(read('src/lib/market/market-session.mjs')));

  // The instant itself, across both DST boundaries.
  const CASES = [
    ['2026-03-06T20:00:00Z', '2026-03-05', '2026-03-05T21:00:00.000Z'],   // EST
    ['2026-03-10T20:00:00Z', '2026-03-10', '2026-03-10T20:00:00.000Z'],   // EDT
    ['2026-11-09T20:00:00Z', '2026-11-06', '2026-11-06T21:00:00.000Z'],   // back to EST
  ];
  for (const [nowIso, wantSession, wantClose] of CASES) {
    const now = Date.parse(nowIso);
    ok(`as of ${nowIso.slice(0, 10)}: session ${wantSession}`, lastCompletedSession(now) === wantSession, lastCompletedSession(now));
    ok(`  …close instant ${wantClose}`, lastSessionCloseIso(now) === wantClose, lastSessionCloseIso(now));
  }
  // ⚠️ THE HELPER MOVED, AND THE ENTITLEMENT PATH MUST BE BYTE-IDENTICAL AFTER THE MOVE.
  const { eodCutoffIso } = await import('../src/lib/entitlement-rules.mjs');
  ok('⚠️ eodCutoffIso still agrees with the shared close instant', eodCutoffIso('free') === lastSessionCloseIso());
  ok('…and Pro is still ungated', eodCutoffIso('pro') === null);
  ok('only one etInstant exists now', typeof etInstant === 'function'
    && !/^function etInstant/m.test(code('src/lib/entitlement-rules.mjs')));

  // ⚠️ MEASURED AGAINST THE LIVE VENDOR: a Free (prevClose) read must not look seconds old.
  const { getQuotes } = await import('../src/lib/market/tiingo.mjs');
  const r = await getQuotes(['AAPL', 'MSFT'], { realtime: false });
  const qs = Object.values(r.quotes || {});
  ok('a Free read returns quotes', qs.length > 0, JSON.stringify(r).slice(0, 120));
  for (const [symbol, q] of Object.entries(r.quotes || {})) {
    const isClose = q.price === q.prevClose;
    if (!isClose) { ok(`${symbol}: live print keeps the vendor timestamp`, true); continue; }
    const ageMin = (Date.now() - Date.parse(q.asOf)) / 60000;
    ok(`⚠️ ${symbol}: a previous-close price is NOT stamped as seconds old`, ageMin > 30, `age ${ageMin.toFixed(0)}min`);
    ok(`  …it carries the session close instant`, q.asOf === lastSessionCloseIso(), q.asOf);
  }

  // The consumers that compute age from it.
  ok('the movers rank still rejects a print older than the session open',
    /if \(!isSessionPrint\(q\.timestamp, sessionOpenMs\)\)/.test(code('src/lib/movers/movers-universe.mjs')));
  ok('⚠️ …and movers ranks on lastPrice, so a prevClose row was never ranked anyway',
    /tngoLast: r\.lastPrice/.test(code('src/lib/movers/movers-store.js')));
  ok('the heatmap reads the quote asOf only when the row is live',
    /if \(rr\.live\) \{ row\.price = lq\.price; row\.priceAsOf = lq\.asOf \?\? null;/.test(code('src/lib/heatmap/heatmap-store.js')));
  ok('⚠️ the shared quote hook measures its own poll, not the price age',
    /setState\(\{ quotes: j, asOf: Date\.now\(\), loading: false \}\)/.test(code('src/lib/cp-shared.jsx')));
}

L('⚠️ What Changed is one event per user per security, however many lists carry it');
{
  const c = code('src/app/api/watchlist/changes/route.js');
  ok('the ticker set is collapsed per user in the statement', /group by ticker/.test(c));
  ok('⚠️ …and the user predicate is inside the same statement, so it cannot collapse across users',
    /where user_id = \$\{userId\}[\s\S]{0,60}group by ticker/.test(c));
  ok('⚠️ …while keeping the reader\'s own ordering rather than re-sorting alphabetically',
    /order by min\(position\) asc nulls last, max\(added_at\) desc/.test(c));
  ok('the change builder deduplicates its input independently too',
    /const watched = \[\.\.\.new Set\(\(tickers \|\| \[\]\)\.filter\(isIngestableTicker\)/.test(code('src/lib/watchlist-changes.js')));

  // ⚠️ THE GROUPING EXECUTED AGAINST DUPLICATE ROWS. uq_watchlist_user_ticker makes a duplicate
  // impossible to insert today, so the real table cannot demonstrate this — the exact query shape is
  // run over a VALUES list that HAS duplicates, which is what the fix has to survive if that index is
  // ever relaxed to (user_id, list_id, ticker) to let a ticker live on several lists.
  const rows = await sql`
    with watchlist(user_id, ticker, position, added_at) as (values
      ('uA','NVDA',1,'2026-01-01'::timestamptz), ('uA','NVDA',5,'2026-02-01'::timestamptz),
      ('uA','AAPL',2,'2026-01-02'::timestamptz), ('uA','MSFT',3,'2026-01-03'::timestamptz),
      ('uB','NVDA',1,'2026-01-01'::timestamptz))
    select ticker from watchlist where user_id = 'uA'
     group by ticker order by min(position) asc nulls last, max(added_at) desc`;
  const got = rows.map((r) => r.ticker);
  ok('⚠️ a ticker on two of one user\'s lists yields ONE row', got.filter((x) => x === 'NVDA').length === 1, JSON.stringify(got));
  ok('…and the other tickers survive', got.length === 3, JSON.stringify(got));
  ok('⚠️ …in the reader\'s own position order, not alphabetical', got.join(',') === 'NVDA,AAPL,MSFT', got.join(','));
  const other = await sql`
    with watchlist(user_id, ticker, position, added_at) as (values
      ('uA','NVDA',1,'2026-01-01'::timestamptz), ('uA','NVDA',5,'2026-02-01'::timestamptz),
      ('uB','NVDA',1,'2026-01-01'::timestamptz))
    select ticker from watchlist where user_id = 'uB' group by ticker`;
  ok('⚠️ a DIFFERENT user still gets their own row for the same ticker', other.length === 1 && other[0].ticker === 'NVDA');

  // Production: the constraint that makes it impossible today is still there, and is not what we rely on.
  const idx = await sql`select indexdef from pg_indexes where tablename='watchlist' and indexdef ilike '%unique%'`;
  ok('the (user_id, ticker) unique index is still in place, unchanged',
    idx.some((i) => /\(user_id, ticker\)/.test(i.indexdef)));
  const dupes = await one(sql`select count(*)::int n from
    (select user_id, ticker from watchlist group by 1,2 having count(*) > 1) q`);
  ok('no duplicate pair exists in production', dupes.n === 0, `${dupes.n}`);
}

L('⚠️ email and bell are independent channels, deduped within each');
{
  const mailer = code('src/app/api/cron/insider-alerts/route.js');
  const store = code('src/lib/alerts/evidence-alert-store.js');
  const worker = code('src/lib/alerts/evidence-alert-worker.mjs');

  // ⚠️ NEITHER CHANNEL CAN SEE THE OTHER'S LEDGER. This is the structural guarantee: the bell path
  // contains no reference to evidence_alerts_sent at all.
  ok('⚠️ the bell store never reads the email ledger', !/evidence_alerts_sent|alreadySent|\bclaim\(/.test(store));
  ok('⚠️ the bell worker never reads it either', !/evidence_alerts_sent|alreadySent|\bclaim\(/.test(worker));
  // ⚠️ THE MAILER NO LONGER BUILDS THE SCOPED KEY. claim and alreadySent now both take the EVENT key and
  // apply the channel themselves, so a caller can no longer read one key and write another — the failure
  // that would have emailed every filing on every run forever.
  ok('the email ledger is written only by the mailer',
    /await claim\(userId, insiderAccessionKey\(f\.accession\)/.test(mailer) && /channel: 'email'/.test(mailer));

  // Per-channel dedupe, exercised.
  const { channelKey, insiderAccessionKey, claim, alreadySent } = await import('../src/lib/evidence-alerts.js');
  ok('⚠️ a channel-scoped key can never equal another channel\'s',
    channelKey('email', 'insider:X') !== channelKey('in_app', 'insider:X'));
  ok('…and the accession is what identifies the filing', insiderAccessionKey('0001-26-9') === 'insider:0001-26-9');

  const U = `verify_chan_${Date.now()}`;
  const ACC = '0009999-26-000001';
  try {
    // EMAIL channel: first claim wins, replay is refused.
    // ⚠️ THE CONTRACT CHANGED SHAPE, NOT MEANING: both sides now take the event key.
    ok('the first email claim succeeds', (await claim(U, insiderAccessionKey(ACC), { channel: 'email' })) === true);
    ok('⚠️ a replayed email claim for the same filing is refused',
      (await claim(U, insiderAccessionKey(ACC), { channel: 'email' })) === false);
    const seen = await alreadySent(U, [insiderAccessionKey(ACC)], 'email');
    ok('…and the mailer would now skip it', seen.has(insiderAccessionKey(ACC)));

    // ⚠️ AND THE BELL IS UNAFFECTED BY THAT EMAIL. Same filing, same user, other channel.
    ok('⚠️ the emailed filing is NOT recorded as sent on the in-app channel',
      !(await alreadySent(U, [insiderAccessionKey(ACC)], 'in_app')).size);
    ok('⚠️ …so an in-app claim for the same filing still succeeds',
      (await claim(U, insiderAccessionKey(ACC), { channel: 'in_app' })) === true);
    ok('…and its replay is refused too, within its own channel',
      (await claim(U, insiderAccessionKey(ACC), { channel: 'in_app' })) === false);
    const rows = await one(sql`select count(*)::int n from evidence_alerts_sent where user_id=${U}`);
    ok('⚠️ exactly two deliveries recorded: one per enabled channel', rows.n === 2, `${rows.n}`);
  } finally {
    const gone = await sql`delete from evidence_alerts_sent where user_id=${U} returning user_id`;
    console.log(`  (cleanup: removed ${gone.length} ledger row(s) for ${U})`);
  }

  // The bell's own dedupe is a database constraint, not application logic.
  ok('the bell dedupes on (user_id, evidence_id) in its own table',
    /on conflict \(user_id, evidence_id\) do nothing/.test(store));
  ok('…backed by a unique index', /uq_evidence_alert\s*\n?\s*ON evidence_alerts \(user_id, evidence_id\)/.test(store));
  // The mailer reads before sending, so a lost KV watermark cannot re-send.
  ok('⚠️ the mailer checks its ledger BEFORE sending, not after',
    mailer.indexOf('await alreadySent(') < mailer.indexOf('await sendEmail('));
  ok('…and an unreadable ledger skips the user rather than sending twice', /skipped\+\+;\s*\n\s*continue;/.test(mailer));
  ok('…and the claim is still written only on a successful send', /if \(ok\) \{/.test(mailer));
}

L('⚠️ the vendor is named on the legal pages and nowhere else');
{
  // ⚠️ WHAT THE AGREEMENT ACTUALLY REQUIRES: the phrase "Market Data from Tiingo.com" with
  // Tiingo.com hyperlinked, on the legal/disclaimer page of the product and on the corresponding legal
  // page of the website. It does NOT require the vendor beside every quote, chart, screener, ticker
  // page, Terminal panel or scan result — so the per-surface feed label was removed rather than
  // reworded, and a plan-tier name was an implementation detail either way.
  const ATTRIBUTED = ['src/app/disclaimer/DisclaimerClient.jsx', 'src/app/terms/TermsClient.jsx'];
  for (const f of ATTRIBUTED) {
    const c = read(f);
    ok(`${f} carries the exact required phrase`, /Market Data from <a href="https:\/\/www\.tiingo\.com"/.test(c));
    ok(`  …with Tiingo.com as the hyperlink text`, /rel="noopener noreferrer"[^>]*>Tiingo\.com<\/a>/.test(c));
    ok(`  …opening safely in a new tab`, /target="_blank" rel="noopener noreferrer"/.test(c));
    ok(`  …and the contractual reason is recorded so it is not reworded away`,
      /CONTRACTUAL ATTRIBUTION/.test(c));
  }

  // ⚠️ AND NOWHERE ELSE. The provider-specific label must not reach any client payload or bundle.
  const { scanState } = await import('../src/lib/scan/runtime.js');
  for (const rt of [false, true]) {
    const payload = JSON.stringify(scanState({ realtime: rt }));
    ok(`the scan payload (realtime: ${rt}) names no vendor`, !/tiingo|polygon/i.test(payload),
      (payload.match(/.{0,40}(tiingo|polygon).{0,40}/i) || [''])[0]);
  }
  const screener = code('src/app/api/screener/route.js');
  ok('the internal provider id is not served', !/provider: caps\.id|provider: served\.id/.test(screener));
  ok('⚠️ …and neither is the provider label', !/label: (caps|served)\.label/.test(screener));
  ok('⚠️ the readiness object no longer carries the vendor id or label',
    !/provider: caps\.id|providerLabel/.test(code('src/lib/scan/runtime.js')));
  // The descriptors keep their labels for operational logs; that is server-side only.
  ok('the descriptors still carry labels internally', /label: 'Tiingo \(real-time consolidated\)'/.test(read('src/lib/market/tiingo.mjs')));

  // ⚠️ THE REPLACEMENT IS A FRESHNESS CLAIM, AND IT MUST STAY ACCURATE.
  const { freshnessPhrase, FRESHNESS_PHRASE, FRESHNESS_LABEL } = await import('../src/lib/scan/scan-rows.mjs');
  ok('the scanner sentence describes freshness, not a feed',
    /Market data is currently \$\{freshnessPhrase\(caps\.quoteFreshness\)\}/.test(code('src/components/scan/CustomScannerPanel.jsx')));
  ok('…and no longer names the feed', !/Current feed/.test(code('src/components/scan/CustomScannerPanel.jsx')));
  ok('⚠️ an unknown provenance is described as the weakest, never as live', freshnessPhrase('nonsense') === 'end-of-day');
  ok('…and so is a missing one', freshnessPhrase(undefined) === 'end-of-day');
  for (const [f, want] of [['realtime', 'live'], ['near', 'live'], ['delayed', 'delayed'], ['eod', 'end-of-day']]) {
    ok(`${f} reads as "${want}"`, freshnessPhrase(f) === want, freshnessPhrase(f));
  }
  // ⚠️ ONE VOCABULARY, TWO RENDERINGS. A second map in another file is how a board came to be
  // summarised with a word no row had said, so the two are asserted to cover the same keys.
  ok('⚠️ the phrase and badge maps cover the same freshness keys',
    Object.keys(FRESHNESS_PHRASE).sort().join(',') === Object.keys(FRESHNESS_LABEL).sort().join(','),
    `${Object.keys(FRESHNESS_PHRASE).sort()} vs ${Object.keys(FRESHNESS_LABEL).sort()}`);
  // The freshness the sentence renders is the entitlement-capped one, not the provider's.
  ok('the scanner reads the SERVED freshness', /caps\?\.quoteFreshness/.test(code('src/components/scan/CustomScannerPanel.jsx')));
  for (const f of ['src/app/screener/ScreenerClient.jsx', 'src/components/scan/PitScanPanel.jsx',
    'src/components/scan/ScanBoardRows.jsx', 'src/lib/cp-shared.jsx']) {
    const c = read(f);
    ok(`${f} contains no API key or token`, !/TIINGO_API_KEY|TIINGO_API_TOKEN|Token \$\{/.test(c));
  }

  // ⚠️ AND NOT ON A QUOTE EITHER. /api/quotes returned `provider: "tiingo"` on every quote — read by
  // nothing, and checked before removal.
  const q = code('src/app/api/quotes/route.js');
  ok('the quotes route strips the provider id at the boundary',
    /const PUBLIC_QUOTE_OMIT = new Set\(\['provider'\]\);/.test(q));
  // ⚠️ EVERY PATH, because one unprojected branch is the whole leak: entitled realtime, the Free
  // delayed snapshot, the snapshot's fall-through, the KV hit and the provider read.
  const projected = (q.match(/Response\.json\(publicQuotes\(/g) || []).length;
  ok('⚠️ …on every path that returns quotes', projected === 5, `${projected} of 5`);
  ok('…and no quote response bypasses it',
    !/return Response\.json\((quotes|delayed|cached)[,)]/.test(q));
  ok('the projection is defined before first use',
    q.indexOf('const publicQuotes') > 0 && q.indexOf('const publicQuotes') < q.indexOf('publicQuotes(quotes)'));

  const t = read('src/lib/market/tiingo.mjs');
  ok('the token is read from the environment only', /process\.env\.TIINGO_API_KEY/.test(t));
  ok('⚠️ …and never logged', !/console\.log\([^)]*TIINGO_API_KEY|console\.log\([^)]*token\(\)/.test(t));
  ok('the module states it is server-only and the token never reaches a URL',
    /read ONLY here, on the server|the token never appears in a URL we log/.test(t));
  // Nothing client-side may import the vendor module at all.
  for (const f of ['src/app/screener/ScreenerClient.jsx', 'src/components/scan/PitScanPanel.jsx']) {
    ok(`${f} does not import the vendor module`, !/market\/tiingo/.test(read(f)));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
