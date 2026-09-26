// The prior-ownership view: what an amendment CHANGED, not just what it reports.
//
//   node --env-file=.env.local --loader ./scripts/ext-resolve-loader.mjs scripts/create-13d-prior-view.mjs
//
// ⚠️ A VIEW RATHER THAN STORED COLUMNS, DELIBERATELY. The filing an amendment points back to may
// arrive in our record AFTER the amendment does — we ingest forward from 2026-09-02, and most
// amendments reference filings older than that. Stored deltas computed at insert time would be
// permanently null for those and would never repair themselves. A view recomputes on every read, so
// a link becomes resolvable the moment the earlier filing lands.
//
// ⚠️ AND IT REFUSES TO TURN A PERCENTAGE MOVE INTO A STAKE MOVE WHEN THE SHARES SAY OTHERWISE.
// Measured on our own data: CTNT amends from 62.5% to 0.9% while holding exactly 1,846,000 shares
// both times. Nobody sold anything — the denominator changed, or the two filings describe different
// classes. Reporting "-61.6 points" there would be a false statement about what the holder did. So
// the view exposes BOTH deltas and a flag for when they disagree, and any caller that wants to say
// "increased" or "reduced" has to look at the flag first.
import { sql } from 'drizzle-orm';
import { db } from '../src/lib/db.js';

await db.execute(sql`drop view if exists schedule13d_with_prior`);
await db.execute(sql`
  create view schedule13d_with_prior as
  select
    f.*,
    prev.accession     as prior_accession,
    prev.filed_at      as prior_filed_at,
    prev.pct_of_class  as prior_pct_of_class,
    prev.shares        as prior_shares,
    prev.sole_voting   as prior_sole_voting,
    prev.shared_voting as prior_shared_voting,
    -- the two deltas, each null unless BOTH sides are present
    case when f.pct_of_class is not null and prev.pct_of_class is not null
         then f.pct_of_class - prev.pct_of_class end as pct_change,
    case when f.shares is not null and prev.shares is not null
         then f.shares - prev.shares end as share_change,
    -- ⚠️ THE DISAGREEMENT FLAG. True when the percentage moved materially while the share count did
    -- not, which means the move is in the denominator and is NOT a purchase or a sale. A caller that
    -- says "raised its stake" without checking this will eventually say it about a reverse split.
    case
      when f.pct_of_class is null or prev.pct_of_class is null
        or f.shares is null or prev.shares is null then null
      when abs(f.pct_of_class - prev.pct_of_class) >= 0.5
       and (prev.shares = 0 or abs(f.shares - prev.shares) / nullif(prev.shares, 0) < 0.01)
        then true
      else false
    end as pct_moved_without_shares,
    -- a direction word only where both measures agree, otherwise null and the caller must say nothing
    case
      when f.shares is null or prev.shares is null then null
      when f.shares > prev.shares then 'increased'
      when f.shares < prev.shares then 'reduced'
      else 'unchanged'
    end as share_direction
  from schedule13d_filings f
  left join schedule13d_filings prev on prev.accession = f.previous_accession`);

const L = (s = '') => console.log(s);
L('[13d] view schedule13d_with_prior created');
L();
const r = await db.execute(sql`
  select count(*)::int total,
         count(prior_accession)::int resolved,
         count(pct_change)::int with_pct_delta,
         count(*) filter (where pct_moved_without_shares)::int denominator_moves
    from schedule13d_with_prior`);
L('coverage: ' + JSON.stringify((r.rows ?? r)[0]));
L();
const s = await db.execute(sql`
  select ticker, filed_at::date d, prior_pct_of_class was, pct_of_class cur,
         pct_change, share_change, share_direction, pct_moved_without_shares
    from schedule13d_with_prior
   where prior_accession is not null
   order by filed_at desc limit 10`);
L('what it now says about each amendment:');
for (const x of (s.rows ?? s)) {
  const flag = x.pct_moved_without_shares ? '  ⚠️ DENOMINATOR MOVE — not a purchase or sale' : '';
  L(`  ${String(x.ticker).padEnd(6)} ${x.d}  ${x.was ?? '—'}% -> ${x.cur ?? '—'}%`
    + `  shares ${x.share_change == null ? '—' : (Number(x.share_change) >= 0 ? '+' : '') + Number(x.share_change).toLocaleString()}`
    + `  ${x.share_direction ?? '—'}${flag}`);
}
process.exit(0);
