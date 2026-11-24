// ─────────────────────────────────────────────────────────────────────────────
// WHAT A CRAWLER ACTUALLY RECEIVES FROM CATALYST PIT, AND WHAT IT COSTS US TO SERVE
//
// ── ⚠️ WHY THIS EXISTS WHEN SEARCH CONSOLE ALREADY DOES ─────────────────────
//
// It does not do what Search Console does, and it is not a substitute for it. Search Console
// answers "what were we shown for, and did anyone click" — demand-side, and it needs the owner's
// account. This answers the two supply-side questions no dashboard reports:
//
//   1. does the research reach a crawler at all WITHOUT JavaScript, per page, and
//   2. does serving that page cost an origin render every single time.
//
// Both are measurable from outside with no credentials, which is the whole point: the Search
// Console API needs a service account nobody has provisioned yet (the domain IS verified — a
// google-site-verification TXT record is live on catalystpit.com — but a verified property is not
// programmatic access), and Bing Webmaster Tools has no property at all. This file is the part of
// the baseline that does not have to wait for either.
//
// ⚠️ AND IT IS A BASELINE, WHICH MEANS THE DATES MATTER. Numbers below are what it printed when
// written, so a later run is a comparison and not just a reading.
//
// Measured 2026-11-24 against production (41668bf7, then dd09c1d7):
//
//   route          words  /ticker links  <time>  cached   note
//   /                531             15      20  HIT      server-rendered at 541b81a8/41668bf7
//   /dividends     4,958            298       0  MISS     force-dynamic: 4 queries per request
//   /insiders        376              0       0  HIT      headings and column labels, no rows
//   /politicians     264              0       0  HIT      same
//   /scan            189              0       0  HIT      same
//   /institutions    177              0       0  HIT      same
//   /consensus       163              0       0  HIT      same
//   /news            129              0       0  HIT      same
//   /screener          4              0       0  HIT      advertised in sitemap.xml at priority 0.7
//   /ticker/AAPL     269              0       0  MISS     identity only; fixed to HIT at dd09c1d7
//
// The ticker universe, same 60-URL sitemap spread, before and after dd09c1d7:
//
//                        41668bf7      dd09c1d7
//   served no-store        60 of 60      0 of 60
//   edge cache HIT          0 of 60     60 of 60   (on the second pass; the first fills the cache)
//   TTFB p50                 673 ms        80 ms
//   TTFB p90               1,356 ms       136 ms
//   TTFB max               2,387 ms       196 ms
//
// ⚠️ THE FIRST PASS AFTER A DEPLOY READS 0 of 60 HIT AND THAT IS CORRECT, not a regression: the
// cache is per-symbol and fills on first request. Measure twice, or the number means nothing.
//
// The ticker row is why dd09c1d7 exists. The rooms between / and /ticker are the same gap the
// homepage had before 541b81a8 — their TITLES already target the nonbranded queries ("Insider
// Trading Tracker · SEC Form 4 Buys and Sells", "Congress Stock Trades · STOCK Act Disclosures")
// and the page a crawler reads contains the column headers with nothing under them.
//
//   node scripts/measure-crawl-surface.mjs                     # production
//   node scripts/measure-crawl-surface.mjs --base http://127.0.0.1:3310
//   node scripts/measure-crawl-surface.mjs --tickers 40        # also sample the sitemap
// ─────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argOf = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const BASE = argOf('--base', 'https://www.catalystpit.com').replace(/\/$/, '');
const TICKER_SAMPLE = Number(argOf('--tickers', 0));

// The agents that matter, and why each one is here rather than a longer list: two search engines
// that send traffic, four AI fetchers that quote us, Apple because Siri and Spotlight read it, and
// a real browser as the control. If any of these disagrees with the control about what is on the
// page, that is the finding.
const AGENTS = {
  Googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  Bingbot: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'OAI-SearchBot': 'Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)',
  GPTBot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot',
  PerplexityBot: 'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
  ClaudeBot: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  Applebot: 'Mozilla/5.0 (compatible; Applebot/0.1; +http://www.apple.com/go/applebot)',
  Chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

const ROOMS = ['/', '/insiders', '/politicians', '/news', '/scan', '/markets', '/consensus',
  '/institutions', '/screener', '/heatmap', '/dividends', '/fear-greed'];

/** The readable body a crawler sees with no JavaScript — scripts and styles are not content. */
const readable = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&[a-z]+;|&#\d+;/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const uniq = (html, re) => new Set([...html.matchAll(re)].map((m) => m[1])).size;

async function look(path, agent = AGENTS.Googlebot) {
  const t0 = Date.now();
  let r;
  try { r = await fetch(BASE + path, { headers: { 'user-agent': agent }, redirect: 'manual' }); }
  catch (e) { return { path, error: String(e.message || e).slice(0, 60) }; }
  const html = await r.text();
  const body = readable(html);
  const meta = (name) => (html.match(new RegExp(`<meta name="${name}" content="([^"]*)"`, 'i')) || [])[1] || '';
  return {
    path,
    status: r.status,
    ms: Date.now() - t0,
    bytes: html.length,
    // ⚠️ THE TWO HEADERS THAT DECIDE WHETHER A CRAWL COSTS US A RENDER. no-store means every fetch
    // of this URL, by anyone, reaches the origin — and tells every intermediary not to keep it.
    noStore: /no-store/.test(r.headers.get('cache-control') || ''),
    sMaxAge: ((r.headers.get('cache-control') || '').match(/s-maxage=(\d+)/) || [])[1] || null,
    edge: r.headers.get('x-vercel-cache') || r.headers.get('x-nextjs-cache') || '-',
    prerendered: !!r.headers.get('x-nextjs-prerender'),
    words: body.split(' ').filter(Boolean).length,
    tickerLinks: uniq(html, /href="(\/ticker\/[^"#?]+)"/g),
    internalLinks: uniq(html, /href="(\/[^"#?]*)"/g),
    // A machine-readable instant beside the words. "2h ago" is unreadable to anything quoting the
    // page later, which is most of what an AI fetcher does with it.
    times: (html.match(/<time[\s>]/gi) || []).length,
    tables: (html.match(/<tbody/gi) || []).length,
    h1: (html.match(/<h1[\s>]/gi) || []).length,
    jsonLd: (html.match(/application\/ld\+json/gi) || []).length,
    noindex: /name="robots" content="[^"]*noindex/i.test(html),
    title: (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '',
    description: meta('description'),
    canonical: (html.match(/<link rel="canonical" href="([^"]*)"/i) || [])[1] || '',
  };
}

const n = (v, w) => String(v).padStart(w);

console.log(`\n${BASE}   ${new Date().toISOString()}\n`);
console.log('── the indexable rooms, as Googlebot, no JavaScript ──');
console.log('route            code   ms  words  tkLinks  links  <time>  tbody  h1  ld  cache     cacheable  noindex');
const rooms = [];
for (const p of ROOMS) {
  const r = await look(p);
  rooms.push(r);
  if (r.error) { console.log(`${p.padEnd(16)} ERROR ${r.error}`); continue; }
  console.log(
    `${r.path.padEnd(16)}${n(r.status, 4)}${n(r.ms, 5)}${n(r.words, 7)}${n(r.tickerLinks, 9)}`
    + `${n(r.internalLinks, 7)}${n(r.times, 8)}${n(r.tables, 7)}${n(r.h1, 4)}${n(r.jsonLd, 4)}  `
    + `${r.edge.padEnd(9)} ${(r.noStore ? 'no-store' : r.sMaxAge ? `s-maxage=${r.sMaxAge}` : '-').padEnd(10)} ${r.noindex}`,
  );
}

// ⚠️ A ROOM WHOSE HEADINGS ARE PRESENT AND WHOSE ROWS ARE NOT is the specific failure this exists
// to name. It is invisible to anything that renders JavaScript, which is every tool a developer
// looks at the page with, and it is the only thing a crawler gets.
const empty = rooms.filter((r) => !r.error && !r.noindex && r.words < 400 && r.tables === 0 && r.tickerLinks === 0);
const uncached = rooms.filter((r) => !r.error && r.noStore);
console.log('\n── summary ──');
console.log(`  rooms measured                        ${rooms.filter((r) => !r.error).length}`);
console.log(`  indexable rooms with NO rows and NO ticker links  ${empty.length}  ${empty.map((r) => r.path).join(' ')}`);
console.log(`  rooms served no-store (origin render per request) ${uncached.length}  ${uncached.map((r) => r.path).join(' ') || '(none)'}`);
console.log(`  rooms missing a description             ${rooms.filter((r) => !r.error && !r.description).length}`);
console.log(`  rooms missing a canonical              ${rooms.filter((r) => !r.error && !r.canonical).length}`);
console.log(`  titles over 60 chars (truncated in SERPs) ${rooms.filter((r) => !r.error && r.title.length > 60).length}`);

// ── every permitted crawler must receive the same page ──────────────────────
// ⚠️ NOT A FORMALITY. A crawler-specific divergence is normally invisible: it needs the page fetched
// as each agent and the bodies compared, and nothing in a browser or a dashboard does that.
console.log('\n── the homepage, as each permitted agent ──');
console.log('agent             code   ms   words  tkLinks  <time>  cache');
const parity = [];
for (const [name, ua] of Object.entries(AGENTS)) {
  const r = await look('/', ua);
  parity.push([name, r]);
  if (r.error) { console.log(`${name.padEnd(16)} ERROR ${r.error}`); continue; }
  console.log(`${name.padEnd(16)}${n(r.status, 5)}${n(r.ms, 5)}${n(r.words, 8)}${n(r.tickerLinks, 9)}${n(r.times, 8)}  ${r.edge}`);
}
const control = parity.find(([k]) => k === 'Chrome')?.[1];
const odd = parity.filter(([, r]) => !r.error && control && !control.error
  && (r.status !== control.status || Math.abs(r.words - control.words) > 25));
console.log(`  agents disagreeing with the browser control: ${odd.length ? odd.map(([k]) => k).join(' ') : 'none'}`);

// ── a sample of the ticker universe ────────────────────────────────────────
if (TICKER_SAMPLE > 0) {
  console.log(`\n── ${TICKER_SAMPLE} ticker URLs, spread evenly through our own sitemap ──`);
  const sm = await fetch(BASE + '/sitemap.xml', { headers: { 'user-agent': AGENTS.Googlebot } });
  const xml = await sm.text();
  const all = [...xml.matchAll(/<loc>[^<]*\/ticker\/([^<]+)<\/loc>/g)].map((m) => m[1]);
  // Evenly spread, not the first N: the file is alphabetical, so the head is all A-names.
  const step = Math.max(1, Math.floor(all.length / TICKER_SAMPLE));
  const sample = Array.from({ length: TICKER_SAMPLE }, (_, i) => all[i * step]).filter(Boolean);
  const out = [];
  const queue = [...sample];
  // Four at a time. Before dd09c1d7 every one of these was an uncached origin render, so a wider
  // fan-out here was measuring our own database under load rather than the page.
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) out.push(await look('/ticker/' + queue.pop()));
  }));
  const good = out.filter((r) => !r.error);
  const ms = good.map((r) => r.ms).sort((a, b) => a - b);
  const words = good.map((r) => r.words).sort((a, b) => a - b);
  console.log(`  advertised ticker URLs in sitemap.xml  ${all.length}`);
  console.log(`  sampled                                ${good.length} (every ${step}th)`);
  console.log(`  TTFB ms            p50 ${ms[Math.floor(ms.length / 2)]}  p90 ${ms[Math.floor(ms.length * 0.9)]}  max ${ms[ms.length - 1]}`);
  console.log(`  words              min ${words[0]}  p50 ${words[Math.floor(words.length / 2)]}  max ${words[words.length - 1]}`);
  console.log(`  served no-store                        ${good.filter((r) => r.noStore).length} of ${good.length}`);
  console.log(`  edge/ISR cache HIT                     ${good.filter((r) => /HIT|STALE/.test(r.edge)).length} of ${good.length}`);
  console.log(`  noindex (we hold no identity)          ${good.filter((r) => r.noindex).length}`);
  console.log(`  under 100 readable words               ${good.filter((r) => r.words < 100).length}`
    + `  → ~${Math.round(all.length * good.filter((r) => r.words < 100).length / good.length)} of ${all.length}`);
  console.log(`  no <time> element                      ${good.filter((r) => r.times === 0).length} of ${good.length}`);
  const errs = out.filter((r) => r.error);
  if (errs.length) console.log(`  errors                                 ${errs.length}  ${errs.slice(0, 5).map((r) => r.path).join(' ')}`);
}

console.log('');
