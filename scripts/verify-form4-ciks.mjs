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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
