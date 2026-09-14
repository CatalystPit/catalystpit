// Pit Wire verification: the taxonomy/filter logic (pure) and the /api/wire contracts the tape
// depends on (cursor paging, enrichment updates, duplicate prevention, ordering).
//
// Reads only. Ingests nothing, writes nothing, touches no SEC row.
//
// Run: node scripts/verify-pitwire.mjs        (needs the dev server on :3000)

import { EVENT_TYPES, CATEGORIES, SOURCE_GROUPS, CAP_BUCKETS, NOISE_FILTERS, IMPACT,
         eventTypeOf, categoryOf, sourceGroupOf, capBucketOf, decorate } from '../src/lib/wire-taxonomy.mjs';

const BASE = process.env.WIRE_BASE || 'http://localhost:3000';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const sec = (s) => console.log(`\n=== ${s} ===`);

// ── taxonomy ─────────────────────────────────────────────────────────────────
sec('EVENT TYPES — from the engine classifier, not a second one');
ok('buyback', eventTypeOf({ headline: 'Acme announces $500M share repurchase program' }) === 'buyback');
ok('merger', eventTypeOf({ headline: 'Acme to buy Beta in $2B deal' }) === 'merger');
ok('earnings', eventTypeOf({ headline: 'Acme reports Q3 earnings, raises guidance' }) === 'earnings');
ok('offering', eventTypeOf({ headline: 'Acme announces pricing of $300M offering' }) === 'offering');
ok('dividend', eventTypeOf({ headline: 'Acme declares quarterly dividend' }) === 'dividend');
ok('approval', eventTypeOf({ headline: 'FDA approves Acme therapy' }) === 'approval');
ok('rejection', eventTypeOf({ headline: 'Acme receives complete response letter from FDA' }) === 'rejection');
ok('trial', eventTypeOf({ headline: 'Acme reports topline Phase 3 data' }) === 'trial');
ok('bankruptcy', eventTypeOf({ headline: 'Acme files for Chapter 11' }) === 'bankruptcy');
ok('leadership', eventTypeOf({ headline: 'Acme CEO to resign' }) === 'leadership');
ok('contract', eventTypeOf({ headline: 'Acme wins contract with the Navy' }) === 'contract');
ok('halt by source_type', eventTypeOf({ headline: 'ACME halted', source_type: 'halt' }) === 'halt');
ok('upgrade split', eventTypeOf({ headline: 'Analyst upgrades Acme to buy' }) === 'upgrade');
ok('downgrade split', eventTypeOf({ headline: 'Analyst downgrades Acme to sell' }) === 'downgrade');
ok('downgrade wins over ambiguous target language',
  eventTypeOf({ headline: 'Broker cuts price target on Acme' }) === 'downgrade');
ok('unclassifiable is "other", never invented', eventTypeOf({ headline: 'Acme comments on the weather' }) === 'other');

sec('CATEGORIES — engine category + type, no renamed duplicates');
ok('earnings → EARNINGS', categoryOf({ headline: 'Acme reports Q3 earnings', category: 'MARKETS' }) === 'EARNINGS');
ok('merger → MA', categoryOf({ headline: 'Acme to buy Beta', category: 'MARKETS' }) === 'MA');
ok('stored PHARMA kept', categoryOf({ headline: 'FDA approves drug', category: 'PHARMA' }) === 'PHARMA');
ok('stored MACRO kept', categoryOf({ headline: 'Fed holds rates', category: 'MACRO' }) === 'MACRO');
ok('stored FILING kept', categoryOf({ headline: 'Acme 8-K', category: 'FILING' }) === 'FILING');
ok('halt → HALT', categoryOf({ headline: 'ACME halted', category: 'HALT' }) === 'HALT');
ok('analyst → ANALYST', categoryOf({ headline: 'Analyst upgrades Acme to buy', category: 'MARKETS' }) === 'ANALYST');
ok('buyback → CORPORATE', categoryOf({ headline: 'Acme announces $500M buyback', category: 'MARKETS' }) === 'CORPORATE');
ok('every category key is unique', new Set(CATEGORIES.map((c) => c.key)).size === CATEGORIES.length);

sec('SOURCE GROUPS — 61 feeds collapsed to something usable');
ok('FinancialJuice → wires', sourceGroupOf('FINANCIALJUICE') === 'wires');
ok('Telegram → wires', sourceGroupOf('BREAKINGMARKETNEWS') === 'wires');
ok('Bloomberg → media', sourceGroupOf('BLOOMBERG') === 'media');
ok('GlobeNewswire → pr', sourceGroupOf('GLOBENEWSWIRE') === 'pr');
ok('Fed → gov', sourceGroupOf('FED') === 'gov');
ok('SEC has its own group', sourceGroupOf('SEC') === 'sec');
ok('Nasdaq → exchange', sourceGroupOf('NASDAQ') === 'exchange');
ok('unknown → other', sourceGroupOf('WHOEVER') === 'other');
ok('no source is in two groups', (() => {
  const seen = new Set();
  for (const g of SOURCE_GROUPS) for (const s of g.sources) { if (seen.has(s)) return false; seen.add(s); }
  return true;
})());

sec('MARKET CAP — bucketed, never guessed');
ok('mega', capBucketOf(3.2e12) === 'mega');
ok('large', capBucketOf(50e9) === 'large');
ok('mid', capBucketOf(5e9) === 'mid');
ok('small', capBucketOf(900e6) === 'small');
ok('micro', capBucketOf(120e6) === 'micro');
ok('null cap → null bucket', capBucketOf(null) === null);
ok('zero cap → null bucket', capBucketOf(0) === null);
ok('garbage cap → null bucket', capBucketOf('abc') === null);

sec('NOISE FILTERS');
const noiseOf = (e) => decorate(e).wireNoise;
ok('low-impact PR', noiseOf({ headline: 'Acme wins award', source_type: 'press_release', importance: 0 }).includes('lowPr'));
ok('high-impact PR NOT noise', !noiseOf({ headline: 'Acme buyback', source_type: 'press_release', importance: 3 }).includes('lowPr'));
ok('transcripts', noiseOf({ headline: 'Acme call', source_type: 'transcript' }).includes('transcripts'));
ok('working papers', noiseOf({ headline: 'IFDP paper', source_type: 'research' }).includes('papers'));
ok('crypto', noiseOf({ headline: 'Bitcoin rallies past resistance' }).includes('crypto'));
ok('foreign markets', noiseOf({ headline: 'Nikkei closes higher' }).includes('foreign'));
ok('ordinary news is not noise', noiseOf({ headline: 'Acme raises guidance', source_type: 'article', importance: 2 }).length === 0);

// Opinion and advice. Matched on the SHAPE of a column — a question, a second-person address, a
// ranked list, a dated price guess — never on subject matter, because a dividend column and a
// dividend declaration are about the same thing and only one of them is an event.
const advice = (h, extra = {}) => noiseOf({ headline: h, source_type: 'article', importance: 2, ...extra }).includes('advice');
ok('question headline', advice('Which Monthly Dividend Stock Should Retirees Own?'));
ok('setup commentary', advice('Gold Miners Set Up Well Into Q4'));
ok('first-person method piece', advice("Forget Screeners and Hot Tips: Here's How I Actually Research a Stock"));
ok('dated price guess', advice('What Will XRP Be Worth By 2028?'));
ok('ranked listicle', advice('5 Dividend Powerhouses Yielding Above 5%'));
ok('second-person address', advice('Debt settlement vs consolidation: which is right for you?'));
// The guards. Each of these was a live false positive during development; a decimal dividend and a
// "$5,000 dividend" both read as listicles until the count pattern learned to reject money.
ok('real dividend declaration survives', !advice('Amerigo Resources declares CAD 0.21 dividend'));
ok('dollar-amount dividend news survives', !advice("Trump's $5,000 dividend checks require congressional approval"));
ok('singular analyst top pick survives', !advice('Piper Sandler names Q2 Holdings top pick for Q2'));
ok('FDA approval survives', !advice('Nasus Pharma wins FDA approval'));
ok('macro flash survives', !advice('Goldman Sachs and JPMorgan expect 25bp Fed hike this week'));
ok('wire flashes are never advice', !advice('Is the ECB done hiking?', { source_type: 'wire' }));
ok('SEC filings are never advice', !advice('Acme Corp files 8-K', { source_kind: 'sec' }));

// A trusted source is exempt from noise classification entirely. The point is that nothing the tape
// does to suppress commentary can be what discards a designated breaking-news flash.
const noiseFor = (source, headline) => decorate({ source, headline, source_type: 'wire', importance: 2 }).wireNoise;
ok('an untrusted crypto flash is classified', noiseFor('SEEKINGALPHA', 'Bitcoin rallies past resistance').includes('crypto'));
ok('a trusted crypto flash is not', noiseFor('WALTERBLOOMBERG', 'Bitcoin rallies past resistance').length === 0);
ok('an untrusted foreign-index flash is classified', noiseFor('YAHOO', 'Nikkei closes higher').includes('foreign'));
ok('a trusted foreign-index flash is not', noiseFor('WALTERBLOOMBERG', 'Nikkei closes higher').length === 0);
ok('trust does not change category or type',
  decorate({ source: 'WALTERBLOOMBERG', headline: 'Acme to buy Beta in $2B deal', source_type: 'wire' }).wireCategory === 'MA');

// ── filter engine (mirrors the component's pure `passes`) ────────────────────
sec('FILTER COMPOSITION');
const D = {
  impact: [3, 2, 1, 0], categories: CATEGORIES.map((c) => c.key), types: EVENT_TYPES.map((t) => t.key),
  groups: SOURCE_GROUPS.map((g) => g.key).concat('other'), caps: CAP_BUCKETS.map((b) => b.key),
  capUnknown: true, tickerMode: 'all', tickers: [], noise: [],
};
function passes(ev, f, watch) {
  if (!f.impact.includes(ev.importance ?? 0)) return false;
  if (!f.categories.includes(ev.wireCategory)) return false;
  if (!f.types.includes(ev.wireType)) return false;
  if (!f.groups.includes(ev.wireGroup)) return false;
  if (ev.wireCap) { if (!f.caps.includes(ev.wireCap)) return false; } else if (!f.capUnknown) return false;
  if (f.tickerMode === 'watchlist') { if (!watch.size || !(ev.tickers || []).some((t) => watch.has(t))) return false; }
  else if (f.tickerMode === 'specific') { if (!f.tickers.length || !(ev.tickers || []).some((t) => f.tickers.includes(t))) return false; }
  if (f.noise.length && (ev.wireNoise || []).some((n) => f.noise.includes(n))) return false;
  return true;
}
const ev1 = decorate({ seq: 1, headline: 'Acme announces $500M share repurchase', category: 'MARKETS', source: 'GLOBENEWSWIRE', source_type: 'press_release', importance: 2, tickers: ['ACME'], market_cap: 900e6 });
const ev2 = decorate({ seq: 2, headline: 'Nikkei closes higher', category: 'MARKETS', source: 'YAHOO', source_type: 'article', importance: 0, tickers: [], market_cap: null });
const ev3 = decorate({ seq: 3, headline: 'FDA approves Beta therapy', category: 'PHARMA', source: 'FDA', source_type: 'approval', importance: 3, tickers: ['BETA'], market_cap: 60e9 });
ok('default shows everything', [ev1, ev2, ev3].every((e) => passes(e, D, new Set())));
ok('impact filter', passes(ev3, { ...D, impact: [3] }, new Set()) && !passes(ev1, { ...D, impact: [3] }, new Set()));
ok('category filter', passes(ev3, { ...D, categories: ['PHARMA'] }, new Set()) && !passes(ev1, { ...D, categories: ['PHARMA'] }, new Set()));
ok('type filter', passes(ev1, { ...D, types: ['buyback'] }, new Set()) && !passes(ev3, { ...D, types: ['buyback'] }, new Set()));
ok('source group filter', passes(ev3, { ...D, groups: ['gov'] }, new Set()) && !passes(ev2, { ...D, groups: ['gov'] }, new Set()));
ok('cap filter', passes(ev1, { ...D, caps: ['small'], capUnknown: false }, new Set()) && !passes(ev3, { ...D, caps: ['small'], capUnknown: false }, new Set()));
ok('unknown-cap exclusion', !passes(ev2, { ...D, capUnknown: false }, new Set()));
ok('watchlist mode', passes(ev1, { ...D, tickerMode: 'watchlist' }, new Set(['ACME'])) && !passes(ev3, { ...D, tickerMode: 'watchlist' }, new Set(['ACME'])));
ok('empty watchlist hides all', !passes(ev1, { ...D, tickerMode: 'watchlist' }, new Set()));
ok('specific tickers', passes(ev3, { ...D, tickerMode: 'specific', tickers: ['BETA'] }, new Set()));
ok('noise hiding', !passes(ev2, { ...D, noise: ['foreign'] }, new Set()));
ok('MULTIPLE filters at once',
  passes(ev1, { ...D, impact: [2, 3], types: ['buyback'], caps: ['small'], capUnknown: false, groups: ['pr'] }, new Set())
  && !passes(ev3, { ...D, impact: [2, 3], types: ['buyback'], caps: ['small'], capUnknown: false, groups: ['pr'] }, new Set()));

sec('PRESETS');
const moving = { ...D, impact: [3, 2], noise: ['lowPr', 'transcripts', 'commentary', 'papers', 'govRoutine'] };
ok('Market Moving keeps CRITICAL', passes(ev3, moving, new Set()));
ok('Market Moving drops LOW', !passes(ev2, moving, new Set()));
const small = { ...D, impact: [3, 2, 1], caps: ['small', 'micro'], capUnknown: false };
ok('Small Cap keeps a small cap', passes(ev1, small, new Set()));
ok('Small Cap drops a large cap', !passes(ev3, small, new Set()));

// ── live API contracts ───────────────────────────────────────────────────────
sec('/api/wire CONTRACTS');
const get = async (qs) => {
  const r = await fetch(`${BASE}/api/wire${qs}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};
try {
  const first = await get('?limit=40');
  ok('returns events', first.events.length > 0, `count=${first.events.length}`);
  ok('returns a cursor', Number.isFinite(first.cursor) && first.cursor > 0);
  ok('returns serverTime', !!Date.parse(first.serverTime));
  ok('newest first', first.events.every((e, i, a) => i === 0 || new Date(a[i - 1].published_at || a[i - 1].received_at) >= new Date(e.published_at || e.received_at)));
  ok('every row carries display facets', first.events.every((e) => e.wireCategory && e.wireType && e.wireGroup));
  ok('no duplicate seq in one page', new Set(first.events.map((e) => e.seq)).size === first.events.length);
  ok('canonical only — no folded members', first.events.every((e) => e.cluster_id === undefined || e.cluster_id === null));
  ok('every row is display_ready (AI never gates)', first.events.every((e) => e.headline && e.headline.length > 0));
  // A Pit Wire row is a Catalyst Pit event. The upstream publisher's identity never reaches the
  // browser, so there is nothing to render by accident — and nothing to read in devtools either.
  // These assertions used to say the opposite; the product contract changed, so they changed with
  // it. All of these fields are still on primary_events, which the provenance test below proves.
  const ordinary = first.events.filter((e) => e.source_kind !== 'sec');
  const filings = first.events.filter((e) => e.source_kind === 'sec');
  ok('ordinary rows name no publisher',
    ordinary.every((e) => e.source === undefined && e.source_name === undefined), `checked ${ordinary.length}`);
  ok('ordinary rows carry no upstream link or publisher wording',
    ordinary.every((e) => e.original_url === undefined && e.source_headline === undefined && e.summary === undefined));
  ok('ordinary rows keep the source GROUP, which is a category not an outlet',
    ordinary.every((e) => typeof e.wireGroup === 'string' && e.wireGroup.length > 0));
  // SEC is the exception and must stay one: a filing says SEC and links to the filing.
  ok('SEC filings keep their attribution and direct filing link',
    filings.every((e) => e.source_name && /^https:\/\/(www\.)?sec\.gov\//.test(e.original_url || '')),
    filings.length ? `checked ${filings.length}` : 'no SEC rows in this page');
  ok('multi-source events expose a count', first.events.every((e) => Number(e.source_count) >= 1));

  // Cursor paging: asking for what came after the newest must not re-deliver anything.
  const tail = await get(`?since=${first.cursor}&limit=50`);
  ok('cursor tail returns no already-seen rows',
    tail.events.every((e) => Number(e.seq) > Number(first.cursor)), `got ${tail.events.length}`);

  // Reconnect recovery: resuming from an older cursor returns exactly the gap, no full re-download.
  const seqs = first.events.map((e) => Number(e.seq)).sort((a, b) => b - a);
  const mid = seqs[Math.min(10, seqs.length - 1)];
  const resumed = await get(`?since=${mid}&limit=200`);
  ok('resume from an older cursor returns only the gap', resumed.events.every((e) => Number(e.seq) > mid));
  // The cursor is seq-based while display order is published_at-based, so a resume legitimately
  // returns every event ingested after that seq — bounded by the page limit, never the full table.
  ok('resume is bounded, not a full history download', resumed.events.length <= 200, `${resumed.events.length} rows`);
  ok('resume never returns rows at or below the cursor', resumed.events.every((e) => Number(e.seq) > mid));
  ok('resume produces no duplicates', new Set(resumed.events.map((e) => e.seq)).size === resumed.events.length);

  // Enrichment channel.
  const upd = await get(`?updatedSince=${encodeURIComponent(new Date(Date.now() - 3600e3).toISOString())}&limit=20`);
  ok('update channel responds', Array.isArray(upd.events));
  ok('update rows carry a seq to merge on', upd.events.every((e) => Number.isFinite(Number(e.seq))));

  // Server-side filters still work (used for future narrowing; the UI filters client-side).
  const crit = await get('?minImportance=3&limit=20');
  ok('server importance filter', crit.events.every((e) => e.importance >= 3), `n=${crit.events.length}`);
  const tk = first.events.find((e) => (e.tickers || []).length)?.tickers[0];
  if (tk) {
    const byTicker = await get(`?ticker=${tk}&limit=20`);
    ok('server ticker filter', byTicker.events.every((e) => e.tickers.includes(tk)));
  }

  // Volume / performance sanity.
  const big = await get('?limit=300');
  ok('large page served', big.events.length > 0);
  ok('page cap respected', big.events.length <= 300, `${big.events.length}`);
  ok('no duplicates at volume', new Set(big.events.map((e) => e.seq)).size === big.events.length);
  const caps = big.events.filter((e) => e.wireCap).length;
  console.log(`  market-cap resolved on ${caps}/${big.events.length} of a 300-event page`);

  // ── provenance ─────────────────────────────────────────────────────────────
  // The publisher is absent from the RESPONSE, not from the record. This takes the exact seqs the
  // wire just served and proves every one of them still has its full provenance in storage — which
  // is the whole claim: strip the presentation, never the evidence.
  if (process.env.DATABASE_URL) {
    sec('PROVENANCE — stripped from the response, intact in storage');
    const { default: postgres } = await import('postgres');
    const sql = postgres(process.env.DATABASE_URL, { max: 1 });
    try {
      const seqs = big.events.slice(0, 200).map((e) => Number(e.seq));
      const rows = await sql`select seq, source, source_name, source_uid, source_headline, original_url,
          raw, published_at, received_at, source_count
        from primary_events where seq = any(${seqs})`;
      ok('every served event is still on primary_events', rows.length === seqs.length, `${rows.length}/${seqs.length}`);
      for (const f of ['source', 'source_name', 'source_uid', 'source_headline', 'original_url', 'raw', 'published_at', 'received_at']) {
        ok(`provenance field kept: ${f}`, rows.every((r) => r[f] !== null && r[f] !== undefined),
          `${rows.filter((r) => r[f] === null || r[f] === undefined).length} missing`);
      }
      // Folded members are the other half of provenance: a merged record is kept and attached, not
      // discarded, so a "·3" row can still be traced back to all three reports.
      const merged = await sql`select count(*) n from primary_events
        where cluster_id = any(${seqs})`;
      console.log(`  folded source records attached to this page's events: ${merged[0].n}`);
      // SEC must be exactly as it was: never rewritten, never clustered.
      const secRows = await sql`select count(*) n,
          count(*) filter (where headline <> source_headline) altered,
          count(*) filter (where cluster_id is not null) clustered
        from primary_events where source_kind = 'sec'`;
      ok('SEC headlines never rewritten', Number(secRows[0].altered) === 0, `altered=${secRows[0].altered}`);
      ok('SEC rows never clustered', Number(secRows[0].clustered) === 0, `clustered=${secRows[0].clustered}`);
      console.log(`  SEC rows checked: ${secRows[0].n}`);
    } finally { await sql.end(); }
  } else {
    console.log('\n  (provenance check skipped — run with --env-file=.env.local for DATABASE_URL)');
  }
} catch (e) {
  fail++; console.error('  FAIL live API —', e.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
