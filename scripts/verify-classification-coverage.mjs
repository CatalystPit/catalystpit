// A CANONICAL SECTOR MUST NOT SILENTLY BECOME "OTHER", AND THE REPAIR MUST SURVIVE THE REBUILD.
//
//   node --env-file=.env.local --experimental-loader ./scripts/ext-resolve-loader.mjs \
//        scripts/verify-classification-coverage.mjs [--mutate=m] [--live]
//
// ⚠️ THE FAILURE THIS GUARDS IS SILENT BY NATURE. 113 of the Top 500 rendered as "Other" — TSM,
// HSBC, BABA, SAP, BP — and nothing reported it. groupBySector's `r.sector || 'Other'` is not an
// error path, and the one alarm pointed at this had ADRC outside its denominator, so it could not
// ring. Both halves are asserted here.
//
// Mutations:
//   --mutate=excludeadr   the health probe drops ADRC from its denominator again
//   --mutate=stocksonly   the durable write goes to screener_stocks, which the rebuild erases

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1] || '';
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const fs = await import('node:fs/promises');
const read = (p) => fs.readFile(new URL(p, import.meta.url), 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const { SECTORS } = await import('../src/lib/market-taxonomy.mjs');
const { groupBySector, SECTOR_OTHER } = await import('../src/lib/heatmap/heatmap-layout.mjs');
const { TRADEABLE_ASSET_TYPES } = await import('../src/lib/heatmap/heatmap-universe.mjs');

const nameOf = (g) => g.sector ?? g.name ?? g.key;

L('=== ⚠️ A CANONICAL SECTOR CAN NEVER BECOME "OTHER" ===');
{
  const rows = SECTORS.map((s, i) => ({ ticker: `T${i}`, sector: s, marketCap: 1 }));
  const names = new Set(groupBySector(rows).map(nameOf));
  for (const s of SECTORS) ok(`${s} groups as itself`, names.has(s));
  ok('⚠️ none of them fell to Other', !names.has(SECTOR_OTHER));
  ok('the taxonomy carries 11 canonical sectors', SECTORS.length === 11, String(SECTORS.length));

  // ⚠️ AND "OTHER" MEANS UNCLASSIFIABLE, NOT UNRECOGNISED. There is deliberately no allow-list in
  // the heatmap: any non-empty string groups as itself, so a NEW canonical sector appears as its
  // own visible band rather than being silently swallowed.
  ok('⚠️ an unrecognised sector appears as itself, not as Other',
    groupBySector([{ ticker: 'X', sector: 'Some New Sector', marketCap: 1 }]).map(nameOf).includes('Some New Sector'));
  ok('only a null or empty sector becomes Other',
    groupBySector([{ ticker: 'Y', sector: null, marketCap: 1 }]).map(nameOf).includes(SECTOR_OTHER));
}

L('\n=== ⚠️ THE REPAIR MUST SURVIVE THE NIGHTLY REBUILD ===');
{
  const sd = strip(await read('../src/lib/screener-data.js'));
  ok('⚠️ the SEC fallback writes to screener_meta',
    mut('stocksonly') ? false : /update screener_meta/.test(sd),
    'screener_stocks is DELETEd by rebuildScreener and repopulated from screener_meta, so a repair written there is erased nightly');
  ok('…and rebuildScreener still repopulates sector FROM screener_meta',
    /sector: m\?\.sector \?\? null/.test(sd), 'which is exactly why screener_meta is the durable home');
  ok('…so the recovered value is carried forward rather than erased',
    /await db\.delete\(screenerStocks\)/.test(sd) && /update screener_meta/.test(sd));
  ok('⚠️ the write never clobbers an existing value',
    /sector\s*=\s*coalesce\(nullif\(trim\(sector\), ''\)/.test(sd),
    'a null from SEC must not erase a good Polygon value, nor the reverse');
  // ⚠️ SCOPED TO THE FUNCTION BODY. indexOf over the whole file found the IMPORT at the top and
  // reported the call as preceding the function it sits inside.
  const backfillBody = sd.slice(sd.indexOf('export async function backfillMeta'));
  ok('the fallback rides the existing metadata cron, not a new job',
    backfillBody.includes('resolveClassifications('),
    'a separate script with no cron is how the previous repair got erased nightly and nobody noticed');
  ok('⚠️ it only asks SEC for rows the vendor had no SIC for',
    /rows\.filter\(\(r\) => !Number\.isFinite\(r\.sicCode\)\)/.test(sd),
    'so a steady-state run costs zero requests');
  ok('a SEC outage is non-fatal', /SEC classification fallback skipped/.test(sd));
}

L('\n=== ⚠️ NOTHING IS HAND-MAPPED ===');
{
  const secRaw = await read('../src/lib/market/sec-classification.mjs');
  const sec = strip(secRaw);
  ok('⚠️ no ticker-to-sector table exists',
    !/(TSM|BABA|HSBC)\s*[:=]/.test(sec),
    'a lookup table would hide the architecture problem rather than fix it');
  ok('…the sector is derived by the SAME mapping domestic securities use',
    /import \{ sicToMarketSector \}/.test(sec) && /sicToMarketSector\(got\.sic\)/.test(sec));
  ok('⚠️ it fails closed — an unresolvable ticker is ABSENT from the result, not null-filled',
    /if \(got\) \{/.test(sec));
  ok('a SIC outside the taxonomy still leaves the sector null', /THE SECTOR MAY STILL BE NULL/.test(secRaw));
  ok('SEC is identified and paced', /User-Agent/.test(sec) && /PACE_MS/.test(sec));
  ok('an unreachable SEC writes nothing rather than nulls', /SEC unreachable/.test(secRaw));
}

L('\n=== ⚠️ THE HEALTH CHECK MEASURES THE UNIVERSE IT PROTECTS ===');
{
  const h = strip(await read('../src/app/api/health/route.js'));
  ok('⚠️ ADRC is INSIDE the denominator',
    mut('excludeadr') ? false : !/'ADRC','FUND','ETF'/.test(h) && /TRADEABLE_ASSET_TYPES/.test(h),
    'the heatmap draws ADRC, so an alarm excluding it cannot detect the heatmap being broken');
  ok('…the denominator is literally the heatmap eligibility rule',
    /coalesce\(m\.asset_type, ''\) = any\(/.test(h) && /TRADEABLE_ASSET_TYPES\.join/.test(h));
  ok('⚠️ the threshold is UNCHANGED at 8%', /pctWeight < 8/.test(h),
    'the population was corrected and the data repaired; the bar was not moved');
  ok('ADR coverage is reported as its own number', /adrs: \{ total: r\.adrs/.test(h),
    'so a foreign-issuer gap cannot hide inside a market-wide average');
  ok('coverage is reported by count AND by weight', /pctByCount/.test(h) && /pctByWeight/.test(h));
  ok('the eligibility list is the shared constant',
    TRADEABLE_ASSET_TYPES.includes('ADRC') && TRADEABLE_ASSET_TYPES.includes('Stock'));
}

if (process.argv.includes('--live')) {
  L('\n=== LIVE: PRODUCTION CLASSIFICATION COVERAGE ===');
  const { sql } = await import('drizzle-orm');
  const { db } = await import('../src/lib/db.js');
  const { heatmapUniverse } = await import('../src/lib/heatmap/heatmap-store.js');
  const one = async (q) => (await db.execute(q)).rows?.[0] ?? {};

  const uni = await heatmapUniverse(500);
  const named = uni.filter((u) => u.sector).length;
  const other = uni.length - named;
  L(`  Top 500: ${named} named, ${other} Other (${((named / uni.length) * 100).toFixed(1)}% classified)`);
  ok('⚠️ Other is a genuine remainder, not a bucket', other <= uni.length * 0.05, `${other}/${uni.length}`);

  const by = {};
  for (const u of uni) { const k = u.sector || SECTOR_OTHER; by[k] = (by[k] || 0) + 1; }
  ok('⚠️ sector counts sum exactly to the universe',
    Object.values(by).reduce((a, b) => a + b, 0) === uni.length);
  ok('every named group is a canonical sector',
    Object.keys(by).every((k) => k === SECTOR_OTHER || SECTORS.includes(k)), Object.keys(by).join('|'));

  for (const t of ['TSM', 'HSBC', 'BABA', 'SAP', 'BP', 'NVS', 'SAN', 'SONY', 'UBS', 'ING', 'BHP']) {
    const r = await one(sql`select coalesce(s.sector, m.sector) sector, coalesce(s.sic_code, m.sic_code) sic
      from screener_stocks s left join screener_meta m on m.ticker = s.ticker where s.ticker = ${t}`);
    ok(`${t} carries a canonical sector`, Boolean(r.sector) && SECTORS.includes(r.sector), `${r.sector} (sic ${r.sic})`);
  }
  // ⚠️ DOMESTIC CONTROL — the repair must not have moved anything that already worked.
  for (const [t, want] of [['AAPL', 'Technology'], ['JPM', 'Financial Services'], ['XOM', 'Energy']]) {
    const r = await one(sql`select sector from screener_stocks where ticker = ${t}`);
    ok(`${t} is unchanged at ${want}`, r.sector === want, String(r.sector));
  }

  // ⚠️ DURABILITY IS TESTED ON THE ROWS THAT WERE ACTUALLY REPAIRED, not against a count I picked.
  // rebuildScreener() DELETEs screener_stocks nightly and repopulates it from screener_meta, so
  // "does the fix survive?" is exactly the question "is it in screener_meta?" — and an arbitrary
  // total would pass while every foreign issuer was still missing.
  const durable = await one(sql`select count(*)::int n from screener_meta
    where ticker in ('TSM','HSBC','BABA','SAP','BP','NVS','SAN','SONY','UBS','ING','BHP')
      and sector is not null and trim(sector) <> '' and sic_code is not null`);
  ok('⚠️ every repaired foreign issuer is durable in screener_meta',
    Number(durable.n) === 11, `${durable.n}/11 — the rest would be erased by the next rebuild`);

  // And the whole Top 500 must be reconstructible from screener_meta alone.
  // ⚠️ THE TOP 500 IS TAKEN FIRST, THEN THE GAP IS COUNTED WITHIN IT. The obvious spelling puts the
  // `m.sector is null` filter inside the subquery, which silently selects "the 500 largest rows
  // that are MISSING a sector" and reports 86 against a board that has 1 — a test measuring a
  // different population than the one it names.
  const fromMeta = await one(sql`select count(*) filter (where m_sector is null or trim(m_sector) = '')::int n from (
      select nullif(trim(coalesce(m.sector, '')), '') as m_sector
        from screener_stocks s
        left join screener_meta m on m.ticker = s.ticker
       where coalesce(s.market_cap, m.market_cap) > 0
         and coalesce(m.asset_type, '') = any(${sql`${`{${TRADEABLE_ASSET_TYPES.join(',')}}`}::text[]`})
       order by coalesce(s.market_cap, m.market_cap) desc limit 500) x`);
  ok('⚠️ the Top 500 survives a rebuild from screener_meta alone',
    Number(fromMeta.n) <= 25, `${fromMeta.n} of the top 500 would lose their sector`);

  const adr = await one(sql`select count(*)::int total, count(*) filter (where m.sector is null)::int missing
    from screener_meta m join screener_stocks s on s.ticker = m.ticker
    where upper(coalesce(m.asset_type, '')) = 'ADRC' and coalesce(s.market_cap, m.market_cap) > 0`);
  ok('⚠️ ADR classification coverage is high',
    Number(adr.missing) / Math.max(1, Number(adr.total)) < 0.1, `${adr.missing}/${adr.total} missing`);

  const sc = await one(sql`select count(*)::int total, count(*) filter (where sector is null or trim(sector) = '')::int missing
    from screener_stocks where market_cap > 0`);
  L(`  Screener: ${sc.missing}/${sc.total} missing sector (${((sc.missing / sc.total) * 100).toFixed(1)}%)`);
  ok('⚠️ the Screener gap closed with the same repair',
    Number(sc.missing) / Number(sc.total) < 0.12, `${sc.missing}/${sc.total}`);
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
