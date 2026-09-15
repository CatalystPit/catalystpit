// TMX Newsfile: two views of one wire.
//
// The two feeds republish the same releases, and their GUIDs DISAGREE on the same story —
// SyndiGate emits `/release/314360`, Last25Stories emits `/release/314360/<slug>`. A pipeline that
// dedupes on the feed's own identifier would therefore publish both. This suite proves the canonical
// engine collapses them anyway, and that the symbols Newsfile states do not put a Frankfurt or
// Canadian listing on the tape as a Catalyst Pit ticker.
//
// Run: node scripts/verify-newsfile.mjs            (live fetch)
//      node scripts/verify-newsfile.mjs --offline  (cached bytes in .tmp, no network)

import { readFile } from 'node:fs/promises';
import { runAdapter } from '../src/lib/news-adapters.mjs';
import { FEEDS, TIER, normalize, contentHash } from '../src/lib/primary-sources.mjs';
import { statedTickersIn, statedUsTickersIn } from '../src/lib/news-normalize.mjs';
import { sourceGroupOf } from '../src/lib/wire-sources.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log('\n' + s);

const feeds = FEEDS.filter((f) => f.source === 'NEWSFILE');

// ── 1. registry ─────────────────────────────────────────────────────────────
section('1. registry entries');
ok('both feeds registered', feeds.length === 2, 'found ' + feeds.length);
for (const f of feeds) {
  ok(`${f.key}: FAST cadence`, f.everySec === TIER.FAST, String(f.everySec));
  ok(`${f.key}: not FLASH`, f.everySec !== TIER.FLASH);
  ok(`${f.key}: press_release`, f.type === 'press_release');
  ok(`${f.key}: tickerable`, f.tickerable === true);
  ok(`${f.key}: US tickers only`, f.usTickersOnly === true);
  ok(`${f.key}: rss adapter`, (f.adapter || 'rss') === 'rss');
  ok(`${f.key}: https newsfilecorp url`, /^https:\/\/feeds\.newsfilecorp\.com\//.test(f.url), f.url);
}
ok('one shared source code', new Set(feeds.map((f) => f.source)).size === 1);
ok('distinct feed keys', new Set(feeds.map((f) => f.key)).size === 2);
ok('NEWSFILE groups with the PR wires', sourceGroupOf('NEWSFILE') === 'pr');
ok('only SyndiGate opts into symbol categories',
  feeds.filter((f) => f.symbolCategories).length === 1
  && feeds.find((f) => f.symbolCategories)?.key === 'newsfile_syndigate');

// ── 2. the US-only stated-ticker reader ─────────────────────────────────────
section('2. a foreign listing never becomes a Catalyst Pit ticker');
const REAL_LINE = 'LaFleur Minerals Inc. (CSE: LFLR) (OTCQB: LFLRF) (FSE: 3WK0) announces a board change';
// The default reader takes the OTCQB listing — a real US symbol, but not one our screener, ticker
// page or chart carries, so the cashtag would lead nowhere. (The Frankfurt symbol "3WK0" is refused
// by both readers for a different reason: it starts with a digit and fails the shape rule.)
ok('default reader would have taken the OTC listing',
  statedTickersIn(REAL_LINE).includes('LFLRF'), JSON.stringify(statedTickersIn(REAL_LINE)));
ok('US reader takes nothing from it', statedUsTickersIn(REAL_LINE).length === 0,
  JSON.stringify(statedUsTickersIn(REAL_LINE)));
for (const [line, want] of [
  ['HIVE Digital Technologies Ltd. (NASDAQ: HIVE) (TSX: HIVE) reports', ['HIVE']],
  ['Acme Corp (NYSE: ACME) and Beta Inc (TSX-V: BETA) sign an agreement', ['ACME']],
  ['Gamma Ltd (NYSE American: GAM) closes financing', ['GAM']],
  ['Delta (FSE: 3D0A) (CNSX: DLT) (OTCQX: DLTAF) updates', []],
  ['Epsilon Corp (ISIN: CA50684B1031) reports', []],
]) ok(`"${line.slice(0, 44)}…" -> ${JSON.stringify(want)}`,
  JSON.stringify(statedUsTickersIn(line)) === JSON.stringify(want),
  JSON.stringify(statedUsTickersIn(line)));

// ── 3. live (or cached) feed bytes ──────────────────────────────────────────
const offline = process.argv.includes('--offline');
const bodies = new Map();
section('3. fetching both feeds');
for (const f of feeds) {
  let body = null;
  if (offline) {
    const name = f.key === 'newsfile_syndigate' ? 'SyndiGate' : 'Last25Stories';
    try { body = await readFile(new URL(`../.tmp/${name}.xml`, import.meta.url), 'utf8'); } catch { /* none */ }
  } else {
    try {
      const r = await fetch(f.url, { headers: { 'User-Agent': 'CatalystPit contact@catalystpit.com' } });
      if (r.ok) body = await r.text();
      ok(`${f.key}: HTTP 200`, r.ok, 'HTTP ' + r.status);
    } catch (e) { ok(`${f.key}: fetch`, false, e.message); }
  }
  if (body) bodies.set(f.key, body);
  ok(`${f.key}: body received`, !!body && body.length > 500, body ? body.length + ' bytes' : 'none');
  ok(`${f.key}: is RSS`, !!body && /<rss[\s>]/i.test(body));
}

// ── 4. parsing ──────────────────────────────────────────────────────────────
section('4. parsing');
const parsed = new Map();
for (const f of feeds) {
  const body = bodies.get(f.key);
  if (!body) continue;
  const items = runAdapter(body, f);
  parsed.set(f.key, items);
  console.log('  ' + f.key.padEnd(22) + items.length + ' items');
  ok(`${f.key}: items parsed`, items.length > 0);
  ok(`${f.key}: every item has a headline`, items.every((i) => i.title && i.title.length > 5));
  ok(`${f.key}: every item has a newsfilecorp URL`,
    items.every((i) => /^https:\/\/www\.newsfilecorp\.com\/release\//.test(i.url)),
    items.find((i) => !/newsfilecorp\.com\/release\//.test(i.url))?.url);
  ok(`${f.key}: every item has a parsed timestamp`, items.every((i) => i.publishedAt),
    String(items.filter((i) => !i.publishedAt).length) + ' missing');
  ok(`${f.key}: timestamps are sane ISO instants`, items.every((i) => {
    const t = Date.parse(i.publishedAt);
    return Number.isFinite(t) && t > Date.parse('2020-01-01') && t < Date.now() + 2 * 86400000;
  }), items[0]?.publishedAt);
  ok(`${f.key}: summaries are not the headline repeated`,
    items.every((i) => i.summary === null || i.summary !== i.title));
  ok(`${f.key}: no HTML survives into the headline`, items.every((i) => !/[<>]/.test(i.title)));
}

// ── 5. structured symbols ───────────────────────────────────────────────────
section('5. <category domain="…/stocksymbol"> handling');
{
  const syn = parsed.get('newsfile_syndigate') || [];
  const withSyms = syn.filter((i) => i.tickers.length);
  console.log('  SyndiGate items carrying a US symbol: ' + withSyms.length + ' of ' + syn.length);
  for (const i of withSyms.slice(0, 5)) console.log('    ' + JSON.stringify(i.tickers).padEnd(12) + i.title.slice(0, 62));
  ok('every extracted symbol is ticker-shaped',
    syn.every((i) => i.tickers.every((t) => /^[A-Z][A-Z0-9.\-]{0,6}$/.test(t))),
    JSON.stringify(syn.flatMap((i) => i.tickers)));
  ok('no ISIN leaked through as a ticker',
    !syn.some((i) => i.tickers.some((t) => /^(CA|US)\d/.test(t) || t.length > 7)),
    JSON.stringify(syn.flatMap((i) => i.tickers)));
  // The feed states CNSX/TSX/TSX-V/FSE/OTC listings on most releases; none may survive.
  const body = bodies.get('newsfile_syndigate') || '';
  const foreign = [...body.matchAll(/stocksymbol[^>]*>\s*(?:CNSX|TSX|TSX-V|FSE|OTCQB|OTCQX|OTC PINK|ISIN)\s*:\s*([A-Z0-9.]+)/gi)]
    .map((m) => m[1].toUpperCase());
  ok('the feed does state foreign/OTC listings', foreign.length > 0, String(foreign.length));
  // A dual listing is not a leak: HIVE is stated as both NASDAQ:HIVE and TSX:HIVE, and it is the
  // NASDAQ line that earns it. Only a symbol stated EXCLUSIVELY on venues we do not carry counts.
  const usStated = new Set([...body.matchAll(/stocksymbol[^>]*>\s*(?:NASDAQ|NYSE[^:]*|AMEX|CBOE)\s*:\s*([A-Z0-9.]+)/gi)]
    .map((m) => m[1].toUpperCase()));
  const taken = new Set(syn.flatMap((i) => i.tickers));
  const leaked = foreign.filter((s) => taken.has(s) && !usStated.has(s));
  ok('no symbol stated only on a foreign/OTC venue was taken',
    leaked.length === 0, JSON.stringify(leaked.slice(0, 8)));
  ok('a dual US listing IS taken', [...taken].every((t) => usStated.has(t)), JSON.stringify([...taken]));
  // Last25Stories states no symbols at all, so it must contribute none structurally.
  const l25 = parsed.get('newsfile_last25') || [];
  ok('Last25Stories opts out of category symbols', !feeds.find((f) => f.key === 'newsfile_last25').symbolCategories);
  console.log('  Last25Stories items carrying a symbol: ' + l25.filter((i) => i.tickers.length).length + ' of ' + l25.length);
}

// ── 6. cross-feed dedupe ────────────────────────────────────────────────────
section('6. ONE canonical event per release');
{
  const syn = parsed.get('newsfile_syndigate') || [];
  const l25 = parsed.get('newsfile_last25') || [];
  const relId = (u) => (String(u).match(/\/release\/(\d+)/) || [])[1];
  const synIds = new Set(syn.map((i) => relId(i.url)).filter(Boolean));
  const shared = l25.map((i) => relId(i.url)).filter((id) => id && synIds.has(id));
  console.log('  releases in both feeds right now: ' + shared.length);
  ok('the feeds do overlap', shared.length > 0, 'if 0, the two feeds momentarily disagree — rerun');

  // The GUIDs disagree, which is exactly why guid-keyed dedupe is not enough.
  const synByRel = new Map(syn.map((i) => [relId(i.url), i]));
  const l25ByRel = new Map(l25.map((i) => [relId(i.url), i]));
  let guidDiff = 0;
  for (const id of shared) if (synByRel.get(id).uid !== l25ByRel.get(id).uid) guidDiff++;
  ok('their feed identifiers disagree on the same release', guidDiff > 0,
    'guidDiff=' + guidDiff + ' — the dedupe below is what protects us');

  // content_hash is what the UNIQUE index keys on: sha256(source | normalised headline | day).
  const fSyn = feeds.find((f) => f.key === 'newsfile_syndigate');
  const fL25 = feeds.find((f) => f.key === 'newsfile_last25');
  let collapsed = 0, distinctHashes = new Set();
  for (const id of shared) {
    const a = normalize(fSyn, synByRel.get(id));
    const b = normalize(fL25, l25ByRel.get(id));
    const ha = contentHash({ source: a.source, title: a.source_headline, publishedAt: a.published_at });
    const hb = contentHash({ source: b.source, title: b.source_headline, publishedAt: b.published_at });
    distinctHashes.add(ha); distinctHashes.add(hb);
    if (ha === hb) collapsed++;
  }
  ok('every shared release collapses to one content_hash', collapsed === shared.length,
    collapsed + ' of ' + shared.length);
  ok('no extra hashes were produced', distinctHashes.size === shared.length,
    distinctHashes.size + ' hashes for ' + shared.length + ' releases');

  // Idempotence: parsing the same bytes twice must produce identical identity.
  const again = runAdapter(bodies.get('newsfile_syndigate'), fSyn);
  ok('re-parsing the same bytes is identical',
    JSON.stringify(again.map((i) => [i.title, i.url, i.publishedAt, i.tickers]))
    === JSON.stringify(syn.map((i) => [i.title, i.url, i.publishedAt, i.tickers])));
}

// ── 7. normalisation shape ──────────────────────────────────────────────────
section('7. normalised events');
{
  const f = feeds.find((x) => x.key === 'newsfile_syndigate');
  const items = parsed.get('newsfile_syndigate') || [];
  for (const it of items.slice(0, 3)) {
    const e = normalize(f, it);
    ok('source is NEWSFILE', e.source === 'NEWSFILE');
    ok('source_type is press_release', e.source_type === 'press_release');
    ok('original_url preserved', e.original_url === it.url);
    ok('source_headline preserved verbatim', e.source_headline === it.title);
    ok('published_at preserved', e.published_at === it.publishedAt);
    ok('tickers are US-shaped or empty',
      e.tickers.every((t) => /^[A-Z][A-Z0-9.\-]{0,6}$/.test(t)), JSON.stringify(e.tickers));
    ok('norm_hash present', !!e.norm_hash);
  }
}

// ── 8. no other feed was disturbed ──────────────────────────────────────────
section('8. existing feeds unaffected');
{
  const others = FEEDS.filter((f) => f.source !== 'NEWSFILE');
  ok('no other feed opts into US-only tickers', others.every((f) => !f.usTickersOnly));
  ok('no other feed opts into symbol categories', others.every((f) => !f.symbolCategories));
  ok('the permissive reader is unchanged for them',
    statedTickersIn('Acme (TSX: ACME) reports').includes('ACME'));
  ok('feed keys remain unique across the registry',
    new Set(FEEDS.map((f) => f.key)).size === FEEDS.length);
  console.log('  registry now holds ' + FEEDS.length + ' feeds across '
    + new Set(FEEDS.map((f) => f.source)).size + ' sources');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
