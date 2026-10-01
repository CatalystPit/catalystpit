// THE SEC XBRL FACT-SELECTION CONTRACT.
//
//   node scripts/verify-sec-xbrl-facts.mjs [--mutate=<mode>]
//
// ⚠️ EVERY ASSERTION HERE IS EXECUTED AGAINST THE REAL SELECTOR, not matched against its source. The
// defects this layer exists to prevent are all arithmetic or ordering mistakes — a YTD fact read as a
// quarter, a stale tag winning a chain, four quarters that overlap — and none of them is visible in the
// text of the code. They are only visible when you run it on the shape of data that causes them.
//
// ⚠️ AND EVERY FIXTURE IS THE REAL SHAPE, taken from live frames and companyfacts responses during
// implementation: Apple's fiscal quarters really do end on 2026-06-27, its `Revenues` series really does
// stop in 2018, and NVDA really does report revenue under `Revenues` while Apple does not.
import {
  spanDays, isQuarterSpan, isAnnualSpan, fiscalOf, fiscalLabel, resolveChain,
  validateDuration, validateInstant, computeTtm, computeMarketCap, computePe,
  computeFreeCashFlow, detectFiscalYearEndMonth, deriveFourthQuarter,
} from '../src/lib/sec/xbrl-facts.mjs';
import { CONCEPTS, CONCEPT_KEYS, QUARTERLY_KEYS, INSTANT_KEYS, ANNUAL_ONLY_KEYS, isAllowedTaxonomy, PE_EPS_BASIS } from '../src/lib/sec/xbrl-concepts.mjs';
import { recentQuarterFrames, recentAnnualFrame } from '../src/lib/sec/xbrl-frames.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const MUT = (process.argv.find((a) => a.startsWith('--mutate=')) || '').split('=')[1] || '';

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('1. PERIOD SHAPES — the YTD trap');
{
  // Apple FY2026 Q3, measured from the live frames API.
  ok('a real fiscal quarter is 90 days', Math.round(spanDays('2026-03-29', '2026-06-27')) === 90);
  ok('…and is accepted as a quarter', isQuarterSpan(spanDays('2026-03-29', '2026-06-27')));
  // 52/53-week filers.
  ok('a 91-day quarter is accepted', isQuarterSpan(91));
  ok('a 98-day 14-week quarter is accepted', isQuarterSpan(98));
  ok('⚠️ a 181-day half-year is REFUSED as a quarter', !isQuarterSpan(181));
  ok('⚠️ a 274-day nine-month YTD is REFUSED as a quarter', !isQuarterSpan(274));
  ok('⚠️ a 365-day year is REFUSED as a quarter', !isQuarterSpan(365));
  ok('a 364-day 52-week year is accepted as annual', isAnnualSpan(364));
  ok('a 371-day 53-week year is accepted as annual', isAnnualSpan(371));
  ok('⚠️ a 279-day nine-month YTD is REFUSED as annual', !isAnnualSpan(279));

  // The named reasons matter: a caller logging them must be able to tell these apart.
  const ytd = validateDuration({ start: '2025-09-28', end: '2026-06-27' }, 'quarter');
  ok('⚠️ a YTD fact offered as a quarter is refused BY NAME',
    !ytd.ok && ytd.reason === 'ytd-or-multi-quarter-span', JSON.stringify(ytd));
  const ann = validateDuration({ start: '2025-06-29', end: '2026-06-27' }, 'quarter');
  ok('⚠️ an annual fact offered as a quarter is refused by its own name',
    !ann.ok && ann.reason === 'annual-span-offered-for-quarter', JSON.stringify(ann));
  ok('a genuine quarter validates', validateDuration({ start: '2026-03-29', end: '2026-06-27' }, 'quarter').ok);
  ok('a genuine year validates as annual', validateDuration({ start: '2025-09-29', end: '2026-09-26' }, 'annual').ok);
  ok('⚠️ a fact with no start is refused rather than treated as instant',
    !validateDuration({ end: '2026-06-27' }, 'quarter').ok);

  ok('⚠️ an instant fact carrying a start is refused',
    !validateInstant({ start: '2026-03-29', end: '2026-06-27' }).ok,
    'a duration fact read as a balance-sheet snapshot is silently wrong');
  ok('a real instant fact validates', validateInstant({ end: '2026-06-27' }).ok);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('2. FISCAL CALENDARS — a calendar quarter is not a fiscal quarter');
{
  // Apple: FYE September. Its quarter ending 2026-06-27 is fiscal Q3 of FY2026.
  const apple = fiscalOf('2026-06-27', 9);
  ok('⚠️ Apple Jun-2026 is fiscal Q3 FY2026, not Q2 CY2026',
    apple.fy === 2026 && apple.q === 3, JSON.stringify(apple));
  ok('…and Apple Sep-2026 is Q4 FY2026', JSON.stringify(fiscalOf('2026-09-26', 9)) === JSON.stringify({ fy: 2026, q: 4 }));
  ok('…and Apple Dec-2026 is Q1 FY2027', JSON.stringify(fiscalOf('2026-12-26', 9)) === JSON.stringify({ fy: 2027, q: 1 }));
  // A calendar filer.
  ok('a December filer Jun-2026 is Q2 FY2026', JSON.stringify(fiscalOf('2026-06-30', 12)) === JSON.stringify({ fy: 2026, q: 2 }));
  ok('…and Dec-2026 is Q4 FY2026', JSON.stringify(fiscalOf('2026-12-31', 12)) === JSON.stringify({ fy: 2026, q: 4 }));
  // NVDA: FYE January.
  ok('an January filer Apr-2026 is Q1 FY2027', JSON.stringify(fiscalOf('2026-04-26', 1)) === JSON.stringify({ fy: 2027, q: 1 }));
  ok('…and Jan-2026 is Q4 FY2026', JSON.stringify(fiscalOf('2026-01-25', 1)) === JSON.stringify({ fy: 2026, q: 4 }));
  // MU: FYE August/September.
  ok('an August filer May-2026 is Q3 FY2026', JSON.stringify(fiscalOf('2026-05-28', 8)) === JSON.stringify({ fy: 2026, q: 3 }));
  ok('the label reads as a fiscal period', fiscalLabel('2026-06-27', 9) === 'Q3 FY2026', fiscalLabel('2026-06-27', 9));

  // ⚠️ MODAL FYE, not the latest end.
  ok('⚠️ the FYE month is the mode, so one changed year does not move it',
    detectFiscalYearEndMonth(['2022-09-24', '2023-09-30', '2024-09-28', '2025-09-27', '2026-06-27']) === 9);
  ok('a pure calendar filer resolves to December',
    detectFiscalYearEndMonth(['2024-12-31', '2025-12-31', '2026-12-31']) === 12);
  ok('no data resolves to December rather than throwing', detectFiscalYearEndMonth([]) === 12);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('3. THE AAPL STALE-REVENUES TRAP');
{
  // The real shape: both tags present, the legacy one stopping in 2018.
  const candidates = [
    { tag: 'RevenueFromContractWithCustomerExcludingAssessedTax', chainIndex: 0, fact: { end: '2026-06-27', val: 94_036_000_000 } },
    { tag: 'Revenues', chainIndex: 1, fact: { end: '2018-09-29', val: 265_595_000_000 } },
  ];
  // ⚠️ THE CONTROL COMES FIRST, because an assertion that the right answer is right proves nothing unless
  // the wrong answer is demonstrably available. This is the naive rule — "first tag in the chain that has
  // data wins" — applied to the same fixture, and it returns Apple's 2018 revenue as current. That is the
  // bug, reproduced here, so the assertion below is measured against something.
  // The chain order in the registry puts the live tag first for most companies, so the control reorders to
  // the case that actually bites: a company whose LEGACY tag happens to come first in whatever order the
  // candidates were assembled. "First with data wins" then returns 2018.
  const naiveReordered = [candidates[1], candidates[0]].find((c) => c.fact.val != null);
  ok('⚠️ control: with the legacy tag first, naive selection picks 2018 revenue',
    naiveReordered.tag === 'Revenues' && naiveReordered.fact.end === '2018-09-29',
    `${naiveReordered.tag} @ ${naiveReordered.fact.end}`);

  const won = resolveChain(MUT === 'firstwins' ? [candidates[1], candidates[0]] : candidates);
  ok('⚠️ the LIVE tag wins, not the first in the chain',
    won?.tag === 'RevenueFromContractWithCustomerExcludingAssessedTax', won?.tag);
  ok('⚠️ …and the stale 2018 value is not what is returned',
    won?.fact.val === 94_036_000_000, String(won?.fact.val));

  // And order-independence: the same answer whichever way the candidates arrive.
  const reversed = resolveChain([candidates[1], candidates[0]]);
  ok('⚠️ the result does not depend on candidate order',
    reversed?.tag === won?.tag, `${reversed?.tag} vs ${won?.tag}`);

  // ⚠️ THE MUTATION-KILLING FIXTURE: POSITION AND RECENCY MUST DISAGREE, AND BOTH CANDIDATES MUST HAVE
  // DATA. Without this, "pick the lowest chain index" and "pick the latest period end" return the same
  // answer for Apple — because the registry happens to list Apple's live tag first — so a mutation that
  // replaces the whole rule with chain position survives every other assertion in this section. Measured
  // reality makes this case real rather than hypothetical: NVDA's live revenue tag is `Revenues`, which
  // sits at chain index 1, and a filer in that position may also carry a stale index-0 series.
  const liveTagIsLaterInChain = resolveChain([
    { tag: 'RevenueFromContractWithCustomerExcludingAssessedTax', chainIndex: 0, fact: { end: '2019-01-27', val: 11_716_000_000 } },
    { tag: 'Revenues', chainIndex: 1, fact: { end: '2026-04-26', val: 44_062_000_000 } },
  ]);
  ok('⚠️ when the LIVE tag sits later in the chain, recency still wins over position',
    liveTagIsLaterInChain?.tag === 'Revenues' && liveTagIsLaterInChain?.fact.end === '2026-04-26',
    `${liveTagIsLaterInChain?.tag} @ ${liveTagIsLaterInChain?.fact.end}`);
  ok('…and the stale index-0 value is not returned',
    liveTagIsLaterInChain?.fact.val === 44_062_000_000, String(liveTagIsLaterInChain?.fact.val));

  // The other half of the same rule: a company that simply does not report the index-0 tag.
  const nvda = resolveChain([
    { tag: 'RevenueFromContractWithCustomerExcludingAssessedTax', chainIndex: 0, fact: { end: null, val: null } },
    { tag: 'Revenues', chainIndex: 1, fact: { end: '2026-04-26', val: 44_062_000_000 } },
  ]);
  ok('⚠️ a company whose live tag is the LEGACY one still resolves correctly',
    nvda?.tag === 'Revenues', nvda?.tag);

  // A genuine tie goes to the more standard concept.
  const tie = resolveChain([
    { tag: 'RevenueFromContractWithCustomerExcludingAssessedTax', chainIndex: 0, fact: { end: '2026-06-27', val: 1 } },
    { tag: 'Revenues', chainIndex: 1, fact: { end: '2026-06-27', val: 2 } },
  ]);
  ok('a tie on period end goes to the earlier chain entry', tie?.tag === 'RevenueFromContractWithCustomerExcludingAssessedTax');
  ok('an all-empty chain returns null rather than a zero', resolveChain([{ tag: 'X', fact: { end: null, val: null } }]) === null);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('4. THE TTM ENGINE');
{
  // Apple's four real fiscal quarters to 2026-06-27, diluted EPS.
  const appleQ = [
    { start: '2025-09-28', end: '2025-12-27', val: 2.40, accn: 'a1' },
    { start: '2025-12-28', end: '2026-03-28', val: 1.65, accn: 'a2' },
    { start: '2026-03-29', end: '2026-06-27', val: 2.02, accn: 'a3' },
    { start: '2026-06-28', end: '2026-09-26', val: 1.90, accn: 'a4' },
  ];
  const t = computeTtm(appleQ);
  ok('⚠️ four contiguous fiscal quarters produce a TTM', t.ok, JSON.stringify(t).slice(0, 90));
  ok('…summed, not averaged', t.ok && Math.abs(t.value - 7.97) < 1e-9, String(t.value));
  ok('…spanning about a year', t.ok && t.spanDays >= 350 && t.spanDays <= 380, String(t.spanDays));
  ok('…with lineage back to each accession',
    t.ok && t.periods.length === 4 && t.periods.every((p) => p.accn), JSON.stringify(t.periods?.map((p) => p.accn)));

  ok('⚠️ three quarters is REFUSED rather than scaled up',
    !computeTtm(appleQ.slice(0, 3)).ok && computeTtm(appleQ.slice(0, 3)).reason === 'insufficient-quarters');

  // A YTD fact among the quarters must not be counted.
  const withYtd = [...appleQ.slice(0, 3), { start: '2025-09-28', end: '2026-06-27', val: 6.07 }];
  const y = computeTtm(withYtd);
  ok('⚠️ a YTD fact mixed in is dropped, leaving too few quarters',
    !y.ok && y.reason === 'insufficient-quarters', JSON.stringify(y));

  // Overlap: a restated quarter that survived upstream.
  const overlap = [
    { start: '2025-09-28', end: '2025-12-27', val: 2.40 },
    { start: '2025-11-01', end: '2026-01-31', val: 2.10 },
    { start: '2025-12-28', end: '2026-03-28', val: 1.65 },
    { start: '2026-03-29', end: '2026-06-27', val: 2.02 },
  ];
  const o = computeTtm(overlap);
  ok('⚠️ overlapping quarters are refused, not double-counted',
    !o.ok && o.reason === 'overlapping-quarters', JSON.stringify(o));

  // ⚠️ A GAP FIXTURE THAT THE TOTAL-SPAN CHECK CANNOT ALSO CATCH, which the first version of this was not.
  // Four quarters with an obvious hole necessarily span far more than a year, so the span check caught it
  // and a mutation deleting the gap check survived. These are four SHORT quarters (81 days each, the low
  // end of the valid window) separated by 14-day holes: the total span is 366 days and passes the span
  // check, every individual span passes the quarter check, and only the adjacency test can see that 56
  // days of the year are missing from the sum.
  const gap = [
    { start: '2025-09-29', end: '2025-12-19', val: 1.00 },
    { start: '2026-01-02', end: '2026-03-24', val: 1.00 },
    { start: '2026-04-07', end: '2026-06-27', val: 1.00 },
    { start: '2026-07-11', end: '2026-09-30', val: 1.00 },
  ];
  const g = computeTtm(gap);
  ok('⚠️ a gap between quarters is refused even when the total span looks like a year',
    !g.ok && g.reason === 'gap-between-quarters', JSON.stringify(g));
  // And the span check still does its own job on the obvious case.
  const sparse = computeTtm([
    { start: '2025-03-30', end: '2025-06-28', val: 1.40 },
    { start: '2025-12-28', end: '2026-03-28', val: 1.65 },
    { start: '2026-03-29', end: '2026-06-27', val: 2.02 },
    { start: '2026-06-28', end: '2026-09-26', val: 1.90 },
  ]);
  ok('…and a widely-spaced set is refused too', !sparse.ok, JSON.stringify(sparse).slice(0, 80));

  // Duplicate period ends: one must be dropped, and if that leaves three it refuses.
  const dup = [appleQ[0], { ...appleQ[0], val: 99 }, appleQ[1], appleQ[2]];
  const d = computeTtm(dup);
  ok('⚠️ a duplicated period end does not fill a slot',
    !d.ok, JSON.stringify(d));

  // A 52/53-week filer: quarters of 91/91/91/98 days spanning 371.
  const w53 = [
    { start: '2025-09-29', end: '2025-12-28', val: 1 },
    { start: '2025-12-29', end: '2026-03-29', val: 1 },
    { start: '2026-03-30', end: '2026-06-28', val: 1 },
    { start: '2026-06-29', end: '2026-10-04', val: 1 },
  ];
  const w = computeTtm(w53);
  ok('⚠️ a 53-week fiscal year with a 14-week quarter is accepted', w.ok, JSON.stringify(w).slice(0, 110));

  // Negative earnings: a TTM may legitimately be negative.
  const loss = appleQ.map((q, i) => ({ ...q, val: i === 2 ? -5.0 : 0.5 }));
  const lt = computeTtm(loss);
  ok('a loss-making TTM is computed, not rejected', lt.ok && lt.value < 0, String(lt.value));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('5. MARKET CAP — the TSM $11.8 trillion error');
{
  // TSM's real shape: ordinary shares, an ADS price, and a 20-F filer.
  const tsm = computeMarketCap({
    price: 456.31, priceDate: '2026-09-30',
    shares: 25_930_380_458, sharesAsOf: '2026-06-30',
    filesDomestic: false, filesForeign: true,
  });
  ok('⚠️ a foreign private issuer gets NO market cap', !tsm.ok, JSON.stringify(tsm));
  ok('…and the reason names the ADS ratio', tsm.reason === 'foreign-private-issuer-ads-ratio-unknown', tsm.reason);

  // A domestic filer is fine.
  const aapl = computeMarketCap({
    price: 333.02, priceDate: '2026-09-30',
    shares: 14_687_360_000, sharesAsOf: '2026-07-18',
    filesDomestic: true, filesForeign: false,
  });
  ok('a domestic filer gets a market cap', aapl.ok);
  ok('…equal to price × shares', aapl.ok && Math.abs(aapl.value - 333.02 * 14_687_360_000) < 1, String(aapl.value));
  ok('…and it is a plausible magnitude', aapl.ok && aapl.value > 1e12 && aapl.value < 1e13, String(aapl.value));

  ok('⚠️ an unknown filer type gets nothing rather than a guess',
    !computeMarketCap({ price: 10, shares: 1e6, filesDomestic: false, filesForeign: false }).ok);
  ok('⚠️ a stale share count is refused',
    !computeMarketCap({ price: 10, priceDate: '2026-09-30', shares: 1e6, sharesAsOf: '2024-01-01', filesDomestic: true }).ok,
    'an 18-month-old count times today\'s price is wrong by every buyback since');
  ok('…by name', computeMarketCap({ price: 10, priceDate: '2026-09-30', shares: 1e6, sharesAsOf: '2024-01-01', filesDomestic: true }).reason === 'share-count-stale');
  ok('⚠️ a share count dated after the price is refused as a data problem',
    computeMarketCap({ price: 10, priceDate: '2026-01-01', shares: 1e6, sharesAsOf: '2026-09-30', filesDomestic: true }).reason === 'share-count-after-price');
  ok('no price means no market cap', !computeMarketCap({ price: 0, shares: 1e6, filesDomestic: true }).ok);
  ok('no shares means no market cap', !computeMarketCap({ price: 10, shares: null, filesDomestic: true }).ok);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('6. P/E — basis stated, denominator positive');
{
  const pe = computePe({ price: 333.02, epsTtm: 7.97 });
  ok('a positive TTM EPS yields a P/E', pe.ok);
  ok('…on the stated basis', pe.ok && pe.basis === PE_EPS_BASIS && PE_EPS_BASIS === 'epsDiluted', String(pe.basis));
  ok('…equal to price ÷ EPS', pe.ok && Math.abs(pe.value - 333.02 / 7.97) < 1e-9, String(pe.value));
  ok('⚠️ a NEGATIVE EPS yields no P/E', !computePe({ price: 10, epsTtm: -1.5 }).ok);
  ok('…by name', computePe({ price: 10, epsTtm: -1.5 }).reason === 'non-positive-eps');
  ok('⚠️ a ZERO EPS yields no P/E', !computePe({ price: 10, epsTtm: 0 }).ok);
  ok('a missing EPS yields no P/E', !computePe({ price: 10, epsTtm: null }).ok);
  ok('a missing price yields no P/E', !computePe({ price: null, epsTtm: 5 }).ok);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('7. FREE CASH FLOW — an absent capex is not a zero capex');
{
  const f = computeFreeCashFlow({ operatingCashFlow: 118_254_000_000, capex: 11_247_000_000 });
  ok('both components present yields FCF', f.ok && Math.abs(f.value - 107_007_000_000) < 1, String(f.value));
  ok('⚠️ a missing capex yields NO free cash flow',
    !computeFreeCashFlow({ operatingCashFlow: 1e9, capex: null }).ok,
    'treating it as zero publishes operating cash flow as FCF');
  ok('…by name', computeFreeCashFlow({ operatingCashFlow: 1e9, capex: null }).reason === 'no-capex-fact');
  ok('a capex reported as a negative outflow is handled by magnitude',
    computeFreeCashFlow({ operatingCashFlow: 100, capex: -30 }).value === 70);
  ok('a missing operating cash flow yields nothing', !computeFreeCashFlow({ operatingCashFlow: null, capex: 1 }).ok);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('8. THE CONCEPT REGISTRY');
{
  ok('every concept declares a kind, unit, taxonomy and chain',
    CONCEPT_KEYS.every((k) => {
      const c = CONCEPTS[k];
      return c.kind && c.unit && c.taxonomy && Array.isArray(c.chain) && c.chain.length > 0;
    }));
  ok('⚠️ every taxonomy used is a STANDARD one',
    CONCEPT_KEYS.every((k) => isAllowedTaxonomy(CONCEPTS[k].taxonomy)),
    CONCEPT_KEYS.filter((k) => !isAllowedTaxonomy(CONCEPTS[k].taxonomy)).join(','));
  ok('⚠️ a company-extension taxonomy is refused', !isAllowedTaxonomy('aapl') && !isAllowedTaxonomy('custom'));
  ok('EPS concepts use the per-share unit',
    CONCEPTS.epsBasic.unit === 'USD-per-shares' && CONCEPTS.epsDiluted.unit === 'USD-per-shares');
  ok('shares outstanding is a dei instant concept in shares',
    CONCEPTS.sharesOutstanding.taxonomy === 'dei' && CONCEPTS.sharesOutstanding.unit === 'shares'
      && CONCEPTS.sharesOutstanding.kind === 'instant');
  ok('⚠️ cash flow is annual-only, because the quarterly frames are nearly empty',
    ANNUAL_ONLY_KEYS.includes('operatingCashFlow') && ANNUAL_ONLY_KEYS.includes('capex'));
  ok('…and is therefore not in the quarterly/TTM set',
    !QUARTERLY_KEYS.includes('operatingCashFlow') && !QUARTERLY_KEYS.includes('capex'));
  ok('the balance-sheet concepts are instant', INSTANT_KEYS.includes('assets') && INSTANT_KEYS.includes('equity'));
  ok('the income concepts are quarterly durations',
    QUARTERLY_KEYS.includes('revenue') && QUARTERLY_KEYS.includes('netIncome') && QUARTERLY_KEYS.includes('epsDiluted'));
  ok('⚠️ no concept named float exists anywhere in the registry',
    !CONCEPT_KEYS.some((k) => /float/i.test(k)) && !CONCEPT_KEYS.some((k) => /float/i.test(CONCEPTS[k].label)),
    'SEC shares outstanding is not free float and must never be labelled as it');
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('9. FRAME SELECTION — completed periods only');
{
  // Fixed "now" so the assertion is about the rule rather than about today.
  const frames = recentQuarterFrames(4, new Date('2026-10-01T00:00:00Z'));
  ok('four quarter frames are offered', frames.length === 4);
  ok('⚠️ the newest is a COMPLETED quarter, not the one in progress',
    frames[0].frame === 'CY2026Q2', frames[0].frame);
  ok('…and they walk back consecutively',
    frames.map((f) => f.frame).join(',') === 'CY2026Q2,CY2026Q1,CY2025Q4,CY2025Q3', frames.map((f) => f.frame).join(','));
  ok('…with an instant variant for balance-sheet reads', frames[0].instantFrame === 'CY2026Q2I');
  ok('the year rolls back correctly across a boundary',
    recentQuarterFrames(4, new Date('2026-04-01T00:00:00Z')).map((f) => f.frame).join(',') === 'CY2025Q4,CY2025Q3,CY2025Q2,CY2025Q1');
  const annual = recentAnnualFrame(new Date('2026-10-01T00:00:00Z'));
  ok('⚠️ the annual frame is a year whose 10-Ks have been filed', annual.frame === 'CY2025', annual.frame);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('10. THE DERIVED FOURTH QUARTER');
{
  // Apple FY2025: the 10-K reports the year; there is no standalone Q4 10-Q, ever.
  const annual = { start: '2024-09-29', end: '2025-09-27', val: 416_161_000_000, accn: '0000320193-25-000079', tag: 'RevenueFromContractWithCustomerExcludingAssessedTax' };
  const q123 = [
    { start: '2024-09-29', end: '2024-12-28', val: 124_300_000_000 },
    { start: '2024-12-29', end: '2025-03-29', val: 95_359_000_000 },
    { start: '2025-03-30', end: '2025-06-28', val: 94_036_000_000 },
  ];
  const d = deriveFourthQuarter({ annual, quarters: q123 });
  ok('⚠️ the missing fourth quarter is derived from the year minus three quarters', !!d, JSON.stringify(d).slice(0, 80));
  ok('…with the arithmetic right', d && Math.abs(d.val - 102_466_000_000) < 1e6, String(d?.val));
  ok('…starting the day after Q3 ends', d?.start === '2025-06-29', String(d?.start));
  ok('…ending on the fiscal year end', d?.end === '2025-09-27', String(d?.end));
  ok('…spanning a real quarter', d && isQuarterSpan(spanDays(d.start, d.end)), String(spanDays(d?.start, d?.end)));
  ok('⚠️ …and flagged as derived, with the annual filing accession as its lineage',
    d?.derived === true && d?.accn === '0000320193-25-000079' && d?.derivedFrom?.quarters?.length === 3);

  ok('⚠️ a year with only TWO reported quarters derives nothing',
    deriveFourthQuarter({ annual, quarters: q123.slice(0, 2) }) === null,
    'two quarters leave a six-month hole, not a quarter');
  ok('⚠️ a year with FOUR reported quarters derives nothing, since none is missing',
    deriveFourthQuarter({ annual, quarters: [...q123, { start: '2025-06-29', end: '2025-09-27', val: 1 }] }) === null);
  ok('⚠️ quarters that do not start at the fiscal year start derive nothing',
    deriveFourthQuarter({ annual, quarters: q123.map((q, i) => (i === 0 ? { ...q, start: '2024-11-01' } : q)) }) === null,
    'a late first quarter means the hole is not where it looks');
  ok('⚠️ quarters with a gap between them derive nothing',
    deriveFourthQuarter({ annual, quarters: [q123[0], { ...q123[1], start: '2025-01-20' }, q123[2]] }) === null);
  ok('⚠️ an annual fact that is not a year derives nothing',
    deriveFourthQuarter({ annual: { ...annual, end: '2025-06-28' }, quarters: q123 }) === null);
  ok('a derived quarter from a 53-week year is still accepted',
    !!deriveFourthQuarter({
      annual: { start: '2024-09-29', end: '2025-10-04', val: 100 },
      quarters: [
        { start: '2024-09-29', end: '2024-12-28', val: 20 },
        { start: '2024-12-29', end: '2025-03-29', val: 20 },
        { start: '2025-03-30', end: '2025-06-28', val: 20 },
      ],
    }));

  // ⚠️ AND THE DERIVED QUARTER COMPLETES A TTM, which is the entire point of deriving it.
  const ttm = computeTtm([...q123, d, { start: '2025-09-28', end: '2025-12-27', val: 143_755_000_000 }].filter(Boolean));
  ok('⚠️ a TTM built across the derived quarter succeeds', ttm.ok, JSON.stringify(ttm).slice(0, 70));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('11. REGRESSIONS — every real failure found while building this');
{
  // 1. Number(null) is 0 and 0 is finite, so an ABSENT value passed a Number.isFinite guard and was
  //    reported as a non-positive one. Two different follow-ups, one wrong label.
  ok('⚠️ an absent TTM EPS is "no-ttm-eps", NOT "non-positive-eps"',
    computePe({ price: 100, epsTtm: null }).reason === 'no-ttm-eps',
    computePe({ price: 100, epsTtm: null }).reason);
  ok('⚠️ …and a genuinely negative one still says non-positive',
    computePe({ price: 100, epsTtm: -1 }).reason === 'non-positive-eps');
  ok('⚠️ an absent capex is "no-capex-fact", not a zero',
    computeFreeCashFlow({ operatingCashFlow: 1e9, capex: null }).reason === 'no-capex-fact');
  ok('⚠️ an absent operating cash flow is refused rather than treated as zero',
    computeFreeCashFlow({ operatingCashFlow: null, capex: 1e9 }).reason === 'no-operating-cash-flow');
  ok('…and an empty string is absence too, because that is what a column can hold',
    !computeFreeCashFlow({ operatingCashFlow: '', capex: 1 }).ok);

  // 2. The frame window returned a quarter whose 10-Qs had not been filed.
  const f = recentQuarterFrames(1, new Date('2026-10-01T00:00:00Z'));
  ok('⚠️ on 1 October the newest frame is Q2, not the just-ended Q3',
    f[0].frame === 'CY2026Q2', f[0].frame);
  // The 75-day lag is past the 45-day 10-Q deadline with margin, so Q3 becomes available in mid-December
  // rather than mid-November. Asserting the rule rather than a guess about it: 51 days is not yet enough.
  ok('…and 51 days after quarter end is still NOT enough',
    recentQuarterFrames(1, new Date('2026-11-20T00:00:00Z'))[0].frame === 'CY2026Q2');
  ok('…while 81 days after it is',
    recentQuarterFrames(1, new Date('2026-12-20T00:00:00Z'))[0].frame === 'CY2026Q3',
    recentQuarterFrames(1, new Date('2026-12-20T00:00:00Z'))[0].frame);

  // 3. Fiscal-year-end detection read quarterly ends and came out a quarter wrong.
  ok('⚠️ FYE from ANNUAL ends only: Apple is September',
    detectFiscalYearEndMonth(['2024-09-28', '2025-09-27']) === 9);
  // ⚠️ AND A MIXTURE THAT OVER-REPRESENTS A QUARTER MONTH RETURNS THAT MONTH, which is exactly how the
  // first version reported Apple's fiscal year as ending in June: eight quarters of history contribute
  // several June and March ends against a single annual September one, and the mode follows the crowd.
  ok('⚠️ a quarterly-dominated mixture returns the WRONG month, which is why only annual ends are used',
    detectFiscalYearEndMonth(['2025-09-27', '2024-06-29', '2025-06-28', '2026-06-27']) === 6,
    String(detectFiscalYearEndMonth(['2025-09-27', '2024-06-29', '2025-06-28', '2026-06-27'])));

  // 4. A TTM needs four quarters and one of every four is a Q4 that no 10-Q reports.
  ok('⚠️ three real quarters alone cannot make a TTM, which is why Q4 derivation exists',
    !computeTtm([
      { start: '2025-09-28', end: '2025-12-27', val: 1 },
      { start: '2025-12-28', end: '2026-03-28', val: 1 },
      { start: '2026-03-29', end: '2026-06-27', val: 1 },
    ]).ok);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
