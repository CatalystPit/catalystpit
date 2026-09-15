// THE TICKER SSR SECURITY BOUNDARY.
//
// Server-rendered HTML is crawled, cached and archived. A field that leaks into an API response can
// be removed tomorrow; a field that leaks into indexed markup is out for good. So the public view
// model is not reviewed by reading it — it is serialized and searched, RECURSIVELY, for every name
// and value that must never appear, against REAL bundles for real tickers.
//
// Run: node --env-file=.env.local scripts/verify-ticker-seo-bundle.mjs

import { getTickerBundle, INSIDER_WINDOW_DAYS } from '../src/lib/ticker-seo.mjs';
import { buildPublicView, buildEligibility } from '../src/lib/ticker-seo-view.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log('\n' + s);

// ── the forbidden list ──────────────────────────────────────────────────────
// Column and concept names that describe our pipeline rather than the world. Checked as KEYS
// anywhere in the tree, at any depth, in any array element.
const FORBIDDEN_KEYS = [
  'source', 'source_name', 'sourceName', 'source_kind', 'sourceKind', 'source_type', 'sourceType',
  'source_uid', 'sourceUid', 'source_headline', 'source_count', 'sourceCount', 'feed', 'feedId', 'feedUrl',
  'raw', 'facts', 'seq', 'cluster_id', 'clusterId', 'norm_hash', 'normHash', 'fact_key', 'factKey',
  'fact_sig', 'content_hash', 'contentHash', 'display_hash', 'event_key', 'entity',
  'first_seen_at', 'firstSeenAt', 'last_seen_at', 'lastSeenAt', 'received_at', 'receivedAt',
  'enriched_at', 'enrichedAt', 'enrich_attempts', 'inserted_at', 'insertedAt',
  'headline_status', 'headlineStatus', 'pipeline_status', 'display_ready', 'displayReady',
  'importance', 'wireNoise', 'wireGroup', 'wireType', 'wireCategory', 'wireCap', 'noise',
  'conviction', 'conviction_band', 'conviction_tags', 'consensus_score', 'material',
  'cusip', 'cik', 'issuer_cik', 'owner_cik', 'accession', 'amends_accession', 'tx_hash',
  'id', 'row_id', 'rowId', 'original_url', 'originalUrl', 'canonical_url', 'summary',
  'amount_mid', 'amountMid', 'amount_min', 'amount_max', 'market_center', 'put_call',
  'perf_1d', 'perf_1w', 'perf_1m', 'perf_6m', 'apiKey', 'api_key',
];

// Values that betray the source stack or the vendor stack. These are checked as SUBSTRINGS of every
// string in the tree. Uppercase feed codes are used deliberately: they are how the roster names
// sources internally and they cannot occur in ordinary prose, so a real headline mentioning a
// publisher by name in passing does not trip the test while a leaked roster code does.
const FORBIDDEN_VALUES = [
  'FINANCIALJUICE', 'BREAKINGMARKETNEWS', 'WALTERBLOOMBERG', 'SEEKINGALPHA', 'ZEROHEDGE',
  'GLOBENEWSWIRE', 'PRNEWSWIRE', 'EINPRESSWIRE', 'BIOSPACE', 'BIOTECHNEWSWIRE', 'MARKETAUX',
  'STOCKDATA', 'PRCOM', 'MARKETWATCH', 'TECHCRUNCH',
  'finnhub', 'polygon.io', 'api.polygon', 'tiingo', 'logo.dev', 'img.logo',
  'DATABASE_URL', 'KV_REST_API', 'FINNHUB_KEY', 'POLYGON_API_KEY', 'TIINGO_API_KEY',
  'postgres://', 'postgresql://', 'neon.tech', 'upstash',
  // Internal table names. A public page must never name our storage.
  'screener_stocks', 'insider_trades', 'congress_trades', 'fund_holdings', 'primary_events',
  'eightk_filings', 'ticker_daily_candles', 'short_interest', 'ticker_institutional_ownership',
  'cusip_map', 'canonical_events', 'x_post_candidates',
];

/** Every (path, key, value) triple in the tree, so nothing hides inside an array or a nested object. */
function* walk(node, path = '$') {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) yield* walk(node[i], `${path}[${i}]`);
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      yield { path: `${path}.${k}`, key: k, value: v };
      yield* walk(v, `${path}.${k}`);
    }
    return;
  }
  yield { path, key: null, value: node };
}

function auditPublic(label, model) {
  const badKeys = [];
  const badValues = [];
  for (const { path, key, value } of walk(model)) {
    if (key) {
      const lower = key.toLowerCase();
      if (FORBIDDEN_KEYS.some((f) => f.toLowerCase() === lower)) badKeys.push(path);
    }
    if (typeof value === 'string') {
      for (const f of FORBIDDEN_VALUES) {
        if (value.toLowerCase().includes(f.toLowerCase())) badValues.push(`${path} contains "${f}"`);
      }
    }
  }
  ok(`${label}: no forbidden key at any depth`, badKeys.length === 0, badKeys.slice(0, 6).join(' '));
  ok(`${label}: no source/vendor/table value at any depth`, badValues.length === 0, badValues.slice(0, 6).join(' '));

  // Serializing is what an RSC payload actually does, so assert on the serialized form too — this
  // catches anything a getter or a Date or a class instance would smuggle past the walk.
  const json = JSON.stringify(model);
  const inJson = FORBIDDEN_VALUES.filter((f) => json.toLowerCase().includes(f.toLowerCase()));
  ok(`${label}: serialized JSON is clean`, inJson.length === 0, inJson.join(' '));
  return json;
}

// ── 1. the walker itself works ──────────────────────────────────────────────
// A negative result is only worth something if the instrument can produce a positive one.
section('1. control — the audit detects what it is looking for');
(() => {
  const planted = { a: { b: [{ source_name: 'x' }] }, c: 'served by FINANCIALJUICE' };
  const keys = [...walk(planted)].filter((n) => n.key === 'source_name');
  ok('walker reaches a key nested inside an array', keys.length === 1, JSON.stringify(keys));
  const vals = [...walk(planted)].filter((n) => typeof n.value === 'string' && n.value.includes('FINANCIALJUICE'));
  ok('walker reaches a planted value', vals.length >= 1);
  ok('table names are in the forbidden list', FORBIDDEN_VALUES.includes('primary_events'));
})();

// ── 2. the mapper refuses raw rows ──────────────────────────────────────────
// Feed it a full-fat database row with every dangerous column populated. Nothing may survive except
// the handful of fields the whitelist names.
section('2. mapper drops everything it was not told to keep');
(() => {
  const dirty = buildPublicView('TEST', {
    identity: { ticker: 'TEST', company: 'Test Co', exchange: 'NASDAQ', sector: 'Tech', industry: 'Software',
      country: 'USA', asset_type: 'Stock', market_cap: 1e9,
      consensus_score: 99, insider_own_pct: 4, news_category: 'X', updated_at: 'now', breaking_today: true },
    insiderRecent: [{ transaction_date: '2026-01-02', filing_date: '2026-01-04', executive: 'A Person',
      title: 'CEO', action: 'Buy', shares: 100, price_per_share: 10, total_value: 1000, rule_10b5_1: false,
      filing_url: 'https://www.sec.gov/Archives/x.htm',
      id: 7, accession: '0001', issuer_cik: '320193', owner_cik: '999', conviction: 8.2,
      conviction_band: 'high', perf_1m: 0.3, inserted_at: 'now', footnotes: 'internal' }],
    insiderSummary: { trades: 3, buys: 2, sells: 1, net: '500', latest: '2026-01-04' },
    insiderWindowDays: 180,
    congress: [{ transaction_date: '2026-01-02', disclosure_date: '2026-02-01', representative: 'A Member',
      member_slug: 'a-member', party: 'D', state: 'CA', chamber: 'House', action: 'Buy',
      amount_range: '$1,001 - $15,000',
      id: 9, tx_hash: 'abc', amount_mid: 8000, amount_min: 1001, amount_max: 15000, link: 'https://x.test',
      enriched_at: 'now', price_at_trade: 12, option_occ: 'X' }],
    institutions: { as_of_quarter: '2026-06-30', filer_count: 10, inst_shares: 1e6, inst_value: 1e8,
      ownership_pct: 55, cik: '123', cusip: '037833100', accession: '0002' },
    news: [{ headline: 'Test Co reports results', published_at: '2026-01-05T12:00:00Z',
      source: 'GLOBENEWSWIRE', source_name: 'GlobeNewswire', source_kind: 'pr', source_type: 'press_release',
      source_uid: 'u1', source_count: 4, seq: 123, cluster_id: null, norm_hash: 'h', fact_key: 'f',
      content_hash: 'c', importance: 3, raw: { feed: 'x' }, facts: {}, summary: '(Source: Bloomberg)',
      original_url: 'https://globenewswire.com/x', canonical_url: 'https://globenewswire.com/x',
      received_at: 'now', enriched_at: 'now', first_seen_at: 'now', last_seen_at: 'now',
      headline_status: 'rewritten', display_ready: true, category: 'EARNINGS', entity: 'TEST' }],
    filings: [{ report_date: '2026-01-06', filed_at: '2026-01-06T20:00:00Z', items: '2.02,9.01',
      filing_url: 'https://www.sec.gov/Archives/y.htm',
      id: 3, cik: '320193', accession: '0003', material: true, company: 'Test Co',
      primary_doc_url: 'https://www.sec.gov/z.htm', inserted_at: 'now' }],
    candle: { date: '2026-01-06', close: 12.5, volume: 1e6, source: 'polygon' },
    shortInterest: { settlement_date: '2026-01-06', short_int_shares: 5e5, days_to_cover: 2.1,
      avg_daily_volume: 2.4e5, source: 'finra', market_center: 'NASDAQ', issue_name: 'TEST CO' },
  });
  auditPublic('poisoned row', dirty);
  ok('news item keeps only headline + publishedAt',
    JSON.stringify(Object.keys(dirty.news.recent[0]).sort()) === '["headline","publishedAt"]',
    Object.keys(dirty.news.recent[0]).join(','));
  ok('publisher summary is gone', !JSON.stringify(dirty).includes('Bloomberg'));
  ok('insider conviction score is gone', !JSON.stringify(dirty).includes('8.2'));
  ok('congress amount band kept, derived midpoint dropped',
    dirty.congress.recent[0].amountRange === '$1,001 - $15,000' && !JSON.stringify(dirty).includes('8000'));
  ok('candle source is gone', !JSON.stringify(dirty).includes('polygon'));
  ok('8-K items parsed to codes', JSON.stringify(dirty.filings.recent[0].items) === '["2.02","9.01"]');
  ok('SEC links survive (deliberate attribution)',
    dirty.insiders.recent[0].filingUrl.includes('sec.gov') && dirty.filings.recent[0].filingUrl.includes('sec.gov'));
})();

// ── 3. url and code validators ──────────────────────────────────────────────
section('3. link and code validators reject what is not what they claim to be');
(() => {
  const withUrl = (u) => buildPublicView('T', { filings: [{ report_date: '2026-01-01', filing_url: u, items: '1.01' }] })
    .filings.recent[0].filingUrl;
  ok('https sec.gov kept', withUrl('https://www.sec.gov/Archives/a.htm') !== null);
  ok('bare sec.gov kept', withUrl('https://sec.gov/a.htm') !== null);
  ok('http sec.gov dropped', withUrl('http://www.sec.gov/a.htm') === null);
  ok('vendor url dropped', withUrl('https://api.polygon.io/a') === null);
  ok('lookalike host dropped', withUrl('https://sec.gov.evil.test/a') === null);
  ok('junk dropped', withUrl('not a url') === null);

  const items = (v) => JSON.stringify(buildPublicView('T', { filings: [{ report_date: '2026-01-01', items: v, filing_url: 'https://www.sec.gov/a.htm' }] }).filings.recent[0].items);
  ok('item codes parsed', items('2.02, 9.01') === '["2.02","9.01"]');
  ok('free text in items is dropped', items('internal note about our feed') === '[]');
  ok('duplicate item codes collapse', items('2.02,2.02') === '["2.02"]');

  const band = (v) => buildPublicView('T', { congress: [{ amount_range: v }] }).congress.recent[0].amountRange;
  ok('disclosed band kept', band('$1,001 - $15,000') === '$1,001 - $15,000');
  ok('free text band dropped', band('per internal estimate') === null);
})();

// ── 4. real bundles ─────────────────────────────────────────────────────────
section('4. real bundles from live data');
const SAMPLES = [
  ['AAPL',   'mega cap, every dataset'],
  ['NVDA',   'mega cap'],
  ['BRK.B',  'dotted share class'],
  ['SRRK',   'small cap with insider + 8-K data'],
  ['PYPL',   'congress-traded, real company name'],
  ['GME',    'retail name with 8-K and short interest'],
  ['ASTS',   'mid cap'],
  ['ZZZZZZ', 'syntactically valid, unresolved'],
];
const bundles = new Map();
for (const [sym, why] of SAMPLES) {
  const b = await getTickerBundle(sym);
  bundles.set(sym, b);
  ok(`${sym} bundle returned`, b !== null, why);
  if (!b) continue;
  auditPublic(sym, b.public);
  ok(`${sym} public model has no eligibility state`, !('eligibility' in b.public) && !('datasetCount' in b.public));
  ok(`${sym} symbol echoed correctly`, b.public.symbol === sym);
}

section('5. coverage actually reflects what we hold');
for (const [sym] of SAMPLES) {
  const b = bundles.get(sym);
  if (!b) continue;
  const c = b.public.coverage, e = b.eligibility;
  console.log('  ' + sym.padEnd(8)
    + 'insiders=' + String(c.insiders).padEnd(3) + 'congress=' + String(c.congress).padEnd(3)
    + 'holders=' + String(c.institutions).padEnd(6) + 'news=' + String(c.news).padEnd(3)
    + 'filings=' + String(c.filings).padEnd(3) + 'close=' + String(c.market).padEnd(3)
    + 'short=' + String(c.shortInterest).padEnd(3)
    + '| datasets=' + e.datasetCount + ' us=' + e.isUsExchange + ' stock=' + e.isCommonStock
    + ' name=' + (b.public.identity?.companyName || '—'));
}
ok('AAPL is identified', bundles.get('AAPL')?.public.identity?.companyName?.includes('Apple'));
ok('AAPL has institutional holders', (bundles.get('AAPL')?.public.institutions?.holders || 0) > 100);
ok('AAPL institutional model is an aggregate, not rows',
  !Array.isArray(bundles.get('AAPL')?.public.institutions)
  && Object.keys(bundles.get('AAPL')?.public.institutions || {}).sort().join(',')
     === 'asOfQuarter,holders,ownershipPercent,shares,value');
ok('BRK.B resolves as a dotted class', bundles.get('BRK.B')?.public.identity?.companyName != null);
ok('PYPL has congressional trades', (bundles.get('PYPL')?.public.coverage.congress || 0) > 0);
ok('GME has an 8-K filing', (bundles.get('GME')?.public.coverage.filings || 0) > 0);
ok('SRRK has insider trades', (bundles.get('SRRK')?.public.coverage.insiders || 0) > 0);
ok('unresolved ZZZZZZ has no identity', bundles.get('ZZZZZZ')?.public.identity === null);
ok('unresolved ZZZZZZ has zero datasets', bundles.get('ZZZZZZ')?.eligibility.datasetCount === 0);
ok('unresolved ZZZZZZ still returns a well-formed model',
  bundles.get('ZZZZZZ')?.public.news.recent.length === 0 && bundles.get('ZZZZZZ')?.public.coverage.insiders === 0);

section('5b. an SIC industry description is not a company name');
(() => {
  const unique = buildPublicView('T', { identity: { ticker: 'T', company: 'Acme Inc.', exchange: 'NASDAQ', name_shared_by: 1 } });
  const shared = buildPublicView('U', { identity: { ticker: 'U', company: 'PHARMACEUTICAL PREPARATIONS', exchange: 'NASDAQ', sector: 'Healthcare', name_shared_by: 229 } });
  ok('a unique name is kept', unique.identity.companyName === 'Acme Inc.');
  ok('a name shared by 229 tickers is refused', shared.identity.companyName === null);
  ok('the rest of the identity survives', shared.identity.exchange === 'NASDAQ' && shared.identity.sector === 'Healthcare');
  ok('eligibility sees no company name', buildEligibility(shared).hasCompanyName === false);
  ok('eligibility still sees an identity', buildEligibility(shared).hasIdentity === true);
  ok('missing signal is taken at face value',
    buildPublicView('V', { identity: { ticker: 'V', company: 'Acme Inc.' } }).identity.companyName === 'Acme Inc.');
})();

section('6. internal eligibility stays internal and carries inputs, not a verdict');
(() => {
  const e = bundles.get('AAPL')?.eligibility || {};
  ok('has identity inputs', e.hasIdentity === true && e.hasCompanyName === true);
  ok('has exchange input', e.isUsExchange === true, 'exchange=' + e.exchange);
  ok('has asset-type input', e.isCommonStock === true, 'assetType=' + e.assetType);
  ok('has per-dataset flags', typeof e.datasets === 'object' && 'insiders' in e.datasets && 'news' in e.datasets);
  ok('has a dataset count', typeof e.datasetCount === 'number');
  ok('does NOT decide indexability yet', !('indexable' in e) && !('shouldIndex' in e));
  ok('eligibility is a separate object from the public model',
    bundles.get('AAPL').public !== bundles.get('AAPL').eligibility);
})();

section('7. no vendor call is possible from the bundle module');
{
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../src/lib/ticker-seo.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const f of ['fetch(', 'finnhub', 'polygon', 'tiingo', 'axios', 'https://'])
    ok(`bundle module contains no "${f}"`, !code.toLowerCase().includes(f.toLowerCase()));
  const view = await (await import('node:fs/promises')).readFile(
    new URL('../src/lib/ticker-seo-view.mjs', import.meta.url), 'utf8');
  ok('view model module imports nothing at all', !/^\s*import\s/m.test(view));
  ok('view model module reads no environment', !view.includes('process.env'));
}

section('8. insider window is stated, not implied');
ok('insider window carries its own length', bundles.get('AAPL')?.public.insiders.window?.windowDays === INSIDER_WINDOW_DAYS);
// A CASE MISMATCH HERE IS SILENT. The stored vocabulary is BUY/SELL/OTHER; comparing against 'Buy'
// returned trades=35, buys=0, sells=0, netValue=0 for AAPL and nothing failed. Assert the window
// actually classifies, rather than only that it exists.
(() => {
  const withInsiders = [...bundles.entries()].filter(([, b]) => b?.public.insiders.window?.trades > 0);
  ok('some ticker has a non-zero buy or sell count',
    withInsiders.some(([, b]) => (b.public.insiders.window.buys + b.public.insiders.window.sells) > 0),
    withInsiders.map(([s, b]) => s + ':' + JSON.stringify(b.public.insiders.window)).join(' ').slice(0, 200));
  for (const [sym, b] of withInsiders) {
    const w = b.public.insiders.window;
    ok(sym + ': buys + sells never exceeds trades', w.buys + w.sells <= w.trades,
      JSON.stringify(w));
    ok(sym + ': a net of zero means no buys and no sells',
      w.netValue !== 0 || (w.buys === 0 && w.sells === 0), JSON.stringify(w));
  }
  console.log('  insider windows: ' + withInsiders.map(([s, b]) => {
    const w = b.public.insiders.window;
    return s + '=' + w.trades + 't/' + w.buys + 'b/' + w.sells + 's';
  }).join('  '));
})();
ok('no key named "summary" anywhere in any public model',
  [...bundles.values()].filter(Boolean).every((b) => !JSON.stringify(b.public).includes('"summary"')));

// ── 9. timing ───────────────────────────────────────────────────────────────
section('9. bundle timing (uncached, this script has no Next cache)');
for (const [sym] of SAMPLES) {
  const runs = [];
  for (let i = 0; i < 3; i++) { const t = Date.now(); await getTickerBundle(sym); runs.push(Date.now() - t); }
  console.log('  ' + sym.padEnd(8) + runs.map((x) => String(x).padStart(6)).join('') + '   min=' + Math.min(...runs) + 'ms');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
