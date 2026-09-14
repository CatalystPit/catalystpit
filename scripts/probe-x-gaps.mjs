// Where do X candidates actually die? Answers two questions with data rather than guesses:
//   1. what ARE the not_required events that can never become eligible?
//   2. where do ticker-bearing, market-moving events get lost?
// Run: node --env-file=.env.local scripts/probe-x-gaps.mjs [hours]
import { neon } from '@neondatabase/serverless';
import { buildCandidate, evaluate } from '../src/lib/x-autopost.mjs';
import { publicationVerdict } from '../src/lib/x-quality.mjs';

const sql = neon(process.env.DATABASE_URL);
const hi = process.argv.indexOf('--hours');
const HOURS = Number(process.argv[2] || (hi >= 0 ? process.argv[hi + 1] : 72)) || 72;

const rows = await sql.query(`
  select e.seq, e.headline, e.summary, e.headline_status, e.importance, e.tickers, e.source_kind,
         e.source, e.source_type, e.category, e.published_at,
         array(select distinct m.source from primary_events m
                where m.seq = e.seq or m.cluster_id = e.seq) as sources
    from primary_events e
   where e.cluster_id is null
     and e.published_at > now() - ($1 || ' hours')::interval
     and (e.importance = 3 or exists (
           select 1 from primary_events w
            where (w.seq = e.seq or w.cluster_id = e.seq) and w.source = 'WALTERBLOOMBERG'))
   order by e.published_at desc`, [String(HOURS)]);

console.log(`${rows.length} prefilter-eligible events over ${HOURS}h\n`);

// ── 1. the not_required population ───────────────────────────────────────────
const nr = rows.filter((r) => r.headline_status === 'not_required');
console.log(`=== not_required: ${nr.length} (permanently ineligible today) ===`);
const byKind = {};
for (const r of nr) {
  const k = `${r.source}/${r.source_type}/${r.source_kind}`;
  byKind[k] = (byKind[k] || 0) + 1;
}
for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
console.log('  examples:');
for (const r of nr.slice(0, 8)) console.log(`    imp=${r.importance} [${r.source}] ${r.headline.slice(0, 96)}`);

const rp = rows.filter((r) => r.headline_status === 'rewrite_pending');
console.log(`\n=== rewrite_pending: ${rp.length} (waiting on the rewrite queue) ===`);
const rpBySrc = {};
for (const r of rp) rpBySrc[r.source] = (rpBySrc[r.source] || 0) + 1;
console.log(' ', JSON.stringify(rpBySrc));

// ── 2. ticker-bearing events ─────────────────────────────────────────────────
const withTicker = rows.filter((r) => (r.tickers || []).length > 0);
console.log(`\n=== ticker-bearing events: ${withTicker.length} of ${rows.length} ===`);
const fate = {};
for (const r of withTicker) {
  const ev = evaluate(r, Date.parse(r.published_at));
  let key;
  if (!ev.eligible) key = `ineligible: ${ev.blocked}`;
  else {
    const v = publicationVerdict(r, Date.parse(r.published_at));
    key = v.publish ? 'PUBLISHABLE' : `gate: ${v.reason}`;
  }
  fate[key] = (fate[key] || 0) + 1;
}
for (const [k, n] of Object.entries(fate).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);

console.log('\n  ticker events blocked ONLY by wording state (would pass the gate otherwise):');
let shown = 0;
for (const r of withTicker) {
  const ev = evaluate(r, Date.parse(r.published_at));
  if (ev.eligible) continue;
  const v = publicationVerdict(r, Date.parse(r.published_at));
  if (!v.publish) continue;
  if (shown++ >= 12) break;
  console.log(`    [${r.headline_status}] imp=${r.importance} $${(r.tickers || [])[0]} ${r.headline.slice(0, 92)}`);
}
if (!shown) console.log('    (none)');
