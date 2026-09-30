// FORM 4/A LINEAGE — the rule, and the things it must refuse.
//
//   node scripts/verify-form4a-lineage.mjs
//
// ⚠️ THE DEFECT THIS PINS. lib/form4.mjs read `<accessionNumber>` to find the filing an amendment
// corrects. That element does not exist in the SEC ownership schema, so amends_accession was null
// on all 2,027 amendments we hold — not under-covered, never populated. And the live per-minute
// parser rejected `documentType !== '4'`, so it had never ingested a single 4/A at all.
//
// What a Form 4/A does state is <dateOfOriginalSubmission>. Measured across all 901 distinct 4/A
// filings we hold: exactly ONE names the accession it amends, in prose a filer typed into <remarks>
// by hand. So EXPLICIT is real but vanishingly rare, and it is corroborated against our own corpus
// before it becomes a link — a hand-typed key with no schema behind it is a typo risk.
import { readFileSync } from 'node:fs';
import { amendmentSource, resolveAmendment, resolveChains, filingDay, LINK_BASIS } from '../src/lib/form4-lineage.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);

// A real 4/A, trimmed to the elements that carry lineage. PG, 2026-08-27.
const XML = `<ownershipDocument><schemaVersion>X0508</schemaVersion>
<documentType>4/A</documentType><periodOfReport>2026-08-20</periodOfReport>
<dateOfOriginalSubmission>2026-08-24</dateOfOriginalSubmission>
<issuer><issuerCik>0000080424</issuerCik><issuerTradingSymbol>PG</issuerTradingSymbol></issuer>
<reportingOwner><reportingOwnerId><rptOwnerCik>0001825382</rptOwnerCik></reportingOwnerId></reportingOwner>
<remarks>1. The original Form 4, filed on August 24, 2026, is being amended solely to correct the date.</remarks>
</ownershipDocument>`;

L('what the filing states about itself');
{
  const s = amendmentSource(XML);
  ok('it is recognised as an amendment', s.isAmendment && s.documentType === '4/A');
  ok('⚠️ the original-submission date is read', s.origSubmissionDate === '2026-08-24', s.origSubmissionDate);
  ok('the period is read', s.periodOfReport === '2026-08-20');
  ok('leading zeros are stripped from every cik', s.issuerCik === '80424' && s.ownerCiks[0] === '1825382');
  ok('⚠️ and NO accession is stated — the prose says a date, not a key', s.accessionRefs.length === 0);
  const plain = amendmentSource(XML.replace('4/A', '4'));
  ok('a plain Form 4 is not an amendment', !plain.isAmendment);
}

const src = amendmentSource(XML);
const cand = (o) => ({ accession: '0000080424-26-000150', issuerCik: '80424', ownerCik: '1825382',
  filingDate: '2026-08-24', periodOfReport: '2026-08-20', ...o });

L('the rule');
{
  const r = resolveAmendment(src, [cand({})], '0000080424-26-000160');
  ok('⚠️ exactly one matching filing is DETERMINISTIC', r.basis === LINK_BASIS.DETERMINISTIC && r.accession === '0000080424-26-000150', JSON.stringify(r));
  ok('...and the reason records why', /filed 2026-08-24/.test(r.reason));

  ok('⚠️ two matching filings is UNRESOLVED, never a coin flip',
    resolveAmendment(src, [cand({}), cand({ accession: '0000080424-26-000151' })], 'X').basis === LINK_BASIS.UNRESOLVED);
  ok('⚠️ no matching filing is UNRESOLVED', resolveAmendment(src, [], 'X').basis === LINK_BASIS.UNRESOLVED);
  ok('a filing with no stated original date is UNRESOLVED',
    resolveAmendment({ ...src, origSubmissionDate: null }, [cand({})], 'X').basis === LINK_BASIS.UNRESOLVED);

  // ⚠️ THE THINGS IT MUST REFUSE TO MATCH ON.
  ok('⚠️ never across issuers', resolveAmendment(src, [cand({ issuerCik: '99999' })], 'X').basis === LINK_BASIS.UNRESOLVED);
  ok('⚠️ never a different reporting owner', resolveAmendment(src, [cand({ ownerCik: '77777' })], 'X').basis === LINK_BASIS.UNRESOLVED);
  ok('⚠️ never a filing submitted on another date', resolveAmendment(src, [cand({ filingDate: '2026-08-25' })], 'X').basis === LINK_BASIS.UNRESOLVED);
  ok('⚠️ never itself', resolveAmendment(src, [cand({ accession: 'SELF' })], 'SELF').basis === LINK_BASIS.UNRESOLVED);

  // ⚠️ BUT THE PERIOD IS NOT ONE OF THEM. Correcting the date of earliest transaction is one of the
  // commonest reasons a 4/A exists, so the original's period differing is expected, not disqualifying.
  ok('⚠️ a DIFFERENT period still resolves — the amendment is what changed it',
    resolveAmendment(src, [cand({ periodOfReport: '2026-07-31' })], 'X').basis === LINK_BASIS.DETERMINISTIC,
    'requiring period equality rejects the very filings a 4/A most often corrects');
  ok('⚠️ ...and the guard that replaces it is uniqueness, not the period',
    resolveAmendment(src, [cand({ periodOfReport: '2026-07-31' }), cand({ accession: 'OTHER' })], 'X')
      .basis === LINK_BASIS.UNRESOLVED,
    'two filings fitting the stated metadata must stay UNRESOLVED');
  ok('the stated reason no longer claims a period it did not match on',
    !/covering/.test(resolveAmendment(src, [cand({})], 'X').reason));

  // ⚠️ AND NOTHING ABOUT TRANSACTIONS IS EVEN AVAILABLE TO IT. The resolver's inputs carry no
  // shares, price or code, so a match on those cannot be reached by any future edit here.
  const lib = readFileSync(new URL('../src/lib/form4-lineage.mjs', import.meta.url), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('⚠️ the resolver never reads a transaction field',
    !/\b(shares|pricePerShare|price_per_share|transactionCode|transaction_code|totalValue)\b/.test(lib));

  // A joint filing: several reporting owners, any of which identifies the same chain.
  const joint = { ...src, ownerCiks: ['1339161', '1388732'] };
  ok('a joint filing matches on any of its reporting owners',
    resolveAmendment(joint, [cand({ ownerCik: '1388732' })], 'X').basis === LINK_BASIS.DETERMINISTIC);

  // ⚠️ A JOINT FILING ARRIVES AS SEVERAL ROWS SHARING ONE ACCESSION. Indexing by accession and
  // keeping the first row would drop owner B, so an amendment filed by B would find no candidate.
  const rowsA = [cand({ ownerCik: '1339161' }), cand({ ownerCik: '1388732' })];
  ok('⚠️ ...including when the filing reaches us as one row per owner',
    resolveAmendment({ ...src, ownerCiks: ['1388732'] }, rowsA, 'X').basis === LINK_BASIS.DETERMINISTIC,
    'the second owner of a joint filing was dropped');
  ok('...and that is still ONE candidate, not two',
    resolveAmendment({ ...src, ownerCiks: ['1339161', '1388732'] }, rowsA, 'X').accession === '0000080424-26-000150');
}

L('a stated accession — real, rare, and corroborated');
{
  // NYAX 0001976408-26-000547: one filing in 901 typed the reference into <remarks> itself.
  const NYAX = `<ownershipDocument><documentType>4/A</documentType>
<periodOfReport>2026-05-28</periodOfReport><dateOfOriginalSubmission>2026-06-01</dateOfOriginalSubmission>
<issuer><issuerCik>0001901279</issuerCik></issuer>
<reportingOwner><reportingOwnerId><rptOwnerCik>0002000237</rptOwnerCik></reportingOwnerId></reportingOwner>
<remarks>This Form 4/A is an amendment for Accession number: 0001976408-26-000518.</remarks>
</ownershipDocument>`;
  const n = amendmentSource(NYAX);
  ok('⚠️ the stated accession is read out of the prose', n.accessionRefs[0] === '0001976408-26-000518');
  const held = { accession: '0001976408-26-000518', issuerCik: '1901279', ownerCik: '2000237',
    filingDate: '2026-06-01', periodOfReport: '2026-05-28' };
  const r = resolveAmendment(n, [held], '0001976408-26-000547');
  ok('⚠️ it resolves EXPLICIT when we hold that filing', r.basis === LINK_BASIS.EXPLICIT && r.accession === held.accession, JSON.stringify(r));

  // ⚠️ THE GUARDS. No schema element carries this reference; it is hand-typed prose.
  ok('⚠️ a stated accession we do NOT hold is UNRESOLVED, not a dangling link',
    resolveAmendment(n, [], 'X').basis === LINK_BASIS.UNRESOLVED);
  ok('⚠️ ...and does NOT fall through to the date rule, which would overrule the filer',
    resolveAmendment(n, [{ ...held, accession: '0001976408-26-000999' }], 'X').basis === LINK_BASIS.UNRESOLVED,
    'a different filing matching only on date was linked despite the filer naming another');
  ok('⚠️ never across issuers, even when stated',
    resolveAmendment(n, [{ ...held, issuerCik: '99999' }], 'X').basis === LINK_BASIS.UNRESOLVED);
  ok('⚠️ two stated accessions is UNRESOLVED', resolveAmendment(
    { ...n, accessionRefs: ['0001976408-26-000518', '0001976408-26-000519'] },
    [held, { ...held, accession: '0001976408-26-000519' }], 'X').basis === LINK_BASIS.UNRESOLVED);
  ok('a filing that names only ITSELF falls through to the date rule',
    resolveAmendment({ ...n, accessionRefs: ['0001976408-26-000547'] }, [held], '0001976408-26-000547')
      .basis === LINK_BASIS.DETERMINISTIC);
}

L('dates that are not dates');
{
  // ⚠️ TWO FILER AGENTS WELD A TIMEZONE OFFSET ONTO THE DATE. Nine filings in the corpus state
  // `2025-02-19-05:00`. Postgres rejects it as a date; a string compare would never match.
  ok('⚠️ an offset is cut back to the calendar day', filingDay('2025-02-19-05:00') === '2025-02-19');
  ok('a plain date is unchanged', filingDay('2026-08-24') === '2026-08-24');
  ok('a full timestamp is cut to its day', filingDay('2026-08-24T13:05:00Z') === '2026-08-24');
  ok('junk is null, never a guess', filingDay('') === null && filingDay(null) === null && filingDay('soon') === null);
  const tz = amendmentSource(XML.replace('<dateOfOriginalSubmission>2026-08-24<', '<dateOfOriginalSubmission>2026-08-24-05:00<')
    .replace('<periodOfReport>2026-08-20<', '<periodOfReport>2026-08-20-05:00<'));
  ok('⚠️ ...and an offset filing still resolves', resolveAmendment(tz, [cand({})], 'X').basis === LINK_BASIS.DETERMINISTIC,
    `${tz.origSubmissionDate} / ${tz.periodOfReport}`);

  // Against CODE: the backfill must normalise before it hands a date to Postgres.
  const bf = readFileSync(new URL('../scripts/backfill-form4a-lineage.mjs', import.meta.url), 'utf8');
  ok('⚠️ the backfill normalises the cached date rather than trusting it',
    /origSubmissionDate: filingDay\(r\.dateOfOriginalSubmission\)/.test(bf));
}

L('chains');
{
  const filedAt = new Map([['A', '2026-01-01'], ['B', '2026-01-05'], ['C', '2026-01-09']]);
  const chain = resolveChains([{ amendment: 'B', amends: 'A' }, { amendment: 'C', amends: 'B' }], filedAt);
  ok('⚠️ every member of a chain points at the NEWEST filing, not its neighbour',
    chain.get('A') === 'C' && chain.get('B') === 'C', JSON.stringify([...chain]));
  ok('⚠️ a self-link is dropped', resolveChains([{ amendment: 'A', amends: 'A' }], filedAt).size === 0);
  ok('⚠️ a cycle is dropped entirely rather than resolved arbitrarily',
    resolveChains([{ amendment: 'B', amends: 'A' }, { amendment: 'A', amends: 'B' }], filedAt).size === 0);
  const contested = resolveChains([{ amendment: 'B', amends: 'A' }, { amendment: 'C', amends: 'A' }], filedAt);
  ok('⚠️ one original has ONE authoritative successor — the newest', contested.get('A') === 'C', JSON.stringify([...contested]));
  // ⚠️ AND THE LOSER IS SUPERSEDED TOO, OR IT KEEPS COUNTING. Two amendments of one filing means the
  // older amendment has been restated by the newer; leaving it unmarked is the double count.
  ok('⚠️ ...and the older amendment is superseded by the newer, not merely dropped',
    contested.get('B') === 'C', JSON.stringify([...contested]));
  ok('⚠️ ...so every filing but the newest is accounted for', contested.size === 2);
  // Stable regardless of the order edges arrive in.
  const flipped = resolveChains([{ amendment: 'C', amends: 'A' }, { amendment: 'B', amends: 'A' }], filedAt);
  ok('the result does not depend on edge order',
    flipped.get('A') === 'C' && flipped.get('B') === 'C');
  ok('an empty edge set resolves to nothing', resolveChains([], filedAt).size === 0);
}

L('the parsers no longer read a field that does not exist');
{
  // Against CODE: the note explaining the removal quotes the call it removed, as it must.
  const strip = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const lib = strip(readFileSync(new URL('../src/lib/form4.mjs', import.meta.url), 'utf8'));
  const live = readFileSync(new URL('../src/app/api/refresh/route.js', import.meta.url), 'utf8');
  ok('⚠️ lib/form4.mjs no longer looks for <accessionNumber>', !/extractText\(xml, 'accessionNumber'\)/.test(lib));
  ok('⚠️ ...and reads dateOfOriginalSubmission instead', /dateOfOriginalSubmission/.test(lib));
  ok('⚠️ the LIVE parser accepts 4/A at last',
    /documentType !== '4' && documentType !== '4\/A'/.test(live));
  ok('⚠️ ...and carries the provenance the lineage needs',
    /periodOfReport: normalizeDate\(extractFormText\(xml, 'periodOfReport'\)\)/.test(live)
    && /origSubmissionDate: isAmendment \? origSubmissionDate : null/.test(live));
  ok('⚠️ ...and resolves lineage before the write', /await resolveLineageForRows\(rows\)/.test(live));
  ok('⚠️ ...and gives the resolver EVERY reporting owner, not this row\'s',
    /ownerCiks: \[\.\.\.new Set\(ownerCiks\)\]/.test(live),
    'owner_cik is null on a joint filing, so a single-owner input resolves nothing');
  ok('⚠️ ...and carries a stated accession through instead of discarding it',
    /accessionRefs: r\.lineage\?\.accessionRefs \?\? \[\]/.test(live));
  ok('⚠️ ...and looks the named filing up even when it was filed on another date',
    /OR accession = ANY\(\$\{named\}\)/.test(live));
  ok('⚠️ ...and strips the lineage inputs before the insert, since they are not columns',
    /\.map\(\(\{ lineage, \.\.\.row \}\) => row\)/.test(live));
  ok('⚠️ ...and refuses to store an amendment it cannot place',
    /rows\.filter\(\(r\) => !r\.isAmendment \|\| r\.amendsAccession\)/.test(live),
    'storing an unplaceable amendment puts the correction beside the thing it corrects');
}

L('every consumer that reads insider filings excludes the superseded ones');
{
  // ⚠️ POPULATING superseded_by CHANGES WHAT THESE QUERIES MEAN. Before this work the column was
  // empty on all but 117 rows, so a consumer that forgot the predicate still looked right. With 685
  // filings marked, a consumer that filters only `is_amendment is not true` now shows precisely the
  // figures a 4/A was filed to correct — the original stays in and its correction is excluded.
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  // ⚠️ THIS LIST WAS THE WHOLE PROBLEM: it named four consumers and there were ten. The six added
  // below all read transaction rows and none of them filtered supersession, so each was serving or
  // aggregating the version a 4/A had already replaced. /api/insiders was the worst of them — the
  // most insider-centric surface in the product, whose `top` view sorts by value descending and
  // therefore had MYNZ's mistyped, retracted $258,827,700,000 purchase as its headline row.
  //
  // A consumer is counted here when it reads insider TRANSACTION rows. Readers that only take a
  // ticker or a company name from the table (watchlist-materialise, primary-events) are excluded
  // deliberately: supersession cannot change the answer to "which tickers have filings".
  const CONSUMERS = [
    ['src/lib/ticker-seo.mjs', 2],
    ['src/lib/x-reply-context.mjs', 1],
    ['src/lib/consensus/board.mjs', 1],
    ['src/lib/consensus/setup-board.js', 1],
    // Added by the Form 4 end-to-end audit.
    ['src/app/api/insiders/route.js', 10],
    ['src/app/api/cron/insider-alerts/route.js', 1],
    ['src/app/api/cron/pit-snapshot/route.js', 2],
    ['src/app/api/watchlist/signals/route.js', 2],
    ['src/lib/confluence.js', 1],
    ['src/lib/screener-data.js', 1],
  ];
  for (const [file, n] of CONSUMERS) {
    const src = read(file);
    const guards = (src.match(/superseded_by,\s*''\)\s*=\s*''|superseded_by IS NULL/g) || []).length;
    ok(`⚠️ ${file} excludes superseded filings`, guards >= n, `${guards} guard(s), expected ${n}`);
  }
  // The two that filter in JS rather than SQL, because they hand rows to a resolver.
  ok('⚠️ evidence/resolve.js drops superseded rows before they become evidence',
    /filter\(\(x\) => !x\.superseded\)/.test(read('src/lib/evidence/resolve.js')));
  ok('⚠️ evidence/timeline.js does the same', /filter\(\(x\) => !x\.superseded\)/.test(read('src/lib/evidence/timeline.js')));
  ok('⚠️ conviction refuses to score a superseded row',
    /if \(row\.superseded_by\) return false;/.test(read('src/lib/conviction.server.js')));
  ok('⚠️ the conviction pipeline excludes them in SQL too',
    /superseded_by IS NULL/.test(read('src/lib/insider/conviction-pipeline.mjs')));
  // ⚠️ THE TWO SPELLINGS MUST STAY EQUIVALENT. `superseded_by IS NULL` and `coalesce(...,'') = ''`
  // disagree the moment an empty string is written, and both spellings are in use.
  ok('⚠️ nothing writes an empty string into superseded_by',
    !/superseded_by\s*=\s*''/.test(read('src/app/api/refresh/route.js') + read('scripts/backfill-form4a-lineage.mjs')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
