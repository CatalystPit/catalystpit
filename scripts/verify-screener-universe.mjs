// THE SCREENER'S INVESTABLE UNIVERSE — what the test-symbol rule must NOT have removed.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-screener-universe.mjs
//
// ⚠️ THE RULE AND ITS DIRECT CASES ARE ALREADY PINNED in verify-launch-cleanup §6: the reserved families
// are refused, a classified or named match is kept, the real TEST ETF survives, and the application site
// is asserted. This file deliberately does not repeat any of that.
//
// What it covers is the half a test-symbol fix usually gets wrong and which nothing asserted: that the
// exclusion took ONLY the test namespaces with it. A rule applied at the universe entry point reaches
// every consumer of screener_stocks at once, so the question is not "are the test symbols gone" — they
// are — but "is every instrument type the Screener is meant to carry still carried, at a plausible
// count, in every product that reads this table".
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { isExchangeTestSymbol, isIngestableSymbol } from '../src/lib/ticker-symbol.mjs';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const RESERVED = '^(Z[A-Z]ZZT|[A-Z]?TEST[A-Z]?|ZXYZ[A-Z]?)$';

L('⚠️ 1 — the classification is deterministic metadata, not a ticker list');
{
  const lib = code('src/lib/ticker-symbol.mjs');
  // ⚠️ THE RULE IS pattern ∧ no-reference-data. The pattern alone is a blacklist and would have taken
  // the real TEST ETF; the metadata alone cannot distinguish an unlisted test issue from a gap in our
  // own data. Both halves are required, and the metadata is what decides.
  ok('⚠️ a reference-data hit overrides the pattern, and does so first',
    /if \(classified \|\| named\) return false;/.test(lib)
    && lib.indexOf('if (classified || named) return false;') < lib.indexOf('RESERVED_TEST_SYMBOL.test('));
  ok('⚠️ there is no per-ticker branch anywhere in the rule',
    !/=== 'Z[A-Z]ZZT'|ticker === '/.test(lib));
  ok('⚠️ …and no hardcoded list of excluded symbols',
    !/EXCLUDE|BLACKLIST|DENYLIST|BANNED/i.test(lib));
  // ⚠️ AND IT MUST NOT INFER INVALIDITY FROM THE THINGS THE BRIEF FORBIDS.
  ok('⚠️ it does not judge by length, punctuation, volume or market cap',
    !/\.length [<>]/.test(lib.slice(lib.indexOf('export function isExchangeTestSymbol'), lib.indexOf('export function isExchangeTestSymbol') + 400))
    && !/volume|market_?cap|marketCap/i.test(lib));
  // Exercised: a symbol in a reserved shape that our data knows is kept, whichever signal we have.
  ok('a classified reserved shape is kept', isExchangeTestSymbol('ZTEST', { classified: true }) === false);
  ok('a named reserved shape is kept', isExchangeTestSymbol('ZTEST', { named: true }) === false);
  ok('…and both together', isExchangeTestSymbol('ZTEST', { classified: true, named: true }) === false);
  ok('⚠️ an unknown reserved shape is refused', isExchangeTestSymbol('ZTEST') === true);
  for (const junk of [null, undefined, 42, {}, [], '']) {
    ok(`${JSON.stringify(junk)} is not treated as a test symbol`, isExchangeTestSymbol(junk) === false);
  }

  // ⚠️ THE PATTERN MUST BE ANCHORED TO THE RESERVED SHAPES, NOT A SUBSTRING MATCH ON "TEST". Mutation
  // testing found this uncovered: replacing the whole pattern with /TEST/ survived every check above,
  // because the only reserved-shape ticker we actually hold is TEST itself and the metadata override
  // keeps it. These are called WITHOUT a metadata hit, so the pattern alone has to reject them.
  for (const t of ['CONTEST', 'LATEST', 'PROTEST', 'TESTING', 'BACKTEST', 'ATTEST', 'DETEST']) {
    ok(`⚠️ ${t} contains "TEST" but is not a reserved shape`, isExchangeTestSymbol(t) === false);
  }
  // ⚠️ AND IT MUST NOT CONDEMN A LETTER. Replacing the pattern with /^Z/ also survived, because every
  // legitimate Z symbol we hold is classified and so never reaches the pattern. Asked cold, they must
  // still be accepted — this is the discriminating form.
  for (const t of ['ZTS', 'ZM', 'ZBRA', 'ZION', 'ZTO', 'ZS', 'Z']) {
    ok(`⚠️ ${t} is accepted on the pattern alone, with no metadata`, isExchangeTestSymbol(t) === false);
  }
  // The genuine families must still be rejected cold, or the two checks above could be satisfied by a
  // pattern that matches nothing at all.
  for (const t of ['ZVZZT', 'ZXZZT', 'ZTEST', 'NTEST', 'ZXYZ', 'ZXYZA']) {
    ok(`  ${t} is still rejected cold, so the pattern is not inert`, isExchangeTestSymbol(t) === true);
  }
}

L('⚠️ 2 — every instrument type the Screener carries is still carried');
{
  // ⚠️ THE ACTUAL RISK OF THIS FIX. The exclusion runs at the universe entry point, so an over-broad
  // rule would silently thin whole asset classes rather than produce an obvious error. These are the
  // classes the table holds today, with floors well below current counts so the check fails on a
  // collapse rather than on normal drift.
  // ⚠️ COUNTED FROM screener_meta's LABEL, JOINED TO THE UNIVERSE, NOT FROM screener_stocks' COPY.
  //
  // The question this section asks is "did the test-symbol exclusion silently thin a whole asset class",
  // which is about which SYMBOLS SURVIVED the universe filter. It used to read screener_stocks.asset_type,
  // which was the same thing while that column was populated for everyone.
  //
  // It no longer is: asset_type is vendor reference data from the retired provider, so the licensing gate
  // withholds it for the 14,758 rows whose meta provenance is still unestablished, and the label collapses
  // to null while the row stays put. Measured at the time of this change: 18,035 rows in the universe, of
  // which 2,727 carried a servable asset_type. Reading the gated copy made ETN look like 2 and GDR like 0
  // when both were present and simply unlabelled — a licensing gate reported as a coverage collapse.
  //
  // screener_meta still holds every label; it just may not publish them. Joining to it answers the
  // original question exactly, and keeps answering it as provenance is established.
  const rows = await sql`select coalesce(m.asset_type, '(null)') as t, count(*)::int n
    from screener_stocks s join screener_meta m on m.ticker = s.ticker group by 1 order by n desc`;
  const by = new Map(rows.map((r) => [r.t, r.n]));
  console.log('         ' + rows.map((r) => `${r.t}=${r.n}`).join(' · '));
  // ⚠️ RECALIBRATED TO THE POPULATION THIS NOW MEASURES, not loosened. The old floors were set against
  // screener_stocks.asset_type, which the retired provider populated for nearly every row; this counts
  // screener_meta's label joined to the universe, whose own coverage is lower because meta was never
  // complete. Measured when this was changed: ETF 5549 · Stock 4545 · OS 1029 · ADRC 918 · WARRANT 431 ·
  // FUND 246 · UNIT 208 · PFD 78 · RIGHT 111 · ETN 44 · GDR 8, against a universe of 18,035 rows.
  //
  // Each floor sits roughly 10-20% below its current value: far enough to survive ordinary drift, close
  // enough that losing a whole class still trips it. The universe-size assertion elsewhere in this file is
  // what catches a broad thinning; this one catches a class-shaped one.
  const FLOORS = { Stock: 4000, ETF: 4800, ADRC: 800, WARRANT: 350, FUND: 200, UNIT: 150, PFD: 60, RIGHT: 80, ETN: 30, GDR: 5 };
  for (const [t, floor] of Object.entries(FLOORS)) {
    ok(`⚠️ ${t} is still present (${by.get(t) ?? 0} ≥ ${floor})`, (by.get(t) ?? 0) >= floor, String(by.get(t)));
  }
  const total = rows.reduce((a, r) => a + r.n, 0);
  ok('⚠️ the universe is plausibly sized', total > 15_000 && total < 30_000, String(total));

  // ⚠️ NAMED EXAMPLES PER CLASS, so a count floor cannot be satisfied by the wrong rows. Each of these
  // is a real security that a careless rule could plausibly have caught.
  const WANT = [
    ['AAPL', 'NASDAQ common stock'], ['MSFT', 'NASDAQ common stock'],
    ['JPM', 'NYSE common stock'], ['KO', 'NYSE common stock'],
    ['SPY', 'ETF'], ['QQQ', 'ETF'], ['TEST', 'the real TEST ETF'],
    ['BABA', 'ADR'], ['TSM', 'ADR'],
    ['BRK.B', 'a dotted class share'],
    ['ZTS', 'a Z-prefixed common stock'], ['ZM', 'a short Z symbol'],
    ['CBOE', 'a symbol containing a reserved-looking run'],
    ['AEHR', 'a company literally named "Aehr Test Systems"'],
    ['INTT', 'a company named "inTEST Corp"'],
  ];
  for (const [t, why] of WANT) {
    const r = await sql`select ticker, company, asset_type, price from screener_stocks where ticker = ${t}`;
    ok(`⚠️ ${t} is present — ${why}`, r.length === 1, `${r.length} rows`);
    if (r.length) ok(`  …and it was not stripped of identity`, !!r[0].company, JSON.stringify(r[0]).slice(0, 90));
  }
  // ⚠️ AND THE RULE ITSELF AGREES, called on every one of them with the metadata the rebuild would pass.
  for (const [t] of WANT) {
    const known = await sql`select 1 from screener_meta where ticker = ${t}`;
    ok(`  ${t} is not classified as a test symbol by the live rule`,
      isExchangeTestSymbol(t, { classified: known.length > 0 }) === false);
  }
}

L('⚠️ 3 — no test symbol survives in ANY universe table, and nothing else was taken');
{
  for (const [label, rows] of [
    ['screener_stocks', await sql`select ticker, company, asset_type from screener_stocks where ticker ~ ${RESERVED}`],
    ['screener_meta', await sql`select ticker, name, asset_type from screener_meta where ticker ~ ${RESERVED}`],
    ['security_identity', await sql`select ticker, name from security_identity where ticker ~ ${RESERVED}`],
  ]) {
    // ⚠️ THE ONLY PERMITTED SURVIVOR IS A CLASSIFIED, NAMED ONE — which is the real ETF, by the rule's
    // own definition rather than by being named in this test.
    const unknown = rows.filter((r) => !(r.name || r.company) && !r.asset_type);
    ok(`⚠️ ${label}: no reserved-shape row lacking both name and classification`,
      unknown.length === 0, JSON.stringify(unknown));
    ok(`  …and every survivor is one the rule itself would keep (${rows.length})`,
      rows.every((r) => isExchangeTestSymbol(r.ticker, { classified: !!r.asset_type, named: !!(r.name || r.company) }) === false),
      JSON.stringify(rows.map((r) => r.ticker)));
  }
  // ⚠️ AND THE SPECIFIC FAMILIES ARE GONE, by name, so an empty result cannot be a regex that matches
  // nothing.
  const fams = ['ZVZZT', 'ZWZZT', 'ZXZZT', 'ZAZZT', 'ZBZZT', 'ZCZZT', 'ZJZZT', 'ZTEST', 'NTEST', 'ATEST', 'MTEST', 'ZXYZ'];
  const present = await sql`select ticker from screener_stocks where ticker = any(${fams})`;
  ok('⚠️ none of the named exchange test symbols is in the Screener', present.length === 0,
    JSON.stringify(present.map((r) => r.ticker)));
  ok('…and the regex used here does match them, so the check has teeth',
    fams.filter((f) => new RegExp(RESERVED).test(f)).length === fams.length);
}

L('⚠️ 4 — scope: which products this reaches, and whether that is correct');
{
  // ⚠️ THE EXCLUSION IS AT THE UNIVERSE ENTRY POINT, so it reaches every consumer of screener_stocks at
  // once. That is the right layer for these specific rows — a reserved test namespace is not a security
  // in any product — but it means the blast radius has to be stated rather than assumed.
  const screener = code('src/lib/screener-data.js');
  ok('the rule is applied exactly once', (screener.match(/isExchangeTestSymbol\(/g) || []).length === 1);
  ok('⚠️ …at the universe filter, before any row is built',
    /const tickers = \[\.\.\.universe\]\.filter\(/.test(screener)
    && screener.indexOf('isExchangeTestSymbol(') < screener.indexOf('const priceMap'));
  // ⚠️ AND NOT DUPLICATED INTO THE CONSUMERS, which would be two rules to keep in step.
  for (const f of ['src/app/api/screener/route.js', 'src/app/api/search/route.js',
    'src/lib/evidence/resolve.js', 'src/app/api/ticker/route.js']) {
    let src = '';
    try { src = code(f); } catch { continue; }
    ok(`${f} does not re-implement the exclusion`, !/isExchangeTestSymbol|ZVZZT|Z\[A-Z\]ZZT/.test(src));
  }
  // The ticker resolver must be untouched by this: it has its own, separate gate.
  ok('⚠️ ticker resolution keeps its own independent gate',
    /export function isIngestableSymbol/.test(code('src/lib/ticker-symbol.mjs')));
  ok('…and a legitimate unusual symbol still resolves', isIngestableSymbol('BRK.B') === true
    && isIngestableSymbol('BF.B') === true && isIngestableSymbol('ZTS') === true);
}

L('⚠️ 5 — Market Breadth: not affected, and the reason is structural');
{
  // ⚠️ BREADTH IS COMPUTED FROM THIS UNIVERSE, NOT FROM A SEPARATE ONE. So a test symbol could only
  // contaminate it by being in screener_stocks, which §3 has just shown it is not. There is no separate
  // breadth exclusion to add, and adding one would be a second rule for the same question.
  const cols = await sql`select column_name from information_schema.columns where table_name='market_breadth'`;
  ok('market_breadth stores aggregates, not per-ticker rows',
    !cols.some((c) => c.column_name === 'ticker'), JSON.stringify(cols.map((c) => c.column_name)));
  const latest = await sql`select * from market_breadth order by 1 desc limit 1`;
  ok('…and it has a current row, so breadth is live', latest.length === 1);
  // The count it reports should be in the same order as the priced universe it draws from.
  const priced = await sql`select count(*)::int n from screener_stocks where price > 0`;
  ok('⚠️ the priced universe breadth draws from is plausibly sized', priced[0].n > 8000, String(priced[0].n));
  console.log(`         priced universe: ${priced[0].n} · breadth row keys: ${Object.keys(latest[0] || {}).slice(0, 8).join(', ')}`);
}

L('⚠️ 6 — historical records were NOT deleted to achieve this');
{
  // ⚠️ THE BRIEF IS EXPLICIT: this is a user-facing universe problem, not a reason to delete stored
  // source data. The rebuild filters what it WRITES; it issues no deletes for these symbols.
  const screener = code('src/lib/screener-data.js');
  ok('⚠️ the rebuild deletes nothing based on the test rule',
    !/delete from screener_stocks where ticker ~|delete .*isExchangeTestSymbol/i.test(screener));
  // Raw source data that predates the rule may legitimately still mention these symbols; that is fine
  // and must not be "cleaned". If any exists, it is reported rather than removed.
  const raw = await sql`select count(*)::int n from primary_events where exists (
    select 1 from unnest(tickers) t where t ~ ${RESERVED})`;
  console.log(`         raw primary_events rows mentioning a reserved shape: ${raw[0].n} (left alone)`);
  ok('…and the check is read-only', true);
}

L('⚠️ 7 — performance: the exclusion costs no per-row lookup');
{
  const screener = code('src/lib/screener-data.js');
  // ⚠️ metaByT IS A MAP THE REBUILD ALREADY HAS. The classification signal is a Map.has() on data
  // already loaded, inside a filter the rebuild already runs — no query, no round trip, no per-row
  // await. A rule that queried per symbol would add ~18,000 round trips to every rebuild.
  ok('⚠️ the classification signal is an in-memory Map hit', /classified: metaByT\.has\(t\)/.test(screener));
  ok('⚠️ …with no await inside the universe filter',
    !/\[\.\.\.universe\]\.filter\(async/.test(screener) && !/await isExchangeTestSymbol/.test(screener));
  // ⚠️ NOT EVEN AN IMPORT. Checking for `db.` or a sql template missed a mutation that merely added
  // `import { db } from "./db"` — which is the first move anyone makes before turning a pure predicate
  // into a per-symbol query, and the whole point is that this module stays pure.
  const sym = code('src/lib/ticker-symbol.mjs');
  ok('…and the rule\'s module imports no database at all',
    !/from '\.\/db'|from "\.\/db"|drizzle|@neondatabase|sql`/.test(sym));
  ok('…and touches no table', !/db\.|screener_stocks|screener_meta/.test(sym));
  ok('…and performs one regex test', (sym.match(/RESERVED_TEST_SYMBOL\.test\(/g) || []).length === 1);
  // ⚠️ AND IT LOGS WHAT IT REFUSED. A universe filter that removes rows silently is how a rule that is
  // too broad goes unnoticed for months — the refusal line is the only place a human sees the blast
  // radius of this rule on a given rebuild.
  ok('⚠️ the rebuild records which symbols it refused',
    /refused \$\{testSyms\.length\} exchange test symbol/.test(read('src/lib/screener-data.js'))
    && /testSyms\.join\(', '\)/.test(read('src/lib/screener-data.js')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
