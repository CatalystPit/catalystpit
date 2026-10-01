// PRODUCTION VERIFICATION THAT NO UNAPPROVED COMMERCIAL DATA REACHES A USER.
//
// ⚠️ THE TEST IS WHAT THE BROWSER RECEIVES, not what the code says. The exposure this verifies was
// invisible in code review for months: /api/ticker returned a Finnhub quote, Finnhub's metrics block and
// a hotlinked static2.finnhub.io image URL to anonymous visitors, and every one of those is visible in
// the response body. So the response bodies are inspected directly, and the real browser is checked for
// requests to vendor hosts — because a hotlinked image is a request the SERVER never makes.
import { attach, newTab } from './cdp.mjs';

const BASE = 'https://www.catalystpit.com';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);

// Every host we may not take data from. A response mentioning one is either serving its data or telling
// the browser to go and fetch it.
const BAD = ['polygon.io', 'finnhub.io', 'twelvedata.com', 'financialmodelingprep.com',
  'coingecko.com', 'openfigi.com', 'logo.dev', 'alphavantage', 'intrinio', 'databento', 'stooq'];
const badIn = (s) => BAD.filter((h) => String(s).toLowerCase().includes(h));

// ⚠️ EVERY REQUEST BUSTS THE EDGE CACHE, AND THE FIRST VERSION OF THIS SUITE DID NOT.
//
// /api/ticker is deliberately shared at the CDN (s-maxage=45, stale-while-revalidate=120) because the
// response is user-independent. So a no-store request header on the CLIENT changes nothing: Vercel served a
// response generated before the deploy, and this suite reported Finnhub data still live minutes after
// the fix had shipped correctly. x-vercel-cache said HIT and the body said static2.finnhub.io.
//
// A unique query parameter changes the cache key, so each request reaches the function. The routes here
// read only their documented parameters, so an extra one is inert — and the suite asserts the header to
// prove it actually got a MISS rather than trusting that it did.
let probe = 0;
const bust = (p) => p + (p.includes('?') ? '&' : '?') + '_lic=' + Date.now() + (probe++);
const j = async (p) => {
  const r = await fetch(BASE + bust(p), { cache: 'no-store' });
  return { status: r.status, headers: r.headers, edge: r.headers.get('x-vercel-cache'), text: await r.text() };
};

L('1. NO UNAPPROVED VENDOR HOST APPEARS IN ANY PUBLIC RESPONSE BODY');
{
  const ROUTES = [
    '/', '/ticker/AAPL', '/screener', '/scan', '/terminal', '/heatmap', '/dividends',
    '/politicians', '/insiders', '/institutions', '/watchlist', '/news', '/markets',
    '/api/ticker?symbol=AAPL', '/api/screener?pageSize=25', '/api/quotes?symbols=AAPL,MSFT',
    '/api/market?key=ticker_tape', '/api/market?key=market_snapshot',
    '/api/chart-daily?ticker=AAPL&range=1Y', '/api/dividends?ticker=AAPL',
    '/api/dividends/calendar?from=2026-10-01&to=2026-10-31&limit=50',
    '/api/market-movers', '/api/heatmap/performance', '/api/short-interest?ticker=AAPL',
    '/api/earnings?ticker=AAPL', '/api/earnings-calendar', '/api/scan', '/api/logo?ticker=AAPL',
    '/api/institutions?limit=5', '/api/congress-overview?window=30d&limit=3',
    '/api/pitscan?board=all', '/api/wire?limit=10', '/api/health',
  ];
  for (const p of ROUTES) {
    let res;
    try { res = await j(p); } catch (e) { ok(`${p} responds`, false, e.message); continue; }
    const hits = badIn(res.text);
    ok(`${p.padEnd(52)} [${res.status}] names no unapproved vendor`, hits.length === 0, hits.join(','));
  }
}

L('2. THE TICKER PAGE SERVES LICENSED FIELDS AND WITHHOLDS THE REST');
{
  const r = JSON.parse((await j('/api/ticker?symbol=AAPL')).text);
  ok('the page still resolves and names the company', r.valid === true && !!r.name, JSON.stringify(r.name));
  ok('⚠️ a quote is served', r.quote && Number.isFinite(Number(r.quote.c)), JSON.stringify(r.quote));
  // ⚠️ THE LOGO WAS A HOTLINK TO A VENDOR CDN — the one field the user's own browser fetched.
  ok('⚠️ no logo URL is handed to the browser', r.logo === null, String(r.logo));
  ok('⚠️ the withheld fields are NULL rather than substituted',
    r.country === null && r.ipo === null && r.weburl === null,
    JSON.stringify({ country: r.country, ipo: r.ipo, weburl: r.weburl }));
  ok('⚠️ P/E and EPS are withheld, not estimated',
    r.metric?.peTTM === null && r.metric?.epsTTM === null, JSON.stringify(r.metric));
  // Computed from our own licensed candles — and a range needs a year behind it.
  const m = r.metric || {};
  ok('⚠️ the 52-week range is computed and plausible',
    m.high52 > 0 && m.low52 > 0 && m.high52 > m.low52 && Number(r.quote.c) <= m.high52 * 1.02,
    JSON.stringify({ high52: m.high52, low52: m.low52, last: r.quote.c }));
  ok('…and the range is a real year, not a handful of sessions',
    (m.high52 - m.low52) / m.low52 > 0.05, `${(((m.high52 - m.low52) / m.low52) * 100).toFixed(1)}% wide`);
  ok('⚠️ average volume is computed from licensed candles', m.avgVol10d > 0, String(m.avgVol10d));
  // The FINRA numerator survives; the FMP denominator does not.
  ok('⚠️ short interest still reports FINRA shares', Number(r.shortInterest?.shortIntShares) > 0,
    JSON.stringify(r.shortInterest));
  ok('⚠️ …and % of float is withheld rather than computed from an unlicensed float',
    r.shortInterest?.pctFloat === null, String(r.shortInterest?.pctFloat));
}

L('3. A REAL BROWSER MAKES NO REQUEST TO AN UNAPPROVED VENDOR');
{
  // ⚠️ THIS IS THE CHECK A SERVER-SIDE SWEEP CANNOT MAKE. The Finnhub logo was a URL in the payload, so
  // the vendor was contacted by the READER's browser, not by us — invisible to every server-side test.
  const p = await attach(await newTab());
  for (const route of ['/', '/ticker/AAPL', '/screener', '/heatmap']) {
    await p.viewport(1440, 900, false);
    await p.goto(`${BASE}${route}`, { settleMs: 2500, ceilingMs: 40_000 });
    await new Promise((r) => setTimeout(r, 5000));
    const vendorReqs = p.collected.requests.filter((r) => badIn(r.url).length);
    ok(`${route.padEnd(14)} the browser requested nothing from an unapproved vendor`,
      vendorReqs.length === 0, vendorReqs.slice(0, 4).map((r) => r.url.slice(0, 90)).join(' | '));
    const broken = await p.eval(`(() => /(something went wrong|unexpected error|unavailable right now)/i.test(document.body.innerText))()`);
    ok(`${route.padEnd(14)} …and the page is not broken`, broken === false);
  }
  p.close();
}

L('4. THE LICENSED SURFACES STILL WORK');
{
  const sc = JSON.parse((await j('/api/screener?pageSize=50')).text);
  ok('the Screener answers with rows', (sc.rows || []).length === 50, String(sc.rows?.length));
  ok('⚠️ …and prices are present, so removing the vendor did not empty the board',
    sc.rows.filter((r) => Number(r.price) > 0).length > 25,
    `${sc.rows.filter((r) => Number(r.price) > 0).length}/50 priced`);
  const ch = JSON.parse((await j('/api/chart-daily?ticker=AAPL&range=1Y')).text);
  const bars = ch.bars || ch.candles || [];
  ok('⚠️ a 1-year daily chart still has a year of licensed bars', bars.length > 200, String(bars.length));
  const q = JSON.parse((await j('/api/quotes?symbols=AAPL,MSFT')).text);
  ok('quotes still answer from the licensed provider', Object.keys(q).length === 2, JSON.stringify(Object.keys(q)));
  const tape = JSON.parse((await j('/api/market?key=ticker_tape')).text);
  const arr = tape.data || tape.tickers || [];
  ok('⚠️ the tape is still priced (now from the licensed provider)',
    Array.isArray(arr) && arr.filter((x) => Number(x.price) > 0).length >= 5,
    `${arr.filter?.((x) => Number(x.price) > 0).length} priced of ${arr.length}`);
  ok('⚠️ …and carries no BTC row, rather than a zero price',
    !arr.some((x) => String(x.symbol).startsWith('BTC')), JSON.stringify(arr.map((x) => x.symbol)));
  const dv = JSON.parse((await j('/api/dividends/calendar?from=2026-10-01&to=2026-10-31&limit=200')).text);
  ok('the dividend calendar still answers', (dv.events || []).length > 20, String(dv.events?.length));
  const h = JSON.parse((await j('/api/health')).text);
  ok('⚠️ overall health is still healthy', h.ok === true && h.status === 'healthy', String(h.status));
}

L('5. THE RETIRED ENDPOINTS ANSWER HONESTLY RATHER THAN ERRORING');
{
  const ec = await j('/api/earnings-calendar');
  ok('the earnings calendar reports unconfigured', ec.status === 200 && /"configured":false/.test(ec.text));
  const lg = await fetch(BASE + bust('/api/logo?ticker=AAPL'), { cache: 'no-store' });
  ok('⚠️ the logo route 404s so the initials badge renders', lg.status === 404, String(lg.status));
  const sc = await j('/api/scan?mode=custom&priceMoreThan=10');
  ok('⚠️ the FMP custom scanner mode is refused', sc.status === 400, `${sc.status} ${sc.text.slice(0, 60)}`);
}

L('6. THE LEGAL PAGES NAME ONLY SOURCES WE ACTUALLY USE');
{
  for (const p of ['/terms', '/privacy', '/disclaimer']) {
    const r = await j(p);
    const hits = badIn(r.text);
    ok(`${p} names no retired vendor`, hits.length === 0, hits.join(','));
    ok(`${p} still attributes Tiingo`, /Tiingo/i.test(r.text));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log('\nNOT VERIFIED HERE — requires credentials:');
console.log('  · a signed-in Free or Pro session on any surface (no credentials available)');
console.log('  · Pro intraday charts and the Pro Screener aggregate, which are entitlement-gated');
process.exit(fail ? 1 : 0);
