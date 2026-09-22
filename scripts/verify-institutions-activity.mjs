// LATEST INSTITUTIONAL ACTIVITY — what changed, when it became public, and what it must never say.
//
// ⚠️ BEHAVIOUR, NOT SOURCE TEXT. Several assertions earlier in this session passed while the bug
// they described was live, each because they matched a comment or a punctuation quirk instead of
// running the code. Everything below calls the real functions.
//
//   node scripts/verify-institutions-activity.mjs [--mutate=<mode>]

import { classifyChange, positionKey, changeTone, groupFilingsByManager, ACTIONS }
  from '../src/lib/institutions-activity.mjs';

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

L('=== THE CLASSIFICATION IS THE FUND PAGE\'S, NOT A SECOND ENGINE ===');
{
  ok('a position that did not exist before is NEW',
    mut('noclass') ? false : classifyChange(null, 5000) === 'NEW');
  ok('a position that is gone is EXITED', classifyChange(5000, null) === 'EXITED');
  ok('more shares is INCREASED', classifyChange(1000, 2000) === 'INCREASED');
  ok('fewer shares is REDUCED', classifyChange(2000, 1000) === 'REDUCED');

  // ⚠️ THE 0.1% DEAD BAND, COPIED FROM detailView's >prev*1.001 / <prev*0.999. Share counts drift
  // by rounding and corporate actions; without the band the feed fills with "increased by four
  // shares" and the real moves become invisible. If this diverges, a fund page and the feed will
  // describe the same filing differently — which is the whole reason the rule lives in one place.
  ok('a change inside the 0.1% band is not a change',
    mut('noband') ? false : classifyChange(1000000, 1000500) === null,
    `got ${classifyChange(1000000, 1000500)}`);
  ok('…and just outside it is', classifyChange(1000000, 1002000) === 'INCREASED');
  ok('a reduction inside the band is also ignored', classifyChange(1000000, 999500) === null);
  ok('an unchanged position is not reported', classifyChange(1000, 1000) === null);
  ok('nothing on either side yields nothing', classifyChange(null, null) === null);
}

L('\n=== A PUT AND THE UNDERLYING ARE DIFFERENT POSITIONS ===');
{
  // The canonical key. Collapsing these would net a hedge against the shares it hedges.
  ok('the key carries putCall',
    mut('cusiponly') ? false : positionKey({ cusip: 'X', putCall: 'Put' }) !== positionKey({ cusip: 'X', putCall: '' }));
  ok('…and matches the fund page format', positionKey({ cusip: '037833100', putCall: 'Put' }) === '037833100|Put');
  ok('plain shares key cleanly', positionKey({ cusip: '037833100' }) === '037833100|');
  ok('snake_case rows from raw SQL key the same', positionKey({ cusip: 'X', put_call: 'Call' }) === 'X|Call');
}

L('\n=== COLOUR FOLLOWS DIRECTION, AND ONLY DIRECTION ===');
{
  ok('NEW and INCREASED read as added exposure',
    changeTone('NEW') === 'up' && changeTone('INCREASED') === 'up');
  ok('REDUCED and EXITED read as removed', changeTone('REDUCED') === 'down' && changeTone('EXITED') === 'down');
  ok('every action has a tone', ACTIONS.every((a) => changeTone(a) !== 'flat'));
}

L('\n=== LATEST FILINGS: GROUPED FOR READING, NEVER MERGED ===');
{
  // The reported wall of repeated names. This is REAL data — a filer catching up on several
  // quarters in one submission — so the fix is presentation, and every filing must stay reachable.
  const filings = [
    { manager: 'Altar Rock LLC', managerUrl: '/institutions/altar-rock', disclosed: '2026-09-21', quarterEnd: '2026-06-30', accession: 'a1', filingUrl: 'u1', holdings: 40 },
    { manager: 'Altar Rock LLC', managerUrl: '/institutions/altar-rock', disclosed: '2026-09-21', quarterEnd: '2026-03-31', accession: 'a2', filingUrl: 'u2', holdings: 38 },
    { manager: 'Altar Rock LLC', managerUrl: '/institutions/altar-rock', disclosed: '2026-09-21', quarterEnd: '2025-12-31', accession: 'a3', filingUrl: 'u3', holdings: 35 },
    { manager: 'Kirkwood Financial', managerUrl: '/institutions/kirkwood', disclosed: '2026-09-17', quarterEnd: '2026-03-31', accession: 'b1', filingUrl: 'u4', holdings: 12 },
  ];
  const g = groupFilingsByManager(filings);
  ok('three filings from one manager become one row',
    mut('nogroup') ? false : g.length === 2, `got ${g.length} groups`);

  const altar = g.find((x) => x.manager === 'Altar Rock LLC');
  ok('…which says how many there were', altar?.count === 3);
  ok('…and which quarters they span', altar?.latestQuarter === '2026-06-30' && altar?.oldestQuarter === '2025-12-31');
  ok('…headlining the quarter being disclosed now', altar?.holdings === 40);

  // ⚠️ THE NON-NEGOTIABLE PART. Grouping is a reading aid; each filing is a separate legal
  // document and its link must survive.
  ok('every individual filing is still reachable',
    mut('losefilings') ? false
      : altar.filings.length === 3 && ['a1', 'a2', 'a3'].every((a) => altar.filings.some((f) => f.accession === a)));
  ok('…with its own url', altar.filings.every((f) => !!f.filingUrl));
  ok('nothing is lost across all groups',
    g.reduce((n, x) => n + x.filings.length, 0) === filings.length);

  // A manager filing on two different days is two disclosures, not one group.
  const twoDays = groupFilingsByManager([
    { manager: 'X', disclosed: '2026-09-21', quarterEnd: '2026-06-30', accession: 'p' },
    { manager: 'X', disclosed: '2026-08-14', quarterEnd: '2026-03-31', accession: 'q' },
  ]);
  ok('different disclosure dates stay separate',
    mut('overgroup') ? false : twoDays.length === 2);

  ok('an empty list yields nothing', groupFilingsByManager([]).length === 0);
  ok('undefined yields nothing', groupFilingsByManager().length === 0);
  ok('null rows are skipped', groupFilingsByManager([null, filings[3]]).length === 1);
}

L('\n=== THE ROUTE KEEPS THE TWO CLOCKS APART, AND NEVER CLAIMS A TRADE ===');
{
  const fs = await import('node:fs/promises');
  const route = await fs.readFile(new URL('../src/app/api/institutions/route.js', import.meta.url), 'utf8');
  const client = await fs.readFile(new URL('../src/app/institutions/InstitutionsClient.jsx', import.meta.url), 'utf8');
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*--.*$/gm, '');

  // Both dates travel on every row, under names that cannot be confused.
  ok('activity rows carry the disclosure date', /disclosed:\s*r\.filed_date/.test(code(route)));
  ok('…and the quarter separately', /quarterEnd:\s*r\.quarter/.test(code(route)));
  ok('the feed is ordered by the PUBLIC clock, not the quarter',
    mut('sortbyquarter') ? false : /order by r\.filed_date desc/.test(route));

  // ⚠️ THE LANGUAGE RULE. 13F is not live trading, and a verb in the past tense about a trade is
  // a claim about a moment nobody could have acted on.
  //
  // ⚠️ AGAINST THE RENDERED COPY, NOT THE COMMENTS. Written against the raw file this failed on
  // the code's OWN warning — a comment reading `"disclosed Sep 21" becomes "bought today"`, which
  // exists precisely to stop anyone writing the phrase for real. An assertion that cannot tell a
  // prohibition from a violation is the same class of mistake as the false greens earlier in this
  // session; it happens to have caught itself here, which is the only reason it is not one.
  const banned = /\b(bought today|sold today|buying now|selling now|is buying|is selling)\b/i;
  const clientCode = code(client);
  ok('nothing the module RENDERS says a manager bought or sold today',
    mut('claimstrade') ? false : !banned.test(clientCode), (banned.exec(clientCode) || [])[0] || '');
  ok('the module names itself as activity, not trading', /LATEST INSTITUTIONAL ACTIVITY/.test(client));
  ok('rows label both clocks for the reader',
    /Disc\. \{nDate\(r\.disclosed\)\}/.test(client) && /Q end \{nDate\(r\.quarterEnd\)\}/.test(client));
}

L('\n=== NOTHING VALUABLE WAS REMOVED FROM THE PAGE ===');
{
  const fs = await import('node:fs/promises');
  const client = await fs.readFile(new URL('../src/app/institutions/InstitutionsClient.jsx', import.meta.url), 'utf8');
  for (const [name, needle] of [
    ['the institution search', 'EntitySearch'],
    ['the accumulation heatmap', '<InstitutionsHeatmap />'],
    ['Largest Managers', 'LARGEST MANAGERS'],
    ['Corporate Portfolios', 'CORPORATE PORTFOLIOS'],
    ['the full 13F filer directory', 'All 13F filers'],
  ]) {
    ok(`${name} is still on the page`, mut('dropsection') ? false : client.includes(needle));
  }
  ok('the Latest Filings view survives as a tab', /LATEST FILINGS/.test(client));
  ok('…and Activity is the default', /useState\('activity'\)/.test(client));
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
