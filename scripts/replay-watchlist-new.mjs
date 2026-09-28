// HISTORICAL REPLAY of the Watchlist NEW eligibility pipeline over real canonical events.
//
//   node --env-file=.env.local --loader ./scripts/ext-resolve-loader.mjs scripts/replay-watchlist-new.mjs [days]
//
// ⚠️ WHAT THIS IS FOR. "NVDA works now" is not evidence that the system works. This replays every
// canonical event in a window through the SAME classifier, the SAME source gate and the SAME
// materiality rules the badge uses, and reports what would and would not have produced a NEW —
// so false negatives, false positives, duplicate counting and wrong-ticker counting are measured
// across the whole tape rather than argued about on three tickers.
//
// It reads production and writes nothing.
import fs from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { classifyCompanyEvent, sourceQuality, isEvidenceSource } from '../src/lib/evidence/company-events.mjs';
import { NEW_MATERIALITY_FLOOR, eligibleForNew, countNew } from '../src/lib/watchlist-new.mjs';

const DAYS = Number(process.argv[2] || 30);
const env = fs.readFileSync('.env.local', 'utf8');
const sql = neon(/DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/.exec(env)[1].trim());

const rows = await sql`
  SELECT seq, headline, source_headline, summary, source, tickers, published_at, cluster_id, event_key
    FROM primary_events
   WHERE published_at >= now() - make_interval(days => ${DAYS})
     AND coalesce(array_length(tickers, 1), 0) > 0
   ORDER BY published_at`;
console.log(`canonical events in the last ${DAYS} days with a ticker: ${rows.length}`);

const now = Date.now();
let sourceGated = 0, unclassified = 0, classified = 0, belowFloor = 0, eligible = 0;
const byType = new Map();
const perTickerDay = new Map();      // ticker|YYYY-MM-DD|type → count, for duplicate measurement
const multiTicker = [];

for (const r of rows) {
  const headline = r.source_headline || r.headline;
  if (!isEvidenceSource(r.source)) { sourceGated++; continue; }
  const spec = classifyCompanyEvent(headline, r.summary);
  if (!spec) { unclassified++; continue; }
  classified++;
  byType.set(spec.type, (byType.get(spec.type) || 0) + 1);

  const ev = {
    family: 'catalyst', type: spec.type, materiality: spec.materiality,
    publicTime: new Date(r.published_at).toISOString(), quality: sourceQuality(r.source),
  };
  if (!eligibleForNew(ev, { now })) { belowFloor++; continue; }
  eligible++;

  const day = new Date(r.published_at).toISOString().slice(0, 10);
  for (const t of r.tickers) {
    const k = `${t}|${day}|${spec.type}`;
    perTickerDay.set(k, (perTickerDay.get(k) || 0) + 1);
  }
  if ((r.tickers || []).length > 2) multiTicker.push({ headline, tickers: r.tickers, type: spec.type });
}

console.log(`\n── the funnel ──`);
console.log(`  source not allowed to be evidence : ${sourceGated}`);
console.log(`  allowed but states no event       : ${unclassified}`);
console.log(`  classified as a company event     : ${classified}`);
console.log(`  ...below the materiality floor    : ${belowFloor}  (floor ${NEW_MATERIALITY_FLOOR})`);
console.log(`  ...ELIGIBLE for a NEW badge       : ${eligible}`);

console.log(`\n── duplicate coverage, before and after canonical collapse ──`);
const raw = [...perTickerDay.values()].reduce((a, b) => a + b, 0);
const collapsed = perTickerDay.size;
console.log(`  raw (ticker, day, type) rows      : ${raw}`);
console.log(`  after collapsing to one per event : ${collapsed}`);
console.log(`  duplicate copies removed          : ${raw - collapsed}  (${((1 - collapsed / raw) * 100).toFixed(1)}% of rows were the same event again)`);
const worst = [...perTickerDay].sort((a, b) => b[1] - a[1]).slice(0, 8);
for (const [k, n] of worst) console.log(`    ${String(n).padStart(3)} copies  ${k}`);

console.log(`\n── events attached to several tickers ──`);
console.log(`  eligible events naming >2 tickers : ${multiTicker.length}`);
for (const m of multiTicker.slice(0, 6)) console.log(`    ${JSON.stringify(m.tickers)} ${m.type}  ${String(m.headline).slice(0, 72)}`);

console.log(`\n── what a NEW badge would be made of ──`);
for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1]).slice(0, 22)) {
  console.log(`  ${String(n).padStart(5)}  ${t}`);
}

// A per-ticker view: how many securities would badge at all, and how loud the loudest are.
const perTicker = new Map();
for (const k of perTickerDay.keys()) {
  const t = k.split('|')[0];
  perTicker.set(t, (perTicker.get(t) || 0) + 1);
}
const counts = [...perTicker.values()].sort((a, b) => a - b);
console.log(`\n── spread across the universe (${DAYS} days) ──`);
console.log(`  distinct securities with >=1 eligible event : ${perTicker.size}`);
console.log(`  median eligible events per such security    : ${counts[Math.floor(counts.length / 2)]}`);
console.log(`  p90                                          : ${counts[Math.floor(counts.length * 0.9)]}`);
console.log(`  max                                          : ${counts[counts.length - 1]}`);
console.log(`  securities with exactly one                  : ${counts.filter((c) => c === 1).length}`);
