// INSIDER / FORM 4 — end-to-end integrity, the invariants the audit actually found.
//
//   node --env-file=.env.local scripts/verify-insider-integrity.mjs
//
// ⚠️ WHAT THIS GUARDS. Two defects were found by auditing production and neither looked like broken
// code. Six consumers read insider rows without excluding filings the filer had retracted — so
// /api/insiders?view=top, which sorts by value descending, had a $258,827,700,000 purchase as its
// headline row, a price the filer had mistyped and corrected the same week. And the guard's own
// spelling turned out to matter: coalesce(superseded_by,'') = '' is opaque to the planner and made the
// main list query 14x slower, so the correctness fix carried a performance regression until the
// spelling changed. Both are the kind that produce a plausible page rather than an error.
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { classifyAction, validateRow, LIMITS } from '../src/lib/form4.mjs';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const one = async (q) => (await q)[0];

L('⚠️ only a real open-market trade becomes BUY or SELL');
{
  // ⚠️ AN AWARD IS NOT A PURCHASE. A, M, F, G, D, J, C, X are grants, option exercises, tax
  // withholding, gifts and conversions; calling any of them a buy would invent conviction that the
  // filing does not contain.
  ok('P is the only BUY', classifyAction('P') === 'BUY');
  ok('S is the only SELL', classifyAction('S') === 'SELL');
  for (const c of ['A', 'M', 'F', 'G', 'D', 'J', 'C', 'X', 'I', 'L', 'W', 'Z', 'U', 'O', 'E', 'H', 'K', 'V']) {
    if (classifyAction(c) !== 'OTHER') { ok(`code ${c} is not BUY/SELL`, false, classifyAction(c)); }
  }
  ok('every non-P/S code classifies as OTHER',
    ['A', 'M', 'F', 'G', 'D', 'J', 'C', 'X', 'I', 'L', 'W', 'Z', 'U', 'O', 'E', 'H', 'K', 'V'].every((c) => classifyAction(c) === 'OTHER'));
  // Production: the stored action must agree with the stored code, on every row.
  const bad = await one(sql`select count(*)::int n from insider_trades
    where (transaction_code = 'P' and action <> 'BUY')
       or (transaction_code = 'S' and action <> 'SELL')
       or (transaction_code not in ('P','S') and action <> 'OTHER')`);
  ok('⚠️ no stored row disagrees with the canonical classifier', bad.n === 0, `${bad.n} rows`);
}

L('⚠️ a value we do not have is not zero');
{
  // shares / price_per_share / total_value are NOT NULL columns, so an undisclosed price must land as
  // 0. That is only safe while every consumer treats 0 as unknown.
  const fmt = [
    ['insiders list', 'src/app/insiders/InsidersClient.jsx'],
    ['ticker page', 'src/app/ticker/[symbol]/TickerPage.jsx'],
  ];
  for (const [label, path] of fmt) {
    const src = read(path);
    const body = src.match(/const fmtMoney = \(n\) => \{[\s\S]*?\n\};/)?.[0] || '';
    ok(`⚠️ ${label} renders an unknown value as a dash, never $0`,
      /return '—'/.test(body) && /!v|!n/.test(body), body.slice(0, 90));
  }
  // Dollar aggregates must exclude what cannot be valued.
  ok('⚠️ the dollar aggregates filter on a value above zero',
    /total_value > 0/.test(read('src/app/api/insiders/route.js')));
  // ⚠️ AND THE PARSER KEEPS THE DISTINCTION THE COLUMN CANNOT. A filer who footnotes a price has not
  // said it is zero; a filer who writes <value>0</value> has. Only the second is a data error.
  const p = read('src/lib/form4.mjs');
  ok('⚠️ the parser separates a footnoted price from a disclosed zero',
    /const priceDisclosed = rawPrice != null && rawPrice !== '';/.test(p));
  ok('…and quarantines only the disclosed zero on an open-market code',
    /pricePerShare === 0 && row\.priceDisclosed/.test(p));
  // Production: every $0 open-market row must carry the footnote that explains it.
  const unexplained = await one(sql`select count(*)::int n from insider_trades
    where transaction_code in ('P','S') and shares > 0 and price_per_share = 0
      and (footnotes is null or btrim(footnotes) = '')`);
  ok('⚠️ no unexplained $0 open-market row is stored', unexplained.n === 0, `${unexplained.n} rows`);
  const neg = await one(sql`select count(*)::int n from insider_trades
    where shares < 0 or price_per_share < 0 or total_value < 0`);
  ok('nothing is negative', neg.n === 0, `${neg.n}`);
  // total_value must be derivable from its own parts.
  const incons = await one(sql`select count(*)::int n from insider_trades
    where abs(total_value - shares * price_per_share) > greatest(1, shares * price_per_share * 1e-6)`);
  ok('⚠️ total_value equals shares x price on every row', incons.n === 0, `${incons.n} rows`);
}

L('⚠️ one disclosed transaction is one row');
{
  const r = await one(sql`select count(*)::int rows,
    count(distinct (accession, transaction_date, transaction_code, security_title, shares, price_per_share, shares_owned_after))::int keys
    from insider_trades`);
  ok('no duplicate transactions', r.rows === r.keys, `${r.rows} rows / ${r.keys} keys`);
  // ⚠️ THE CONSTRAINT, NOT JUST TODAY'S DATA — and it must stay a MULTI-COLUMN key, because one
  // accession legitimately holds many lines. Deduping on accession alone would delete real
  // transactions; we hold accessions with up to 56 of them.
  const idx = await sql`select indexdef from pg_indexes where tablename='insider_trades' and indexdef ilike '%unique%'`;
  const uq = idx.find((i) => /\(accession,/.test(i.indexdef));
  ok('⚠️ …enforced by a unique index keyed on more than the accession', !!uq, JSON.stringify(idx.map((i) => i.indexname)));
  const multi = await one(sql`select count(*)::int n from (select accession from insider_trades group by accession having count(*) > 1) z`);
  ok('…and multi-transaction filings exist and are preserved', multi.n > 1000, `${multi.n}`);
}

L('⚠️ identity is the SEC identifier, never the name string');
{
  // Two different people share a name; one person is spelled several ways. Only owner_cik settles it.
  const pipeline = read('src/lib/insider/conviction-pipeline.mjs');
  ok('⚠️ the canonical cluster count is DISTINCT owner_cik', /COUNT\(DISTINCT x\.owner_cik\)/.test(pipeline));
  ok('…and insider_people is keyed on owner_cik', /insider_people \(owner_cik/.test(pipeline));
  ok('the ingest takes both CIKs from the filing, never infers them',
    /issuerCik = extractFormText\(xml, 'issuerCik'\)/.test(read('src/app/api/refresh/route.js')));
  // ⚠️ A JOINT FILING YIELDS NO owner_cik RATHER THAN THE WRONG ONE.
  ok('⚠️ a filing with several reporting owners stores no owner_cik',
    /new Set\(ownerCiks\)\.size === 1 \? ownerCiks\[0\] : null/.test(read('src/app/api/refresh/route.js')));
}

L('⚠️ a symbol that is not a symbol reaches neither the table nor the page');
{
  ok('the ingest gate is the shared one', /isIngestableTicker\(ticker\)/.test(read('src/app/api/refresh/route.js')));
  ok('…and it refuses rather than repairing', /IT REJECTS, IT DOES NOT REPAIR/.test(read('src/lib/security-identity.mjs')));
  ok('⚠️ the read has its own guard, because rows outlive the ingest gate',
    /TICKER_IS_A_SYMBOL/.test(read('src/app/api/insiders/route.js')));
  const arriving = await one(sql`select count(*)::int n from insider_trades
    where ticker !~ '^[A-Z][A-Z0-9.-]{0,9}$' and inserted_at > now() - interval '7 days'`);
  ok('⚠️ no unusable symbol has been ingested in the last 7 days', arriving.n === 0, `${arriving.n} rows`);
}

L('⚠️ two clocks: a transaction becomes public when it is FILED');
{
  const res = read('src/lib/evidence/resolve.js');
  ok('⚠️ insider evidence publishes on filing_date', /publicTime: newest\.filing_date/.test(res));
  ok('…and the transaction date is the event, not the disclosure', /eventTime: eventClock\(/.test(res));
  // ⚠️ AND A STORED DATE THAT BREAKS THE INVARIANT COSTS THE DATE, NOT THE EVIDENCE. Eleven rows
  // carry a transaction date later than their own filing date — the filer's error, faithfully
  // stored. Handing that over would quarantine the whole object and delete a real purchase.
  const facts = read('src/lib/evidence/insider-facts.mjs');
  ok('⚠️ eventClock returns null when the event postdates its disclosure', /e > p\) return null;/.test(facts));
  const model = read('src/lib/evidence/model.mjs');
  ok('⚠️ …and the model enforces publicTime >= eventTime independently',
    /reason: 'pit'/.test(model) && /evt > pub \+ FUTURE_TOLERANCE_MS/.test(model));
  ok('markers are placed on publicTime only', /publicTime ONLY\. Never eventTime/.test(read('src/lib/chart/evidence-markers.mjs')));
  ok('…and the card distinguishes Transacted from Filed',
    /Transacted /.test(read('src/components/chart/EvidenceCard.jsx')) && /Filed \{/.test(read('src/components/chart/EvidenceCard.jsx')));
  ok('alerts are selected by publicTime against a subscriber watermark',
    /changedSince/.test(read('src/lib/alerts/evidence-alerts.mjs')));
  const future = await one(sql`select count(*)::int n from insider_trades where filing_date > current_date`);
  ok('⚠️ nothing is filed in the future', future.n === 0, `${future.n}`);
}

L('⚠️ a filing the filer retracted reaches NO consumer');
{
  // ⚠️ TEN CONSUMERS, NOT FOUR. The lineage work guarded four; six more read transaction rows and
  // none of them filtered. /api/insiders was the worst: its `top` view sorts by value descending and
  // so led with MYNZ's mistyped $258,827,700,000 purchase, corrected by a 4/A to $1.03M.
  const CONSUMERS = [
    ['src/lib/ticker-seo.mjs', 2], ['src/lib/x-reply-context.mjs', 1],
    ['src/lib/consensus/board.mjs', 1], ['src/lib/consensus/setup-board.js', 1],
    ['src/app/api/insiders/route.js', 10], ['src/app/api/cron/insider-alerts/route.js', 1],
    ['src/app/api/cron/pit-snapshot/route.js', 2], ['src/app/api/watchlist/signals/route.js', 2],
    ['src/lib/confluence.js', 1], ['src/lib/screener-data.js', 1],
  ];
  for (const [file, n] of CONSUMERS) {
    const guards = (read(file).match(/superseded_by,\s*''\)\s*=\s*''|superseded_by IS NULL/gi) || []).length;
    ok(`${file} excludes retracted filings`, guards >= n, `${guards} guard(s), expected ${n}`);
  }
  ok('conviction refuses to score a retracted row', /if \(row\.superseded_by\) return false;/.test(read('src/lib/conviction.server.js')));

  // ⚠️ A GUARD COUNT CANNOT SEE A NEUTERED GUARD, and this assertion exists because the count above
  // missed exactly that. /api/insiders applies the predicate through a shared constant at six query
  // sites; replacing its body with `1 = 1` left all ten textual occurrences in place and the suite
  // passed. So the constant's DEFINITION is pinned, and its use counted separately.
  {
    const src = read('src/app/api/insiders/route.js');
    ok('⚠️ NOT_SUPERSEDED is defined as a real supersession predicate',
      /const NOT_SUPERSEDED = sql`insider_trades\.superseded_by IS NULL`;/.test(src),
      (src.match(/const NOT_SUPERSEDED = sql`[^`]*`/) || ['not found'])[0]);
    const uses = (src.match(/NOT_SUPERSEDED/g) || []).length - 1;   // minus the definition
    ok('⚠️ …and applied at every query site that reads insider rows', uses >= 6, `${uses} use(s)`);
  }

  // ⚠️ THE SPELLING IS PART OF THE INVARIANT. coalesce(superseded_by,'') = '' is opaque to the query
  // planner: combined with the ticker regex it abandoned the filing_date index for a parallel seq
  // scan and the main list query went from 50ms to 716ms at p50. superseded_by IS NULL is estimable,
  // and equivalent because nothing writes an empty string — asserted just below.
  const READ_PATHS = ['src/app/api/insiders/route.js', 'src/app/api/cron/insider-alerts/route.js',
    'src/app/api/cron/pit-snapshot/route.js', 'src/app/api/watchlist/signals/route.js',
    'src/lib/confluence.js', 'src/lib/screener-data.js'];
  const slow = READ_PATHS.filter((f) => /coalesce\([a-z_.]*superseded_by/i.test(read(f)));
  ok('⚠️ the hot read paths use the index-friendly spelling, not coalesce()', slow.length === 0, slow.join(', '));
  const empties = await one(sql`select count(*)::int n from insider_trades where superseded_by = ''`);
  ok('⚠️ …which is only equivalent because nothing writes an empty string', empties.n === 0, `${empties.n} rows`);

  // Production: the retracted row that was the headline number must not be the top open-market trade.
  const top = await one(sql`select ticker, total_value from insider_trades
    where superseded_by is null and action in ('BUY','SELL') and total_value > 0
      and upper(trim(ticker)) ~ '^[A-Z][A-Z0-9]*([.-][A-Z0-9]+)*$'
    order by total_value desc limit 1`);
  ok('⚠️ the largest insider transaction on record is not a retracted one',
    top && Number(top.total_value) < 100e9, `${top?.ticker} $${Number(top?.total_value).toLocaleString()}`);
}

L('one canonical attention rule, used everywhere');
{
  const hs = read('src/lib/consensus/high-significance.mjs');
  ok('the thresholds are declared once', /ROLE_PURCHASE_USD = 500_000/.test(hs) && /ANY_PURCHASE_USD = 1_000_000/.test(hs));
  ok('⚠️ chart marker promotion calls the canonical function', /highSignificance\(Array\.isArray\(items\)/.test(read('src/lib/chart/evidence-markers.mjs')));
  ok('⚠️ Consensus calls it too', /const h = highSignificance\(evidence\)/.test(read('src/lib/consensus/setup-board.js')));
  // ⚠️ AND NOBODY KEEPS A PRIVATE COPY OF A THRESHOLD NUMBER.
  const offenders = ['src/lib/chart/evidence-markers.mjs', 'src/lib/consensus/board.mjs',
    'src/lib/evidence/resolve.js', 'src/lib/terminal/watchlist-changes.mjs', 'src/lib/evidence/insider-facts.mjs']
    .filter((f) => /\b(500_000|500000|1_000_000|1000000)\b/.test(read(f)));
  ok('⚠️ no consumer hardcodes a significance threshold', offenders.length === 0, offenders.join(', '));
}

L('the read paths are indexed');
{
  const idx = (await sql`select indexname, indexdef from pg_indexes where tablename='insider_trades'`);
  const has = (frag) => idx.some((i) => i.indexdef.includes(frag));
  ok('ticker is indexed', has('(ticker)') || has('(ticker,'));
  ok('filing_date is indexed', has('(filing_date)') || has('filing_date'));
  ok('owner_cik is indexed (identity lookups)', has('(owner_cik)'));
  // ⚠️ THE top VIEW SORTED 269,886 ROWS BY total_value WITH NO INDEX: p50 587ms, a parallel seq scan
  // plus a sort, on the view users land on. The partial index supplies the order instead.
  ok('⚠️ the top-by-value read path has a partial index', has('total_value DESC'),
    idx.map((i) => i.indexname).join(','));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
