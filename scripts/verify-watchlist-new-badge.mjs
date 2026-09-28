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
  const evidence = (type, at) => ({ family: 'catalyst', type, direction: null, summary: type, publicTime: at });

  const two = await watchlistChanges(['META'], {
    since: days(1), now: NOW,
    ...fake({ META: [evidence('mgmt_ceo_departure', mins(300)), evidence('mgmt_ceo_appointed', mins(110))] }),
  });
  ok('⚠️ two qualifying events show 2, not 1', two.byTicker.META?.length === 2, JSON.stringify(two.byTicker.META?.length));
  ok('...newest first', two.changes[0].type === 'mgmt_ceo_appointed');

  const one = await watchlistChanges(['NVDA'], {
    since: days(1), now: NOW, ...fake({ NVDA: [evidence('cap_buyback_authorized', mins(90))] }),
  });
  ok('one qualifying event shows 1', one.byTicker.NVDA?.length === 1);

  const none = await watchlistChanges(['SPY'], { since: days(1), now: NOW, ...fake({}) });
  ok('no qualifying events shows no badge at all', !none.byTicker.SPY && none.changes.length === 0);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
