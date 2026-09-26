// BACKFILL OFFICIAL OCC EQUITY-OPTIONS VOLUME.
//
//   node --env-file=.env.local --experimental-loader ./scripts/ext-resolve-loader.mjs \
//     scripts/backfill-occ-options.mjs [--since=2021-01-01] [--limit=2000]
//
// ⚠️ BOUNDED, RESUMABLE AND DEDUPLICATED BY CONSTRUCTION. The work queue is "market sessions we do
// not already hold", so stopping and restarting simply re-selects what is left and an already
// stored session is never asked for twice. There is no cursor to corrupt.
//
// ⚠️ AND IT ONLY EVER WRITES WHAT OCC ACTUALLY PUBLISHED. A session OCC has no data for is counted
// and skipped; a request that fails is counted and skipped. Nothing is interpolated, nothing is
// carried forward, and no row is written from a payload that failed its own arithmetic check.
//
// The market calendar comes from our own SPY daily bars, so holidays and weekends are never
// requested — the same calendar the index itself reports on.

import { sql } from 'drizzle-orm';
import { db } from '../src/lib/db.js';
import { ingestSessions, storedSessions, loadOptionsVolume } from '../src/lib/fear-greed/occ-store.mjs';

const arg = (k, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const SINCE = arg('since', '2021-01-01');
const LIMIT = Number(arg('limit', '3000'));

const res = await db.execute(sql`
  select date::text as date from ticker_daily_candles
   where ticker = 'SPY' and close > 0 and date >= ${SINCE}::date
   order by date asc`);
const sessions = (res?.rows ?? res ?? []).map((r) => String(r.date));
const before = await storedSessions(db);
console.log(`[occ] ${sessions.length} market sessions since ${SINCE}; ${before.size} already stored`);

const t0 = Date.now();
const stat = await ingestSessions(sessions, {
  limit: LIMIT,
  onProgress: (p) => {
    if (p.done % 120 === 0) {
      console.log(`[occ] ${p.done}/${p.asked} · stored ${p.stored} · unpublished ${p.unpublished} · failed ${p.failed}`);
    }
  },
});
console.log(`[occ] done in ${Math.round((Date.now() - t0) / 1000)}s: ${JSON.stringify(stat)}`);

const rows = await loadOptionsVolume(db, {});
console.log(`[occ] stored series: ${rows.length} sessions, ${rows[0]?.date} → ${rows.at(-1)?.date}`);
if (rows.length) {
  const r = rows.at(-1);
  console.log(`[occ] latest: ${r.date} calls ${r.calls.toLocaleString()} puts ${r.puts.toLocaleString()}`
    + ` → put/call ${(r.puts / r.calls).toFixed(4)}`);
}
// Gaps against the market calendar, named rather than silently tolerated.
const held = new Set(rows.map((r) => r.date));
const missing = sessions.filter((d) => !held.has(d));
console.log(`[occ] market sessions with no stored observation: ${missing.length}`
  + (missing.length ? ` — most recent ${missing.slice(-5).join(', ')}` : ''));
