// scripts/score-conviction.mjs
//
// Runs the Catalyst Pit Insider Conviction engine across eligible purchases and
// persists ONLY the publishable result: score, band, approved tags. No weight,
// threshold or factor value is ever written to the database, so nothing proprietary
// can leak through an API response or a cached row.
//
//   node --conditions react-server --env-file=.env.local scripts/score-conviction.mjs
//   node --conditions react-server --env-file=.env.local scripts/score-conviction.mjs --stats
//
// Run after scripts/build-insider-context.mjs — the score depends on the context
// columns that job materialises. Safe to re-run; it recomputes in place.
//
// This imports the server-only engine, so it MUST run with --conditions react-server.
// That resolves the `server-only` marker to its empty module the same way the Next
// server build does. Without the flag node throws - which is the guard working, and is
// exactly what would happen if this engine were ever pulled into a client bundle.

import postgres from 'postgres';
import { scoreConviction, convictionTags, isConvictionEligible } from '../src/lib/conviction.server.js';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 20, connect_timeout: 30 });
const STATS_ONLY = process.argv.includes('--stats');

// Wording must never outrun the data we hold. This derives the label from
// insider_history_meta, so a 3-year backfill says "3-YEAR HISTORY" and a 5-year one
// says "5-YEAR HISTORY" with no code change — and neither ever says "EVER".
async function historyLabel() {
  const [m] = await sql`SELECT covered_from, covered_to FROM insider_history_meta WHERE id = 1`;
  if (!m?.covered_from) return 'AVAILABLE HISTORY';
  const years = (new Date(m.covered_to || Date.now()) - new Date(m.covered_from)) / (365.25 * 864e5);
  if (years >= 0.9) return `${Math.round(years)}-YEAR HISTORY`;
  return `${Math.max(1, Math.round(years * 12))}-MONTH HISTORY`;
}

async function distribution() {
  const [d] = await sql`
    SELECT count(*)::int scored,
           count(*) FILTER (WHERE conviction_band = 'LOW')::int       low,
           count(*) FILTER (WHERE conviction_band = 'MODERATE')::int  moderate,
           count(*) FILTER (WHERE conviction_band = 'HIGH')::int      high,
           count(*) FILTER (WHERE conviction_band = 'VERY HIGH')::int very_high,
           count(*) FILTER (WHERE conviction_band = 'EXTREME')::int   extreme,
           round(avg(conviction)::numeric, 1)::text  avg,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY conviction)::int p50,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY conviction)::int p90,
           max(conviction)::int mx, min(conviction)::int mn
    FROM insider_trades WHERE conviction IS NOT NULL`;
  if (!d.scored) { console.log('nothing scored yet'); return d; }
  const pct = (n) => `${String(n).padStart(6)}  ${(n / d.scored * 100).toFixed(1).padStart(5)}%`;
  console.log(`\nscored ${d.scored}   min ${d.mn}  median ${d.p50}  avg ${d.avg}  p90 ${d.p90}  max ${d.mx}`);
  console.log(`  LOW       0-39  ${pct(d.low)}`);
  console.log(`  MODERATE 40-59  ${pct(d.moderate)}`);
  console.log(`  HIGH     60-74  ${pct(d.high)}`);
  console.log(`  VERY HIGH 75-89 ${pct(d.very_high)}`);
  console.log(`  EXTREME  90-100 ${pct(d.extreme)}`);
  return d;
}

async function examples() {
  for (const band of ['LOW', 'MODERATE', 'HIGH', 'VERY HIGH', 'EXTREME']) {
    const rows = await sql`
      SELECT ticker, executive, title, conviction, conviction_band, conviction_tags,
             total_value, transaction_date
      FROM insider_trades WHERE conviction_band = ${band}
      ORDER BY conviction DESC, total_value DESC LIMIT 2`;
    for (const r of rows) {
      const tags = (() => { try { return JSON.parse(r.conviction_tags || '[]'); } catch { return []; } })();
      console.log(`  ${String(r.conviction).padStart(3)} ${String(r.conviction_band).padEnd(10)} ${String(r.ticker).padEnd(7)} $${(Number(r.total_value) / 1e6).toFixed(2)}M  ${String(r.executive || '').slice(0, 24).padEnd(25)} ${tags.join(' · ')}`);
    }
  }
}

(async () => {
  if (STATS_ONLY) { await distribution(); console.log('\nexamples:'); await examples(); await sql.end(); return; }

  const label = await historyLabel();
  console.log(`[conviction] history label: "${label}"`);

  // Market caps let scale be judged against the company rather than in raw dollars.
  const caps = new Map();
  for (const r of await sql`SELECT ticker, market_cap FROM screener_stocks WHERE market_cap > 0`) {
    caps.set(r.ticker, Number(r.market_cap));
  }
  console.log(`[conviction] market caps available for ${caps.size} tickers`);

  const people = new Map();
  for (const p of await sql`SELECT * FROM insider_people`) people.set(p.owner_cik, p);
  console.log(`[conviction] insider baselines: ${people.size}`);

  let scored = 0, skipped = 0, page = 0;
  const PAGE = 5000;
  for (;;) {
    const rows = await sql`
      SELECT id, ticker, title, is_officer, is_director, is_ten_pct_owner, transaction_code,
             is_derivative, superseded_by, shares, total_value, owner_cik, ownership_type,
             rule_10b5_1, is_first_om_buy, months_since_prev_buy, om_buys_12m, om_buys_total,
             is_repeat_buyer, cluster_insiders_10d, ownership_increase_pct
      FROM insider_trades
      WHERE transaction_code = 'P' AND is_derivative = false AND superseded_by IS NULL
      ORDER BY id LIMIT ${PAGE} OFFSET ${page * PAGE}`;
    if (!rows.length) break;

    const updates = [];
    for (const row of rows) {
      if (!isConvictionEligible(row)) { skipped++; continue; }
      const person = people.get(row.owner_cik) || null;
      const s = scoreConviction(row, person, { marketCap: caps.get(row.ticker) });
      if (!s) { skipped++; continue; }
      // Only score, band and tags are persisted. s.factors stays in this process.
      updates.push([row.id, s.score, s.band, JSON.stringify(convictionTags(row, person, label))]);
      scored++;
    }

    // One statement per chunk via unnest: fast, and avoids postgres-js's VALUES-list
    // interpolation, which needs per-column casts to survive an empty or mixed batch.
    for (let i = 0; i < updates.length; i += 500) {
      const chunk = updates.slice(i, i + 500);
      await sql.unsafe(
        `UPDATE insider_trades AS t
            SET conviction = v.score, conviction_band = v.band,
                conviction_tags = v.tags, conviction_at = now()
           FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::double precision[]) AS score,
                        unnest($3::text[]) AS band, unnest($4::text[]) AS tags) v
          WHERE t.id = v.id`,
        [chunk.map((c) => c[0]), chunk.map((c) => c[1]), chunk.map((c) => c[2]), chunk.map((c) => c[3])],
      );
    }
    page++;
    process.stdout.write(`\r[conviction] scored ${scored}  skipped ${skipped}`);
  }
  console.log(`\n[conviction] done — scored ${scored}, skipped ${skipped}`);
  await distribution();
  console.log('\nexamples by band:');
  await examples();
  await sql.end();
})();
