// WHAT CHANGED ON YOUR NAMES — the watchlist change feed.
//
// Driven entirely by FIXTURES. watchlistChanges() takes an injected prefilter and resolver, so
// these assertions exercise the real assembly — ordering, the invalid-ticker gate, truncation,
// per-ticker indexing, failure reporting — without waiting for a filing to land or touching a
// database. The Evidence Engine's own output is already covered by verify-evidence.
//
//   node scripts/verify-watchlist-changes.mjs [--mutate=<mode>]

// ⚠️ NO DATABASE IS CONTACTED. The module imports the neon client at load time and neon() throws
// on a missing connection string, so a placeholder is set purely to let the import succeed. Every
// query path is replaced by a fixture below; if one were ever reached, this URL would fail loudly
// rather than silently reading production.
process.env.DATABASE_URL ||= 'postgres://verify:verify@127.0.0.1:1/verify';

import fs from 'node:fs';
const { watchlistChanges, MAX_RESOLVE, RESOLVE_CONCURRENCY, DEFAULT_LOOKBACK_MS } =
  await import('../src/lib/watchlist-changes.js');

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const read = (p) => fs.readFileSync(new URL(p, new URL('..', import.meta.url)), 'utf8');
// These files explain their own rules in prose, so "the code must not say X" has to be asked of
// the CODE. A comment stating that a line must never claim "buying now" is not such a claim.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const NOW = Date.parse('2026-09-20T18:00:00Z');
const ago = (h) => new Date(NOW - h * 3600e3).toISOString();
const SINCE = ago(48);

// Evidence exactly as the engine emits it — the shape verify-evidence already guarantees.
const ev = (o) => ({
  ticker: o.ticker, family: o.family, type: o.type,
  direction: o.direction ?? 'neutral', summary: o.summary,
  publicTime: o.publicTime, referencePeriod: o.referencePeriod ?? null,
  url: o.url ?? 'https://sec.gov/x',
});

const FIXTURES = {
  // A new Form 4 on a watched name.
  TELA: [ev({ ticker: 'TELA', family: 'insider', type: 'insider_buy_cluster',
    summary: 'Chief Executive Officer open-market purchase of $186K', publicTime: ago(6) })],
  // A material 8-K on another.
  AAOI: [ev({ ticker: 'AAOI', family: 'catalyst', type: 'sec_8k_delisting',
    summary: 'Delisting / listing-standard notice', publicTime: ago(2) })],
  // Congress, disclosed — and a 13F carrying its quarter.
  MSFT: [
    ev({ ticker: 'MSFT', family: 'congress', type: 'congress_multi',
      summary: '10 members of Congress disclosed trades', publicTime: ago(30) }),
    ev({ ticker: 'MSFT', family: 'institution', type: 'inst_breadth_up',
      summary: 'Institutional breadth rose', publicTime: ago(12), referencePeriod: '2026-06-30' }),
  ],
  QUIET: [],
};

const fakeCandidates = async (tickers) => tickers.filter((t) => (FIXTURES[t] || []).length > 0);
const fakeResolve = async (ticker, { since }) => ({
  // The engine applies the exact publicTime > since cut; the fixture mirrors it.
  evidence: (FIXTURES[ticker] || []).filter((e) => new Date(e.publicTime) > new Date(since)),
  failedFamilies: [],
});
const run = (tickers, opts = {}) => watchlistChanges(tickers, {
  since: SINCE, now: NOW, _candidates: fakeCandidates, _resolve: fakeResolve, ...opts,
});

L('=== TWO WATCHED TICKERS, A FORM 4 AND AN 8-K ===');
{
  const r = await run(['TELA', 'AAOI']);
  ok('both watched names report a change', r.changes.length === 2, JSON.stringify(r.changes.map((c) => c.ticker)));
  const tela = r.changes.find((c) => c.ticker === 'TELA');
  const aaoi = r.changes.find((c) => c.ticker === 'AAOI');
  ok('the Form 4 appears', mut('dropsinsider') ? false : !!tela && tela.family === 'insider');
  ok('…carrying the engine\'s own sentence, unreworded',
    tela?.summary === 'Chief Executive Officer open-market purchase of $186K', tela?.summary);
  ok('the 8-K appears', mut('dropscatalyst') ? false : !!aaoi && aaoi.family === 'catalyst');
  ok('…with its publication time', !!aaoi?.publicTime && aaoi.publicTime === ago(2));
  ok('every change links somewhere verifiable', r.changes.every((c) => c.url || c.tickerUrl));
  ok('every change links to its ticker page', r.changes.every((c) => c.tickerUrl === `/ticker/${c.ticker}`));

  // Newest first — a change feed ordered any other way buries what just happened.
  ok('changes are newest-first',
    mut('badorder') ? false : new Date(r.changes[0].publicTime) >= new Date(r.changes[1].publicTime),
    r.changes.map((c) => c.publicTime).join(' '));

  // The per-ticker index is what a row badge counts.
  ok('a per-ticker index is returned', r.byTicker.TELA?.length === 1 && r.byTicker.AAOI?.length === 1);
  ok('a name with nothing new is absent from the index', !('QUIET' in r.byTicker));
}

L('\n=== NOTHING NEW IS NOT A FAILURE ===');
{
  const r = await run(['QUIET']);
  ok('a quiet watchlist returns an empty list', r.changes.length === 0);
  ok('…and still reports what it scanned', r.scanned === 1);
  ok('…with no failures invented', r.failed.length === 0);
  const none = await run([]);
  ok('an empty watchlist resolves nothing at all', none.scanned === 0 && none.resolved === 0);
}

L('\n=== INVALID TICKERS NEVER APPEAR ===');
{
  // These are still in insider_trades until the cleanup script is run, and a watchlist row could
  // name one. They must not reach the engine, and must never render.
  const bad = ['NONE', 'N/A', 'NULL', '', '   ', '(CALX)', 'NYSE: VTEX', 'Z AND ZG'];
  const r = await run([...bad, 'TELA']);
  ok('only the valid name is scanned', mut('allowsinvalid') ? false : r.scanned === 1, `scanned ${r.scanned}`);
  ok('…and only it appears in changes', r.changes.every((c) => c.ticker === 'TELA'));
  ok('…no placeholder reaches the output',
    !r.changes.some((c) => ['NONE', 'N/A', 'NULL'].includes(String(c.ticker).toUpperCase())));
  const onlyBad = await run(bad);
  ok('a watchlist of only invalid tickers resolves nothing', onlyBad.scanned === 0 && onlyBad.changes.length === 0);

  // And the gate is the INGEST gate, so a real symbol the card rule would reject still works.
  const src = read('src/lib/watchlist-changes.js');
  ok('the gate used is isIngestableTicker', /isIngestableTicker/.test(src));
}

L('\n=== POINT-IN-TIME ===');
{
  const src = read('src/lib/watchlist-changes.js');
  // ⚠️ CONGRESS IS DISCLOSURE_DATE. A member's trade is not news until it is disclosed.
  ok('congress is filtered on disclosure_date',
    mut('txdate') ? false : /congress_trades[\s\S]{0,120}disclosure_date >=/.test(src));
  ok('…and transaction_date is never used as a clock',
    mut('txdate') ? false : !/transaction_date\s*>=/.test(src));
  ok('Form 4 uses filing_date', /insider_trades[\s\S]{0,120}filing_date >=/.test(src));
  ok('8-K uses filed_at', /eightk_filings[\s\S]{0,120}filed_at >=/.test(src));
  ok('13F uses filed_date, not the quarter', /f\.filed_date >=/.test(src));
  // ⚠️ NOT OUR INGEST CLOCK. inserted_at would present a backfill as breaking news.
  ok('no source is filtered on inserted_at',
    mut('ingestclock') ? false : !/inserted_at\s*>=/.test(src));

  // 13F must carry its quarter so the UI can say "quarter ended", never "buying now".
  const r = await run(['MSFT']);
  const inst = r.changes.find((c) => c.family === 'institution');
  ok('a 13F change carries its reference period',
    mut('noquarter') ? false : inst?.referencePeriod === '2026-06-30', String(inst?.referencePeriod));
  const ui = read('src/components/WatchlistChanges.jsx');
  ok('…and the UI prints it as a quarter that ended',
    mut('noquarter') ? false : /quarter ended/.test(ui));
  // Against the CODE only: the file says «never "buying now"» in a comment, which is the rule
  // being stated, not the claim being made.
  ok('…and never claims present-tense buying',
    mut('presenttense') ? false : !/buying now|is buying|accumulating now/i.test(code(ui)));
}

L('\n=== THE FAN-OUT IS BOUNDED, AND SAYS SO ===');
{
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`AA${i}`, [ev({
    ticker: `AA${i}`, family: 'catalyst', type: 'sec_8k', summary: 'Filing', publicTime: ago(1) })]]));
  Object.assign(FIXTURES, many);
  const r = await run(Object.keys(many), { limit: 5 });
  ok('no more than the limit is resolved', mut('unbounded') ? false : r.resolved === 5, `resolved ${r.resolved}`);
  ok('…and truncation is reported rather than hidden', r.truncated === true);
  ok('…keeping the names the user put first', r.changes.every((c) => Object.keys(many).slice(0, 5).includes(c.ticker)));
  for (const k of Object.keys(many)) delete FIXTURES[k];

  ok('the default cap is modest', MAX_RESOLVE <= 25 && MAX_RESOLVE > 0, String(MAX_RESOLVE));
  ok('concurrency stays small', RESOLVE_CONCURRENCY <= 6 && RESOLVE_CONCURRENCY > 0, String(RESOLVE_CONCURRENCY));
  ok('the no-watermark default is one day', DEFAULT_LOOKBACK_MS === 24 * 3600e3);
}

L('\n=== A RESOLVER FAILURE IS NOT "NOTHING CHANGED" ===');
{
  const boom = async () => { throw new Error('resolver down'); };
  const r = await watchlistChanges(['TELA'], {
    since: SINCE, now: NOW, _candidates: fakeCandidates, _resolve: boom,
  });
  ok('a thrown resolver is reported', mut('swallows') ? false : r.failed.length === 1, JSON.stringify(r.failed));
  ok('…and does not masquerade as an empty change list',
    r.failed[0]?.ticker === 'TELA' && r.changes.length === 0);

  // The endpoint has to fail loudly too — a 200 with [] reads as "nothing happened".
  const route = read('src/app/api/watchlist/changes/route.js');
  ok('the endpoint returns 503 on failure, never an empty 200',
    mut('quietfail') ? false : /status: 503/.test(route));
  ok('…and the UI refuses to render an outage as silence',
    /not a statement that nothing changed/i.test(read('src/components/WatchlistChanges.jsx')));
}

L('\n=== THE ENDPOINT AND THE SURFACES ===');
{
  const route = read('src/app/api/watchlist/changes/route.js');
  ok('the response is per-user and never shared-cacheable',
    mut('sharedcache') ? false : /private, no-store/.test(route) && !/s-maxage/.test(route));
  ok('it requires a signed-in user', /if \(!userId\) return Response\.json\(\{ error: 'unauthorized'/.test(route));
  ok('a first visit defaults to the last 24 hours', /DEFAULT_LOOKBACK_MS/.test(route));
  ok('…and the response says which question it answered', /sinceSource/.test(route));
  // ⚠️ READING MUST NOT BE WHAT MARKS IT READ.
  ok('the watermark advances only on an explicit POST',
    mut('autoseen') ? false : /export async function POST/.test(route) && !/kvSet\(seenKey\(userId\)[\s\S]{0,80}GET/.test(route));

  const ui = read('src/components/WatchlistChanges.jsx');
  ok('the empty state is the agreed sentence',
    mut('emptystate') ? false : /No new public evidence on your names\./.test(ui));
  // ⚠️ NO PRICE CLAIM ON A CHANGE LINE. Realtime is not entitled.
  // \b on purpose: "alive" contains "live", and a variable name is not a claim to the reader.
  const uiCode = code(ui);
  for (const banned of ['rvol', 'relative volume', 'LIVE']) {
    ok(`a change line never says ${banned}`,
      mut('claimslive') ? false : !new RegExp(`\\b${banned}\\b`, 'i').test(uiCode));
  }
  ok('…and no change line renders a price or a move',
    mut('pricey') ? false : !/changePct|\$\{.*price/i.test(ui));

  // ONE implementation, shared. Two would drift.
  const section = read('src/components/WatchlistSection.jsx');
  const dock = read('src/components/WatchlistDock.jsx');
  ok('the home card uses the shared component', /WatchlistChanges/.test(section));
  ok('the dock uses the same one', /WatchlistChanges/.test(dock));
  ok('…and the dock badges its rows from the same fetch',
    mut('twofetches') ? false : /state=\{changesState\}/.test(dock) && /ChangedBadge/.test(dock));
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
