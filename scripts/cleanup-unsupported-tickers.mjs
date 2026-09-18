// ONE-OFF CLEANUP: remove ticker associations the structural validation says are unsupported.
//
// Context: "BREAKING: $WEN Meritage Hospitality Group files for bankruptcy" was published to X. The
// resolver read the SOURCE headline ("Giant Wendy's franchisee Meritage Hospitality Group files for
// bankruptcy") and had no notion of who the sentence was about. `e14fee88` fixed that going forward;
// this repairs what was already stored.
//
// THE RULE — each EXISTING ticker is validated against the event we actually published:
//
//   keep = tickersSupportedBy( published_headline, existing_tickers )
//
// A ticker survives if the resolver confirms the company in our own sentence, or the symbol is
// printed in it, or the company's leading name token appears capitalised and NOT as somebody else's
// franchisee/partner/supplier. Nothing is ever added, and a genuine multi-company story keeps every
// symbol it earned.
//
// Validating the EXISTING tickers is the point. An earlier draft of this script re-resolved the
// source headline first and filtered that instead, which proposed stripping TXN from "TXN: TI raises
// dividend" and SPGI from "S&P Global to acquire OpenZeppelin" — both of which plainly name their
// company. The question is whether the published event supports the ticker, not whether today's
// resolver would rediscover it from the wire copy.
//
// TOUCHES ONE COLUMN. Events are not deleted, headlines are not rewritten, timestamps are not
// changed: the UPDATE sets `tickers` and nothing else.
//
// Dry run by default. Nothing is written without --apply.
//
//   node --env-file=.env.local scripts/cleanup-unsupported-tickers.mjs [--apply] [--days=14]

import postgres from 'postgres';
import { buildIndex, tickersSupportedBy } from '../src/lib/company-symbols.mjs';

const APPLY = process.argv.includes('--apply');
const DAYS = Number((process.argv.find((a) => a.startsWith('--days=')) || '--days=14').split('=')[1]) || 14;

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

try {
  // The same reference data production resolves against, so the cleanup cannot disagree with it.
  const a = await sql`select distinct on (ticker) ticker, company from insider_trades
                       where company is not null and company <> '' order by ticker, filing_date desc`;
  const b = await sql`select ticker, company, industry from screener_stocks
                       where company is not null and company <> ''`;
  const idx = buildIndex([...a, ...b]);
  console.log(`reference index: ${idx.size} keys · window: ${DAYS} days · mode: ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  // PUBLISHED events only. An event nobody ever saw is not part of this incident, and rewriting
  // rows the product never showed would be a broader change than the one that was approved.
  const rows = await sql`
    select e.seq, e.tickers, e.headline, e.source_headline, e.headline_status, e.first_seen_at,
           exists(select 1 from x_post_candidates c  where c.event_seq = e.seq and c.status = 'posted') px,
           exists(select 1 from fb_post_candidates f where f.event_seq = e.seq and f.status = 'posted') pf
      from primary_events e
     where e.first_seen_at > now() - (${DAYS} || ' days')::interval
       and coalesce(array_length(e.tickers, 1), 0) > 0
     order by e.first_seen_at`;

  const published = rows.filter((r) => r.px || r.pf);
  console.log(`events with tickers: ${rows.length} · of which published: ${published.length}`);

  const audit = [];
  for (const r of published) {
    const existing = [...new Set((r.tickers || []).filter(Boolean))];
    const supported = new Set(tickersSupportedBy(r.headline, existing, idx));
    const keep = existing.filter((t) => supported.has(t));
    const remove = existing.filter((t) => !supported.has(t));
    if (remove.length) {
      audit.push({ seq: String(r.seq), headline: r.headline, source: r.source_headline,
        before: existing, keep, remove, px: r.px, pf: r.pf });
    }
  }

  const removedAssociations = audit.reduce((s, x) => s + x.remove.length, 0);
  const keptSome = audit.filter((x) => x.keep.length > 0);

  console.log(`\n=== events to correct: ${audit.length} · ticker associations to remove: ${removedAssociations} ===\n`);
  for (const x of audit) {
    console.log(`  seq=${x.seq.padEnd(8)} ${x.px ? '[X]' : ''}${x.pf ? '[FB]' : ''}`);
    console.log(`     headline : ${String(x.headline).slice(0, 96)}`);
    console.log(`     before   : ${JSON.stringify(x.before)}   remove: ${JSON.stringify(x.remove)}   keep: ${JSON.stringify(x.keep)}`);
  }
  console.log(`\n  events retaining at least one legitimate ticker: ${keptSome.length}`);
  for (const x of keptSome) console.log(`     seq=${x.seq} keeps ${JSON.stringify(x.keep)}`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to perform the cleanup.');
  } else {
    let updated = 0;
    for (const x of audit) {
      // Guarded on the exact prior value, so a row that changed since the dry run is skipped rather
      // than overwritten. ONLY the tickers column is touched.
      const res = await sql`
        update primary_events
           set tickers = ${x.keep}::text[]
         where seq = ${Number(x.seq)}
           and tickers = ${x.before}::text[]`;
      if (res.count) updated += 1;
      else console.log(`  SKIPPED seq=${x.seq} — tickers changed since the dry run`);
    }
    console.log(`\nAPPLIED: ${updated}/${audit.length} events updated, ${removedAssociations} associations removed.`);
  }
} finally {
  await sql.end();
}
