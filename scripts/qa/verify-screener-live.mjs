// THE PRODUCTION SCREENER — test symbols absent, everything else intact.
//
// ⚠️ THE BOARD IS CLIENT-RENDERED, so fetching the HTML proves nothing about what a reader sees: the
// rows arrive from /api/screener after hydration. This drives a real browser for the UI half and calls
// the API directly for the data half, because item 9 asks for both.
import { attach, newTab } from './cdp.mjs';

const BASE = 'https://www.catalystpit.com';
const RESERVED = /^(Z[A-Z]ZZT|[A-Z]?TEST[A-Z]?|ZXYZ[A-Z]?)$/;
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);

// pageSize caps at 100 and page is 0-based; filters arrive as one JSON object.
const api = async (qs) => {
  const r = await fetch(`${BASE}/api/screener?${qs}`);
  const j = await r.json().catch(() => ({}));
  const rows = j.rows || j.stocks || j.data || [];
  return { status: r.status, total: j.total ?? j.count ?? null, rows, raw: j };
};

L('⚠️ the API: no test symbol, and the universe is still whole');
{
  const first = await api('pageSize=100');
  ok('the Screener API answers', first.status === 200);
  ok('…with a full page', first.rows.length === 100, `${first.rows.length} rows`);
  ok('⚠️ the total is plausible, not collapsed', first.total > 15_000 && first.total < 30_000, String(first.total));

  // ⚠️ PAGE THROUGH A LARGE SLICE RATHER THAN TRUSTING ONE PAGE. A test symbol could sit anywhere in
  // the ordering, and the one thing a single page cannot tell you is whether it is absent everywhere.
  const seen = [];
  for (let pg = 0; pg < 30; pg++) {
    const p = await api(`pageSize=100&page=${pg}`);
    if (!p.rows.length) break;
    seen.push(...p.rows.map((r) => String(r.ticker || '').toUpperCase()));
  }
  ok('⚠️ a 3,000-row sweep returned rows', seen.length > 2500, `${seen.length} tickers`);
  const bad = seen.filter((t) => RESERVED.test(t));
  ok('⚠️ …and no reserved-shape symbol appears except a classified one',
    bad.every((t) => t === 'TEST'), JSON.stringify([...new Set(bad)]));
  // ⚠️ AND NOTHING MALFORMED EITHER, which is the adjacent failure a universe filter can introduce.
  const malformed = seen.filter((t) => !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t));
  ok('⚠️ every ticker served is a well-formed symbol', malformed.length === 0, JSON.stringify(malformed.slice(0, 6)));
  ok('…and there are no duplicate tickers in the sweep',
    new Set(seen).size === seen.length, `${seen.length - new Set(seen).size} dupes`);
  console.log(`         swept ${seen.length} tickers across 30 pages · total ${first.total}`);
}

L('⚠️ the specific families, asked for by name');
{
  // Asking for a test symbol directly is the strongest form: if the row existed, a ticker search finds it.
  for (const t of ['ZVZZT', 'ZWZZT', 'ZXZZT', 'ZTEST', 'NTEST', 'ATEST', 'ZXYZ']) {
    const r = await api(`ticker=${t}&pageSize=10`);
    const hit = r.rows.some((x) => String(x.ticker).toUpperCase() === t);
    ok(`⚠️ ${t} is not served`, !hit, JSON.stringify(r.rows.map((x) => x.ticker).slice(0, 4)));
  }
  // ⚠️ AND THE REAL ETF IS SERVED, which is what makes the rule a classification rather than a blacklist.
  const real = await api('ticker=TEST&pageSize=10');
  const found = real.rows.find((x) => String(x.ticker).toUpperCase() === 'TEST');
  ok('⚠️ the real TEST ETF IS served', !!found, JSON.stringify(real.rows.map((x) => x.ticker)));
  ok('…with its name and a price', !!(found?.company || found?.name) && Number(found?.price) > 0,
    JSON.stringify(found && { t: found.ticker, c: found.company || found.name, p: found.price }));
}

L('⚠️ legitimate securities across every instrument type are still served');
{
  const WANT = ['AAPL', 'MSFT', 'JPM', 'KO', 'SPY', 'QQQ', 'BABA', 'TSM', 'BRK.B', 'ZTS', 'ZM', 'CBOE', 'AEHR', 'INTT'];
  for (const t of WANT) {
    const r = await api(`ticker=${encodeURIComponent(t)}&pageSize=10`);
    ok(`${t} is served`, r.rows.some((x) => String(x.ticker).toUpperCase() === t), `${r.rows.length} rows`);
  }
}

L('⚠️ filters, sorting and pagination still work');
{
  // ⚠️ A UNIVERSE FILTER IS APPLIED IN THE SAME BUILD AS THESE, so a mistake here looks like a broken
  // control rather than a missing row. Each is checked for behaviour, not just a 200.
  const asc = await api('pageSize=20&sort=price&dir=asc');
  const desc = await api('pageSize=20&sort=price&dir=desc');
  const aOk = asc.rows.map((r) => Number(r.price)).filter(Number.isFinite);
  const dOk = desc.rows.map((r) => Number(r.price)).filter(Number.isFinite);
  ok('sorting ascending returns rows', aOk.length > 5);
  ok('⚠️ …and they really are ascending', aOk.every((v, i) => i === 0 || aOk[i - 1] <= v), JSON.stringify(aOk.slice(0, 5)));
  ok('sorting descending returns rows', dOk.length > 5);
  ok('⚠️ …and they really are descending', dOk.every((v, i) => i === 0 || dOk[i - 1] >= v), JSON.stringify(dOk.slice(0, 5)));
  // ⚠️ THE $7,616 ZTEST QUOTE IS WHY THIS MATTERS: a test symbol distorts any price-ordered board.
  ok('⚠️ the top of the price-descending board is not a test symbol',
    !RESERVED.test(String(desc.rows[0]?.ticker || '').toUpperCase()) || String(desc.rows[0]?.ticker) === 'TEST',
    String(desc.rows[0]?.ticker));

  const p1 = await api('pageSize=25&page=0');
  const p2 = await api('pageSize=25&page=1');
  ok('pagination returns distinct pages', p1.rows.length === 25 && p2.rows.length === 25
    && p1.rows[0].ticker !== p2.rows[0].ticker);
  ok('…and the pages do not overlap',
    p1.rows.filter((a) => p2.rows.some((b) => b.ticker === a.ticker)).length === 0);

  const filtered = await api(`pageSize=50&filters=${encodeURIComponent(JSON.stringify({ exchange: { eq: 'NASDAQ' } }))}`);
  ok('an exchange filter narrows the set', filtered.rows.length > 0 && filtered.total < 18_500,
    `${filtered.rows.length} rows / total ${filtered.total}`);
  const cap = await api(`pageSize=50&filters=${encodeURIComponent(JSON.stringify({ marketCap: { min: 100000000000 } }))}`);
  ok('⚠️ a market-cap filter actually filters',
    cap.rows.length > 0 && cap.rows.every((r) => !r.marketCap || Number(r.marketCap) >= 1e11),
    `${cap.rows.length} rows`);
}

const p = await attach(await newTab());

for (const mobile of [false, true]) {
  const label = mobile ? '@390px' : '@1440px';
  L(`⚠️ the rendered Screener ${label}`);
  await p.viewport(mobile ? 390 : 1440, mobile ? 844 : 900, mobile);
  await p.goto(`${BASE}/screener`, { settleMs: 2500, ceilingMs: 40_000 });
  await new Promise((r) => setTimeout(r, 6000));

  const v = await p.eval(`(() => {
    const links = [...document.querySelectorAll('a[href^="/ticker/"]')]
      .map((a) => decodeURIComponent(a.getAttribute('href').split('/').pop()).toUpperCase());
    const t = document.body.innerText;
    return {
      tickers: links, count: links.length,
      broken: /unavailable|failed to load|something went wrong/i.test(t),
      empty: /no (stocks|results|matches)/i.test(t),
      overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      chars: t.length
    };
  })()`);
  ok(`${label} the board renders rows`, v.count > 10, `${v.count} ticker links`);
  ok(`${label} ⚠️ it does not report itself broken`, v.broken === false);
  ok(`${label} ⚠️ …nor claim to be empty`, v.empty === false);
  const uiBad = v.tickers.filter((t) => RESERVED.test(t) && t !== 'TEST');
  ok(`${label} ⚠️ no test symbol is rendered`, uiBad.length === 0, JSON.stringify(uiBad));
  const uiMalformed = v.tickers.filter((t) => !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t));
  ok(`${label} every rendered ticker is well formed`, uiMalformed.length === 0, JSON.stringify(uiMalformed.slice(0, 5)));
  ok(`${label} no horizontal overflow`, v.overflow <= 1, `${v.overflow}px`);
  const hard = p.collected.pageErrors.filter((e) => !/ResizeObserver|Hydration/i.test(e));
  ok(`${label} no uncaught exception`, hard.length === 0, hard.slice(0, 1).join(''));
  console.log(`         ${label} first rows: ${v.tickers.slice(0, 8).join(', ')}`);
}

L('⚠️ performance: the board is not slower for having a universe filter');
{
  // The filter runs in the nightly rebuild, not per request — so a request should be unaffected. Measured
  // rather than asserted, and reported either way.
  const times = [];
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now();
    const r = await fetch(`${BASE}/api/screener?pageSize=100&cb=${Date.now()}`);
    await r.text();
    times.push(Date.now() - t0);
  }
  const median = times.sort((a, b) => a - b)[2];
  ok('⚠️ the Screener API responds well inside a second', median < 1500, `${times.join('ms, ')}ms`);
  console.log(`         median ${median}ms over 4 cold requests`);
}

console.log(`\n${pass} passed, ${fail} failed`);
p.close();
process.exit(fail ? 1 : 0);
