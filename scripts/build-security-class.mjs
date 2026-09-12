// Rebuilds security_position_class from fund_holdings. Read-only against holdings; safe to re-run
// while the 13F backfill is writing.
//   node --env-file=.env.local scripts/build-security-class.mjs
import { neon } from '@neondatabase/serverless';
import { classifyWithFallback, RANKABLE, isForeignCusip } from '../src/lib/security-class.mjs';

const sql = neon(process.env.DATABASE_URL);
const rows = await sql`
  select h.cusip, h.class as cls, h.put_call, max(s.asset_type) as asset_type
    from fund_holdings h
    left join screener_stocks s on s.ticker = h.ticker
   group by h.cusip, h.class, h.put_call`;
console.log(`combinations to classify: ${rows.length.toLocaleString()}`);

const tally = {};
let wrote = 0;
for (let i = 0; i < rows.length; i += 500) {
  const batch = rows.slice(i, i + 500).map((r) => {
    const c = classifyWithFallback({ cls: r.cls, putCall: r.put_call, cusip: r.cusip, assetType: r.asset_type });
    tally[c.kind] = (tally[c.kind] || 0) + 1;
    return [r.cusip, r.cls ?? '', r.put_call ?? '', c.kind, c.source, c.confidence,
      RANKABLE.has(c.kind), isForeignCusip(r.cusip), (c.evidence ?? '').slice(0, 80)];
  });
  const vals = batch.map((_, j) => { const o = j * 9; return `($${o+1},$${o+2},$${o+3},$${o+4},$${o+5},$${o+6},$${o+7},$${o+8},$${o+9})`; }).join(',');
  await sql.query(
    `INSERT INTO security_position_class (cusip, cls, put_call, kind, source, confidence, rankable, foreign_cins, evidence)
     VALUES ${vals}
     ON CONFLICT (cusip, cls, put_call) DO UPDATE SET kind=excluded.kind, source=excluded.source,
       confidence=excluded.confidence, rankable=excluded.rankable, foreign_cins=excluded.foreign_cins,
       evidence=excluded.evidence, computed_at=now()`, batch.flat());
  wrote += batch.length;
}
console.log(`wrote ${wrote.toLocaleString()}`);
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(10)} ${v}`);
