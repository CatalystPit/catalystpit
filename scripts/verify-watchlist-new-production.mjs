// WATCHLIST "NEW", CHECKED AGAINST PRODUCTION — the real modules, the real database, the real rows.
//
//   node --env-file=.env.local --loader ./scripts/ext-resolve-loader.mjs scripts/verify-watchlist-new-production.mjs
//
// ⚠️ THIS IS NOT THE UNIT SUITE. verify-watchlist-new-badge drives the contract through seams with
// fixtures; this runs the shipped read path over the materialised rows a production cron actually
// built, so it can catch the things a fixture cannot: a builder that stopped, a family that never
// made it into the sweep, a watermark that does not bite, a list size that silently truncates.
//
// Reads production and writes nothing.
import fs from 'node:fs';
import { neon } from '@neondatabase/serverless';

const env = fs.readFileSync('.env.local', 'utf8');
const sql = neon(/DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/.exec(env)[1].trim());
const { watchlistChangesFast } = await import('../src/lib/watchlist-changes.js');
const { eligibleForNew, countNew, NEW_MATERIALITY_FLOOR, NEW_FAMILIES } = await import('../src/lib/watchlist-new.mjs');
const { coverage } = await import('../src/lib/watchlist-materialise.mjs');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.error(`  FAIL ${n}${d ? ` — ${d}` : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const DAY = 86_400_000;
const since = (d) => new Date(Date.now() - d * DAY).toISOString();

// ── 1. MATERIAL EVENTS ONLY ──────────────────────────────────────────────────
L('1. material events only');
{
  const rows = await sql`SELECT min(materiality)::float lo, max(materiality)::float hi, count(*)::int n FROM watchlist_events`;
  ok(`⚠️ every materialised row clears the floor (${NEW_MATERIALITY_FLOOR})`,
    Number(rows[0].lo) >= NEW_MATERIALITY_FLOOR, `lowest stored materiality is ${rows[0].lo}`);
  console.log(`       ${rows[0].n} rows, materiality ${rows[0].lo}–${rows[0].hi}`);

  // The routine classes that must never be stored at all.
  const routine = await sql`SELECT event_type, count(*)::int n FROM watchlist_events
     WHERE event_type IN ('sec_8k_other','list_symbol_change') GROUP BY event_type`;
  ok('⚠️ no routine Item 8.01 or symbol-change row was stored', routine.length === 0, JSON.stringify(routine));

  // ⚠️ FORM 144 IS TIERED, NOT BANNED, and asserting it absent was MY error — the check failed and
  // the product was right. A notice is scored 0.75 at 2% of shares outstanding, 0.70 at $50m, and
  // 0.55 when nothing distinguishes it. Only the residual tier is routine; the sized tiers are a
  // genuine disclosure and are meant to badge. So the assertion is on the FLOOR for that type.
  const f144 = await sql`SELECT min(materiality)::float lo, count(*)::int n FROM watchlist_events
     WHERE event_type = 'sec_144_proposed_sale'`;
  // The column is REAL, so 0.70 comes back as 0.6999999880. Eligibility is decided in memory on the
  // exact number before the row is written, so the stored precision is a display concern only — but
  // a comparison here needs the epsilon or it fails on arithmetic rather than on behaviour.
  const EPS = 1e-6;
  ok('⚠️ only SIZED Form 144 notices are stored, never the residual tier',
    Number(f144[0].n) === 0 || Number(f144[0].lo) >= 0.70 - EPS,
    `${f144[0].n} rows, lowest materiality ${f144[0].lo}`);

  // And the contract still refuses them when asked directly.
  ok('the contract still refuses a routine 8.01',
    !eligibleForNew({ family: 'catalyst', type: 'sec_8k_other', materiality: 0.45, publicTime: since(0.1), ticker: 'X' }));
  ok('...and a routine Form 144',
    !eligibleForNew({ family: 'insider', type: 'sec_144_proposed_sale', materiality: 0.55, publicTime: since(0.1), ticker: 'X' }));
}

// ── 2. ALL INTENDED EVIDENCE FAMILIES ────────────────────────────────────────
L('2. every intended evidence family reaches the builder');
{
  const fams = await sql`SELECT family, count(*)::int n, count(distinct ticker)::int t FROM watchlist_events GROUP BY family ORDER BY n DESC`;
  for (const f of fams) console.log(`       ${String(f.family).padEnd(13)} ${String(f.n).padStart(5)} rows  ${f.t} tickers`);
  const present = new Set(fams.map((f) => f.family));
  for (const f of NEW_FAMILIES) {
    ok(`⚠️ the ${f} family is represented in production rows`, present.has(f),
      `declared in NEW_FAMILIES but no row was ever built for it`);
  }

  // ⚠️ THE FAMILY THE WHOLE FIX WAS ABOUT. A catalyst found on the wire, for a company that filed
  // no 8-K, must still be able to create NEW.
  const wireOnly = await sql`
    SELECT w.ticker, w.event_type, w.public_time::text
      FROM watchlist_events w
     WHERE w.family = 'catalyst'
       AND w.event_type NOT LIKE 'sec_%'
       AND NOT EXISTS (SELECT 1 FROM eightk_filings e
                        WHERE upper(e.ticker) = w.ticker AND e.filed_at > now() - interval '30 days')
     ORDER BY w.public_time DESC LIMIT 5`;
  ok('⚠️ a wire-discovered catalyst creates NEW with no 8-K behind it', wireOnly.length > 0,
    'this is the NVDA failure class; zero rows would mean the wire family is unreachable again');
  for (const r of wireOnly) console.log(`       ${r.ticker.padEnd(7)} ${r.event_type.padEnd(26)} ${r.public_time.slice(0, 16)}  (no 8-K in 30d)`);
}

// ── 3. CANONICAL TICKER ATTRIBUTION ──────────────────────────────────────────
L('3. ticker attribution is canonical, never inferred');
{
  // Every materialised catalyst row must trace to a canonical event that NAMES that ticker.
  const orphans = await sql`
    SELECT w.ticker, w.event_type, w.public_time::text
      FROM watchlist_events w
     WHERE w.family = 'catalyst' AND w.event_type NOT LIKE 'sec_%'
       AND w.public_time > now() - interval '30 days'
       AND NOT EXISTS (
         SELECT 1 FROM primary_events p
          WHERE w.ticker = ANY(p.tickers)
            AND p.published_at BETWEEN w.public_time - interval '2 days' AND w.public_time + interval '2 days')
     LIMIT 10`;
  ok('⚠️ no wire-sourced row exists without a canonical event naming that ticker',
    orphans.length === 0, JSON.stringify(orphans.slice(0, 3)));

  // The resolver cleanup earlier in this project removed word-matched symbols; none may have
  // produced a badge row.
  const wordy = await sql`SELECT ticker, count(*)::int n FROM watchlist_events
     WHERE ticker IN ('HERE','BILL','NWS','CHCO','PPLI','TISI','BLSH','SO','TAAG','JVA') GROUP BY ticker`;
  console.log(`       word-like symbols holding rows: ${JSON.stringify(wordy)}`);
  for (const w of wordy) {
    const real = await sql`SELECT count(*)::int n FROM primary_events
       WHERE ${w.ticker} = ANY(tickers) AND published_at > now() - interval '45 days'`;
    ok(`   ${w.ticker}'s rows rest on canonical events that name it`, Number(real[0].n) > 0);
  }
}

// ── 4. DEDUPLICATION ─────────────────────────────────────────────────────────
L('4. one real-world event is one row');
{
  const dupes = await sql`SELECT event_key, count(*)::int n FROM watchlist_events GROUP BY event_key HAVING count(*) > 1`;
  ok('⚠️ the event key is unique in production, enforced by the database', dupes.length === 0, JSON.stringify(dupes.slice(0, 3)));

  // The NVDA buyback: many canonical copies, one badge row.
  const copies = await sql`SELECT count(*)::int n FROM primary_events
     WHERE 'NVDA' = ANY(tickers) AND event_key = 'NVDA|buyback|2026-09-28'`;
  const badge = await sql`SELECT count(*)::int n FROM watchlist_events
     WHERE ticker = 'NVDA' AND event_type = 'cap_buyback_authorized'`;
  ok('⚠️ many outlets carrying one announcement produce ONE row',
    Number(copies[0].n) >= 2 && Number(badge[0].n) === 1,
    `${copies[0].n} canonical copies -> ${badge[0].n} badge row(s)`);

  // Genuinely separate events stay separate.
  const multi = await sql`SELECT ticker, count(*)::int n, array_agg(event_type) types FROM watchlist_events
     WHERE public_time > now() - interval '30 days' GROUP BY ticker HAVING count(*) >= 3 ORDER BY n DESC LIMIT 3`;
  ok('⚠️ genuinely separate events are still counted separately', multi.length > 0,
    JSON.stringify(multi.map((m) => `${m.ticker}:${m.n}`)));
  for (const m of multi) console.log(`       ${m.ticker.padEnd(7)} ${m.n} distinct events  ${m.types.join(', ')}`);
}

// ── 5. SEEN STATE — the watermark bites ──────────────────────────────────────
L('5. the watermark decides what is new');
{
  const busy = (await sql`SELECT ticker FROM watchlist_events WHERE public_time > now() - interval '7 days'
     GROUP BY ticker ORDER BY count(*) DESC LIMIT 6`).map((r) => r.ticker);
  const wide = await watchlistChangesFast(busy, { since: since(30) });
  const narrow = await watchlistChangesFast(busy, { since: since(0) });
  const future = await watchlistChangesFast(busy, { since: new Date(Date.now() + DAY).toISOString() });
  ok('⚠️ an old watermark returns events', wide.changes.length > 0, `${wide.changes.length}`);
  ok('⚠️ a newer watermark returns fewer', narrow.changes.length < wide.changes.length,
    `${wide.changes.length} at 30d -> ${narrow.changes.length} at 0d`);
  ok('⚠️ a watermark of "now" returns nothing — marking seen really clears it', future.changes.length === 0,
    `${future.changes.length}`);
}

// ── 6. ACCOUNT ISOLATION ─────────────────────────────────────────────────────
L('6. one account\'s list never answers for another');
{
  const busy = (await sql`SELECT ticker FROM watchlist_events WHERE public_time > now() - interval '7 days'
     GROUP BY ticker ORDER BY count(*) DESC LIMIT 2`).map((r) => r.ticker);
  const a = await watchlistChangesFast([busy[0]], { since: since(30) });
  const b = await watchlistChangesFast([busy[1]], { since: since(30) });
  ok('⚠️ a list answers only for the names it contains',
    Object.keys(a.byTicker).every((t) => t === busy[0]) && Object.keys(b.byTicker).every((t) => t === busy[1]),
    `${JSON.stringify(Object.keys(a.byTicker))} / ${JSON.stringify(Object.keys(b.byTicker))}`);
  const empty = await watchlistChangesFast([], { since: since(30) });
  ok('an empty list is an empty answer, not everything', empty.changes.length === 0);

  const route = fs.readFileSync(new URL('../src/app/api/watchlist/changes/route.js', import.meta.url), 'utf8');
  ok('the watermark is still keyed per user', /catalystpit:watchlist:seen:\$\{userId\}/.test(route));
  ok('⚠️ only POST advances it — a GET never marks anything seen',
    /export async function POST/.test(route) && !/kvSet\(seenKey\(userId\)[\s\S]{0,200}export async function POST/.test(route));
  ok('the answer is never shared-cached', /private, no-store/.test(route));
}

// ── 7. SCALE AND COVERAGE ────────────────────────────────────────────────────
L('7. the whole watchlist is evaluated, and coverage is stated');
{
  const universe = (await sql`SELECT ticker FROM screener_stocks WHERE market_cap > 0 ORDER BY market_cap DESC LIMIT 500`)
    .map((r) => String(r.ticker).toUpperCase());
  for (const n of [1, 60, 100, 250, 500]) {
    const list = universe.slice(0, n);
    const t0 = Date.now();
    const r = await watchlistChangesFast(list, { since: since(30) });
    ok(`⚠️ ${String(n).padStart(3)} names: all evaluated, nothing truncated`,
      r.resolved === list.length && r.truncated === false,
      `evaluated ${r.resolved}/${list.length} truncated=${r.truncated}`);
    console.log(`       ${String(n).padStart(3)} names -> ${String(r.changes.length).padStart(3)} events, ${Date.now() - t0}ms`);
  }

  const cov = await coverage();
  const ageMin = cov.builtThrough ? (Date.now() - Date.parse(cov.builtThrough)) / 60000 : null;
  ok('⚠️ the production builder is current', ageMin != null && ageMin < 30, `built_through is ${ageMin?.toFixed(1)} min old`);
  ok('⚠️ ...and reported no error on its last sweep', !cov.lastError, String(cov.lastError));
  ok('⚠️ ...and finished its sweep rather than stopping part-way', !cov.resumeAfter, String(cov.resumeAfter));
  const r = await watchlistChangesFast(['NVDA'], { since: since(2) });
  ok('⚠️ the read states its own coverage, so unchecked is never rendered as zero',
    typeof r.coverage?.fresh === 'boolean' && r.coverage.builtThrough != null,
    JSON.stringify(r.coverage));
  ok('...and says it is fresh right now', r.coverage.fresh === true);
}

// ── 8. REGRESSION FIXTURES ───────────────────────────────────────────────────
L('8. the reported fixtures, as fixtures only');
{
  const r = await watchlistChangesFast(['NVDA', 'META', 'MSTR', 'SPY', 'QQQ'], { since: since(2) });
  const types = (t) => (r.byTicker[t] || []).map((x) => x.type);
  console.log(`       NVDA ${JSON.stringify(types('NVDA'))}`);
  console.log(`       META ${JSON.stringify(types('META'))}`);
  console.log(`       MSTR ${JSON.stringify(types('MSTR'))}`);
  ok('⚠️ NVDA\'s buyback is NEW', types('NVDA').includes('cap_buyback_authorized'));
  ok('⚠️ META\'s CEO transition collapsed to one event',
    (r.byTicker.META || []).filter((x) => /mgmt_ceo|sec_8k_officer/.test(x.type)).length <= 1,
    JSON.stringify(types('META')));
  ok('⚠️ MSTR\'s routine 8.01 is NOT new', !types('MSTR').includes('sec_8k_other'), JSON.stringify(types('MSTR')));
  ok('⚠️ quiet index tickers stay quiet', types('SPY').length === 0 && types('QQQ').length === 0);

  // Nothing about these names is special-cased.
  const lib = fs.readFileSync(new URL('../src/lib/watchlist-new.mjs', import.meta.url), 'utf8');
  const mat = fs.readFileSync(new URL('../src/lib/watchlist-materialise.mjs', import.meta.url), 'utf8');
  const chg = fs.readFileSync(new URL('../src/lib/watchlist-changes.js', import.meta.url), 'utf8');
  const strip = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const [name, src] of [['watchlist-new', lib], ['watchlist-materialise', mat], ['watchlist-changes', chg]]) {
    ok(`${name} names no company`, !/\b(NVDA|META|MSTR|AAPL|TSLA)\b/.test(strip(src)));
  }
}

// ── 8b. HOW LONG A NEW EVENT TAKES TO BECOME A BADGE ─────────────────────────
//
// ⚠️ MEASURED END TO END, not asserted from the cron schedule. published_at is when the market
// learned; built_at is when the row a badge reads came into existence. The gap is the whole
// ingestion → classification → materialisation path, and it is the honest answer to "do I have to
// reload for this to show up".
L('8b. tape-to-badge latency, measured on real rows');
{
  // ⚠️ ONLY EVENTS THE RUNNING CRON PICKED UP. A row written by a one-off backfill carries the age
  // of the history it swept, not the pipeline's speed — measuring those together reported a median
  // of 272 minutes for a pipeline whose real median is minutes. The window is therefore events
  // published AFTER the builder was already current, which is the only steady-state population.
  const lat = await sql`
    SELECT ticker, event_type,
           extract(epoch from (built_at - public_time))/60 AS mins
      FROM watchlist_events
     WHERE public_time > (SELECT min(built_at) FROM watchlist_events WHERE built_at > now() - interval '3 hours')
       AND built_at >= public_time
     ORDER BY public_time DESC LIMIT 60`;
  const mins = lat.map((r) => Number(r.mins)).filter(Number.isFinite).sort((a, b) => a - b);
  ok('there are recent rows to measure', mins.length > 0, `${mins.length} rows in 24h`);
  if (mins.length) {
    const p = (q) => mins[Math.min(mins.length - 1, Math.floor(mins.length * q))];
    console.log(`       median ${p(0.5).toFixed(1)} min · p90 ${p(0.9).toFixed(1)} min · fastest ${mins[0].toFixed(1)} min`);
    ok('⚠️ the median event is materialised within the poll interval it will be read on',
      p(0.5) <= 30, `median ${p(0.5).toFixed(1)} min`);
  }
}

// ── 9. LIVE UPDATING ─────────────────────────────────────────────────────────
L('9. the badge refreshes without a reload');
{
  const ui = fs.readFileSync(new URL('../src/components/WatchlistChanges.jsx', import.meta.url), 'utf8');
  ok('60s while visible', /const POLL_ACTIVE = 60_000;/.test(ui));
  ok('5 min while hidden', /const POLL_HIDDEN = 300_000;/.test(ui));
  ok('immediate on focus return', /document\.addEventListener\('visibilitychange', wake\)/.test(ui));
  ok('⚠️ one batched request for the whole list, not one per ticker',
    (ui.match(/fetch\('\/api\/watchlist\/changes'/g) || []).length === 2,   // one GET, one POST
    'a per-ticker fetch would multiply with list size');
  ok('⚠️ polling never marks anything seen',
    (ui.match(/method: 'POST'/g) || []).length === 1 && /genRef\.current \+= 1;/.test(ui));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
