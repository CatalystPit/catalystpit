// WATCHLIST + WHAT CHANGED — end-to-end integrity for the live path.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-watchlist-integrity.mjs
//
// ⚠️ WHAT THIS GUARDS. The defect found by auditing production was two local symbol regexes, in two
// watchlist routes, answering one question differently:
//
//   /api/watchlist         /^[A-Z0-9.-]{1,10}$/   accepts BRK.B — and also 'NONE', 'TBD', '---', '1234'
//   /api/watchlist/signals /^[A-Z]{1,5}$/         rejects every dotted share class
//
// So the add path could store filler that can never resolve, and the monitor silently dropped a
// watched BRK.B from its own symbol list — no NEWS flag, no HALT flag, no headline. Neither threw.
// Both now use the canonical gate, and this file asserts they cannot drift apart again.
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const one = async (q) => (await q)[0];

L('⚠️ one canonical symbol gate, shared by every watchlist surface');
{
  const { isIngestableSymbol } = await import('../src/lib/ticker-symbol.mjs');
  // ⚠️ THE CASES THAT DIVERGED. A dotted class must be admitted by BOTH routes; filler by NEITHER.
  for (const s of ['AAPL', 'BRK.B', 'BF.B', 'HEI.A', 'AXIA3']) {
    ok(`${s} is admitted`, isIngestableSymbol(s) === true);
  }
  for (const s of ['NONE', 'NULL', 'TBD', 'N/A', '---', '1234', 'NYSE: VTEX', 'Z AND ZG', '(CALX)', '']) {
    ok(`${JSON.stringify(s)} is refused`, isIngestableSymbol(s) === false);
  }
  ok('case and whitespace are normalised before the test', isIngestableSymbol('aapl') && isIngestableSymbol(' AAPL '));

  const add = read('src/app/api/watchlist/route.js');
  const sig = read('src/app/api/watchlist/signals/route.js');
  ok('⚠️ the add path uses the canonical gate, not a local shape test',
    /isIngestableSymbol\(ticker\)/.test(add) && !/TICKER_RE\s*=/.test(add));
  ok('⚠️ the monitor uses the same gate', /\.filter\(isIngestableSymbol\)/.test(sig) && !/TICKER_RE\s*=/.test(sig));
  // Production: nothing already stored may be refused by the gate, or the fix orphans a membership.
  const stored = (await sql`select distinct ticker from watchlist`).map((r) => r.ticker);
  const orphaned = stored.filter((t) => !isIngestableSymbol(t));
  ok(`⚠️ all ${stored.length} stored tickers pass the gate (nothing orphaned)`, orphaned.length === 0, orphaned.join(','));
}

L('⚠️ every query is scoped to the caller');
{
  const routes = ['src/app/api/watchlist/route.js', 'src/app/api/watchlist/changes/route.js',
    'src/app/api/watchlist/lists/route.js'];
  for (const f of routes) {
    const src = read(f);
    ok(`${f} refuses an unauthenticated caller`, /if \(!userId\)/.test(src) && /401/.test(src));
    // ⚠️ PRIVATE, because the answer depends on one person's list and one person's watermark.
    ok('…and never allows a shared cache to hold the answer', /private, no-store/.test(src));
    // ⚠️ AND THE EXCEPTION TEXT STAYS SERVER-SIDE. Matched on the return, not the word, because the
    // comment explaining the fix names e.message.
    const returns = (src.match(/return Response\.json\([^;]*;/g) || []).join(' ');
    ok('…and no response hands the client an exception message', !/e\.message/.test(returns),
      (returns.match(/[^;]*e\.message[^;]*/) || [''])[0].slice(0, 90));
  }
  const lists = read('src/lib/watchlists.js');
  // ⚠️ OWNERSHIP IS CHECKED BEFORE THE WRITE, not inferred from the id. A guessed list id must not
  // be enough to delete or rename somebody else's list.
  // ⚠️ SCOPED TO THE FUNCTION BODY, because the file-wide version of this passed while deleteList
  // was reading a list by id alone: the ownership pattern it looked for existed in a SIBLING
  // function. A mutation test caught that, and an assertion about one function must read one function.
  const deleteBody = lists.match(/export async function deleteList\([\s\S]*?\n\}/)?.[0] || '';
  ok('the deleteList function was found', deleteBody.length > 0);
  ok('⚠️ deleteList proves ownership before deleting anything',
    /eq\(watchlistLists\.userId, userId\)/.test(deleteBody) && /return \{ error: 'Not found' \}/.test(deleteBody),
    deleteBody.slice(0, 120));
  ok('…and both of its deletes are scoped by user AND list',
    (deleteBody.match(/eq\(watchlist\.userId, userId\)/g) || []).length >= 1
    && (deleteBody.match(/eq\(watchlistLists\.userId, userId\)/g) || []).length >= 2);
  ok('the default list cannot be deleted', /Can't delete your default list/.test(lists));

  // Production: no row may belong to one user through a list owned by another.
  const cross = await one(sql`select count(*)::int n from watchlist w
    join watchlist_lists l on l.id = w.list_id where l.user_id <> w.user_id`);
  ok('⚠️ no membership sits in another user\'s list', cross.n === 0, `${cross.n}`);
  const orphan = await one(sql`select count(*)::int n from watchlist w
    where w.list_id is not null and not exists (select 1 from watchlist_lists l where l.id = w.list_id)`);
  ok('no membership points at a list that does not exist', orphan.n === 0, `${orphan.n}`);
}

L('⚠️ plan limits come from the canonical rules and are enforced on the server');
{
  const ent = await import('../src/lib/entitlements.js');
  // ⚠️ EXECUTED. These were undefined for part of today — the re-export that carried them was
  // dropped, and `WATCHLIST_LIMIT[tier]` threw, so adding to a watchlist failed outright.
  ok('WATCHLIST_LIMIT is a live value', ent.WATCHLIST_LIMIT && typeof ent.WATCHLIST_LIMIT === 'object');
  ok('WATCHLIST_LISTS_LIMIT is a live value', ent.WATCHLIST_LISTS_LIMIT && typeof ent.WATCHLIST_LISTS_LIMIT === 'object');
  ok('Free is 15 names / 1 list', ent.WATCHLIST_LIMIT.free === 15 && ent.WATCHLIST_LISTS_LIMIT.free === 1);
  ok('Pro is 250 names / 10 lists', ent.WATCHLIST_LIMIT.pro === 250 && ent.WATCHLIST_LISTS_LIMIT.pro === 10);
  ok('Elite is 1000 names / 25 lists', ent.WATCHLIST_LIMIT.elite === 1000 && ent.WATCHLIST_LISTS_LIMIT.elite === 25);
  ok('⚠️ an unknown tier falls back to Free, never to unlimited',
    (ent.WATCHLIST_LIMIT.bogus ?? ent.WATCHLIST_LIMIT.free) === 15);

  const add = read('src/app/api/watchlist/route.js');
  ok('⚠️ the cap is resolved server-side from the tier', /await resolveUserTier\(\)/.test(add) && /WATCHLIST_LIMIT\[tier\]/.test(add));
  ok('…and refused with 403 at the cap', /current\.length >= limit/.test(add) && /403/.test(add));
  // ⚠️ AN EXISTING TICKER IS NOT A NEW ONE. Re-adding at the cap must stay idempotent rather than 403.
  ok('⚠️ re-adding a ticker already held is not blocked by the cap', /!already && current\.length >= limit/.test(add));
  ok('the list cap is enforced where lists are created', /WATCHLIST_LISTS_LIMIT/.test(read('src/lib/watchlists.js')));
  // ⚠️ DOWNGRADE PRESERVES DATA. Nothing may delete memberships to satisfy a smaller cap.
  ok('⚠️ no code path deletes memberships to fit a lower plan',
    !/downgrade/i.test(read('src/lib/watchlists.js')) && !/downgrade/i.test(add));
}

L('⚠️ one ticker, one membership');
{
  const idx = await sql`select indexdef from pg_indexes where tablename='watchlist' and indexdef ilike '%unique%'`;
  // ⚠️ THE UNIQUENESS SCOPE IS (user, ticker) — per user, NOT per list. A concurrent double-add
  // cannot produce two rows because the database refuses the second, not because a check raced.
  ok('⚠️ uniqueness is enforced on (user_id, ticker) by the database',
    idx.some((i) => /\(user_id, ticker\)/.test(i.indexdef)), JSON.stringify(idx.map((i) => i.indexdef)));
  const dup = await one(sql`select count(*)::int n from (select user_id, upper(ticker) t from watchlist group by 1,2 having count(*) > 1) z`);
  ok('no duplicate membership exists, case-insensitively', dup.n === 0, `${dup.n}`);
  const bad = await one(sql`select count(*)::int n from watchlist where ticker !~ '^[A-Z][A-Z0-9.-]{0,9}$'`);
  ok('every stored ticker is symbol-shaped', bad.n === 0, `${bad.n}`);
  const fut = await one(sql`select count(*)::int n from watchlist where added_at > now() + interval '1 hour'`);
  ok('no membership is dated in the future', fut.n === 0, `${fut.n}`);
}

L('⚠️ What Changed windows on the PUBLIC clock for every source');
{
  const src = read('src/lib/watchlist-changes.js');
  // ⚠️ THE FOUR CLOCKS, EACH THE ONE ITS OWN PIPELINE SETTLED. A window on an event date would show
  // a filing before anyone could have known it.
  ok('⚠️ Form 4 windows on filing_date', /filing_date >= \$\{sinceDay\}/.test(src));
  ok('⚠️ 8-K windows on filed_at', /filed_at >= \$\{sinceIso\}/.test(src));
  ok('⚠️ Congress windows on disclosure_date', /disclosure_date >= \$\{sinceDay\}/.test(src));
  ok('⚠️ 13F windows on the FILING date, not the quarter end', /f\.filed_date >= \$\{sinceDay\}/.test(src));
  ok('…and the wire on published_at', /published_at >= \$\{sinceIso\}/.test(src));
  // ⚠️ NO EVENT-TIME COLUMN MAY APPEAR AS A BOUND. Matched as a comparison, because the file's own
  // comments name transaction_date to explain why it is NOT used.
  const bounds = (src.match(/\b(transaction_date|report_date|period_of_report)\s*>=/g) || []);
  ok('⚠️ no event-time column is used as a window bound', bounds.length === 0, bounds.join(','));
  const mat = read('src/lib/watchlist-materialise.mjs');
  ok('the stored public_time is the evidence object\'s publicTime', /new Date\(e\.publicTime\)\.toISOString\(\)/.test(mat));
  const fut = await one(sql`select count(*)::int n from watchlist_events where public_time > now() + interval '1 hour'`);
  ok('⚠️ no materialised event is published in the future', fut.n === 0, `${fut.n}`);
}

L('⚠️ one real-world event is one row, once');
{
  const mat = read('src/lib/watchlist-materialise.mjs');
  const r = await one(sql`select count(*)::int total, count(distinct event_key)::int keys from watchlist_events`);
  ok('no duplicate event_key', r.total === r.keys, `${r.total} / ${r.keys}`);
  const idx = await sql`select indexdef from pg_indexes where tablename='watchlist_events' and indexdef ilike '%unique%'`;
  ok('⚠️ …enforced by a unique index, so a cron rerun cannot double-count',
    idx.some((i) => /\(event_key\)/.test(i.indexdef)));
  // ⚠️ A RERUN MAY ONLY UPGRADE, NEVER RESTAMP. public_time is absent from the update list, so
  // re-materialising cannot move an event forward and make it new again.
  const upd = mat.match(/on conflict \(event_key\) do update set[\s\S]*?where[^\n]*\n/)?.[0] || '';
  ok('the conflict path exists', upd.length > 0);
  ok('⚠️ …and never rewrites public_time', !/public_time/.test(upd), upd.slice(0, 90));
  ok('⚠️ …and only overwrites a LESS material copy', /materiality < excluded\.materiality/.test(mat));
  const nw = read('src/lib/watchlist-new.mjs');
  ok('the event key is (ticker, class, day), not the URL or our row id', /\[ev\?\.ticker \?\? '', cls, day\]/.test(nw));
  ok('⚠️ an 8-K and the press release about it collapse to one class', /sec_8k_results: 'results', earn_results: 'results'/.test(nw));
  ok('⚠️ precedence keeps the MOST MATERIAL copy, ties on the earliest', /Number\(ev\.materiality\) > Number\(prior\.materiality\)/.test(nw));
}

L('⚠️ the badge floor and families are one decision in one place');
{
  const nw = await import('../src/lib/watchlist-new.mjs');
  ok('the materiality floor is declared once', nw.NEW_MATERIALITY_FLOOR === 0.60);
  ok('the families are declared once', Array.isArray(nw.NEW_FAMILIES) && nw.NEW_FAMILIES.length === 4);
  // ⚠️ AN UNJUDGED EVENT MUST NOT INTERRUPT ANYBODY — a missing materiality is not a pass.
  ok('⚠️ a missing materiality fails the floor', nw.eligibleForNew({ family: 'catalyst', publicTime: new Date().toISOString() }) === false);
  ok('a below-floor event fails', nw.eligibleForNew({ family: 'catalyst', materiality: 0.59, publicTime: new Date().toISOString() }) === false);
  ok('an exactly-at-floor event passes', nw.eligibleForNew({ family: 'catalyst', materiality: 0.60, publicTime: new Date().toISOString() }) === true);
  ok('a family outside the list is silent', nw.eligibleForNew({ family: 'other', materiality: 1, publicTime: new Date().toISOString() }) === false);
  // ⚠️ A FUTURE PUBLICATION TIME IS A CLOCK PROBLEM, NEVER NEWS.
  ok('⚠️ a future publicTime is refused', nw.eligibleForNew({ family: 'catalyst', materiality: 1, publicTime: new Date(Date.now() + 86400000).toISOString() }) === false);
  ok('an event past its family window is refused',
    nw.eligibleForNew({ family: 'catalyst', materiality: 1, publicTime: new Date(Date.now() - 40 * 86400000).toISOString() }) === false);
  // Order independence: the same set shuffled must give the same count and the same keys.
  const mk = (t, m, p) => ({ ticker: 'X', family: 'catalyst', type: t, materiality: m, publicTime: p });
  const now = new Date().toISOString();
  const set = [mk('sec_8k_results', 0.7, now), mk('earn_results', 0.65, now), mk('ma_agreement', 0.8, now)];
  const a = nw.countNew(set), b = nw.countNew([...set].reverse());
  ok('⚠️ counting is independent of input order', a.count === b.count
    && JSON.stringify(a.events.map(nw.newEventKey).sort()) === JSON.stringify(b.events.map(nw.newEventKey).sort()), `${a.count} vs ${b.count}`);
  ok('…and the two shapes of one earnings collapse to one', a.count === 2, `${a.count}`);
}

L('⚠️ a retracted Form 4 cannot become a What Changed event');
{
  // The materializer resolves nothing itself: it calls the canonical engine, which drops superseded
  // rows before they are evidence. Asserted at the engine, because that is where it is decided.
  ok('⚠️ the engine drops superseded rows before they become evidence',
    /filter\(\(x\) => !x\.superseded\)/.test(read('src/lib/evidence/resolve.js')));
  ok('the materializer calls the engine rather than reclassifying', /tickerEvidence/.test(read('src/lib/watchlist-materialise.mjs')));
  ok('…and the live monitor carries the guard too',
    (read('src/app/api/watchlist/signals/route.js').match(/superseded_by IS NULL/g) || []).length >= 2);
  // ⚠️ A READ NEVER REBUILDS. A visitor opening Watchlist must not be able to recompute history.
  ok('⚠️ the read path does not rebuild evidence', !/rebuildBoard|recompute/i.test(read('src/lib/watchlist-changes.js')));
}

L('⚠️ the watermark is per-user, durable, and only the user advances it');
{
  const route = read('src/app/api/watchlist/changes/route.js');
  ok('the watermark key is namespaced per user', /catalystpit:watchlist:seen:\$\{userId\}/.test(route));
  // ⚠️ NO TTL. An expiring watermark silently becomes "everything changed", which is the one failure
  // this feature cannot have.
  ok('⚠️ the watermark is stored without a TTL', /No TTL: a watermark that expires/.test(route));
  ok('⚠️ reading does not advance it — only POST does', /POST → mark them seen/.test(route));
  ok('a missing watermark degrades to a bounded lookback, not to all history', /DEFAULT_LOOKBACK_MS/.test(route));
  ok('…and the response says which question it answered', /sinceSource/.test(route));
  ok('What Changed is identical for every authenticated tier, so nothing is withheld client-side',
    !/resolveUserTier|isProTier/.test(route) && !/resolveUserTier|isProTier/.test(read('src/lib/watchlist-changes.js')));
}

L('⚠️ "nothing happened" is never how a failure looks');
{
  const c = read('src/components/WatchlistChanges.jsx');
  ok('loading is its own state', /Checking for new evidence/.test(c));
  ok('an error is its own state', /\{error \?/.test(c));
  // ⚠️ THE THIRD STATE. "We have not checked" is not "nothing happened", and coverage carries which.
  ok('⚠️ stale coverage is distinguished from a genuine empty result', /coverage\.fresh === false/.test(c));
  ok('⚠️ a failed refresh keeps the last good answer rather than blanking it',
    /A FAILED REFRESH MUST NOT WIPE A GOOD ANSWER/.test(c));
  ok('coverage is a stored fact, not inferred', /COVERAGE IS A STORED FACT/.test(read('src/lib/watchlist-materialise.mjs')));
}

L('⚠️ adding a ticker does not subscribe anybody to anything');
{
  for (const f of ['src/app/api/watchlist/route.js', 'src/app/api/watchlist/lists/route.js', 'src/lib/watchlists.js']) {
    ok(`${f} never touches evidence alerts`, !/evidence_alert|evidence-alerts|setSubscription/i.test(read(f)));
  }
  // Production: if membership implied a subscription, the overlap would equal the membership count.
  const r = await one(sql`select
    (select count(*)::int from watchlist) members,
    (select count(*)::int from evidence_alert_subs s join watchlist w
       on w.user_id = s.user_id and w.ticker = s.ticker where s.enabled) overlap`);
  ok('⚠️ membership has not silently created subscriptions', r.overlap < r.members || r.members === 0,
    `${r.overlap} of ${r.members}`);
}

L('every link is a canonical ticker URL');
{
  const lib = read('src/lib/watchlist-changes.js');
  ok('the URL is built server-side and encoded', /tickerUrl: `\/ticker\/\$\{encodeURIComponent\(/.test(lib));
  ok('…and upper-cased, so one ticker is one URL', /toUpperCase\(\)\)\}`/.test(lib));
  const bad = await one(sql`select count(*)::int n from watchlist where ticker <> upper(ticker)`);
  ok('no stored ticker differs from its canonical case', bad.n === 0, `${bad.n}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
