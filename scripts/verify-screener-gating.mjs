// THE SCREENER'S PRO AGGREGATE — gated at the data layer, three ways.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-screener-gating.mjs
//
// ⚠️ WHAT WAS EXPOSED. /api/screener took no auth and returned db.select() — the whole row — so an
// anonymous caller received, for all 18,036 securities, 100 at a time: insiderNet90d ($1.38B on the
// leader), insiderBuyers90d, insiderBuy90d, insiderSell90d, congressNet90d, congressBuy90d, fundNetQoq
// and consensusScore. Those are our cross-dataset aggregates over the products that are gated
// everywhere else — the Insiders, Politicians and Institutions boards each give an anonymous visitor
// TEN records, and Pit Consensus is a Pro board outright. 181 requests took the whole book.
//
// ⚠️ AND HIDING THE COLUMN WOULD NOT HAVE BEEN THE FIX. Three surfaces leak the same aggregate:
//   the CELL      — the value itself
//   the FILTER    — filters={"insiderBuy90d":{"eq":true}} answers "which of the 18,036", via the result set
//   the SORT      — ordering by insiderNet90d publishes the ranking, and it was the DEFAULT ordering
// All three are checked here, and the third is the one that was easiest to miss.
import { readFileSync } from 'node:fs';
import {
  PRO_AGGREGATE_FIELDS, isProAggregateField, stripProAggregate, sanitizeFilters, sanitizeSort,
  NON_PRO_DEFAULT_SORT,
} from '../src/lib/screener-entitlement.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

// A row shaped like one db.select() returns, carrying both halves.
const ROW = Object.freeze({
  ticker: 'AAPL', company: 'Apple Inc.', sector: 'Technology', marketCap: 3.4e12, price: 240.1,
  changePct: 1.2, volume: 51e6, pe: 36.2, rsi14: 58, perf1m: 4.4, roe: 1.47,
  insiderOwnPct: 0.07, instOwnPct: 61.2, hasMaterial8k: true, newsRecent: true,
  insiderNet90d: 1380311036.98, insiderBuyers90d: 3, insiderBuy90d: true, insiderSell90d: false,
  congressNet90d: -8000.5, congressBuy90d: false, fundNetQoq: 23, consensusScore: 71,
});

L('⚠️ 1 — the gated set is exactly the aggregate, and nothing a screener needs');
{
  ok('the list is non-empty and frozen', PRO_AGGREGATE_FIELDS.length === 8 && Object.isFrozen(PRO_AGGREGATE_FIELDS),
    JSON.stringify(PRO_AGGREGATE_FIELDS));
  for (const f of ['insiderNet90d', 'insiderBuyers90d', 'insiderBuy90d', 'insiderSell90d',
    'congressNet90d', 'congressBuy90d', 'fundNetQoq', 'consensusScore']) {
    ok(`⚠️ ${f} is gated`, isProAggregateField(f) === true);
  }
  // ⚠️ THE OTHER HALF OF THE RULE: the Screener must stay usable. Locking these would be inventing a
  // restriction rather than fixing one.
  for (const f of ['ticker', 'company', 'sector', 'industry', 'country', 'marketCap', 'price', 'changePct',
    'volume', 'avgVol', 'relVol', 'pe', 'ps', 'pb', 'rsi14', 'sma50', 'sma200', 'hi52', 'lo52',
    'perf1w', 'perf1m', 'perf1y', 'roe', 'grossMargin', 'netMargin', 'debtEquity', 'beta',
    'shortFloat', 'dividendYield', 'exchange', 'assetType', 'ipoDate']) {
    ok(`${f} is NOT gated`, isProAggregateField(f) === false);
  }
  // ⚠️ THE DISTINCTION THAT MAKES THE LIST DEFENSIBLE. A static ownership percentage is standard
  // reference data; a 90-day flow is our analysis of filings we gate.
  ok('⚠️ instOwnPct and insiderOwnPct stay open — a fact about the company, not our analysis',
    isProAggregateField('instOwnPct') === false && isProAggregateField('insiderOwnPct') === false);
  ok('⚠️ …while insiderNet90d is gated — our 90-day flow over gated filings',
    isProAggregateField('insiderNet90d') === true);
  ok('hasMaterial8k stays open — a public SEC fact the Wire already publishes',
    isProAggregateField('hasMaterial8k') === false);
}

L('⚠️ 2 — the CELL: stripped for non-Pro, intact for Pro');
{
  const free = stripProAggregate(ROW);
  for (const f of PRO_AGGREGATE_FIELDS) {
    ok(`⚠️ ${f} is absent from a non-Pro row`, !(f in free), JSON.stringify(free[f]));
  }
  // ⚠️ DELETED, NOT NULLED. A null on these columns reads as "no insider buying" — a claim about the
  // security produced by the reader's entitlement.
  ok('⚠️ the keys are absent, not set to null', PRO_AGGREGATE_FIELDS.every((f) => free[f] === undefined));
  // Everything else survives untouched, by value.
  const keptKeys = Object.keys(ROW).filter((k) => !isProAggregateField(k));
  ok('⚠️ every non-gated field survives', keptKeys.every((k) => free[k] === ROW[k]),
    JSON.stringify(keptKeys.filter((k) => free[k] !== ROW[k])));
  ok('…and no key was invented', Object.keys(free).length === keptKeys.length);
  ok('the original row is not mutated', ROW.insiderNet90d === 1380311036.98);
  for (const junk of [null, undefined, 'x', 42]) {
    ok(`stripProAggregate(${JSON.stringify(junk)}) is a no-op`, stripProAggregate(junk) === junk);
  }
}

L('⚠️ 3 — the FILTER: a gated predicate cannot be used to read the aggregate');
{
  const asked = { marketCap: { min: 1e9 }, insiderBuy90d: { eq: true }, fundNetQoq: { min: 5 }, rsi14: { max: 30 } };
  const freeRes = sanitizeFilters(asked, { pro: false });
  ok('⚠️ gated filters are removed for a non-Pro caller',
    !('insiderBuy90d' in freeRes.filters) && !('fundNetQoq' in freeRes.filters));
  ok('⚠️ …and the ungated ones are kept, so the Screener still filters',
    freeRes.filters.marketCap?.min === 1e9 && freeRes.filters.rsi14?.max === 30);
  ok('⚠️ …and the caller is TOLD which were dropped, not silently served a different query',
    freeRes.dropped.sort().join(',') === 'fundNetQoq,insiderBuy90d', JSON.stringify(freeRes.dropped));
  const proRes = sanitizeFilters(asked, { pro: true });
  ok('⚠️ a Pro caller keeps all of them', Object.keys(proRes.filters).length === 4 && proRes.dropped.length === 0);
  for (const junk of [null, undefined, 'x', 42]) {
    ok(`a ${JSON.stringify(junk)} filter object is handled`, Object.keys(sanitizeFilters(junk, { pro: false }).filters).length === 0);
  }
}

L('⚠️ 4 — the SORT: the default ordering was itself the gated field');
{
  // ⚠️ THIS IS THE ONE A "HIDE THE COLUMN" FIX LEAVES BEHIND. The route's fallback ordering was
  // insiderNet90d, so every unsorted anonymous request ranked the whole universe by the Pro aggregate —
  // the ranking readable in full even with every cell removed.
  const refused = sanitizeSort('insiderNet90d', { pro: false });
  ok('⚠️ a non-Pro caller cannot sort by a gated column', refused.sort === NON_PRO_DEFAULT_SORT && refused.refused === true);
  ok('⚠️ …and is re-pointed at a neutral, ungated ordering', NON_PRO_DEFAULT_SORT === 'marketCap');
  ok('consensusScore is refused too', sanitizeSort('consensusScore', { pro: false }).refused === true);
  ok('⚠️ an ungated sort is untouched', sanitizeSort('marketCap', { pro: false }).refused === false
    && sanitizeSort('price', { pro: false }).sort === 'price');
  ok('⚠️ a Pro caller may sort by it', sanitizeSort('insiderNet90d', { pro: true }).refused === false
    && sanitizeSort('insiderNet90d', { pro: true }).sort === 'insiderNet90d');
  ok('an absent sort is not treated as gated', sanitizeSort(undefined, { pro: false }).refused === false);
}

L('⚠️ 5 — the route enforces all three, server-side, before the query is built');
{
  const r = code('src/app/api/screener/route.js');
  ok('⚠️ the tier is resolved from the shared entitlement system',
    /isProTier\(\(await resolveUserAccess\(\)\)\.tier\)/.test(r));
  // ⚠️ EVERY CATCH, NOT "A" CATCH. This matched `catch { pro = false; }` anywhere, so flipping the ROWS
  // branch to fail open still passed on the strength of the META branch's catch. Both resolutions are
  // counted and none may grant Pro.
  const catches = (r.match(/catch \{ pro = (true|false); \}/g) || []);
  ok('⚠️ …and every entitlement resolution fails CLOSED',
    catches.length === 2 && catches.every((c) => /pro = false/.test(c)), JSON.stringify(catches));
  ok('…with no path that grants Pro on an error', !/catch \{ pro = true/.test(r));
  ok('⚠️ …with no second Pro-detection path',
    !/publicMetadata/.test(r) && !/headers\.get\('x-tier'\)/.test(r) && !/sp\.get\('pro'\)/.test(r));
  // The gate must reach the SQL, not just the payload.
  // ⚠️ PRESENCE FIRST, THEN ORDER. Asserted as an indexOf comparison alone, deleting the call entirely
  // PASSED — indexOf returns -1 and -1 is less than any real index, so "sanitised before" was satisfied
  // by not sanitising at all. The -1 trap, in the one assertion protecting the SQL.
  ok('⚠️ filters are sanitised at all', /const \{ filters: allowed, dropped \} = sanitizeFilters\(active, \{ pro \}\);/.test(r)
    && /active = allowed;/.test(r));
  ok('⚠️ …BEFORE the conditions are built',
    r.includes('sanitizeFilters(active, { pro })') && r.includes('buildConds(active)')
    && r.indexOf('sanitizeFilters(active, { pro })') < r.indexOf('buildConds(active)'));
  ok('⚠️ the sort is sanitised before the order clause', /sanitizeSort\(sp\.get\('sort'\), \{ pro \}\)/.test(r)
    && r.indexOf('sanitizeSort(') < r.indexOf('orderPrimary'));
  ok('⚠️ …and the non-Pro fallback column is not the gated one',
    /pro \? screenerStocks\.insiderNet90d : screenerStocks\.marketCap/.test(r));
  ok('⚠️ rows are stripped on the way out', /pro \? rows : rows\.map\(stripProAggregate\)/.test(r));
  ok('…and the caller is told what was refused', /droppedFilters: dropped/.test(r) && /sortRefused: true/.test(r));
  // ⚠️ AND THE META ENDPOINT MUST NOT ADVERTISE A CONTROL THAT CANNOT WORK.
  ok('⚠️ gated filters are marked unavailable for non-Pro', /available: false, proOnly: true/.test(r));
  ok('…and the tier is reported so the client needs no second request', /\n        pro,/.test(r));
}

L('⚠️ 6 — CACHE: an entitlement-dependent response is never publicly cached');
{
  const r = read('src/app/api/screener/route.js');
  // ⚠️ THE ORIGINAL CONSTANT WAS NAMED NO_STORE AND ITS VALUE WAS `public, max-age=30`. Survivable while
  // every caller got the same payload; a cross-tier leak the moment the payload varies — a Free user
  // served a cached Pro page, or a downgraded Pro user still served the aggregate, which is item 9.
  ok('⚠️ no response is publicly cacheable any more', !/'public, max-age=30'/.test(r));
  ok('⚠️ …and the rows response is private and uncached',
    /const PRIVATE_NO_STORE = \{ 'Cache-Control': 'private, no-store' \}/.test(r));
  const hdrs = [...r.matchAll(/headers: ([A-Z_0-9]+)/g)].map((m) => m[1]);
  ok('⚠️ every response in the route uses it', hdrs.length >= 3 && hdrs.every((h) => h === 'PRIVATE_NO_STORE'),
    JSON.stringify(hdrs));
  ok('…and there is no second, public constant left to reach for', !/PUBLIC_30/.test(r));
}

L('⚠️ 7 — the UI gates the matching view, without an entitlement flash');
{
  const c = code('src/app/screener/ScreenerClient.jsx');
  // ⚠️ DERIVED FROM THE COLUMNS so a new gated column gates its view automatically.
  ok('the client knows which views carry the aggregate', /const viewIsProOnly = \(v\) =>/.test(c));
  // ⚠️ LOCKED ONLY WHEN *EVERY* COLUMN IS GATED, and production QA is what caught the alternative. With
  // `.some()`, the News view — [hasMaterial8k, insiderBuy90d, changePct] — was locked entirely because one
  // of its three columns is gated, denying Free readers two columns they are meant to have. That is this
  // task's own bug in reverse, and it shipped to a browser before a test noticed.
  ok('⚠️ …derived from the columns, and locking only when ALL of them are gated',
    /cs\.length > 0 && cs\.every\(\(c\) => PRO_AGGREGATE_COLS\.has\(c\)\)/.test(c));
  ok('⚠️ …and a partially-gated view drops the gated COLUMN instead of locking the view',
    /const visibleCols = \(v, isPro\) =>/.test(c)
    && /\.filter\(\(c\) => isPro === true \|\| !PRO_AGGREGATE_COLS\.has\(c\)\)/.test(c));
  ok('⚠️ …and the rendered columns come from that filter, not from VIEWS directly',
    /const cols = visibleCols\(view, pro\);/.test(c) && !/const cols = VIEWS\[view\]/.test(c));
  ok('⚠️ unknown entitlement yields the non-Pro column set, which is fail-closed',
    /isPro === true/.test(c), 'a null tier must not satisfy the Pro branch');
  // ⚠️ THE CLIENT LIST MUST MATCH THE SERVER'S AUTHORITY, or a view stops being gated while the data
  // still is — a dead tab — or worse, the reverse.
  const clientSet = [...c.matchAll(/'(insider[A-Za-z0-9]+|congress[A-Za-z0-9]+|fundNetQoq|consensusScore)'/g)]
    .map((m) => m[1]);
  ok('⚠️ every server-gated field appears in the client set',
    PRO_AGGREGATE_FIELDS.every((f) => clientSet.includes(f)),
    JSON.stringify(PRO_AGGREGATE_FIELDS.filter((f) => !clientSet.includes(f))));
  // The three-state handling is what prevents both flashes.
  // Matched on what the code actually says: the state starts null and is compared with !==, not ===.
  // My first version looked for `pro === null`, which appears only in the comment explaining it.
  ok('⚠️ entitlement has an UNKNOWN state',
    /const \[pro, setPro\] = useState\(null\);/.test(c) && /pro !== null/.test(c));
  ok('…and it is set from the server answer, never inferred',
    /setPro\(j\.pro === true\)/.test(c) && /\.catch\(\(\) => \{ setMeta\(\{\}\); setPro\(false\); \}\)/.test(c));
  ok('⚠️ …and unknown does not render either answer',
    /const resolved = pro !== null;/.test(c) && /locked && resolved \? ' · Pro' : ''/.test(c));
  ok('⚠️ a gated tab is not selectable unless Pro', /const locked = gated && pro !== true;/.test(c));
  ok('…and the upgrade path is the product\'s own', /startCheckout\(\)/.test(c)
    && /startCheckout/.test(read('src/app/screener/ScreenerClient.jsx').split('\n')[4]));
  // ⚠️ AND THE BASIC SCREENER MUST NOT WAIT ON ENTITLEMENT.
  ok('⚠️ no ungated tab is disabled while entitlement resolves',
    !/if \(pro === null\) return null/.test(c) && !/disabled=\{pro === null\}/.test(c));
  ok('…and the rows request is not withheld pending the tier',
    c.indexOf("fetch(`/api/screener?${qs}`") > 0 && !/if \(pro === null\) return;[\s\S]{0,80}fetch\(`\/api\/screener/.test(c));
  // Hiding is not the enforcement, and the comment must not claim it is.
  ok('⚠️ the gate is not described as client-side protection',
    !/client-side (gate|protection|enforcement)/i.test(c));
}

L('⚠️ 8 — nothing from the test-symbol work was touched');
{
  const sd = code('src/lib/screener-data.js');
  // ⚠️ THE CALL GAINED A `named` ARGUMENT, and the reason belongs in the test. `classified: metaByT.has(t)`
  // was the whole test for "our reference data knows this symbol" — but metaByT is now filtered to rows
  // whose vendor-derived columns may be SERVED, so TEST (the real YieldMax ETF, whose meta row predates the
  // provenance work and carries a NULL source) stopped counting as known, was refused as an exchange test
  // symbol, and vanished from screener_stocks entirely. Whether we may publish a sector is a different
  // question from whether a symbol denotes a real security, so the security master's name decides too.
  ok('the universe filter still refuses exchange test symbols',
    /isExchangeTestSymbol\(t, \{ classified: metaByT\.has\(t\), named: !!nameByT\.get\(t\) \}\)/.test(sd));
  const r = code('src/app/api/screener/route.js');
  ok('⚠️ and this route did not touch the universe or the filters module',
    !/isExchangeTestSymbol/.test(r) && /buildConds/.test(r));
  ok('…nor the sort map it shares', /SORT_MAP\[sortKey\]/.test(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
