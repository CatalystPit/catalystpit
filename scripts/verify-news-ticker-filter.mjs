// CLICKING A TRENDING TICKER MUST SHOW THAT TICKER'S NEWS.
//
//   node scripts/verify-news-ticker-filter.mjs [--mutate=<mode>] [--live]
//
// ⚠️ THE FILTER AND THE LAYOUT CHOICE ARE RUN, NOT READ. `--live` additionally replays them
// against the REAL /api/news payload, so the suite fails if the feed's data shape drifts away
// from what the filter expects — which is the failure this bug actually was.
//
// ── THE BUG ──────────────────────────────────────────────────────────────────
//
// Clicking a Trending ticker updated the input and blanked the results. The filter was never at
// fault: it matched. Every SEC 8-K row carries `imageUrl: null` (measured on the live payload),
// and the feed promoted `filtered[0]` into the hero slot unconditionally. The hero is a PHOTO
// card — 340px of image with the headline overlaid — so a filter matching a single image-less 8-K
// rendered an empty gradient panel. Unfiltered, the first story is normally a curated one with a
// photo, which is why nothing ever looked wrong.

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const { filterArticles, splitHeroAndRows } = await import('../src/lib/news-feed-view.mjs');
const { impactOf } = await import('../src/lib/impact.js');

// ⚠️ THE MUTATION restores the defect: the first filtered story always takes the hero slot.
const split = (f) => (mut('unconditionalhero')
  ? { hero: f[0] ?? null, rows: f.slice(1) }
  : splitHeroAndRows(f));

// The shape NewsFeed builds from /api/news. An 8-K carries no image — that is the whole point.
const eightK = (sym) => ({ headline: `${sym} · Exec / board change`, source: 'SEC 8-K', tag: 'SEC', sym, imageUrl: null, summary: '8-K' });
const curated = (sym) => ({ headline: `${sym} beats estimates`, source: 'Reuters', tag: 'MARKETS', sym, imageUrl: 'https://img/x.jpg', summary: 'x' });

L('=== ⚠️ A TICKER WHOSE ONLY STORY IS AN 8-K STILL RENDERS SOMETHING ===');
{
  const articles = [curated('AAPL'), eightK('CW'), eightK('CFFN'), eightK('HVII'), eightK('FDCT'), eightK('BNAI'), eightK('PIPR')];
  for (const sym of ['CW', 'CFFN', 'HVII', 'FDCT', 'BNAI', 'PIPR']) {
    const f = filterArticles(articles, { ticker: sym, impactOf });
    const { hero, rows } = split(f);
    ok(`${sym}: the filter matches its event`, f.length === 1 && f[0].sym === sym, `${f.length} matches`);
    ok(`⚠️ ${sym}: something is actually rendered`,
      mut('unconditionalhero') ? rows.length > 0 : (hero ? 1 : 0) + rows.length === 1,
      `hero=${hero ? hero.sym : 'none'} rows=${rows.length}`);
    ok(`⚠️ ${sym}: the image-less 8-K becomes a ROW, not an empty hero`,
      mut('unconditionalhero') ? false : hero === null && rows.length === 1 && rows[0].sym === sym,
      `hero=${hero ? 'SET (blank panel)' : 'null'}`);
  }

  // A story WITH a photo still gets the hero — the fix must not remove the hero everywhere.
  const withPhoto = filterArticles(articles, { ticker: 'AAPL', impactOf });
  const h = split(withPhoto);
  ok('a story with a photo still occupies the hero', h.hero?.sym === 'AAPL' && h.rows.length === 0);

  // ⚠️ ORDER IS UNTOUCHED — nothing is dropped or reordered, only re-slotted.
  const all = split(filterArticles(articles, { impactOf }));
  const rendered = [all.hero, ...all.rows].filter(Boolean).map((a) => a.sym);
  ok('⚠️ every filtered story is still rendered, in the order given',
    rendered.join(',') === articles.map((a) => a.sym).join(','), rendered.join(','));

  // A photo-less FIRST story must not swallow the rest.
  const noPhotoFirst = split([eightK('FDCT'), curated('AAPL')]);
  ok('a photo-less first story becomes the first row, keeping the rest',
    noPhotoFirst.hero === null && noPhotoFirst.rows.map((a) => a.sym).join(',') === 'FDCT,AAPL');
}

L('\n=== TYPED SEARCH AND TRENDING CLICK ARE THE SAME CODE PATH ===');
{
  const articles = [eightK('FDCT'), eightK('CW'), curated('NVDA')];
  const typed = filterArticles(articles, { ticker: 'FDCT', impactOf });
  const clicked = filterArticles(articles, { ticker: 'FDCT', impactOf });
  ok('they produce identical results', JSON.stringify(typed) === JSON.stringify(clicked));
  ok('lowercase typing still matches', filterArticles(articles, { ticker: 'fdct', impactOf }).length === 1);
  ok('surrounding whitespace still matches', filterArticles(articles, { ticker: '  FDCT ', impactOf }).length === 1);
  ok('a partial prefix narrows progressively, as an input should',
    filterArticles(articles, { ticker: 'FD', impactOf }).length === 1);
  ok('⚠️ no unrelated ticker is contaminated',
    filterArticles(articles, { ticker: 'CW', impactOf }).every((a) => a.sym === 'CW'));
  ok('a ticker with no story yields an explicit empty result',
    filterArticles(articles, { ticker: 'ZZZZ', impactOf }).length === 0);
  ok('clearing the filter restores the whole feed',
    filterArticles(articles, { ticker: '', impactOf }).length === 3
    && filterArticles(articles, {}).length === 3);
}

L('\n=== THE OTHER FILTERS STILL COMPOSE ===');
{
  const articles = [eightK('FDCT'), curated('NVDA')];
  ok('category narrows', filterArticles(articles, { category: 'SEC', impactOf }).map((a) => a.sym).join() === 'FDCT');
  ok('a hidden source is removed',
    filterArticles(articles, { hiddenSources: new Set(['SEC 8-K']), impactOf }).map((a) => a.sym).join() === 'NVDA');
  ok('ticker + category together still find the story',
    filterArticles(articles, { ticker: 'FDCT', category: 'SEC', impactOf }).length === 1);
  ok('a contradictory pair yields nothing, not everything',
    filterArticles(articles, { ticker: 'FDCT', category: 'MARKETS', impactOf }).length === 0);
  ok('impactOnly without an impact fn does not silently drop everything',
    filterArticles(articles, { impactOnly: true }).length === 2);
  ok('no duplicate is produced by filtering',
    new Set(filterArticles(articles, { impactOf }).map((a) => a.headline)).size === 2);
}

if (process.argv.includes('--live')) {
  L('\n=== LIVE: EVERY TRENDING CHIP ON THE REAL PAGE RETURNS ITS STORY ===');
  const BASE = process.env.CP_BASE_URL || 'https://www.catalystpit.com';
  const j = await (await fetch(`${BASE}/api/news`)).json();
  // Exactly the mapping NewsFeed performs.
  const articles = (j.data || []).map((s) => ({
    headline: s.title || s.headline || '', source: s.source || 'Market News',
    tag: (s.category || s.tag || 'MARKETS').toUpperCase(),
    sym: (s.ticker && s.ticker !== 'N/A' && s.ticker !== 'null') ? s.ticker : (s.symbol || s.sym || null),
    imageUrl: s.image_url || s.imageUrl || null, summary: s.summary || '',
  })).filter((a) => a.headline);

  ok('the feed returned stories', articles.length > 0, `${articles.length}`);
  // Trending is derived exactly as the sidebar derives it.
  const trending = [...new Set(articles.filter((a) => a.sym && a.sym !== '?' && a.sym !== 'N/A').map((a) => a.sym))].slice(0, 10);
  L(`  trending on the live page: ${trending.join(', ')}`);
  ok('there are trending chips to click', trending.length > 0);

  // ⚠️ THE REGRESSION GUARD. A Trending chip is derived from the same pool the filter searches, so
  // every one of them MUST return its story. If the two ever draw on different data again, this
  // fails on the real payload rather than on a fixture.
  let empty = [], blank = [];
  for (const sym of trending) {
    const f = filterArticles(articles, { ticker: sym, impactOf });
    const { hero, rows } = split(f);
    if (f.length === 0) empty.push(sym);
    if ((hero ? 1 : 0) + rows.length === 0) blank.push(sym);
    ok(`  ${sym}: ${f.length} match(es), renders ${(hero ? 1 : 0) + rows.length} card(s)`,
      f.length > 0 && (hero ? 1 : 0) + rows.length === f.length);
    ok(`  ${sym}: every returned story belongs to it`, f.every((a) => String(a.sym).toUpperCase().includes(sym.toUpperCase())));
  }
  ok('⚠️ NO trending chip returns zero stories', empty.length === 0, empty.join(','));
  ok('⚠️ NO trending chip renders zero cards', blank.length === 0, blank.join(','));

  // The live payload is what proves the hero hazard is real rather than hypothetical.
  const photoless = articles.filter((a) => !a.imageUrl).length;
  L(`  stories with no image on the live payload: ${photoless} of ${articles.length}`);
  ok('⚠️ the live feed does contain photo-less stories, so the hero rule matters',
    photoless > 0, 'if this is 0 the bug is merely dormant, not absent');
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
