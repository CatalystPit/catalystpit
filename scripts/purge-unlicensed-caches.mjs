// PURGE CACHED RESPONSES THAT STILL HOLD UNAPPROVED-PROVIDER DATA.
//
//   node --env-file=.env.local scripts/purge-unlicensed-caches.mjs [--apply]
//
// ⚠️ THE DEPLOY DID NOT STOP THE EXPOSURE, AND THIS IS WHY. /api/ticker caches each section in KV with
// its own TTL — profile 24h, metric 30m, short-interest 6h, quote 5m, news 5m — and reads the cache
// before it fetches. So minutes after shipping the removal, production was still handing anonymous
// visitors Finnhub's `logo` (a static2.finnhub.io URL the reader's own browser then requests), Finnhub's
// country/IPO/website, Finnhub's peTTM and epsTTM, and a "% of float" computed from an FMP denominator.
// Every one of those was measured on the live site AFTER the deploy went green.
//
// A cache is a copy of the data. Removing the integration stops new copies; it does not recall the ones
// already made, and a 24-hour TTL is a 24-hour tail on a licensing problem. The audit brief named this
// vector directly — cached responses are one of the ways unapproved data keeps reaching users — and the
// honest conclusion is that "deployed" is not the same as "no longer served".
//
// ⚠️ IT DELETES RATHER THAN REWRITES. The next request repopulates each key from the licensed path, which
// is the same work a cold cache always does. Writing corrected values in would mean this script becoming
// a second, unverified implementation of the ticker route.
const URL_BASE = process.env.KV_REST_API_URL;
const TOKEN = process.env.KV_REST_API_TOKEN;
const APPLY = process.argv.includes('--apply');

if (!URL_BASE || !TOKEN) { console.error('KV is not configured in this environment'); process.exit(1); }

const kv = async (path) => {
  const r = await fetch(`${URL_BASE}/${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`KV ${path}: HTTP ${r.status}`);
  return (await r.json()).result;
};

// The sections that held vendor-derived values. `quote` and `news` are included even though both now come
// from the licensed provider: a cached quote written minutes before the deploy is a Finnhub quote, and
// there is no way to tell one from the other by looking at it.
const TICKER_SECTIONS = ['profile', 'metric', 'shortint', 'quote', 'news', 'ma50', 'notfound'];
const PATTERNS = [
  ...TICKER_SECTIONS.map((s) => `catalystpit:ticker:*:${s}`),
  'catalystpit:quote:*',          // the shared quote cache /api/watchlist and /api/ticker both use
  'catalystpit:ticker_tape',      // Finnhub-priced tape, incl. the CoinGecko BTC row
  'catalystpit:market_snapshot',  // same
  'catalystpit:_raw_news',        // merged news, included the two Finnhub feeds
  'catalystpit:wire_news',
  'earnings_cal:v1',              // the Twelve Data earnings calendar
];

let totalFound = 0, totalDeleted = 0;
for (const pattern of PATTERNS) {
  // SCAN rather than KEYS: a blocking full-keyspace scan on a shared Redis is a bad habit even when it
  // would work, and the cursor form is what Upstash documents for large keyspaces.
  const found = [];
  let cursor = '0';
  do {
    const res = await kv(`scan/${cursor}/match/${encodeURIComponent(pattern)}/count/1000`);
    cursor = String(res[0]);
    for (const k of (res[1] || [])) found.push(k);
  } while (cursor !== '0');

  totalFound += found.length;
  console.log(`${pattern.padEnd(42)} ${String(found.length).padStart(6)} keys`);
  if (!APPLY || !found.length) continue;

  for (let i = 0; i < found.length; i += 100) {
    const batch = found.slice(i, i + 100);
    // Upstash accepts a pipelined DEL; one request per 100 keys keeps this to a handful of round trips.
    const r = await fetch(`${URL_BASE}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(batch.map((k) => ['DEL', k])),
    });
    if (!r.ok) { console.error(`  DEL batch failed: HTTP ${r.status}`); continue; }
    totalDeleted += batch.length;
  }
  console.log(`${' '.repeat(42)} ${String(found.length).padStart(6)} deleted`);
}

console.log(`\nkeys matched: ${totalFound}${APPLY ? ` · deleted: ${totalDeleted}` : '  [DRY RUN — re-run with --apply]'}`);
if (APPLY) console.log('Each key repopulates from the licensed path on the next request.');
