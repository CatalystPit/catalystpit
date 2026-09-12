// Re-resolve every name-matched (source='sec-name') CUSIP via OpenFIGI (CUSIP is authoritative).
// Override where OpenFIGI returns a clean US ticker; keep the sec-name result where OpenFIGI can't
// map it (foreign CINS like ASML/Credo). Then update holdings + recompute ownership.
// Run: node --env-file=.env.local scripts/refigi-secname.mjs
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const US = new Set(['US', 'UN', 'UW', 'UQ', 'UA', 'UR', 'UP', 'UV', 'UF', 'UD']);
const isT = (t) => /^[A-Z][A-Z0-9.\-]{0,8}$/.test(t || '');
const norm = (t) => { const s = String(t || '').toUpperCase().trim().replace(/\//g, '.').replace(/\*/g, ''); return isT(s) ? s : null; };
const pick = (data) => {
  const c = (data || []).map((d) => ({ t: norm(d.ticker), us: US.has(d.exchCode), eq: d.marketSector === 'Equity' || /stock|depositary|adr|reit|share|fund|etp|unit/i.test(`${d.securityType2 || ''} ${d.securityType || ''}`) })).filter((x) => x.t);
  return (c.find((x) => x.us && x.eq) || c.find((x) => x.us))?.t || null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = await sql`SELECT cusip, ticker FROM cusip_map WHERE source='sec-name'`;
console.log('sec-name cusips to re-check:', rows.length);
const curBy = new Map(rows.map((r) => [r.cusip, r.ticker]));
const cusips = rows.map((r) => r.cusip);
let overridden = 0, kept = 0, failed = 0, processed = 0;
for (let i = 0; i < cusips.length; i += 10) {
  const batch = cusips.slice(i, i + 10);
  let data = null;
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch('https://api.openfigi.com/v3/mapping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch.map((c) => ({ idType: 'ID_CUSIP', idValue: c }))) });
      if (r.status === 429) { await sleep(3000 * (a + 1)); continue; }
      if (r.ok) { data = await r.json(); }
      break;
    } catch { await sleep(1500); }
  }
  const overrides = [];
  if (Array.isArray(data)) {
    data.forEach((res, j) => { const c = batch[j]; const t = pick(res.data); if (t) { if (t !== curBy.get(c)) { overrides.push([c, t]); overridden++; } else kept++; } else failed++; });
  }
  if (overrides.length) {
    const cs = overrides.map((o) => o[0]), ts = overrides.map((o) => o[1]);
    await sql`INSERT INTO cusip_map (cusip,ticker,status,confidence,source,updated_at) SELECT u.cusip,u.t,'resolved','high','openfigi',now() FROM unnest(${cs}::text[],${ts}::text[]) AS u(cusip,t) ON CONFLICT (cusip) DO UPDATE SET ticker=excluded.ticker,status='resolved',source='openfigi',updated_at=now()`;
    await sql`UPDATE fund_holdings h SET ticker=m.t FROM unnest(${cs}::text[],${ts}::text[]) AS m(cusip,t) WHERE h.cusip=m.cusip`;
  }
  processed += batch.length;
  if (processed % 1000 < 10) console.log(`  ${processed}/${cusips.length} · overridden=${overridden} kept=${kept} openfigi-miss=${failed}`);
  await sleep(300);
}
console.log(`DONE: overridden=${overridden}, kept-same=${kept}, openfigi-miss(kept sec-name)=${failed}`);

await sql`DELETE FROM ticker_institutional_ownership`;
await sql`WITH latest AS (SELECT DISTINCT ON (cik) cik,quarter FROM fund_filings ORDER BY cik,quarter DESC),
  agg AS (SELECT h.ticker,SUM(h.shares)::double precision inst_shares,SUM(h.value)::double precision inst_value,COUNT(DISTINCT h.cik) filer_count,MAX(h.quarter) as_of FROM fund_holdings h JOIN latest l ON l.cik=h.cik AND l.quarter=h.quarter WHERE h.ticker IS NOT NULL AND coalesce(h.put_call,'')='' AND coalesce(h.shares,0)>0 GROUP BY h.ticker)
  INSERT INTO ticker_institutional_ownership (ticker,as_of_quarter,inst_shares,inst_value,filer_count,shares_out,ownership_pct,updated_at)
  SELECT a.ticker,a.as_of,a.inst_shares,a.inst_value,a.filer_count,so.shares_out,CASE WHEN so.shares_out>0 THEN a.inst_shares/so.shares_out*100 ELSE NULL END,now()
  FROM agg a LEFT JOIN LATERAL (SELECT coalesce(sm.shares_out,tf.outstanding_shares) shares_out FROM (SELECT 1) x LEFT JOIN screener_meta sm ON sm.ticker=a.ticker LEFT JOIN ticker_float tf ON tf.ticker=a.ticker) so ON true`;
console.log('ownership recomputed');
