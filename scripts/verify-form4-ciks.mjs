// FORM 4 IDENTIFIERS — the two columns the live parser was silently dropping.
//
// ⚠️ WHAT HAPPENED, BECAUSE IT SHAPES THE ASSERTIONS.
//
// There are two Form 4 parsers. lib/form4.mjs extracts issuerCik and rptOwnerCik and always has —
// but only the backfill scripts use it. The parser local to /api/refresh, the one the per-minute
// cron actually runs, never extracted either, so every row the live path wrote carried NULL for
// both. It stayed invisible for months because the manual backfills were still sweeping history
// behind it and filling the gaps in. When those stopped, CIK coverage on new filings went to 0%
// and took the conviction context pipeline with it — build-insider-context partitions on
// owner_cik, so a null owner means no context, which means every context factor falls to its
// neutral default and no recent purchase can reach HIGH.
//
// Two parsers, one of them quietly less complete than the other, is the shape of this bug. The
// assertions below are mostly about keeping them in step.
//
// Run: node scripts/verify-form4-ciks.mjs

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

const refresh = read('../src/app/api/refresh/route.js');
const form4 = read('../src/lib/form4.mjs');
const repair = read('../scripts/repair-form4-ciks.mjs');
const backfill = read('../scripts/backfill-insiders.mjs');
const schema = read('../src/lib/schema.js');

L('⚠️ THE LIVE PARSER NOW CARRIES BOTH IDENTIFIERS');
{
  // ⚠️ THE ROOT CAUSE, ASSERTED AS A FIELD LIST. The returned row simply did not mention them.
  ok('⚠️ the live parser extracts issuerCik',
    /const issuerCik = extractFormText\(xml, 'issuerCik'\)\?\.replace\(\/\^0\+\/, ''\) \|\| null;/.test(refresh));
  ok('⚠️ …and rptOwnerCik', /rptOwnerCik>\(\[\\s\\S\]\*\?\)<\\\/rptOwnerCik>/.test(refresh) || /rptOwnerCik/.test(refresh));
  ok('⚠️ …and the row it returns includes both', /issuerCik, ownerCik,/.test(code(refresh)));
  // ⚠️ THE SAME SHAPE AS THE OTHER PARSER, or the same company gets two different CIK spellings.
  ok('⚠️ leading zeros are stripped the same way lib/form4.mjs strips them',
    /replace\(\/\^0\+\/, ''\)/.test(code(form4)) && (code(refresh).match(/replace\(\/\^0\+\/, ''\)/g) || []).length >= 2);
  ok('lib/form4.mjs is unchanged in how it reads them',
    /const issuerCik = extractText\(xml, 'issuerCik'\)\?\.replace\(\/\^0\+\/, ''\) \|\| null;/.test(form4)
    && /const ownerCik = extractText\(xml, 'rptOwnerCik'\)\?\.replace\(\/\^0\+\/, ''\) \|\| null;/.test(form4));

  // ⚠️ FROM THE FILING, NEVER INFERRED.
  ok('⚠️ no CIK is derived from a ticker, a name or a lookup table',
    !/cikFor|cikFromTicker|tickerToCik|lookupCik/i.test(code(refresh)));
  ok('…absent in the XML means null, not a fallback', /\|\| null;/.test(code(refresh)));

  // ⚠️ A JOINT FILING MUST NOT STAPLE ONE PERSON'S ID TO ANOTHER'S TRADES.
  ok('⚠️ a filing reporting several owners yields no owner_cik on the live path',
    /new Set\(ownerCiks\)\.size === 1 \? ownerCiks\[0\] : null/.test(code(refresh)));

  // ⚠️ AND NOTHING ELSE ABOUT THE PARSE MOVED.
  ok('transaction parsing is untouched',
    /transactionCode === 'P'\) action = 'BUY'/.test(code(refresh))
    && /totalValue: shares \* pricePerShare/.test(code(refresh)));
  ok('the ticker gate is untouched', /if \(!isIngestableTicker\(ticker\)\) return \[\];/.test(code(refresh)));
}

L('⚠️ NO WRITE PATH CAN ERASE A VALID IDENTIFIER');
{
  // ⚠️ THE FAILURE THIS FORBIDS: a later, less complete path re-touching a row and nulling a CIK
  // that an earlier, complete path had written.
  const conflicts = code(refresh).match(/onConflict\w+/g) || [];
  ok('⚠️ every live insert conflicts to DO NOTHING, never DO UPDATE',
    conflicts.length >= 2 && conflicts.every((c) => c === 'onConflictDoNothing'), conflicts.join(','));
  ok('…and the backfill script does the same',
    /onConflictDoNothing/.test(code(backfill)) && !/onConflictDoUpdate/.test(code(backfill)));
  ok('⚠️ no ingest path UPDATEs insider_trades identifiers at all',
    !/UPDATE insider_trades[\s\S]{0,200}(owner_cik|issuer_cik)/i.test(code(refresh))
    && !/UPDATE insider_trades[\s\S]{0,200}(owner_cik|issuer_cik)/i.test(code(backfill)));
  ok('the duplicate/accession conflict target is unchanged',
    /insiderTradesTable\.accession, insiderTradesTable\.transactionDate, insiderTradesTable\.transactionCode/.test(refresh));
  ok('the schema still declares both columns', /ownerCik:\s+text\('owner_cik'\)/.test(schema) && /issuerCik:\s+text\('issuer_cik'\)/.test(schema));
}

L('⚠️ THE REPAIR FILLS NULLS AND NOTHING ELSE');
{
  // ⚠️ EVERY UPDATE IS NULL-GUARDED. Without this the repair could rewrite an identifier that a
  // complete parse had already established, which is the opposite of a repair.
  const updates = code(repair).match(/UPDATE insider_trades SET [\s\S]*?WHERE[^`]*/g) || [];
  ok('⚠️ every repair UPDATE is guarded on the column being NULL',
    updates.length >= 3 && updates.every((u) => /IS NULL/.test(u)), `${updates.length} updates`);
  ok('⚠️ the repair touches only the two identifier columns',
    updates.every((u) => /SET (owner_cik|issuer_cik) =/.test(u)));
  ok('⚠️ …so economics, dates, accession, ticker and insider name are never rewritten',
    !/SET (total_value|shares|price_per_share|transaction_date|filing_date|accession|ticker|executive)/i.test(code(repair)));

  // ⚠️ IT REFUSES TO GUESS AN OWNER ON A JOINT FILING.
  ok('⚠️ a single-owner filing is applied to the whole filing',
    /distinct\.length === 1/.test(code(repair)));
  ok('⚠️ a multi-owner filing matches each row by name',
    /owners\.filter\(\(o\) => o\.name && norm\(o\.name\) === norm\(row\.executive\)\)/.test(code(repair)));
  ok('⚠️ …and leaves the row null when that match is not unique',
    /uniq\.length === 1/.test(code(repair)) && /stat\.ownerAmbiguous\+\+/.test(code(repair)));

  // ⚠️ THE SOURCE IS THE FILING ITSELF, reachable by a deterministic transform of a URL we stored.
  ok('⚠️ the recovery source is the original SEC submission',
    /Archives\\\/edgar\\\/data/.test(repair) && /-index\\\.html\?\$/.test(repair));
  ok('…declared to SEC with a User-Agent and rate-limited',
    /'User-Agent': UA/.test(repair) && /CONCURRENCY/.test(repair) && /GAP_MS/.test(repair));
  // ⚠️ IDEMPOTENT: the work queue is the NULL predicate, so a re-run finds only what is still null.
  ok('⚠️ re-running repairs only what is still missing',
    /\(owner_cik IS NULL OR issuer_cik IS NULL\)/.test(repair));
  ok('it is bounded and dry-runnable', /--dry/.test(repair) && /LIMIT \$\{LIMIT\}/.test(repair));
}

L('⚠️ THE DOWNSTREAM PIPELINE IS UNCHANGED');
{
  // ⚠️ THIS WAS AN UPSTREAM INPUT REPAIR. Nothing about how a score is computed may have moved.
  const engine = read('../src/lib/conviction.server.js');
  const pipeline = read('../src/lib/insider/conviction-pipeline.mjs');
  ok('⚠️ conviction weights untouched',
    /seniority: 0\.15/.test(engine) && /sizeVsSelf: 0\.20/.test(engine) && /rarity: 0\.19/.test(engine));
  ok('⚠️ the de-minimis floor untouched', /const DE_MINIMIS = 50000;/.test(engine));
  ok('⚠️ context still partitions on owner_cik — which is why the nulls mattered',
    /owner_cik IS NOT NULL/.test(pipeline) && /PARTITION BY owner_cik, issuer_cik/.test(pipeline));
  ok('notable-insider bands untouched',
    /NOTABLE_BANDS = Object\.freeze\(\['HIGH', 'VERY HIGH', 'EXTREME'\]\)/.test(read('../src/lib/terminal/watchlist-changes.mjs')));
}

console.log('\n=== ⚠️ a well-formed symbol can still belong to another company ===');
{
  // ⚠️ THE DEFECT THIS PINS. issuerTradingSymbol is free text on a Form 4. resolveFilerSymbol already
  // refuses the unparseable ones ("Z AND ZG", "MOGA/MOGB") — it returns null rather than inventing a
  // symbol. What it cannot catch is a symbol that IS a valid ticker, for somebody else. Measured on the
  // live corpus, 8 tickers carried filings from a company the ticker does not name: 8 DoorDash rows on
  // Fabrinet's FN page, Bank of America rows on an Invesco muni fund, PEDEVCO on Crexendo, Zomedica on
  // TSS, Riverview Bancorp on Timberland.
  const A = await import('../src/lib/insider-ticker-authority.mjs');
  const counts = [
    { ticker: 'FN', issuerCik: 'FABRINET', n: 50 },      // Fabrinet holds FN
    { ticker: 'FN', issuerCik: 'DOORDASH', n: 8 },        // DoorDash filed under it by mistake
    { ticker: 'DASH', issuerCik: 'DOORDASH', n: 695 },    // and has a page of its own
  ];
  const auth = A.buildTickerAuthority(counts);
  ok('⚠️ a row on another company\'s ticker is moved to its own',
    A.authoritativeTicker({ ticker: 'FN', issuerCik: 'DOORDASH' }, auth) === 'DASH');
  ok('⚠️ the ticker\'s real holder is left alone',
    A.authoritativeTicker({ ticker: 'FN', issuerCik: 'FABRINET' }, auth) === null);

  // ⚠️ AND THE RULE MUST BE SILENT ON A SYMBOL CHANGE, which is the opposite failure: after a rename
  // the old symbol has thousands of rows and the new one has few, and "prefer the issuer's usual
  // ticker" would file every new filing under the dead symbol. A renamed company's new symbol is not
  // established by anyone else, so both conditions fail and nothing moves.
  const renamed = A.buildTickerAuthority([
    { ticker: 'OLD', issuerCik: 'ACME', n: 900 },
    { ticker: 'NEW', issuerCik: 'ACME', n: 2 },
  ]);
  ok('⚠️ a symbol change is not rewritten to the old symbol',
    A.authoritativeTicker({ ticker: 'NEW', issuerCik: 'ACME' }, renamed) === null,
    'this is the regression that would misfile every filing after a rename');

  // A company with no established ticker of its own must be left as filed, not guessed at.
  const noOwn = A.buildTickerAuthority([
    { ticker: 'BOX', issuerCik: 'BOX_INC', n: 89 },
    { ticker: 'BOX', issuerCik: 'BOXABL', n: 1 },
  ]);
  ok('⚠️ a company with no page of its own is left unchanged, not guessed',
    A.authoritativeTicker({ ticker: 'BOX', issuerCik: 'BOXABL' }, noOwn) === null,
    'preferring unresolved over wrong');

  // A free-text symbol is nobody's authority and is not this rule's job.
  ok('a malformed symbol is left to resolveFilerSymbol',
    A.authoritativeTicker({ ticker: 'Z AND ZG', issuerCik: 'ZILLOW' },
      A.buildTickerAuthority([{ ticker: 'Z AND ZG', issuerCik: 'OTHER', n: 9 }, { ticker: 'Z', issuerCik: 'ZILLOW', n: 9 }])) === null);
  ok('...and cannot become an authority itself',
    !A.buildTickerAuthority([{ ticker: 'NYSE: VTEX', issuerCik: 'VTEX', n: 88 }]).dominantCikOf.has('NYSE: VTEX'));
  // ⚠️ A TIE MUST NOT BE DECIDED BY ROW ORDER, or the same corpus gives different answers on different
  // runs. Both directions are asserted, because checking one leaves the outcome the same either way.
  // B is listed FIRST on purpose: without the sort, insertion order would hand T1 to B, so the
  // assertion only has teeth when the fixture's order disagrees with the deterministic answer.
  const tie = A.buildTickerAuthority([
    { ticker: 'T1', issuerCik: 'B', n: 5 }, { ticker: 'T1', issuerCik: 'A', n: 5 },
    { ticker: 'T3', issuerCik: 'A', n: 9 }, { ticker: 'T2', issuerCik: 'B', n: 9 },
  ]);
  ok('ties are broken deterministically — the lower cik holds the ticker',
    tie.dominantCikOf.get('T1') === 'A');
  ok('...so the tie loser is relocated', A.authoritativeTicker({ ticker: 'T1', issuerCik: 'B' }, tie) === 'T2');
  ok('...and the tie winner is left alone', A.authoritativeTicker({ ticker: 'T1', issuerCik: 'A' }, tie) === null);

  // Against the live parser: the guard runs before the insert, or it protects nothing.
  const route = read('../src/app/api/refresh/route.js');
  ok('⚠️ the live parser applies the rule before storing', /await relocateMisfiledTickers\(rows\);/.test(route));
  ok('⚠️ ...and before the placeable filter that writes the rows',
    route.indexOf('relocateMisfiledTickers(rows)') < route.indexOf('const placeable = rows.filter'));
  ok('⚠️ ...using the shared decision, not a second copy of it',
    /authoritativeTicker\(p, buildTickerAuthority\(counts\)\)/.test(route));
  ok('a lookup failure leaves the filed symbol rather than dropping the filing',
    /ticker authority check failed/.test(route));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
