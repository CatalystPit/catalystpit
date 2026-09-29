// THE TICKER PAGE'S SERVER-RENDERED PAYLOAD.
//
//   node --env-file=.env.local scripts/verify-ticker-ssr.mjs            # bundle + metadata behaviour
//   BASE=http://localhost:3123 node --env-file=.env.local scripts/verify-ticker-ssr.mjs
//   BASE=https://www.catalystpit.com node scripts/verify-ticker-ssr.mjs --live-only
//
// ⚠️ WHAT WAS WRONG. The body of /ticker/[symbol] was client-rendered end to end: the first HTML
// carried a grey skeleton and every fact about the company arrived from /api/ticker after hydration.
// A crawler that runs no JavaScript received a nav, a footer and two rectangles, for ~20,500
// advertised URLs.
//
// So the assertions that matter are about the RAW RESPONSE — fetched, not rendered — and about the
// STRINGS the metadata says. Both are checked against real symbols chosen for the situations that
// differ: a clean large cap, the two tickers whose names used to be SIC descriptions, a share class
// with a dot, a small cap, a recent listing, a symbol we know ONLY through its filings, and a symbol
// we know nothing about.
import { getTickerBundle } from '../src/lib/ticker-seo.mjs';
import { tickerTitle, tickerDescription, tickerStructuredData, identityLabel } from '../src/lib/ticker-seo-meta.mjs';
import { buildPublicView } from '../src/lib/ticker-seo-view.mjs';
import { canonicalSiteUrl } from '../src/lib/seo.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const BASE = process.env.BASE || '';
const LIVE_ONLY = process.argv.includes('--live-only');

// AAPL/MSFT/NVDA: clean. XOM/ZTS: the two the SIC fallback used to rename. BRK.B: the dotted share
// class our resolver actually holds. AACG: small cap. NWCL: recent listing. LBTY: filings-only —
// 114 Form 4s, no screener_stocks row at all. ZZZZZZ: not a security.
const CASES = ['AAPL', 'MSFT', 'NVDA', 'XOM', 'ZTS', 'SIRI', 'BRK.B', 'AACG', 'NWCL', 'LBTY'];
const UNKNOWN = 'ZZZZZZ';

const bundles = new Map();
if (!LIVE_ONLY) {
  for (const s of [...CASES, UNKNOWN]) bundles.set(s, (await getTickerBundle(s))?.public || null);
}

if (!LIVE_ONLY) {
  L('every representative symbol resolves an identity we can render');
  for (const s of CASES) {
    const v = bundles.get(s);
    ok(`${s} has a company name`, !!v?.identity?.companyName, JSON.stringify(v?.identity ?? null));
  }
  ok(`${UNKNOWN} resolves no identity at all`, !bundles.get(UNKNOWN)?.identity);

  L('⚠️ a symbol known only through its filings still has a name');
  {
    // The regression this pins: identity came only from screener_stocks, which has no row for LBTY.
    // 2,816 sitemap-shaped symbols were in that position — advertised, crawled, and unable to say
    // who they were while security_identity held the name from their own Form 4.
    const v = bundles.get('LBTY');
    ok('LBTY is named from the security master', v?.identity?.companyName === 'Liberty Global Ltd.', String(v?.identity?.companyName));
    ok('...with no screener listing facts invented to go with it',
      v.identity.exchange === null && v.identity.sector === null && v.identity.marketCap === null,
      JSON.stringify(v.identity));
    ok('...and the master alone never fabricates a symbol', v.identity.symbol === 'LBTY');
  }

  L('⚠️ an SIC description can never become the company name');
  {
    // The live corpus is clean, so a clean corpus cannot be the test. These are synthetic rows in
    // exactly the shape the bug produced — the name character-identical to another descriptive column
    // on its own row — fed through the real view model, from BOTH possible sources.
    const contaminated = (over) => buildPublicView('TEST', {
      identity: { ticker: 'TEST', company: 'PHARMACEUTICAL PREPARATIONS', exchange: 'NYSE',
        sector: 'Healthcare', industry: 'PHARMACEUTICAL PREPARATIONS', country: 'USA',
        asset_type: 'Stock', market_cap: 1e9 },
      ...over,
    });
    ok('a screener name equal to its own industry is refused',
      contaminated({}).identity.companyName === null);
    ok('⚠️ ...and so is a MASTER name equal to it, which is the new source',
      contaminated({ master: { name: 'PHARMACEUTICAL PREPARATIONS', source: 'provider' } }).identity.companyName === null,
      'the new master path bypassed the contamination gate');
    ok('...while the rest of the identity survives',
      contaminated({}).identity.sector === 'Healthcare' && contaminated({}).identity.exchange === 'NYSE');
    const clean = contaminated({ master: { name: 'Zoetis Inc.', source: 'form4' } });
    ok('a real master name is used even when the screener copy is contaminated',
      clean.identity.companyName === 'Zoetis Inc.');
    // Sector, country and asset type are the other columns the same bug wrote.
    for (const [col, val] of [['sector', 'Healthcare'], ['country', 'USA'], ['asset_type', 'Stock']]) {
      const v = buildPublicView('TEST', { identity: { ticker: 'TEST', company: val, [col]: val } });
      ok(`a name equal to its own ${col} is refused`, v.identity.companyName === null, String(v.identity.companyName));
    }
  }

  L('metadata speaks from the same object the page renders');
  for (const s of CASES) {
    const v = bundles.get(s);
    const name = v.identity.companyName;
    const title = tickerTitle(v);
    const desc = tickerDescription(v);
    ok(`${s} title carries the company name and the symbol`,
      title.includes(name) && title.includes(s), title);
    ok(`${s} description carries the same name`, desc.includes(name), desc);
    ok(`${s} description fits a search result`, desc.length <= 158, `${desc.length} chars`);
    // ⚠️ THE AGREEMENT IS THE POINT. One object, three renderings; they cannot name two companies.
    ok(`${s} title and description agree on identity`,
      title.startsWith(identityLabel(v)) && desc.startsWith(identityLabel(v)));
  }

  L('⚠️ the description promises only datasets we actually hold');
  {
    const bare = buildPublicView('TEST', { identity: { ticker: 'TEST', company: 'Test Co', exchange: 'NYSE' } });
    const d = tickerDescription(bare);
    ok('a page with no rows advertises no datasets',
      !/insider|congress|institutional|filings|news/i.test(d), d);
    ok('...and still states who it is', d.includes('Test Co (TEST)'), d);
    const insOnly = buildPublicView('TEST', {
      identity: { ticker: 'TEST', company: 'Test Co', exchange: 'NYSE' },
      insiderRecent: [{ executive: 'A', action: 'BUY', filing_date: '2026-01-01' }],
    });
    ok('a page with only insider rows names only insider trades',
      /insider trades\.$/.test(tickerDescription(insOnly)), tickerDescription(insOnly));
    ok('nothing at all yields NO description rather than a bare symbol',
      tickerDescription(buildPublicView('TEST', {})) === null,
      String(tickerDescription(buildPublicView('TEST', {}))));
  }

  L('⚠️ no claim about the security, in any string');
  {
    // Wording a financial page must never generate on its own authority.
    const BANNED = /\b(buy|sell|hold|best|top|undervalued|overvalued|outperform|underperform|forecast|prediction|predicted|target price|should you|worth buying|strong|bullish|bearish|rating|recommend)\b/i;
    for (const s of CASES) {
      const v = bundles.get(s);
      const both = `${tickerTitle(v)} ${tickerDescription(v)}`;
      // "Insider & Congress Trades" contains "Trades", not a verb about what a reader should do.
      ok(`${s} strings make no recommendation or performance claim`,
        !BANNED.test(both.replace(/insider trades|congressional trades|Congress Trades/gi, '')), both);
    }
  }

  L('structured data states facts, or is absent');
  {
    const URL_ = 'https://www.catalystpit.com/ticker/AAPL';
    const ld = tickerStructuredData(bundles.get('AAPL'), URL_);
    ok('a named common stock gets a Corporation', ld?.['@type'] === 'Corporation');
    ok('...carrying only name, tickerSymbol and url',
      JSON.stringify(Object.keys(ld).sort()) === JSON.stringify(['@context', '@type', 'name', 'tickerSymbol', 'url']),
      Object.keys(ld).join(','));
    // ⚠️ NOTHING FABRICATED. Every one of these properties exists in the vocabulary and every one
    // would be invented here.
    const flat = JSON.stringify(ld);
    for (const prop of ['aggregateRating', 'ratingValue', 'offers', 'price', 'review', 'priceRange', 'tickerPrice'])
      ok(`no ${prop} in the structured data`, !flat.includes(prop));
    const etf = buildPublicView('TEST', { identity: { ticker: 'TEST', company: 'Some ETF', asset_type: 'ETS' } });
    ok('⚠️ an ETF is NOT declared a Corporation', tickerStructuredData(etf, URL_) === null);
    const unnamed = buildPublicView('TEST', { identity: { ticker: 'TEST', asset_type: 'Stock' } });
    ok('a security we cannot name gets no structured data', tickerStructuredData(unnamed, URL_) === null);
    ok('an unknown symbol gets none', tickerStructuredData(bundles.get(UNKNOWN), URL_) === null);
  }

  L('⚠️ no market-data provider is reachable from the SSR identity path');
  {
    // Against SOURCE, transitively: a fetch anywhere in this graph would put a vendor on the critical
    // path of the HTML response, so a provider outage would become a site outage and a crawl of
    // 20,500 URLs would become a metered bill.
    const files = ['../src/lib/ticker-seo.mjs', '../src/lib/ticker-seo-view.mjs',
      '../src/lib/ticker-seo-meta.mjs', '../src/lib/ticker-seo.server.mjs'];
    for (const f of files) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8')
        .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join('\n');
      ok(`${f.split('/').pop()} performs no fetch`, !/\bfetch\s*\(/.test(src));
      ok(`${f.split('/').pop()} names no market-data vendor`,
        !/finnhub|polygon|tiingo|alphavantage|iexcloud|fmp/i.test(src));
    }
    // And the route imports the bundle, not the vendor-backed API handler.
    const page = readFileSync(new URL('../src/app/ticker/[symbol]/page.jsx', import.meta.url), 'utf8');
    ok('⚠️ the route reads the bundle through the server-only guard',
      /from '\.\.\/\.\.\/\.\.\/lib\/ticker-seo\.server\.mjs'/.test(page));
    ok('the route does not call /api/ticker on the server', !/api\/ticker/.test(page));
  }

  L('⚠️ only the public half crosses to the client');
  {
    const page = readFileSync(new URL('../src/app/ticker/[symbol]/page.jsx', import.meta.url), 'utf8');
    ok('the page passes bundle.public, never the bundle', /ssr=\{view\}/.test(page) && /bundle\?\.public/.test(page));
    ok('⚠️ eligibility is never handed to a component', !/eligibility/.test(page.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')));
  }

  L('⚠️ hydration cannot replace our identity with the vendor\'s');
  {
    // /api/ticker's resolveValidity falls back to the bare SYMBOL as the "name" whenever the provider
    // has no profile for a ticker. Without this merge, LBTY's page would server-render
    // "Liberty Global Ltd." and then hydrate to "LBTY".
    const tp = readFileSync(new URL('../src/app/ticker/[symbol]/TickerPage.jsx', import.meta.url), 'utf8');
    ok('the rendered name prefers the server identity',
      /name: ssr\.identity\.companyName \|\| data\.name/.test(tp),
      'the vendor name would win and could be the bare symbol');
    ok('...and exchange/industry fall back to it rather than to nothing',
      /exchange: data\.exchange \|\| ssr\.identity\.exchange/.test(tp)
      && /industry: data\.industry \|\| ssr\.identity\.industry/.test(tp));
    ok('⚠️ the SSR shell is what the loading state renders, not a skeleton',
      /if \(loading\) return <TickerSeoShell symbol=\{symbol\} ssr=\{ssr\} \/>;/.test(tp));
    ok('...and the Suspense fallback too, so the streamed shell is not blank',
      /<Suspense fallback=\{<TickerSeoShell symbol=\{symbol\} ssr=\{ssr\} \/>\}>/.test(tp));
    ok('⚠️ a symbol the vendor cannot price keeps the identity we hold',
      /ssr\?\.identity \? <TickerSeoShell symbol=\{symbol\} ssr=\{ssr\} \/> : <NotFound/.test(tp));
    ok('the shell degrades to the old skeleton when we hold no identity',
      /if \(!id\) return <LoadingShell \/>;/.test(tp));

    // ⚠️ THE HEADING MUST SURVIVE HYDRATION, AND GOOGLEBOT RUNS JAVASCRIPT. Measured in headless
    // Chrome: the server shell headed the page with an h1, the client page replaced it with a div of
    // spans, and the hydrated DOM — the version actually indexed — had NO h1 at all. Both renderers
    // emit exactly one, carrying the same symbol and name.
    const h1s = tp.match(/<h1[\s>]/g) || [];
    ok('⚠️ both the shell and the hydrated Hero head the page with an h1', h1s.length === 2, `${h1s.length} h1 element(s)`);
    // Each block is non-greedy, so it ends at its OWN closing tag rather than the next one in the file.
    const blocks = tp.match(/<h1[\s\S]*?<\/h1>/g) || [];
    ok('⚠️ ...and neither heading holds the Alert or Watchlist control',
      blocks.length === 2 && blocks.every((b) => !/AlertToggle|WatchlistStar/.test(b)),
      'the buttons were inside the heading text a crawler reads');
    ok('...and both name the symbol', blocks.every((b) => /\{symbol\}|\{data\.symbol\}/.test(b)));
  }

  L('⚠️ the canonical host is enforced, not merely defaulted');
  {
    // Production ran with NEXT_PUBLIC_SITE_URL=https://catalystpit.com while the apex 307s to www, so
    // every canonical, the sitemap, robots Host and every Open Graph url nominated a redirect. The
    // default here was ALREADY www and its comment already said why; a default is not a guarantee.
    ok('⚠️ the apex is rewritten to www', canonicalSiteUrl('https://catalystpit.com') === 'https://www.catalystpit.com');
    ok('⚠️ ...however it is spelled', canonicalSiteUrl('http://catalystpit.com/') === 'https://www.catalystpit.com'
      && canonicalSiteUrl('https://catalystpit.com/some/path') === 'https://www.catalystpit.com');
    ok('http on the canonical host is upgraded', canonicalSiteUrl('http://www.catalystpit.com') === 'https://www.catalystpit.com');
    ok('an unset or unusable value falls back to www',
      canonicalSiteUrl(undefined) === 'https://www.catalystpit.com' && canonicalSiteUrl('not a url') === 'https://www.catalystpit.com');
    // ⚠️ AND IT IS NOT A BLANKET "ADD www" RULE. A preview must keep its own identity, or every
    // preview deploy would claim to be the canonical site.
    ok('⚠️ localhost is left alone', canonicalSiteUrl('http://localhost:3000') === 'http://localhost:3000');
    ok('⚠️ a preview host is left alone', canonicalSiteUrl('https://cp-git-x.vercel.app') === 'https://cp-git-x.vercel.app');
  }

  L('⚠️ the title names only the categories this page has');
  {
    // Every ticker used to be titled "· Stock Price, News, Insider & Congress Trades" whether or not
    // it held one insider filing or one headline.
    const view = (over) => buildPublicView('TEST', { identity: { ticker: 'TEST', company: 'Test Co' }, ...over });
    const bare = tickerTitle(view({}));
    ok('a page with nothing enumerates nothing', bare === 'Test Co (TEST) · Stock Overview', bare);
    const insOnly = tickerTitle(view({ insiderRecent: [{ executive: 'A', filing_date: '2026-01-01' }] }));
    ok('⚠️ a page with only insider rows says only Insider Trades',
      insOnly === 'Test Co (TEST) · Insider Trades', insOnly);
    ok('⚠️ ...and does NOT claim congress, news or filings',
      !/Congress|News|SEC Filings/.test(insOnly), insOnly);
    const withMkt = tickerTitle(view({ candle: { date: '2026-01-02', close: 5 } }));
    ok('Stock Price appears only where we hold price history',
      withMkt === 'Test Co (TEST) · Stock Price' && !/Stock Price/.test(bare), withMkt);
    const all = tickerTitle(view({
      insiderRecent: [{ executive: 'A' }], congress: [{ representative: 'B' }],
      institutions: { filer_count: 3 }, news: [{ headline: 'H' }], filings: [{ filing_url: 'https://www.sec.gov/x' }],
      candle: { date: '2026-01-02', close: 5 },
    }));
    ok('⚠️ a full page is capped at three categories so the identity survives truncation',
      all.split('·')[1].split(',').length === 3 && all.length <= 80, `${all.length}: ${all}`);
    ok('...and the identity is first', all.startsWith('Test Co (TEST) ·'), all);
  }

  L('⚠️ institutional ownership reaches the initial HTML, as an aggregate');
  {
    const tp = readFileSync(new URL('../src/app/ticker/[symbol]/TickerPage.jsx', import.meta.url), 'utf8');
    ok('the shell renders the institutional block', /INSTITUTIONAL OWNERSHIP/.test(tp));
    ok('...from the bundle\'s aggregate', /const inst = ssr\.institutions;/.test(tp));
    // ⚠️ AGGREGATE ONLY. Per-fund positions come from 9.2M rows of CUSIP-resolved 13F work and must
    // never reach a crawlable page.
    const block = (/INSTITUTIONAL OWNERSHIP[\s\S]{0,1800}/.exec(tp) || [''])[0];
    ok('⚠️ no per-fund position is rendered', !/\b(fund|filer_name|filerName|holdings\.map|positions)\b/.test(block));
    const v = bundles.get('AAPL');
    ok('the bundle carries the aggregate for a large cap', (v?.institutions?.holders ?? 0) > 0, JSON.stringify(v?.institutions));
    ok('...and never a list of funds', !Array.isArray(v?.institutions));
  }

  L('the SSR payload stays small');
  for (const s of ['AAPL', 'XOM', 'LBTY']) {
    const bytes = JSON.stringify(bundles.get(s)).length;
    ok(`${s} serializes small enough to sit in HTML`, bytes < 12000, `${bytes} bytes`);
  }
}

// ── the raw response, if a server was given ─────────────────────────────────
if (BASE) {
  L(`RAW INITIAL HTML from ${BASE} — no JavaScript executed`);
  const get = async (path) => {
    const r = await fetch(`${BASE}${path}`, { redirect: 'manual' });
    return { status: r.status, location: r.headers.get('location'), html: r.status === 200 ? await r.text() : '' };
  };
  const text = (h) => h.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
  const meta = (h, re) => (re.exec(h) || [])[1] || null;

  // ⚠️ THE ORIGIN IS DERIVED, NOT HARDCODED. It differs by environment — production self-canonicalises
  // to https://catalystpit.com, a preview and the dev server to something else — and an assertion that
  // spelled one host in failed against a correct deployment while proving nothing about the property
  // that matters. What matters is that EVERY page agrees on ONE origin and that each canonical is its
  // own bare uppercase path; a www/non-www split is exactly what that catches.
  const probe = await get(`/ticker/${CASES[0]}`);
  const ORIGIN = (meta(probe.html, /<link rel="canonical" href="(https?:\/\/[^/"]+)/) || '');
  ok('the site states a canonical origin', /^https:\/\/[^/]+$/.test(ORIGIN), ORIGIN);
  const expect = (path) => `${ORIGIN}${path}`;

  // ⚠️ A CANONICAL MUST NOT POINT AT A URL THAT REDIRECTS AWAY. Found live: production emits
  // canonical https://catalystpit.com/... for every page, and the apex 307s to www — so the URL we
  // nominate as canonical is one Google cannot fetch without a hop, on all ~20,500 ticker URLs plus
  // the sitemap, robots Host and every Open Graph url. seo.js already defaults to the www host and
  // says why; NEXT_PUBLIC_SITE_URL is set in the Vercel production environment to the apex and
  // overrides it. The fix is that variable, not this code — and this assertion is what notices.
  {
    const r = await fetch(`${ORIGIN}/ticker/${CASES[0]}`, { redirect: 'manual' });
    ok('⚠️ the canonical origin serves the page itself, not a redirect to another host',
      r.status === 200, `${ORIGIN} -> HTTP ${r.status} ${r.headers.get('location') || ''}`);
  }

  for (const s of CASES) {
    const { status, html } = await get(`/ticker/${encodeURIComponent(s)}`);
    ok(`${s} answers 200`, status === 200, String(status));
    if (status !== 200) continue;
    const body = text(html);
    const v = bundles.get(s);
    const name = v?.identity?.companyName;
    // 1 — the symbol is in the initial HTML, as a heading.
    const h1 = (/<h1[\s\S]*?<\/h1>/.exec(html) || [''])[0];
    ok(`${s} initial HTML has ONE h1 naming the security`,
      (html.match(/<h1[\s>]/g) || []).length === 1 && text(h1).includes(s), text(h1));
    // 2 — the company name is in the initial HTML.
    if (name && !LIVE_ONLY) {
      ok(`${s} company name is in the initial HTML`, body.includes(name), name);
      ok(`${s} ...and in the h1 beside the symbol`, text(h1).includes(name), text(h1));
      // 4 — metadata uses the same identity as the body.
      ok(`${s} <title> names the same company as the h1`, (meta(html, /<title>([^<]*)<\/title>/) || '').includes(name));
      ok(`${s} meta description names the same company`,
        (meta(html, /<meta name="description" content="([^"]*)"/) || '').includes(name));
    }
    // 3 — basic company content, where we have it.
    if (v?.identity?.exchange && !LIVE_ONLY) {
      ok(`${s} exchange and sector are in the initial HTML`,
        body.includes(v.identity.exchange) && (!v.identity.sector || body.includes(v.identity.sector)));
    }
    // 5 — canonical, uppercase, self.
    ok(`${s} canonical is the bare uppercase URL`,
      meta(html, /<link rel="canonical" href="([^"]*)"/) === expect(`/ticker/${s}`),
      String(meta(html, /<link rel="canonical" href="([^"]*)"/)));
    // 6 — a known ticker is indexable.
    ok(`${s} is indexable`, !/noindex/.test(meta(html, /<meta name="robots" content="([^"]*)"/) || ''));

    // ⚠️ SETTING openGraph IN A ROUTE DELETES THE FILE-BASED IMAGE. Measured on the running app,
    // /ticker/ZTS carried no og:image and no twitter:image while still declaring
    // twitter:card=summary_large_image — the blank card X renders. There is no per-ticker image and
    // inventing 20,000 of them is not the fix; naming the one brand image is.
    ok(`${s} carries the brand social image`,
      /\/opengraph-image/.test(meta(html, /<meta property="og:image" content="([^"]*)"/) || ''),
      String(meta(html, /<meta property="og:image" content="([^"]*)"/)));
    ok(`${s} ...and the card that promises one has one`,
      !/summary_large_image/.test(meta(html, /<meta name="twitter:card" content="([^"]*)"/) || '')
      || /\/opengraph-image/.test(meta(html, /<meta name="twitter:image" content="([^"]*)"/) || ''));
    // Social strings must not diverge from the page's own identity.
    if (!LIVE_ONLY && v?.identity?.companyName) {
      ok(`${s} og:title and og:url match the page`,
        (meta(html, /<meta property="og:title" content="([^"]*)"/) || '').includes(v.identity.companyName)
        && meta(html, /<meta property="og:url" content="([^"]*)"/) === expect(`/ticker/${s}`));
    }
  }

  L('SEO safety, unchanged');
  {
    const unk = await get(`/ticker/${UNKNOWN}`);
    ok('an unknown symbol still answers 200', unk.status === 200, String(unk.status));
    ok('⚠️ an unknown symbol is noindex', /noindex/.test(meta(unk.html, /<meta name="robots" content="([^"]*)"/) || ''));
    ok('⚠️ ...and makes no claim: no heading, no company, no structured data',
      !/<h1[\s>]/.test(unk.html) && !/"@type":"Corporation"/.test(unk.html));

    const lower = await get('/ticker/aapl');
    ok('⚠️ lowercase is a 308 to the uppercase URL',
      lower.status === 308 && /\/ticker\/AAPL$/.test(lower.location || ''), `${lower.status} ${lower.location}`);

    const qp = await get('/ticker/AAPL?ref=twitter');
    ok('⚠️ a query parameter does not create a second canonical',
      meta(qp.html, /<link rel="canonical" href="([^"]*)"/) === expect('/ticker/AAPL'),
      String(meta(qp.html, /<link rel="canonical" href="([^"]*)"/)));
    const tab = await get('/ticker/AAPL?tab=insider');
    ok('...nor does a tab', meta(tab.html, /<link rel="canonical" href="([^"]*)"/) === expect('/ticker/AAPL'),
      String(meta(tab.html, /<link rel="canonical" href="([^"]*)"/)));

    const junk = await get('/ticker/.....');
    ok('a malformed segment is still a 404', junk.status === 404, String(junk.status));

    // ⚠️ THE CONTAMINATION CHECK, AGAINST THE LIVE RESPONSE. XOM and ZTS are the two symbols whose
    // names WERE their SIC descriptions. If that ever regresses, it regresses into crawlable markup.
    for (const [s, sic] of [['XOM', 'PETROLEUM REFINING'], ['ZTS', 'PHARMACEUTICAL PREPARATIONS']]) {
      const { html } = await get(`/ticker/${s}`);
      const h1 = text((/<h1[\s\S]*?<\/h1>/.exec(html) || [''])[0]);
      ok(`${s} heading is the company, not its SIC description`, !h1.includes(sic), h1);
      ok(`${s} <title> is the company, not its SIC description`,
        !(meta(html, /<title>([^<]*)<\/title>/) || '').includes(sic));
      ok(`${s} Corporation name is the company, not its SIC description`,
        !new RegExp(`"name":"${sic}"`).test(html));
    }
  }
} else {
  console.log('\n(no BASE given — raw-HTML assertions skipped; set BASE to run them)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
