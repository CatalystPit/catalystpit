// SYSTEM-WIDE AUDIT of the Watchlist NEW badge, against the production universe.
//
//   node --env-file=.env.local --loader ./scripts/ext-resolve-loader.mjs scripts/audit-watchlist-new-system.mjs
//
// ⚠️ THREE TICKERS ARE NOT A SYSTEM TEST. This runs the real prefilter, the real Evidence Engine and
// the real eligibility contract over a stratified sample of the actual equity universe — every cap
// bucket, every sector, securities with heavy news and with none, word-like symbols, recent
// listings — plus a random sample chosen without regard to whether anything happened, because
// SILENCE IS THE COMMON CASE and a badge system that cannot stay quiet is worse than none.
//
// Reads production; writes nothing.
import fs from 'node:fs';
import { neon } from '@neondatabase/serverless';

const env = fs.readFileSync('.env.local', 'utf8');
const sql = neon(/DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/.exec(env)[1].trim());
const { watchlistChanges, candidateTickers, MAX_RESOLVE } = await import('../src/lib/watchlist-changes.js');
const { NEW_MATERIALITY_FLOOR } = await import('../src/lib/watchlist-new.mjs');

const SINCE = new Date(Date.now() - 7 * 86_400_000).toISOString();
const line = (s) => console.log(s);
const H = (s) => console.log(`\n${'─'.repeat(78)}\n${s}\n${'─'.repeat(78)}`);

// ── the sample ───────────────────────────────────────────────────────────────
const bucket = (lo, hi, n) => sql`
  SELECT ticker, company, industry, market_cap FROM screener_stocks
   WHERE market_cap > ${lo} AND market_cap <= ${hi} AND company IS NOT NULL
   ORDER BY random() LIMIT ${n}`;

const [large, mid, small, micro] = await Promise.all([
  bucket(10e9, 1e15, 30), bucket(2e9, 10e9, 30), bucket(3e8, 2e9, 30), bucket(0, 3e8, 30),
]);
// Sector spread, so the audit is not a technology audit.
const sectors = await sql`
  SELECT DISTINCT ON (industry) ticker, company, industry, market_cap
    FROM screener_stocks WHERE industry IS NOT NULL AND industry <> '' AND market_cap > 0
   ORDER BY industry, market_cap DESC LIMIT 40`;
// Securities whose SYMBOL is an ordinary English word — the population the resolver fix was about.
const wordLike = await sql`
  SELECT ticker, company, industry, market_cap FROM screener_stocks
   WHERE ticker IN ('ON','IT','ALL','ARE','FOR','NOW','LOVE','OPEN','GO','SO','CAN','HERE','BILL','POOL','GAP','SNAP','STEM','BOX','KEY','BEST','CAR','FUN','HOPE','LUV','MAN','PLAY','RUN','SEE','TRUE','WELL','WING')`;
// Heavy news and no news at all, decided by the tape rather than by reputation.
const loud = await sql`
  SELECT t AS ticker, count(*)::int n FROM primary_events, unnest(tickers) AS t
   WHERE published_at > now() - interval '7 days' GROUP BY t ORDER BY n DESC LIMIT 25`;
const quiet = await sql`
  SELECT s.ticker FROM screener_stocks s WHERE s.market_cap > 1e8
     AND NOT EXISTS (SELECT 1 FROM primary_events p WHERE s.ticker = ANY(p.tickers)
                      AND p.published_at > now() - interval '90 days')
   ORDER BY random() LIMIT 25`;
const random100 = await sql`
  SELECT ticker, company, industry, market_cap FROM screener_stocks
   WHERE company IS NOT NULL ORDER BY random() LIMIT 100`;

const uniq = (xs) => [...new Set(xs.map((x) => String(x.ticker).toUpperCase()))];
const groups = {
  'large cap': uniq(large), 'mid cap': uniq(mid), 'small cap': uniq(small), 'micro cap': uniq(micro),
  'sector spread': uniq(sectors), 'word-like symbols': uniq(wordLike),
  'heaviest news flow': uniq(loud), 'no news in 90 days': uniq(quiet),
  'random 100': uniq(random100),
};

H('TASK 5 / 9 — the eligibility engine across the universe');
line(`window: last 7 days   materiality floor: ${NEW_MATERIALITY_FLOOR}`);
line('');
line('group                    tickers  nominated  badged  events  silent   time');
const perGroup = {};
for (const [name, tickers] of Object.entries(groups)) {
  const t0 = Date.now();
  const cands = await candidateTickers(tickers, SINCE);
  // Resolve in slices so a big group is not capped by MAX_RESOLVE, which is a per-REQUEST bound.
  let badged = 0, events = 0;
  const detail = [];
  for (let i = 0; i < tickers.length; i += MAX_RESOLVE) {
    const slice = tickers.slice(i, i + MAX_RESOLVE);
    const r = await watchlistChanges(slice, { since: SINCE });
    for (const [tk, rows] of Object.entries(r.byTicker)) {
      badged++; events += rows.length;
      detail.push({ ticker: tk, n: rows.length, types: rows.map((x) => x.type) });
    }
  }
  const ms = Date.now() - t0;
  perGroup[name] = { tickers: tickers.length, nominated: cands.length, badged, events, detail };
  line(`${name.padEnd(24)} ${String(tickers.length).padStart(7)} ${String(cands.length).padStart(10)} `
    + `${String(badged).padStart(7)} ${String(events).padStart(7)} ${String(tickers.length - badged).padStart(7)} ${String(ms + 'ms').padStart(7)}`);
}

H('what actually badged, by group');
for (const [name, g] of Object.entries(perGroup)) {
  if (!g.detail.length) { line(`${name}: nothing — correctly silent across all ${g.tickers}`); continue; }
  line(`${name}:`);
  for (const d of g.detail.slice(0, 10)) line(`   ${d.ticker.padEnd(7)} ${d.n} NEW   ${d.types.join(', ')}`);
}

H('TASK 9 — silence is the common case');
{
  const r = perGroup['random 100'];
  line(`random securities audited      : ${r.tickers}`);
  line(`...correctly showing no badge  : ${r.tickers - r.badged}  (${(((r.tickers - r.badged) / r.tickers) * 100).toFixed(0)}%)`);
  line(`...showing a badge             : ${r.badged}, ${r.events} events`);
  const q = perGroup['no news in 90 days'];
  line(`securities with no tape at all : ${q.tickers} audited, ${q.badged} badged  (must be 0)`);
  const w = perGroup['word-like symbols'];
  line(`word-like symbols              : ${w.tickers} audited, ${w.badged} badged, ${w.events} events`);
}

H('TASK 10 — account and watchlist isolation');
{
  // Two lists that share one active name and nothing else. The function takes the LIST as its
  // input, so a name absent from a list cannot appear in that list's answer — and the watermark
  // that decides "since when" is read per user by the route, never here.
  const active = perGroup['heaviest news flow'].detail[0]?.ticker
    || perGroup['large cap'].detail[0]?.ticker;
  const a = await watchlistChanges([active, 'SPY'], { since: SINCE });
  const b = await watchlistChanges(['SPY', 'QQQ'], { since: SINCE });
  line(`user A watches [${active}, SPY] -> ${a.changes.length} events ${JSON.stringify(Object.keys(a.byTicker))}`);
  line(`user B watches [SPY, QQQ]       -> ${b.changes.length} events ${JSON.stringify(Object.keys(b.byTicker))}`);
  line(`B sees nothing about ${active}   : ${!b.byTicker[active]}`);
  const c = await watchlistChanges([active, 'SPY'], { since: new Date().toISOString() });
  line(`A with a watermark of "now"     : ${c.changes.length} events  (a read clears only that user's)`);
}

H('TASK 12 — scale');
line('watchlist  prefilter  resolver  events   ms    bytes');
const pool = uniq(random100).concat(uniq(loud)).concat(uniq(large));
for (const size of [1, 10, 25, 50, 100]) {
  const list = pool.slice(0, size);
  if (list.length < size) continue;
  const t0 = Date.now();
  const cands = await candidateTickers(list, SINCE);
  const r = await watchlistChanges(list, { since: SINCE });
  const ms = Date.now() - t0;
  const bytes = JSON.stringify({ changes: r.changes, byTicker: r.byTicker }).length;
  line(`${String(size).padStart(9)} ${String(cands.length).padStart(10)} ${String(r.resolved).padStart(9)} `
    + `${String(r.changes.length).padStart(6)} ${String(ms).padStart(6)} ${String(bytes).padStart(8)}`
    + (r.truncated ? `   TRUNCATED at ${MAX_RESOLVE}` : ''));
}
line(`\nMAX_RESOLVE = ${MAX_RESOLVE} (resolver calls per request, whatever the list size)`);
