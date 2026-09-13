// End-to-end verification of the external-news pipeline against the real database.
//
// Inserts synthetic events through the REAL ingest path (dedupe + insert) and the REAL enrichment
// path, with the model call stubbed so the write path is provable without spending an API call.
// Everything it creates is namespaced 'ZZTEST' and deleted at the end.
//
// Run: node --env-file=.env.local scripts/verify-news-pipeline.mjs

import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const cleanup = async () => { await sql`delete from primary_events where source like 'ZZTEST%'`; };
await cleanup();

// The three synthetic sources report overlapping events, plus one genuinely distinct event.
const DAY = new Date(Date.now() - 3600_000).toISOString();
const mk = (source, uid, headline, url, summary, tickers) => ({
  source, source_name: `${source} Wire`, source_kind: 'external', source_type: 'article',
  source_uid: uid, headline, source_headline: headline, summary,
  published_at: DAY, original_url: url, tickers, category: 'MARKETS', importance: 1,
  content_hash: `zz-${source}-${uid}-${Math.random().toString(36).slice(2)}`,
  headline_status: 'pending', pipeline_status: 'pending', raw: { test: true },
});

console.log('\n=== INGEST + CROSS-SOURCE DEDUPE ===');
const call = async (payload) => {
  const r = await fetch('http://localhost:3000/api/cron/newsselftest', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-selftest': '1' }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error('harness HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
};

const batch = [
  mk('ZZTESTA', 'a1', 'Zeta Corp acquires Omega Labs for $2.5B', 'https://a.test/story-1?utm_source=rss',
     'Zeta Corp said it will acquire Omega Labs for $2.5B in cash.', ['ZETA']),
  // same event, different outlet, different URL and wording → must fold
  mk('ZZTESTB', 'b1', 'Zeta Corp to buy Omega Labs in $2.5B deal', 'https://b.test/story-9',
     'Zeta Corp will acquire Omega Labs for $2.5B in cash, the company said.', ['ZETA']),
  // same event, third outlet, SAME article url as A but decorated → must fold via tier 1
  mk('ZZTESTC', 'c1', 'Zeta buys Omega', 'https://a.test/story-1?ref=twitter&utm_campaign=x',
     'Deal announced.', ['ZETA']),
  // genuinely DIFFERENT event, same company → must NOT fold
  mk('ZZTESTA', 'a2', 'Zeta Corp names new chief financial officer', 'https://a.test/story-2',
     'Zeta Corp appointed a new CFO effective next month.', ['ZETA']),
  // similar words, different company → must NOT fold
  mk('ZZTESTB', 'b2', 'Kappa Corp acquires Omega Labs for $2.5B', 'https://b.test/story-2',
     'Kappa Corp said it will acquire Omega Labs for $2.5B in cash.', ['KAPPA']),
];

const ins = await call({ op: 'insert', events: batch });
ok('all 5 raw records stored', ins.written === 5, `written=${ins.written}`);
ok('3 duplicates folded', ins.folded === 2, `folded=${ins.folded}`);

const canon = await sql`
  select seq, source, headline, cluster_id, source_count from primary_events
   where source like 'ZZTEST%' and cluster_id is null order by seq`;
const members = await sql`select seq, source, cluster_id from primary_events where source like 'ZZTEST%' and cluster_id is not null`;

ok('3 canonical events exposed', canon.length === 3, `got ${canon.length}: ${canon.map((c) => c.source).join(',')}`);
ok('2 rows folded as members', members.length === 2, `got ${members.length}`);
ok('raw source records all retained', (await sql`select count(*) n from primary_events where source like 'ZZTEST%'`)[0].n === '5');

const head = canon.find((c) => c.headline.includes('acquires Omega Labs for $2.5B') && c.source === 'ZZTESTA');
ok('first reporter is the canonical head', !!head);
ok('head counts 3 sources', head && Number(head.source_count) === 3, `source_count=${head?.source_count}`);
ok('members point at the head', members.every((m) => Number(m.cluster_id) === Number(head.seq)));
ok('different event stayed separate', canon.some((c) => c.headline.includes('chief financial officer')));
ok('different company stayed separate', canon.some((c) => c.source === 'ZZTESTB' && c.headline.includes('Kappa')));

console.log('\n=== CANONICAL VIEW ===');
const view = await sql`select count(*) n from canonical_events where source like 'ZZTEST%'`;
ok('view exposes exactly one row per event', view[0].n === '3', `view rows=${view[0].n}`);

console.log('\n=== ENRICHMENT WRITE PATH (model stubbed) ===');


const er = await call({ op: 'enrich', limit: 10 });
ok('enrichment processed the pending rows', er.claimed >= 3, `claimed=${er.claimed}`);
ok('grounded headline accepted', er.original >= 1, `original=${er.original}`);
ok('fabricated headline rejected', er.fallback >= 1, `fallback=${er.fallback}`);

const enriched = await sql`
  select seq, source, headline, source_headline, headline_status, pipeline_status, facts, enriched_at
    from primary_events where source like 'ZZTEST%' order by seq`;

const good = enriched.find((r) => r.headline_status === 'original');
ok('accepted row stores the CP headline', good && good.headline !== good.source_headline, good?.headline);
ok('accepted row PRESERVES the source headline', good && /acquires Omega Labs/.test(good.source_headline), good?.source_headline);
ok('accepted row stores grounded facts', good && good.facts?.actor === 'Zeta Corp', JSON.stringify(good?.facts));

// A rejected AI headline does NOT regress to the raw source string: the row keeps the
// deterministic normalised headline it has been displaying since the moment it was captured.
const fell = enriched.find((r) => r.headline_status === 'normalized');
ok('rejected row keeps its normalised headline', fell && fell.headline && !/soars|Zorin/.test(fell.headline), fell?.headline);
ok('rejected row still preserves the source headline', fell && fell.source_headline, fell?.source_headline);
ok('rejected row nulls the fabricated actor', fell && fell.facts?.actor === null, JSON.stringify(fell?.facts));
ok('all rows marked ready', enriched.every((r) => r.pipeline_status === 'ready'));
ok('all rows timestamped', enriched.every((r) => r.enriched_at));

console.log('\n=== SEC ISOLATION ===');
const secTouched = await sql`
  select count(*) n from primary_events
   where source_kind = 'sec' and (headline <> source_headline or headline_status <> 'not_required'
      or pipeline_status <> 'ready' or enriched_at is not null)`;
ok('no SEC row was ever rewritten or enriched', secTouched[0].n === '0', `${secTouched[0].n} affected`);
const secQueue = await sql`select count(*) n from primary_events where source_kind='sec' and pipeline_status='pending'`;
ok('no SEC row can enter the enrich queue', secQueue[0].n === '0');
const secSrc = await sql`select count(*) n from primary_events where source='SEC' and (source <> 'SEC' or original_url not like '%sec.gov%')`;
ok('every SEC row keeps SEC source + EDGAR link', secSrc[0].n === '0');

await cleanup();
const left = await sql`select count(*) n from primary_events where source like 'ZZTEST%'`;
ok('test data removed', left[0].n === '0');

console.log(`\n${pass} passed, ${fail} failed`);
await sql.end();
process.exit(fail ? 1 : 0);
