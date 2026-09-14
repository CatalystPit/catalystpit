// Unit verification for the pure modules of the external-news engine: adapters, clustering and the
// headline validation gate. No DB, no network, no API key required.
//
// Run: node scripts/verify-news-engine.mjs

import { runAdapter, statedTickers, parseDate, pick } from '../src/lib/news-adapters.mjs';
import { canonicalUrl, eventKey, actionClass, findCluster, jaccard, shingles } from '../src/lib/event-cluster.mjs';
import { validateHeadline, validateFacts } from '../src/lib/headline-writer.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; } else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log(`\n=== ${s} ===`);

// ── adapters ─────────────────────────────────────────────────────────────────
section('ADAPTERS — one item shape from any wire format');

const RSS = `<rss><channel>
  <item><title>Acme Corp wins approval</title><link>https://ex.com/a?utm_source=x</link>
        <guid>g1</guid><pubDate>Tue, 08 Sep 2026 14:00:00 GMT</pubDate>
        <description>Acme Corp received clearance today.</description></item>
  <item><title>No link here</title><guid>g2</guid></item>
</channel></rss>`;
const rssItems = runAdapter(RSS, { adapter: 'rss', url: 'https://ex.com/feed.xml' });
ok('rss parses valid item', rssItems.length === 1, `got ${rssItems.length}`);
ok('rss drops item without link', !rssItems.some((i) => i.title === 'No link here'));
ok('rss keeps summary', rssItems[0]?.summary?.includes('clearance'));

const JSONFEED = JSON.stringify({
  data: { articles: [
    { headline: 'Beta Inc raises guidance', link: '/news/1', id: 'b1',
      published_utc: 1757340000, description: 'Beta Inc raised guidance.',
      // 'junk!' and the over-long token must be dropped; 'x' must survive — X is US Steel, and
      // one-letter tickers are real (F, T, C). Dropping them would lose legitimate symbols.
      symbols: ['BETA', 'junk!', 'x', 'WAYTOOLONGSYMBOL'] },
    { headline: 'No url', id: 'b2' },
  ] },
});
const jsonFeed = { adapter: 'json', url: 'https://api.ex.com/v1/news',
  map: { items: 'data.articles', title: 'headline', url: 'link', uid: 'id',
         publishedAt: 'published_utc', summary: 'description', tickers: 'symbols' } };
const jsonItems = runAdapter(JSONFEED, jsonFeed);
ok('json parses valid item', jsonItems.length === 1, `got ${jsonItems.length}`);
ok('json resolves relative url', jsonItems[0]?.url === 'https://api.ex.com/news/1', jsonItems[0]?.url);
ok('json parses epoch seconds', jsonItems[0]?.publishedAt === '2025-09-08T14:00:00.000Z', jsonItems[0]?.publishedAt);
ok('json keeps only symbol-shaped tickers', JSON.stringify(jsonItems[0]?.tickers) === '["BETA","X"]', JSON.stringify(jsonItems[0]?.tickers));
ok('rss and json produce identical keys',
  JSON.stringify(Object.keys(rssItems[0]).sort()) === JSON.stringify(Object.keys(jsonItems[0]).sort()));

ok('malformed json yields no items, no throw', runAdapter('{not json', jsonFeed).length === 0);
ok('empty body yields no items', runAdapter('', { adapter: 'rss', url: 'https://e.com' }).length === 0);
ok('unknown adapter yields no items', runAdapter(RSS, { adapter: 'nope', url: 'https://e.com' }).length === 0);
ok('pick handles missing path', pick({ a: 1 }, 'b.c.d') === undefined);
ok('parseDate rejects 1899', parseDate('Sat, 30 Dec 1899 15:00:00 GMT') === null);
ok('parseDate rejects far future', parseDate('2099-01-01') === null);
ok('statedTickers reads object form', JSON.stringify(statedTickers([{ symbol: 'aapl' }])) === '["AAPL"]');
ok('statedTickers reads csv form', JSON.stringify(statedTickers('AAPL, MSFT')) === '["AAPL","MSFT"]');

// ── clustering ───────────────────────────────────────────────────────────────
section('CLUSTERING — collapse the same event, never merge different ones');

ok('canonicalUrl strips utm', canonicalUrl('https://www.ex.com/a/?utm_source=t&id=5') === 'https://ex.com/a?id=5',
  canonicalUrl('https://www.ex.com/a/?utm_source=t&id=5'));
ok('canonicalUrl strips www + trailing slash + hash',
  canonicalUrl('http://www.ex.com/b/#top') === 'https://ex.com/b');
ok('canonicalUrl on junk returns empty', canonicalUrl('not a url') === '');

// A wire release that carries its own id IS that id. GlobeNewswire publishes one announcement in
// several languages under the SAME id; that shipped as two live Pit Wire rows for release 3361074,
// "Jyske Realkredit opens new fixed rate bonds" and "...convertible bonds".
const JY_EN = 'https://www.globenewswire.com/news-release/2026/09/14/3361074/0/en/jyske-realkredit-to-open-new-fixed-rate-bonds.html';
const JY_DA = 'https://www.globenewswire.com/news-release/2026/09/14/3361074/0/da/jyske-realkredit-abner-nye-obligationer.html';
ok('canonicalUrl reduces a wire release to its id', canonicalUrl(JY_EN) === 'https://globenewswire.com/news-release/3361074', canonicalUrl(JY_EN));
ok('two language editions of one release share a canonical url', canonicalUrl(JY_EN) === canonicalUrl(JY_DA));
ok('different releases keep different canonical urls',
  canonicalUrl(JY_EN) !== canonicalUrl(JY_EN.replace('3361074', '3361075')));
ok('an ordinary article url is untouched by the release rule',
  canonicalUrl('https://www.ex.com/news-release/some-story') === 'https://ex.com/news-release/some-story');

// The display-headline layer: two events that would PRINT the same words are one event. This is
// what catches four language editions that each got their own release id and were then all
// rewritten into the same English sentence.
const at = '2026-09-14T12:00:00Z';
const dh = (seq, display_hash, extra = {}) => ({ seq, display_hash, published_at: at, headline: 'x', ...extra });
ok('identical display headlines collapse',
  findCluster({ display_hash: 'pan global wins bid salamon gold project rights spain', published_at: at, headline: 'x' },
    [dh(1, 'pan global wins bid salamon gold project rights spain')])?.tier === 'display_hash');
ok('different display headlines do not collapse',
  findCluster({ display_hash: 'acme raises guidance', published_at: at, headline: 'x' },
    [dh(1, 'beta cuts guidance')]) === null);
ok('the 36h gate still applies to display headlines — a recurring notice stays separate',
  findCluster({ display_hash: 'federal reserve issues fomc statement', published_at: '2026-09-14T12:00:00Z', headline: 'x' },
    [dh(1, 'federal reserve issues fomc statement', { published_at: '2026-07-30T12:00:00Z' })]) === null);

// ── relay layers ────────────────────────────────────────────────────────────
// A wire re-sending one upstream story with the wording evolving. Four canonical rows for a single
// CNBC piece reached production; their pairwise shingle scores were 0.32, 0.49 and 0.19 against a
// 0.60 bar, so similarity could never have caught them and lowering that bar is not the answer.
const rel = (min) => new Date(Date.parse('2026-09-14T13:00:00Z') + min * 60000).toISOString();
const msft = (o) => ({ tickers: ['MSFT'], entity: 'MSFT', fact_sig: '', summary: '', ...o });
const msftHead = { seq: 1, cluster_id: null, canonical_url: 'https://x/1', ...msft({
  headline: 'MSFT: Microsoft sets limits for future AI models - CNBC $MSFT',
  source_headline: 'Microsoft sets limits for future AI models - CNBC $MSFT|FJ', published_at: rel(0) }) };

ok('a longer re-send of the same line merges (containment)',
  findCluster(msft({ original_url: 'https://x/2', published_at: rel(5),
    headline: 'MSFT: Microsoft sets limits for future AI models as industry throttles frontier development - CNBC $MSFT',
    source_headline: 'x - CNBC|FJ' }), [msftHead])?.tier === 'containment');
ok('a paraphrase of the same story merges (cited outlet)',
  findCluster(msft({ original_url: 'https://x/3', published_at: rel(1),
    headline: 'MSFT: Microsoft issues code of conduct to restrict AI models - CNBC $MSFT',
    source_headline: 'Microsoft issues code of conduct to restrict AI models - CNBC $MSFT|FJ' }), [msftHead])?.tier === 'relay_outlet');
ok('a relay with no ticker resolved still merges on containment',
  findCluster(msft({ original_url: 'https://x/4', published_at: rel(2), tickers: [], entity: 'microsoft-sets',
    headline: 'Microsoft Sets Limits for Future AI Models: Cnbc',
    source_headline: '*MICROSOFT SETS LIMITS FOR FUTURE AI MODELS: CNBC (@WalterBloomberg)' }), [msftHead])?.tier === 'containment');

// The guards. Each of these merged during development and each must not.
ok('TWO DIFFERENT announcements, same company, same outlet, same minute stay separate',
  findCluster(msft({ original_url: 'https://x/9', published_at: rel(1),
    headline: 'Microsoft raises quarterly dividend by 10% - CNBC $MSFT',
    source_headline: 'Microsoft raises quarterly dividend by 10% - CNBC $MSFT|FJ' }),
    [{ seq: 2, cluster_id: null, canonical_url: 'https://x/8', ...msft({
      headline: 'Microsoft names new CFO effective October - CNBC $MSFT',
      source_headline: 'Microsoft names new CFO effective October - CNBC $MSFT|FJ', published_at: rel(0) }) }]) === null);
ok('same outlet but a different company stays separate',
  findCluster(msft({ original_url: 'https://x/10', published_at: rel(1), tickers: ['AAPL'], entity: 'AAPL',
    headline: 'Apple sets limits for future AI models - CNBC $AAPL', source_headline: 'Apple - CNBC' }), [msftHead]) === null);
ok('containment three hours apart stays separate — recurring notices are real events',
  findCluster(msft({ original_url: 'https://x/11', published_at: rel(180),
    headline: 'MSFT: Microsoft sets limits for future AI models - CNBC $MSFT', source_headline: 'x' }),
    [{ ...msftHead, headline: 'MSFT: Microsoft sets limits for future AI models as industry throttles frontier development - CNBC $MSFT' }]) === null);
ok('containment with conflicting figures stays separate',
  findCluster(msft({ original_url: 'https://x/12', published_at: rel(2), fact_sig: '750000000',
    headline: 'Microsoft announces buyback program', source_headline: 'z' }),
    [{ seq: 3, cluster_id: null, canonical_url: 'https://x/7', ...msft({ fact_sig: '500000000',
      headline: 'Microsoft announces buyback program worth billions', source_headline: 'z', published_at: rel(0) }) }]) === null);
ok('a stub under the four-word floor cannot swallow a longer headline',
  findCluster(msft({ original_url: 'https://x/13', published_at: rel(1),
    headline: 'Microsoft update', source_headline: 'q' }), [msftHead]) === null);

ok('actionClass finds merger', actionClass('Acme to buy Beta') === 'merger');
ok('actionClass finds approval', actionClass('FDA approves drug') === 'approval');
ok('actionClass unknown → null', actionClass('weather is nice today') === null);

const k1 = eventKey({ tickers: ['ACME'], headline: 'Acme acquires Beta', publishedAt: '2026-09-08T10:00:00Z' });
const k2 = eventKey({ tickers: ['ACME'], headline: 'Acme to buy Beta in deal', publishedAt: '2026-09-08T18:00:00Z' });
ok('eventKey agrees across phrasings', k1 && k1 === k2, `${k1} vs ${k2}`);
ok('eventKey null without ticker', eventKey({ tickers: [], headline: 'Acme acquires Beta', publishedAt: '2026-09-08T10:00:00Z' }) === null);
ok('eventKey null without action', eventKey({ tickers: ['ACME'], headline: 'Acme weather update', publishedAt: '2026-09-08' }) === null);

const base = [{ seq: 10, cluster_id: null, event_key: k1, headline: 'Acme acquires Beta for $1B',
                summary: 'Acme Corp will acquire Beta Inc for one billion dollars', tickers: ['ACME'],
                canonical_url: 'https://a.com/1' }];

ok('tier1 url match', findCluster({ original_url: 'https://a.com/1?utm_source=z', tickers: [], headline: 'x' }, base)?.tier === 'url');
ok('tier2 event_key match',
  findCluster({ original_url: 'https://b.com/9', event_key: k2, tickers: ['ACME'], headline: 'Acme to buy Beta' }, base)?.tier === 'event_key');
const sim = findCluster({ original_url: 'https://c.com/3', event_key: null, tickers: ['ACME'],
  headline: 'Acme acquires Beta for $1B', summary: 'Acme Corp will acquire Beta Inc for one billion dollars' }, base);
ok('tier3 similarity match', sim?.tier === 'similarity', JSON.stringify(sim));
ok('different event does NOT merge',
  findCluster({ original_url: 'https://d.com/4', event_key: null, tickers: ['ACME'],
    headline: 'Acme names new chief financial officer', summary: 'Leadership change announced' }, base) === null);
ok('same words but no shared ticker does NOT merge',
  findCluster({ original_url: 'https://e.com/5', event_key: null, tickers: ['ZZZZ'],
    headline: 'Acme acquires Beta for $1B', summary: 'Acme Corp will acquire Beta Inc for one billion dollars' }, base) === null);
ok('cluster points at head not member',
  findCluster({ original_url: 'https://a.com/1', tickers: [], headline: 'x' },
    [{ seq: 11, cluster_id: 10, canonical_url: 'https://a.com/1', tickers: [] }])?.match.cluster_id === 10);
ok('jaccard identical = 1', Math.abs(jaccard(shingles('hello world'), shingles('hello world')) - 1) < 1e-9);
ok('jaccard disjoint = 0', jaccard(shingles('aaaa'), shingles('zzzz')) === 0);

// ── headline gate ────────────────────────────────────────────────────────────
section('HEADLINE GATE — fail closed on anything untraceable');

const SRC = 'HEADLINE: FDA approves Acme Corp therapy\nThe FDA approved a therapy from Acme Corp on September 8, generating $1.2B in expected sales.';

ok('accepts grounded restatement',
  validateHeadline('Acme Corp therapy wins FDA approval', SRC, []).ok);
ok('rejects fabricated number',
  validateHeadline('Acme Corp therapy approved, $9.9B expected', SRC, []).reason === 'number');
ok('accepts number present in source',
  validateHeadline('Acme Corp wins approval, $1.2B expected', SRC, []).ok);
ok('rejects fabricated name',
  validateHeadline('Acme Corp and Zorin Labs win approval', SRC, []).reason === 'name');
ok('rejects hype verb',
  validateHeadline('Acme Corp stock soars on FDA approval', SRC, []).reason === 'hype');
ok('rejects verbatim copy',
  validateHeadline('FDA approves Acme Corp therapy', SRC, []).reason === 'verbatim_copy');
ok('rejects overlong', validateHeadline('Acme Corp '.repeat(20), SRC, []).reason === 'too_long');
ok('rejects empty', validateHeadline('', SRC, []).reason === 'empty');
ok('rejects unresolved ticker', validateHeadline('$ACME therapy wins approval', SRC, []).reason === 'unresolved_ticker');
ok('accepts resolved ticker', validateHeadline('$ACME therapy wins approval', SRC, ['ACME']).ok);

const facts = validateFacts({ actor: 'Acme Corp', action: 'approved', object: 'therapy',
  value: '$1.2B', effective_date: 'September 8' }, SRC);
ok('facts keep grounded actor', facts.actor === 'Acme Corp');
ok('facts keep grounded value', facts.value === '$1.2B');
const bad = validateFacts({ actor: 'Zorin Labs', action: 'approved', object: null, value: '$9.9B', effective_date: null }, SRC);
ok('facts null out fabricated actor', bad.actor === null, JSON.stringify(bad));
ok('facts null out fabricated value', bad.value === null, JSON.stringify(bad));
ok('facts on null input → null', validateFacts(null, SRC) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
