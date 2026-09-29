// 13F / INSTITUTIONAL DATA INTEGRITY.
//
//   node --import ./scripts/lib/node-resolve-hook.mjs --env-file=.env.local scripts/verify-13f-integrity.mjs
//
// ⚠️ THE TWO DEFECTS THIS PINS, both found by auditing production rather than reading the code.
//
// 1. THE OWNERSHIP AGGREGATE DELETED LEGITIMATE POSITIONS. Its amendment guard deduped on
//    (cik, quarter, cusip) and then kept only rows carrying the winning accession, so whenever one
//    CUSIP held two share classes reported by two accessions of the same quarter, one real position
//    was dropped. 3,324 groups in the live corpus are in that shape. The table's own unique key is
//    (cik, quarter, cusip, class, put_call) — and it has to be, because a filer may use ONE CUSIP for
//    SEVERAL securities: verified against the SEC document, First Trust files cusip 336917109
//    thirty-four times in one information table under 31 different titleOfClass values.
//
// 2. IT PUBLISHED PERCENTAGES BUILT ON IMPOSSIBLE DENOMINATORS. QNTM carried shares_out = 42 while 26
//    funds reported 461,546 shares between them, and the page read "1,098,919% of shares outstanding".
//    The test is arithmetic — one fund cannot hold more shares than exist — not a cap: crossing 100%
//    in aggregate is legitimate (two managers sharing voting authority both report the same shares)
//    and 1,835 tickers still do.
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const one = async (q) => (await q)[0];
const SRC = readFileSync(new URL('../src/lib/institutions-universe.js', import.meta.url), 'utf8');
const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|--)/.test(l.trim())).join('\n');

L('the forms we ingest, and the one we deliberately do not');
{
  // 13F-NT is a NOTICE: the manager states that its holdings are reported on another manager's filing,
  // so it carries no information table. Ingesting it would create empty quarters.
  ok('⚠️ only 13F-HR and its amendments are ingested', /startsWith\('13F-HR'\)/.test(code));
  ok('⚠️ 13F-NT is not ingested as holdings', !/13F-NT/.test(code.replace(/'13F-HR'/g, '')));
  ok('the amendment form is reached by the same prefix', /13F-HR/.test(SRC) && /\/A/.test(SRC));
}

L('⚠️ amendment classification comes from the SEC cover page, not from the form suffix');
{
  // The SEC defines exactly two amendment types and they mean opposite things. Treating NEW HOLDINGS
  // as a RESTATEMENT discards the original: ExodusPoint's Q1 2026 went 1,454 positions -> 41.
  ok('⚠️ amendmentType is read from primary_doc.xml', /primary_doc\.xml/.test(code) && /amendmentType/.test(code));
  // ⚠️ THE TEST ITSELF, NOT THE IDENTIFIER. An earlier version checked only that isAdditive existed,
  // so rewriting it to return a constant — every amendment additive, or none — passed both ways. Those
  // are the two worst outcomes available: one discards every original, the other discards every
  // addition.
  ok('⚠️ additive means the SEC amendmentType says NEW HOLDINGS',
    /const isAdditive = \(f\) => \/NEW\\s\*HOLDINGS\/i\.test\(f\.amendmentType \|\| ''\);/.test(code),
    'isAdditive must read amendmentType, not return a constant');
  ok('⚠️ an unreadable amendment type is treated as a RESTATEMENT, the conservative reading',
    /isAmendment: null, amendmentType: null/.test(SRC));
  ok('a plain 13F-HR needs no cover-page fetch — it restates by definition',
    /if \(!f\.form\.endsWith\('\/A'\)\)/.test(code));
  ok('⚠️ only additive amendments filed AFTER the base are layered',
    /marked\.slice\(baseIdx \+ 1\)\.filter\(isAdditive\)/.test(code));
}

L('⚠️ the operative quarter is resolved at INGEST, so no consumer has to filter amendments');
{
  ok('a quarter is rewritten wholesale, never appended to', /delete\(fundHoldings\)/.test(code));
  ok('⚠️ ...and a newer existing filing is never overwritten by an older one',
    /String\(existing\.filedDate \|\| ''\) > String\(filedDate\)/.test(code));
  ok('⚠️ ...and a stale position count forces a rewrite, which is what heals old quarters',
    /existing\.holdingsCount === agg\.length/.test(code));
  ok('every stored row keeps the accession it came from', /accession/.test(code));

  // Against PRODUCTION: one operative filing per fund-quarter, enforced by the primary key.
  const d = await one(sql`SELECT
    (SELECT count(*)::int FROM (SELECT cik, quarter FROM fund_filings GROUP BY 1,2 HAVING count(*)>1) t) dup_filing,
    (SELECT count(*)::int FROM (SELECT cik,quarter,cusip,class,put_call FROM fund_holdings GROUP BY 1,2,3,4,5 HAVING count(*)>1) t) dup_position,
    (SELECT count(*)::int FROM fund_filings f WHERE NOT EXISTS (SELECT 1 FROM fund_holdings h WHERE h.cik=f.cik AND h.quarter=f.quarter)) filing_no_holdings,
    (SELECT count(*)::int FROM (SELECT f.cik,f.quarter FROM fund_filings f JOIN fund_holdings h ON h.cik=f.cik AND h.quarter=f.quarter
       GROUP BY 1,2,f.holdings_count HAVING f.holdings_count IS DISTINCT FROM count(*)) t) count_mismatch`);
  ok('⚠️ no duplicate operative filing', d.dup_filing === 0, String(d.dup_filing));
  ok('⚠️ no duplicate economic position', d.dup_position === 0, String(d.dup_position));
  ok('⚠️ no quarter left from the old restatement-only logic', d.count_mismatch === 0, String(d.count_mismatch));
  ok('no filing without holdings', d.filing_no_holdings === 0, String(d.filing_no_holdings));
}

L('⚠️ a placeholder information table is not a portfolio');
{
  // Some managers satisfy the filing requirement with one non-position: CUSIP 000000000, value 0,
  // shares 0 — Norges Bank's Q1 2026 is 627 bytes and exactly that. Stored as a quarter it became the
  // filer's LATEST, and the ownership aggregate reads each fund's latest quarter, so the fund's real
  // disclosure stopped counting. 253 funds were contributing nothing on the strength of one.
  ok('⚠️ the ingest drops the SEC placeholder CUSIP',
    /!== '000000000'/.test(code) && /rows = rows\.filter/.test(code));
  ok('⚠️ ...and a placeholder-only table is recorded, not stored',
    /reason: 'placeholder-table'/.test(code));
  ok('⚠️ the aggregate skips a placeholder quarter when choosing the latest',
    /h\.cusip <> '000000000'/.test(code),
    'without this a placeholder filing erases the fund from ownership');
  // ⚠️ total_value IS NOT THE TEST, and must not become one: 56 substantive quarters legitimately
  // total 0 and have to stay.
  ok('⚠️ the test is the placeholder CUSIP, never a zero total value',
    !/total_value\s*[>=]\s*0/.test(code.slice(code.indexOf('WITH latest AS ('), code.indexOf('primary_cusip AS ('))),
    '56 real quarters total 0 and would be skipped');

  const ph = await one(sql`
    WITH per AS (SELECT cik, quarter, count(*)::int n, count(*) FILTER (WHERE cusip='000000000')::int z
                   FROM fund_holdings GROUP BY 1,2),
    bad AS (SELECT cik, quarter FROM per WHERE n = z),
    latest AS (SELECT DISTINCT ON (cik) cik, quarter FROM fund_filings f
                WHERE EXISTS (SELECT 1 FROM fund_holdings h WHERE h.cik=f.cik AND h.quarter=f.quarter AND h.cusip<>'000000000')
                ORDER BY cik, quarter DESC)
    SELECT count(*)::int still_erased FROM latest l JOIN bad b ON b.cik=l.cik AND b.quarter=l.quarter`);
  ok('⚠️ no fund\'s operative quarter is a placeholder', ph.still_erased === 0, String(ph.still_erased));
  const o = await one(sql`SELECT count(*)::int n FROM ticker_institutional_ownership WHERE ticker='AAPL'`);
  ok('the aggregate still produces rows after the exclusion', o.n === 1);
}

L('⚠️ report period and filing date are separate clocks');
{
  const c = await one(sql`SELECT
    (SELECT count(*)::int FROM fund_filings WHERE filed_date < quarter) filed_before_period,
    (SELECT count(*)::int FROM fund_filings WHERE quarter > current_date) future_period,
    (SELECT count(*)::int FROM fund_filings WHERE filed_date > current_date) future_filed`);
  ok('⚠️ no filing predates the period it reports', c.filed_before_period === 0, String(c.filed_before_period));
  ok('no future report period', c.future_period === 0, String(c.future_period));
  ok('no future filing date', c.future_filed === 0, String(c.future_filed));

  // ⚠️ LATEST MEANS LATEST REPORT PERIOD, NOT LATEST FILING DATE. A manager back-filing eight quarters
  // today must not make 2024-09-30 the current quarter.
  ok('⚠️ the aggregate picks each fund\'s latest QUARTER',
    /DISTINCT ON \(cik\) cik, quarter[\s\S]{0,400}?ORDER BY cik, quarter DESC/.test(code),
    'ordering by filed_date here would promote an old report period');
  const qoq = readFileSync(new URL('../src/lib/fund-qoq.js', import.meta.url), 'utf8');
  // Scoped to the PAIR query. fund-qoq.js prunes old rows with the same ordering, so an unscoped
  // match passed even when the pair itself had been switched to filing date.
  ok('⚠️ the QoQ pair is the two latest QUARTERS',
    /select quarter from fund_filings group by quarter order by quarter desc limit 2/.test(qoq),
    'ordering the pair by filed_date compares whatever was filed last, not the last two periods');
  const inst = readFileSync(new URL('../src/app/api/institutions/route.js', import.meta.url), 'utf8');
  ok('⚠️ the previous quarter is the fund\'s own prior REPORT PERIOD',
    /lag\(quarter\) over \(partition by cik order by quarter\)/.test(inst),
    'a filing-date lag would compare against whatever was filed before, not the prior period');
  ok('⚠️ one submission back-filing many quarters is ONE disclosure',
    /distinct on \(cik, filed_date\)/.test(inst));
}

L('⚠️ point-in-time: the quarter is the event, the filing date is when it became public');
{
  const res = readFileSync(new URL('../src/lib/evidence/resolve.js', import.meta.url), 'utf8');
  const block = res.slice(res.indexOf("family: FAMILY.INSTITUTION, type: 'institution_breadth_change'") - 400);
  ok('⚠️ eventTime is the quarter end', /eventTime: latest\.quarter/.test(block));
  ok('⚠️ publicTime is the filing date', /publicTime: latest\.filed/.test(block));
  ok('...and they are not the same field', !/publicTime: latest\.quarter/.test(block));
  const model = readFileSync(new URL('../src/lib/evidence/model.mjs', import.meta.url), 'utf8');
  ok('⚠️ an alert compares publicTime and nothing else',
    /export function changedSince/.test(model) && /toEpoch\(e\?\.publicTime\)/.test(model));
}

L('⚠️ QoQ classification, and why no percentage can be infinite');
{
  const inst = readFileSync(new URL('../src/app/api/institutions/route.js', import.meta.url), 'utf8');
  ok('⚠️ absent previous side is NEW', /when prev_shares is null then 'NEW'/.test(inst));
  ok('⚠️ absent current side is EXITED', /when cur_shares is null then 'EXITED'/.test(inst));
  ok('increase and decrease carry a dead band',
    /cur_shares > prev_shares \* 1\.001/.test(inst) && /cur_shares < prev_shares \* 0\.999/.test(inst));
  ok('⚠️ an EXITED position is reachable at all — the join is a FULL OUTER JOIN',
    /full outer join/.test(inst), 'an inner join cannot express a sold-out position');
  ok('⚠️ the exit\'s disclosure date is taken from whichever side has one',
    /coalesce\(c\.filed_date, v\.filed_date\)/.test(inst));
  // ⚠️ NO RATIO IS COMPUTED, which is why a zero denominator cannot produce Infinity here.
  ok('⚠️ no percentage change is derived from prev_shares',
    !/prev_shares\s*\)?\s*\*\s*100/.test(inst) && !/\/\s*prev_shares/.test(inst),
    'a ratio here would divide by zero on a NEW position');
  // Options must never be compared against common stock.
  ok('⚠️ put_call is part of the position key', /group by p\.cik, p\.quarter, p\.filed_date, p\.accession, h\.cusip, h\.put_call/.test(inst));
  ok('⚠️ ...and part of the previous-quarter join', /v\.put_call = c\.put_call/.test(inst));
}

L('⚠️ the aggregate keys on the FULL position, so a share class cannot be dropped');
{
  ok('⚠️ pick dedupes on (cik, quarter, cusip, class)',
    /DISTINCT ON \(cik, quarter, cusip, class\)/.test(code),
    'deduping on cusip alone drops one of two classes reported by two accessions');
  ok('⚠️ ...and kept joins on class too', /pk\.class = sc\.class/.test(code));
  ok('scoped carries class for that key to exist', /SELECT h\.ticker, h\.cik, h\.quarter, h\.cusip, h\.class/.test(code));

  // Against PRODUCTION: the shape the old key mishandled still exists, so the guard is load-bearing.
  const at = await one(sql`SELECT count(*)::int n FROM (
    SELECT cik, quarter, cusip FROM fund_holdings WHERE coalesce(put_call,'')=''
     GROUP BY 1,2,3 HAVING count(DISTINCT class)>1 AND count(DISTINCT accession)>1) t`);
  ok('⚠️ the corpus still contains multi-class multi-accession groups', at.n > 0,
    `${at.n} — if this reaches 0 the assertion above stops being exercised by real data`);
}

L('⚠️ ownership counts common stock only');
{
  // ⚠️ SCOPED TO THE CTE THAT FEEDS THE SUM. primary_cusip carries both of these clauses too, so an
  // unscoped match survived deleting them from `scoped` — the one place where they decide the number.
  const scopedCte = code.slice(code.indexOf('scoped AS ('), code.indexOf('pick AS ('));
  ok('⚠️ puts and calls are excluded from the summed set',
    /coalesce\(h\.put_call, ''\) = ''/.test(scopedCte),
    'without this the sum counts option contracts as shares');
  ok('⚠️ debt, options, warrants, rights and preferreds are excluded from the summed set',
    /NOT IN \('debt', 'option', 'warrant', 'right', 'preferred'\)/.test(scopedCte),
    "a convertible note's shares column is FACE VALUE — Akamai read 2,984M shares against 144M outstanding");
  ok('⚠️ a derivative most filers label as one is excluded even with a blank put_call',
    /mislabelled_option/.test(code));
  ok('the primary CUSIP only ever protects a security from exclusion', /primary_cusip/.test(code));

  const o = await one(sql`SELECT
    (SELECT count(*)::int FROM ticker_institutional_ownership WHERE ownership_pct > 1000) over1000,
    (SELECT count(*)::int FROM ticker_institutional_ownership) rows,
    (SELECT count(*)::int FROM ticker_institutional_ownership WHERE inst_shares IS NULL OR inst_shares <= 0) nonpositive,
    (SELECT count(*)::int FROM ticker_institutional_ownership WHERE filer_count IS NULL OR filer_count < 1) no_filers`);
  ok('⚠️ no percentage above 1000% survives', o.over1000 === 0, String(o.over1000));
  ok('every row has a positive share count', o.nonpositive === 0, String(o.nonpositive));
  ok('every row has at least one filer', o.no_filers === 0, String(o.no_filers));
}

L('⚠️ no percentage on an arithmetically impossible denominator');
{
  ok('⚠️ the guard compares the largest single position to shares_out',
    /a\.max_single_position <= so\.shares_out/.test(code));
  ok('⚠️ ...and withholds the denominator with the ratio', (code.match(/max_single_position <= so\.shares_out/g) || []).length === 2);
  ok('max_single_position is computed but never published', /MAX\(kept\.shares\)::double precision AS max_single_position/.test(code));

  // Against PRODUCTION: not one published ratio may rest on a denominator that a single CONTRIBUTING
  // position exceeds.
  //
  // ⚠️ "CONTRIBUTING" IS LOAD-BEARING, AND AN EARLIER VERSION OF THIS ASSERTION GOT IT WRONG. Taking
  // the max over all common-stock rows reported 75 failures — every one a convertible note, whose
  // `shares` column is FACE VALUE, not a share count: CDLX's "NOTE 4.250%" reads 53,802,000 against
  // 5,888,716 shares outstanding. The aggregate already excludes debt, so those rows never reach the
  // ratio and cannot invalidate its denominator. Mirroring that exclusion is what makes this test
  // measure the aggregate rather than something the aggregate never looked at.
  const bad = await one(sql`
    WITH latest AS (SELECT DISTINCT ON (cik) cik, quarter FROM fund_filings ORDER BY cik, quarter DESC),
    biggest AS (
      SELECT h.ticker, max(h.shares) m
        FROM fund_holdings h
        JOIN latest l ON l.cik = h.cik AND l.quarter = h.quarter
        LEFT JOIN security_position_class s
          ON s.cusip = h.cusip AND s.cls = h.class AND s.put_call = h.put_call
       WHERE h.ticker IS NOT NULL AND coalesce(h.put_call,'') = '' AND h.shares > 0
         AND (s.kind IS NULL OR s.kind NOT IN ('debt','option','warrant','right','preferred'))
       GROUP BY 1)
    SELECT count(*)::int n FROM ticker_institutional_ownership o JOIN biggest b ON b.ticker=o.ticker
     WHERE o.ownership_pct IS NOT NULL AND b.m > o.shares_out`);
  ok('⚠️ zero published ratios rest on an impossible denominator', bad.n === 0, String(bad.n));
  // And the 13F facts are still there for the suppressed ones.
  const kept = await one(sql`SELECT count(*)::int n FROM ticker_institutional_ownership
    WHERE ownership_pct IS NULL AND inst_shares > 0 AND filer_count > 0`);
  ok('⚠️ suppressing the ratio does not discard the Form 13F facts', kept.n > 0, `${kept.n} rows keep shares and filers`);
}

L('⚠️ legitimate aggregate double counting is NOT capped');
{
  // Two managers sharing voting authority over the same shares both report them. Capping would invent
  // a number; this asserts the product still reports what the filings say.
  const over = await one(sql`SELECT count(*)::int n FROM ticker_institutional_ownership WHERE ownership_pct > 100`);
  ok('⚠️ tickers above 100% with a possible denominator are still published', over.n > 0, `${over.n}`);
  // Case-insensitive: the earlier version spelled LEAST in capitals and missed a lower-case least().
  ok('...and no arbitrary ceiling exists in the aggregate',
    !/\bleast\s*\(|THEN\s+100\b/i.test(code),
    'capping at 100% publishes a number no filing supports');
}

L('⚠️ EVERY place that resolves a 13F position keys on the FULL position');
{
  // ⚠️ THERE ARE TWO IMPLEMENTATIONS OF THIS RULE, NOT ONE, and the second was found by this suite
  // rather than by reading the code: screener-data.js's fund-net computation carried the identical
  // (cik, quarter, cusip) key and the identical class-dropping bug — worse there, because per_security
  // sums classes together immediately afterwards, so the lost position vanished silently into the net.
  //
  // Extracting one shared helper across two large statements with different surrounding CTEs is a
  // refactor this task did not ask for. Asserting the invariant in every implementation is what stops
  // them diverging, which is the property that actually matters.
  const IMPLS = ['../src/lib/institutions-universe.js', '../src/lib/screener-data.js'];
  for (const f of IMPLS) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    const name = f.split('/').pop();
    const picks = [...src.matchAll(/distinct on \(cik, quarter, cusip([^)]*)\)/gi)].map((m) => m[1].trim());
    ok(`${name}: every position dedupe includes class`,
      picks.length > 0 && picks.every((p) => /,\s*class/i.test(p)),
      `found ${picks.length}: ${JSON.stringify(picks)}`);
    ok(`${name}: ...and the join back to the rows includes class`,
      /l\.class = sc\.class|pk\.class = sc\.class/.test(src));
  }
  // Nothing else may invent a third rule.
  const OTHERS = ['../src/app/api/institutions/route.js', '../src/lib/fund-qoq.js',
    '../src/lib/institutions-activity.mjs', '../src/lib/evidence/resolve.js',
    '../src/lib/consensus/build-context.mjs', '../src/lib/ticker-seo.mjs',
    '../src/lib/confluence.js', '../src/lib/evidence/timeline.js'];
  for (const f of OTHERS) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    const name = f.split('/').pop();
    ok(`${name} reads the operative table and adds no amendment rule`,
      !/amendmentType|NEW\s+HOLDINGS|13F-HR\/A/i.test(src.replace(/^\s*(\/\/|--).*$/gm, '')),
      'a third amendment rule here would diverge from the other two');
  }
}

L('live ingestion applies the same rule going forward');
{
  const cron = readFileSync(new URL('../src/app/api/cron/institutions/route.js', import.meta.url), 'utf8');
  ok('⚠️ the cron ingests through the same module the backfill uses',
    /institutions-universe/.test(cron));
  ok('⚠️ ...and the ownership aggregate is a separate scheduled recompute',
    /runOwnershipAggregate/.test(readFileSync(new URL('../src/app/api/cron/institutions-ownership/route.js', import.meta.url), 'utf8')));
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const paths = (vercel.crons || []).map((c) => c.path);
  ok('⚠️ institutions ingestion is scheduled', paths.some((p) => /institutions(\?|$)/.test(p)), paths.filter((p) => /institution/.test(p)).join(' '));
  ok('⚠️ the ownership recompute is scheduled — no manual step',
    paths.some((p) => /institutions-ownership/.test(p)), paths.filter((p) => /institution/.test(p)).join(' '));
  ok('the aggregate is a full refresh, so re-running it is idempotent',
    /DELETE FROM ticker_institutional_ownership/.test(code));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
