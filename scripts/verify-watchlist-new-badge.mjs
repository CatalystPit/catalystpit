// THE WATCHLIST "N NEW" BADGE — does it represent new MATERIAL information on your names?
//
// ⚠️ THE FAILURE THIS SUITE EXISTS FOR, measured in production on 2026-09-28.
//
// NVIDIA authorised an additional $150 BILLION of share repurchases. Catalyst Pit ingested it
// within minutes — Bloomberg at 11:16 UTC, then WSJ, FT, GlobeNewswire and more, all correctly
// tagged NVDA — and the Evidence Engine, asked directly, classified it `cap_buyback_authorized`.
// The watchlist badge showed NOTHING for NVDA. Meanwhile MSTR showed "1 NEW" for a routine Item
// 7.01/8.01 filing, and META's CEO change was invisible too.
//
// The cause was not classification and not ingestion. candidateTickers() — the prefilter that
// decides which names are worth asking the engine about — queried four filing tables and never
// primary_events, so for a company whose news arrives by wire rather than by 8-K the engine was
// NEVER CALLED. Its own contract says it must never miss, only over-include; it was missing a whole
// family. NVIDIA had filed no 8-K at all (its latest was 2026-09-03), so nothing else could save it.
//
// The second half was freshness: the hook fetched exactly once on mount, so even a correct answer
// only arrived if you reloaded the page.
//
// Run: node --loader ./scripts/ext-resolve-loader.mjs scripts/verify-watchlist-new-badge.mjs
//
// The loader resolves the extensionless './db' imports the way Next's bundler does. NO DATABASE IS
// TOUCHED: the engine is driven through its own `ctx` seam with real production headlines, and the
// assembly through its `_candidates` / `_resolve` seams, so the suite runs anywhere. The connection
// string below exists only because db.js constructs a client at module load; no query is issued.

import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ||= 'postgres://verify:verify@127.0.0.1/verify';
const { pressReleaseEvidence } = await import('../src/lib/evidence/resolve.js');
const { watchlistChanges } = await import('../src/lib/watchlist-changes.js');
const { eligibleForNew, countNew, newEventKey, NEW_MATERIALITY_FLOOR, NEW_FAMILIES } =
  await import('../src/lib/watchlist-new.mjs');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
// Matched against CODE, never prose: the comments in these files describe the bug in detail and
// would satisfy half of these assertions on their own.
const code = (s) => s.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n');

const NOW = Date.parse('2026-09-28T18:00:00Z');
const mins = (m) => new Date(NOW - m * 60_000).toISOString();
const days = (d) => new Date(NOW - d * 86_400_000).toISOString();

// The engine reads press releases through a ctx seam, so real headlines can be driven through the
// real classifier with no database. Every fixture below is a production headline.
const wire = (rows) => ({ rows: () => rows });
const ev = (rows, ticker = 'NVDA') => pressReleaseEvidence(ticker, { now: NOW, ctx: wire(rows) });
const row = (o) => ({
  seq: o.seq ?? 1, source: o.source, headline: o.headline, summary: o.summary ?? null,
  published_at: o.at, canonical_url: null, original_url: o.url ?? null, content_hash: o.hash ?? String(o.seq ?? 1),
});

// ── A. A MATERIAL ANNOUNCEMENT BECOMES EVIDENCE ──────────────────────────────
L('A. a material buyback authorisation is new material information');
{
  const e = await ev([
    row({ seq: 1, source: 'BLOOMBERG', headline: 'Nvidia Boosts Share Buyback Authorization by $150 Billion', at: mins(90) }),
  ]);
  ok('⚠️ the $150bn repurchase authorisation is evidence', e.length === 1, JSON.stringify(e.map((x) => x.type)));
  ok('⚠️ ...classified as a buyback authorisation', e[0]?.type === 'cap_buyback_authorized', e[0]?.type);
  ok('...carrying the publication time, not an ingest time', e[0]?.publicTime === mins(90));
}

// ── B. COMMENTARY IS NOT AN EVENT ────────────────────────────────────────────
L('B. a generic article about a company is not new material information');
{
  const derivative = await ev([
    row({ seq: 2, source: 'SEEKINGALPHA', headline: "Nvidia's $150B Repurchase News: What To Do About Its Trillion-Dollar Problem", at: mins(80) }),
  ]);
  ok('⚠️ an aggregator column about the event is not the event', derivative.length === 0,
    JSON.stringify(derivative.map((x) => x.type)));

  // ⚠️ THE SOURCE GATE, ISOLATED. The same words that DO become evidence from a newsroom must not
  // become evidence from an aggregator — otherwise this only tests the classifier's vocabulary.
  const sameWordsWrongSource = await ev([
    row({ seq: 3, source: 'SEEKINGALPHA', headline: 'NVIDIA Announces $150 Billion Share Repurchase Authorization', at: mins(75) }),
  ]);
  ok('⚠️ ...even when it prints the announcement verbatim', sameWordsWrongSource.length === 0,
    JSON.stringify(sameWordsWrongSource.map((x) => x.type)));

  // ⚠️ AND THE ROUNDUP GATE, ISOLATED, from a source that IS allowed. A column listing several
  // companies is the record of none of them; this one classified as an NVDA buyback.
  const roundup = await ev([
    row({ seq: 4, source: 'BLOOMBERG', headline: 'Midday Need to Know: Nvidia expands buyback, yields climb & more', at: mins(70) }),
  ]);
  ok('⚠️ a market-wrap naming the company is not an event either', roundup.length === 0,
    JSON.stringify(roundup.map((x) => x.type)));

  // The column tail on its own, with no column name to fall back on — "…, X and more" is the
  // Bloomberg/Reuters roundup shape and names several unrelated companies.
  const tail = await ev([
    row({ seq: 5, source: 'BLOOMBERG', headline: 'Nvidia expands buyback, Paramount settles merger lawsuit & more', at: mins(65) }),
  ]);
  ok('⚠️ ...and the roundup TAIL alone is enough to refuse it', tail.length === 0,
    JSON.stringify(tail.map((x) => x.type)));

  // A Form 144 is a notice of intent to sell. At large issuers officers file them continuously
  // under 10b5-1 plans, and scoring the residual tier at the floor made it the commonest reason a
  // mega-cap would interrupt someone — AAPL, META and NVDA all carried one in a single week.
  ok('⚠️ a routine Form 144 is below the badge floor',
    !eligibleForNew({ family: 'insider', type: 'sec_144_proposed_sale', materiality: 0.55,
      publicTime: mins(60), ticker: 'XXX' }),
    'a notice of intent to sell is not a company decision');
  // ⚠️ AND THE ENGINE ACTUALLY SCORES IT THERE. Asserting the floor alone would pass however the
  // residual tier were scored — the two halves have to be pinned together.
  ok('⚠️ ...because the residual tier is scored below the floor, not at it',
    /value != null && value >= 50_000_000 \? 0\.70 : 0\.55,/.test(code(read('../src/lib/evidence/resolve.js'))),
    'the sized tiers stay where they were; only "nothing distinguishes this one" drops');
}

// ── H. ONE EVENT, HOWEVER MANY OUTLETS CARRY IT ──────────────────────────────
L('H. the same announcement from six outlets counts once');
{
  // ⚠️ EVERY FIXTURE HERE CLASSIFIES ON ITS OWN. Copies that the classifier happens to refuse would
  // make this pass whether or not anything de-duplicates, which is exactly how a test like this
  // ends up asserting nothing — mutation-testing caught that first time round.
  const copies = [
    row({ seq: 10, source: 'GLOBENEWSWIRE', headline: 'NVIDIA Announces $150 Billion Share Repurchase Authorization', at: mins(120) }),
    row({ seq: 11, source: 'BLOOMBERG', headline: 'Nvidia Boosts Share Buyback Authorization by $150 Billion', at: mins(118) }),
    row({ seq: 12, source: 'WSJ', headline: 'Nvidia Board Authorizes $150 Billion Share Repurchase', at: mins(116) }),
  ];
  for (const c of copies) {
    const solo = await ev([c]);
    ok(`  (control) "${String(c.headline).slice(0, 40)}…" is an event on its own`,
      solo.length === 1 && solo[0].type === 'cap_buyback_authorized', JSON.stringify(solo.map((x) => x.type)));
  }
  const many = await ev(copies);
  ok('⚠️ three outlets carrying one announcement produce ONE badge item', many.length === 1, `${many.length}`);
  ok('...and it is the buyback', many[0]?.type === 'cap_buyback_authorized');
}

// ── I. HISTORY IS NOT NEWS ───────────────────────────────────────────────────
L('I. an old event does not become new');
{
  const stale = await ev([
    row({ seq: 20, source: 'BLOOMBERG', headline: 'Nvidia Boosts Share Buyback Authorization by $150 Billion', at: days(200) }),
  ]);
  ok('⚠️ a buyback announced 200 days ago is not new material information', stale.length === 0,
    JSON.stringify(stale.map((x) => x.publicTime)));
}

// ── THE PREFILTER — THE ACTUAL ROOT CAUSE ────────────────────────────────────
L('the prefilter asks about wire events, not only filings');
{
  const src = code(read('../src/lib/watchlist-changes.js'));
  ok('⚠️ primary_events is one of the source branches', /from primary_events, unnest\(tickers\)/.test(src),
    'without this branch the engine is never called for a company that files no 8-K');
  ok('⚠️ ...clocked on published_at, never on when we ingested it',
    /published_at >= \$\{sinceIso\}::timestamptz/.test(src) && !/primary_events[\s\S]{0,200}inserted_at/.test(src));
  ok('⚠️ ...and gated by the ENGINE\'S OWN source vocabulary, not a second list',
    /import \{ ISSUER_WIRE, NEWS_DESK \} from '\.\/evidence\/company-events\.mjs'/.test(src)
    && /\[\.\.\.ISSUER_WIRE, \.\.\.NEWS_DESK\]/.test(src),
    'a private copy of the source list is how two surfaces start disagreeing');
  ok('the four filing families are still there',
    /from insider_trades/.test(src) && /from eightk_filings/.test(src)
    && /from congress_trades/.test(src) && /from fund_holdings/.test(src));
}

// ── D / G / COUNTING — assembled through the documented seams ────────────────
L('D. the count is the real number of qualifying events');
{
  const fake = (byTicker) => ({
    _candidates: async (tickers) => tickers.filter((t) => byTicker[t]?.length),
    _resolve: async (t) => ({ evidence: byTicker[t] || [], failedFamilies: [] }),
  });
  const evidence = (type, at, materiality = 0.70) => ({ ticker: 'XXX', family: 'catalyst', type, materiality, direction: null, summary: type, publicTime: at });

  // ⚠️ TWO GENUINELY DIFFERENT CATALYSTS. A CEO departure and the appointment that came with it
  // would be ONE event by design — see the collapse tests below — so using that pair here would
  // have asserted the opposite of what the system should do.
  const two = await watchlistChanges(['META'], {
    since: days(1), now: NOW,
    ...fake({ META: [evidence('mgmt_ceo_departure', mins(300), 0.85), evidence('ma_agreement', mins(110), 0.88)] }),
  });
  ok('⚠️ two qualifying events show 2, not 1', two.byTicker.META?.length === 2, JSON.stringify(two.byTicker.META?.length));
  ok('...newest first', two.changes[0].type === 'ma_agreement');

  const one = await watchlistChanges(['NVDA'], {
    since: days(1), now: NOW, ...fake({ NVDA: [evidence('cap_buyback_authorized', mins(90))] }),
  });
  ok('one qualifying event shows 1', one.byTicker.NVDA?.length === 1);

  const none = await watchlistChanges(['SPY'], { since: days(1), now: NOW, ...fake({}) });
  ok('no qualifying events shows no badge at all', !none.byTicker.SPY && none.changes.length === 0);

  // ⚠️ THE CONTRACT IS APPLIED HERE, NOT ONLY DEFINED. The engine legitimately returns the routine
  // filing alongside the material one; the badge must count one of them.
  const mixed = await watchlistChanges(['XXX'], {
    since: days(1), now: NOW,
    ...fake({ XXX: [evidence('cap_buyback_authorized', mins(90), 0.70),
                    evidence('sec_8k_other', mins(80), 0.45),
                    evidence('sec_144_proposed_sale', mins(70), 0.55)] }),
  });
  ok('⚠️ the badge applies the eligibility contract to what the engine returns',
    mixed.byTicker.XXX?.length === 1 && mixed.byTicker.XXX[0].type === 'cap_buyback_authorized',
    JSON.stringify(mixed.byTicker.XXX?.map((x) => x.type)));

  // G — the engine only ever reads the canonical `tickers` column, so a name the wire never
  // attached cannot acquire a badge here.
  const other = await watchlistChanges(['AMD'], {
    since: days(1), now: NOW, ...fake({ NVDA: [evidence('cap_buyback_authorized', mins(90))] }),
  });
  ok('⚠️ G. an event belonging to another company creates no badge', other.changes.length === 0);

  ok('an unlistable ticker never reaches the engine', (await watchlistChanges(['NONE'], {
    since: days(1), now: NOW, _candidates: async () => { throw new Error('prefilter must not be called'); },
    _resolve: async () => { throw new Error('engine must not be called'); },
  })).changes.length === 0);
}

// ── C. IT UPDATES WHILE THE PAGE STAYS OPEN ──────────────────────────────────
L('C. the badge refreshes without a page reload');
{
  const ui = code(read('../src/components/WatchlistChanges.jsx'));
  ok('⚠️ it polls rather than fetching once on mount', /const POLL_ACTIVE = /.test(ui) && /setTimeout\(async \(\) => \{ await load\(\); if \(alive\) schedule\(\); \}/.test(ui),
    'fetching once on mount is why a watchlist left open all day never showed the buyback');
  ok('⚠️ ...at a slower cadence when the tab is hidden',
    /document\.visibilityState === 'hidden'/.test(ui) && /POLL_HIDDEN/.test(ui));
  ok('⚠️ ...and re-reads the moment the tab comes back',
    /document\.addEventListener\('visibilitychange', wake\)/.test(ui) && /const wake = \(\) =>/.test(ui));
  ok('a failed refresh keeps the answer already on screen',
    (ui.match(/setData\(\(d\) => d \|\| \{ changes: \[\], byTicker: \{\} \}\)/g) || []).length === 2,
    'BOTH the bad-status path and the thrown path must preserve it; blanking reads as "nothing happened"');

  // ── E / F. READ STATE ──
  ok('⚠️ E. reading is a deliberate act — only markSeen advances the watermark',
    /const markSeen = useCallback\(async \(\) => \{[\s\S]{0,260}method: 'POST'/.test(ui));
  ok('⚠️ ...and the poll only ever reads, so a visible badge is never silently consumed',
    !/method: 'POST'[\s\S]{0,200}schedule\(\)/.test(ui)
    && (ui.match(/method: 'POST'/g) || []).length === 1);
  ok('⚠️ ...and a poll in flight cannot resurrect what was just cleared',
    /genRef\.current \+= 1;/.test(ui) && /gen !== genRef\.current/.test(ui),
    'the badge reappearing a second after being dismissed is the race this closes');
}

// ── F / J. THE WATERMARK IS PER USER ─────────────────────────────────────────
L('F/J. read state is per account, and new events after it return');
{
  const route = code(read('../src/app/api/watchlist/changes/route.js'));
  ok('⚠️ J. the watermark key is per user', /seenKey = \(userId\) =>/.test(route)
    && /catalystpit:watchlist:seen:\$\{userId\}/.test(route));
  ok('⚠️ ...and the watched list is the signed-in user\'s own', /eq\(watchlist\.userId, userId\)/.test(route));
  ok('⚠️ ...and the answer is never shared-cached', /private, no-store/.test(route));
  ok('⚠️ F. "since" is a moving watermark, so a later event returns again',
    /DEFAULT_LOOKBACK_MS/.test(route) && /last_seen/.test(route),
    'a watermark that only ever cleared would make the badge a one-shot');

  const lib = code(read('../src/lib/watchlist-changes.js'));
  ok('⚠️ I. the engine applies the exact since cut after the prefilter',
    /_resolve\(ticker, \{ now, since: sinceIso \}\)/.test(lib));
}

// ── THE ELIGIBILITY CONTRACT ─────────────────────────────────────────────────
//
// ⚠️ ONE FUNCTION, EVERY FAMILY, EVERY TICKER. The badge used to mean "the engine returned
// something", and the engine correctly returns everything it knows — including the routine Item
// 8.01 filing that badged MSTR while NVIDIA's $150bn buyback badged nothing. Eligibility is now a
// decision the watchlist makes on top of the engine, in one place, with no per-family rule and no
// knowledge of any company's name.

L('the universal eligibility contract');
{
  const at = (iso, over = {}) => ({
    ticker: 'XYZ', family: 'catalyst', type: 'cap_buyback_authorized',
    materiality: 0.70, publicTime: iso, ...over,
  });
  const NOW2 = Date.parse('2026-09-28T18:00:00Z');
  const opt = { now: NOW2 };
  const hoursAgo = (h) => new Date(NOW2 - h * 3600e3).toISOString();
  const daysAgo = (d) => new Date(NOW2 - d * 86400e3).toISOString();

  ok('a material, fresh, well-formed event qualifies', eligibleForNew(at(hoursAgo(2)), opt));
  ok(`⚠️ H. a routine filing does not — materiality below ${NEW_MATERIALITY_FLOOR}`,
    !eligibleForNew(at(hoursAgo(2), { type: 'sec_8k_other', materiality: 0.45 }), opt),
    'this exact event is what badged MSTR while a $150bn buyback badged nothing');
  ok('an event exactly at the floor qualifies', eligibleForNew(at(hoursAgo(2), { materiality: NEW_MATERIALITY_FLOOR }), opt));
  ok('⚠️ an unscored event never qualifies — unjudged is not the same as material',
    !eligibleForNew(at(hoursAgo(2), { materiality: undefined }), opt)
    && !eligibleForNew(at(hoursAgo(2), { materiality: null }), opt));
  ok('a family the badge does not speak for is silent',
    !eligibleForNew(at(hoursAgo(2), { family: 'market' }), opt));
  ok('every named family is one the engine actually produces',
    NEW_FAMILIES.every((f) => ['catalyst', 'insider', 'congress', 'institution'].includes(f)));
  ok('⚠️ I. an old event is not new', !eligibleForNew(at(daysAgo(200)), opt));
  ok('...and the window follows the family — a 40-day congressional disclosure still counts',
    eligibleForNew(at(daysAgo(40), { family: 'congress', type: 'congress_multi', materiality: 0.65 }), opt)
    && !eligibleForNew(at(daysAgo(40), { family: 'catalyst' }), opt));
  ok('a publication time in the future is never news', !eligibleForNew(at(new Date(NOW2 + 86400e3).toISOString()), opt));
  ok('nonsense in is nothing out', !eligibleForNew(null, opt) && !eligibleForNew('x', opt) && !eligibleForNew({}, opt));

  // ── L / M. ONE REAL EVENT, ONE NEW ──
  const copy = (over) => at(hoursAgo(3), over);
  const six = ['BLOOMBERG', 'REUTERS', 'WSJ', 'FT', 'CNBC', 'GLOBENEWSWIRE'].map((s, i) =>
    copy({ source: s, publicTime: new Date(NOW2 - (3 * 3600e3) - i * 60_000).toISOString() }));
  ok('⚠️ L. six outlets carrying one announcement count ONCE', countNew(six, opt).count === 1, `${countNew(six, opt).count}`);
  ok('⚠️ M. two DIFFERENT catalysts on the same day count twice',
    countNew([copy({}), copy({ type: 'ma_agreement', materiality: 0.88 })], opt).count === 2);
  ok('⚠️ ...and the same kind of event on two different days counts twice',
    countNew([at(hoursAgo(3)), at(daysAgo(4))], opt).count === 2);
  ok('⚠️ one earnings arriving as an 8-K AND a press release counts once',
    countNew([copy({ type: 'sec_8k_results', materiality: 0.70 }), copy({ type: 'earn_results', materiality: 0.70 })], opt).count === 1,
    'two shapes of one quarter is the duplicate that showed COST 2 NEW');
  ok('⚠️ a CEO transition is one decision, not a departure plus an appointment',
    countNew([copy({ type: 'mgmt_ceo_departure', materiality: 0.85 }),
              copy({ type: 'mgmt_ceo_appointed', materiality: 0.70 })], opt).count === 1);
  ok('...and the line kept is the more material half',
    countNew([copy({ type: 'mgmt_ceo_appointed', materiality: 0.70 }),
              copy({ type: 'mgmt_ceo_departure', materiality: 0.85 })], opt).events[0].type === 'mgmt_ceo_departure');
  ok('⚠️ K. the same event on two tickers is two separate counts, one each',
    newEventKey(copy({ ticker: 'AAA' })) !== newEventKey(copy({ ticker: 'BBB' })));
  ok('T. nothing qualifying means a count of zero', countNew([], opt).count === 0
    && countNew([at(hoursAgo(1), { materiality: 0.2 })], opt).count === 0);

  // ── R / S. NO TICKER IS SPECIAL ──
  // ⚠️ THE SAME EVENT, THE SAME ANSWER, WHATEVER THE SYMBOL IS. A large cap, a micro cap and a
  // company whose ticker is an ordinary English word all go through one contract; there is no cap
  // threshold, no liquidity test and no symbol vocabulary anywhere in it.
  const shapes = ['NVDA', 'CHAI', 'HERE', 'ON', 'ALL', 'BRK.B', 'QNME'];
  const counts = shapes.map((t) => countNew([at(hoursAgo(2), { ticker: t })], opt).count);
  ok('⚠️ R/S. every symbol shape gets the identical answer', counts.every((c) => c === 1), JSON.stringify(counts));
}

L('the badge has no ticker-specific behaviour anywhere');
{
  const files = ['../src/lib/watchlist-new.mjs', '../src/lib/watchlist-changes.js',
    '../src/components/WatchlistChanges.jsx', '../src/app/api/watchlist/changes/route.js'];
  for (const f of files) {
    const src = code(read(f));
    const literals = (src.match(/['"][A-Z]{2,5}['"]/g) || [])
      .filter((s) => !/^['"](GET|POST|PUT|DELETE|ALL|NONE|USD|SEC|DOJ|FDA|FTC|CFTC|WSJ|FT|CNBC|NEW|UTC)['"]$/.test(s));
    ok(`${f.split('/').pop()} names no company`, literals.length === 0, literals.join(' '));
  }
  // A positive control: the pattern does find such literals when they exist.
  ok('(control) the detector would catch a hardcoded ticker',
    (code("const x = 'NVDA';").match(/['"][A-Z]{2,5}['"]/g) || []).length === 1);
}

// ── THE READ PATH HAS NO CAP, AND SAYS WHEN IT DOES NOT KNOW ─────────────────
//
// ⚠️ THE CORRECTNESS BUG A CAP IS. Resolving one ticker through the Evidence Engine cost ~1,350ms
// and SEVEN queries, so a sixty-name list cost ~420 queries and twenty-two seconds — per user, per
// minute — and was bounded by MAX_RESOLVE. Measured on the 100 largest issuers, 81 were nominated,
// 60 resolved, and the other 21 were returned to the user as "nothing happened". That is not a
// performance limit; it is a wrong answer. None of that work depends on the reader, so it now runs
// once per event and the read is one indexed query with nothing to truncate.
L('the read path evaluates every watched security');
{
  const lib = code(read('../src/lib/watchlist-changes.js'));
  const mat = code(read('../src/lib/watchlist-materialise.mjs'));
  const route = code(read('../src/app/api/watchlist/changes/route.js'));
  const cron = code(read('../src/app/api/cron/watchlist-events/route.js'));

  ok('⚠️ the endpoint reads the materialised view, not the engine',
    /watchlistChangesFast\(tickers, \{ since \}\)/.test(route) && !/MAX_RESOLVE/.test(route),
    'the fan-out is what forced the cap');
  ok('⚠️ ...with one indexed query over (ticker, public_time)',
    /from watchlist_events/.test(lib) && /where ticker in \(\$\{list\}\) and public_time > /.test(lib));
  // Anchored to the fast path's OWN return shape: the legacy function also returns a `truncated`
  // field, and a loose match was satisfied by its empty-list early return.
  ok('⚠️ ...and never truncates',
    /since: sinceIso, scanned: watched\.length, resolved: watched\.length, truncated: false, failed: \[\],/.test(lib),
    'every watched security is evaluated, so there is nothing to cap');
  ok('the index the read pattern needs is declared',
    /CREATE INDEX IF NOT EXISTS idx_watchlist_events_read ON watchlist_events \(ticker, public_time DESC\)/.test(mat));
  ok('⚠️ one real event is one ROW, enforced by the database rather than by the counter',
    /CREATE UNIQUE INDEX IF NOT EXISTS uq_watchlist_events_key ON watchlist_events \(event_key\)/.test(mat)
    && /on conflict \(event_key\) do update/.test(mat));
  ok('⚠️ the materialiser uses the SAME engine and the SAME contract — no second classifier',
    /tickerEvidence\(ticker/.test(mat) && /countNew\(r\.evidence/.test(mat)
    && !/classifyCompanyEvent/.test(mat));
  ok('the expensive work is scheduled once per event, not per reader',
    /\/api\/cron\/watchlist-events/.test(JSON.stringify(JSON.parse(read('../vercel.json')).crons))
    && /buildWatchlistEvents/.test(cron));

  // ── TASK 6. UNKNOWN IS NOT ZERO ──
  ok('⚠️ the read reports its own coverage', /coverage: \{ fresh,/.test(lib));
  ok('⚠️ ...and freshness is a measured age, not an assumption',
    /const fresh = builtMs != null && \(now - builtMs\) <= STALE_AFTER_MS && !cov\.lastError;/.test(lib));
  const ui = code(read('../src/components/WatchlistChanges.jsx'));
  ok('⚠️ ...and a stale view is never rendered as "nothing happened"',
    /data\.coverage\.fresh === false/.test(ui) && /Still checking your names/.test(ui),
    'an unchecked security shown as silent is the same lie as an outage shown as silence');

  // ── the builder cannot skip work ──
  ok('⚠️ a capped run resumes where it stopped instead of repeating itself',
    /const pending = resumeAfter \? changed\.filter\(\(t\) => t > resumeAfter\) : changed;/.test(mat)
    && /resume_after/.test(mat),
    'without this, 726 changed names and a 400 cap repeated the same 400 forever');
  ok('⚠️ ...and the clock never advances over a failure or an unfinished sweep',
    /const advance = failed === 0 && complete;/.test(mat),
    'moving the cursor past a ticker that threw turns a transient error into a permanent hole');
  ok('the builder sorts, so "after the last name finished" is a stable position',
    /\(await changedTickersSince\(from\)\)\.sort\(\)/.test(mat));
  ok('the builder sweeps the whole universe, not one list',
    /export async function changedTickersSince\(since\)/.test(mat)
    && /from primary_events, unnest\(tickers\) as t/.test(mat));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
