// Catalyst Convergence is gone from the DEPLOYED Terminal bundle.
//
// ⚠️ WHY THE BUNDLE AND NOT THE RENDERED PAGE. The Terminal is a Pro feature; a signed-out browser
// gets the upsell wall, so "the words do not appear on screen" is true of an empty page and proves
// nothing. The panel's titles and header strings are string literals and survive minification, so
// the shipped JavaScript is the honest place to ask. Every absence below is paired with a POSITIVE
// CONTROL — a string that must still be there — so an empty or unfetched bundle fails loudly
// instead of passing quietly.
const ORIGIN = process.argv[2] || 'https://catalystpit.com';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.error(`  FAIL ${n}${d ? ` — ${d}` : ''}`); } };

const get = async (u) => {
  const r = await fetch(u, { headers: { 'User-Agent': 'CatalystPit-verify' } });
  return r.ok ? r.text() : '';
};

const html = await get(`${ORIGIN}/terminal`);
ok('the /terminal document was served', html.length > 1000, `${html.length} bytes`);

const chunks = [...new Set([...html.matchAll(/\/_next\/static\/[^"']+?\.js/g)].map((m) => m[0]))];
ok('client chunks were found in the document', chunks.length > 0, `${chunks.length} chunks`);

let js = '';
for (const c of chunks) js += await get(`${ORIGIN}${c}`);
ok('⚠️ the chunks actually downloaded', js.length > 200_000, `${js.length} bytes across ${chunks.length} chunks`);

// POSITIVE CONTROLS — if these are missing, the bundle is not the Terminal and every absence below
// is meaningless.
ok('(control) the Terminal bundle is present — "Halt Scanner"', js.includes('Halt Scanner'));
ok('(control) ...and "Pit Scan"', js.includes('Pit Scan'));
ok('(control) ...and the Evidence panel is still shipped', js.includes('Evidence'));

// THE REMOVAL.
ok('⚠️ "Catalyst Convergence" is not in the shipped Terminal', !js.includes('Catalyst Convergence'));
ok('⚠️ ...nor the panel header "Evidence alignment"', !js.includes('Evidence alignment'));
ok('⚠️ ...nor its tag "CANONICAL CONSENSUS"', !js.includes('CANONICAL CONSENSUS'));
ok('⚠️ ...nor its empty state "No stacked signals right now."', !js.includes('No stacked signals right now'));
ok('⚠️ ...nor its Pro teaser "more names. Unlock the full board"', !js.includes('Unlock the full board'));

// THE EVIDENCE FIX, in the shipped bundle.
ok('⚠️ Evidence reads stateLabel', js.includes('stateLabel'));
ok('⚠️ ...and the family colour map shipped', js.includes('CONFIRMING') && js.includes('DIVERGING'));
ok('(control) Evidence still links to EDGAR', js.includes('cgi-bin/browse-edgar'));
ok('(control) ...and still shows the families-active line', js.includes('families active'));

// THE DATA BEHIND IT IS UNTOUCHED.
const board = await (await fetch(`${ORIGIN}/api/consensus-board`, { cache: 'no-store' })).json().catch(() => null);
ok('⚠️ /api/consensus-board still serves', board && (board.status === 'ok' || board.status === 'empty'),
  board ? `status=${board.status} rows=${(board.rows || []).length}` : 'no response');
const cons = await (await fetch(`${ORIGIN}/api/consensus?ticker=RWAY`, { cache: 'no-store' })).json().catch(() => null);
ok('⚠️ /api/consensus still answers for a ticker', cons && cons.ticker === 'RWAY', cons ? `state=${cons.state}` : 'no response');
ok('⚠️ ...and emits canonical.stateLabel, the field Evidence now reads',
  typeof cons?.canonical?.stateLabel === 'string' && /^[A-Z][a-z]/.test(cons.canonical.stateLabel),
  JSON.stringify(cons?.canonical?.stateLabel));
ok('⚠️ ...and family state words the colour map understands',
  (cons?.families || []).every((f) => ['POSITIVE', 'NEGATIVE', 'MIXED', 'INACTIVE', 'CONFIRMING', 'DIVERGING', 'UNAVAILABLE'].includes(String(f.state))),
  JSON.stringify((cons?.families || []).map((f) => `${f.family}:${f.state}`)));

// The /consensus page — the surface Convergence duplicated — must still be there.
const consensusPage = await get(`${ORIGIN}/consensus`);
ok('⚠️ the Pit Consensus page is untouched', consensusPage.length > 1000, `${consensusPage.length} bytes`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
